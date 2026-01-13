// scraper-full.js - Comprehensive UTR scraper with opponent tracking
// Run with: node scraper-full.js <profile_id> [--force]

// Use Puppeteer for Lambda compatibility
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

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
const CACHE_VERSION = "1.1"; // Bump this to invalidate cache
const CACHE_MAX_AGE_DAYS = 7; // Cache valid for 7 days
const AUTH_STATE_FILE = path.join(CACHE_DIR, "auth-state.json");

// Rate limiting - optimized for speed while staying safe
const DELAY_BETWEEN_PAGES = 800; // 800ms between page loads (with jitter)
const DELAY_BETWEEN_OPPONENTS = 300; // 300ms base delay for opponent lookups (with jitter)
const MAX_OPPONENTS_TO_FETCH = 15; // Limit opponent lookups
const MAX_PARALLEL_OPPONENTS = 4; // Fetch up to 4 opponents concurrently
const ENABLE_RESOURCE_BLOCKING = true; // Block images/fonts/CSS to speed up loading

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
  // Check SECRETS_PATH environment variable first (for Lambda), then fall back to __dirname
  const secretsPath =
    process.env.SECRETS_PATH || path.join(__dirname, "secrets.json");
  if (fs.existsSync(secretsPath)) {
    credentials = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    console.log("📧 Credentials loaded from:", secretsPath);
  } else {
    console.log("ℹ️  No secrets file found at:", secretsPath);
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

        // Wait for the login form - try multiple selectors with longer timeout
        let emailFieldFound = false;
        const emailSelectors = [
          'input[type="email"]',
          'input[name="email"]',
          'input[placeholder*="email" i]',
          'input[id*="email" i]',
          'input[type="text"]', // Sometimes email fields are type="text"
        ];

        for (const selector of emailSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 5000 });
            emailFieldFound = true;
            console.log(`   Found email field with selector: ${selector}`);
            break;
          } catch (e) {
            // Try next selector
          }
        }

        if (!emailFieldFound) {
          // Take screenshot for debugging
          await page.screenshot({
            path: path.join(CACHE_DIR, "login-timeout.png"),
          });
          console.log("   ⚠️  Email field not found, screenshot saved");
          // Continue anyway - maybe the page structure is different
        }

        // Fill in credentials - use the selector that worked
        let emailInput = null;
        let workingEmailSelector = null;
        for (const selector of emailSelectors) {
          try {
            emailInput = await page.$(selector);
            if (emailInput) {
              workingEmailSelector = selector;
              break;
            }
          } catch (e) {}
        }

        if (emailInput) {
          // Clear and type email
          await emailInput.focus();
          await page.keyboard.down("Control");
          await page.keyboard.press("a");
          await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await emailInput.type(credentials.username || credentials.email, {
            delay: 50,
          });
          console.log(
            `   ✅ Filled email using selector: ${workingEmailSelector}`,
          );
        } else {
          console.log("   ⚠️  Could not find email input");
        }
        await delay(1000);

        // UTR uses a two-step login: email first, then click Continue to show password field
        console.log("   Looking for Continue button to show password field...");
        let continueClicked = false;

        // Try to find and click Continue button using XPath
        const clicked = await page.evaluate(() => {
          const xpath =
            "//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continue')]";
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
              window.getComputedStyle(btn).display !== "none"
            ) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (clicked) {
          console.log("   ✅ Clicked Continue button");
          continueClicked = true;
        }

        // If XPath didn't work, try standard selectors
        if (!continueClicked) {
          const submitBtn =
            (await page.$('button[type="submit"]')) ||
            (await page.$('input[type="submit"]'));
          if (submitBtn) {
            const isVisible = await page.evaluate((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }, submitBtn);
            if (isVisible) {
              await submitBtn.click();
              console.log("   ✅ Clicked submit button (Continue)");
              continueClicked = true;
            }
          }
        }

        // If still not found, try pressing Enter in email field
        if (!continueClicked && emailInput) {
          try {
            await emailInput.focus();
            await page.keyboard.press("Enter");
            console.log("   ✅ Pressed Enter in email field");
            continueClicked = true;
          } catch (e) {}
        }

        // Wait for password field to appear after clicking Continue
        if (continueClicked) {
          console.log("   Waiting for password field to appear...");
          await delay(2000);

          // Wait for password field with timeout
          try {
            await page.waitForSelector('input[type="password"]', {
              timeout: 5000,
            });
            console.log("   ✅ Password field appeared");
          } catch (e) {
            console.log(
              "   ⚠️  Password field did not appear after Continue click",
            );
          }
        } else {
          console.log(
            "   ⚠️  Could not find Continue button - password field may not appear",
          );
        }

        // Find password field - try multiple methods with longer waits
        const passwordSelectors = [
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

        // Method 1: Try standard submit button
        try {
          const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button[type="button"]', // Sometimes submit buttons are type="button"
            '[type="submit"]',
          ];

          for (const selector of submitSelectors) {
            try {
              const btn = await page.$(selector);
              if (btn) {
                // Check if it's visible and clickable
                const isVisible = await page.evaluate((el) => {
                  const rect = el.getBoundingClientRect();
                  return (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    window.getComputedStyle(el).visibility !== "hidden" &&
                    window.getComputedStyle(el).display !== "none"
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

        // Method 2: Try XPath for buttons with text
        if (!submitSuccess) {
          try {
            const clicked = await page.evaluate(() => {
              const xpath =
                "//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'log in') or contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sign in')]";
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
                if (rect.width > 0 && rect.height > 0) {
                  btn.click();
                  return true;
                }
              }
              return false;
            });
            if (clicked) {
              console.log("   Clicked submit button (XPath)");
              submitSuccess = true;
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

  // Calculate UTR deltas for each match
  console.log("\n📈 Calculating UTR deltas...");
  calculateUtrDeltas(results);

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

async function scrapeMatches(page, playerName, type) {
  return await page.evaluate(
    ({ playerName, type }) => {
      const matches = [];
      // Use multiple selectors based on what we found in debug
      const cards = document.querySelectorAll(
        '.utr-card.score-card, .score-card, [class*="scorecard__link"]',
      );

      cards.forEach((card) => {
        const match = { type };

        // Get the raw text
        const rawText = card.innerText.replace(/\s+/g, " ").trim();
        match.rawText = rawText;

        // Parse date
        const dateMatch = rawText.match(/\|\s*(\w+\s+\d+)/);
        match.date = dateMatch ? dateMatch[1] : "";

        // Check for walkover
        if (rawText.toLowerCase().includes("walkover")) {
          match.isWalkover = true;
          // In a walkover, the player listed first (before "walkover") advances
          // Check if our name comes before "walkover"
          const walkoverIdx = rawText.toLowerCase().indexOf("walkover");
          const textBefore = rawText.substring(0, walkoverIdx);
          match.won = textBefore.includes(playerName.split(" ")[0]);
        }

        // Find opponent profile ID from link FIRST (reliable method)
        const links = card.querySelectorAll('a[href*="/profiles/"]');
        links.forEach((link) => {
          const href = link.getAttribute("href");
          const idMatch = href.match(/profiles\/(\d+)/);
          if (idMatch) {
            const linkText = link.innerText.trim();
            // If link text doesn't contain our first name, it's the opponent
            if (!linkText.includes(playerName.split(" ")[0])) {
              match.opponentId = idMatch[1];
              match.opponent = linkText;
            }
          }
        });

        // Parse scores from raw text - most reliable method
        // Format: "Name1 UTR1 scores1 Name2 UTR2 scores2" e.g., "Harper Chalat 5.74 64 John Smith 4.50 26"
        // Scores are concatenated digits: "64" means games 6 and 4, "26" means games 2 and 6
        // Sets would be: 6-2, 4-6
        let myScores = [],
          oppScores = [];
        let tiebreakScoresFromSup = []; // Tiebreak scores from <sup> elements

        // First, find any <sup> elements which contain tiebreak scores
        const supElements = card.querySelectorAll("sup");
        supElements.forEach((sup) => {
          const text = sup.innerText.trim();
          if (/^\d+$/.test(text)) {
            tiebreakScoresFromSup.push(parseInt(text));
          }
        });

        // Fallback: extract from raw text using pattern matching
        // Scores like "66 40" mean sets 6-4, 6-0 (each digit is a set score)
        // Super tiebreaks have "10" which is 2 digits for 10 points
        if (myScores.length === 0) {
          const pattern =
            /([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)+)\s*(\d+\.\d{2})\s*([\d\s]+)/g;
          let pm;
          const playerData = [];
          while ((pm = pattern.exec(rawText)) !== null) {
            // Parse scores - handle "10" as a single score (super tiebreak)
            const rawScores = pm[3].trim().replace(/\s+/g, "");
            const scores = [];
            let i = 0;
            while (i < rawScores.length) {
              // Check if next two digits form "10" or higher (super tiebreak score)
              if (i + 1 < rawScores.length) {
                const twoDigit = parseInt(rawScores.substring(i, i + 2));
                if (twoDigit >= 10) {
                  scores.push(twoDigit);
                  i += 2;
                  continue;
                }
              }
              // Single digit score
              scores.push(parseInt(rawScores[i]));
              i++;
            }
            playerData.push({
              name: pm[1].trim(),
              utr: parseFloat(pm[2]),
              scores: scores.filter((n) => !isNaN(n)),
            });
          }

          if (playerData.length >= 2) {
            const isPlayer1 = playerData[0].name.includes(
              playerName.split(" ")[0],
            );
            if (isPlayer1) {
              myScores = playerData[0].scores;
              oppScores = playerData[1].scores;
              match.myUtr = playerData[0].utr;
              match.opponentUtr = playerData[1].utr;
              if (!match.opponent) match.opponent = playerData[1].name;
            } else {
              myScores = playerData[1].scores;
              oppScores = playerData[0].scores;
              match.myUtr = playerData[1].utr;
              match.opponentUtr = playerData[0].utr;
              if (!match.opponent) match.opponent = playerData[0].name;
            }
          }
        }

        // Parse sets with tiebreak handling
        // Tiebreaks: 7-6 means a tiebreak was won. Tiebreak score may be in <sup> (e.g., 7-5, 7-4)
        // Note: tiebreak scores are 7+ for winner (can't be 7-6 since must win by 2)
        // Super tiebreaks: 1-0 followed by score like 10-8
        match.sets = [];
        match.tiebreakScores = [];

        let supScoreIdx = 0; // Track which <sup> score we're on

        if (
          myScores.length > 0 &&
          oppScores.length > 0 &&
          myScores.length === oppScores.length
        ) {
          let i = 0;
          while (i < myScores.length) {
            const my = myScores[i];
            const opp = oppScores[i];

            // Check if this is a tiebreak set (7-6 or 6-7)
            if ((my === 7 && opp === 6) || (my === 6 && opp === 7)) {
              match.sets.push(`${my}-${opp}`);

              // Check if next scores look like tiebreak scores (winner > 6, win by 2+)
              // Or use <sup> tiebreak scores if available
              if (tiebreakScoresFromSup.length > supScoreIdx) {
                // Use the <sup> tiebreak score - it's the loser's points
                const loserPoints = tiebreakScoresFromSup[supScoreIdx];
                const winnerPoints = Math.max(7, loserPoints + 2); // Winner has at least 7, and at least 2 more
                if (my === 7) {
                  match.tiebreakScores.push(`${winnerPoints}-${loserPoints}`);
                } else {
                  match.tiebreakScores.push(`${loserPoints}-${winnerPoints}`);
                }
                supScoreIdx++;
              } else if (i + 1 < myScores.length) {
                // Check if next scores are valid tiebreak scores
                const nextMy = myScores[i + 1];
                const nextOpp = oppScores[i + 1];
                // Valid tiebreak: one player has 7+, wins by 2+
                const isValidTiebreak =
                  (nextMy >= 7 || nextOpp >= 7) &&
                  Math.abs(nextMy - nextOpp) >= 2 &&
                  !(nextMy === 7 && nextOpp === 6) && // Not another set score
                  !(nextMy === 6 && nextOpp === 7);
                if (isValidTiebreak) {
                  match.tiebreakScores.push(`${nextMy}-${nextOpp}`);
                  i += 2;
                  continue;
                }
              }
              // No tiebreak score found - that's ok, 7-6 alone is valid
              i++;
            }
            // Check if this is a super tiebreak (1-0 or 0-1)
            else if ((my === 1 && opp === 0) || (my === 0 && opp === 1)) {
              // Next scores are the super tiebreak score
              if (i + 1 < myScores.length) {
                const stbMy = myScores[i + 1];
                const stbOpp = oppScores[i + 1];
                match.sets.push(`${stbMy}-${stbOpp}`); // Store actual super TB score
                match.superTiebreak = `${stbMy}-${stbOpp}`;
                i += 2;
              } else {
                match.sets.push(`${my}-${opp}`);
                i++;
              }
            }
            // Regular set
            else {
              match.sets.push(`${my}-${opp}`);
              i++;
            }
          }
        }

        // Determine win/loss from set count (most reliable method)
        if (!match.isWalkover && match.sets.length > 0) {
          let mySets = 0,
            oppSets = 0;
          match.sets.forEach((set) => {
            const parts = set.split("-");
            if (parts.length !== 2) return;
            const a = parseInt(parts[0]);
            const b = parseInt(parts[1]);
            if (isNaN(a) || isNaN(b)) return;

            // Regular sets (0-7 range) or super tiebreaks (10+)
            if (a > b) mySets++;
            else if (b > a) oppSets++;
          });
          match.won = mySets > oppSets;
        }

        // Only add valid matches (must have date and opponent)
        if (match.date && match.opponent && match.rawText.length > 30) {
          matches.push(match);
        }
      });

      return matches;
    },
    { playerName, type },
  );
}

function calculateUtrDeltas(results) {
  const myHistory = results.singlesHistory;

  // For each singles match, find UTR before and after
  results.singlesMatches.forEach((match) => {
    if (!match.date) return;

    // Parse match date to find the relevant week
    const year = new Date().getFullYear();
    const matchDate = new Date(`${match.date}, ${year}`);

    // Find my UTR before and after this match
    const myBefore = findRatingBefore(myHistory, matchDate);
    const myAfter = findRatingAfter(myHistory, matchDate);

    match.myUtrBefore = myBefore?.rating;
    match.myUtrAfter = myAfter?.rating;
    match.myUtrDelta =
      myAfter && myBefore
        ? (myAfter.rating - myBefore.rating).toFixed(2)
        : null;

    // Find opponent UTR before and after
    if (match.opponentId && results.opponentHistories[match.opponentId]) {
      const oppHistory = results.opponentHistories[match.opponentId].history;
      const oppBefore = findRatingBefore(oppHistory, matchDate);
      const oppAfter = findRatingAfter(oppHistory, matchDate);

      match.opponentUtrBefore = oppBefore?.rating;
      match.opponentUtrAfter = oppAfter?.rating;
      match.opponentUtrDelta =
        oppAfter && oppBefore
          ? (oppAfter.rating - oppBefore.rating).toFixed(2)
          : null;
    }
  });

  // Doubles UTR deltas skipped - focusing on singles
  // results.doublesMatches.forEach(match => {
  //     if (!match.date) return;
  //     const year = new Date().getFullYear();
  //     const matchDate = new Date(`${match.date}, ${year}`);
  //
  //     const myBefore = findRatingBefore(myHistory, matchDate);
  //     const myAfter = findRatingAfter(myHistory, matchDate);
  //
  //     match.myUtrBefore = myBefore?.rating;
  //     match.myUtrAfter = myAfter?.rating;
  //     match.myUtrDelta = myAfter && myBefore ? (myAfter.rating - myBefore.rating).toFixed(2) : null;
  // });
}

function findRatingBefore(history, date) {
  // Find the rating entry just before or on this date
  let closest = null;
  for (const entry of history) {
    const entryDate = new Date(entry.date);
    if (entryDate <= date) {
      closest = entry;
    } else {
      break;
    }
  }
  return closest;
}

function findRatingAfter(history, date) {
  // Find the rating entry just after this date
  for (const entry of history) {
    const entryDate = new Date(entry.date);
    if (entryDate > date) {
      return entry;
    }
  }
  return null;
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
