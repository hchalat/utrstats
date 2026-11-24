#!/bin/bash
# Deploy Lambda function (optimized - only code files, no node_modules)

set -e

# Load AWS credentials from .aws file
if [ -f .aws ]; then
    source .aws
    echo "✅ Loaded AWS credentials from .aws file"
else
    echo "⚠️  No .aws file found, using default AWS credentials"
fi

FUNCTION_NAME="utr-year-in-review-scraper"
ZIP_FILE="lambda-deployment-optimized.zip"

echo "📦 Creating optimized Lambda deployment package..."
echo "   (Code files only - node_modules should be in Lambda layer)"

# Remove old zip if exists
rm -f "$ZIP_FILE"

# Copy auth state file if it exists (for saved login cookies)
if [ -f "cache/auth-state.json" ]; then
  cp cache/auth-state.json auth-state-lambda.json
  echo "✅ Copied auth-state.json for Lambda deployment"
fi

# Create zip with ONLY code files (no node_modules).
# lib/ holds the shared parser + stats modules that scraper-full.js and
# generate-full-review.js require — the function breaks without it.
zip -r "$ZIP_FILE" \
    lambda-handler-v2.js \
    generate-full-review.js \
    scraper-full.js \
    scraper-http.js \
    lib/ \
    -x "*.git*" "*.DS_Store" "*.md" "*.sh" "*.png" "cache/*" \
    2>/dev/null

# Verify lib/ made it into the package (guards against silent breakage).
if ! unzip -l "$ZIP_FILE" | grep -q "lib/stats.js"; then
    echo "❌ lib/ missing from package — aborting (function would break)"
    exit 1
fi
echo "✅ Verified lib/ is included in package"

# The HTTP scraper is optional at runtime (the browser scraper covers for
# it), so a missing copy would only show up as slower refreshes — check here.
if ! unzip -l "$ZIP_FILE" | grep -q "scraper-http.js" || ! unzip -l "$ZIP_FILE" | grep -q "lib/utr-api.js"; then
    echo "❌ scraper-http.js or lib/utr-api.js missing from package — aborting"
    exit 1
fi
echo "✅ Verified the HTTP scraper is included in package"

# Add optional files if they exist
[ -f "parse-complete.js" ] && zip "$ZIP_FILE" parse-complete.js 2>/dev/null
[ -f "parse-history.js" ] && zip "$ZIP_FILE" parse-history.js 2>/dev/null
[ -f "parse-utr.js" ] && zip "$ZIP_FILE" parse-utr.js 2>/dev/null
[ -f "export-csv.js" ] && zip "$ZIP_FILE" export-csv.js 2>/dev/null
[ -f "check-cached-files.js" ] && zip "$ZIP_FILE" check-cached-files.js 2>/dev/null
[ -f "auth-state-lambda.json" ] && zip "$ZIP_FILE" auth-state-lambda.json 2>/dev/null && echo "✅ Added auth-state-lambda.json to deployment"

# Check if zip was created
if [ ! -f "$ZIP_FILE" ]; then
    echo "❌ Failed to create zip file"
    exit 1
fi

ZIP_SIZE=$(du -h "$ZIP_FILE" | cut -f1)
echo "✅ Created deployment package: $ZIP_FILE ($ZIP_SIZE)"
echo ""

echo "📤 Uploading to Lambda..."
aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" \
    --region us-east-1

if [ $? -eq 0 ]; then
    echo ""
    echo "✅✅✅ Lambda function deployed successfully!"
    echo ""
    echo "📋 Function: $FUNCTION_NAME"
    echo "📦 Package size: $ZIP_SIZE (optimized - code only)"
    echo ""
    echo "💡 Note: Make sure node_modules are in a Lambda layer"
else
    echo ""
    echo "❌ Failed to deploy Lambda function"
    exit 1
fi

# Clean up
rm -f "$ZIP_FILE"
