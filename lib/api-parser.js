// lib/api-parser.js - Map UTR's results API payload to canonical matches.
//
// Source: GET https://api.utrsports.net/v1/player/{id}/results
// (fetched from an authenticated page context; see scraper-full.js).
//
// The API is structured — winner/loser are labeled, dates include the year,
// tiebreak points are explicit fields, and doubles partners are separate
// player objects — so unlike lib/match-parser.js there is no interpretation
// or digit-decoding here, just reshaping into the match objects that
// lib/stats.js and the frontend consume.

"use strict";

function fullName(p) {
  return [p?.firstName, p?.lastName].filter(Boolean).join(" ").trim();
}

function playerUtr(p, isDoubles) {
  if (!p) return null;
  const v = isDoubles ? p.doublesUtr : p.singlesUtr;
  return typeof v === "number" && v > 0 ? v : null;
}

// API timestamps are UTC (e.g. "2026-04-24T00:30:00" is Apr 23, 8:30 PM
// Eastern). When a real time-of-day is present, convert to the local
// timezone so dates and day/night stats line up with when matches were
// actually played. A bare "T00:00:00" is ambiguous — UTR also uses it as a
// date-only placeholder — so those are kept as-is (date unchanged, no time).
const DEFAULT_TZ = process.env.UTR_TZ || "America/New_York";

function splitDateTime(iso, tz = DEFAULT_TZ) {
  if (!iso || typeof iso !== "string") return { date: null, time: null };
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m || (m[1] === "00" && m[2] === "00")) {
    return { date: iso.slice(0, 10), time: null };
  }
  try {
    const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const hour = parseInt(get("hour"), 10) % 24;
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 || 12;
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${h12}:${get("minute")} ${ampm}`,
    };
  } catch (e) {
    return { date: iso.slice(0, 10), time: null };
  }
}

// Convert the API score object (keyed "1","2",... with winner-perspective
// games) into my-perspective sets / tiebreak scores.
function parseScore(score, iWon, completionType) {
  const sets = [];
  const tiebreakScores = [];
  let superTiebreak = null;

  const setNums = Object.keys(score || {})
    .filter((k) => /^\d+$/.test(k) && score[k] && score[k].winner != null)
    .sort((a, b) => Number(a) - Number(b));

  const isRetirement = /incomplete/i.test(completionType || "");

  setNums.forEach((num, idx) => {
    const s = score[num];
    const my = iWon ? s.winner : s.loser;
    const opp = iWon ? s.loser : s.winner;

    // Super tiebreak: rendered as a 1-0 "set" with the real points in the
    // tiebreak fields. A genuine 1-0 partial (retirement) has no tiebreak
    // points and is kept as literal games.
    const looksLikeStb =
      ((s.winner === 1 && s.loser === 0) || (s.winner === 0 && s.loser === 1)) &&
      (s.winnerTiebreak != null || (idx >= 2 && !isRetirement));
    if (looksLikeStb) {
      // The deciding super-tiebreak counts as a single 1-0 / 0-1 "set". When
      // the points are known it's shown like a tiebreak set with the loser's
      // points in parens, e.g. "1-0(6)" (winner reached 10, loser got 6).
      const myGame = iWon ? s.winner : s.loser; // 1 if I won the STB, else 0
      const oppGame = iWon ? s.loser : s.winner;
      if (s.winnerTiebreak != null) {
        const loserPts = s.tiebreak ?? 0; // s.tiebreak = the STB loser's points
        const myPts = iWon ? s.winnerTiebreak : loserPts;
        const oppPts = iWon ? loserPts : s.winnerTiebreak;
        superTiebreak = `${myPts}-${oppPts}`;
        sets.push(`${myGame}-${oppGame}(${loserPts})`);
      } else {
        superTiebreak = "Super TB";
        sets.push(`${myGame}-${oppGame}`);
      }
      return;
    }

    sets.push(`${my}-${opp}`);

    // Regular 7-6 set. The tiebreak fields follow the MATCH winner/loser
    // (like the games): winnerTiebreak = match-winner's TB points,
    // tiebreak = match-loser's TB points — even when the match winner lost
    // this particular set.
    if ((s.winner === 7 && s.loser === 6) || (s.winner === 6 && s.loser === 7)) {
      let myPts = iWon ? s.winnerTiebreak : s.tiebreak;
      let oppPts = iWon ? s.tiebreak : s.winnerTiebreak;
      const iWonSet = my > opp;
      // Derive a missing SET-winner score (must be >= loser + 2, min 7).
      if (myPts == null && oppPts != null && iWonSet) {
        myPts = Math.max(7, oppPts + 2);
      }
      if (oppPts == null && myPts != null && !iWonSet) {
        oppPts = Math.max(7, myPts + 2);
      }
      if (myPts != null && oppPts != null) {
        tiebreakScores.push(`${myPts}-${oppPts}`);
      }
    }
  });

  return { sets, tiebreakScores, superTiebreak };
}

// Parse one API result into a canonical match, or null if the profile owner
// isn't in it / it isn't a usable result.
function parseApiResult(result, profileId, extras = {}) {
  const pid = String(profileId);
  const p = result.players || {};
  const sides = {
    winner: [p.winner1, p.winner2].filter(Boolean),
    loser: [p.loser1, p.loser2].filter(Boolean),
  };

  let mySide = null;
  if (sides.winner.some((pl) => String(pl.id) === pid)) mySide = "winner";
  else if (sides.loser.some((pl) => String(pl.id) === pid)) mySide = "loser";
  if (!mySide) return null;

  const iWon = mySide === "winner";
  const mine = sides[mySide];
  const theirs = sides[iWon ? "loser" : "winner"];
  const isDoubles = !!(p.winner2 || p.loser2);
  const type = isDoubles ? "doubles" : "singles";

  const me = mine.find((pl) => String(pl.id) === pid);
  const partner = mine.find((pl) => String(pl.id) !== pid) || null;

  const { date, time } = splitDateTime(result.date);
  const completionType = result.completionType || "";
  const isWalkover = /didnotstart|walkover/i.test(completionType);
  const isRetirement = /incomplete|retire/i.test(completionType);

  const { sets, tiebreakScores, superTiebreak } = isWalkover
    ? { sets: [], tiebreakScores: [], superTiebreak: null }
    : parseScore(result.score, iWon, completionType);

  const match = {
    type,
    source: "api",
    resultId: result.id,
    date,
    dateText: date, // kept for filters that check presence
    time,
    won: iWon,
    sets,
    tiebreakScores,
    myUtr: playerUtr(me, isDoubles),
    eventName: extras.eventName || null,
    round: result.round?.name || null,
  };
  if (superTiebreak) match.superTiebreak = superTiebreak;
  if (isWalkover) match.isWalkover = true;
  if (isRetirement) match.isRetirement = true;
  if (result.excludeFromRating) match.excludeFromRating = true;

  if (isDoubles) {
    match.partner = partner ? fullName(partner) : null;
    match.partnerUtr = playerUtr(partner, true);
    match.opponent = theirs.map(fullName).filter(Boolean).join(" / ");
    match.opponentIds = theirs.map((pl) => String(pl.id));
    match.opponentUtr = playerUtr(theirs[0], true);
    match.myTeamUtrs = [match.myUtr, match.partnerUtr];
    match.oppTeamUtrs = theirs.map((pl) => playerUtr(pl, true));
  } else {
    const opp = theirs[0];
    match.opponent = opp ? fullName(opp) : null;
    match.opponentId = opp ? String(opp.id) : null;
    match.opponentUtr = playerUtr(opp, false);
  }

  return match;
}

// Parse the whole /results payload into { singlesMatches, doublesMatches },
// newest first, deduped by result id.
function parseApiResults(payload, profileId) {
  const singlesMatches = [];
  const doublesMatches = [];
  const seen = new Set();

  (payload?.events || []).forEach((ev) => {
    const collect = (results) => {
      (results || []).forEach((r) => {
        if (r.id != null && seen.has(r.id)) return;
        if (r.id != null) seen.add(r.id);
        const match = parseApiResult(r, profileId, { eventName: ev.name });
        if (!match || !match.date) return;
        (match.type === "doubles" ? doublesMatches : singlesMatches).push(match);
      });
    };
    collect(ev.results);
    (ev.draws || []).forEach((d) => collect(d.results));
  });

  const newestFirst = (a, b) => String(b.date).localeCompare(String(a.date));
  singlesMatches.sort(newestFirst);
  doublesMatches.sort(newestFirst);
  return { singlesMatches, doublesMatches };
}

module.exports = { parseApiResults, parseApiResult, parseScore, splitDateTime };
