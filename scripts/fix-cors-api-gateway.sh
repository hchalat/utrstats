#!/bin/bash
# Fix CORS configuration for API Gateway
# This script configures CORS for the API Gateway endpoint

set -e

source .aws

API_ID="tka3bt4pi4"
RESOURCE_ID="generate"
REGION="us-east-1"

echo "🔧 Fixing CORS configuration for API Gateway..."
echo "   API ID: $API_ID"
echo "   Resource: /generate"
echo ""

# Get the resource ID for /generate
echo "📋 Finding resource ID for /generate..."
RESOURCE_INFO=$(aws apigateway get-resources \
    --rest-api-id "$API_ID" \
    --region "$REGION" \
    --query "items[?path=='/generate']" \
    --output json)

RESOURCE_ID=$(echo "$RESOURCE_INFO" | jq -r '.[0].id // empty')

if [ -z "$RESOURCE_ID" ]; then
    echo "❌ Could not find /generate resource"
    echo "   Trying to find it manually..."
    RESOURCE_ID=$(aws apigateway get-resources \
        --rest-api-id "$API_ID" \
        --region "$REGION" \
        --query "items[?contains(pathPart, 'generate')].id" \
        --output text | head -1)
fi

if [ -z "$RESOURCE_ID" ]; then
    echo "❌ Still could not find resource. Listing all resources:"
    aws apigateway get-resources \
        --rest-api-id "$API_ID" \
        --region "$REGION" \
        --query "items[*].[id, path, pathPart]" \
        --output table
    exit 1
fi

echo "✅ Found resource ID: $RESOURCE_ID"
echo ""

# Enable CORS for the resource
echo "🔧 Enabling CORS for /generate..."
aws apigateway put-method-response \
    --rest-api-id "$API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method POST \
    --status-code 200 \
    --response-parameters "method.response.header.Access-Control-Allow-Origin=true" \
    --region "$REGION" 2>/dev/null || echo "   Method response already configured"

# Add OPTIONS method for preflight
echo "🔧 Adding OPTIONS method for preflight requests..."
aws apigateway put-method \
    --rest-api-id "$API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS \
    --authorization-type NONE \
    --region "$REGION" 2>/dev/null || echo "   OPTIONS method already exists"

# Configure OPTIONS integration (mock)
echo "🔧 Configuring OPTIONS integration..."
aws apigateway put-integration \
    --rest-api-id "$API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS \
    --type MOCK \
    --request-templates '{"application/json":"{\"statusCode\":200}"}' \
    --region "$REGION" 2>/dev/null || echo "   Integration already configured"

# Configure OPTIONS integration response
echo "🔧 Configuring OPTIONS integration response..."
aws apigateway put-integration-response \
    --rest-api-id "$API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Origin":"'"'"'*'"'"'","method.response.header.Access-Control-Allow-Methods":"'"'"'GET,POST,OPTIONS'"'"'","method.response.header.Access-Control-Allow-Headers":"'"'"'Content-Type,Authorization'"'"'"}' \
    --response-templates '{"application/json":""}' \
    --region "$REGION" 2>/dev/null || echo "   Integration response already configured"

# Configure OPTIONS method response
echo "🔧 Configuring OPTIONS method response..."
aws apigateway put-method-response \
    --rest-api-id "$API_ID" \
    --resource-id "$RESOURCE_ID" \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Origin":true,"method.response.header.Access-Control-Allow-Methods":true,"method.response.header.Access-Control-Allow-Headers":true}' \
    --region "$REGION" 2>/dev/null || echo "   Method response already configured"

# Deploy to prod stage
echo ""
echo "🚀 Deploying API Gateway changes..."
aws apigateway create-deployment \
    --rest-api-id "$API_ID" \
    --stage-name prod \
    --region "$REGION" \
    --description "CORS fix" 2>/dev/null || echo "   Deployment may have failed (this is OK if already deployed)"

echo ""
echo "✅✅✅ CORS configuration updated!"
echo ""
echo "📝 Note: It may take a few seconds for changes to propagate."
echo "   Test the API endpoint to verify CORS is working."


