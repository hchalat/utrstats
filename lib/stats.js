// lib/stats.js - Shared statistics engine for UTR Stats.
//
// Consumes matches already cleaned by lib/match-parser.js (ISO dates, parsed
// sets, reliable `won` flags) and computes every stat the site displays.
// Runs in Node (generator, tests) and the browser (client-side windowing):
//   Node:    const Stats = require("./lib/stats");
//   Browser: <script src="lib/stats.js"></script> -> window.UTRStats

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.UTRStats = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  // ---------------------------------------------------------------------
  // Date windows
  // ---------------------------------------------------------------------

  // window: "all" | "12mo" | "ytd" | "6mo" | "3mo" | "1mo" | { year: 2025 }
  function windowRange(window, now) {
    now = now ? new Date(now) : new Date();
    if (!window || window === "all") return { from: null, to: null };
    if (typeof window === "object" && window.year) {
      return {
        from: new Date(window.year, 0, 1),
        to: new Date(window.year, 11, 31, 23, 59, 59),
      };
    }
    const months = { "12mo": 12, "6mo": 6, "3mo": 3, "1mo": 1 }[window];
    if (months) {
      const from = new Date(now);
      from.setMonth(from.getMonth() - months);
      return { from, to: now };
    }
    if (window === "ytd") {
      return { from: new Date(now.getFullYear(), 0, 1), to: now };
    }
    return { from: null, to: null };
  }

  function filterMatches(matches, window, now) {
    const { from, to } = windowRange(window, now);
    if (!from && !to) return matches.slice();
    return matches.filter((m) => {
      if (!m.date || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return false;
      const d = new Date(m.date + "T12:00:00");
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  function filterHistory(history, window, now) {
    const { from, to } = windowRange(window, now);
    if (!from && !to) return history.slice();
    return history.filter((h) => {
      if (!h.date) return false;
      const d = new Date(h.date + "T12:00:00");
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function teamAvg(utrs) {
    const v = (utrs || []).filter((n) => n != null && n > 0);
    return v.length === 2 ? (v[0] + v[1]) / 2 : null;
  }

  // Rating pair used for higher/lower comparisons and best-win/worst-loss.
  // Doubles: team average vs team average (only fair comparison for a team
  // result). Singles: match-time ratings when both sides have them (from
  // rating histories), otherwise the card UTRs (both "current at scrape
  // time") — never a mix, so differences compare like with like.
  function matchUtrs(m) {
    const myTeam = teamAvg(m.myTeamUtrs);
    const oppTeam = teamAvg(m.oppTeamUtrs);
    if (myTeam != null && oppTeam != null) {
      return { my: myTeam, opp: oppTeam, teamAvg: true };
    }
    if (m.myUtrBefore != null && m.opponentUtrBefore != null) {
      return { my: m.myUtrBefore, opp: m.opponentUtrBefore, atMatchTime: true };
    }
    return {
      my: m.myUtr != null ? m.myUtr : null,
      opp: m.opponentUtr != null ? m.opponentUtr : null,
      atMatchTime: false,
    };
  }

  function stripParens(set) {
    return set.replace(/\([^)]*\)/g, "").trim();
  }

  function parseSetPair(set) {
    const parts = stripParens(set).split("-");
    if (parts.length !== 2) return null; // e.g. "Super TB"
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (isNaN(a) || isNaN(b)) return null;
    return [a, b];
  }

  function isSuperTbSet(set, m) {
    if (set === "Super TB") return true;
    const pair = parseSetPair(set);
    if (!pair) return set === m.superTiebreak; // legacy placeholder
    if (pair[0] >= 10 || pair[1] >= 10) return true; // legacy points-in-set
    // A 1-0 / 0-1 set (optionally with points, e.g. "1-0(6)") is a super
    // tiebreak only when the match recorded one — distinguishes it from a
    // real 1-0 partial set in a retirement.
    const clean = stripParens(set);
    if (m.superTiebreak && (clean === "1-0" || clean === "0-1")) return true;
    return set === m.superTiebreak;
  }

  // Score line for display: keep the super-tiebreak's parenthetical points
  // (e.g. "1-0(6)"), strip any parens from other sets.
  function scoreLine(m) {
    return (m.sets || [])
      .map((s) => (isSuperTbSet(s, m) ? s : stripParens(s)))
      .join(" ");
  }

  // "12:00 AM" is UTR's placeholder for unknown time.
  function timeSegment(time) {
    if (!time || /^12:00\s*AM$/i.test(time)) return null;
    const m = time.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10) % 12;
    if (/PM/i.test(m[3])) hour += 12;
    if (hour < 12) return "morning";
    if (hour < 17) return "afternoon";
    return "evening";
  }

  function sortChronological(matches) {
    return matches
      .slice()
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  }

  function pct(wins, losses) {
    const total = wins + losses;
    return total > 0 ? Math.round((wins / total) * 100) : 0;
  }

  // ---------------------------------------------------------------------
  // Main stats generation
  // ---------------------------------------------------------------------

  function generateStats(matches, type, playerName) {
    type = type || "singles";
    const chrono = sortChronological(matches);

    const stats = {
      type,
      // Activity-history style totals
      record: { wins: 0, losses: 0, walkovers: 0, winPct: 0 },
      matchesPlayed: 0,
      setsRecord: { won: 0, lost: 0 },
      gamesRecord: { won: 0, lost: 0, winPct: 0 },
      decidingSets: { won: 0, lost: 0 }, // decisive-set matches
      straightSets: { won: 0, lost: 0 }, // straight-set matches
      tiebreaks: { won: 0, lost: 0 }, // 7-6 sets
      superTiebreaks: { won: 0, lost: 0 },
      tiebreakerSets: { won: 0, lost: 0 }, // 7-6 sets + super TBs combined

      vsHigherRated: { wins: 0, losses: 0 },
      vsLowerRated: { wins: 0, losses: 0 },
      bagels: { given: 0, received: 0 },
      breadsticks: { given: 0, received: 0 },
      doubleBagels: { given: 0, received: 0 },
      gamesDifferential: { wonWithFewer: 0, lostWithMore: 0 },

      longestWinStreak: 0,
      longestLossStreak: 0,
      currentStreak: { type: null, count: 0 },
      form: [], // last 10 played matches, oldest -> newest, "W"/"L"

      firstSet: {
        afterWinning: { wins: 0, losses: 0 },
        afterLosing: { wins: 0, losses: 0 },
      },
      comebacks: { won: 0, lost: 0 },
      revengeWins: [],
      timeOfDay: {
        morning: { wins: 0, losses: 0 },
        afternoon: { wins: 0, losses: 0 },
        evening: { wins: 0, losses: 0 },
      },

      opponents: {},
      partners: {},
      teams: {},
      setScoreCounts: {},

      matches: [],
      nemesis: null,
      dominatedOpponent: null,
      closestRival: null,
      mostFrequentPartner: null,
      bestWin: null,
      worstLoss: null,
    };

    let currentWinStreak = 0;
    let currentLossStreak = 0;
    const formSeq = [];
    const beatenSoFar = new Set();
    const lostToSoFar = new Set();

    chrono.forEach((m) => {
      if (m.isWalkover) {
        stats.record.walkovers++;
        return;
      }
      if (m.won !== true && m.won !== false) return; // undetermined; exclude

      stats.matchesPlayed++;
      const { my: myUtr, opp: oppUtr } = matchUtrs(m);

      // --- W/L record and streaks (chronological) ---
      if (m.won) {
        stats.record.wins++;
        currentWinStreak++;
        currentLossStreak = 0;
        if (currentWinStreak > stats.longestWinStreak) {
          stats.longestWinStreak = currentWinStreak;
        }
      } else {
        stats.record.losses++;
        currentLossStreak++;
        currentWinStreak = 0;
        if (currentLossStreak > stats.longestLossStreak) {
          stats.longestLossStreak = currentLossStreak;
        }
      }
      formSeq.push(m.won ? "W" : "L");

      // --- vs higher/lower rated (skip when either rating is unknown) ---
      if (myUtr != null && oppUtr != null && myUtr > 0 && oppUtr > 0) {
        if (oppUtr > myUtr) {
          if (m.won) stats.vsHigherRated.wins++;
          else stats.vsHigherRated.losses++;
        } else if (oppUtr < myUtr) {
          if (m.won) stats.vsLowerRated.wins++;
          else stats.vsLowerRated.losses++;
        }
        // exact ties count in neither bucket
      }

      // --- revenge wins ---
      const oppKey = type === "doubles" ? m.opponent : m.opponent;
      if (oppKey) {
        if (m.won && lostToSoFar.has(oppKey)) {
          stats.revengeWins.push({ opponent: oppKey, date: m.date });
        }
        if (m.won) beatenSoFar.add(oppKey);
        else lostToSoFar.add(oppKey);
      }

      // --- time of day ---
      const seg = timeSegment(m.time);
      if (seg) {
        if (m.won) stats.timeOfDay[seg].wins++;
        else stats.timeOfDay[seg].losses++;
      }

      // --- opponent / team / partner tracking ---
      function ensure(map, key, extra) {
        if (!map[key]) {
          map[key] = Object.assign(
            {
              played: 0, wins: 0, losses: 0,
              gamesWon: 0, gamesLost: 0, setsWon: 0, setsLost: 0,
            },
            extra || {},
          );
        }
        return map[key];
      }

      let oppEntry = null;
      let partnerEntry = null;
      if (type === "doubles") {
        if (m.opponent) {
          oppEntry = ensure(stats.teams, m.opponent, {});
        }
        if (m.partner) {
          partnerEntry = ensure(stats.partners, m.partner, {});
        }
      } else if (m.opponent) {
        oppEntry = ensure(stats.opponents, m.opponent, {
          utr: oppUtr,
          id: m.opponentId,
        });
      }
      [oppEntry, partnerEntry].forEach((e) => {
        if (!e) return;
        e.played++;
        if (m.won) e.wins++;
        else e.losses++;
      });

      // --- set-by-set analysis ---
      let setsWon = 0;
      let setsLost = 0;
      let gamesWon = 0;
      let gamesLost = 0;
      let hadSuperTb = false;

      (m.sets || []).forEach((set) => {
        const pair = parseSetPair(set);

        // Super tiebreak (either "10-6"-style scores or the placeholder)
        if (isSuperTbSet(set, m)) {
          hadSuperTb = true;
          let won;
          if (pair) won = pair[0] > pair[1];
          else won = m.won; // placeholder: the STB decided the match
          if (won) {
            stats.superTiebreaks.won++;
            stats.tiebreakerSets.won++;
            setsWon++;
          } else {
            stats.superTiebreaks.lost++;
            stats.tiebreakerSets.lost++;
            setsLost++;
          }
          return; // games not counted for super TBs
        }
        if (!pair) return;
        const [myGames, oppGames] = pair;

        // 7-6 tiebreak set
        if ((myGames === 7 && oppGames === 6) || (myGames === 6 && oppGames === 7)) {
          if (myGames === 7) {
            stats.tiebreaks.won++;
            stats.tiebreakerSets.won++;
          } else {
            stats.tiebreaks.lost++;
            stats.tiebreakerSets.lost++;
          }
        }

        gamesWon += myGames;
        gamesLost += oppGames;
        if (myGames > oppGames) setsWon++;
        else if (oppGames > myGames) setsLost++;

        if (myGames === 6 && oppGames === 0) stats.bagels.given++;
        else if (myGames === 0 && oppGames === 6) stats.bagels.received++;
        else if (myGames === 6 && oppGames === 1) stats.breadsticks.given++;
        else if (myGames === 1 && oppGames === 6) stats.breadsticks.received++;

        // set score distribution (from my perspective)
        const key = `${myGames}-${oppGames}`;
        stats.setScoreCounts[key] = (stats.setScoreCounts[key] || 0) + 1;
      });

      stats.setsRecord.won += setsWon;
      stats.setsRecord.lost += setsLost;
      stats.gamesRecord.won += gamesWon;
      stats.gamesRecord.lost += gamesLost;

      // Double bagel: won (or lost) 6-0 6-0
      const cleanPairs = (m.sets || []).map(parseSetPair).filter(Boolean);
      if (cleanPairs.length === 2) {
        if (cleanPairs.every(([a, b]) => a === 6 && b === 0)) {
          stats.doubleBagels.given++;
        } else if (cleanPairs.every(([a, b]) => a === 0 && b === 6)) {
          stats.doubleBagels.received++;
        }
      }

      if (m.won && gamesWon < gamesLost) stats.gamesDifferential.wonWithFewer++;
      else if (!m.won && gamesWon > gamesLost) {
        stats.gamesDifferential.lostWithMore++;
      }

      // Decisive-set match: both sides took a set, or it went to a super TB
      const wentToDecider = (setsWon >= 1 && setsLost >= 1) || hadSuperTb;
      if (wentToDecider && !m.isRetirement) {
        if (m.won) stats.decidingSets.won++;
        else stats.decidingSets.lost++;
      }
      // Straight-set match: completed, 2+ sets, winner dropped none
      if (!wentToDecider && !m.isRetirement && cleanPairs.length >= 2) {
        if (m.won && setsLost === 0) stats.straightSets.won++;
        else if (!m.won && setsWon === 0) stats.straightSets.lost++;
      }

      // --- first set -> result ---
      if ((m.sets || []).length >= 2) {
        const first = parseSetPair(m.sets[0]);
        if (first && first[0] !== first[1]) {
          const wonFirst = first[0] > first[1];
          const bucket = wonFirst
            ? stats.firstSet.afterWinning
            : stats.firstSet.afterLosing;
          if (m.won) bucket.wins++;
          else bucket.losses++;
          if (m.won && !wonFirst) stats.comebacks.won++;
          if (!m.won && wonFirst) stats.comebacks.lost++;
        }
      }

      [oppEntry, partnerEntry].forEach((e) => {
        if (!e) return;
        e.gamesWon += gamesWon;
        e.gamesLost += gamesLost;
        e.setsWon += setsWon;
        e.setsLost += setsLost;
      });

      // --- cleaned match entry for the frontend match log ---
      stats.matches.push({
        date: m.date,
        time: m.time || null,
        opponent: m.opponent || "Unknown",
        partner: type === "doubles" ? m.partner || null : null,
        opponentId: m.opponentId,
        opponentUtr: oppUtr,
        myUtr: myUtr,
        myUtrBefore: m.myUtrBefore,
        myUtrAfter: m.myUtrAfter,
        myUtrDelta: m.myUtrDelta,
        opponentUtrBefore: m.opponentUtrBefore,
        opponentUtrAfter: m.opponentUtrAfter,
        won: m.won,
        isWalkover: false,
        sets: m.sets || [],
        tiebreakScores: m.tiebreakScores || [],
        score: scoreLine(m),
        eventName: m.eventName || null,
      });
    });

    stats.record.winPct = pct(stats.record.wins, stats.record.losses);
    stats.gamesRecord.winPct = pct(stats.gamesRecord.won, stats.gamesRecord.lost);
    stats.form = formSeq.slice(-10);
    if (formSeq.length > 0) {
      const last = formSeq[formSeq.length - 1];
      let count = 0;
      for (let i = formSeq.length - 1; i >= 0 && formSeq[i] === last; i--) count++;
      stats.currentStreak = { type: last, count };
    }

    // --- most common set / match scores ---
    const scoreEntries = Object.entries(stats.setScoreCounts).sort(
      (a, b) => b[1] - a[1],
    );
    stats.mostCommonSetScore = scoreEntries.length
      ? { score: scoreEntries[0][0], count: scoreEntries[0][1] }
      : null;

    // --- callouts over opponents (singles) or teams (doubles) ---
    const rosterMap = type === "doubles" ? stats.teams : stats.opponents;
    const roster = Object.entries(rosterMap).map(([name, data]) =>
      Object.assign({ name, gameDiff: data.gamesWon - data.gamesLost }, data),
    );

    const nemesisCandidates = roster.filter((o) => o.losses >= 1 && o.played >= 2);
    if (nemesisCandidates.length > 0) {
      nemesisCandidates.sort((a, b) => {
        const aNet = a.losses - a.wins;
        const bNet = b.losses - b.wins;
        if (aNet !== bNet) return bNet - aNet;
        if (a.gameDiff !== b.gameDiff) return a.gameDiff - b.gameDiff;
        return b.played - a.played;
      });
      const nem = nemesisCandidates[0];
      stats.nemesis = {
        name: nem.name,
        record: `${nem.wins}-${nem.losses}`,
        gamesRecord: `${nem.gamesWon}-${nem.gamesLost}`,
        utr: nem.utr,
      };
    }

    const dominatedCandidates = roster.filter((o) => o.wins >= 1 && o.played >= 2);
    if (dominatedCandidates.length > 0) {
      dominatedCandidates.sort((a, b) => {
        const aNet = a.wins - a.losses;
        const bNet = b.wins - b.losses;
        if (aNet !== bNet) return bNet - aNet;
        if (a.gameDiff !== b.gameDiff) return b.gameDiff - a.gameDiff;
        return b.played - a.played;
      });
      const dom = dominatedCandidates[0];
      stats.dominatedOpponent = {
        name: dom.name,
        record: `${dom.wins}-${dom.losses}`,
        gamesRecord: `${dom.gamesWon}-${dom.gamesLost}`,
        utr: dom.utr,
      };
    }

    const rivalCandidates = roster.filter((o) => o.played >= 2);
    if (rivalCandidates.length > 0) {
      rivalCandidates.sort((a, b) => {
        const aTotal = a.gamesWon + a.gamesLost;
        const bTotal = b.gamesWon + b.gamesLost;
        const aPct = aTotal > 0 ? Math.abs((a.gameDiff / aTotal) * 100) : 999;
        const bPct = bTotal > 0 ? Math.abs((b.gameDiff / bTotal) * 100) : 999;
        if (aPct !== bPct) return aPct - bPct;
        const aDiff = Math.abs(a.wins - a.losses);
        const bDiff = Math.abs(b.wins - b.losses);
        if (aDiff !== bDiff) return aDiff - bDiff;
        return b.played - a.played;
      });
      const rival = rivalCandidates[0];
      stats.closestRival = {
        name: rival.name,
        record: `${rival.wins}-${rival.losses}`,
        gamesRecord: `${rival.gamesWon}-${rival.gamesLost}`,
        gameDiff: rival.gameDiff > 0 ? `+${rival.gameDiff}` : `${rival.gameDiff}`,
        utr: rival.utr,
      };
    }

    roster.sort((a, b) => b.played - a.played);
    stats.frequentOpponents = roster.slice(0, 5).map((o) => ({
      name: o.name,
      id: o.id,
      played: o.played,
      record: `${o.wins}-${o.losses}`,
      gamesRecord: `${o.gamesWon}-${o.gamesLost}`,
      utr: o.utr,
    }));

    if (type === "doubles") {
      const partnerList = Object.entries(stats.partners).map(([name, data]) =>
        Object.assign({ name }, data),
      );
      partnerList.sort((a, b) => b.played - a.played);
      stats.partnerRecords = partnerList.slice(0, 5).map((p) => ({
        name: p.name,
        played: p.played,
        record: `${p.wins}-${p.losses}`,
        gamesRecord: `${p.gamesWon}-${p.gamesLost}`,
        winPct: pct(p.wins, p.losses),
      }));
      if (partnerList.length > 0) {
        const mf = partnerList[0];
        stats.mostFrequentPartner = {
          name: mf.name,
          played: mf.played,
          record: `${mf.wins}-${mf.losses}`,
          gamesRecord: `${mf.gamesWon}-${mf.gamesLost}`,
        };
        // Best chemistry: highest win % with >= 2 matches together
        const chem = partnerList
          .filter((p) => p.played >= 2)
          .sort((a, b) => pct(b.wins, b.losses) - pct(a.wins, a.losses))[0];
        if (chem) {
          stats.bestPartner = {
            name: chem.name,
            played: chem.played,
            record: `${chem.wins}-${chem.losses}`,
            winPct: pct(chem.wins, chem.losses),
          };
        }
      }
    }

    // --- best win / worst loss by rating difference ---
    chrono.forEach((m) => {
      if (m.isWalkover || (m.won !== true && m.won !== false)) return;
      const { my, opp } = matchUtrs(m);
      if (my == null || opp == null || my <= 0 || opp <= 0) return;
      const utrDiff = opp - my;
      const entry = {
        opponent: m.opponent,
        opponentUtr: opp,
        myUtr: my,
        utrDiff,
        score: scoreLine(m),
        date: m.date,
        partner: type === "doubles" ? m.partner || null : undefined,
      };
      if (m.won) {
        if (!stats.bestWin || utrDiff > stats.bestWin.utrDiff) stats.bestWin = entry;
      } else if (!stats.worstLoss || utrDiff < stats.worstLoss.utrDiff) {
        stats.worstLoss = entry;
      }
    });

    // --- monthly breakdown (min 3 matches for best/worst callouts) ---
    const monthly = {};
    stats.matches.forEach((m) => {
      if (!m.date || !/^\d{4}-\d{2}/.test(m.date)) return;
      const key = m.date.substring(0, 7); // YYYY-MM
      if (!monthly[key]) {
        const monthIdx = parseInt(m.date.substring(5, 7), 10) - 1;
        monthly[key] = {
          key,
          month: MONTH_NAMES[monthIdx],
          year: m.date.substring(0, 4),
          wins: 0,
          losses: 0,
        };
      }
      if (m.won) monthly[key].wins++;
      else monthly[key].losses++;
    });
    const monthlyData = Object.values(monthly)
      .map((mo) =>
        Object.assign(mo, {
          total: mo.wins + mo.losses,
          winPct: pct(mo.wins, mo.losses),
        }),
      )
      .sort((a, b) => a.key.localeCompare(b.key));
    stats.monthlyBreakdown = monthlyData;

    const eligible = monthlyData.filter((mo) => mo.total >= 3);
    const pool = eligible.length > 0 ? eligible : monthlyData;
    stats.bestMonth = pool.length
      ? pool.reduce((a, b) => (b.winPct > a.winPct ? b : a))
      : null;
    stats.worstMonth = pool.length
      ? pool.reduce((a, b) => (b.winPct < a.winPct ? b : a))
      : null;
    stats.busiestMonth = monthlyData.length
      ? monthlyData.reduce((a, b) => (b.total > a.total ? b : a))
      : null;

    // --- quality wins (upsets) ---
    stats.qualityWins = stats.matches
      .filter((m) => m.won && m.opponentUtr > 0 && m.myUtr > 0 && m.opponentUtr > m.myUtr)
      .sort((a, b) => (b.opponentUtr - b.myUtr) - (a.opponentUtr - a.myUtr))
      .slice(0, 3)
      .map((m) => ({
        player: m.opponent,
        utrDiff: (m.opponentUtr - m.myUtr).toFixed(2),
        date: m.date,
        score: m.score,
      }));

    return stats;
  }

  // ---------------------------------------------------------------------
  // Rating history stats
  // ---------------------------------------------------------------------

  function ratingStats(history, window, now) {
    const inWindow = filterHistory(history || [], window, now).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (inWindow.length === 0) {
      return { start: null, end: null, peak: null, min: null, change: null, biggestJump: null };
    }
    let peak = inWindow[0];
    let min = inWindow[0];
    let biggestJump = null;
    for (let i = 0; i < inWindow.length; i++) {
      const h = inWindow[i];
      if (h.rating > peak.rating) peak = h;
      if (h.rating < min.rating) min = h;
      if (i > 0) {
        const delta = h.rating - inWindow[i - 1].rating;
        if (!biggestJump || delta > biggestJump.delta) {
          biggestJump = { delta, from: inWindow[i - 1], to: h };
        }
      }
    }
    return {
      start: inWindow[0],
      end: inWindow[inWindow.length - 1],
      peak: { rating: peak.rating, date: peak.date },
      min: { rating: min.rating, date: min.date },
      change: +(inWindow[inWindow.length - 1].rating - inWindow[0].rating).toFixed(2),
      biggestJump: biggestJump
        ? { delta: +biggestJump.delta.toFixed(2), date: biggestJump.to.date }
        : null,
    };
  }

  // Per-year season summaries for the Trends tab.
  function seasonSummaries(matches, history, type, playerName) {
    const years = new Set();
    matches.forEach((m) => {
      if (m.date && /^\d{4}/.test(m.date)) years.add(m.date.substring(0, 4));
    });
    return Array.from(years)
      .sort()
      .map((y) => {
        const year = parseInt(y, 10);
        const s = generateStats(
          filterMatches(matches, { year }),
          type,
          playerName,
        );
        const r = ratingStats(history, { year });
        return {
          year,
          wins: s.record.wins,
          losses: s.record.losses,
          winPct: s.record.winPct,
          matches: s.matchesPlayed,
          peakUtr: r.peak,
          endUtr: r.end ? r.end.rating : null,
          utrChange: r.change,
        };
      });
  }

  // ---------------------------------------------------------------------
  // Head-to-head
  // ---------------------------------------------------------------------

  // "6-3" -> "3-6", "1-0(6)" -> "0-1(6)"; anything else is left alone.
  function flipSet(set) {
    const m = String(set).match(/^(\d+)-(\d+)(.*)$/);
    return m ? `${m[2]}-${m[1]}${m[3]}` : set;
  }

  // Re-express a match from the opponent's point of view.
  function flipMatch(m) {
    const f = Object.assign({}, m, {
      won: m.won === true ? false : m.won === false ? true : m.won,
      sets: (m.sets || []).map(flipSet),
      myUtr: m.opponentUtr,
      opponentUtr: m.myUtr,
      myUtrBefore: m.opponentUtrBefore,
      opponentUtrBefore: m.myUtrBefore,
      myUtrAfter: m.opponentUtrAfter,
      opponentUtrAfter: m.myUtrAfter,
      myUtrDelta: null,
    });
    if (m.superTiebreak) f.superTiebreak = flipSet(m.superTiebreak);
    if (m.myTeamUtrs || m.oppTeamUtrs) {
      f.myTeamUtrs = m.oppTeamUtrs;
      f.oppTeamUtrs = m.myTeamUtrs;
    }
    return f;
  }

  function facedPlayer(m, id) {
    return m.opponentId === id || (m.opponentIds || []).includes(id);
  }

  // Every match player A and player B played against each other, from A's
  // point of view, oldest first. Each bundle is a separate scrape and either
  // can miss results, so both sides are merged (deduped by resultId).
  // opts: { nameA, nameB } fill in opponent names for matches only B has.
  function headToHeadMatches(matchesA, matchesB, idA, idB, opts) {
    opts = opts || {};
    idA = String(idA);
    idB = String(idB);
    const byKey = new Map();
    const keyOf = (m) => m.resultId != null
      ? `r${m.resultId}`
      : `${m.date}|${(m.sets || []).join(" ")}`;

    (matchesA || []).forEach((m) => {
      if (facedPlayer(m, idB)) byKey.set(keyOf(m), m);
    });
    (matchesB || []).forEach((m) => {
      if (!facedPlayer(m, idA)) return;
      const flipped = flipMatch(m);
      const k = keyOf(flipped);
      if (byKey.has(k)) return;
      if (m.type !== "doubles") {
        flipped.opponent = opts.nameB || null;
        flipped.opponentId = idB;
      } else {
        // B's bundle names B's partner and A's team; A's partner is unknown.
        flipped.opponent = [opts.nameB, m.partner].filter(Boolean).join(" / ");
        flipped.opponentIds = [idB];
        flipped.partner = null;
      }
      byKey.set(k, flipped);
    });
    return sortChronological(Array.from(byKey.values()));
  }

  return {
    WINDOWS: ["all", "12mo", "ytd", "6mo", "3mo", "1mo"],
    headToHeadMatches,
    windowRange,
    filterMatches,
    filterHistory,
    generateStats,
    ratingStats,
    seasonSummaries,
  };
});
