// lambda-handler-v2.js - Lambda function using existing scraper files
// This version uses credentials from environment variables and stores JSON in DynamoDB

const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
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
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE || "utr-rate-limits";

// Rate limiting removed - DynamoDB pending status prevents duplicate expensive scrapes

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

// Rate limiting function
async function checkRateLimit(identifier, type = "ip") {
  if (!dynamoDocClient) {
    console.warn("DynamoDB client not available, allowing request (fail open)");
    return true; // Allow if DynamoDB not available
  }

  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const window = type === "ip" ? hourAgo : dayAgo;
  const limit = type === "ip" ? MAX_REQUESTS_PER_IP : MAX_REQUESTS_PER_PROFILE;
  const windowName = type === "ip" ? "hour" : "day";

  try {
    // Query recent requests
    const response = await dynamoDocClient.send(
      new QueryCommand({
        TableName: RATE_LIMIT_TABLE,
        KeyConditionExpression: "#id = :id AND #time > :window",
        ExpressionAttributeNames: {
          "#id": "identifier",
          "#time": "timestamp",
        },
        ExpressionAttributeValues: {
          ":id": `${type}:${identifier}`,
          ":window": window,
        },
      }),
    );

    const requestCount = response.Items?.length || 0;

    if (requestCount >= limit) {
      console.log(
        `Rate limit exceeded for ${type}:${identifier} - ${requestCount}/${limit} requests in last ${windowName}`,
      );
      return false; // Rate limit exceeded
    }

    // Record this request
    await dynamoDocClient.send(
      new PutCommand({
        TableName: RATE_LIMIT_TABLE,
        Item: {
          identifier: `${type}:${identifier}`,
          timestamp: now,
          ttl: Math.floor((now + 24 * 60 * 60 * 1000) / 1000), // 24 hour TTL in seconds
        },
      }),
    );

    console.log(
      `Rate limit check passed for ${type}:${identifier} - ${requestCount + 1}/${limit} requests in last ${windowName}`,
    );
    return true; // Within rate limit
  } catch (error) {
    console.error("Rate limit check error:", error);
    // Fail open - allow request if rate limiting fails
    return true;
  }
}

// Function to extract IP address from event
function extractIP(event) {
  // Try various headers that might contain the IP
  const headers = event.headers || event.multiValueHeaders || {};
  const xForwardedFor =
    headers["X-Forwarded-For"] ||
    headers["x-forwarded-for"] ||
    (headers["X-Forwarded-For"] && headers["X-Forwarded-For"][0]);
  if (xForwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first one
    return xForwardedFor.split(",")[0].trim();
  }

  const xRealIP = headers["X-Real-IP"] || headers["x-real-ip"];
  if (xRealIP) {
    return xRealIP;
  }

  // Fallback to request context
  const sourceIP =
    event.requestContext?.identity?.sourceIp ||
    event.requestContext?.http?.sourceIp;
  if (sourceIP) {
    return sourceIP;
  }

  // Last resort: use a default identifier
  return "unknown";
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
  // Handle internal async invocation (for background scraping)
  if (event.action === "scrape") {
    console.log("=== ASYNC SCRAPE REQUEST RECEIVED ===");
    console.log("Event action:", event.action);
    console.log("Profile ID:", event.profileId);
    console.log("Year:", event.year);
    console.log("Has credentials:", !!(event.utrEmail && event.utrPassword));

    // CRITICAL: We MUST await here - Lambda will keep the execution context alive
    // as long as the handler hasn't returned. If we return early, Lambda terminates.
    console.log("Starting performScrapeAndUpload...");
    try {
      await performScrapeAndUpload(
        event.profileId,
        event.utrEmail,
        event.utrPassword,
        event.year,
      );
      console.log("=== Async scrape completed successfully ===");
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: "Scrape completed" }),
      };
    } catch (error) {
      console.error("=== Async scrape failed ===");
      console.error("Error:", error);
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
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
    const profileId = event.queryStringParameters?.profileId;
    if (profileId) {
      return await checkCachedFiles(profileId);
    }
    return createCORSResponse(400, {
      error: "profileId query parameter is required",
    });
  }

  // Ensure createCORSResponse is available (it should be, but just in case)
  const corsResponse =
    createCORSResponse ||
    ((statusCode, body) => ({
      statusCode,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  // Wrap everything in try-catch to ensure we always return a response
  try {
    console.log("Event received:", JSON.stringify(event, null, 2));
    console.log("Event keys:", Object.keys(event));
    console.log(
      "HTTP Method:",
      event.httpMethod ||
        event.requestContext?.http?.method ||
        event.requestContext?.httpMethod,
    );
    console.log("Body type:", typeof event.body);
    console.log(
      "Body value (first 200 chars):",
      typeof event.body === "string"
        ? event.body.substring(0, 200)
        : event.body,
    );

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

    const { profileId } = body;

    // Always use 2025 for year
    const year = 2025;

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

    // Rate limiting removed - DynamoDB pending status prevents duplicate expensive scrapes
    // Multiple requests for the same profileId will return cached data or "processing" message

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

    // Check if data already exists in DynamoDB
    // First try with year 2025, then scan for any year if not found (for backward compatibility)
    try {
      let getResponse = await dynamoDocClient.send(
        new GetCommand({
          TableName: DYNAMODB_TABLE,
          Key: {
            profileId: profileId,
            year: parseInt(year), // year is 2025
          },
        }),
      );

      // If not found with year 2025, scan for any completed record with this profileId
      // (for backward compatibility with old data that might have different years)
      if (!getResponse.Item) {
        console.log(
          "No record found with year 2025, scanning for any completed record...",
        );
        const { ScanCommand } = require("@aws-sdk/lib-dynamodb");
        const scanResponse = await dynamoDocClient.send(
          new ScanCommand({
            TableName: DYNAMODB_TABLE,
            FilterExpression: "profileId = :pid AND #s = :status",
            ExpressionAttributeNames: {
              "#s": "status",
            },
            ExpressionAttributeValues: {
              ":pid": profileId,
              ":status": "completed",
            },
          }),
        );

        if (scanResponse.Items && scanResponse.Items.length > 0) {
          // Use the most recent completed record
          const completedItems = scanResponse.Items.filter((item) => item.data);
          if (completedItems.length > 0) {
            // Sort by updatedAt descending to get the most recent
            completedItems.sort((a, b) => {
              const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
              const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
              return bTime - aTime;
            });
            const mostRecent = completedItems[0];
            console.log(
              `Found completed record with year ${mostRecent.year}, returning it`,
            );
            return corsResponse(200, {
              success: true,
              message: "Review data retrieved from cache",
              data: mostRecent.data,
            });
          }
        }
      }

      if (getResponse.Item) {
        const item = getResponse.Item;
        console.log(
          `Found existing record in DynamoDB with status: ${item.status}, year: ${item.year}`,
        );

        // If completed, return the data immediately
        if (item.status === "completed" && item.data) {
          console.log("Data is completed, returning immediately");
          return corsResponse(200, {
            success: true,
            message: "Review data retrieved from cache",
            data: item.data,
          });
        }

        // If pending, return processing message
        if (item.status === "pending") {
          console.log("Data is pending, returning processing message");
          return corsResponse(200, {
            success: false,
            message:
              "Your data is being processed. Please check back in 30-60 seconds.",
            error:
              "Review data is currently being generated. Please check back in 30-60 seconds.",
          });
        }

        // If failed, we can retry (fall through)
        if (item.status === "failed") {
          console.log("Previous attempt failed, will retry");
        }
      }
    } catch (dynamoError) {
      console.error("Error checking DynamoDB:", dynamoError);
      // Continue to try creating new record
    }

    // Try to create a pending record (only if it doesn't exist)
    // This prevents duplicate processing
    try {
      await dynamoDocClient.send(
        new PutCommand({
          TableName: DYNAMODB_TABLE,
          Item: {
            profileId: profileId,
            year: parseInt(year),
            status: "pending",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          ConditionExpression:
            "attribute_not_exists(profileId) AND attribute_not_exists(#yr)",
          ExpressionAttributeNames: {
            "#yr": "year",
          },
        }),
      );
      console.log("Created pending record in DynamoDB");
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

    // Ultra-fast mode: Run scraping synchronously (only takes ~30 seconds now!)
    console.log("Running ultra-fast scrape synchronously...");
    console.log("Expected time: ~30 seconds");
    console.log("Profile ID:", profileId);
    console.log("Year:", year);
    console.log("Has credentials:", !!(utrEmail && utrPassword));
    console.log("DynamoDB client initialized:", !!dynamoDocClient);

    try {
      // Run the scrape and wait for it to complete
      console.log("Calling performScrapeAndUpload...");
      await performScrapeAndUpload(profileId, utrEmail, utrPassword, year);
      console.log("✅ Ultra-fast scrape completed successfully!");

      // Fetch the completed data from DynamoDB
      const result = await dynamoDocClient.send(
        new GetCommand({
          TableName: DYNAMODB_TABLE,
          Key: { profileId, year },
        }),
      );

      if (result.Item && result.Item.status === "completed") {
        console.log("Returning completed data immediately");
        return corsResponse(200, {
          success: true,
          data: result.Item.data,
          message: "Year in review generated successfully!",
        });
      } else {
        // Shouldn't happen, but handle gracefully
        console.error("Data generated but not found in DynamoDB");
        return corsResponse(500, {
          success: false,
          error: "Data generation completed but result not found",
        });
      }
    } catch (scrapeError) {
      console.error("Scrape failed:", scrapeError);
      console.error("Error name:", scrapeError.name);
      console.error("Error message:", scrapeError.message);
      console.error("Error stack:", scrapeError.stack);

      // Mark as failed in DynamoDB
      try {
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
      } catch (dbError) {
        console.error("Failed to update error status:", dbError);
      }

      return corsResponse(500, {
        success: false,
        error: `Failed to generate review: ${scrapeError.message}`,
      });
    }

    // OLD ASYNC CODE (keeping for reference, can be deleted):
    /*
    const lambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (lambdaClient && lambdaFunctionName) {
      console.log(
        `Attempting to invoke Lambda function ${lambdaFunctionName} asynchronously...`,
      );
      const invokePayload = {
        action: "scrape",
        profileId: profileId,
        year: 2025, // Always use 2025
        utrEmail: utrEmail,
        utrPassword: utrPassword,
      };
      console.log(
        "Invoke payload (without credentials):",
        JSON.stringify({
          ...invokePayload,
          utrEmail: "[REDACTED]",
          utrPassword: "[REDACTED]",
        }),
      );

      // Await the invoke to ensure it's actually triggered and log any errors
      // We don't await the scrape itself, just the invoke command
      try {
        const invokeResponse = await lambdaClient.send(
          new InvokeCommand({
            FunctionName: lambdaFunctionName,
            InvocationType: "Event", // Async invocation - doesn't wait for response
            Payload: JSON.stringify(invokePayload),
          }),
        );
        console.log("Async Lambda invocation triggered successfully");
        console.log("Invoke response status:", invokeResponse.StatusCode);
        console.log(
          "Invoke response metadata:",
          JSON.stringify(invokeResponse.$metadata || {}),
        );
      } catch (invokeError) {
        console.error("Failed to invoke Lambda asynchronously:", invokeError);
        console.error("Invoke error name:", invokeError.name);
        console.error("Invoke error message:", invokeError.message);
        console.error("Invoke error code:", invokeError.code);
        console.error("Invoke error stack:", invokeError.stack);
        // Log error but don't block - the user will get the processing message anyway
      }
    } else {
      console.log("Lambda client or function name not available");
      console.log("  - lambdaClient:", !!lambdaClient);
      console.log("  - lambdaFunctionName:", lambdaFunctionName);
      console.log(
        "Falling back to direct scrape in background (will likely timeout)...",
      );
      // Fire and forget - don't await
      performScrapeAndUpload(profileId, utrEmail, utrPassword, year).catch(
        (err) => {
          console.error("Direct scrape failed:", err);
        },
      );
    }
    */
    // END OLD ASYNC CODE
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
  // Use profile ID in filename to avoid conflicts
  const resultPath = path.join(
    workDir,
    `${profileId}-${year}-year-in-review.json`,
  );

  try {
    // Write credentials to temp file
    const credentials = {
      username: utrEmail,
      email: utrEmail,
      password: utrPassword,
    };
    fs.writeFileSync(secretsPath, JSON.stringify(credentials, null, 2));

    // Reference scraper files
    const scraperPath = path.join(TASK_DIR, "scraper-full.js");
    const generatorPath = path.join(TASK_DIR, "generate-full-review.js");
    const exportCsvPath = path.join(TASK_DIR, "export-csv.js");

    // Debug: List files in TASK_DIR
    console.log("TASK_DIR:", TASK_DIR);
    console.log(
      "Files in TASK_DIR:",
      fs.readdirSync(TASK_DIR).slice(0, 20).join(", "),
    );
    console.log("Looking for scraper-full.js at:", scraperPath);
    console.log("Looking for generate-full-review.js at:", generatorPath);
    console.log("scraper-full.js exists:", fs.existsSync(scraperPath));
    console.log(
      "generate-full-review.js exists:",
      fs.existsSync(generatorPath),
    );

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
        const scraperCommand = `node ${scraperPath} ${profileId} --ultra-fast`;
        console.log("Command:", scraperCommand);
        console.log("Working directory:", workDir);
        console.log("⚡ Using ultra-fast mode (28s estimated time)");

        scraperOutput = await execAsync(scraperCommand, {
          timeout: 120000, // 2 minutes (ultra-fast mode ~30s)
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

        // Check if scraper actually created the output file
        const expectedOutputFile = path.join(
          workDir,
          `utr-full-${profileId}.json`,
        );
        console.log("Checking for scraper output file at:", expectedOutputFile);
        console.log("File exists:", fs.existsSync(expectedOutputFile));
        if (fs.existsSync(expectedOutputFile)) {
          const stat = fs.statSync(expectedOutputFile);
          console.log("✅ File exists! Size:", stat.size, "bytes");
          // Read first 500 chars to verify it's valid JSON
          const preview = fs
            .readFileSync(expectedOutputFile, "utf8")
            .substring(0, 500);
          console.log("File preview:", preview);
        } else {
          console.log("❌ File does NOT exist! Listing workDir contents:");
          try {
            const files = fs.readdirSync(workDir);
            console.log("Files in workDir:", files.join(", "));
          } catch (e) {
            console.log("Error listing workDir:", e.message);
          }
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
          `node ${generatorPath} ${profileId} ${year}`,
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
        // Try default location with profile ID (generator now writes with profile ID)
        const defaultResultPathWithId = path.join(
          workDir,
          `${profileId}-${year}-year-in-review.json`,
        );
        const defaultResultPath = path.join(workDir, "year-in-review.json");

        if (fs.existsSync(defaultResultPathWithId)) {
          // Generator wrote with profile ID - use it directly
          // resultPath already has the correct name, so just verify it exists
          if (defaultResultPathWithId !== resultPath) {
            fs.copyFileSync(defaultResultPathWithId, resultPath);
          }
        } else if (fs.existsSync(defaultResultPath)) {
          // Fallback to old naming convention (for backwards compatibility)
          fs.copyFileSync(defaultResultPath, resultPath);
        } else {
          throw new Error(
            `Review file not generated. Checked: ${resultPath}, ${defaultResultPathWithId}, ${defaultResultPath}`,
          );
        }
      }

      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));

      // Check if we have matches - don't generate CSV if no matches found
      const singlesMatches =
        result.singles?.matches || result.singlesMatches || [];
      const hasMatches = singlesMatches.length > 0;

      if (!hasMatches) {
        console.log("⚠️  No matches found");

        // Check if login failed
        const loginFailed =
          result.loginSuccessful === false || result.loginError;
        let errorMessage =
          "No matches found. The scraper completed but found 0 matches.";

        if (loginFailed) {
          errorMessage =
            "Authentication failed - unable to access match data. Please check UTR credentials. " +
            (result.loginError || "");
          console.error("Login failed:", errorMessage);
        } else {
          console.error("No matches found - cannot save to DynamoDB");
        }

        // Update DynamoDB with failed status
        if (dynamoDocClient) {
          try {
            await dynamoDocClient.send(
              new PutCommand({
                TableName: DYNAMODB_TABLE,
                Item: {
                  profileId: profileId,
                  year: parseInt(year),
                  status: "failed",
                  error: errorMessage,
                  updatedAt: new Date().toISOString(),
                },
              }),
            );
          } catch (dynamoError) {
            console.error("Error updating DynamoDB:", dynamoError);
          }
        }
        return; // Exit async function, don't save
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

      // Save JSON to DynamoDB with completed status
      if (dynamoDocClient) {
        try {
          // Use reviewData if available, otherwise use result
          const jsonToUpload = reviewData || result;

          await dynamoDocClient.send(
            new PutCommand({
              TableName: DYNAMODB_TABLE,
              Item: {
                profileId: profileId,
                year: parseInt(year),
                status: "completed",
                data: jsonToUpload,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            }),
          );
          console.log("JSON saved to DynamoDB with completed status");
        } catch (dynamoError) {
          console.error("Error saving JSON to DynamoDB:", dynamoError);
          // Continue anyway - we still have the JSON data
        }
      }

      // Ensure we have data to return
      if (!reviewData) {
        throw new Error(
          "Failed to load review data - file not found and result not available",
        );
      }

      // For async invocations, we don't need to return a response
      // The data is already saved to DynamoDB, which is the goal
      console.log(
        "✅ Review data generated and saved to DynamoDB successfully",
      );
      console.log(
        `✅ Data available for profileId: ${profileId}, year: ${year}`,
      );
      return; // Just return - no response needed for async invocation
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

    // For async invocations, we just log the error
    // No need to return a response - the error is logged
    console.error("Error details:", errorMessage);

    // Cleanup temp directories
    // Use fs.rmSync with force for safe recursive deletion
    try {
      if (fs.existsSync(secretsPath)) {
        try {
          fs.unlinkSync(secretsPath);
        } catch (e) {
          /* ignore */
        }
      }
      if (fs.existsSync(workDir)) {
        try {
          // Use fs.rmSync if available (Node.js 14.14+), otherwise use recursive delete
          if (fs.rmSync) {
            fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
          } else {
            // Fallback: try to delete files individually, ignore errors
            const deleteRecursive = (dir) => {
              if (!fs.existsSync(dir)) return;
              try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                  const filePath = path.join(dir, file);
                  try {
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                      deleteRecursive(filePath);
                      try {
                        fs.rmdirSync(filePath);
                      } catch (e) {
                        /* ignore */
                      }
                    } else {
                      try {
                        fs.unlinkSync(filePath);
                      } catch (e) {
                        /* ignore */
                      }
                    }
                  } catch (e) {
                    /* ignore */
                  }
                }
                try {
                  fs.rmdirSync(dir);
                } catch (e) {
                  /* ignore */
                }
              } catch (e) {
                /* ignore */
              }
            };
            deleteRecursive(workDir);
          }
        } catch (e) {
          // Silently ignore - cleanup failures should not affect response
          console.log("Cleanup warning (non-critical):", e.message);
        }
      }
    } catch (cleanupError) {
      // Silently ignore - cleanup failures should not affect response
      console.log("Cleanup warning (non-critical):", cleanupError.message);
    }

    // Re-throw the error so it's caught by the async handler
    throw error;
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

// Helper function to generate CSV (from export-csv.js)
function generateCSV(data) {
  const rows = [];

  // Header
  rows.push([
    "Year",
    "Player Name",
    "UTR",
    "Wins",
    "Losses",
    "Win %",
    "Games Won",
    "Games Lost",
    "Games Win %",
  ]);

  // Add player row
  const player = data.player || {};
  const singles = data.singles || {};
  const record = singles.record || {};
  const games = singles.gamesRecord || {};

  rows.push([
    data.year || "",
    player.name || "",
    player.singlesUtr || "",
    record.wins || 0,
    record.losses || 0,
    record.winPct || 0,
    games.won || 0,
    games.lost || 0,
    games.winPct || 0,
  ]);

  // Add matches
  if (singles.matches && singles.matches.length > 0) {
    rows.push([]); // Empty row
    rows.push(["Matches:"]); // Section header
    rows.push([
      "Date",
      "Opponent",
      "Result",
      "Score",
      "UTR",
      "Opponent UTR",
      "UTR Diff",
    ]);

    singles.matches.forEach((m) => {
      rows.push([
        m.date || "",
        m.opponent || "",
        m.won ? "Win" : "Loss",
        m.score || "",
        m.myUtr || m.myUtrBefore || "",
        m.opponentUtr || m.opponentUtrBefore || "",
        m.opponentUtr && m.myUtr ? (m.opponentUtr - m.myUtr).toFixed(2) : "",
      ]);
    });
  }

  // Add opponents
  if (singles.frequentOpponents && singles.frequentOpponents.length > 0) {
    rows.push([]);
    rows.push(["Frequent Opponents:"]);
    rows.push(["Opponent", "Matches", "Record", "Games Record", "UTR"]);

    singles.frequentOpponents.forEach((opp) => {
      rows.push([
        opp.name || "",
        opp.played || 0,
        opp.record || "",
        opp.gamesRecord || "",
        opp.utr || "",
      ]);
    });
  }

  // Convert to CSV string
  function escapeCSV(value) {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  return rows.map((row) => row.map(escapeCSV).join(",")).join("\n");
}
