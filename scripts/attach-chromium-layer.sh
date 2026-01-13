#!/bin/bash
# Script to attach @sparticuz/chromium layer to Lambda function
# Usage: ./attach-chromium-layer.sh <layer-arn>

set -e

REGION="us-east-1"
FUNCTION_NAME="utr-year-in-review-scraper"

if [ -z "$1" ]; then
    echo "Usage: $0 <layer-arn>"
    echo ""
    echo "Example:"
    echo "  $0 arn:aws:lambda:us-east-1:123456789012:layer:chromium:1"
    echo ""
    echo "Or create a new layer first, then attach it."
    exit 1
fi

LAYER_ARN="$1"

echo "🔧 Attaching layer to Lambda function..."
echo "   Function: $FUNCTION_NAME"
echo "   Layer: $LAYER_ARN"
echo ""

# Source AWS credentials
if [ -f .aws ]; then
    source .aws
fi

# Get current layers
echo "📋 Getting current layers..."
CURRENT_LAYERS=$(aws lambda get-function \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --query 'Configuration.Layers[*].Arn' \
    --output text 2>/dev/null || echo "")

# Remove old chrome-aws-lambda layer if present
NEW_LAYERS=""
REMOVED_OLD=false

for layer in $CURRENT_LAYERS; do
    if [[ "$layer" == *"chrome-aws-lambda"* ]]; then
        echo "   ⚠️  Removing old chrome-aws-lambda layer: $layer"
        REMOVED_OLD=true
    else
        NEW_LAYERS="$NEW_LAYERS $layer"
    fi
done

# Add new layer
NEW_LAYERS="$NEW_LAYERS $LAYER_ARN"
NEW_LAYERS=$(echo $NEW_LAYERS | xargs)  # Trim whitespace

echo "   📎 Attaching new layer..."
aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --layers $NEW_LAYERS \
    --region "$REGION" > /dev/null

echo ""
echo "✅✅✅ Layer attached successfully!"
echo ""
echo "Current layers:"
for layer in $NEW_LAYERS; do
    echo "  - $layer"
done
echo ""
echo "🧪 Test your Lambda function to verify it works!"


