#!/bin/bash
# Create DynamoDB table for storing year-in-review data

set -e

TABLE_NAME="utr-year-in-review"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "📊 Creating DynamoDB table: $TABLE_NAME"
echo ""

# Check if table already exists
if aws dynamodb describe-table --table-name $TABLE_NAME 2>/dev/null; then
    echo "⚠️  Table already exists!"
    echo "   To recreate, delete it first:"
    echo "   aws dynamodb delete-table --table-name $TABLE_NAME"
    exit 1
fi

# Create table
aws dynamodb create-table \
  --table-name $TABLE_NAME \
  --attribute-definitions \
    AttributeName=profileId,AttributeType=S \
    AttributeName=year,AttributeType=N \
  --key-schema \
    AttributeName=profileId,KeyType=HASH \
    AttributeName=year,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --tags Key=Project,Value=UTR-Year-In-Review

echo ""
echo "⏳ Waiting for table to be active..."
aws dynamodb wait table-exists --table-name $TABLE_NAME

echo ""
echo "✅ Table created successfully!"
echo ""
echo "📋 Table structure:"
echo "   Primary Key:"
echo "     - profileId (String) - Partition key"
echo "     - year (Number) - Sort key"
echo ""
echo "📝 Additional attributes:"
echo "   - status: 'pending' | 'completed' | 'failed'"
echo "   - data: JSON object (the review data)"
echo "   - createdAt: ISO timestamp"
echo "   - updatedAt: ISO timestamp"
echo "   - error: Error message (if failed)"
