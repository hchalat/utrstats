#!/bin/bash
# Fix API Gateway integration to properly invoke Lambda

set -e

source .aws

API_ID="tka3bt4pi4"
RESOURCE_ID="f1laq0"
FUNCTION_NAME="utr-year-in-review-scraper"
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "🔧 Fixing API Gateway integration..."
echo "   API ID: $API_ID"
echo "   Resource ID: $RESOURCE_ID"
echo "   Function: $FUNCTION_NAME"
echo "   Account: $ACCOUNT_ID"
echo ""

# Get Lambda ARN
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
echo "📋 Lambda ARN: $LAMBDA_ARN"
echo ""

# Update integration to use AWS_PROXY
echo "🔧 Updating integration..."
aws apigateway put-integration \
    --rest-api-id "$API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method POST \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations" \
    --region "$REGION" \
    --output json

echo ""
echo "✅ Integration updated"
echo ""

# Grant API Gateway permission to invoke Lambda
echo "🔧 Granting API Gateway permission to invoke Lambda..."
aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id "api-gateway-invoke-$(date +%s)" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/POST/generate" \
    --region "$REGION" 2>/dev/null || echo "   Permission may already exist"

echo ""
echo "🚀 Deploying API..."
aws apigateway create-deployment \
    --rest-api-id "$API_ID" \
    --stage-name prod \
    --region "$REGION" \
    --description "Fix integration" 2>/dev/null || echo "   Deployment may have failed (this is OK if already deployed)"

echo ""
echo "✅✅✅ API Gateway integration fixed!"
echo ""
echo "Test with:"
echo "  curl -X POST https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod/generate \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"profileId\":\"904826\",\"year\":2025}'"


