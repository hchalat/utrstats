#!/bin/bash
# Invalidate CloudFront cache for utrstats.com

set -e

DIST_ID="E3SM6OQ8MCL5C2"
DOMAIN="utrstats.com"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "🔄 Invalidating CloudFront cache"
echo "   Distribution: $DIST_ID"
echo "   Domain: $DOMAIN"
echo ""

# Create invalidation for all paths
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id $DIST_ID \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text)

echo "✅ Cache invalidation created!"
echo "   Invalidation ID: $INVALIDATION_ID"
echo ""
echo "⏳ Cache invalidation in progress..."
echo "   This typically takes 1-5 minutes"
echo ""
echo "💡 Check status with:"
echo "   aws cloudfront get-invalidation --distribution-id $DIST_ID --id $INVALIDATION_ID"
