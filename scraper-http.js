// scraper-http.js - Fetch a player's UTR data over plain HTTP, no browser.
// Run with: UTR_JWT=<token> node scraper-http.js <profile_id>
//
// Uses the session token the Lambda stores (UTR_JWT) against UTR's JSON API
// and writes utr-full-<id>.json in the same shape as scraper-full.js, for
// generate-full-review.js. With PREVIOUS_BUNDLE it fetches only the last 12
// months of results and merges them in. Exits non-zero when it can't
// finish (exit 3: token missing or rejected) so the Lambda can fall back to
// the browser scraper, which logs in and stores a fresh token.

"use strict";

const fs = require("fs");
const path = require("path");
const { parseApiResults, mergeMatches } = require("./lib/api-parser");
const { attachRatingDeltas } = require("./lib/match-parser");
const {
  readPreviousBundle,
  loadPreviousBundle,
} = require("./lib/previous-bundle");
const {
  UtrAuthError,
  createClient,
  fetchResults,
  fetchRatingHistory,
  fetchProfile,
} = require("./lib/utr-api");

const PROFILE_ID = process.argv[2];
const EXIT_AUTH = 3;

async function main() {
  const start = Date.now();
  if (!/^\d{4,10}$/.test(PROFILE_ID || "")) {
    throw new Error("Usage: UTR_JWT=<token> node scraper-http.js <profile_id>");
  }
  const jwt = process.env.UTR_JWT;
  if (!jwt) throw new UtrAuthError("No session token (UTR_JWT)");

  console.log(`\n🎾 HTTP scrape - Profile ${PROFILE_ID}`);
  const client = createClient(jwt);
  const results = {
    profileId: PROFILE_ID,
    scrapedAt: new Date().toISOString(),
    player: { id: PROFILE_ID },
    singlesHistory: [],
    doublesHistory: [],
    singlesMatches: [],
    doublesMatches: [],
    opponentHistories: {},
    loginSuccessful: true,
    dataSource: "api",
  };

  // Profile: name and current ratings (optional, like scraper-full.js).
  try {
    const p = await fetchProfile(client, PROFILE_ID);
    results.player = {
      id: PROFILE_ID,
      name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.displayName,
      singlesUtr: p.singlesUtr,
      doublesUtr: p.doublesUtr,
    };
  } catch (e) {
    if (e instanceof UtrAuthError) throw e;
    console.log(`⚠️  Profile unavailable (${e.message})`);
  }
  console.log(`Player: ${results.player.name || "Unknown"} (UTR: ${results.player.singlesUtr || "?"})`);

  // Rating history. A failed read keeps the previous bundle's history
  // rather than blanking the UTR chart.
  try {
    results.singlesHistory = await fetchRatingHistory(client, PROFILE_ID);
  } catch (e) {
    if (e instanceof UtrAuthError) throw e;
    console.log(`⚠️  Rating history unavailable (${e.message})`);
  }
  const previousHistory = readPreviousBundle()?.singles?.history || [];
  if (results.singlesHistory.length === 0 && previousHistory.length > 0) {
    results.singlesHistory = previousHistory;
    console.log(`   Kept ${previousHistory.length} rating points from the previous bundle`);
  } else {
    console.log(`📊 ${results.singlesHistory.length} singles rating points`);
  }

  // Results: last 12 months merged into the previous bundle, or the full
  // career when there's no usable previous bundle.
  const previous = loadPreviousBundle();
  console.log(
    previous
      ? `📡 Fetching results from the last 12 months (full walk ${previous.resultsFullAt})`
      : "📡 Fetching full career results",
  );
  const payload = await fetchResults(client, PROFILE_ID, { incremental: !!previous });
  console.log(`   v4 events per call: ${payload._v4Counts}`);
  let parsed = parseApiResults(payload, PROFILE_ID);
  const fetchedCount = parsed.singlesMatches.length + parsed.doublesMatches.length;
  if (previous) {
    parsed = {
      singlesMatches: mergeMatches(previous.singles?.matches, parsed.singlesMatches),
      doublesMatches: mergeMatches(previous.doubles?.matches, parsed.doublesMatches),
    };
  }
  results.singlesMatches = parsed.singlesMatches;
  results.doublesMatches = parsed.doublesMatches;
  results.resultsFullAt = previous ? previous.resultsFullAt : results.scrapedAt;
  console.log(
    `✅ API results: ${results.singlesMatches.length} singles, ${results.doublesMatches.length} doubles ` +
      (previous ? `(${fetchedCount} fetched from the last 12 months, merged)` : "(full career)"),
  );

  attachRatingDeltas(results.singlesMatches, results.singlesHistory, {});

  const outputDir = process.env.OUTPUT_DIR || __dirname;
  const outputPath = path.join(outputDir, `utr-full-${PROFILE_ID}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n✅ Saved to ${outputPath}`);
  console.log(
    `⏱️  TOTAL SCRAPING TIME: ${((Date.now() - start) / 1000).toFixed(2)}s (${client.calls} API calls, no browser)`,
  );
}

main().catch((e) => {
  console.error(`❌ HTTP scrape failed: ${e.message}`);
  process.exit(e instanceof UtrAuthError ? EXIT_AUTH : 1);
});
