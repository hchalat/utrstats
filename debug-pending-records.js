#!/usr/bin/env node
// debug-pending-records.js - Check for stuck pending records in DynamoDB

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || "utr-year-in-review";

// Initialize DynamoDB
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);

async function checkPendingRecords() {
  try {
    console.log("🔍 Scanning for pending records in DynamoDB...\n");

    const result = await dynamoDocClient.send(
      new ScanCommand({
        TableName: DYNAMODB_TABLE,
        FilterExpression: "#status = :pending",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":pending": "pending",
        },
      })
    );

    if (!result.Items || result.Items.length === 0) {
      console.log("✅ No pending records found!");
      return;
    }

    console.log(`Found ${result.Items.length} pending record(s):\n`);

    for (const item of result.Items) {
      const createdAt = new Date(item.createdAt);
      const age = Math.floor((Date.now() - createdAt.getTime()) / 1000 / 60); // minutes

      console.log(`📊 Profile ID: ${item.profileId}`);
      console.log(`   Year: ${item.year}`);
      console.log(`   Status: ${item.status}`);
      console.log(`   Created: ${item.createdAt} (${age} minutes ago)`);
      console.log(`   Updated: ${item.updatedAt || "N/A"}`);

      if (age > 5) {
        console.log(`   ⚠️  STUCK! This record is ${age} minutes old`);
      }
      console.log();
    }

    // Ask if user wants to clean up stuck records
    if (process.argv.includes("--clean")) {
      console.log("🧹 Cleaning up stuck pending records (older than 5 minutes)...\n");

      for (const item of result.Items) {
        const createdAt = new Date(item.createdAt);
        const age = Math.floor((Date.now() - createdAt.getTime()) / 1000 / 60);

        if (age > 5) {
          console.log(`Marking ${item.profileId} as failed...`);
          await dynamoDocClient.send(
            new UpdateCommand({
              TableName: DYNAMODB_TABLE,
              Key: {
                profileId: item.profileId,
                year: item.year,
              },
              UpdateExpression: "SET #status = :failed, #error = :errorMsg, #updatedAt = :now",
              ExpressionAttributeNames: {
                "#status": "status",
                "#error": "error",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":failed": "failed",
                ":errorMsg": "Stuck in pending state - cleaned up by debug script",
                ":now": new Date().toISOString(),
              },
            })
          );
          console.log(`  ✅ Marked as failed`);
        }
      }
    } else {
      console.log("💡 To clean up stuck records, run: node debug-pending-records.js --clean");
    }

  } catch (error) {
    console.error("❌ Error:", error);
    console.error("Make sure AWS credentials are configured");
  }
}

checkPendingRecords();
