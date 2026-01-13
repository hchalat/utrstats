#!/usr/bin/env node
// check-recent-records.js - Check recent records in DynamoDB

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || "utr-year-in-review";

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);

async function checkRecentRecords() {
  try {
    console.log("🔍 Checking recent records in DynamoDB...\n");

    const result = await dynamoDocClient.send(
      new ScanCommand({
        TableName: DYNAMODB_TABLE,
        Limit: 10,
      })
    );

    if (!result.Items || result.Items.length === 0) {
      console.log("No records found!");
      return;
    }

    // Sort by updatedAt
    const sorted = result.Items.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
    );

    console.log(`Found ${result.Items.length} recent record(s):\n`);

    for (const item of sorted.slice(0, 5)) {
      console.log(`📊 Profile ID: ${item.profileId}`);
      console.log(`   Year: ${item.year}`);
      console.log(`   Status: ${item.status}`);
      console.log(`   Created: ${item.createdAt}`);
      console.log(`   Updated: ${item.updatedAt || "N/A"}`);
      if (item.error) {
        console.log(`   Error: ${item.error}`);
      }
      if (item.data) {
        console.log(`   Has data: Yes (${JSON.stringify(item.data).length} bytes)`);
      }
      console.log();
    }

  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

checkRecentRecords();
