// lambda-handler-v2.js - Lambda function using existing scraper files
// This version uses credentials from environment variables and stores JSON in DynamoDB

const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const execAsync = promisify(exec);

// Initialize DynamoDB client with error handling
let dynamoClient;
let dynamoDocClient;
try {
  const dynamoClientRaw = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
  });
  dynamoDocClient = DynamoDBDocumentClient.from(dynamoClientRaw);
  dynamoClient = dynamoClientRaw;
} catch (dynamoError) {
  console.error("Failed to initialize DynamoDB client:", dynamoError);
  dynamoClient = null;
  dynamoDocClient = null;
}

// Initialize Lambda client for async invocation
let lambdaClient;
try {
  lambdaClient = new LambdaClient({
    region: process.env.AWS_REGION || "us-east-1",
  });
} catch (lambdaError) {
  console.error("Failed to initialize Lambda client:", lambdaError);
  lambdaClient = null;
}

// Lambda has /tmp for writable files, /var/task for code
const TMP_DIR = "/tmp";
const TASK_DIR = "/var/task";
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || "utr-year-in-review";

// Canonical per-profile bundle slot. The table's composite key is
// (profileId, year); the bundle covers all years, so it lives at year 0.
const BUNDLE_YEAR = 0;
// Bundles older than this are re-scraped on request so the site stays
// current year-round.
const MAX_DATA_AGE_DAYS = 7;
// A pending record older than this is assumed dead (scrape crashed without
// marking failure) and may be reclaimed.
const PENDING_TIMEOUT_MINUTES = 15;
// After a failed refresh, serve the stale bundle (flagged stale) for this long
// before trying another scrape.
const RETRY_BACKOFF_MINUTES = 60;
// DynamoDB caps an item at 400 KB; an uncompressed bundle passes that at
// roughly 700-800 matches, so bundles are stored gzipped (`dataGz`).
const MAX_BUNDLE_BYTES = 380 * 1024;

function packBundle(data) {
  const gz = zlib.gzipSync(JSON.stringify(data));
  if (gz.length > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Bundle too large to store (${Math.round(gz.length / 1024)} KB compressed)`,
    );
  }
  return gz;
}

// A refresh must keep at least this share of the previous bundle's matches
// to replace it.
const MIN_BUNDLE_RETAINED = 0.9;

function countMatches(bundle) {
  return (
    (bundle?.singles?.matches?.length || 0) +
    (bundle?.doubles?.matches?.length || 0)
  );
}

// Reads either storage format: gzipped `dataGz`, or legacy plain `data`.
function unpackBundle(item) {
  if (!item) return null;
  if (item.dataGz) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(item.dataGz)).toString("utf8"));
  }
  return item.data || null;
}

// Kick off a stale bundle's refresh as an async self-invocation so the
// visitor gets the old data immediately. `refreshStartedAt` is a lock: one
// refresh per profile at a time, reclaimable after PENDING_TIMEOUT_MINUTES.
// Returns false only when no refresh could be started (caller refreshes
// inline instead).
async function startBackgroundRefresh(profileId, year) {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!lambdaClient || !functionName) return false;
  const key = { profileId, year };
  try {
    await dynamoDocClient.send(
      new UpdateCommand({
        TableName: DYNAMODB_TABLE,
        Key: key,
        UpdateExpression: "SET refreshStartedAt = :now",
        ConditionExpression:
          "attribute_not_exists(refreshStartedAt) OR refreshStartedAt < :cutoff",
        ExpressionAttributeValues: {
          ":now": new Date().toISOString(),
          ":cutoff": new Date(
            Date.now() - PENDING_TIMEOUT_MINUTES * 60 * 1000,
          ).toISOString(),
        },
      }),
    );
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") {
      console.log("Background refresh already running");
      return true;
    }
    console.error("Could not claim refresh lock:", e.message);
    return false;
  }
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: JSON.stringify({ action: "refresh", profileId }),
      }),
    );
    console.log("Background refresh started");
    return true;
  } catch (e) {
    console.error("Could not start background refresh:", e.message);
    await dynamoDocClient
      .send(
        new UpdateCommand({
          TableName: DYNAMODB_TABLE,
          Key: key,
          UpdateExpression: "REMOVE refreshStartedAt",
        }),
      )
      .catch(() => {});
    return false;
  }
}

// Helper to ensure all responses have CORS headers
// Define this BEFORE mainHandler so it's always in scope
function createCORSResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400", // 24 hours
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

// Session slot for the reusable UTR JWT (refreshed on every scrape). Keyed
// with a non-numeric profileId so it never collides with a real player.
const SESSION_KEY = { profileId: "_session", year: BUNDLE_YEAR };

// True if the JWT parses and has more than `minRemainingMs` left before expiry.
function isValid(jwt, minRemainingMs = 60000) {
  if (!jwt || typeof jwt !== "string") return false;
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString(),
    );
    return payload.exp && payload.exp * 1000 > Date.now() + minRemainingMs;
  } catch (e) {
    return false;
  }
}

// A token handed to the scraper must outlast the scrape itself.
const SCRAPE_JWT_MIN_REMAINING_MS = 15 * 60 * 1000;

// Read a valid (unexpired) UTR JWT for authenticated API calls like search.
// Prefers the token refreshed by the most recent scrape (DynamoDB), and
// falls back to the one bundled with the deploy package.
async function getUtrJwt(minRemainingMs) {
  // 1. DynamoDB session slot (freshest — updated by each scrape).
  if (dynamoDocClient) {
    try {
      const r = await dynamoDocClient.send(
        new GetCommand({ TableName: DYNAMODB_TABLE, Key: SESSION_KEY }),
      );
      if (isValid(r.Item?.jwt, minRemainingMs)) return r.Item.jwt;
    } catch (e) {
      console.error("Error reading session jwt:", e.message);
    }
  }

  // 2. Fall back to the auth state bundled at deploy time.
  try {
    const bundled = path.join(TASK_DIR, "auth-state-lambda.json");
    if (fs.existsSync(bundled)) {
      const auth = JSON.parse(fs.readFileSync(bundled, "utf8"));
      const jwt = (auth.cookies || []).find((c) => c.name === "jwt")?.value;
      if (isValid(jwt, minRemainingMs)) return jwt;
    }
  } catch (e) {
    console.error("Error reading bundled jwt:", e.message);
  }
  return null;
}

// Persist a freshly scraped JWT so search stays authenticated between deploys.
async function storeUtrJwt(cacheDir) {
  if (!dynamoDocClient) return;
  try {
    const authPath = path.join(cacheDir, "auth-state.json");
    if (!fs.existsSync(authPath)) return;
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const jwt = (auth.cookies || []).find((c) => c.name === "jwt")?.value;
    if (!jwt) return;
    await saveUtrJwt(jwt);
  } catch (e) {
    console.error("Could not store jwt:", e.message);
  }
}

async function saveUtrJwt(jwt) {
  if (!dynamoDocClient) return;
  await dynamoDocClient.send(
    new PutCommand({
      TableName: DYNAMODB_TABLE,
      Item: { ...SESSION_KEY, jwt, updatedAt: new Date().toISOString() },
    }),
  );
  console.log("Stored refreshed UTR jwt for search");
}

// Self-heal for search: when no stored token is valid (or UTR rejects it),
// log in directly over HTTP with the Lambda's UTR credentials instead of
// waiting for the next full scrape to refresh it. Concurrent callers share
// one login, and a failed login is not retried for a few minutes so a bad
// password doesn't hammer UTR's auth endpoint.
const LOGIN_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
let loginInFlight = null;
let lastLoginFailureAt = 0;

async function refreshUtrJwt() {
  if (loginInFlight) return loginInFlight;
  if (Date.now() - lastLoginFailureAt < LOGIN_RETRY_COOLDOWN_MS) return null;
  loginInFlight = (async () => {
    try {
      const jwt = await loginForUtrJwt();
      if (!isValid(jwt)) throw new Error("login returned no valid jwt");
      try {
        await saveUtrJwt(jwt);
      } catch (e) {
        console.error("Could not store jwt:", e.message);
      }
      return jwt;
    } catch (e) {
      console.error("UTR login for search failed:", e.message);
      lastLoginFailureAt = Date.now();
      return null;
    } finally {
      loginInFlight = null;
    }
  })();
  return loginInFlight;
}

async function loginForUtrJwt() {
  const email = process.env.UTR_EMAIL;
  const password = process.env.UTR_PASSWORD;
  if (!email || !password) throw new Error("UTR credentials not set");

  const r = await fetch("https://app.utrsports.net/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`login returned ${r.status}`);

  // UTR sets the token as a `jwt` cookie; some responses also echo it in
  // the body, so accept either.
  const cookies =
    typeof r.headers.getSetCookie === "function"
      ? r.headers.getSetCookie()
      : [r.headers.get("set-cookie") || ""];
  for (const c of cookies) {
    const m = /(?:^|[;,]\s*)jwt=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  const body = await r.json().catch(() => ({}));
  return body.jwt || body.token || null;
}

// Proxy UTR's player search (server-side to avoid the browser CORS preflight
// that its API rejects). Returns a trimmed list of { id, name, location, utr }.
async function handleSearch(query) {
  const q = String(query || "").trim();
  if (q.length < 2) {
    return createCORSResponse(200, { success: true, results: [] });
  }
  const jwt = (await getUtrJwt()) || (await refreshUtrJwt());
  if (!jwt) {
    return createCORSResponse(200, {
      success: false,
      error: "Search is temporarily unavailable (no valid session).",
    });
  }
  try {
    const url =
      "https://api.utrsports.net/v2/search/players?query=" +
      encodeURIComponent(q) +
      "&top=10";
    const search = (token) =>
      fetch(url, {
        headers: {
          accept: "application/json",
          authorization: "Bearer " + token,
        },
      });
    let r = await search(jwt);
    // A token can be revoked before it expires; log in again and retry once.
    if (r.status === 401 || r.status === 403) {
      const fresh = await refreshUtrJwt();
      if (fresh) r = await search(fresh);
    }
    if (!r.ok) {
      console.error("UTR search returned", r.status);
      return createCORSResponse(200, {
        success: false,
        error: `Search failed (${r.status}).`,
      });
    }
    const body = await r.json();
    const hits = body.players?.hits || body.hits || [];
    const results = hits
      .map((h) => {
        const s = h.source || h;
        const loc = s.location && (s.location.display || s.location.cityStateZip);
        return {
          id: String(s.id),
          name:
            s.displayName ||
            `${s.firstName || ""} ${s.lastName || ""}`.trim(),
          location: loc || null,
          utr: s.singlesUtrDisplay || (s.singlesUtr ? s.singlesUtr.toFixed(2) : null),
          gender: s.gender || null,
        };
      })
      .filter((r) => r.id && r.name);
    return createCORSResponse(200, { success: true, results });
  } catch (e) {
    console.error("Search error:", e.message);
    return createCORSResponse(200, {
      success: false,
      error: "Search error.",
    });
  }
}

// Function to check for cached files in DynamoDB
async function checkCachedFiles(profileId) {
  try {
    if (!dynamoDocClient) {
      return createCORSResponse(500, {
        success: false,
        error: "DynamoDB client not initialized",
      });
    }

    // Query all items for this profileId
    const response = await dynamoDocClient.send(
      new QueryCommand({
        TableName: DYNAMODB_TABLE,
        KeyConditionExpression: "profileId = :profileId",
        ExpressionAttributeValues: {
          ":profileId": profileId,
        },
      }),
    );

    const cachedFiles = (response.Items || [])
      .filter((item) => item.status === "completed")
      .map((item) => ({
        profileId: item.profileId,
        year: item.year,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      .sort((a, b) => b.year - a.year); // Sort by year descending

    return createCORSResponse(200, {
      success: true,
      profileId: profileId,
      cachedFiles: cachedFiles,
      count: cachedFiles.length,
    });
  } catch (error) {
    console.error("Error checking cached files:", error);
    return createCORSResponse(500, {
      success: false,
      error: error.message || "Internal server error",
    });
  }
}

// Wrap handler to catch ALL errors, including module loading errors
const mainHandler = async (event) => {
  // Background refresh of a stale bundle (async self-invocation from
  // startBackgroundRefresh). The old bundle stays served until this lands.
  if (event.action === "refresh") {
    const profileId = String(event.profileId || "");
    if (!/^\d{4,10}$/.test(profileId)) {
      return { statusCode: 400, body: "invalid profileId" };
    }
    console.log(`=== Background refresh for ${profileId} ===`);
    // We MUST await here - Lambda freezes the context once the handler returns.
    try {
      await performScrapeAndUpload(
        profileId,
        process.env.UTR_EMAIL,
        process.env.UTR_PASSWORD,
        BUNDLE_YEAR,
      );
      console.log("=== Background refresh completed ===");
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
      console.error("=== Background refresh failed ===", error);
      // Keep the existing bundle; record the failure so visitors get the
      // retry backoff instead of re-triggering a scrape on every visit.
      try {
        await dynamoDocClient.send(
          new UpdateCommand({
            TableName: DYNAMODB_TABLE,
            Key: { profileId, year: BUNDLE_YEAR },
            UpdateExpression:
              "SET lastError = :err, lastAttemptAt = :now REMOVE refreshStartedAt",
            ConditionExpression: "attribute_exists(profileId)",
            ExpressionAttributeValues: {
              ":err": error.message,
              ":now": new Date().toISOString(),
            },
          }),
        );
      } catch (dbError) {
        console.error("Failed to record refresh failure:", dbError.message);
      }
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: error.message }),
      };
    }
  }

  // Handle OPTIONS preflight requests
  if (
    event.httpMethod === "OPTIONS" ||
    event.requestContext?.http?.method === "OPTIONS"
  ) {
    console.log("OPTIONS preflight request received");
    return createCORSResponse(200, { message: "OK" });
  }

  // Handle GET requests for checking cached files
  const httpMethod =
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod;
  if (httpMethod === "GET") {
    // Player name search: /generate?search=<name>
    const searchQuery = event.queryStringParameters?.search;
    if (searchQuery != null) {
      return await handleSearch(searchQuery);
    }
    const profileId = event.queryStringParameters?.profileId;
    if (profileId) {
      return await checkCachedFiles(profileId);
    }
    return createCORSResponse(400, {
      error: "profileId or search query parameter is required",
    });
  }

  const corsResponse = createCORSResponse;
  // Wrap everything in try-catch to ensure we always return a response
  try {
    console.log("Request:", httpMethod, event.path || event.rawPath || "");

    // Parse request body
    let body;
    try {
      if (event.body) {
        body =
          typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      } else {
        // If no body, try to get from event directly (for direct Lambda invocation)
        body = event;
      }
    } catch (e) {
      console.error("JSON parse error:", e);
      console.error("Body that failed to parse:", event.body);
      return corsResponse(400, {
        error: "Invalid JSON in request body",
        details: e.message,
      });
    }

    // Player name search (POST { search: "<name>" }). Routed through POST
    // because that's the method wired on the API Gateway resource.
    if (body.search != null) {
      return await handleSearch(body.search);
    }

    const { profileId } = body;

    // All data lives in the canonical bundle slot
    const year = BUNDLE_YEAR;

    // Validate input
    if (!profileId) {
      return corsResponse(400, { error: "Missing required field: profileId" });
    }

    // Enhanced profile ID validation
    if (!/^\d+$/.test(profileId)) {
      return corsResponse(400, {
        error: "Invalid profile ID format. Must be numeric only.",
      });
    }

    // Validate profile ID length (reasonable range: 4-10 digits)
    if (profileId.length < 4 || profileId.length > 10) {
      return corsResponse(400, {
        error: "Invalid profile ID length. Must be between 4 and 10 digits.",
      });
    }


    // Get credentials from environment variables
    const utrEmail = process.env.UTR_EMAIL;
    const utrPassword = process.env.UTR_PASSWORD;

    if (!utrEmail || !utrPassword) {
      return corsResponse(200, {
        success: false,
        error: "Server configuration error: UTR credentials not set",
      });
    }

    // Check if DynamoDB client is initialized
    if (!dynamoDocClient) {
      return corsResponse(200, {
        success: false,
        error: "DynamoDB client initialization failed",
      });
    }

    console.log(`Starting scrape for profile ${profileId}, year ${year}`);

    // Check for an existing bundle in DynamoDB. Fresh bundles are returned
    // immediately; stale ones (older than MAX_DATA_AGE_DAYS) fall through to
    // a re-scrape, with the stale bundle preserved as a fallback in case the
    // scrape fails.
    // updatedAt of the stale bundle, restored if the refresh fails so the
    // bundle keeps reporting its true age instead of looking fresh.
    let staleUpdatedAt = null;
    try {
      const getResponse = await dynamoDocClient.send(
        new GetCommand({
          TableName: DYNAMODB_TABLE,
          Key: {
            profileId: profileId,
            year: year,
          },
        }),
      );

      if (getResponse.Item) {
        const item = getResponse.Item;
        const lastUpdated = new Date(
          item.updatedAt || item.createdAt || 0,
        ).getTime();
        const ageDays = (Date.now() - lastUpdated) / (24 * 60 * 60 * 1000);
        console.log(
          `Found record: status=${item.status}, age=${ageDays.toFixed(1)} days`,
        );

        const cachedData =
          item.status === "completed" || item.status === "pending"
            ? unpackBundle(item)
            : null;
        if (item.status === "completed" && cachedData) {
          if (ageDays < MAX_DATA_AGE_DAYS) {
            console.log("Bundle is fresh, returning immediately");
            return corsResponse(200, {
              success: true,
              message: "Data retrieved from cache",
              data: cachedData,
            });
          }
          const lastAttempt = new Date(item.lastAttemptAt || 0).getTime();
          if (Date.now() - lastAttempt < RETRY_BACKOFF_MINUTES * 60 * 1000) {
            console.log("Bundle is stale but a refresh failed recently");
            return corsResponse(200, {
              success: true,
              stale: true,
              message:
                "Refresh failed recently; showing previously cached data.",
              data: cachedData,
            });
          }
          // Stale-while-revalidate: serve the old bundle now, refresh behind it.
          if (await startBackgroundRefresh(profileId, year)) {
            return corsResponse(200, {
              success: true,
              refreshing: true,
              message: "Showing cached data; a refresh is running.",
              data: cachedData,
            });
          }
          console.log("Bundle is stale - refreshing inline");
          staleUpdatedAt = item.updatedAt || item.createdAt || null;
          // Fall through to re-scrape.
        } else if (item.status === "pending") {
          const ageMinutes = (Date.now() - lastUpdated) / (60 * 1000);
          if (ageMinutes < PENDING_TIMEOUT_MINUTES && cachedData) {
            // An inline refresh of an existing bundle is running.
            return corsResponse(200, {
              success: true,
              refreshing: true,
              message: "Showing cached data; a refresh is running.",
              data: cachedData,
            });
          }
          if (ageMinutes < PENDING_TIMEOUT_MINUTES) {
            console.log("Scrape already in progress");
            return corsResponse(200, {
              success: false,
              message:
                "Your data is being processed. Please check back in 30-60 seconds.",
              error:
                "Review data is currently being generated. Please check back in 30-60 seconds.",
            });
          }
          console.log(
            "Pending record timed out (scrape likely died) - retrying",
          );
        } else if (item.status === "failed") {
          console.log("Previous attempt failed, will retry");
        }
      }
    } catch (dynamoError) {
      console.error("Error checking DynamoDB:", dynamoError);
      // Continue to try creating new record
    }

    // Claim the work slot. The condition lets a request claim when there is
    // no record, the record isn't pending, or a pending record has timed out
    // — concurrent requests can't double-scrape, but stale locks self-heal.
    // UpdateCommand (not Put) so an existing stale bundle's `data` survives.
    try {
      const nowIso = new Date().toISOString();
      const staleCutoff = new Date(
        Date.now() - PENDING_TIMEOUT_MINUTES * 60 * 1000,
      ).toISOString();
      await dynamoDocClient.send(
        new UpdateCommand({
          TableName: DYNAMODB_TABLE,
          Key: { profileId: profileId, year: year },
          UpdateExpression:
            "SET #s = :pending, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)",
          ConditionExpression:
            "attribute_not_exists(profileId) OR #s <> :pending OR updatedAt < :staleCutoff",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":now": nowIso,
            ":staleCutoff": staleCutoff,
          },
        }),
      );
      console.log("Claimed pending slot in DynamoDB");
    } catch (putError) {
      if (putError.name === "ConditionalCheckFailedException") {
        // Record already exists - someone else is processing or it's pending
        console.log("Record already exists, returning processing message");
        return corsResponse(200, {
          success: false,
          message:
            "Your data is being processed. Please check back in 30-60 seconds.",
          error:
            "Review data is currently being generated. Please check back in 30-60 seconds.",
        });
      } else {
        console.error("Error creating pending record:", putError);
        // Continue anyway - worst case we process twice
      }
    }

    // Run scraping synchronously (fast mode, ~45-90 seconds)
    console.log("Running scrape synchronously...");
    console.log("Profile ID:", profileId);
    console.log("Year:", year);
    console.log("Has credentials:", !!(utrEmail && utrPassword));
    console.log("DynamoDB client initialized:", !!dynamoDocClient);

    try {
      // Run the scrape and wait for it to complete
      console.log("Calling performScrapeAndUpload...");
      const bundle = await performScrapeAndUpload(
        profileId,
        utrEmail,
        utrPassword,
        year,
      );
      console.log("✅ Scrape completed successfully!");
      return corsResponse(200, {
        success: true,
        data: bundle,
        message: "Data generated successfully!",
      });
    } catch (scrapeError) {
      console.error("Scrape failed:", scrapeError);
      console.error("Error name:", scrapeError.name);
      console.error("Error message:", scrapeError.message);
      console.error("Error stack:", scrapeError.stack);

      // Record the failure. If a previous (stale) bundle exists, restore its
      // completed status and serve it rather than losing good data.
      let staleFallback = null;
      try {
        const existing = await dynamoDocClient.send(
          new GetCommand({
            TableName: DYNAMODB_TABLE,
            Key: { profileId, year },
          }),
        );
        const existingData = unpackBundle(existing.Item);
        if (existingData) {
          staleFallback = existingData;
          await dynamoDocClient.send(
            new UpdateCommand({
              TableName: DYNAMODB_TABLE,
              Key: { profileId, year },
              // The claim overwrote updatedAt; put the bundle's real age back.
              UpdateExpression:
                "SET #s = :completed, lastError = :err, lastAttemptAt = :now, updatedAt = :dataAt",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":completed": "completed",
                ":err": scrapeError.message,
                ":now": new Date().toISOString(),
                ":dataAt":
                  staleUpdatedAt ||
                  existingData.scrapedAt ||
                  new Date(0).toISOString(),
              },
            }),
          );
          console.log("Restored stale bundle after failed refresh");
        } else {
          await dynamoDocClient.send(
            new PutCommand({
              TableName: DYNAMODB_TABLE,
              Item: {
                profileId,
                year,
                status: "failed",
                error: scrapeError.message,
                updatedAt: new Date().toISOString(),
              },
            }),
          );
          console.log("Marked record as failed in DynamoDB");
        }
      } catch (dbError) {
        console.error("Failed to update error status:", dbError);
      }

      if (staleFallback) {
        return corsResponse(200, {
          success: true,
          stale: true,
          message:
            "Refresh failed; showing previously cached data. It will retry on a later visit.",
          data: staleFallback,
        });
      }

      return corsResponse(500, {
        success: false,
        error: `Failed to generate review: ${scrapeError.message}`,
      });
    }

  } catch (error) {
    console.error("Error in mainHandler:", error);
    return corsResponse(200, {
      success: false,
      error: "Internal server error",
      message: error.message || "Unknown error",
    });
  }
};

// Extract scraping logic into separate function for async execution
async function performScrapeAndUpload(profileId, utrEmail, utrPassword, year) {
  // Create temp directories
  const workDir = path.join(
    TMP_DIR,
    `utr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  );
  fs.mkdirSync(workDir, { recursive: true });
  const cacheDir = path.join(workDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const secretsPath = path.join(workDir, "secrets.json");
  // Canonical bundle written by the generator
  const resultPath = path.join(workDir, `${profileId}-data.json`);

  try {
    // Write credentials to temp file
    const credentials = {
      username: utrEmail,
      email: utrEmail,
      password: utrPassword,
    };
    fs.writeFileSync(secretsPath, JSON.stringify(credentials, null, 2));

    // Keep UTR traffic low: hand the scraper the stored session (so it can
    // usually skip the login flow) and the previous bundle (so it only
    // re-fetches recent results and merges them in).
    const sessionJwt = await getUtrJwt(SCRAPE_JWT_MIN_REMAINING_MS);
    let previousBundlePath = "";
    let previousMatchCount = 0;
    if (dynamoDocClient) {
      try {
        const prev = await dynamoDocClient.send(
          new GetCommand({
            TableName: DYNAMODB_TABLE,
            Key: { profileId, year: BUNDLE_YEAR },
          }),
        );
        const previousBundle = unpackBundle(prev.Item);
        if (previousBundle) {
          previousMatchCount = countMatches(previousBundle);
          previousBundlePath = path.join(workDir, "previous-bundle.json");
          fs.writeFileSync(previousBundlePath, JSON.stringify(previousBundle));
        }
      } catch (e) {
        console.error("Could not load previous bundle:", e.message);
      }
    }
    console.log(
      `Session token: ${sessionJwt ? "reusing stored" : "none"}; previous bundle: ${previousBundlePath ? "yes" : "no"}`,
    );

    // Reference scraper files
    const scraperPath = path.join(TASK_DIR, "scraper-full.js");
    const generatorPath = path.join(TASK_DIR, "generate-full-review.js");

    // Check if files exist
    if (!fs.existsSync(scraperPath) || !fs.existsSync(generatorPath)) {
      const availableFiles = fs
        .readdirSync(TASK_DIR)
        .filter((f) => f.includes("scraper") || f.includes("generate"));
      throw new Error(
        `Scraper files not found. Available files: ${availableFiles.join(", ")}`,
      );
    }

    // Set environment variables for the scripts
    process.env.CACHE_DIR = cacheDir;
    process.env.SECRETS_PATH = secretsPath;

    // Change to work directory
    const originalCwd = process.cwd();
    process.chdir(workDir);

    try {
      // Run scraper
      console.log("Running scraper...");
      console.log("Secrets file path:", secretsPath);
      console.log("Secrets file exists:", fs.existsSync(secretsPath));
      console.log("Scraper path:", scraperPath);
      console.log("Scraper path exists:", fs.existsSync(scraperPath));
      console.log("Profile ID:", profileId);
      let scraperOutput;
      try {
        // Pass SECRETS_PATH as environment variable so scraper can find it
        const scraperEnv = {
          ...process.env,
          CACHE_DIR: cacheDir,
          SECRETS_PATH: secretsPath,
          OUTPUT_DIR: workDir, // Tell scraper where to write output
          UTR_JWT: sessionJwt || "",
          PREVIOUS_BUNDLE: previousBundlePath,
          // Also set CHROMIUM_PATH if available
          CHROMIUM_PATH: process.env.CHROMIUM_PATH || "/opt/chromium",
        };
        console.log(
          "Scraper environment:",
          JSON.stringify({
            CACHE_DIR: scraperEnv.CACHE_DIR,
            SECRETS_PATH: scraperEnv.SECRETS_PATH,
            CHROMIUM_PATH: scraperEnv.CHROMIUM_PATH,
          }),
        );

        console.log("About to execute scraper command...");
        // --fast: skips per-opponent rating histories but DOES fetch the
        // player's own rating history, which the year-round site needs for
        // the UTR journey chart and match-time ratings.
        const scraperCommand = `node ${scraperPath} ${profileId} --fast`;
        console.log("Command:", scraperCommand);
        console.log("Working directory:", workDir);

        scraperOutput = await execAsync(scraperCommand, {
          timeout: 240000, // 4 minutes (fast mode ~45-90s)
          maxBuffer: 10 * 1024 * 1024,
          env: scraperEnv,
          cwd: workDir, // Run from work directory so relative paths work
        });
        console.log(
          "Scraper command completed. stdout length:",
          scraperOutput.stdout?.length || 0,
        );
        console.log(
          "Scraper stdout (first 3000 chars):",
          scraperOutput.stdout.substring(0, 3000),
        );
        if (scraperOutput.stderr) {
          console.log(
            "Scraper stderr:",
            scraperOutput.stderr.substring(0, 2000),
          );
        }

      } catch (scraperError) {
        console.error("Scraper error:", scraperError);
        console.error("Scraper stdout:", scraperError.stdout || "");
        console.error("Scraper stderr:", scraperError.stderr || "");
        throw new Error(
          `Scraper failed: ${scraperError.message}. stdout: ${scraperError.stdout || ""}. stderr: ${scraperError.stderr || ""}`,
        );
      }

      // Run generator
      console.log("Generating review...");
      let generatorOutput;
      try {
        const generatorEnv = {
          ...process.env,
          CACHE_DIR: cacheDir,
          OUTPUT_DIR: workDir, // Tell generator where to find scraper output
        };
        generatorOutput = await execAsync(
          `node ${generatorPath} ${profileId}`,
          {
            timeout: 60000, // 1 minute
            maxBuffer: 10 * 1024 * 1024,
            env: generatorEnv,
            cwd: workDir, // Run from work directory so it can find scraper output
          },
        );
        console.log(
          "Generator output:",
          generatorOutput.stdout.substring(0, 500),
        );
      } catch (generatorError) {
        console.error("Generator error:", generatorError);
        throw new Error(
          `Generator failed: ${generatorError.message}. stdout: ${generatorError.stdout || ""}. stderr: ${generatorError.stderr || ""}`,
        );
      }

      // Read result
      if (!fs.existsSync(resultPath)) {
        throw new Error(`Bundle not generated. Expected: ${resultPath}`);
      }

      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));

      // A bundle with zero matches means the scrape effectively failed
      // (usually authentication). Throw so the caller's failure handling
      // preserves any previous good bundle instead of overwriting it.
      const totalMatches = countMatches(result);
      if (totalMatches === 0) {
        const loginFailed =
          result.loginSuccessful === false || result.loginError;
        const errorMessage = loginFailed
          ? "Authentication failed - unable to access match data. " +
            (result.loginError || "")
          : "No matches found. The scraper completed but found 0 matches.";
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
      // Matches only accumulate, so a markedly smaller bundle means a partial
      // scrape (e.g. some year calls failed). Keep the previous one instead.
      if (
        previousMatchCount >= 10 &&
        totalMatches < previousMatchCount * MIN_BUNDLE_RETAINED
      ) {
        throw new Error(
          `Refresh found ${totalMatches} matches but the previous bundle has ${previousMatchCount}; keeping the previous bundle.`,
        );
      }

      // Read the generated JSON data to return to user
      // Use the same path we defined earlier (with profile ID)
      const reviewJsonPath = resultPath;
      let reviewData = null;
      if (fs.existsSync(reviewJsonPath)) {
        try {
          reviewData = JSON.parse(fs.readFileSync(reviewJsonPath, "utf8"));
          console.log("Loaded review data for response");
        } catch (e) {
          console.error("Error reading review JSON:", e);
        }
      } else {
        console.error("Review JSON file not found at:", reviewJsonPath);
        // Try using the result we already parsed
        reviewData = result;
        console.log("Using already-parsed result data");
      }

      const bundle = reviewData || result;

      // Save bundle to DynamoDB with completed status. A failed save throws
      // so the caller's failure handling runs (keeps any previous bundle)
      // instead of leaving the record stuck as pending.
      if (dynamoDocClient) {
        const nowIso = new Date().toISOString();
        await dynamoDocClient.send(
          new PutCommand({
            TableName: DYNAMODB_TABLE,
            Item: {
              profileId: profileId,
              year: BUNDLE_YEAR,
              status: "completed",
              dataGz: packBundle(bundle),
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          }),
        );
        console.log("Bundle saved to DynamoDB with completed status");
        // Persist the freshly refreshed JWT so player search stays authed.
        await storeUtrJwt(cacheDir);
      }

      console.log(
        `✅ Data available for profileId: ${profileId}, year: ${year}`,
      );
      return bundle;
    } finally {
      process.chdir(originalCwd);
    }
  } catch (error) {
    console.error("Error:", error);
    console.error("Error stack:", error.stack);
    console.error("Error name:", error.name);

    const errorMessage = error.message.includes("timeout")
      ? "Request timed out. Please try again."
      : error.message.includes("ENOENT")
        ? "Scraper files not found. Please check Lambda package."
        : "Failed to generate review: " + error.message;

    console.error("Error details:", errorMessage);
    throw error;
  } finally {
    // Remove the work dir (credentials file, browser profile, scrape output)
    // on success too — warm containers otherwise fill /tmp run after run.
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (cleanupError) {
      console.log("Cleanup warning (non-critical):", cleanupError.message);
    }
  }
}

// Export handler wrapped to ensure CORS headers are ALWAYS present
// This wrapper catches ALL errors, including unhandled promise rejections
exports.handler = async (event) => {
  // Define CORS response function that's always available (not dependent on createCORSResponse)
  const corsResponse = (statusCode, body) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  // Handle OPTIONS preflight requests at the wrapper level (before mainHandler)
  const httpMethod =
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod;
  if (httpMethod === "OPTIONS") {
    console.log("OPTIONS preflight request received at wrapper level");
    return corsResponse(200, { message: "OK" });
  }

  try {
    // Call mainHandler and ensure it returns a response with CORS
    const result = await Promise.resolve(mainHandler(event));

    // Ensure result has CORS headers (in case mainHandler forgot)
    if (result && result.headers) {
      result.headers["Access-Control-Allow-Origin"] = "*";
      result.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      result.headers["Access-Control-Allow-Headers"] =
        "Content-Type, Authorization";
      result.headers["Access-Control-Max-Age"] = "86400";
    }

    return result;
  } catch (error) {
    // Catch ANY error - this is the critical safety net
    console.error("Unhandled error in Lambda handler wrapper:", error);
    console.error("Error stack:", error.stack);
    // Return 200 with error in body to avoid API Gateway reformatting
    return corsResponse(200, {
      success: false,
      error: "Internal server error",
      message: error.message || "Unknown error",
      type: error.name || "Error",
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};
