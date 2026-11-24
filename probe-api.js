// probe-api.js - Call UTR's data endpoints directly from an authenticated
// page context and report which return usable match/rating data.
//
//   node probe-api.js <profileId>
//
// Runs fetch() inside the logged-in app origin so the session cookie (and
// any auth header the app configures) is applied automatically. Saves every
// 200 response to cache/api/ and prints status + top-level shape.

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const PROFILE_ID = process.argv[2] || "904826";
const BASE_URL = "https://app.utrsports.net";
const AUTH = path.join(__dirname, "cache/auth-state.json");
const OUT = path.join(__dirname, "cache/api");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Candidate endpoints (UTR versions its API; we try several shapes).
const ENDPOINTS = (id) => [
  `https://api.utrsports.net/v4/player/${id}/results`,
  `https://api.utrsports.net/v4/player/${id}/results?type=singles`,
  `https://api.utrsports.net/v4/player/${id}/results?type=doubles`,
  `https://api.utrsports.net/v1/player/${id}/results`,
  `https://api.utrsports.net/v4/player/${id}/stats`,
  `https://api.utrsports.net/v1/player/${id}/stats`,
  `https://api.utrsports.net/v4/player/${id}/rating-history`,
  `https://api.utrsports.net/v1/player/${id}/profile`,
  `https://api.utrsports.net/v2/player/${id}/results`,
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const { cookies } = JSON.parse(fs.readFileSync(AUTH, "utf8"));
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.setCookie(...cookies);
  // Land on the profile so the app initializes its auth (bearer token in memory).
  await page.goto(`${BASE_URL}/profiles/${PROFILE_ID}`, { waitUntil: "networkidle2", timeout: 60000 });
  await delay(2000);

  const results = await page.evaluate(async (urls) => {
    const out = [];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
        let shape = null, sample = null;
        if (r.ok) {
          const body = await r.json();
          if (Array.isArray(body)) shape = `array[${body.length}]`;
          else if (body && typeof body === "object") shape = Object.keys(body).join(",");
          sample = JSON.stringify(body).slice(0, 220);
        }
        out.push({ url, status: r.status, shape, sample, body: r.ok ? sample : null });
        // Save full body for 200s
        if (r.ok) window.__probeBodies = (window.__probeBodies || {}), window.__probeBodies[url] = await (await fetch(url, { credentials: "include" })).text();
      } catch (e) {
        out.push({ url, status: "ERR", error: String(e).slice(0, 100) });
      }
    }
    return out;
  }, ENDPOINTS(PROFILE_ID));

  // Persist full bodies of successful calls.
  const bodies = await page.evaluate(() => window.__probeBodies || {});
  for (const [url, text] of Object.entries(bodies)) {
    const file = path.join(OUT, `probe_${url.replace(/[^a-z0-9]+/gi, "_").slice(0, 90)}.json`);
    try { fs.writeFileSync(file, JSON.stringify(JSON.parse(text), null, 2)); } catch { fs.writeFileSync(file, text); }
  }

  await browser.close();

  console.log("=== ENDPOINT PROBE ===");
  results.forEach((r) => {
    console.log(`\n[${r.status}] ${r.url.replace(/^https:\/\/api\.utrsports\.net/, "")}`);
    if (r.shape) console.log(`   shape: ${r.shape}`);
    if (r.sample) console.log(`   sample: ${r.sample}`);
    if (r.error) console.log(`   error: ${r.error}`);
  });
  console.log(`\nFull 200 bodies saved to cache/api/probe_*.json`);
})().catch((e) => { console.error(e); process.exit(1); });
