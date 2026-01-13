#!/bin/bash
# Create @sparticuz/chromium Lambda layer
# This is a corrected version of your command for nodejs24.x

set -e

# Configuration
# Try to get bucket from .chromium-bucket file, or use provided/default
if [ -f .chromium-bucket ]; then
    DEFAULT_BUCKET=$(cat .chromium-bucket)
else
    DEFAULT_BUCKET="chromiumUploadBucket"
fi

BUCKET_NAME="${1:-$DEFAULT_BUCKET}"
ARCH_TYPE="${2:-x64}"
CHROMIUM_VERSION="v143.0.0"
LAYER_NAME="chromium-sparticuz"
REGION="us-east-1"
RUNTIME="nodejs24.x"  # Updated for your Lambda runtime

echo "🔧 Creating @sparticuz/chromium Lambda layer..."
echo "   Bucket: $BUCKET_NAME"
echo "   Architecture: $ARCH_TYPE"
echo "   Chromium version: $CHROMIUM_VERSION"
echo "   Runtime: $RUNTIME"
echo ""

# Source AWS credentials if available
if [ -f .aws ]; then
    source .aws
fi

# Convert arch type for Lambda
if [ "$ARCH_TYPE" = "x64" ]; then
    LAMBDA_ARCH="x86_64"
else
    LAMBDA_ARCH="$ARCH_TYPE"
fi

# Upload to S3
ZIP_FILE="chromium-${CHROMIUM_VERSION}-layer.${ARCH_TYPE}.zip"
S3_KEY="chromiumLayers/${ZIP_FILE}"

echo "📤 Uploading to S3..."
aws s3 cp "$ZIP_FILE" "s3://${BUCKET_NAME}/${S3_KEY}" --region "$REGION"

# Publish layer
echo "📦 Publishing Lambda layer..."
LAYER_ARN=$(aws lambda publish-layer-version \
    --layer-name "$LAYER_NAME" \
    --description "Chromium ${CHROMIUM_VERSION} for UTR scraper" \
    --content "S3Bucket=${BUCKET_NAME},S3Key=${S3_KEY}" \
    --compatible-runtimes "$RUNTIME" \
    --compatible-architectures "$LAMBDA_ARCH" \
    --region "$REGION" \
    --query 'LayerVersionArn' \
    --output text)

echo ""
echo "✅✅✅ Layer created successfully!"
echo ""
echo "Layer ARN: $LAYER_ARN"
echo ""
echo "📎 To attach it to your Lambda function, run:"
echo "   ./attach-chromium-layer.sh $LAYER_ARN"
echo ""
echo "Or manually:"
echo "   aws lambda update-function-configuration \\"
echo "     --function-name utr-year-in-review-scraper \\"
echo "     --layers $LAYER_ARN \\"
echo "     --region $REGION"

