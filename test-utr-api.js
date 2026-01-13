// test-utr-api.js - Test UTR API access
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROFILE_ID = process.argv[2] || "904826";

// Load credentials
const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.json'), 'utf8'));

async function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'http:' ? http : https;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function testUTRApi() {
  console.log('\n🔬 Testing UTR API Access\n');

  try {
    // Step 1: Login
    console.log('1️⃣ Logging in...');
    const loginData = JSON.stringify({
      email: credentials.email || credentials.username,
      password: credentials.password
    });

    const loginResponse = await makeRequest({
      hostname: 'app.universaltennis.com',
      port: 443,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(loginData)
      }
    }, loginData);

    console.log(`   ✅ Login successful! Status: ${loginResponse.statusCode}`);

    // Extract cookies
    const cookies = loginResponse.headers['set-cookie']?.join('; ') || '';
    console.log(`   🍪 Got cookies: ${cookies.substring(0, 100)}...`);

    // Step 2: Get player profile
    console.log('\n2️⃣ Fetching player profile...');
    const profileResponse = await makeRequest({
      hostname: 'api.universaltennis.com',
      port: 443,
      path: `/v1/player/${PROFILE_ID}`,
      method: 'GET',
      headers: {
        'Cookie': cookies,
        'Accept': 'application/json'
      }
    });

    console.log(`   ✅ Profile fetched! Status: ${profileResponse.statusCode}`);
    console.log(`   Player: ${profileResponse.body.firstName} ${profileResponse.body.lastName}`);
    console.log(`   Singles UTR: ${profileResponse.body.singlesUtr}`);
    console.log(`   Doubles UTR: ${profileResponse.body.doublesUtr}`);

    // Step 3: Get match results
    console.log('\n3️⃣ Fetching match results...');
    const resultsResponse = await makeRequest({
      hostname: 'api.universaltennis.com',
      port: 443,
      path: `/v1/player/${PROFILE_ID}/results`,
      method: 'GET',
      headers: {
        'Cookie': cookies,
        'Accept': 'application/json'
      }
    });

    console.log(`   ✅ Results fetched! Status: ${resultsResponse.statusCode}`);
    console.log(`   Total results: ${resultsResponse.body.length || 'Unknown'}`);

    if (resultsResponse.body.length > 0) {
      const firstMatch = resultsResponse.body[0];
      console.log(`\n   Sample match:`);
      console.log(`   - Date: ${firstMatch.date || firstMatch.eventDate}`);
      console.log(`   - Opponent: ${firstMatch.opponent1DisplayName}`);
      console.log(`   - Score: ${firstMatch.score}`);
      console.log(`   - Won: ${firstMatch.winner === 'player1'}`);
    }

    // Save full response for analysis
    fs.writeFileSync('/tmp/utr-api-profile.json', JSON.stringify(profileResponse.body, null, 2));
    fs.writeFileSync('/tmp/utr-api-results.json', JSON.stringify(resultsResponse.body, null, 2));
    console.log('\n💾 Saved responses to /tmp/utr-api-*.json');

    console.log('\n🎉 SUCCESS! UTR API is accessible!');
    console.log('\n⚡ This could replace Puppeteer scraping entirely!');
    console.log('   - No browser launch needed');
    console.log('   - Direct JSON responses');
    console.log('   - Much faster (< 5 seconds estimate)');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

testUTRApi();
