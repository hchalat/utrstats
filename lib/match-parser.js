// lib/match-parser.js - Parse UTR match cards from raw card data.
//
// Runs in Node (not in page.evaluate) so it can be shared by the scraper,
// the generator (re-parsing cached rawText), and tests. The score digits in
// a card's innerText contain the full result, including tiebreak points
// (which render as <sup> in the DOM but still appear in innerText), so
// rawText alone is sufficient to reconstruct sets, tiebreaks, and winner.
//
// Digit encoding, per player, concatenated left to right:
//   Regular set:      one digit per set          "64"      -> 6-4
//   Tiebreak set:     7/6 digit, then TB points  "677"/"462" -> 6-4, 7-6(7-2)
//   Super tiebreak:   1/0 indicator, then points "64110"/"4604" -> 6-4, 4-6, 10-4
//   Walkover:         no digits after the UTR values

"use strict";

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseScoreDigits(str) {
  return (str || "").split("").map(Number).filter((n) => !isNaN(n));
}

// Extract "Apr 25" style date text and "8:30 PM" style time from a card.
function extractDateTime(rawText) {
  const dateMatch = rawText.match(/\|\s*([A-Za-z]{3})\w*\s+(\d{1,2})/);
  const timeMatch = rawText.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
  return {
    dateText: dateMatch ? `${dateMatch[1]} ${dateMatch[2]}` : "",
    time: timeMatch ? timeMatch[1].toUpperCase() : null,
  };
}

// Parse the set-by-set result from the two players' digit runs.
// Returns { sets, tiebreakScores, superTiebreak, supertbWon }.
//
// Known limitation: a 7-5 set immediately following a 7-6 set whose tiebreak
// points were NOT rendered is indistinguishable from the tiebreak points
// themselves. UTR renders tiebreak points on every 7-6 set we have observed,
// so the tiebreak interpretation is preferred.
function parseSets(myDigits, oppDigits) {
  const sets = [];
  const tiebreakScores = [];
  let superTiebreak = null;
  let supertbWon;

  let i = 0;
  while (i < myDigits.length && i < oppDigits.length) {
    const my = myDigits[i];
    const opp = oppDigits[i];

    // 7-6 tiebreak set; the next digit pair is each player's TB points.
    if ((my === 7 && opp === 6) || (my === 6 && opp === 7)) {
      sets.push(`${my}-${opp}`);
      if (i + 1 < myDigits.length && i + 1 < oppDigits.length) {
        const nMy = myDigits[i + 1];
        const nOpp = oppDigits[i + 1];
        // TB points are valid when someone reached 7+ with a 2+ margin,
        // and the pair isn't itself another 7-6 set.
        const validTb =
          (nMy >= 7 || nOpp >= 7) &&
          Math.abs(nMy - nOpp) >= 2 &&
          !(nMy === 7 && nOpp === 6) &&
          !(nMy === 6 && nOpp === 7);
        if (validTb) {
          tiebreakScores.push(`${nMy}-${nOpp}`);
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }

    // Super tiebreak indicator: 1-0 / 0-1 is not a valid set score.
    // The winner's remaining digits hold their points (two digits if >= 10),
    // the loser's remaining digit holds theirs.
    if ((my === 1 && opp === 0) || (my === 0 && opp === 1)) {
      const myWon = my === 1;
      let stbMy, stbOpp;

      if (myWon) {
        const d1 = myDigits[i + 1];
        const d2 = myDigits[i + 2];
        if (d1 !== undefined && d2 !== undefined && d1 * 10 + d2 >= 10) {
          stbMy = d1 * 10 + d2;
        } else {
          stbMy = d1 !== undefined ? d1 : 0;
        }
        stbOpp = oppDigits[i + 1] !== undefined ? oppDigits[i + 1] : 0;
      } else {
        const d1 = oppDigits[i + 1];
        const d2 = oppDigits[i + 2];
        if (d1 !== undefined && d2 !== undefined && d1 * 10 + d2 >= 10) {
          stbOpp = d1 * 10 + d2;
        } else {
          stbOpp = d1 !== undefined ? d1 : 0;
        }
        stbMy = myDigits[i + 1] !== undefined ? myDigits[i + 1] : 0;
      }

      // The deciding super-tiebreak shows as a single 1-0 / 0-1 "set". When
      // points are known, include the loser's points in parens, e.g. "1-0(6)".
      const scored = stbMy > 0 || stbOpp > 0;
      const loserPts = myWon ? stbOpp : stbMy;
      superTiebreak = scored ? `${stbMy}-${stbOpp}` : "Super TB";
      sets.push(
        scored
          ? `${myWon ? "1-0" : "0-1"}(${loserPts})`
          : myWon
            ? "1-0"
            : "0-1",
      );
      supertbWon = myWon;
      break;
    }

    // Regular set.
    sets.push(`${my}-${opp}`);
    i++;
  }

  return { sets, tiebreakScores, superTiebreak, supertbWon };
}

// A name: capitalized words, allowing accents/apostrophes/hyphens and
// particles like "De". Requires at least two words. Rating is either a
// decimal UTR ("6.12") or "UR" for unrated players.
const NAME_UTR_SINGLES =
  /([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+)+)\s*(\d+\.\d{2}|UR)\s*(\d*)/g;

function ratingValue(token) {
  const v = parseFloat(token);
  return isNaN(v) ? null : v; // "UR" -> null
}

// Extract players, UTRs, and score digit runs for a singles card.
function extractSingles(rawText, playerName) {
  const firstName = (playerName || "").split(" ")[0];
  const players = [];
  NAME_UTR_SINGLES.lastIndex = 0;
  let pm;
  while ((pm = NAME_UTR_SINGLES.exec(rawText)) !== null) {
    players.push({
      name: pm[1].trim(),
      utr: ratingValue(pm[2]),
      digits: parseScoreDigits(pm[3].trim()),
    });
  }
  if (players.length < 2) return null;

  const meFirst = firstName && players[0].name.includes(firstName);
  const me = meFirst ? players[0] : players[1];
  const them = meFirst ? players[1] : players[0];
  return {
    myUtr: me.utr,
    opponentUtr: them.utr,
    opponentName: them.name,
    myDigits: me.digits,
    oppDigits: them.digits,
  };
}

// Extract teams, UTRs, and score digit runs for a doubles card.
// Layout: "Team1Name1 Team1Name2 UTR UTR <digits> Team2Name1 Team2Name2 UTR UTR <digits>"
function extractDoubles(rawText, playerName) {
  const allUtrs = [...rawText.matchAll(/(\d+\.\d{2}|\bUR\b)/g)];
  if (allUtrs.length < 4) return null;

  const [u0, u1, u2, u3] = allUtrs;
  const afterU1 = rawText.substring(u1.index + u1[0].length).trimStart();
  const afterU3 = rawText.substring(u3.index + u3[0].length).trimStart();
  const myRaw = afterU1.match(/^(\d+)/)?.[1] || "";
  const oppRaw = afterU3.match(/^(\d+)/)?.[1] || "";

  // Team 1 names sit between the date header and the first UTR.
  const beforeU0 = rawText.substring(0, u0.index);
  const headerEnd = beforeU0.lastIndexOf("M |"); // "...8:30 PM | Apr 25 "
  let team1Text = beforeU0;
  if (headerEnd !== -1) {
    // Strip "<time>M | <Mon> <day> " prefix.
    team1Text = beforeU0
      .substring(headerEnd + 3)
      .replace(/^\s*[A-Za-z]{3}\w*\s+\d{1,2}\s*/, "");
  }
  team1Text = team1Text.replace(/\s+/g, " ").trim();

  // Team 2 names sit between team 1's score digits and the third UTR.
  const myDigitsStart = rawText.indexOf(myRaw, u1.index + u1[0].length);
  const team2Start =
    myRaw && myDigitsStart !== -1 ? myDigitsStart + myRaw.length : u1.index + u1[0].length;
  const team2Text = rawText
    .substring(team2Start, u2.index)
    .replace(/\s+/g, " ")
    .trim();

  const onTeam1 = team1Text.includes((playerName || "").split(" ")[0]);
  // The scraper always lists the profile owner's team first in the card, but
  // guard against the reverse just in case.
  const mine = onTeam1
    ? { text: team1Text, utrs: [u0, u1], digits: myRaw }
    : { text: team2Text, utrs: [u2, u3], digits: oppRaw };
  const theirs = onTeam1
    ? { text: team2Text, utrs: [u2, u3], digits: oppRaw }
    : { text: team1Text, utrs: [u0, u1], digits: myRaw };

  // Partner = my team's text minus my own name words.
  const myNameParts = (playerName || "").split(/\s+/).filter(Boolean);
  const partner = mine.text
    .split(/\s+/)
    .filter((w) => !myNameParts.includes(w))
    .join(" ")
    .trim();

  // The two UTRs follow the two names in order, so whether I'm listed first
  // or second on my team tells me which rating is mine.
  const teamWords = mine.text.split(/\s+/);
  const myNameIdx = teamWords.indexOf(myNameParts[0]);
  const iAmListedFirst = myNameIdx >= 0 && myNameIdx < teamWords.length / 2;

  return {
    myUtr: ratingValue(mine.utrs[iAmListedFirst ? 0 : 1][0]),
    partnerUtr: ratingValue(mine.utrs[iAmListedFirst ? 1 : 0][0]),
    myTeamUtrs: [ratingValue(mine.utrs[0][0]), ratingValue(mine.utrs[1][0])],
    opponentUtr: ratingValue(theirs.utrs[1][0]),
    oppTeamUtrs: [ratingValue(theirs.utrs[0][0]), ratingValue(theirs.utrs[1][0])],
    opponentTeamText: theirs.text,
    partner: partner || null,
    myDigits: parseScoreDigits(mine.digits),
    oppDigits: parseScoreDigits(theirs.digits),
  };
}

// Count sets won/lost from a parsed sets array (super-TB entries count as a set).
function countSets(sets) {
  let mine = 0;
  let theirs = 0;
  sets.forEach((set) => {
    const parts = set.split("-");
    if (parts.length !== 2) return; // e.g. "Super TB" placeholder
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (isNaN(a) || isNaN(b)) return;
    if (a > b) mine++;
    else if (b > a) theirs++;
  });
  return { mine, theirs };
}

// Parse one match card.
//
// card: {
//   rawText,            required
//   links,              optional [{ id, name }] profile links found in the card
//   winnerNameText,     optional innerText of the element UTR marks with a
//                       "winner" class (used for retirements)
// }
// options: { playerName, type: "singles"|"doubles" }
function parseMatch(card, { playerName, type = "singles" } = {}) {
  const rawText = (card.rawText || "").replace(/\s+/g, " ").trim();
  const match = { type, rawText };
  const firstName = (playerName || "").split(" ")[0];

  const { dateText, time } = extractDateTime(rawText);
  match.dateText = dateText;
  match.time = time;

  // Winner CSS class fallback (only meaningful when the scraper passed it).
  let classBasedWon;
  if (card.winnerNameText && firstName) {
    classBasedWon = card.winnerNameText.includes(firstName);
  }

  // Opponent links (id + name), excluding the profile owner.
  const links = (card.links || []).filter(
    (l) => l.name && firstName && !l.name.includes(firstName),
  );
  if (type === "singles") {
    if (links.length > 0) {
      match.opponentId = links[0].id;
      match.opponent = links[0].name;
    }
  } else if (links.length > 0) {
    match.opponentIds = links.map((l) => l.id);
  }

  // Walkover: explicit keyword. Winner = whichever side's name appears
  // before the keyword did NOT withdraw... UTR renders "<withdrawing side> walkover";
  // historically: if my name appears before the keyword, the other side withdrew.
  const walkoverRe = /walkover|w\/o|withdrew/i;
  if (walkoverRe.test(rawText)) {
    match.isWalkover = true;
    const before = rawText.substring(0, rawText.search(walkoverRe));
    if (firstName) match.won = before.includes(firstName);
  }

  // Retirement: started but didn't finish. \bret\.?\b avoids "Brett".
  if (!match.isWalkover && /\bret\.?\b|retired/i.test(rawText)) {
    match.isRetirement = true;
  }

  // Extract players + digit runs.
  const extracted =
    type === "doubles"
      ? extractDoubles(rawText, playerName)
      : extractSingles(rawText, playerName);

  if (extracted) {
    match.myUtr = extracted.myUtr;
    match.opponentUtr = extracted.opponentUtr;
    if (type === "doubles") {
      match.myTeamUtrs = extracted.myTeamUtrs;
      match.oppTeamUtrs = extracted.oppTeamUtrs;
      match.partner = extracted.partner;
      match.partnerUtr = extracted.partnerUtr;
      if (!match.opponent) match.opponent = extracted.opponentTeamText;
    } else if (!match.opponent) {
      match.opponent = extracted.opponentName;
    }
  }

  const myDigits = extracted ? extracted.myDigits : [];
  const oppDigits = extracted ? extracted.oppDigits : [];

  const parsed = parseSets(myDigits, oppDigits);
  match.sets = parsed.sets;
  match.tiebreakScores = parsed.tiebreakScores;
  if (parsed.superTiebreak) match.superTiebreak = parsed.superTiebreak;

  // Structural walkover: UTRs present but no score digits at all.
  if (
    !match.isWalkover &&
    match.sets.length === 0 &&
    extracted &&
    myDigits.length === 0 &&
    oppDigits.length === 0
  ) {
    match.isWalkover = true;
    // Winner unknowable from text alone; leave match.won to the CSS fallback.
  }

  // Winner determination, most reliable signal first:
  //   1. walkover text position (already set above)
  //   2. super-tiebreak indicator (encodes winner directly)
  //   3. retirement -> CSS winner class (set counts lie on partial scores)
  //   4. completed match -> set count
  //   5. CSS winner class as last resort
  if (match.won === undefined) {
    if (parsed.supertbWon !== undefined) {
      match.won = parsed.supertbWon;
    } else if (match.isRetirement) {
      if (classBasedWon !== undefined) match.won = classBasedWon;
    } else if (match.sets.length > 0) {
      const { mine, theirs } = countSets(match.sets);
      if (mine !== theirs) match.won = mine > theirs;
    }
    if (match.won === undefined && classBasedWon !== undefined) {
      match.won = classBasedWon;
    }
  }

  return match;
}

// Assign ISO dates to a newest-first match list by inferring the year:
// start at the scrape year and decrement whenever the month increases
// (i.e., we walked back across a year boundary).
function inferYears(matches, scrapedAt) {
  const scr = new Date(scrapedAt || Date.now());
  let year = scr.getFullYear();
  let prevMonth = null;

  matches.forEach((m) => {
    const src = m.dateText || m.date || "";
    const dm = String(src).match(/([A-Za-z]{3})\w*\s+(\d{1,2})/);
    if (!dm || !MONTHS[dm[1]]) {
      // Already ISO or unparseable; leave as-is.
      if (/^\d{4}-\d{2}-\d{2}$/.test(m.date || "")) {
        prevMonth = parseInt(m.date.substring(5, 7), 10);
        year = parseInt(m.date.substring(0, 4), 10);
      }
      return;
    }
    const month = MONTHS[dm[1]];
    const day = parseInt(dm[2], 10);

    if (prevMonth === null) {
      // First (newest) match: if it appears to be after the scrape date,
      // it must be from the previous year.
      const scrMonth = scr.getMonth() + 1;
      if (month > scrMonth || (month === scrMonth && day > scr.getDate())) {
        year--;
      }
    } else if (month > prevMonth) {
      year--;
    }
    prevMonth = month;
    m.date = `${year}-${pad2(month)}-${pad2(day)}`;
  });

  return matches;
}

// Rating entry just before / after a date in a chronological history.
function findRatingBefore(history, date) {
  let closest = null;
  for (const entry of history || []) {
    if (new Date(entry.date) <= date) closest = entry;
    else break;
  }
  return closest;
}

function findRatingAfter(history, date) {
  for (const entry of history || []) {
    if (new Date(entry.date) > date) return entry;
  }
  return null;
}

// Attach my/opponent UTR before+after each match, using the matches' ISO
// dates (inferYears must run first). opponentHistories: { [id]: { history } }.
function attachRatingDeltas(matches, myHistory, opponentHistories) {
  (matches || []).forEach((match) => {
    if (!match.date || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)) return;
    const matchDate = new Date(match.date);

    const myBefore = findRatingBefore(myHistory, matchDate);
    const myAfter = findRatingAfter(myHistory, matchDate);
    match.myUtrBefore = myBefore?.rating;
    match.myUtrAfter = myAfter?.rating;
    match.myUtrDelta =
      myAfter && myBefore
        ? (myAfter.rating - myBefore.rating).toFixed(2)
        : null;

    const oppHistory =
      match.opponentId && opponentHistories?.[match.opponentId]?.history;
    if (oppHistory) {
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
  return matches;
}

module.exports = {
  parseMatch,
  parseSets,
  parseScoreDigits,
  extractSingles,
  extractDoubles,
  extractDateTime,
  inferYears,
  countSets,
  findRatingBefore,
  findRatingAfter,
  attachRatingDeltas,
  MONTHS,
};
