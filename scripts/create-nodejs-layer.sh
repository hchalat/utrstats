#!/bin/bash
# Create Lambda layer with node_modules dependencies (puppeteer-core, etc.)

set -e

# Load AWS credentials from .aws file
if [ -f .aws ]; then
    source .aws
    echo "✅ Loaded AWS credentials from .aws file"
else
    echo "⚠️  No .aws file found, using default AWS credentials"
fi

LAYER_NAME="utr-nodejs-dependencies"
REGION="us-east-1"
RUNTIME="nodejs24.x"

echo "📦 Creating Lambda layer with node_modules dependencies..."
echo "   Layer name: $LAYER_NAME"
echo "   Runtime: $RUNTIME"
echo ""

# Create temporary directory
LAYER_DIR=$(mktemp -d)
echo "   Working directory: $LAYER_DIR"

# Create layer structure (nodejs/node_modules)
mkdir -p "$LAYER_DIR/nodejs"

# Install dependencies
echo "   Installing dependencies..."
cd "$LAYER_DIR/nodejs"
npm init -y > /dev/null 2>&1
npm install puppeteer-core --production --no-save

# Check size
LAYER_SIZE=$(du -sh "$LAYER_DIR" | cut -f1)
echo "   Layer size: $LAYER_SIZE"

# Create zip file
cd "$LAYER_DIR"
LAYER_ZIP="nodejs-layer.zip"
echo "   Creating layer zip..."
zip -r "$LAYER_ZIP" nodejs/ > /dev/null 2>&1

ZIP_SIZE=$(du -h "$LAYER_ZIP" | cut -f1)
echo "   Zip size: $ZIP_SIZE"

# Check if it's too large (Lambda layer limit is 250MB unzipped, 50MB zipped)
ZIP_SIZE_BYTES=$(stat -f%z "$LAYER_ZIP" 2>/dev/null || stat -c%s "$LAYER_ZIP" 2>/dev/null)
if [ "$ZIP_SIZE_BYTES" -gt 52428800 ]; then
    echo "   ⚠️  Warning: Layer zip is larger than 50MB. This may not work."
    echo "   Consider excluding unnecessary files or using a public layer."
fi

# Publish layer
echo ""
echo "📤 Publishing Lambda layer..."
LAYER_ARN=$(aws lambda publish-layer-version \
    --layer-name "$LAYER_NAME" \
    --description "Node.js dependencies for UTR scraper (puppeteer-core)" \
    --zip-file "fileb://${LAYER_DIR}/${LAYER_ZIP}" \
    --compatible-runtimes "$RUNTIME" \
    --compatible-architectures "x86_64" \
    --region "$REGION" \
    --query 'LayerVersionArn' \
    --output text)

echo ""
echo "✅✅✅ Layer created successfully!"
echo ""
echo "Layer ARN: $LAYER_ARN"
echo ""
echo "📎 To attach it to your Lambda function, run:"
echo "   aws lambda update-function-configuration \\"
echo "     --function-name utr-year-in-review-scraper \\"
echo "     --layers arn:aws:lambda:us-east-1:686756213571:layer:chromium-sparticuz:1 $LAYER_ARN \\"
echo "     --region $REGION"
echo ""
echo "Or use the attach script:"
echo "   ./attach-nodejs-layer.sh $LAYER_ARN"

# Cleanup
rm -rf "$LAYER_DIR"


