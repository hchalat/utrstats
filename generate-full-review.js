// generate-full-review.js - Generate comprehensive Year in Review from full scrape
const fs = require("fs");
const path = require("path");

const scriptStartTime = Date.now();
console.log(`\n⏱️  Generator started at: ${new Date().toISOString()}\n`);

const PROFILE_ID = process.argv[2] || "904826";
const TARGET_YEAR = process.argv[3] || "2025"; // Default to 2025

// Load data
let fullData, historyData;

// Use OUTPUT_DIR from environment (for Lambda) or __dirname (for local)
const dataDir = process.env.OUTPUT_DIR || process.env.CACHE_DIR || __dirname;

try {
  const dataPath = path.join(dataDir, `utr-full-${PROFILE_ID}.json`);
  console.log(`Looking for data at: ${dataPath}`);
  fullData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  console.log(`✅ Loaded data from ${dataPath}`);
} catch (e) {
  console.log(
    `No full data found at ${dataDir}/utr-full-${PROFILE_ID}.json. Run: node scraper-full.js ${PROFILE_ID}`,
  );
  // Fallback to existing data
  try {
    historyData = JSON.parse(
      fs.readFileSync(path.join(dataDir, "utr-history-parsed.json"), "utf8"),
    );
  } catch (e2) {
    console.log("No data found at all. Please run the scraper first.");
    process.exit(1);
  }
}

// Parse scores from raw text - format is like "66 40" or "56110 7106"
// Regular sets: single digits per set (6 and 4 = 6-4)
// Tiebreaks: "677 363" = 6-3, 7-6(3) where extra digit is loser's tiebreak points
// Super tiebreaks: "56110 7106" = 5-7, 6-1, 10-6 (remaining digits form the super TB score)
function parseScoresFromRawText(rawText, playerName, type = "singles") {
  if (!rawText) return { sets: [], won: null };

  let userScoreStr, oppScoreStr;

  if (type === "doubles") {
    // For doubles: Format: "Player1 Partner1 UTR1 UTR2 SCORES Opp1 Opp2 UTR3 UTR4 SCORES"
    // Find all UTRs first
    const allUtrs = [...rawText.matchAll(/(\d+\.\d{2})/g)];

    if (allUtrs.length >= 4) {
      // After the 4th UTR, we should find the opponent scores
      // After the 2nd UTR, we should find our scores
      const secondUtrIndex = allUtrs[1].index + allUtrs[1][0].length;
      const fourthUtrIndex = allUtrs[3].index + allUtrs[3][0].length;

      // Extract scores after each team's UTRs
      const afterSecondUtr = rawText.substring(secondUtrIndex).trim();
      const afterFourthUtr = rawText.substring(fourthUtrIndex).trim();

      // Find the score digits (sequence of digits before next name or end)
      const userScoreMatch = afterSecondUtr.match(/^(\d+)/);
      const oppScoreMatch = afterFourthUtr.match(/^(\d+)/);

      if (userScoreMatch && oppScoreMatch) {
        userScoreStr = userScoreMatch[1];
        oppScoreStr = oppScoreMatch[1];
      }
    }
  } else {
    // For singles: Find all UTR values (format: d.dd like 5.74) followed by score digits
    const utrPattern = /(\d+\.\d{2})\s+(\d+)/g;
    const matches = [...rawText.matchAll(utrPattern)];

    if (matches.length >= 2) {
      // First two matches are player and opponent
      userScoreStr = matches[0][2]; // e.g., "66", "677", "56110"
      oppScoreStr = matches[1][2]; // e.g., "40", "363", "7106"
    }
  }

  if (userScoreStr && oppScoreStr) {
    const userDigits = userScoreStr.split("").map(Number);
    const oppDigits = oppScoreStr.split("").map(Number);

    const sets = [];
    let userSetsWon = 0,
      oppSetsWon = 0;
    let i = 0;

    // Don't use special case parsing - let the main loop handle it
    // This allows proper detection of embedded tiebreak scores

    // First pass: parse regular sets and 7-6 tiebreaks
    while (i < userDigits.length && i < oppDigits.length) {
      const my = userDigits[i];
      const opp = oppDigits[i];

      // Check for tiebreak set (7-6 or 6-7)
      if ((my === 7 && opp === 6) || (my === 6 && opp === 7)) {
        // Check if next digits are tiebreak scores
        // Format: "624" vs "776" -> 6-7(2-7) means tiebreak score is 2-7
        if (i + 1 < userDigits.length && i + 1 < oppDigits.length) {
          const nextMy = userDigits[i + 1];
          const nextOpp = oppDigits[i + 1];

          // If next digits are in valid tiebreak range (0-7), they're tiebreak scores
          if (nextMy >= 0 && nextMy <= 7 && nextOpp >= 0 && nextOpp <= 7) {
            // Check if the digits after that are also valid set scores
            // If so, the tiebreak scores are embedded here
            if (i + 2 < userDigits.length && i + 2 < oppDigits.length) {
              const afterMy = userDigits[i + 2];
              const afterOpp = oppDigits[i + 2];
              // If after-tiebreak digits are valid set scores (0-7), then we have embedded tiebreak
              if (
                afterMy >= 0 &&
                afterMy <= 7 &&
                afterOpp >= 0 &&
                afterOpp <= 7
              ) {
                // Format: 7-6(7-1) or 6-7(2-7) with tiebreak scores embedded
                sets.push(`${my}-${opp}(${nextMy}-${nextOpp})`);
                if (my > opp) userSetsWon++;
                else oppSetsWon++;
                i += 2; // Skip tiebreak score digits, continue to next set
                continue;
              }
            }
            // If no digits after, or they're not valid set scores, might still be tiebreak
            // But if they look like a valid set (e.g., 4-6), they're the next set
            // For now, assume they're tiebreak scores if both are <= 7
            sets.push(`${my}-${opp}(${nextMy}-${nextOpp})`);
            if (my > opp) userSetsWon++;
            else oppSetsWon++;
            i += 2; // Skip tiebreak score digits
            continue;
          } else {
            // Next digits are not valid tiebreak scores, so no tiebreak score reported
            sets.push(`${my}-${opp}`);
            if (my > opp) userSetsWon++;
            else oppSetsWon++;
            i++;
            continue;
          }
        }
        // No next digit, just record 7-6
        sets.push(`${my}-${opp}`);
        if (my > opp) userSetsWon++;
        else oppSetsWon++;
        i++;
        continue;
      }

      // Check for super tiebreak indicator: 0-1 or 1-0
      // When we see this, the remaining digits form the super tiebreak score
      // Format: "6403" vs "36110" -> 6-3, 4-6, then 0-1 indicates super TB
      // Raw sets show: ['64-36', '0-11', '3-0']
      // So after 0-1, we have: user has [3] (from "3-0"), opp has [1] (from "0-11") then [1,0]
      // If user won 10-3, maybe: user's "3" + "1" from opp = "13"? No
      // Or maybe: the "1" from "0-11" and "0" from "3-0" form "10" (user's score)
      // And "3" from "3-0" is opp's score
      if ((my === 0 && opp === 1) || (my === 1 && opp === 0)) {
        // Check if there's a next digit that might be part of the tiebreak indicator
        // For "0-11" format, the second "1" might be part of the score
        const nextUser = i + 1 < userDigits.length ? userDigits[i + 1] : null;
        const nextOpp = i + 1 < oppDigits.length ? oppDigits[i + 1] : null;

        // Get remaining digits after the 0-1 indicator (and possibly the next digit)
        let remainingUser = userDigits.slice(i + 1);
        let remainingOpp = oppDigits.slice(i + 1);

        // If next digits are also 1-1 (like "0-11"), include them
        if (
          nextUser === 1 &&
          nextOpp === 1 &&
          i + 2 < userDigits.length &&
          i + 2 < oppDigits.length
        ) {
          // Skip the second "1" and continue
          remainingUser = userDigits.slice(i + 2);
          remainingOpp = oppDigits.slice(i + 2);
        }

        if (remainingUser.length > 0 && remainingOpp.length > 0) {
          let stbUser = 0,
            stbOpp = 0;

          // Special case: "0-11" followed by "3-0" format
          // Raw sets: ['64-36', '0-11', '3-0']
          // This means: after 0-1, we have another "1" (from "0-11"), then "3-0"
          // If user won 10-3, maybe: "1" (from "0-11") + "0" (from "3-0") = "10" (user)
          // And "3" (from "3-0") = "3" (opp)
          if (nextUser === 1 && nextOpp === 1) {
            // We have "0-11" format
            // After skipping the second "1", we should have "3-0"
            if (remainingUser.length >= 1 && remainingOpp.length >= 1) {
              // Try: user's digit from "3-0" + "1" from "0-11" = user's score
              // Opp's digit from "3-0" = opp's score
              const userFrom30 = remainingUser[0] || 0;
              const oppFrom30 = remainingOpp[0] || 0;
              // Combine "1" (from the second "1" in "0-11") with "0" (from "3-0")
              // But we already skipped that "1", so maybe:
              // User's score = combine "1" (from "0-11") with "0" (from "3-0") = "10"
              // Actually, we have remainingUser[0] = 3, remainingOpp[0] = ?
              // Let me check: after "0-11", we have "3-0"
              // So remainingUser[0] = 3, remainingOpp should have the "0" from "3-0"
              // But we need to get the "1" from "0-11" to form "10"
              // The "1" is at position i+1 in oppDigits
              if (i + 1 < oppDigits.length && oppDigits[i + 1] === 1) {
                // We have the "1" from "0-11"
                // Combine it with "0" from remainingOpp to form "10"
                if (remainingOpp.length >= 1 && remainingOpp[0] === 0) {
                  stbUser = 10; // "1" + "0" = "10"
                  stbOpp = remainingUser[0] || 0; // "3" from "3-0"
                }
              }
            }
          }

          // If we didn't get valid scores from the special case, try standard parsing
          if (stbUser < 10 && stbOpp < 10) {
            // Try different combinations to form valid super tiebreak scores (>= 10)
            // Strategy 1: If opponent has 2+ digits, try combining first two for their score
            // For "6403" vs "36110": after 0-1, user=[3], opp=[1,0]
            // opp's [1,0] = 10, user's [3] = 3, so tiebreak is 3-10 (opponent won)
            if (remainingOpp.length >= 2) {
              const oppFirstTwo = parseInt(remainingOpp.slice(0, 2).join(""));
              const userSingle =
                remainingUser.length > 0
                  ? remainingUser[remainingUser.length - 1]
                  : 0;

              if (oppFirstTwo >= 10) {
                // Opponent's score is >= 10, user's is single digit
                stbOpp = oppFirstTwo;
                stbUser = userSingle;
              } else {
                // Try reverse: user might have the >= 10 score
                if (remainingUser.length >= 2) {
                  const userFirstTwo = parseInt(
                    remainingUser.slice(0, 2).join(""),
                  );
                  const oppSingle =
                    remainingOpp.length > 0
                      ? remainingOpp[remainingOpp.length - 1]
                      : 0;
                  if (userFirstTwo >= 10) {
                    stbUser = userFirstTwo;
                    stbOpp = oppSingle;
                  }
                }
              }
            } else if (remainingOpp.length >= 3) {
              // For match 8: "77204" vs "616110" -> after 0-1, opp has [1,1,0]
              // The last two digits [1,0] = 10, user has [4] = 4
              const oppLastTwo = parseInt(remainingOpp.slice(-2).join(""));
              const userSingle =
                remainingUser.length > 0
                  ? remainingUser[remainingUser.length - 1]
                  : 0;
              if (oppLastTwo >= 10) {
                stbOpp = oppLastTwo;
                stbUser = userSingle;
              }
            } else if (
              remainingOpp.length === 1 &&
              remainingUser.length === 1
            ) {
              // Both have single digits - try combining with previous digits
              // For "0-11" format, the second "1" might be part of the score
              if (nextUser === 1 && nextOpp === 1) {
                // We have "0-11", then "3-0"
                // The "1" from "0-11" + "0" from "3-0" = "10" (opponent)
                // The "3" from "3-0" = "3" (user)
                if (remainingOpp[0] === 0 && remainingUser[0] > 0) {
                  stbOpp = 10; // "1" + "0" = "10"
                  stbUser = remainingUser[0]; // "3"
                }
              }
            }

            // Strategy 2: Try combining all remaining digits
            if (stbUser < 10 && stbOpp < 10) {
              stbUser = parseInt(remainingUser.join("")) || 0;
              stbOpp = parseInt(remainingOpp.join("")) || 0;
            }
          }

          // If we got valid super tiebreak scores, use them
          if (stbUser >= 10 || stbOpp >= 10) {
            // Format: show as 1-0(score) or 0-1(score) depending on who won
            // The 1-0 or 0-1 indicates who won the deciding set
            if (stbUser > stbOpp) {
              sets.push(`1-0(${stbUser}-${stbOpp})`);
              userSetsWon++;
            } else {
              sets.push(`0-1(${stbUser}-${stbOpp})`);
              oppSetsWon++;
            }
            break; // Done parsing
          }
        }

        // If we couldn't form valid scores, check if we have remaining digits
        // If no remaining digits or they don't form valid scores, it's a super tiebreak with no score recorded
        if (remainingUser.length === 0 && remainingOpp.length === 0) {
          // No remaining digits - super tiebreak with no score recorded
          // Format: 1-0 or 0-1 depending on who won
          if (my === 1) {
            sets.push("1-0");
            userSetsWon++;
          } else {
            sets.push("0-1");
            oppSetsWon++;
          }
        } else {
          // Have remaining digits but couldn't form valid scores from them
          // Still record the super tiebreak result
          if (my === 1) {
            sets.push("1-0");
            userSetsWon++;
          } else {
            sets.push("0-1");
            oppSetsWon++;
          }
        }
        break; // Done parsing
      }

      // Valid regular set scores (0-7 range)
      if (my >= 0 && my <= 7 && opp >= 0 && opp <= 7) {
        // Check if this looks like a valid set result
        const isValidSet =
          (my === 6 && opp <= 4) ||
          (opp === 6 && my <= 4) ||
          (my === 7 && opp === 5) ||
          (opp === 7 && my === 5) ||
          (my === 7 && opp === 6) ||
          (opp === 7 && my === 6) ||
          // Also allow 5-7, 4-6, etc.
          (my <= 6 && opp <= 6 && (my !== 0 || opp !== 0));

        if (isValidSet) {
          sets.push(`${my}-${opp}`);
          if (my > opp) userSetsWon++;
          else if (opp > my) oppSetsWon++;
          i++;
          continue;
        }
      }

      // If we get here, remaining digits might be super tiebreak without indicator
      const remainingUser = userDigits.slice(i).join("");
      const remainingOpp = oppDigits.slice(i).join("");

      if (remainingUser.length > 0 && remainingOpp.length > 0) {
        const stbUser = parseInt(remainingUser) || 0;
        const stbOpp = parseInt(remainingOpp) || 0;

        // Valid super tiebreak: one score >= 10, win by 2
        if ((stbUser >= 10 || stbOpp >= 10) && stbUser !== stbOpp) {
          sets.push(`${stbUser}-${stbOpp}`);
          if (stbUser > stbOpp) userSetsWon++;
          else oppSetsWon++;
        }
      }
      break;
    }

    return {
      sets,
      won: userSetsWon > oppSetsWon,
    };
  }

  return { sets: [], won: null };
}

// Normalize a date like "Dec 23" to full date string, inferring year
function normalizeDate(dateStr, inferYear = TARGET_YEAR) {
  if (!dateStr) return null;

  // If already has year (YYYY-MM-DD format), return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Parse "Dec 23" or "May 4" format
  const monthMap = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };

  const match = dateStr.match(/([A-Za-z]{3})\s*(\d{1,2})/);
  if (match) {
    const month = monthMap[match[1]] || "01";
    const day = match[2].padStart(2, "0");
    return `${inferYear}-${month}-${day}`;
  }

  return dateStr;
}

// Fix match data with proper score parsing
function fixMatchData(matches, playerName, type = "singles") {
  return matches.map((m) => {
    // Parse scores from raw text
    const { sets: parsedSets, won: parsedWon } = parseScoresFromRawText(
      m.rawText,
      playerName,
      type,
    );

    // Use parsed data if original is bad
    let sets = m.sets || [];

    // For doubles, always reparse from raw text (format is different)
    // For singles, check if original sets look wrong (like "66-40") or empty
    if (
      type === "doubles" ||
      (sets.length > 0 && sets[0].match(/^\d{2,}-\d{2,}$/)) ||
      sets.length === 0
    ) {
      sets = parsedSets;
    }

    // Check if there's a super tiebreak
    // Super tiebreaks can be:
    // 1. "1-0(score)" or "0-1(score)" format with parentheses
    // 2. Scores >= 10 (actual super tiebreak scores like 10-6)
    // 3. "1-0" or "0-1" alone (indicates who won the super tiebreak, score not shown)
    const hasSuperTiebreak = sets.some((s) => {
      // Check for "0-1(score)" or "1-0(score)" format WITH parentheses
      if (s.match(/^[01]-[01]\(/)) return true;
      // Check for scores >= 10 (actual super tiebreak scores)
      const parts = s.replace(/\([^)]+\)/, "").split("-");
      if (parts.length === 2) {
        const a = parseInt(parts[0]);
        const b = parseInt(parts[1]);
        if (a >= 10 || b >= 10) return true;
        // Check for "1-0" or "0-1" format (super tiebreak indicator)
        // This appears as the third set in a match that went to super tiebreak
        if ((a === 1 && b === 0) || (a === 0 && b === 1)) {
          // Only treat as super tiebreak if it's the 3rd set (deciding set)
          // We can't know the position, but if we have 3 sets and one is "1-0" or "0-1", it's likely a super tiebreak
          if (sets.length >= 3) return true;
        }
      }
      return false;
    });

    // Always calculate won from set count - this is the most reliable method
    // Count sets won by comparing scores
    let mySets = 0,
      oppSets = 0;
    sets.forEach((set) => {
      // Remove tiebreak scores in parentheses for comparison
      const cleanSet = set.replace(/\([^)]+\)/, "");
      const parts = cleanSet.split("-");
      if (parts.length === 2) {
        const a = parseInt(parts[0]);
        const b = parseInt(parts[1]);
        if (!isNaN(a) && !isNaN(b)) {
          // For super tiebreaks with format "1-0" or "0-1" (without parentheses),
          // the "1-0" means we won, "0-1" means opponent won
          if (hasSuperTiebreak && a === 1 && b === 0) {
            mySets++;
          } else if (hasSuperTiebreak && a === 0 && b === 1) {
            oppSets++;
          } else if (hasSuperTiebreak && cleanSet.match(/^[01]-[01]\(/)) {
            // Format with parentheses: "1-0(score)" means we won, "0-1(score)" means opponent won
            if (a === 1 && b === 0) mySets++;
            else if (a === 0 && b === 1) oppSets++;
          } else {
            // Regular set comparison
            if (a > b) mySets++;
            else if (b > a) oppSets++;
          }
        }
      }
    });

    // Determine winner from set count
    let won = mySets > oppSets;

    // Only use original scraper's won value if we couldn't determine from sets
    if (mySets === 0 && oppSets === 0 && m.won !== undefined) {
      won = m.won;
    } else if (mySets === 0 && oppSets === 0 && parsedWon !== null) {
      won = parsedWon;
    }

    // Handle walkovers
    if (m.isWalkover || m.rawText?.toLowerCase().includes("walkover")) {
      won = m.won !== undefined ? m.won : true;
    }

    // Normalize the date
    const normalizedDate = normalizeDate(m.date);

    return {
      ...m,
      date: normalizedDate || m.date,
      sets,
      won,
      isWalkover: m.isWalkover || m.rawText?.toLowerCase().includes("walkover"),
      score: sets.join(" "),
    };
  });
}

// Fix the match data
if (fullData) {
  const dataFixStart = Date.now();
  console.log("⏱️  Fixing match data...");
  const playerName = fullData.player?.name || "Harper Chalat";
  fullData.singlesMatches = fixMatchData(
    fullData.singlesMatches || [],
    playerName,
    "singles",
  );
  console.log(`Fixed ${fullData.singlesMatches.length} singles matches`);
  console.log(
    `⏱️  Data fixing took ${((Date.now() - dataFixStart) / 1000).toFixed(2)}s`,
  );
}

function generateStats(matches, type = "singles", playerName = "") {
  const stats = {
    record: { wins: 0, losses: 0, walkovers: 0, winPct: 0 },
    vsHigherRated: { wins: 0, losses: 0 },
    vsLowerRated: { wins: 0, losses: 0 },
    bagels: { given: 0, received: 0 },
    breadsticks: { given: 0, received: 0 },
    tiebreaks: { won: 0, lost: 0 },
    superTiebreaks: { won: 0, lost: 0 },
    setsRecord: { won: 0, lost: 0 },
    gamesRecord: { won: 0, lost: 0 },
    decidingSets: { won: 0, lost: 0 },
    gamesDifferential: { wonWithFewer: 0, lostWithMore: 0 },
    opponents: {},
    partners: {}, // For doubles: track partners
    teams: {}, // For doubles: track opposing teams
    longestWinStreak: 0,
    longestLossStreak: 0,
    matches: [],
    // Callouts
    nemesis: null, // Most losses against
    dominatedOpponent: null, // Most wins against
    closestRival: null, // Closest H2H with multiple matches
    mostFrequentPartner: null, // For doubles
  };

  let currentWinStreak = 0,
    currentLossStreak = 0;

  matches.forEach((m) => {
    // Skip walkovers for W/L record
    if (m.isWalkover) {
      stats.record.walkovers++;
      return; // Don't count in W/L
    }

    // Record (excluding walkovers)
    if (m.won === true) {
      stats.record.wins++;
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > stats.longestWinStreak) {
        stats.longestWinStreak = currentWinStreak;
      }
    } else if (m.won === false) {
      stats.record.losses++;
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > stats.longestLossStreak) {
        stats.longestLossStreak = currentLossStreak;
      }
    }

    // vs Higher/Lower rated
    const myUtr = m.myUtr || m.myUtrBefore || 0;
    const oppUtr = m.opponentUtr || m.opponentUtrBefore || 0;

    if (m.won === true) {
      if (oppUtr > myUtr) stats.vsHigherRated.wins++;
      else stats.vsLowerRated.wins++;
    } else if (m.won === false) {
      if (oppUtr > myUtr) stats.vsHigherRated.losses++;
      else stats.vsLowerRated.losses++;
    }

    // For doubles: parse partner and team from rawText
    let partner = null;
    let team = null;

    if (type === "doubles" && m.rawText) {
      // Format: "Harper Chalat Caleb Richard 6.19 6.28 460 Austen Blass Davis Ryan 4.71 5.94 631"
      // OR: "Joshua Graceffa Harper Chalat 6.36 6.19 631 ..." (partner can come first)

      // Extract all full names (First Last)
      const allNames = m.rawText.match(/([A-Z][a-z]+ [A-Z][a-z]+)/g) || [];

      // Find which name is the player
      const playerNameParts = playerName.split(" ");
      const playerFirstName = playerNameParts[0];
      const playerLastName = playerNameParts[playerNameParts.length - 1];

      // Find partner (the other name in the first two positions)
      if (allNames.length >= 2) {
        const firstTwo = allNames.slice(0, 2);
        const partnerName =
          firstTwo.find(
            (name) =>
              !name.includes(playerFirstName) || !name.includes(playerLastName),
          ) || firstTwo.find((name) => name !== playerName);
        if (partnerName && partnerName !== playerName) {
          partner = partnerName;
        }
      }

      // Extract opposing team (names after our scores)
      // Normalize team order (alphabetically) so "A / B" = "B / A"
      if (allNames.length >= 4) {
        const opponentNames = allNames.slice(2, 4);
        // Sort alphabetically to normalize order
        opponentNames.sort();
        team = opponentNames.join(" / ");
      }
    }

    // Track opponents/teams with game counts
    if (type === "doubles" && team) {
      // Track teams for doubles
      if (!stats.teams[team]) {
        stats.teams[team] = {
          played: 0,
          wins: 0,
          losses: 0,
          gamesWon: 0,
          gamesLost: 0,
          setsWon: 0,
          setsLost: 0,
        };
      }
      stats.teams[team].played++;
      if (m.won === true) stats.teams[team].wins++;
      else if (m.won === false) stats.teams[team].losses++;

      // Track partners for doubles
      if (partner) {
        if (!stats.partners[partner]) {
          stats.partners[partner] = {
            played: 0,
            wins: 0,
            losses: 0,
            gamesWon: 0,
            gamesLost: 0,
            setsWon: 0,
            setsLost: 0,
          };
        }
        stats.partners[partner].played++;
        if (m.won === true) stats.partners[partner].wins++;
        else if (m.won === false) stats.partners[partner].losses++;
      }
    } else if (m.opponent) {
      // Track individual opponents for singles
      if (!stats.opponents[m.opponent]) {
        stats.opponents[m.opponent] = {
          played: 0,
          wins: 0,
          losses: 0,
          gamesWon: 0,
          gamesLost: 0,
          setsWon: 0,
          setsLost: 0,
          utr: oppUtr,
          id: m.opponentId,
        };
      }
      stats.opponents[m.opponent].played++;
      if (m.won === true) stats.opponents[m.opponent].wins++;
      else if (m.won === false) stats.opponents[m.opponent].losses++;
    }

    // Set analysis
    if (m.sets && m.sets.length > 0) {
      let setsWon = 0,
        setsLost = 0;
      let matchGamesWon = 0,
        matchGamesLost = 0;
      let hasSuperTiebreak = false;

      m.sets.forEach((set, idx) => {
        // Check for super tiebreak format: "1-0(score)" or "0-1(score)"
        const superTiebreakMatch = set.match(/^([01])-([01])\((\d+)-(\d+)\)$/);
        if (superTiebreakMatch) {
          hasSuperTiebreak = true;
          const myWon = parseInt(superTiebreakMatch[1]);
          const oppWon = parseInt(superTiebreakMatch[2]);
          const myScore = parseInt(superTiebreakMatch[3]);
          const oppScore = parseInt(superTiebreakMatch[4]);

          // Count based on who won (1-0 means we won, 0-1 means we lost)
          if (myWon === 1) {
            stats.superTiebreaks.won++;
            setsWon++;
          } else {
            stats.superTiebreaks.lost++;
            setsLost++;
          }
          return; // Don't process as regular set
        }

        // Check for super tiebreak without score: "1-0" or "0-1" (no parentheses)
        if (set.match(/^[01]-[01]$/)) {
          hasSuperTiebreak = true;
          const parts = set.split("-");
          const myWon = parseInt(parts[0]);
          if (myWon === 1) {
            stats.superTiebreaks.won++;
            setsWon++;
          } else {
            stats.superTiebreaks.lost++;
            setsLost++;
          }
          return; // Don't process as regular set
        }

        // Check for regular tiebreak format: "7-6(score)" or "6-7(score)"
        const tiebreakMatch = set.match(/^([67])-([67])(?:\((\d+)-(\d+)\))?$/);
        if (tiebreakMatch) {
          const myGames = parseInt(tiebreakMatch[1]);
          const oppGames = parseInt(tiebreakMatch[2]);

          // Count tiebreak
          if (myGames === 7 && oppGames === 6) {
            stats.tiebreaks.won++;
          } else if (myGames === 6 && oppGames === 7) {
            stats.tiebreaks.lost++;
          }

          // Still count as a set and add to games (tiebreak sets count as 7-6)
          matchGamesWon += myGames;
          matchGamesLost += oppGames;
          if (myGames > oppGames) setsWon++;
          else setsLost++;
          return;
        }

        // Regular set - parse normally
        const cleanSet = set.replace(/\([^)]+\)/, ""); // Remove any parentheticals
        const parts = cleanSet.split("-");
        if (parts.length !== 2) return;

        const myGames = parseInt(parts[0]);
        const oppGames = parseInt(parts[1]);
        if (isNaN(myGames) || isNaN(oppGames)) return;

        // Check if it's actually a super tiebreak (scores >= 10)
        if (myGames >= 10 || oppGames >= 10) {
          hasSuperTiebreak = true;
          if (myGames > oppGames) {
            stats.superTiebreaks.won++;
            setsWon++;
          } else {
            stats.superTiebreaks.lost++;
            setsLost++;
          }
          return; // Don't add to game count
        }

        // Regular set - add games
        matchGamesWon += myGames;
        matchGamesLost += oppGames;

        if (myGames > oppGames) setsWon++;
        else if (oppGames > myGames) setsLost++;

        // Bagels (6-0)
        if (myGames === 6 && oppGames === 0) stats.bagels.given++;
        else if (myGames === 0 && oppGames === 6) stats.bagels.received++;
        // Breadsticks (6-1)
        else if (myGames === 6 && oppGames === 1) stats.breadsticks.given++;
        else if (myGames === 1 && oppGames === 6) stats.breadsticks.received++;
      });

      stats.setsRecord.won += setsWon;
      stats.setsRecord.lost += setsLost;
      stats.gamesRecord.won += matchGamesWon;
      stats.gamesRecord.lost += matchGamesLost;

      // Games differential: matches won with fewer games, or lost with more games
      if (m.won === true && matchGamesWon < matchGamesLost) {
        // Won the match but had fewer total games
        stats.gamesDifferential.wonWithFewer++;
      } else if (m.won === false && matchGamesWon > matchGamesLost) {
        // Lost the match but had more total games
        stats.gamesDifferential.lostWithMore++;
      }

      // Track per-opponent/team/partner games
      if (type === "doubles") {
        if (team && stats.teams[team]) {
          stats.teams[team].gamesWon += matchGamesWon;
          stats.teams[team].gamesLost += matchGamesLost;
          stats.teams[team].setsWon += setsWon;
          stats.teams[team].setsLost += setsLost;
        }
        if (partner && stats.partners[partner]) {
          stats.partners[partner].gamesWon += matchGamesWon;
          stats.partners[partner].gamesLost += matchGamesLost;
          stats.partners[partner].setsWon += setsWon;
          stats.partners[partner].setsLost += setsLost;
        }
      } else if (m.opponent && stats.opponents[m.opponent]) {
        stats.opponents[m.opponent].gamesWon += matchGamesWon;
        stats.opponents[m.opponent].gamesLost += matchGamesLost;
        stats.opponents[m.opponent].setsWon += setsWon;
        stats.opponents[m.opponent].setsLost += setsLost;
      }

      // Deciding sets: went to 3rd set (regular) or super tiebreak
      const wentToDecider = (setsWon >= 1 && setsLost >= 1) || hasSuperTiebreak;
      if (wentToDecider) {
        if (m.won === true) stats.decidingSets.won++;
        else if (m.won === false) stats.decidingSets.lost++;
      }
    }

    // Clean score: remove parentheticals from tiebreaks (7-6(3) -> 7-6)
    const cleanScore = m.sets
      ? m.sets.map((s) => s.replace(/\(\d+\)/, "")).join(" ")
      : m.isWalkover
        ? "W/O"
        : "";

    // Add cleaned match data
    stats.matches.push({
      date: m.date,
      opponent: type === "doubles" ? team : m.opponent || "Unknown",
      partner: type === "doubles" ? partner : null,
      opponentId: m.opponentId,
      opponentUtr: oppUtr,
      opponentUtrBefore: m.opponentUtrBefore,
      opponentUtrAfter: m.opponentUtrAfter,
      opponentUtrDelta: m.opponentUtrDelta,
      myUtr: myUtr,
      myUtrBefore: m.myUtrBefore,
      myUtrAfter: m.myUtrAfter,
      myUtrDelta: m.myUtrDelta,
      won: m.won,
      isWalkover: m.isWalkover || false,
      sets: m.sets || [],
      score: cleanScore,
    });
  });

  // Calculate win percentage
  const total = stats.record.wins + stats.record.losses;
  stats.record.winPct =
    total > 0 ? Math.round((stats.record.wins / total) * 100) : 0;

  // Calculate game win percentage
  const totalGames = stats.gamesRecord.won + stats.gamesRecord.lost;
  stats.gamesRecord.winPct =
    totalGames > 0 ? Math.round((stats.gamesRecord.won / totalGames) * 100) : 0;

  // Calculate callouts - different for singles vs doubles
  if (type === "doubles") {
    // For doubles: use teams instead of opponents
    const teamList = Object.entries(stats.teams).map(([name, data]) => ({
      name,
      ...data,
      winPct: data.played > 0 ? data.wins / data.played : 0,
      gameDiff: data.gamesWon - data.gamesLost,
    }));

    // Most frequent partner
    const partnerList = Object.entries(stats.partners).map(([name, data]) => ({
      name,
      ...data,
      winPct: data.played > 0 ? data.wins / data.played : 0,
    }));
    if (partnerList.length > 0) {
      partnerList.sort((a, b) => b.played - a.played);
      const mostFrequent = partnerList[0];
      stats.mostFrequentPartner = {
        name: mostFrequent.name,
        played: mostFrequent.played,
        record: `${mostFrequent.wins}-${mostFrequent.losses}`,
        gamesRecord: `${mostFrequent.gamesWon}-${mostFrequent.gamesLost}`,
      };
    }

    // Nemesis team
    // Worst net record (losses - wins), if tied prefer worse game differential
    const nemesisCandidates = teamList.filter(
      (t) => t.losses >= 1 && t.played >= 2,
    );
    if (nemesisCandidates.length > 0) {
      nemesisCandidates.sort((a, b) => {
        // First: worst net record (losses - wins, more positive = worse)
        const aNet = a.losses - a.wins;
        const bNet = b.losses - b.wins;
        if (aNet !== bNet) return bNet - aNet; // More positive is worse (descending sort)
        // Second: worse game differential (more negative = worse)
        if (a.gameDiff !== b.gameDiff) return a.gameDiff - b.gameDiff;
        // Third: more matches played
        return b.played - a.played;
      });
      const nem = nemesisCandidates[0];
      stats.nemesis = {
        name: nem.name,
        record: `${nem.wins}-${nem.losses}`,
        gamesRecord: `${nem.gamesWon}-${nem.gamesLost}`,
      };
    }

    // Dominated team
    // Best net record (wins - losses), if tied prefer better game differential
    const dominatedCandidates = teamList.filter(
      (t) => t.wins >= 1 && t.played >= 2,
    );
    if (dominatedCandidates.length > 0) {
      dominatedCandidates.sort((a, b) => {
        // First: best net record (wins - losses, more positive = better)
        const aNet = a.wins - a.losses;
        const bNet = b.wins - b.losses;
        if (aNet !== bNet) return bNet - aNet; // More positive is better
        // Second: better game differential (more positive = better)
        if (a.gameDiff !== b.gameDiff) return b.gameDiff - a.gameDiff;
        // Third: more matches played
        return b.played - a.played;
      });
      const dom = dominatedCandidates[0];
      stats.dominatedOpponent = {
        name: dom.name,
        record: `${dom.wins}-${dom.losses}`,
        gamesRecord: `${dom.gamesWon}-${dom.gamesLost}`,
      };
    }

    // Closest rival team
    // Prioritize game score over win/loss difference
    const rivalCandidates = teamList.filter((t) => t.played >= 2);
    if (rivalCandidates.length > 0) {
      rivalCandidates.sort((a, b) => {
        // First: smallest absolute game differential (most competitive games)
        const aGameDiff = Math.abs(a.gameDiff);
        const bGameDiff = Math.abs(b.gameDiff);
        if (aGameDiff !== bGameDiff) return aGameDiff - bGameDiff;
        // Second: smallest win/loss difference (most even record)
        const aDiff = Math.abs(a.wins - a.losses);
        const bDiff = Math.abs(b.wins - b.losses);
        if (aDiff !== bDiff) return aDiff - bDiff;
        // Third: more matches played
        return b.played - a.played;
      });
      const rival = rivalCandidates[0];
      stats.closestRival = {
        name: rival.name,
        record: `${rival.wins}-${rival.losses}`,
        gamesRecord: `${rival.gamesWon}-${rival.gamesLost}`,
        gameDiff:
          rival.gameDiff > 0 ? `+${rival.gameDiff}` : `${rival.gameDiff}`,
      };
    }

    // Most frequent teams
    teamList.sort((a, b) => b.played - a.played);
    stats.frequentOpponents = teamList.slice(0, 5).map((t) => ({
      name: t.name,
      played: t.played,
      record: `${t.wins}-${t.losses}`,
      gamesRecord: `${t.gamesWon}-${t.gamesLost}`,
    }));

    // Partner records
    partnerList.sort((a, b) => b.played - a.played);
    stats.partnerRecords = partnerList.slice(0, 5).map((p) => ({
      name: p.name,
      played: p.played,
      record: `${p.wins}-${p.losses}`,
      gamesRecord: `${p.gamesWon}-${p.gamesLost}`,
    }));

    // Best win and worst loss for doubles (by UTR difference)
    let bestWin = null;
    let worstLoss = null;

    matches.forEach((m) => {
      if (m.isWalkover) return;
      const myUtr = m.myUtr || m.myUtrBefore || 0;
      const oppUtr = m.opponentUtr || m.opponentUtrBefore || 0;
      const utrDiff = oppUtr - myUtr; // Positive = opponent team higher rated

      if (m.won === true) {
        if (!bestWin || utrDiff > (bestWin.utrDiff || 0)) {
          bestWin = {
            opponent: m.opponent,
            opponentUtr: oppUtr,
            myUtr: myUtr,
            utrDiff: utrDiff,
            score: m.score,
            date: m.date,
            partner: m.partner,
          };
        }
      } else if (m.won === false) {
        if (!worstLoss || utrDiff < (worstLoss.utrDiff || 0)) {
          worstLoss = {
            opponent: m.opponent,
            opponentUtr: oppUtr,
            myUtr: myUtr,
            utrDiff: utrDiff,
            score: m.score,
            date: m.date,
            partner: m.partner,
          };
        }
      }
    });

    stats.bestWin = bestWin;
    stats.worstLoss = worstLoss;
  } else {
    // For singles: use opponents
    const opponentList = Object.entries(stats.opponents).map(
      ([name, data]) => ({
        name,
        ...data,
        winPct: data.played > 0 ? data.wins / data.played : 0,
        gameDiff: data.gamesWon - data.gamesLost,
      }),
    );

    // Nemesis: opponent with worst net record (losses - wins, min 2 matches)
    // Someone you're 0-4 against beats someone you're 5-5 against
    // If tied on net record, prefer the one with worse game differential
    const nemesisCandidates = opponentList.filter(
      (o) => o.losses >= 1 && o.played >= 2,
    );
    if (nemesisCandidates.length > 0) {
      nemesisCandidates.sort((a, b) => {
        // First: worst net record (losses - wins, more positive = worse)
        const aNet = a.losses - a.wins;
        const bNet = b.losses - b.wins;
        if (aNet !== bNet) return bNet - aNet; // More positive is worse (descending sort)
        // Second: worse game differential (more negative = worse)
        if (a.gameDiff !== b.gameDiff) return a.gameDiff - b.gameDiff;
        // Third: more matches played
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

    // Dominated opponent: best net record (wins - losses, min 2 matches)
    // Someone you're 4-0 against beats someone you're 5-5 against
    // If tied on net record, prefer the one with better game differential
    const dominatedCandidates = opponentList.filter(
      (o) => o.wins >= 1 && o.played >= 2,
    );
    if (dominatedCandidates.length > 0) {
      dominatedCandidates.sort((a, b) => {
        // First: best net record (wins - losses, more positive = better)
        const aNet = a.wins - a.losses;
        const bNet = b.wins - b.losses;
        if (aNet !== bNet) return bNet - aNet; // More positive is better
        // Second: better game differential (more positive = better)
        if (a.gameDiff !== b.gameDiff) return b.gameDiff - a.gameDiff;
        // Third: more matches played
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

    // Closest rival: smallest game differential as percentage (most competitive games-wise)
    // Prioritize game score over win/loss difference
    // Use percentage to normalize for total games played
    const rivalCandidates = opponentList.filter((o) => o.played >= 2);
    if (rivalCandidates.length > 0) {
      rivalCandidates.sort((a, b) => {
        // First: smallest absolute game differential as percentage (most competitive games)
        const aTotalGames = a.gamesWon + a.gamesLost;
        const bTotalGames = b.gamesWon + b.gamesLost;
        const aGameDiffPct =
          aTotalGames > 0 ? Math.abs((a.gameDiff / aTotalGames) * 100) : 0;
        const bGameDiffPct =
          bTotalGames > 0 ? Math.abs((b.gameDiff / bTotalGames) * 100) : 0;
        if (aGameDiffPct !== bGameDiffPct) return aGameDiffPct - bGameDiffPct;
        // Second: smallest win/loss difference (most even record)
        const aDiff = Math.abs(a.wins - a.losses);
        const bDiff = Math.abs(b.wins - b.losses);
        if (aDiff !== bDiff) return aDiff - bDiff;
        // Third: more matches played
        return b.played - a.played;
      });
      const rival = rivalCandidates[0];
      stats.closestRival = {
        name: rival.name,
        record: `${rival.wins}-${rival.losses}`,
        gamesRecord: `${rival.gamesWon}-${rival.gamesLost}`,
        gameDiff:
          rival.gameDiff > 0 ? `+${rival.gameDiff}` : `${rival.gameDiff}`,
        utr: rival.utr,
      };
    }

    // Most played opponent
    opponentList.sort((a, b) => b.played - a.played);
    stats.frequentOpponents = opponentList.slice(0, 5).map((o) => ({
      name: o.name,
      played: o.played,
      record: `${o.wins}-${o.losses}`,
      gamesRecord: `${o.gamesWon}-${o.gamesLost}`,
      utr: o.utr,
    }));

    // Best win and worst loss (by UTR difference)
    let bestWin = null;
    let worstLoss = null;

    matches.forEach((m) => {
      if (m.isWalkover) return;
      const myUtr = m.myUtr || m.myUtrBefore || 0;
      const oppUtr = m.opponentUtr || m.opponentUtrBefore || 0;
      const utrDiff = oppUtr - myUtr; // Positive = opponent higher rated

      if (m.won === true) {
        // Best win = beat someone with highest UTR (largest positive diff)
        if (!bestWin || utrDiff > (bestWin.utrDiff || 0)) {
          bestWin = {
            opponent: m.opponent,
            opponentUtr: oppUtr,
            myUtr: myUtr,
            utrDiff: utrDiff,
            score: m.score,
            date: m.date,
          };
        }
      } else if (m.won === false) {
        // Worst loss = lost to someone with lowest UTR (most negative diff)
        if (!worstLoss || utrDiff < (worstLoss.utrDiff || 0)) {
          worstLoss = {
            opponent: m.opponent,
            opponentUtr: oppUtr,
            myUtr: myUtr,
            utrDiff: utrDiff,
            score: m.score,
            date: m.date,
          };
        }
      }
    });

    stats.bestWin = bestWin;
    stats.worstLoss = worstLoss;
  }

  // === NEW: TIME-BASED ANALYSIS ===
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthlyStats = {};
  stats.matches.forEach((m) => {
    if (!m.date) return;
    // Extract month from YYYY-MM-DD format
    let monthKey;
    if (/^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
      const monthNum = parseInt(m.date.substring(5, 7)) - 1; // Get month (0-11)
      monthKey = monthNames[monthNum];
    } else {
      // Fallback for other formats
      monthKey = m.date.substring(0, 3);
    }
    if (!monthlyStats[monthKey]) {
      monthlyStats[monthKey] = { wins: 0, losses: 0, month: monthKey };
    }
    if (m.won === true) monthlyStats[monthKey].wins++;
    else if (m.won === false) monthlyStats[monthKey].losses++;
  });

  // Calculate win % for each month
  const monthlyData = Object.values(monthlyStats)
    .map((m) => ({
      ...m,
      total: m.wins + m.losses,
      winPct:
        m.wins + m.losses > 0
          ? Math.round((m.wins / (m.wins + m.losses)) * 100)
          : 0,
    }))
    .filter((m) => m.total > 0);

  // Sort by win percentage
  monthlyData.sort((a, b) => b.winPct - a.winPct);

  stats.monthlyBreakdown = monthlyData;
  stats.bestMonth = monthlyData[0] || null;
  stats.worstMonth = monthlyData[monthlyData.length - 1] || null;

  // === NEW: COMEBACK STATS ===
  let comebacks = 0; // Won after losing first set
  let chokes = 0; // Lost after winning first set

  stats.matches.forEach((m) => {
    if (!m.sets || m.sets.length < 2) return;

    // Parse first set
    const firstSet = m.sets[0]
      .split("-")
      .map((s) => parseInt(s.replace(/[^0-9]/g, "")));
    if (firstSet.length !== 2 || isNaN(firstSet[0]) || isNaN(firstSet[1]))
      return;

    const wonFirstSet = firstSet[0] > firstSet[1];

    if (m.won === true && !wonFirstSet) comebacks++;
    if (m.won === false && wonFirstSet) chokes++;
  });

  stats.comebacks = {
    won: comebacks,
    lost: chokes,
    comebacker: comebacks > chokes ? "Yes! 💪" : "Room for improvement",
  };

  // === NEW: HEAD-TO-HEAD NETWORK ===
  // Build a network of "You beat X, who beat Y"
  const defeatedPlayers = new Set();
  const losses = [];

  stats.matches.forEach((m) => {
    if (m.won === true && m.opponent) {
      defeatedPlayers.add(m.opponent);
    } else if (m.won === false && m.opponent) {
      losses.push({
        opponent: m.opponent,
        oppUtr: m.opponentUtr || m.opponentUtrBefore,
      });
    }
  });

  // Find interesting connections
  const connections = [];
  losses.forEach((loss) => {
    if (defeatedPlayers.has(loss.opponent)) {
      // You also beat this opponent - mutual wins
      connections.push({
        type: "mutual",
        player: loss.opponent,
        note: `Split matches with ${loss.opponent}`,
      });
    }
  });

  // Find your best wins that beat higher-rated players
  const qualityWins = stats.matches
    .filter(
      (m) =>
        m.won === true &&
        m.opponent &&
        (m.opponentUtr || m.opponentUtrBefore) >
          (m.myUtr || m.myUtrBefore || 0),
    )
    .sort((a, b) => {
      const aDiff =
        (a.opponentUtr || a.opponentUtrBefore || 0) -
        (a.myUtr || a.myUtrBefore || 0);
      const bDiff =
        (b.opponentUtr || b.opponentUtrBefore || 0) -
        (b.myUtr || b.myUtrBefore || 0);
      return bDiff - aDiff;
    })
    .slice(0, 3)
    .map((m) => ({
      type: "upset",
      player: m.opponent,
      utrDiff: (
        (m.opponentUtr || m.opponentUtrBefore || 0) -
        (m.myUtr || m.myUtrBefore || 0)
      ).toFixed(2),
      note: `Beat ${m.opponent} (${(m.opponentUtr || m.opponentUtrBefore)?.toFixed(2)}) when you were ${(m.myUtr || m.myUtrBefore)?.toFixed(2)}`,
    }));

  stats.h2hNetwork = {
    connections: connections.slice(0, 5),
    qualityWins: qualityWins,
  };

  return stats;
}

// Generate review
const year = parseInt(TARGET_YEAR);
const history = fullData?.singlesHistory || historyData?.singlesHistory || [];

// Filter history to target year
const yearHistory = history.filter(
  (h) => h.date && h.date.startsWith(year.toString()),
);

// Get peak/min for the year
let peakUtr = { rating: 0, date: "" };
let minUtr = { rating: 99, date: "" };
let startUtr = null;
let endUtr = null;

if (yearHistory.length > 0) {
  startUtr = yearHistory[0].rating;
  endUtr = yearHistory[yearHistory.length - 1].rating;

  yearHistory.forEach((h) => {
    if (h.rating > peakUtr.rating) peakUtr = { rating: h.rating, date: h.date };
    if (h.rating < minUtr.rating) minUtr = { rating: h.rating, date: h.date };
  });
}

// Get all-time peak
let allTimePeak = { rating: 0, date: "" };
let allTimeMin = { rating: 99, date: "" };
history.forEach((h) => {
  if (h.rating > allTimePeak.rating)
    allTimePeak = { rating: h.rating, date: h.date };
  if (h.rating < allTimeMin.rating)
    allTimeMin = { rating: h.rating, date: h.date };
});

// Generate stats for target year (filter by date)
const currentYearSingles = (fullData?.singlesMatches || []).filter((m) => {
  if (!m.date) return false;
  // Check if normalized date starts with target year
  return m.date.startsWith(year.toString());
});

console.log(`Found ${currentYearSingles.length} singles matches in ${year}`);

const statsGenStart = Date.now();
console.log("⏱️  Generating statistics...");
const playerName = fullData?.player?.name || "Harper Chalat";
const singlesStats = generateStats(currentYearSingles, "singles", playerName);
console.log(
  `⏱️  Statistics generation took ${((Date.now() - statsGenStart) / 1000).toFixed(2)}s`,
);

const output = {
  year,
  generatedAt: new Date().toISOString(),
  player: {
    ...(fullData?.player || { name: "Unknown", id: PROFILE_ID }),
  },
  singles: {
    ...singlesStats,
    peakUtr,
    minUtr,
    startUtr,
    endUtr,
  },
};

// Save - use OUTPUT_DIR (for Lambda) or __dirname (for local)
// Include profile ID and year in filename to avoid conflicts
const outputDir = process.env.OUTPUT_DIR || __dirname;
const outputPath = path.join(
  outputDir,
  `${PROFILE_ID}-${TARGET_YEAR}-year-in-review.json`,
);
const fileWriteStart = Date.now();
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`✅ Wrote output to: ${outputPath}`);
console.log(
  `⏱️  File write took ${((Date.now() - fileWriteStart) / 1000).toFixed(2)}s`,
);

// Print summary
console.log("\n🎾 UTR Year in Review Generated!\n");
console.log(`Player: ${output.player.name}`);
console.log(`Year: ${year}`);

console.log(`\n📊 ${year} Singles:`);
console.log(
  `   Record: ${singlesStats.record.wins}-${singlesStats.record.losses} (${singlesStats.record.winPct}%)`,
);
console.log(
  `   Games: ${singlesStats.gamesRecord.won}-${singlesStats.gamesRecord.lost} (${singlesStats.gamesRecord.winPct}%)`,
);
console.log(
  `   Tiebreaks (7-6): ${singlesStats.tiebreaks.won}-${singlesStats.tiebreaks.lost}`,
);
console.log(
  `   Super Tiebreaks: ${singlesStats.superTiebreaks.won}-${singlesStats.superTiebreaks.lost}`,
);
if (singlesStats.dominatedOpponent) {
  console.log(
    `   🎯 Dominated: ${singlesStats.dominatedOpponent.name} (${singlesStats.dominatedOpponent.record})`,
  );
}
if (singlesStats.nemesis) {
  console.log(
    `   😤 Nemesis: ${singlesStats.nemesis.name} (${singlesStats.nemesis.record})`,
  );
}

// Output path already logged above

// Final timing
const totalTime = (Date.now() - scriptStartTime) / 1000;
console.log(`\n⏱️  ========================================`);
console.log(`⏱️  TOTAL GENERATION TIME: ${totalTime.toFixed(2)}s`);
console.log(`⏱️  ========================================\n`);
