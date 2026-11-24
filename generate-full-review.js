// generate-full-review.js - Build the canonical per-profile data bundle.
//
// Usage: node generate-full-review.js <profileId>
//
// Reads the scraper's utr-full-<id>.json, re-parses every match from its
// raw card text through lib/match-parser (so fixes apply to cached data
// without re-scraping), infers match years, recomputes rating deltas, and
// writes <id>-data.json — a single bundle covering all years and both
// singles and doubles. All windowing (year, YTD, last 3 months, ...) happens
// downstream in lib/stats.js, shared with the frontend.

const fs = require("fs");
const path = require("path");
const {
  parseMatch,
  inferYears,
  attachRatingDeltas,
} = require("./lib/match-parser");
const Stats = require("./lib/stats");

const scriptStartTime = Date.now();
const PROFILE_ID = process.argv[2] || "904826";
const SCHEMA_VERSION = 2;

// Use OUTPUT_DIR from environment (for Lambda) or __dirname (for local)
const dataDir = process.env.OUTPUT_DIR || process.env.CACHE_DIR || __dirname;
const dataPath = path.join(dataDir, `utr-full-${PROFILE_ID}.json`);

let fullData;
try {
  fullData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  console.log(`✅ Loaded scrape data from ${dataPath}`);
} catch (e) {
  console.error(
    `No scrape data found at ${dataPath}. Run: node scraper-full.js ${PROFILE_ID}`,
  );
  process.exit(1);
}

const playerName = fullData.player?.name || "";

// Re-parse matches from raw card text. Rating-delta fields are recomputed
// below (the stored ones may predate correct year inference). API-sourced
// matches are already structured and pass through untouched.
function reparse(matches, type) {
  return (matches || [])
    .map((m) => {
      if (m.source === "api" || !m.rawText) return m;
      const links = [];
      if (type === "singles" && m.opponentId) {
        links.push({ id: m.opponentId, name: m.opponent || "" });
      }
      const parsed = parseMatch(
        { rawText: m.rawText, links, winnerNameText: m.winnerNameText },
        { playerName, type },
      );
      if (type === "doubles" && m.opponentIds) {
        parsed.opponentIds = m.opponentIds;
      }
      return parsed;
    })
    .filter((m) => m.dateText && (m.opponent || m.isWalkover));
}

console.log("🎾 Re-parsing matches...");
const singlesMatches = reparse(fullData.singlesMatches, "singles");
const doublesMatches = reparse(fullData.doublesMatches, "doubles");
console.log(
  `   ${singlesMatches.length} singles, ${doublesMatches.length} doubles`,
);

console.log("📅 Inferring match years...");
inferYears(singlesMatches, fullData.scrapedAt);
inferYears(doublesMatches, fullData.scrapedAt);

console.log("📈 Attaching rating deltas...");
attachRatingDeltas(
  singlesMatches,
  fullData.singlesHistory || [],
  fullData.opponentHistories || {},
);

// Strip bulky raw text from the bundle; utr-full-<id>.json keeps it.
function slim(m) {
  const { rawText, ...rest } = m;
  return rest;
}

const bundle = {
  schemaVersion: SCHEMA_VERSION,
  profileId: PROFILE_ID,
  scrapedAt: fullData.scrapedAt,
  generatedAt: new Date().toISOString(),
  player: fullData.player || { name: "Unknown", id: PROFILE_ID },
  singles: {
    matches: singlesMatches.map(slim),
    history: fullData.singlesHistory || [],
  },
  doubles: {
    matches: doublesMatches.map(slim),
    history: fullData.doublesHistory || [],
  },
};

const outputDir = process.env.OUTPUT_DIR || __dirname;
const outputPath = path.join(outputDir, `${PROFILE_ID}-data.json`);
fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2));
console.log(`✅ Wrote bundle to: ${outputPath}`);

// ---- Console summary (sanity check) ----
console.log(`\n🎾 ${bundle.player.name} — data bundle generated`);
["singles", "doubles"].forEach((type) => {
  const matches = bundle[type].matches;
  if (matches.length === 0) return;
  const s = Stats.generateStats(matches, type, playerName);
  console.log(
    `\n📊 ${type[0].toUpperCase()}${type.slice(1)} (all time): ` +
      `${s.record.wins}-${s.record.losses} (${s.record.winPct}%)` +
      (s.record.walkovers ? `, ${s.record.walkovers} W/O` : ""),
  );
  Stats.seasonSummaries(matches, bundle[type].history, type, playerName).forEach(
    (season) => {
      console.log(
        `   ${season.year}: ${season.wins}-${season.losses} (${season.winPct}%)` +
          (season.peakUtr ? `, peak UTR ${season.peakUtr.rating}` : ""),
      );
    },
  );
});

console.log(
  `\n⏱️  Total generation time: ${((Date.now() - scriptStartTime) / 1000).toFixed(2)}s`,
);
