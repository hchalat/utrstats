// lib/utr-api.js - UTR's JSON API over plain HTTP with a session token.
//
// The web app calls api.utrsports.net with `Authorization: Bearer <jwt>`;
// this does the same from Node, so a refresh needs no browser while the
// stored token is valid (see scraper-http.js). Calls are sequential with a
// human-ish pause between them to keep the load on UTR gentle.

"use strict";

const BASE = "https://api.utrsports.net";

// UTR rejected the token: the caller should fall back to a real login.
class UtrAuthError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient(jwt, { minPauseMs = 500, maxPauseMs = 1000 } = {}) {
  let calls = 0;
  async function get(path) {
    if (calls++) await sleep(minPauseMs + Math.random() * (maxPauseMs - minPauseMs));
    const r = await fetch(BASE + path, {
      headers: { accept: "application/json", authorization: "Bearer " + jwt },
      signal: AbortSignal.timeout(20000),
    });
    // 401 is a dead token; a 403 can be a per-resource refusal, so it's an
    // ordinary failure of that one call.
    if (r.status === 401) throw new UtrAuthError(`UTR rejected the session token (401 for ${path})`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
    return r.json();
  }
  return {
    get,
    get calls() {
      return calls;
    },
  };
}

// v4 returns one year per call (type=s|d, year=YYYY|last), so walk back year
// by year until three empty years in a row; with `incremental`, fetch only
// year=last (the caller merges it into the previous bundle). Mirrors the
// in-page fetch in scraper-full.js.
async function fetchResults(client, id, { incremental = false } = {}) {
  const events = [];
  const counts = [];
  let okCalls = 0;
  const call = async (q) => {
    try {
      const body = await client.get(`/v4/player/${id}/results?${q}`);
      okCalls++;
      return body;
    } catch (e) {
      if (e instanceof UtrAuthError) throw e;
      return null;
    }
  };
  const add = (body, label) => {
    const n = (body?.events || []).length;
    if (n) events.push(...body.events);
    counts.push(`${label}:${n}`);
    return n;
  };
  for (const type of ["s", "d"]) {
    add(await call(`type=${type}&year=last`), `${type}/last`);
    if (incremental) continue;
    let emptyStreak = 0;
    for (let y = new Date().getFullYear(); y >= 2005 && emptyStreak < 3; y--) {
      const n = add(await call(`type=${type}&year=${y}`), `${type}/${y}`);
      emptyStreak = n ? 0 : emptyStreak + 1;
    }
  }
  // No events is fine for an incremental fetch (nothing played lately);
  // only fail when the API itself never answered.
  if (okCalls === 0 || (!incremental && events.length === 0)) {
    throw new Error("v4 results returned no events");
  }
  return { events, _v4Counts: counts.join(" ") };
}

// Weekly singles ratings from the profile stats endpoint, oldest first, as
// UTR displays them (ratingDisplay; the raw `rating` can differ by 0.01).
function parseRatingHistory(allStats) {
  return (allStats?.extendedRatingProfile?.history || [])
    .filter((h) => h && h.date && /singles/i.test(h.type || "singles"))
    .map((h) => ({
      date: String(h.date).slice(0, 10),
      rating: parseFloat(h.ratingDisplay) || h.rating,
    }))
    .filter((h) => h.rating > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchRatingHistory(client, id) {
  const body = await client.get(
    `/v4/player/${id}/all-stats?type=singles&resultType=verified&months=12&fetchAllResults=true`,
  );
  return parseRatingHistory(body);
}

async function fetchProfile(client, id) {
  return client.get(`/v1/player/${id}/profile`);
}

module.exports = {
  UtrAuthError,
  createClient,
  fetchResults,
  fetchRatingHistory,
  fetchProfile,
  parseRatingHistory,
};
