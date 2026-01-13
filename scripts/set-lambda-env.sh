#!/bin/bash
# Set Lambda environment variables from .aws file

# Load AWS credentials from .aws file
if [ -f .aws ]; then
    source .aws
    echo "✅ Loaded AWS credentials from .aws file"
else
    echo "⚠️  No .aws file found, using default AWS credentials"
fi

# Lambda function name
FUNCTION_NAME="${1:-utr-year-in-review-scraper}"

# Read UTR credentials
echo "Enter your UTR email:"
read -r UTR_EMAIL

echo "Enter your UTR password:"
read -s UTR_PASSWORD
echo ""

# S3 bucket name
S3_BUCKET="${2:-utr-year-in-review}"
# DynamoDB table name
DYNAMODB_TABLE="${3:-utr-year-in-review}"

echo "Setting environment variables for Lambda function: $FUNCTION_NAME"
echo ""

# Update Lambda function configuration
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --environment "Variables={
    CHROMIUM_PATH=/opt/chrome,
    UTR_EMAIL=$UTR_EMAIL,
    UTR_PASSWORD=$UTR_PASSWORD,
    S3_BUCKET=$S3_BUCKET,
    DYNAMODB_TABLE=$DYNAMODB_TABLE
  }" \
  --region us-east-1

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Environment variables set successfully!"
    echo ""
    echo "⚠️  Security Note: Consider using AWS Secrets Manager for password storage"
    echo "   See: https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html"
else
    echo ""
    echo "❌ Failed to set environment variables"
    exit 1
fi

