#!/bin/bash
# Setup script for @sparticuz/chromium Lambda layer
# This script helps you create and attach the @sparticuz/chromium layer

set -e

REGION="us-east-1"
FUNCTION_NAME="utr-year-in-review-scraper"
LAYER_NAME="chromium-sparticuz"

echo "🔧 Setting up @sparticuz/chromium Lambda layer..."
echo ""

# Check if we're using the official layer or creating our own
echo "Option 1: Use official @sparticuz/chromium layer (if available)"
echo "  Check: https://github.com/Sparticuz/chromium#lambda-layers"
echo ""
echo "Option 2: Create your own layer"
echo ""

read -p "Do you want to create your own layer? (y/n): " create_layer

if [ "$create_layer" = "y" ]; then
    echo ""
    echo "📦 Creating @sparticuz/chromium layer..."
    
    # Create temporary directory
    LAYER_DIR=$(mktemp -d)
    echo "   Working directory: $LAYER_DIR"
    
    # Create layer structure
    mkdir -p "$LAYER_DIR/nodejs"
    
    # Install @sparticuz/chromium
    echo "   Installing @sparticuz/chromium..."
    cd "$LAYER_DIR/nodejs"
    npm init -y > /dev/null 2>&1
    npm install @sparticuz/chromium --production --no-save
    
    # Create zip file
    cd "$LAYER_DIR"
    LAYER_ZIP="chromium-layer.zip"
    echo "   Creating layer zip..."
    zip -r "$LAYER_ZIP" nodejs/ > /dev/null 2>&1
    
    # Get layer size
    LAYER_SIZE=$(du -h "$LAYER_ZIP" | cut -f1)
    echo "   Layer size: $LAYER_SIZE"
    
    # Check if it's too large (Lambda layer limit is 250MB unzipped, 50MB zipped)
    ZIP_SIZE=$(stat -f%z "$LAYER_ZIP" 2>/dev/null || stat -c%s "$LAYER_ZIP" 2>/dev/null)
    if [ "$ZIP_SIZE" -gt 52428800 ]; then
        echo "   ⚠️  Warning: Layer zip is larger than 50MB. This may not work."
        echo "   Consider using a public layer or excluding Chromium binaries."
    fi
    
    # Upload to S3 (if bucket is provided)
    read -p "   Upload to S3? (provide bucket name, or press Enter to skip): " bucket_name
    if [ -n "$bucket_name" ]; then
        S3_KEY="chromium-layers/${LAYER_NAME}-$(date +%s).zip"
        echo "   Uploading to s3://${bucket_name}/${S3_KEY}..."
        source ~/UTR-year-inreview-vibe/.aws 2>/dev/null || true
        aws s3 cp "$LAYER_ZIP" "s3://${bucket_name}/${S3_KEY}" --region "$REGION"
        
        echo "   Publishing layer from S3..."
        LAYER_ARN=$(aws lambda publish-layer-version \
            --layer-name "$LAYER_NAME" \
            --description "@sparticuz/chromium for UTR scraper" \
            --content "S3Bucket=${bucket_name},S3Key=${S3_KEY}" \
            --compatible-runtimes "nodejs24.x" \
            --compatible-architectures "x86_64" \
            --region "$REGION" \
            --query 'LayerVersionArn' \
            --output text)
    else
        echo "   Publishing layer from local file..."
        LAYER_ARN=$(aws lambda publish-layer-version \
            --layer-name "$LAYER_NAME" \
            --description "@sparticuz/chromium for UTR scraper" \
            --zip-file "fileb://${LAYER_DIR}/${LAYER_ZIP}" \
            --compatible-runtimes "nodejs24.x" \
            --compatible-architectures "x86_64" \
            --region "$REGION" \
            --query 'LayerVersionArn' \
            --output text)
    fi
    
    echo ""
    echo "✅ Layer created: $LAYER_ARN"
    echo ""
    echo "📎 Attaching layer to Lambda function..."
    source ~/UTR-year-inreview-vibe/.aws 2>/dev/null || true
    
    # Get current layers
    CURRENT_LAYERS=$(aws lambda get-function \
        --function-name "$FUNCTION_NAME" \
        --region "$REGION" \
        --query 'Configuration.Layers[*].Arn' \
        --output text)
    
    # Remove old chrome-aws-lambda layer if present
    NEW_LAYERS=""
    for layer in $CURRENT_LAYERS; do
        if [[ ! "$layer" == *"chrome-aws-lambda"* ]]; then
            NEW_LAYERS="$NEW_LAYERS $layer"
        fi
    done
    
    # Add new layer
    NEW_LAYERS="$NEW_LAYERS $LAYER_ARN"
    NEW_LAYERS=$(echo $NEW_LAYERS | xargs)  # Trim whitespace
    
    aws lambda update-function-configuration \
        --function-name "$FUNCTION_NAME" \
        --layers $NEW_LAYERS \
        --region "$REGION" > /dev/null
    
    echo "✅ Layer attached to Lambda function!"
    echo ""
    echo "🧹 Cleaning up..."
    rm -rf "$LAYER_DIR"
    
    echo ""
    echo "✅✅✅ Setup complete!"
    echo ""
    echo "Your Lambda function now has the @sparticuz/chromium layer attached."
    echo "Test it to make sure it works!"
else
    echo ""
    echo "To use an official layer, check:"
    echo "  https://github.com/Sparticuz/chromium#lambda-layers"
    echo ""
    echo "Then attach it using:"
    echo "  aws lambda update-function-configuration \\"
    echo "    --function-name $FUNCTION_NAME \\"
    echo "    --layers <LAYER_ARN> \\"
    echo "    --region $REGION"
fi


