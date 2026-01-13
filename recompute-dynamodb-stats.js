#!/usr/bin/env node
// recompute-dynamodb-stats.js
// Recomputes stats for all existing DynamoDB records with the latest logic
// This includes: super tiebreak fix and new games differential stats

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');

// Load AWS credentials from .aws file
if (fs.existsSync('.aws')) {
    const awsContent = fs.readFileSync('.aws', 'utf8');
    awsContent.split('\n').forEach(line => {
        if (line.includes('=')) {
            const [key, value] = line.split('=');
            if (key && value) {
                process.env[key.trim()] = value.trim();
            }
        }
    });
}

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'utr-year-in-review';
const REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';

const dynamoClient = new DynamoDBClient({ region: REGION });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);

// Helper function to calculate games from sets (same logic as generate-full-review.js)
function calculateGamesFromSets(sets) {
    let matchGamesWon = 0;
    let matchGamesLost = 0;
    let hasSuperTiebreak = false;
    
    sets.forEach(set => {
        // Check for super tiebreak format: "1-0(score)" or "0-1(score)"
        const superTiebreakMatch = set.match(/^([01])-([01])\((\d+)-(\d+)\)$/);
        if (superTiebreakMatch) {
            hasSuperTiebreak = true;
            return; // Don't add to game count
        }
        
        // Check for super tiebreak without score: "1-0" or "0-1" (no parentheses)
        if (set.match(/^[01]-[01]$/)) {
            hasSuperTiebreak = true;
            return; // Don't add to game count
        }
        
        // Check for regular tiebreak format: "7-6(score)" or "6-7(score)"
        const tiebreakMatch = set.match(/^([67])-([67])(?:\((\d+)-(\d+)\))?$/);
        if (tiebreakMatch) {
            const myGames = parseInt(tiebreakMatch[1]);
            const oppGames = parseInt(tiebreakMatch[2]);
            matchGamesWon += myGames;
            matchGamesLost += oppGames;
            return;
        }
        
        // Regular set - parse normally
        const cleanSet = set.replace(/\([^)]+\)/, ''); // Remove any parentheticals
        const parts = cleanSet.split('-');
        if (parts.length !== 2) return;
        
        const myGames = parseInt(parts[0]);
        const oppGames = parseInt(parts[1]);
        if (isNaN(myGames) || isNaN(oppGames)) return;
        
        // Check if it's actually a super tiebreak (scores >= 10)
        if (myGames >= 10 || oppGames >= 10) {
            hasSuperTiebreak = true;
            return; // Don't add to game count
        }
        
        // Regular set - add games
        matchGamesWon += myGames;
        matchGamesLost += oppGames;
    });
    
    return { matchGamesWon, matchGamesLost, hasSuperTiebreak };
}

// Recalculate won status from sets (same logic as generate-full-review.js)
function recalculateWonFromSets(sets) {
    if (!sets || !Array.isArray(sets) || sets.length === 0) {
        return null; // Can't determine
    }
    
    // Check if there's a super tiebreak
    const hasSuperTiebreak = sets.some(s => {
        // Check for "0-1(score)" or "1-0(score)" format WITH parentheses
        if (s.match(/^[01]-[01]\(/)) return true;
        // Check for scores >= 10 (actual super tiebreak scores)
        const parts = s.replace(/\([^)]+\)/, '').split('-');
        if (parts.length === 2) {
            const a = parseInt(parts[0]);
            const b = parseInt(parts[1]);
            if (a >= 10 || b >= 10) return true;
            // Check for "1-0" or "0-1" format (super tiebreak indicator)
            if ((a === 1 && b === 0) || (a === 0 && b === 1)) {
                // Only treat as super tiebreak if it's the 3rd set (deciding set)
                if (sets.length >= 3) return true;
            }
        }
        return false;
    });
    
    // Count sets won by comparing scores
    let mySets = 0, oppSets = 0;
    sets.forEach(set => {
        // Remove tiebreak scores in parentheses for comparison
        const cleanSet = set.replace(/\([^)]+\)/, '');
        const parts = cleanSet.split('-');
        if (parts.length === 2) {
            const a = parseInt(parts[0]);
            const b = parseInt(parts[1]);
            if (!isNaN(a) && !isNaN(b)) {
                // For super tiebreaks with format "1-0" or "0-1" (without parentheses),
                // the "1-0" means we won, "0-1" means opponent won
                if (hasSuperTiebreak && (a === 1 && b === 0)) {
                    mySets++;
                } else if (hasSuperTiebreak && (a === 0 && b === 1)) {
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
    return mySets > oppSets;
}

// Recompute stats for a single review data
function recomputeStats(reviewData) {
    if (!reviewData || !reviewData.singles) {
        return reviewData; // Return as-is if no singles data
    }
    
    const singles = reviewData.singles;
    if (!singles.matches || !Array.isArray(singles.matches)) {
        return reviewData; // Return as-is if no matches
    }
    
    // Initialize new stats
    let wonWithFewer = 0;
    let lostWithMore = 0;
    let bestWin = null;
    let worstLoss = null;
    
    // Process each match
    let matchesUpdated = 0;
    singles.matches.forEach(match => {
        // Skip walkovers
        if (match.isWalkover) return;
        
        // Recalculate won status from sets (fixes super tiebreak issues)
        let correctedWon = match.won;
        if (match.sets && Array.isArray(match.sets) && match.sets.length > 0) {
            const recalculatedWon = recalculateWonFromSets(match.sets);
            if (recalculatedWon !== null && recalculatedWon !== match.won) {
                // Update the match's won status
                match.won = recalculatedWon;
                matchesUpdated++;
            }
            correctedWon = match.won; // Use corrected value
            
            // Calculate games from sets
            const { matchGamesWon, matchGamesLost } = calculateGamesFromSets(match.sets);
            
            // Check games differential (using corrected won status)
            if (correctedWon === true && matchGamesWon < matchGamesLost) {
                // Won the match but had fewer total games
                wonWithFewer++;
            } else if (correctedWon === false && matchGamesWon > matchGamesLost) {
                // Lost the match but had more total games
                lostWithMore++;
            }
        }
        
        // Recalculate best win and worst loss based on UTR difference (using corrected won status)
        const myUtr = match.myUtr || match.myUtrBefore || 0;
        const oppUtr = match.opponentUtr || match.opponentUtrBefore || 0;
        const utrDiff = oppUtr - myUtr; // Positive = opponent higher rated
        
        if (correctedWon === true) {
            // Best win = beat someone with highest UTR (largest positive diff)
            if (!bestWin || utrDiff > (bestWin.utrDiff || 0)) {
                bestWin = {
                    opponent: match.opponent,
                    opponentUtr: oppUtr,
                    myUtr: myUtr,
                    utrDiff: utrDiff,
                    score: match.score,
                    date: match.date
                };
            }
        } else if (correctedWon === false) {
            // Worst loss = lost to someone with lowest UTR (most negative diff)
            if (!worstLoss || utrDiff < (worstLoss.utrDiff || 0)) {
                worstLoss = {
                    opponent: match.opponent,
                    opponentUtr: oppUtr,
                    myUtr: myUtr,
                    utrDiff: utrDiff,
                    score: match.score,
                    date: match.date
                };
            }
        }
    });
    
    // Update the stats
    if (!singles.gamesDifferential) {
        singles.gamesDifferential = {};
    }
    singles.gamesDifferential.wonWithFewer = wonWithFewer;
    singles.gamesDifferential.lostWithMore = lostWithMore;
    
    // Update best win and worst loss
    singles.bestWin = bestWin;
    singles.worstLoss = worstLoss;
    
    // Recalculate nemesis, dominated opponent, and closest rival
    // Build opponent list with stats
    const opponentList = Object.entries(singles.opponents || {}).map(([name, data]) => ({
        name,
        ...data,
        winPct: data.played > 0 ? (data.wins / data.played) : 0,
        gameDiff: (data.gamesWon || 0) - (data.gamesLost || 0)
    }));
    
    // Nemesis: worst net record (losses - wins)
    const nemesisCandidates = opponentList.filter(o => o.losses >= 1 && o.played >= 2);
    if (nemesisCandidates.length > 0) {
        nemesisCandidates.sort((a, b) => {
            const aNet = a.losses - a.wins;
            const bNet = b.losses - b.wins;
            if (aNet !== bNet) return bNet - aNet; // More positive is worse (descending sort)
            if (a.gameDiff !== b.gameDiff) return a.gameDiff - b.gameDiff;
            return b.played - a.played;
        });
        const nem = nemesisCandidates[0];
        singles.nemesis = {
            name: nem.name,
            record: `${nem.wins}-${nem.losses}`,
            gamesRecord: `${nem.gamesWon}-${nem.gamesLost}`,
            utr: nem.utr
        };
    } else {
        singles.nemesis = null;
    }
    
    // Dominated opponent: best net record (wins - losses)
    const dominatedCandidates = opponentList.filter(o => o.wins >= 1 && o.played >= 2);
    if (dominatedCandidates.length > 0) {
        dominatedCandidates.sort((a, b) => {
            const aNet = a.wins - a.losses;
            const bNet = b.wins - b.losses;
            if (aNet !== bNet) return bNet - aNet; // More positive is better
            if (a.gameDiff !== b.gameDiff) return b.gameDiff - a.gameDiff;
            return b.played - a.played;
        });
        const dom = dominatedCandidates[0];
        singles.dominatedOpponent = {
            name: dom.name,
            record: `${dom.wins}-${dom.losses}`,
            gamesRecord: `${dom.gamesWon}-${dom.gamesLost}`,
            utr: dom.utr
        };
    } else {
        singles.dominatedOpponent = null;
    }
    
    // Closest rival: smallest game differential as percentage (prioritize game score)
    // Use percentage to normalize for total games played
    const rivalCandidates = opponentList.filter(o => o.played >= 2);
    if (rivalCandidates.length > 0) {
        rivalCandidates.sort((a, b) => {
            // First: smallest absolute game differential as percentage (most competitive games)
            const aTotalGames = a.gamesWon + a.gamesLost;
            const bTotalGames = b.gamesWon + b.gamesLost;
            const aGameDiffPct = aTotalGames > 0 ? Math.abs((a.gameDiff / aTotalGames) * 100) : 0;
            const bGameDiffPct = bTotalGames > 0 ? Math.abs((b.gameDiff / bTotalGames) * 100) : 0;
            if (aGameDiffPct !== bGameDiffPct) return aGameDiffPct - bGameDiffPct;
            // Second: smallest win/loss difference (most even record)
            const aDiff = Math.abs(a.wins - a.losses);
            const bDiff = Math.abs(b.wins - b.losses);
            if (aDiff !== bDiff) return aDiff - bDiff;
            // Third: more matches played
            return b.played - a.played;
        });
        const rival = rivalCandidates[0];
        singles.closestRival = {
            name: rival.name,
            record: `${rival.wins}-${rival.losses}`,
            gamesRecord: `${rival.gamesWon}-${rival.gamesLost}`,
            gameDiff: rival.gameDiff > 0 ? `+${rival.gameDiff}` : `${rival.gameDiff}`,
            utr: rival.utr
        };
    } else {
        singles.closestRival = null;
    }
    
    // Log if we corrected any matches
    if (matchesUpdated > 0) {
        console.log(`      ⚠️  Corrected ${matchesUpdated} match(es) with incorrect won/lost status`);
    }
    
    return reviewData;
}

async function recomputeAllRecords() {
    console.log('🔄 Recomputing stats for all DynamoDB records...');
    console.log(`   Table: ${DYNAMODB_TABLE}`);
    console.log(`   Region: ${REGION}\n`);
    
    let allItems = [];
    let lastEvaluatedKey = undefined;
    
    // Scan all items
    do {
        const scanCommand = new ScanCommand({
            TableName: DYNAMODB_TABLE,
            ExclusiveStartKey: lastEvaluatedKey
        });
        
        const response = await dynamoDocClient.send(scanCommand);
        allItems = allItems.concat(response.Items || []);
        lastEvaluatedKey = response.LastEvaluatedKey;
        
        console.log(`   Scanned ${allItems.length} items so far...`);
    } while (lastEvaluatedKey);
    
    console.log(`\n📊 Found ${allItems.length} total items\n`);
    
    let recomputed = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const item of allItems) {
        try {
            // Only process completed items
            if (item.status !== 'completed' || !item.data) {
                console.log(`⏭️  Skipping ${item.profileId}/${item.year} - status: ${item.status || 'no status'}`);
                skipped++;
                continue;
            }
            
            console.log(`🔄 Processing ${item.profileId}/${item.year}...`);
            
            // Recompute stats (this will also correct match won/lost statuses)
            // Deep copy to avoid mutating original, and ensure we update the matches array
            const updatedData = recomputeStats(JSON.parse(JSON.stringify(item.data)));
            
            // Check if anything changed
            const oldWonWithFewer = item.data?.singles?.gamesDifferential?.wonWithFewer;
            const oldLostWithMore = item.data?.singles?.gamesDifferential?.lostWithMore;
            const oldBestWin = item.data?.singles?.bestWin;
            const oldWorstLoss = item.data?.singles?.worstLoss;
            const oldNemesis = item.data?.singles?.nemesis;
            const oldDominated = item.data?.singles?.dominatedOpponent;
            const oldClosestRival = item.data?.singles?.closestRival;
            
            const newWonWithFewer = updatedData.singles?.gamesDifferential?.wonWithFewer;
            const newLostWithMore = updatedData.singles?.gamesDifferential?.lostWithMore;
            const newBestWin = updatedData.singles?.bestWin;
            const newWorstLoss = updatedData.singles?.worstLoss;
            const newNemesis = updatedData.singles?.nemesis;
            const newDominated = updatedData.singles?.dominatedOpponent;
            const newClosestRival = updatedData.singles?.closestRival;
            
            // Compare values
            const bestWinChanged = !oldBestWin || !newBestWin || 
                oldBestWin.opponent !== newBestWin.opponent || 
                Math.abs((oldBestWin.utrDiff || 0) - (newBestWin.utrDiff || 0)) > 0.01;
            const worstLossChanged = !oldWorstLoss || !newWorstLoss || 
                oldWorstLoss.opponent !== newWorstLoss.opponent || 
                Math.abs((oldWorstLoss.utrDiff || 0) - (newWorstLoss.utrDiff || 0)) > 0.01;
            const nemesisChanged = !oldNemesis || !newNemesis || oldNemesis.name !== newNemesis.name;
            const dominatedChanged = !oldDominated || !newDominated || oldDominated.name !== newDominated.name;
            const closestRivalChanged = !oldClosestRival || !newClosestRival || oldClosestRival.name !== newClosestRival.name;
            
            const gamesDiffChanged = oldWonWithFewer !== newWonWithFewer || oldLostWithMore !== newLostWithMore;
            
            // Always update to ensure all stats are recalculated with latest logic
            const hasChanges = gamesDiffChanged || bestWinChanged || worstLossChanged || 
                              nemesisChanged || dominatedChanged || closestRivalChanged;
            
            if (!hasChanges && oldWonWithFewer !== undefined && oldLostWithMore !== undefined &&
                oldBestWin && oldWorstLoss && oldNemesis && oldDominated && oldClosestRival) {
                // Log current values for verification
                console.log(`   ✅ Stats appear up to date`);
                console.log(`      Best Win: ${oldBestWin.opponent} (+${oldBestWin.utrDiff?.toFixed(2) || '?'} UTR)`);
                console.log(`      Worst Loss: ${oldWorstLoss.opponent} (${oldWorstLoss.utrDiff?.toFixed(2) || '?'} UTR)`);
                console.log(`      Nemesis: ${oldNemesis.name} (${oldNemesis.record})`);
                console.log(`      Dominated: ${oldDominated.name} (${oldDominated.record})`);
                console.log(`      Closest Rival: ${oldClosestRival.name} (${oldClosestRival.record})`);
                console.log(`      Games Diff: ${oldWonWithFewer} won with fewer, ${oldLostWithMore} lost with more`);
                // Still update to ensure consistency
            }
            
            // Update DynamoDB
            await dynamoDocClient.send(new UpdateCommand({
                TableName: DYNAMODB_TABLE,
                Key: {
                    profileId: item.profileId,
                    year: item.year
                },
                UpdateExpression: 'SET #data = :data, #ua = :ua',
                ExpressionAttributeNames: {
                    '#data': 'data',
                    '#ua': 'updatedAt'
                },
                ExpressionAttributeValues: {
                    ':data': updatedData,
                    ':ua': new Date().toISOString()
                }
            }));
            
            const changes = [];
            if (gamesDiffChanged) {
                changes.push(`gamesDiff: ${oldWonWithFewer || 'N/A'}/${oldLostWithMore || 'N/A'} → ${newWonWithFewer}/${newLostWithMore}`);
            }
            if (bestWinChanged) {
                changes.push(`bestWin: ${oldBestWin?.opponent || 'N/A'} → ${newBestWin?.opponent || 'N/A'}`);
            }
            if (worstLossChanged) {
                changes.push(`worstLoss: ${oldWorstLoss?.opponent || 'N/A'} → ${newWorstLoss?.opponent || 'N/A'}`);
            }
            if (nemesisChanged) {
                changes.push(`nemesis: ${oldNemesis?.name || 'N/A'} → ${newNemesis?.name || 'N/A'}`);
            }
            if (dominatedChanged) {
                changes.push(`dominated: ${oldDominated?.name || 'N/A'} → ${newDominated?.name || 'N/A'}`);
            }
            if (closestRivalChanged) {
                changes.push(`closestRival: ${oldClosestRival?.name || 'N/A'} → ${newClosestRival?.name || 'N/A'}`);
            }
            if (changes.length > 0) {
                console.log(`   ✅ Updated! ${changes.join(', ')}`);
            } else {
                console.log(`   ✅ Updated (ensuring consistency)`);
            }
            recomputed++;
            
        } catch (error) {
            console.error(`   ❌ Error processing ${item.profileId}/${item.year}:`, error.message);
            errors++;
        }
    }
    
    console.log('\n📊 Recompute Summary:');
    console.log(`   ✅ Recomputed: ${recomputed}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log('\n✅ Recompute complete!');
}

recomputeAllRecords().catch(console.error);

