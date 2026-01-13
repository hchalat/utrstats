#!/usr/bin/env node
// Migrate existing S3 JSON files to DynamoDB

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

// Load AWS credentials if .aws file exists
// The .aws file is a bash script with export statements
if (fs.existsSync('.aws')) {
    const awsContent = fs.readFileSync('.aws', 'utf8');
    awsContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        // Handle both export KEY=value and KEY=value formats
        if (trimmed && !trimmed.startsWith('#') && (trimmed.startsWith('export ') || trimmed.includes('='))) {
            let key, value;
            if (trimmed.startsWith('export ')) {
                const rest = trimmed.substring(7).trim();
                const match = rest.match(/^([A-Z_]+)=["']?([^"']*)["']?$/);
                if (match) {
                    key = match[1];
                    value = match[2];
                }
            } else {
                const match = trimmed.match(/^([A-Z_]+)=["']?([^"']*)["']?$/);
                if (match) {
                    key = match[1];
                    value = match[2];
                }
            }
            if (key && value !== undefined) {
                process.env[key] = value;
            }
        }
    });
    console.log('✅ Loaded AWS credentials from .aws file');
}

const S3_BUCKET = process.env.S3_BUCKET || 'utr-year-in-review';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'utr-year-in-review';
const REGION = process.env.AWS_REGION || 'us-east-1';

const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient);

async function migrateS3ToDynamoDB() {
    console.log('🔄 Migrating S3 JSON files to DynamoDB');
    console.log(`   S3 Bucket: ${S3_BUCKET}`);
    console.log(`   DynamoDB Table: ${DYNAMODB_TABLE}`);
    console.log('');

    try {
        // List all objects in S3 with pattern: profileId-year-year-in-review.json
        const listResponse = await s3Client.send(new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: ''
        }));

        const jsonFiles = (listResponse.Contents || [])
            .filter(obj => obj.Key.match(/^(\d+)-(\d{4})-year-in-review\.json$/))
            .map(obj => {
                const match = obj.Key.match(/^(\d+)-(\d{4})-year-in-review\.json$/);
                return {
                    key: obj.Key,
                    profileId: match[1],
                    year: parseInt(match[2]),
                    lastModified: obj.LastModified
                };
            });

        console.log(`Found ${jsonFiles.length} JSON files to migrate`);
        console.log('');

        if (jsonFiles.length === 0) {
            console.log('✅ No files to migrate');
            return;
        }

        let migrated = 0;
        let skipped = 0;
        let errors = 0;

        for (const file of jsonFiles) {
            try {
                console.log(`Processing: ${file.key} (profileId: ${file.profileId}, year: ${file.year})`);

                // Check if already exists in DynamoDB
                const { GetCommand } = require('@aws-sdk/lib-dynamodb');
                const existing = await dynamoDocClient.send(new GetCommand({
                    TableName: DYNAMODB_TABLE,
                    Key: {
                        profileId: file.profileId,
                        year: file.year
                    }
                }));

                if (existing.Item && existing.Item.status === 'completed') {
                    console.log(`  ⏭️  Already exists in DynamoDB, skipping`);
                    skipped++;
                    continue;
                }

                // Download from S3
                const getResponse = await s3Client.send(new GetObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: file.key
                }));

                const chunks = [];
                for await (const chunk of getResponse.Body) {
                    chunks.push(chunk);
                }
                const jsonData = JSON.parse(Buffer.concat(chunks).toString('utf8'));

                // Save to DynamoDB
                await dynamoDocClient.send(new PutCommand({
                    TableName: DYNAMODB_TABLE,
                    Item: {
                        profileId: file.profileId,
                        year: file.year,
                        status: 'completed',
                        data: jsonData,
                        createdAt: file.lastModified.toISOString(),
                        updatedAt: new Date().toISOString()
                    }
                }));

                console.log(`  ✅ Migrated successfully`);
                migrated++;
            } catch (error) {
                console.error(`  ❌ Error migrating ${file.key}:`, error.message);
                errors++;
            }
        }

        console.log('');
        console.log('📊 Migration Summary:');
        console.log(`   ✅ Migrated: ${migrated}`);
        console.log(`   ⏭️  Skipped: ${skipped}`);
        console.log(`   ❌ Errors: ${errors}`);
        console.log('');
        console.log('✅ Migration complete!');
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

migrateS3ToDynamoDB();
