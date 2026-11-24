// lib/previous-bundle.js - The previous bundle a refresh builds on.
//
// The Lambda writes the stored bundle to a file and passes its path in
// PREVIOUS_BUNDLE. Both scrapers use it to fetch only recent results and
// merge them in, and to keep the old rating history if a fresh read fails.

"use strict";

const fs = require("fs");

// A refresh normally re-fetches only the last 12 months of results and
// merges them into the previous bundle; the full career is re-walked once
// the last full walk is older than this, which picks up late edits and
// deletions to older results.
const FULL_RESULTS_MAX_AGE_DAYS = 60;

let cache;

// The previous bundle handed over by the Lambda, if any (read once).
function readPreviousBundle() {
  if (cache !== undefined) return cache;
  cache = null;
  const p = process.env.PREVIOUS_BUNDLE;
  if (p && fs.existsSync(p)) {
    try {
      cache = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.log(`⚠️  Could not read previous bundle: ${e.message}`);
    }
  }
  return cache;
}

// The previous bundle, if it can seed an incremental results fetch: every
// match must come from the API (merging keys on resultId) and its last full
// walk must be recent enough that the 12-month fetch overlaps it.
function loadPreviousBundle() {
  const bundle = readPreviousBundle();
  if (!bundle) return null;
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
}

// Tests only: forget the cached read.
function resetPreviousBundle() {
  cache = undefined;
}

module.exports = {
  FULL_RESULTS_MAX_AGE_DAYS,
  readPreviousBundle,
  loadPreviousBundle,
  resetPreviousBundle,
};
