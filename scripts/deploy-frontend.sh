#!/bin/bash
# Deploy the static frontend (index.html + lib/stats.js) to S3 and invalidate
# CloudFront so utrstats.com serves the new version.

set -e

# Load AWS credentials from .aws file if present.
if [ -f .aws ]; then
    source .aws
    echo "✅ Loaded AWS credentials from .aws file"
else
    echo "⚠️  No .aws file found, using default AWS credentials"
fi

BUCKET="utr-year-in-review"
DIST_ID="E3SM6OQ8MCL5C2"
REGION="us-east-1"

echo "📤 Uploading frontend to s3://${BUCKET}/ ..."

# index.html — no-cache so new deploys are picked up immediately (CloudFront
# still caches at the edge; the invalidation below clears it).
aws s3 cp index.html "s3://${BUCKET}/index.html" \
    --region "$REGION" \
    --content-type "text/html" \
    --cache-control "no-cache"

# lib/stats.js — the browser loads this via <script src="lib/stats.js">.
aws s3 cp lib/stats.js "s3://${BUCKET}/lib/stats.js" \
    --region "$REGION" \
    --content-type "application/javascript" \
    --cache-control "no-cache"

echo "✅ Uploaded index.html and lib/stats.js"
echo ""
echo "🔄 Invalidating CloudFront distribution ${DIST_ID}..."
INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$DIST_ID" \
    --paths "/index.html" "/lib/stats.js" "/" \
    --query 'Invalidation.Id' \
    --output text)

echo "✅ Invalidation created: ${INVALIDATION_ID}"
echo ""
echo "⏳ Edge caches clear in ~1-5 minutes."
echo "💡 Status: aws cloudfront get-invalidation --distribution-id ${DIST_ID} --id ${INVALIDATION_ID}"
