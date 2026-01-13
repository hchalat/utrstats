#!/bin/bash
# Enable CORS for API Gateway REST API

source .aws

API_ID="tka3bt4pi4"
REGION="us-east-1"
RESOURCE_PATH="/generate"

echo "🔧 Enabling CORS for API Gateway REST API: $API_ID"
echo ""

# Get the resource ID for /generate
RESOURCE_ID=$(aws apigateway get-resources --rest-api-id $API_ID --region $REGION \
  --query "items[?path=='${RESOURCE_PATH}'].id" --output text)

if [ -z "$RESOURCE_ID" ]; then
  echo "❌ Resource $RESOURCE_PATH not found. Available resources:"
  aws apigateway get-resources --rest-api-id $API_ID --region $REGION \
    --query 'items[*].{Path:path,Id:id}' --output table
  exit 1
fi

echo "✅ Found resource: $RESOURCE_ID"
echo ""

# Check if OPTIONS method exists
OPTIONS_EXISTS=$(aws apigateway get-method --rest-api-id $API_ID --resource-id $RESOURCE_ID \
  --http-method OPTIONS --region $REGION 2>/dev/null && echo "yes" || echo "no")

if [ "$OPTIONS_EXISTS" = "no" ]; then
  echo "📝 Creating OPTIONS method..."
  
  # Create OPTIONS method
  aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --authorization-type NONE \
    --region $REGION \
    --no-api-key-required
  
  # Set up mock integration
  aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --type MOCK \
    --integration-http-method OPTIONS \
    --request-templates '{"application/json":"{\"statusCode\": 200}"}' \
    --region $REGION
  
  # Set method response headers
  aws apigateway put-method-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":true,"method.response.header.Access-Control-Allow-Methods":true,"method.response.header.Access-Control-Allow-Origin":true}' \
    --region $REGION
  
  # Set integration response
  aws apigateway put-integration-response \
    --rest-api-id $API_ID \
    --resource-id $RESOURCE_ID \
    --http-method OPTIONS \
    --status-code 200 \
    --response-parameters '{"method.response.header.Access-Control-Allow-Headers":"'\''Content-Type'\''","method.response.header.Access-Control-Allow-Methods":"'\''GET,POST,OPTIONS'\''","method.response.header.Access-Control-Allow-Origin":"'\''*'\''"}' \
    --region $REGION
  
  echo "✅ OPTIONS method created"
else
  echo "✅ OPTIONS method already exists"
fi

echo ""
echo "📝 Adding CORS headers to POST method response..."

# Add CORS headers to POST method response (if not already there)
aws apigateway put-method-response \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method POST \
  --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Origin":true,"method.response.header.Access-Control-Allow-Headers":true,"method.response.header.Access-Control-Allow-Methods":true}' \
  --region $REGION 2>/dev/null || echo "⚠️  POST method response may already be configured"

# Add CORS headers to POST integration response
aws apigateway put-integration-response \
  --rest-api-id $API_ID \
  --resource-id $RESOURCE_ID \
  --http-method POST \
  --status-code 200 \
  --response-parameters '{"method.response.header.Access-Control-Allow-Origin":"'\''*'\''","method.response.header.Access-Control-Allow-Headers":"'\''Content-Type'\''","method.response.header.Access-Control-Allow-Methods":"'\''GET,POST,OPTIONS'\''"}' \
  --region $REGION 2>/dev/null || echo "⚠️  POST integration response may already be configured"

echo ""
echo "🚀 Deploying API..."

# Get or create deployment
STAGE_NAME="prod"
aws apigateway create-deployment \
  --rest-api-id $API_ID \
  --stage-name $STAGE_NAME \
  --region $REGION \
  --description "Enable CORS" 2>/dev/null || \
aws apigateway update-deployment \
  --rest-api-id $API_ID \
  --deployment-id $(aws apigateway get-deployments --rest-api-id $API_ID --region $REGION --query 'items[0].id' --output text) \
  --region $REGION

echo ""
echo "✅✅✅ CORS enabled!"
echo ""
echo "Test with:"
echo "  curl -X OPTIONS https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}${RESOURCE_PATH} \\"
echo "    -H 'Origin: https://utr-year-in-review.s3-website-us-east-1.amazonaws.com' \\"
echo "    -H 'Access-Control-Request-Method: POST' \\"
echo "    -v"


