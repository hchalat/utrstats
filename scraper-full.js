// scraper-full.js - Comprehensive UTR scraper with opponent tracking
// Run with: node scraper-full.js <profile_id> [--force]

// Use Puppeteer for Lambda compatibility
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const {
  parseMatch,
  inferYears,
  attachRatingDeltas,
} = require("./lib/match-parser");
const { parseApiResults, mergeMatches } = require("./lib/api-parser");

// Use @sparticuz/chromium for Lambda (actively maintained, includes all dependencies)
// This is the recommended package for AWS Lambda
let chromium = null;
try {
  // Try from Lambda layer first
  chromium = require("/opt/nodejs/node_modules/@sparticuz/chromium");
} catch (e) {
  try {
    // Fall back to local node_modules
    chromium = require("@sparticuz/chromium");
  } catch (e2) {
    // Not available, will try to find system Chrome/Chromium
    console.log(
      "⚠️  @sparticuz/chromium not found, will try system Chrome/Chromium",
    );
  }
}

const PROFILE_ID = process.argv[2] || "904826";
const FORCE_REFRESH = process.argv.includes("--force");
const FORCE_LOGIN = process.argv.includes("--login"); // Force fresh login
const FAST_MODE = process.argv.includes("--fast"); // Skip opponent histories for speed
const ULTRA_FAST_MODE = process.argv.includes("--ultra-fast"); // Skip rating history + opponent histories
const BASE_URL = "https://app.utrsports.net";

// Cache settings
// Use CACHE_DIR from environment if set (for Lambda), otherwise use local cache
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "cache");
const CACHE_VERSION = "3.0"; // Bump this to invalidate cache
const CACHE_MAX_AGE_DAYS = 7; // Cache valid for 7 days
const AUTH_STATE_FILE = path.join(CACHE_DIR, "auth-state.json");

// Rate limiting - optimized for speed while staying safe
const DELAY_BETWEEN_PAGES = 800; // 800ms between page loads (with jitter)
const DELAY_BETWEEN_OPPONENTS = 300; // 300ms base delay for opponent lookups (with jitter)
const MAX_OPPONENTS_TO_FETCH = 15; // Limit opponent lookups
const MAX_PARALLEL_OPPONENTS = 4; // Fetch up to 4 opponents concurrently
const ENABLE_RESOURCE_BLOCKING = true; // Block images/fonts/CSS to speed up loading
// A refresh normally re-fetches only the last 12 months of results and
// merges them into the previous bundle (PREVIOUS_BUNDLE); the full career is
// re-walked once the last full walk is older than this, which picks up late
// edits and deletions to older results.
const FULL_RESULTS_MAX_AGE_DAYS = 60;

// The previous bundle, if it can seed an incremental results fetch: every
// match must come from the API (merging keys on resultId) and its last full
// walk must be recent enough that the 12-month fetch overlaps it.
function loadPreviousBundle() {
  const p = process.env.PREVIOUS_BUNDLE;
  if (!p || !fs.existsSync(p)) return null;
  try {
    const bundle = JSON.parse(fs.readFileSync(p, "utf8"));
    const all = [
      ...(bundle.singles?.matches || []),
      ...(bundle.doubles?.matches || []),
    ];
    const fullAgeDays =
      (Date.now() - new Date(bundle.resultsFullAt || 0).getTime()) / 86400000;
    if (
      bundle.schemaVersion !== 2 ||
      fullAgeDays > FULL_RESULTS_MAX_AGE_DAYS ||
      all.some((m) => m.source !== "api" || m.resultId == null)
    ) {
      return null;
    }
    return bundle;
  } catch (e) {
    console.log(`⚠️  Could not read previous bundle: ${e.message}`);
    return null;
  }
}

// Add random jitter to delays to appear more human-like
function randomDelay(baseMs, jitterMs = 200) {
  const jitter = Math.random() * jitterMs;
  return baseMs + jitter;
}

// Helper function to replace page.waitForTimeout (removed in Puppeteer v21+)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper function to replace page.$x (removed in Puppeteer v21+)
// Uses XPath via evaluate instead
async function findByXPath(page, xpath) {
  return await page.evaluate((xpathExpr) => {
    const result = [];
    const nodesSnapshot = document.evaluate(
      xpathExpr,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    for (let i = 0; i < nodesSnapshot.snapshotLength; i++) {
      result.push(nodesSnapshot.snapshotItem(i));
    }
    return result;
  }, xpath);
}

// Helper to click an element found by XPath
async function clickByXPath(page, xpath) {
  return await page.evaluate((xpathExpr) => {
    const element = document.evaluate(
      xpathExpr,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue;
    if (element) {
      element.click();
      return true;
    }
    return false;
  }, xpath);
}

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Check if we have saved auth state
function hasAuthState() {
  try {
    if (fs.existsSync(AUTH_STATE_FILE)) {
      const stat = fs.statSync(AUTH_STATE_FILE);
      const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
      // Auth state valid for 24 hours
      if (ageHours < 24) {
        return true;
      }
      console.log("Auth state expired (>24 hours old)");
    }
  } catch (e) {}
  return false;
}

async function saveAuthState(browser) {
  // Puppeteer: Save cookies manually
  try {
    const pages = await browser.pages();
    if (pages.length > 0) {
      const cookies = await pages[0].cookies();
      // Ensure cache directory exists
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify({ cookies }, null, 2));
      console.log(`💾 Saved auth state (cookies) for future runs`);
      console.log(`   Location: ${AUTH_STATE_FILE}`);
      console.log(`   Cookies: ${cookies.length}`);
    } else {
      console.log("⚠️  No pages available to save cookies from");
    }
  } catch (e) {
    console.log(`❌ Could not save auth state: ${e.message}`);
    console.log(`   Tried to save to: ${AUTH_STATE_FILE}`);
  }
}

// Load credentials if available
let credentials = null;
try {
  // Check SECRETS_PATH env var first (Lambda), then secrets/secrets.json, then secrets.json at root
  const candidatePaths = [
    process.env.SECRETS_PATH,
    path.join(__dirname, "secrets", "secrets.json"),
    path.join(__dirname, "secrets.json"),
  ].filter(Boolean);
  const secretsPath = candidatePaths.find((p) => fs.existsSync(p));
  if (secretsPath) {
    credentials = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    console.log("📧 Credentials loaded from:", secretsPath);
  } else {
    console.log("ℹ️  No secrets file found in:", candidatePaths.join(", "));
  }
} catch (e) {
  console.log("ℹ️  Error loading secrets:", e.message);
  console.log("ℹ️  Will prompt for login if needed");
}

// Cache helpers
function getCachePath(type, id) {
  return path.join(CACHE_DIR, `${type}-${id}.json`);
}

function loadFromCache(type, id) {
  const cachePath = getCachePath(type, id);
  try {
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));

      // Check version
      if (data._cacheVersion !== CACHE_VERSION) {
        console.log(
          `   Cache version mismatch for ${type}-${id}, will refresh`,
        );
        return null;
      }

      // Check age (max 7 days)
      if (data._cachedAt) {
        const cacheDate = new Date(data._cachedAt);
        const ageInDays =
          (Date.now() - cacheDate.getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays > CACHE_MAX_AGE_DAYS) {
          console.log(
            `   Cache expired for ${type}-${id} (${ageInDays.toFixed(1)} days old), will refresh`,
          );
          return null;
        }
      }

      return data;
    }
  } catch (e) {}
  return null;
}

function saveToCache(type, id, data) {
  const cachePath = getCachePath(type, id);
  data._cacheVersion = CACHE_VERSION;
  data._cachedAt = new Date().toISOString();
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

// Cache for opponent rating histories
const opponentCache = {};

async function scrapeUTR(profileId) {
  const scriptStartTime = Date.now();
  console.log(`\n🎾 Full UTR Scraper - Profile ${profileId}\n`);
  console.log(`⏱️  Start time: ${new Date().toISOString()}\n`);

  // Check for cached profile data
  if (!FORCE_REFRESH) {
    const cached = loadFromCache("profile", profileId);
    if (cached && cached.singlesMatches?.length > 0) {
      console.log(`📦 Using cached data from ${cached._cachedAt}`);
      console.log(
        `   Run with --force to refresh: node scraper-full.js ${profileId} --force\n`,
      );
      printSummary(cached);

      // Still save to the output file for the generator
      const outputDir = process.env.OUTPUT_DIR || __dirname;
      const outputPath = path.join(outputDir, `utr-full-${profileId}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(cached, null, 2));
      console.log(`\n✅ Using cached data from ${outputPath}`);
      return cached;
    }
  } else {
    console.log("🔄 Force refresh requested\n");
  }

  // Use persistent browser context to keep login across runs
  const userDataDir = path.join(CACHE_DIR, "browser-data");

  let context;
  let browser;

  if (FORCE_LOGIN) {
    console.log("🔄 Force login requested - will create fresh session");
    // Clear browser data for fresh login
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }

  // Use persistent context - this keeps cookies/login across runs
  const browserLaunchStart = Date.now();
  console.log("🌐 Launching browser with persistent session...");
  // In Lambda, we must use headless mode and Chromium from /opt/chromium
  const isLambda =
    !!process.env.LAMBDA_TASK_ROOT || !!process.env.CHROMIUM_PATH;
  const chromiumPath = process.env.CHROMIUM_PATH || "/opt/chromium";

  // Try multiple possible Chromium paths (chrome-aws-lambda layer typically uses /opt/chrome)
  // The chrome-aws-lambda layer typically puts it at /opt/chrome or /opt/chrome/chrome
  const possiblePaths = [
    chromiumPath, // From environment variable
    "/opt/chrome", // chrome-aws-lambda layer default
    "/opt/chrome/chrome", // Alternative location
    "/opt/chromium", // Alternative
    "/opt/chromium/chromium", // Alternative
  ];

  let foundChromiumPath = null;
  if (isLambda) {
    // First, try to get Chromium path from chrome-aws-lambda package
    if (chromium) {
      try {
        const chromePath = await chromium.executablePath();
        if (chromePath && fs.existsSync(chromePath)) {
          foundChromiumPath = chromePath;
          console.log(
            `✅ Found Chromium via chrome-aws-lambda at: ${foundChromiumPath}`,
          );
        } else {
          console.log(
            `⚠️  chrome-aws-lambda returned path but file doesn't exist: ${chromePath}`,
          );
        }
      } catch (e) {
        console.log(
          "Error getting Chromium path from chrome-aws-lambda:",
          e.message,
        );
      }
    }

    // If chrome-aws-lambda didn't work, try to list /opt to see what's actually there
    if (!foundChromiumPath) {
      try {
        if (fs.existsSync("/opt")) {
          const optContents = fs.readdirSync("/opt");
          console.log("Contents of /opt:", optContents.join(", "));

          // Try to find chrome/chromium in subdirectories
          for (const item of optContents) {
            const itemPath = path.join("/opt", item);
            try {
              if (fs.statSync(itemPath).isDirectory()) {
                const subContents = fs.readdirSync(itemPath);
                console.log(
                  `Contents of /opt/${item}:`,
                  subContents.join(", "),
                );

                // Check for chrome or chromium executable
                for (const subItem of subContents) {
                  const subPath = path.join(itemPath, subItem);
                  if (
                    subItem === "chrome" ||
                    subItem === "chromium" ||
                    subItem === "headless_shell"
                  ) {
                    if (fs.existsSync(subPath)) {
                      const stat = fs.statSync(subPath);
                      if (
                        stat.isFile() ||
                        (stat.isDirectory() &&
                          fs.existsSync(path.join(subPath, "chrome")))
                      ) {
                        foundChromiumPath = stat.isFile()
                          ? subPath
                          : path.join(subPath, "chrome");
                        console.log(
                          `✅ Found Chromium at: ${foundChromiumPath}`,
                        );
                        break;
                      }
                    }
                  }
                }
                if (foundChromiumPath) break;
              } else if (item === "chrome" || item === "chromium") {
                foundChromiumPath = itemPath;
                console.log(`✅ Found Chromium at: ${foundChromiumPath}`);
                break;
              }
            } catch (e) {
              // Ignore errors reading subdirectories
            }
          }
        }
      } catch (e) {
        console.log("Could not list /opt directory:", e.message);
      }
    }

    // If not found by searching, try the standard paths
    if (!foundChromiumPath) {
      for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
          foundChromiumPath = testPath;
          console.log(`✅ Found Chromium at: ${testPath}`);
          break;
        }
      }
    }

    if (!foundChromiumPath) {
      console.log(
        `⚠️  Chromium not found at any of: ${possiblePaths.join(", ")}`,
      );
      console.log("Will try to use Playwright default (may fail in Lambda)");
    }
  }

  let executablePath;
  let launchArgs = [];

  if (isLambda && chromium) {
    // Use chrome-aws-lambda for Lambda (designed for Puppeteer)
    try {
      executablePath = await chromium.executablePath();
      launchArgs = chromium.args || [];
      console.log(`✅ Using @sparticuz/chromium: ${executablePath}`);
      console.log(`   Args: ${launchArgs.length} arguments`);
      // @sparticuz/chromium handles all library setup automatically
    } catch (e) {
      console.log("Error getting @sparticuz/chromium config:", e.message);
      throw new Error(
        "Failed to get Chromium from @sparticuz/chromium. Make sure the package is installed or layer is attached.",
      );
    }
  } else if (foundChromiumPath) {
    executablePath = foundChromiumPath;
    console.log(`✅ Using found Chromium: ${executablePath}`);
  } else {
    // Local development - try to find Chrome/Chromium
    const possiblePaths = [
      process.env.CHROMIUM_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ];

    for (const testPath of possiblePaths) {
      if (testPath && fs.existsSync(testPath)) {
        executablePath = testPath;
        console.log(`✅ Found Chromium at: ${executablePath}`);
        break;
      }
    }

    if (!executablePath) {
      throw new Error(
        "Chromium not found. Install Chrome or set CHROMIUM_PATH.",
      );
    }
  }

  const launchOptions = {
    headless: true, // Always run headless to avoid popup windows
    executablePath: executablePath,
    args: [
      ...launchArgs,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--user-data-dir=" + userDataDir,
    ],
    defaultViewport: chromium?.defaultViewport || { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
  };

  console.log(`Launching browser with Puppeteer...`);

  try {
    browser = await puppeteer.launch(launchOptions);
    const browserLaunchTime = Date.now() - browserLaunchStart;
    console.log("✅ Browser launched successfully");
    console.log(
      `⏱️  Browser launch took ${(browserLaunchTime / 1000).toFixed(2)}s`,
    );
  } catch (browserError) {
    console.error("❌ Failed to launch browser:", browserError.message);
    throw new Error(`Browser launch failed: ${browserError.message}`);
  }
  // Get the default page or create one
  const pages = await browser.pages();
  let page = pages[0];
  if (!page) {
    page = await browser.newPage();
  }

  // Set user agent
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  page.setDefaultTimeout(60000); // 60 second timeout
  page.setDefaultNavigationTimeout(60000);

  // Puppeteer compatibility: set viewport
  await page.setViewport({ width: 1400, height: 900 });

  // Load saved auth state (cookies) if available
  // First check for Lambda-packaged auth state, then local cache
  const TASK_DIR = process.env.LAMBDA_TASK_ROOT || "/var/task";
  const lambdaAuthPath = path.join(TASK_DIR, "auth-state-lambda.json");
  const localAuthPath = AUTH_STATE_FILE;
  let authStatePath = null;

  if (fs.existsSync(lambdaAuthPath)) {
    authStatePath = lambdaAuthPath;
    console.log("📦 Loading auth state from Lambda package...");
  } else if (fs.existsSync(localAuthPath)) {
    authStatePath = localAuthPath;
    console.log("📦 Loading auth state from local cache...");
  }

  if (authStatePath) {
    try {
      const authState = JSON.parse(fs.readFileSync(authStatePath, "utf8"));
      if (authState.cookies && authState.cookies.length > 0) {
        // Navigate to UTR domain first to set cookies (required for cookie domain matching)
        await page.goto(`${BASE_URL}`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        // Set cookies
        await page.setCookie(...authState.cookies);
        console.log(
          `   ✅ Loaded ${authState.cookies.length} cookies from saved session`,
        );
        console.log("   Will skip login and use saved session");
      }
    } catch (e) {
      console.log(`   ⚠️  Could not load auth state: ${e.message}`);
    }
  }

  // A session token from the Lambda (refreshed by earlier runs) is fresher
  // than the deploy-time cookies and usually makes the login flow — the
  // most conspicuous thing a scrape does — unnecessary.
  if (process.env.UTR_JWT) {
    try {
      if (!authStatePath) {
        await page.goto(`${BASE_URL}`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }
      await page.setCookie({
        name: "jwt",
        value: process.env.UTR_JWT,
        domain: ".utrsports.net",
        path: "/",
        secure: true,
      });
      console.log("   ✅ Using stored session token");
    } catch (e) {
      console.log(`   ⚠️  Could not set session token: ${e.message}`);
    }
  }

  const results = {
    profileId,
    scrapedAt: new Date().toISOString(),
    player: {},
    singlesHistory: [],
    doublesHistory: [],
    singlesMatches: [],
    doublesMatches: [],
    opponentHistories: {},
  };

  try {
    // Go to profile
    const profileLoadStart = Date.now();
    console.log("Opening UTR profile...");
    await page.goto(`${BASE_URL}/profiles/${profileId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await delay(3000); // Give it time to load JS
    console.log(
      `⏱️  Profile page loaded in ${((Date.now() - profileLoadStart) / 1000).toFixed(2)}s`,
    );

    // Check if logged in - wait for page to fully load first
    await delay(3000);

    // Take initial screenshot
    await page.screenshot({ path: path.join(CACHE_DIR, "initial-page.png") });

    let loginInfo = await page.evaluate(() => {
      const state = window.INITIAL_STATE;
      const userId = state?.auth?.user?.id;
      const userName = state?.auth?.user?.firstName;
      // Check for login button by looking at all buttons/links
      let hasLoginBtn = false;
      document.querySelectorAll("a, button").forEach((el) => {
        const text = el.innerText?.toLowerCase() || "";
        if (text.includes("sign in") || text.includes("log in")) {
          hasLoginBtn = true;
        }
      });
      return {
        userId,
        userName,
        hasLoginBtn,
        isLoggedIn: !!userId && !hasLoginBtn,
      };
    });

    let isLoggedIn = loginInfo.isLoggedIn;
    console.log(
      `Login check: userId=${loginInfo.userId}, name=${loginInfo.userName}, hasLoginBtn=${loginInfo.hasLoginBtn}`,
    );

    if (!isLoggedIn && credentials) {
      const loginStart = Date.now();
      console.log("\n🔐 Logging in with credentials...");
      try {
        // Dismiss any popups/modals first
        console.log("   Checking for popups...");
        const popupDismissed = await page.evaluate(() => {
          // Try to close any popup overlays
          const closeButtons = document.querySelectorAll(
            '[class*="close"], [class*="dismiss"], [aria-label*="close" i], button[class*="popup"]',
          );
          closeButtons.forEach((btn) => btn.click());

          // Click outside popups
          const overlays = document.querySelectorAll('[class*="overlay"]');
          overlays.forEach((o) => {
            if (o.click) o.click();
          });

          return closeButtons.length + overlays.length;
        });
        if (popupDismissed > 0) {
          console.log(`   Dismissed ${popupDismissed} popup elements`);
          await delay(1000);
        }

        // Press Escape to close any remaining modals
        await page.keyboard.press("Escape");
        await delay(500);

        // Navigate directly to login page to avoid Facebook OAuth redirect
        console.log("   Navigating to login page...");
        await page.goto(`${BASE_URL}/login`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await delay(3000);

        // Check if we got redirected to Facebook OAuth
        let currentUrl = page.url();
        if (currentUrl.includes("facebook.com")) {
          console.log(
            "   ⚠️  Redirected to Facebook OAuth, trying to go back...",
          );
          await page.goBack({ waitUntil: "domcontentloaded" });
          await delay(2000);
          // Try navigating to login again
          await page.goto(`${BASE_URL}/login`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await delay(3000);
          currentUrl = page.url(); // Update URL after navigation
        }

        // Look for email/password form directly (not Facebook OAuth)
        const hasEmailForm = await page.evaluate(() => {
          const emailInputs = document.querySelectorAll(
            'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]',
          );
          const passwordInputs = document.querySelectorAll(
            'input[type="password"], input[name*="password" i], input[id*="password" i]',
          );
          return emailInputs.length > 0 && passwordInputs.length > 0;
        });

        if (!hasEmailForm) {
          console.log(
            "   ⚠️  No email/password form found, page might be using OAuth only",
          );
          // Try to find a link to email/password login
          const clicked = await clickByXPath(
            page,
            "//a[contains(text(), 'email') or contains(text(), 'Email') or contains(text(), 'password')]",
          );
          if (clicked) {
            console.log("   Found email login link, clicking...");
            await delay(2000);
          }
        }

        // Dismiss the cookie banner so it can't sit on top of the form.
        const cookieDeclined = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find(
            (b) =>
              /^\s*decline\s*$/i.test(b.innerText || "") &&
              b.getBoundingClientRect().width > 0,
          );
          if (btn) btn.click();
          return !!btn;
        });
        if (cookieDeclined) {
          console.log("   Declined cookie banner");
          await delay(500);
        }

        // UTR's sign-in form: #emailInput, then the "enter my password" link
        // reveals #passwordInput. The default "SEND A LINK" submit button
        // emails a magic link instead — never click it.
        const emailSelectors = [
          "#emailInput",
          'input[type="email"]',
          'input[name="email"]',
          'input[placeholder*="email" i]',
          'input[id*="email" i]',
        ];
        let workingEmailSelector = null;
        try {
          await page.waitForSelector(emailSelectors.join(", "), {
            visible: true,
            timeout: 15000,
          });
        } catch (e) {}
        for (const selector of emailSelectors) {
          const visible = await page.evaluate((sel) => {
            return Array.from(document.querySelectorAll(sel)).some(
              (el) => el.getBoundingClientRect().width > 0,
            );
          }, selector);
          if (visible) {
            workingEmailSelector = selector;
            break;
          }
        }

        if (workingEmailSelector) {
          console.log(`   Found email field with selector: ${workingEmailSelector}`);
          // Fill via the native value setter + input event: React-controlled
          // and works even if an overlay makes the field "not clickable".
          await page.evaluate(
            (sel, value) => {
              const el = Array.from(document.querySelectorAll(sel)).find(
                (e) => e.getBoundingClientRect().width > 0,
              );
              el.scrollIntoView({ block: "center" });
              el.focus();
              const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
              ).set;
              setter.call(el, value);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            },
            workingEmailSelector,
            credentials.username || credentials.email,
          );
          console.log(`   ✅ Filled email using selector: ${workingEmailSelector}`);
        } else {
          await page.screenshot({
            path: path.join(CACHE_DIR, "login-timeout.png"),
          });
          console.log("   ⚠️  Email field not found, screenshot saved");
        }
        await delay(1000);

        // Switch to password login ("enter my password"; older UI: "Continue").
        console.log("   Switching to password login...");
        const passwordModeText = await page.evaluate(() => {
          const RE = /enter my password|use (a |my )?password|^\s*continue\s*$/i;
          const btn = Array.from(
            document.querySelectorAll("button, a, [role='button']"),
          ).find((b) => {
            const text = (b.innerText || "").trim();
            const rect = b.getBoundingClientRect();
            return RE.test(text) && rect.width > 0 && rect.height > 0;
          });
          if (!btn) return null;
          btn.click();
          return btn.innerText.trim();
        });
        if (passwordModeText) {
          console.log(`   ✅ Clicked "${passwordModeText}"`);
          try {
            await page.waitForSelector('input[type="password"]', {
              visible: true,
              timeout: 8000,
            });
            console.log("   ✅ Password field appeared");
          } catch (e) {
            console.log("   ⚠️  Password field did not appear");
          }
        } else {
          console.log(
            "   ⚠️  Could not find the password-login option - password field may not appear",
          );
        }

        // Find password field - try multiple methods with longer waits
        const passwordSelectors = [
          "#passwordInput",
          'input[type="password"]',
          'input[name="password"]',
          'input[name*="password" i]',
          'input[id*="password" i]',
          'input[placeholder*="password" i]',
          'input[autocomplete*="password" i]',
        ];
        let passwordInput = null;
        let workingPasswordSelector = null;

        // First try waiting for any password field to appear
        try {
          await page.waitForSelector('input[type="password"]', {
            timeout: 5000,
          });
        } catch (e) {
          console.log("   ⚠️  Password field did not appear after wait");
        }

        // Try all selectors
        for (const selector of passwordSelectors) {
          try {
            passwordInput = await page.$(selector);
            if (passwordInput) {
              workingPasswordSelector = selector;
              break;
            }
          } catch (e) {
            // Try next selector
          }
        }

        if (passwordInput) {
          await passwordInput.focus();
          await page.keyboard.down("Control");
          await page.keyboard.press("a");
          await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await passwordInput.type(credentials.password, { delay: 50 });
          console.log(
            `   ✅ Filled password using selector: ${workingPasswordSelector}`,
          );
        } else {
          console.log(
            "   ⚠️  Could not find password input with selectors - trying evaluate()...",
          );
          // Last resort: try to find and fill via evaluate with more comprehensive search
          const passwordFilled = await page.evaluate((password) => {
            // Try multiple ways to find password field - be very thorough
            const allInputs = document.querySelectorAll("input");
            let passwordField = null;

            // First, try to find by type
            for (const input of allInputs) {
              if (input.type === "password") {
                passwordField = input;
                break;
              }
            }

            // If not found, try by name/id/placeholder
            if (!passwordField) {
              for (const input of allInputs) {
                const name = (input.name || "").toLowerCase();
                const id = (input.id || "").toLowerCase();
                const placeholder = (input.placeholder || "").toLowerCase();
                const autocomplete = (input.autocomplete || "").toLowerCase();

                if (
                  name.includes("password") ||
                  id.includes("password") ||
                  placeholder.includes("password") ||
                  autocomplete.includes("password")
                ) {
                  passwordField = input;
                  break;
                }
              }
            }

            // If still not found, try the second input field (often password is second)
            if (!passwordField && allInputs.length >= 2) {
              const secondInput = allInputs[1];
              if (secondInput.type !== "email" && secondInput.type !== "text") {
                passwordField = secondInput;
              }
            }

            if (passwordField) {
              passwordField.focus();
              passwordField.value = password;
              passwordField.dispatchEvent(
                new Event("input", { bubbles: true }),
              );
              passwordField.dispatchEvent(
                new Event("change", { bubbles: true }),
              );
              passwordField.dispatchEvent(new Event("blur", { bubbles: true }));
              // Also try keyup event
              passwordField.dispatchEvent(
                new KeyboardEvent("keyup", { bubbles: true }),
              );
              return true;
            }
            return false;
          }, credentials.password);
          if (passwordFilled) {
            console.log("   ✅ Filled password via evaluate()");
          } else {
            console.log(
              "   ❌ Could not fill password - login will likely fail",
            );
            // Take screenshot for debugging
            await page.screenshot({
              path: path.join(CACHE_DIR, "password-not-found.png"),
            });
            console.log("   Screenshot saved to cache/password-not-found.png");
            // Also log what inputs are on the page
            const inputInfo = await page.evaluate(() => {
              const inputs = document.querySelectorAll("input");
              return Array.from(inputs).map((input) => ({
                type: input.type,
                name: input.name,
                id: input.id,
                placeholder: input.placeholder,
                autocomplete: input.autocomplete,
              }));
            });
            console.log(
              `   Found ${inputInfo.length} input fields on page:`,
              JSON.stringify(inputInfo, null, 2),
            );
          }
        }
        await delay(1000);

        // Take a screenshot for debugging
        await page.screenshot({
          path: path.join(CACHE_DIR, "login-form-filled.png"),
        });
        console.log("   Screenshot saved to cache/login-form-filled.png");

        // Click submit button - try multiple methods
        let submitSuccess = false;

        // Method 1: Find the button whose visible text is "Sign In" / "Log In".
        // UTR's login modal also shows a passwordless "SEND A LINK" button — match
        // text explicitly so a broad selector doesn't grab the wrong one.
        try {
          const clicked = await page.evaluate(() => {
            const buttons = Array.from(
              document.querySelectorAll('button, input[type="submit"]'),
            );
            const SIGN_IN_RE = /^\s*(sign\s*in|log\s*in)\s*$/i;
            const candidates = buttons.filter((btn) => {
              const text = (btn.innerText || btn.value || "").trim();
              if (!SIGN_IN_RE.test(text)) return false;
              const rect = btn.getBoundingClientRect();
              const style = window.getComputedStyle(btn);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                !btn.disabled
              );
            });
            if (candidates.length === 0) return null;
            // Prefer the button nearest the password field (usually the same form).
            const pwd = document.querySelector('input[type="password"]');
            let target = candidates[0];
            if (pwd) {
              const pwdRect = pwd.getBoundingClientRect();
              target = candidates.reduce((best, btn) => {
                const r = btn.getBoundingClientRect();
                const dist = Math.hypot(
                  r.left - pwdRect.left,
                  r.top - pwdRect.top,
                );
                const bestRect = best.getBoundingClientRect();
                const bestDist = Math.hypot(
                  bestRect.left - pwdRect.left,
                  bestRect.top - pwdRect.top,
                );
                return dist < bestDist ? btn : best;
              }, candidates[0]);
            }
            target.click();
            return (target.innerText || target.value || "").trim();
          });
          if (clicked) {
            console.log(`   Clicked submit button (text="${clicked}")`);
            submitSuccess = true;
          }
        } catch (e) {}

        // Method 2: Fall back to standard submit button selectors.
        if (!submitSuccess) {
          try {
            const submitSelectors = [
              'button[type="submit"]',
              'input[type="submit"]',
              '[type="submit"]',
            ];

            for (const selector of submitSelectors) {
              try {
                const btn = await page.$(selector);
                if (btn) {
                  const isVisible = await page.evaluate((el) => {
                    const rect = el.getBoundingClientRect();
                    return (
                      rect.width > 0 &&
                      rect.height > 0 &&
                      window.getComputedStyle(el).visibility !== "hidden" &&
                      window.getComputedStyle(el).display !== "none" &&
                      // Passwordless button: would email a magic link.
                      !/send a link/i.test(el.innerText || el.value || "")
                    );
                  }, btn);

                  if (isVisible) {
                    await btn.click();
                    console.log(`   Clicked submit button (${selector})`);
                    submitSuccess = true;
                    break;
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
        }

        // Method 3: Try pressing Enter in password field
        if (!submitSuccess && passwordInput) {
          try {
            await passwordInput.focus();
            await page.keyboard.press("Enter");
            console.log("   Pressed Enter to submit");
            submitSuccess = true;
          } catch (e) {}
        }

        // Method 4: Try form submit
        if (!submitSuccess) {
          try {
            await page.evaluate(() => {
              const form = document.querySelector("form");
              if (form) form.submit();
            });
            console.log("   Submitted form directly");
            submitSuccess = true;
          } catch (e) {}
        }

        if (!submitSuccess) {
          console.log(
            "   ⚠️  Could not find submit button, waiting for navigation...",
          );
        }

        // Wait for navigation after login - but check URL to avoid Facebook redirect
        let navigationSuccess = false;
        try {
          await Promise.race([
            page.waitForNavigation({
              waitUntil: "networkidle0",
              timeout: 15000,
            }),
            page.waitForFunction(
              () => {
                const url = window.location.href;
                return !url.includes("facebook.com") && !url.includes("login");
              },
              { timeout: 15000 },
            ),
          ]);
          navigationSuccess = true;
          console.log("   ✅ Navigation detected after login");
        } catch (e) {
          console.log(
            "   ⚠️  No navigation detected, waiting and checking login status...",
          );
          await delay(5000);
        }

        // Check if we got redirected to Facebook
        currentUrl = page.url();
        if (currentUrl.includes("facebook.com")) {
          console.log(
            "   ⚠️  Redirected to Facebook OAuth - login form may not be available",
          );
          console.log("   Trying to navigate back to UTR...");
          await page.goto(`${BASE_URL}/profiles/${profileId}`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await delay(3000);
        }

        // Verify login succeeded
        const loginCheck = await page.evaluate(() => {
          const state = window.INITIAL_STATE;
          const userId = state?.auth?.user?.id;
          const userName =
            state?.auth?.user?.firstName || state?.auth?.user?.name;
          return { userId, userName, isLoggedIn: !!userId };
        });

        if (loginCheck.isLoggedIn) {
          console.log(
            `   ✅ Login successful! User: ${loginCheck.userName || "Unknown"} (ID: ${loginCheck.userId})`,
          );
          console.log(
            `⏱️  Login completed in ${((Date.now() - loginStart) / 1000).toFixed(2)}s`,
          );
          isLoggedIn = true;
        } else {
          console.log("   ⚠️  Login may have failed - userId still undefined");
          // Check if we're on the right page
          if (!currentUrl.includes("/profiles/")) {
            console.log("   Navigating to profile page...");
            await page.goto(`${BASE_URL}/profiles/${profileId}`, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            });
            await delay(3000);

            // Check again after navigation
            const loginCheck2 = await page.evaluate(() => {
              const state = window.INITIAL_STATE;
              const userId = state?.auth?.user?.id;
              const userName =
                state?.auth?.user?.firstName || state?.auth?.user?.name;
              return { userId, userName, isLoggedIn: !!userId };
            });
            if (loginCheck2.isLoggedIn) {
              console.log(
                `   ✅ Login verified after navigation! User: ${loginCheck2.userName || "Unknown"} (ID: ${loginCheck2.userId})`,
              );
              isLoggedIn = true;
            }
          }

          if (!isLoggedIn) {
            // Take screenshot for debugging
            await page.screenshot({
              path: path.join(CACHE_DIR, "login-failed.png"),
            });
            console.log("   Screenshot saved to cache/login-failed.png");
          }
        }

        // Verify login - use proper check with userId
        const loginVerify = await page.evaluate(() => {
          const state = window.INITIAL_STATE;
          const userId = state?.auth?.user?.id;
          const userName =
            state?.auth?.user?.firstName || state?.auth?.user?.name;
          return { userId, userName, isLoggedIn: !!userId };
        });

        if (loginVerify.isLoggedIn) {
          console.log(
            `✅ Logged in successfully: ${loginVerify.userName || "Unknown"} (ID: ${loginVerify.userId})`,
          );
          isLoggedIn = true;
          await saveAuthState(browser); // Save for future runs
        } else {
          console.log("⚠️  Login verification failed - userId still undefined");
          console.log("   Will try to continue but matches may not be found");
          await page.screenshot({
            path: path.join(CACHE_DIR, "login-result.png"),
          });
          console.log("   Screenshot saved to cache/login-result.png");
        }
      } catch (e) {
        console.log("⚠️  Auto-login error:", e.message);
        await page.screenshot({
          path: path.join(CACHE_DIR, "login-error.png"),
        });
      }
    }

    if (!isLoggedIn && !credentials) {
      console.log("\n⚠️  Please log in to UTR in the browser window.");
      console.log("   You have 60 seconds to log in...\n");

      // Wait up to 60 seconds for login, checking every 3 seconds
      for (let i = 0; i < 20; i++) {
        await delay(3000);
        isLoggedIn = await page.evaluate(() => {
          const state = window.INITIAL_STATE;
          return !!state?.auth?.user?.id;
        });
        if (isLoggedIn) {
          console.log("✅ Login detected!");
          await saveAuthState(browser);
          break;
        }
        console.log(`   Waiting for login... (${(i + 1) * 3}/60s)`);
      }

      if (!isLoggedIn) {
        console.log("⚠️  Login timeout - continuing without authentication");
      }
    }

    // Final login check and save if we have a valid session
    // Only check if we haven't already verified login
    if (!isLoggedIn) {
      // Wait a bit for page to fully load
      await delay(2000);
      const finalCheck = await page.evaluate(() => {
        const state = window.INITIAL_STATE;
        const userId = state?.auth?.user?.id;
        const userName =
          state?.auth?.user?.firstName || state?.auth?.user?.name;
        return { userId, userName, isLoggedIn: !!userId };
      });
      if (finalCheck.isLoggedIn) {
        console.log(
          `✅ Session is authenticated: ${finalCheck.userName || "Unknown"} (ID: ${finalCheck.userId})`,
        );
        isLoggedIn = true;
        await saveAuthState(browser);
      } else {
        console.log("⚠️  Not logged in - userId still undefined");
        console.log("   This will cause matches to not be found");
        console.log(
          "   Login likely failed - check screenshots in cache/ for debugging",
        );
      }
    } else {
      // We already verified login (from loaded cookies), refresh the saved state
      console.log("✅ Using saved session - refreshing auth state...");
      await saveAuthState(browser);
    }

    // Store login status in results
    results.loginSuccessful = isLoggedIn;
    if (!isLoggedIn) {
      console.log("⚠️  WARNING: Not logged in - matches may not be visible");
      results.loginError = "Failed to authenticate - matches may be hidden";
    }

    // Get player info from page content
    results.player = await page.evaluate(() => {
      // Try multiple sources
      const state = window.INITIAL_STATE;

      // Get name from page header
      const h1 = document.querySelector("h1");
      const nameFromH1 = h1?.innerText?.trim() || "";

      // Try to find UTRs from the page
      const utrElements = document.querySelectorAll(
        '[class*="utr"], [class*="UTR"]',
      );
      let singlesUtr = null;
      let doublesUtr = null;

      // Look for UTR values in the profile section
      const allText = document.body.innerText;

      // Pattern: "UTR 8 (Singles): 5.74" or "UTR 88 (Doubles): 6.19"
      const singlesMatch = allText.match(
        /UTR\s+\d+\s*\(?Singles\)?[:\s]+(\d+\.\d{2})/i,
      );
      const doublesMatch = allText.match(
        /UTR\s+\d+\s*\(?Doubles\)?[:\s]+(\d+\.\d{2})/i,
      );

      if (singlesMatch) singlesUtr = parseFloat(singlesMatch[1]);
      if (doublesMatch) doublesUtr = parseFloat(doublesMatch[1]);

      // Fallback: look for standalone UTR numbers
      if (!singlesUtr) {
        utrElements.forEach((el) => {
          const text = el.innerText.trim();
          const utrMatch = text.match(/^(\d+\.\d{2})$/);
          if (utrMatch && !singlesUtr) {
            singlesUtr = parseFloat(utrMatch[1]);
          }
        });
      }

      return {
        id: state?.auth?.user?.id,
        name:
          nameFromH1 ||
          `${state?.auth?.user?.firstName || ""} ${state?.auth?.user?.lastName || ""}`.trim(),
        singlesUtr: singlesUtr || state?.profile?.data?.singlesUtr,
        doublesUtr: doublesUtr || state?.profile?.data?.doublesUtr,
      };
    });
    console.log(
      `Player: ${results.player.name || "Unknown"} (UTR: ${results.player.singlesUtr || "?"})`,
    );

    // ===== MATCHES VIA UTR API (primary path) =====
    // One authenticated call returns the full career with labeled winners,
    // structured set scores, and explicit tiebreak points — no score-digit
    // parsing. DOM scraping below remains as a fallback.
    let apiMatchesLoaded = false;
    try {
      const apiStart = Date.now();
      const previous = loadPreviousBundle();
      console.log(
        previous
          ? `\n📡 Fetching results from the last 12 months (full walk ${previous.resultsFullAt})`
          : "\n📡 Fetching full career results",
      );
      const apiData = await fetchApiData(page, profileId, {
        incremental: !!previous,
      });
      if (apiData?.profile) {
        const p = apiData.profile;
        results.player = {
          id: profileId,
          name:
            [p.firstName, p.lastName].filter(Boolean).join(" ") ||
            results.player.name,
          singlesUtr: p.singlesUtr || results.player.singlesUtr,
          doublesUtr: p.doublesUtr || results.player.doublesUtr,
        };
      }
      if (apiData?.results) {
        if (apiData.results._v4Counts) {
          console.log(`   v4 events per call: ${apiData.results._v4Counts}`);
        }
        let parsed = parseApiResults(apiData.results, profileId);
        const fetchedCount =
          parsed.singlesMatches.length + parsed.doublesMatches.length;
        if (previous) {
          parsed = {
            singlesMatches: mergeMatches(
              previous.singles?.matches,
              parsed.singlesMatches,
            ),
            doublesMatches: mergeMatches(
              previous.doubles?.matches,
              parsed.doublesMatches,
            ),
          };
        }
        if (parsed.singlesMatches.length + parsed.doublesMatches.length > 0) {
          results.singlesMatches = parsed.singlesMatches;
          results.doublesMatches = parsed.doublesMatches;
          results.dataSource = "api";
          results.resultsFullAt = previous
            ? previous.resultsFullAt
            : results.scrapedAt;
          apiMatchesLoaded = true;
          console.log(
            `✅ API results: ${parsed.singlesMatches.length} singles, ` +
              `${parsed.doublesMatches.length} doubles ` +
              (previous
                ? `(${fetchedCount} fetched from the last 12 months, merged)`
                : "(full career)") +
              ` in ${((Date.now() - apiStart) / 1000).toFixed(2)}s`,
          );
        }
      }
    } catch (e) {
      console.log(
        `⚠️  API fetch failed (${e.message}) — falling back to DOM scraping`,
      );
    }

    // ===== SINGLES RATING HISTORY =====
    const historyStart = Date.now();

    if (ULTRA_FAST_MODE) {
      console.log("\n⚡ Ultra-fast mode: skipping rating history");
      results.singlesHistory = [];
    } else {
      console.log("\n📊 Getting singles rating history...");
      await delay(DELAY_BETWEEN_PAGES); // Rate limiting
      await page.goto(`${BASE_URL}/profiles/${profileId}?t=6`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await delay(3000);

      // Click "Show all" link to load complete history
      let clickedShowAll = false;

      // First, scroll to make sure the button is visible
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1000);

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const clicked = await page.evaluate(() => {
            const xpath = "//*[contains(text(), 'Show all')]";
            const result = document.evaluate(
              xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            );
            const element = result.singleNodeValue;
            if (element) {
              const rect = element.getBoundingClientRect();
              if (
                rect.width > 0 &&
                rect.height > 0 &&
                window.getComputedStyle(element).visibility !== "hidden" &&
                window.getComputedStyle(element).display !== "none"
              ) {
                element.click();
                return true;
              }
            }
            return false;
          });
          if (clicked) {
            clickedShowAll = true;
            console.log('   Clicked "Show all" link');
            await delay(5000);
            break;
          }
        } catch (e) {}

        try {
          // Try clicking by selector with link text
          await page.click('a:has-text("Show all")', { timeout: 2000 });
          clickedShowAll = true;
          console.log('   Clicked "Show all" anchor');
          await delay(5000);
          break;
        } catch (e) {}

        try {
          // Puppeteer: use XPath for text matching
          const clicked = await clickByXPath(
            page,
            "//*[contains(text(), 'Show all')]",
          );
          if (clicked) {
            clickedShowAll = true;
            console.log('   Clicked "Show all" text element');
            await delay(5000);
            break;
          }
        } catch (e) {}

        await delay(1000);
      }

      if (!clickedShowAll) {
        console.log(
          '   Note: Could not find "Show all" link - history may be limited',
        );
      }

      // Scroll down again after click to reveal all loaded content
      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) {
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise((r) => setTimeout(r, 500));
        }
      });
      await delay(2000);

      // Take screenshot for debugging
      await page.screenshot({
        path: path.join(CACHE_DIR, "stats-page-after-showall.png"),
      });

      results.singlesHistory = await scrapeRatingHistory(page);
      console.log(
        `   Found ${results.singlesHistory.length} singles rating points`,
      );
      console.log(
        `⏱️  Rating history fetched in ${((Date.now() - historyStart) / 1000).toFixed(2)}s`,
      );
    } // End if (!ULTRA_FAST_MODE)

    // ===== DOM MATCH SCRAPING (fallback when API unavailable) =====
    if (!apiMatchesLoaded) {
      // ===== SINGLES MATCHES =====
      const singlesMatchesStart = Date.now();
      console.log("\n🎾 Getting singles matches...");
      await page.goto(`${BASE_URL}/profiles/${profileId}?t=2`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await delay(3000);

      // Ensure Singles tab is selected
      try {
        // Puppeteer: use XPath for text matching
        await clickByXPath(page, "//button[contains(text(), 'Singles')]");
        await delay(2000);
      } catch (e) {}

      // Wait for score cards to appear
      try {
        await page.waitForSelector(
          '.utr-card, [class*="score-card"], [class*="match"]',
          { timeout: 10000 },
        );
      } catch (e) {
        console.log("   Waiting for matches to load...");
        await delay(5000);
      }

      // Scroll to load all matches
      await scrollToBottom(page);

      // Debug: Check what's on the page
      await page.screenshot({ path: path.join(CACHE_DIR, "matches-page.png") });

      const pageDebug = await page.evaluate(() => {
        // Get all class names that contain common match-related words
        const allElements = document.querySelectorAll("*");
        const matchClasses = new Set();
        allElements.forEach((el) => {
          if (el.className && typeof el.className === "string") {
            const classes = el.className.split(" ");
            classes.forEach((c) => {
              if (
                c.toLowerCase().includes("match") ||
                c.toLowerCase().includes("score") ||
                c.toLowerCase().includes("result") ||
                c.toLowerCase().includes("event") ||
                c.toLowerCase().includes("card")
              ) {
                matchClasses.add(c);
              }
            });
          }
        });

        return {
          title: document.title,
          h1: document.querySelector("h1")?.innerText,
          cardCount: document.querySelectorAll('.utr-card, [class*="score-card"]')
            .length,
          matchCount: document.querySelectorAll('[class*="match"]').length,
          relevantClasses: Array.from(matchClasses).slice(0, 20),
          bodyPreview: document.body.innerText.substring(0, 1000),
        };
      });
      console.log(
        `   Page: ${pageDebug.title}, Cards: ${pageDebug.cardCount}, H1: ${pageDebug.h1}`,
      );
      console.log(
        `   Relevant classes found: ${pageDebug.relevantClasses.join(", ")}`,
      );

      // Save body text for analysis
      fs.writeFileSync(
        path.join(CACHE_DIR, "page-text.txt"),
        pageDebug.bodyPreview,
      );

      // Quick check: count visible match cards to decide if worth scraping
      const singlesMatchCount = await page.evaluate(() => {
        const cards = document.querySelectorAll(
          '.utr-card, [class*="score-card"], [class*="eventItem"]',
        );
        return cards.length;
      });

      if (singlesMatchCount < 5 && ULTRA_FAST_MODE) {
        console.log(
          `   Only ${singlesMatchCount} singles matches visible, skipping in ultra-fast mode`,
        );
        results.singlesMatches = [];
      } else {
        results.singlesMatches = await scrapeMatches(
          page,
          results.player.name,
          "singles",
        );
        console.log(`   Found ${results.singlesMatches.length} singles matches`);
      }
      console.log(
        `⏱️  Singles matches scraped in ${((Date.now() - singlesMatchesStart) / 1000).toFixed(2)}s`,
      );

      // ===== DOUBLES MATCHES =====
      const doublesMatchesStart = Date.now();

      // In ultra-fast mode, skip doubles entirely if singles was also small
      if (ULTRA_FAST_MODE && results.singlesMatches.length < 5) {
        console.log(
          "\n⚡ Ultra-fast mode: skipping doubles (insufficient singles matches)",
        );
        results.doublesMatches = [];
      } else {
        console.log("\n🎾 Getting doubles matches...");

        try {
          // Navigate to the results tab first
          await page.goto(`${BASE_URL}/profiles/${profileId}?t=2`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await delay(randomDelay(800, 300));

          // Scroll to top first to ensure dropdowns are visible
          await page.evaluate(() => window.scrollTo(0, 0));
          await delay(1000);

          // Take screenshot before click
          await page.screenshot({
            path: path.join(CACHE_DIR, "before-doubles-click.png"),
          });

          // Click the SINGLES dropdown to open it, then select Doubles
          let doublesSelected = false;
          try {
            // Log what we can see on the page
            const pageInfo = await page.evaluate(() => {
              const buttons = [...document.querySelectorAll("button")]
                .map((b) => b.innerText.trim())
                .slice(0, 10);
              const divs = [...document.querySelectorAll("div")]
                .filter((d) => d.innerText.includes("SINGLES"))
                .map((d) => d.className)
                .slice(0, 5);
              return { buttons, singlesContainers: divs };
            });
            console.log("   Page buttons:", pageInfo.buttons.join(", "));

            // Try clicking using XPath
            try {
              const clicked = await page.evaluate(() => {
                const xpath =
                  "//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'singles')]";
                const result = document.evaluate(
                  xpath,
                  document,
                  null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                  null,
                );
                for (let i = 0; i < result.snapshotLength; i++) {
                  const btn = result.snapshotItem(i);
                  const rect = btn.getBoundingClientRect();
                  if (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    window.getComputedStyle(btn).visibility !== "hidden" &&
                    window.getComputedStyle(btn).display !== "none" &&
                    window.getComputedStyle(btn).pointerEvents !== "none"
                  ) {
                    btn.click();
                    return true;
                  }
                }
                return false;
              });
              if (clicked) {
                console.log("   Clicked SINGLES dropdown");
                await delay(2000);
              }

              // Screenshot
              await page.screenshot({
                path: path.join(CACHE_DIR, "dropdown-open.png"),
              });

              // Now click DOUBLES
              const doublesClicked = await page.evaluate(() => {
                const xpath =
                  "//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'doubles')]";
                const result = document.evaluate(
                  xpath,
                  document,
                  null,
                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                  null,
                );
                for (let i = 0; i < result.snapshotLength; i++) {
                  const btn = result.snapshotItem(i);
                  const rect = btn.getBoundingClientRect();
                  if (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    window.getComputedStyle(btn).visibility !== "hidden" &&
                    window.getComputedStyle(btn).display !== "none" &&
                    window.getComputedStyle(btn).pointerEvents !== "none"
                  ) {
                    btn.click();
                    return true;
                  }
                }
                return false;
              });
              if (doublesClicked) {
                console.log("   Clicked DOUBLES");
                await delay(4000);
                doublesSelected = true;
              }
            } catch (innerErr) {
              console.log(
                `   Dropdown click failed: ${innerErr.message?.substring(0, 60)}`,
              );
            }
          } catch (e) {
            console.log(
              `   Dropdown interaction failed: ${e.message?.substring(0, 80)}`,
            );
          }

          if (!doublesSelected) {
            console.log("   Could not switch to Doubles - skipping doubles data");
            results.doublesMatches = [];
          } else {
            // Check if page content changed (no longer shows singles-only events)
            const pageContent = await page.evaluate(() => {
              const firstEvent =
                document.querySelector('[class*="eventName"]')?.innerText || "";
              // Check if W/L record is shown
              const wlText = document.body.innerText.match(
                /W\/L[:\s•]*(\d+)\s*-\s*(\d+)/,
              );
              return {
                firstEventTitle: firstEvent,
                wlRecord: wlText ? `${wlText[1]}-${wlText[2]}` : null,
                containsSingles: firstEvent.toLowerCase().includes("singles"),
              };
            });
            console.log(
              `   Page: firstEvent=${pageContent.firstEventTitle?.substring(0, 40)}, W/L=${pageContent.wlRecord}`,
            );

            // If the page no longer shows "Singles" in event names, assume we switched successfully
            if (!pageContent.containsSingles || pageContent.wlRecord) {
              // Scroll to load all matches
              await scrollToBottom(page);
              await delay(2000);

              // Take a screenshot for debugging
              await page.screenshot({
                path: path.join(CACHE_DIR, "doubles-page.png"),
              });

              results.doublesMatches = await scrapeMatches(
                page,
                results.player.name,
                "doubles",
              );
              console.log(
                `   Found ${results.doublesMatches.length} doubles matches`,
              );
            } else {
              console.log("   Still showing singles - skipping doubles");
              results.doublesMatches = [];
            }
          }
        } catch (e) {
          console.log(`   Could not get doubles matches: ${e.message}`);
          results.doublesMatches = [];
        }
      } // End if (ULTRA_FAST_MODE && results.singlesMatches.length < 5) else
    } // End DOM match scraping fallback

    // ===== GET OPPONENT RATING HISTORIES =====
    if (FAST_MODE || ULTRA_FAST_MODE) {
      console.log("\n⚡ Fast mode: skipping opponent rating histories");
      console.log(
        "   Re-run without --fast flag to get detailed opponent analysis",
      );
    } else {
      console.log("\n👥 Getting opponent rating histories...");
    }

    const allOpponents = new Set();

    if (!FAST_MODE && !ULTRA_FAST_MODE) {
      results.singlesMatches.forEach((m) => {
        if (m.opponentId) allOpponents.add(m.opponentId);
      });

      // Add doubles opponents
      results.doublesMatches.forEach((m) => {
        if (m.opponentIds) m.opponentIds.forEach((id) => allOpponents.add(id));
      });

      const opponentList = Array.from(allOpponents).slice(
        0,
        MAX_OPPONENTS_TO_FETCH,
      );
      console.log(
        `   Found ${allOpponents.size} unique opponents, will fetch up to ${opponentList.length}`,
      );

      let opponentCount = 0;
      let cachedCount = 0;
      let fetchedCount = 0;

      for (const oppId of opponentList) {
        opponentCount++;

        // Check cache first
        const cached = loadFromCache("opponent", oppId);
        if (cached && !FORCE_REFRESH) {
          results.opponentHistories[oppId] = cached;
          cachedCount++;
          console.log(
            `   [${opponentCount}/${opponentList.length}] ${cached.name} (cached)`,
          );
          continue;
        }

        // Rate limit before fetching
        await delay(DELAY_BETWEEN_OPPONENTS);

        try {
          console.log(
            `   [${opponentCount}/${opponentList.length}] Fetching opponent ${oppId}...`,
          );
          await page.goto(`${BASE_URL}/profiles/${oppId}?t=6`, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await delay(2000);

          // Click "Show all" to get full history
          try {
            await page.evaluate(() =>
              window.scrollTo(0, document.body.scrollHeight),
            );
            await delay(500);
            // Puppeteer: use XPath for text matching
            const clicked = await clickByXPath(
              page,
              "//*[contains(text(), 'Show all')]",
            );
            if (clicked) {
            }
            console.log('      Clicked "Show all"');
            await delay(3000);
            // Scroll to reveal all data
            await page.evaluate(async () => {
              for (let i = 0; i < 3; i++) {
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise((r) => setTimeout(r, 300));
              }
            });
            await delay(1000);
          } catch (e) {
            // console.log('      No "Show all" button found');
          }

          const oppHistory = await scrapeRatingHistory(page);
          const oppName = await page.evaluate(() => {
            const h1 = document.querySelector("h1");
            return h1?.innerText?.trim() || "Unknown";
          });

          const oppData = { name: oppName, history: oppHistory };
          results.opponentHistories[oppId] = oppData;

          // Save to cache
          saveToCache("opponent", oppId, oppData);
          fetchedCount++;

          console.log(
            `      ${oppName}: ${oppHistory.length} data points (saved to cache)`,
          );
        } catch (e) {
          console.log(`      Failed to get history for ${oppId}: ${e.message}`);
        }
      }

      console.log(
        `   📦 ${cachedCount} from cache, ${fetchedCount} freshly fetched`,
      );
    } // End if (!FAST_MODE)
  } catch (error) {
    console.error("Error during scraping:", error.message);
  }

  // DOM-scraped cards only show "Apr 25", so infer years (lists are
  // newest-first; the year decrements when the month increases). API matches
  // already carry full ISO dates and are left untouched.
  if (results.dataSource !== "api") {
    console.log("\n📅 Inferring match years...");
    inferYears(results.singlesMatches, results.scrapedAt);
    inferYears(results.doublesMatches, results.scrapedAt);
  }

  // Calculate UTR deltas for each match
  console.log("\n📈 Calculating UTR deltas...");
  attachRatingDeltas(
    results.singlesMatches,
    results.singlesHistory,
    results.opponentHistories,
  );

  // Save to cache
  saveToCache("profile", profileId, results);

  // Save results
  // Use OUTPUT_DIR from environment (for Lambda) or __dirname (for local)
  const outputDir = process.env.OUTPUT_DIR || __dirname;
  const outputPath = path.join(outputDir, `utr-full-${profileId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n✅ Saved to ${outputPath}`);
  console.log(`📦 Cached in ${CACHE_DIR}/`);

  // Summary
  printSummary(results);

  // Final timing
  const totalTime = (Date.now() - scriptStartTime) / 1000;
  console.log(`\n⏱️  ========================================`);
  console.log(
    `⏱️  TOTAL SCRAPING TIME: ${totalTime.toFixed(2)}s (${(totalTime / 60).toFixed(2)} minutes)`,
  );
  console.log(`⏱️  ========================================\n`);

  // Save auth state one final time before closing (in case it wasn't saved earlier)
  if (browser) {
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        const finalCheck = await pages[0].evaluate(() => {
          const state = window.INITIAL_STATE;
          return !!state?.auth?.user?.id;
        });
        if (finalCheck) {
          console.log("\n💾 Saving auth state before closing browser...");
          await saveAuthState(browser);
        }
      }
    } catch (e) {
      // Ignore errors when closing
    }
    await browser.close();
  }
  return results;
}

async function scrapeRatingHistory(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    const history = [];

    // Try pattern 1: YYYY-MM-DD followed by rating (e.g., "2025-12-29 5.73")
    const pattern1 = /(\d{4}-\d{2}-\d{2})\s*\n?\s*(\d+\.\d{2})/g;
    let match;
    while ((match = pattern1.exec(text)) !== null) {
      history.push({ date: match[1], rating: parseFloat(match[2]) });
    }

    // Try pattern 2: Date in various formats (Dec 29, 2025 or 12/29/2025)
    // followed by rating
    const pattern2 =
      /([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})\s*[\n\s]+(\d+\.\d{2})/g;
    while ((match = pattern2.exec(text)) !== null) {
      // Convert "Dec 29, 2025" to "2025-12-29"
      const dateStr = match[1];
      const d = new Date(dateStr);
      if (!isNaN(d)) {
        const isoDate = d.toISOString().split("T")[0];
        // Don't add duplicates
        if (!history.some((h) => h.date === isoDate)) {
          history.push({ date: isoDate, rating: parseFloat(match[2]) });
        }
      }
    }

    // Try pattern 3: Look in table cells or list items
    const rows = document.querySelectorAll(
      'tr, [class*="rating-row"], [class*="history-item"]',
    );
    rows.forEach((row) => {
      const text = row.innerText;
      const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
      const ratingMatch = text.match(/(\d+\.\d{2})/);
      if (dateMatch && ratingMatch) {
        const date = dateMatch[1];
        const rating = parseFloat(ratingMatch[1]);
        if (!history.some((h) => h.date === date)) {
          history.push({ date, rating });
        }
      }
    });

    return history.sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

async function scrollToBottom(page) {
  let previousHeight = 0;
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(600);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) break;
    previousHeight = newHeight;
  }
}

// Fetch structured data from UTR's JSON API using the page's authenticated
// session. Must be called with the page on the app.utrsports.net origin so
// cookies apply. incremental: fetch only the last 12 months (the caller
// merges them into the previous bundle) instead of walking every year.
async function fetchApiData(page, profileId, { incremental = false } = {}) {
  return await page.evaluate(async (id, incremental) => {
    const get = async (url) => {
      const r = await fetch(url, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.json();
    };
    // UTR's web app moved to v4 (Nov 2026; v1 now 404s). v4 returns one
    // year per call (default: the last 12 months), keyed by type=s|d and
    // year=YYYY|last, so walk back year by year and merge the events —
    // parseApiResults dedupes by result id. Calls are sequential with a
    // human-ish pause between them to keep the load on UTR gentle.
    let results;
    try {
      let calls = 0;
      let okCalls = 0;
      const v4 = async (q) => {
        if (calls++) {
          await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
        }
        try {
          const body = await get(
            `https://api.utrsports.net/v4/player/${id}/results?${q}`,
          );
          okCalls++;
          return body;
        } catch (e) {
          return null;
        }
      };
      const events = [];
      const counts = [];
      const add = (body, label) => {
        const n = (body?.events || []).length;
        if (n) events.push(...body.events);
        counts.push(`${label}:${n}`);
        return n;
      };
      for (const type of ["s", "d"]) {
        add(await v4(`type=${type}&year=last`), `${type}/last`);
        if (incremental) continue;
        let emptyStreak = 0;
        for (let y = new Date().getFullYear(); y >= 2005 && emptyStreak < 3; y--) {
          const n = add(await v4(`type=${type}&year=${y}`), `${type}/${y}`);
          emptyStreak = n ? 0 : emptyStreak + 1;
        }
      }
      // No events is legitimate for an incremental fetch (nothing played in
      // the last 12 months); only fall back when v4 itself failed.
      if (okCalls === 0 || (!incremental && events.length === 0)) {
        throw new Error("v4 returned no events");
      }
      results = { events, _v4Counts: counts.join(" ") };
    } catch (e) {
      results = await get(`https://api.utrsports.net/v1/player/${id}/results`);
    }
    let profile = null;
    try {
      profile = await get(`https://api.utrsports.net/v1/player/${id}/profile`);
    } catch (e) {
      // Profile endpoint is optional; results are what matter.
    }
    return { results, profile };
  }, profileId, incremental);
}

async function scrapeMatches(page, playerName, type) {
  // Extract raw card data in the browser; all parsing happens in Node via
  // lib/match-parser.js so it can be shared, tested, and re-run on cached data.
  const cards = await page.evaluate(() => {
    const out = [];
    const cardEls = document.querySelectorAll(
      '.utr-card.score-card, .score-card, [class*="scorecard__link"]',
    );
    cardEls.forEach((card) => {
      const rawText = card.innerText.replace(/\s+/g, " ").trim();

      const links = [];
      card.querySelectorAll('a[href*="/profiles/"]').forEach((link) => {
        const idMatch = (link.getAttribute("href") || "").match(
          /profiles\/(\d+)/,
        );
        if (idMatch) {
          links.push({ id: idMatch[1], name: link.innerText.trim() });
        }
      });

      // UTR marks the winning side's name element with "winner" in its class
      // list; capture its text for retirement/walkover winner fallback.
      let winnerNameText = null;
      const winnerEl = card.querySelector(
        '[class*="player-name"][class*="winner"], .player-name.winner',
      );
      if (winnerEl) winnerNameText = winnerEl.innerText.trim();

      out.push({ rawText, links, winnerNameText });
    });
    return out;
  });

  return cards
    .map((card) => parseMatch(card, { playerName, type }))
    .filter(
      (m) =>
        m.dateText && (m.opponent || m.isWalkover) && m.rawText.length > 30,
    );
}


function printSummary(results) {
  console.log("\n📊 Summary:");

  const singlesWins = results.singlesMatches.filter(
    (m) => m.won === true,
  ).length;
  const singlesLosses = results.singlesMatches.filter(
    (m) => m.won === false,
  ).length;
  console.log(`   Singles: ${singlesWins}-${singlesLosses}`);

  // Doubles stats skipped - focusing on singles
  // const doublesWins = results.doublesMatches.filter(m => m.won === true).length;
  // const doublesLosses = results.doublesMatches.filter(m => m.won === false).length;
  // console.log(`   Doubles: ${doublesWins}-${doublesLosses}`);

  if (results.singlesHistory.length > 0) {
    const peak = results.singlesHistory.reduce((max, h) =>
      h.rating > max.rating ? h : max,
    );
    console.log(`   Peak Singles UTR: ${peak.rating} (${peak.date})`);
  }

  console.log(
    `   Opponents tracked: ${Object.keys(results.opponentHistories).length}`,
  );
}

// Run
scrapeUTR(PROFILE_ID).catch(console.error);
