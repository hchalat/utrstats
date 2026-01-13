#!/usr/bin/env node
// Check what's actually in DynamoDB for debugging

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
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

async function checkItem(profileId) {
    console.log(`\n🔍 Checking DynamoDB for profileId: ${profileId}`);
    console.log(`   Table: ${DYNAMODB_TABLE}`);
    console.log(`   Year: 2025 (hardcoded)\n`);
    
    // Check with year 2025
    try {
        const response = await dynamoDocClient.send(new GetCommand({
            TableName: DYNAMODB_TABLE,
            Key: {
                profileId: profileId,
                year: 2025
            }
        }));
        
        if (response.Item) {
            console.log('✅ Found item with year=2025:');
            console.log(`   Status: ${response.Item.status}`);
            console.log(`   Has data: ${!!response.Item.data}`);
            console.log(`   Created: ${response.Item.createdAt}`);
            console.log(`   Updated: ${response.Item.updatedAt}`);
            if (response.Item.data) {
                console.log(`   Data keys: ${Object.keys(response.Item.data).join(', ')}`);
            }
        } else {
            console.log('❌ No item found with year=2025');
            console.log('\n🔍 Scanning for any items with this profileId...');
            
            // Scan for any items with this profileId
            const scanResponse = await dynamoDocClient.send(new ScanCommand({
                TableName: DYNAMODB_TABLE,
                FilterExpression: 'profileId = :pid',
                ExpressionAttributeValues: {
                    ':pid': profileId
                }
            }));
            
            if (scanResponse.Items && scanResponse.Items.length > 0) {
                console.log(`\n📋 Found ${scanResponse.Items.length} item(s) with this profileId:`);
                scanResponse.Items.forEach((item, idx) => {
                    console.log(`\n   Item ${idx + 1}:`);
                    console.log(`     Year: ${item.year} (type: ${typeof item.year})`);
                    console.log(`     Status: ${item.status}`);
                    console.log(`     Has data: ${!!item.data}`);
                });
                console.log('\n💡 Issue: Data exists but with different year value!');
            } else {
                console.log('❌ No items found with this profileId at all');
            }
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

const profileId = process.argv[2];
if (!profileId) {
    console.log('Usage: node check-dynamodb-item.js <profileId>');
    process.exit(1);
}

checkItem(profileId).catch(console.error);
