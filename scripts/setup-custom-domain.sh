#!/bin/bash
# Setup custom domain utrstats.com for S3 website

set -e

BUCKET_NAME="utr-year-in-review"
DOMAIN="utrstats.com"
WWW_DOMAIN="www.utrstats.com"

echo "🌐 Setting up custom domain: $DOMAIN"
echo ""

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

# 1. Enable S3 static website hosting if not already enabled
echo "📦 Step 1: Enabling S3 static website hosting..."
aws s3 website s3://$BUCKET_NAME/ \
  --index-document index.html \
  --error-document index.html 2>&1 | grep -v "already" || echo "✅ Website hosting already enabled"

# 2. Get the website endpoint
WEBSITE_ENDPOINT=$(aws s3api get-bucket-website --bucket $BUCKET_NAME --query 'WebsiteConfiguration.IndexDocument.Suffix' --output text 2>/dev/null || echo "index.html")
echo "✅ Website endpoint configured"

# 3. Check for existing CloudFront distribution
echo ""
echo "☁️  Step 2: Checking for CloudFront distribution..."
DIST_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$BUCKET_NAME' || contains(Aliases.Items, '$DOMAIN') || contains(Aliases.Items, '$WWW_DOMAIN')].Id" --output text | head -1)

if [ -z "$DIST_ID" ]; then
    echo "⚠️  No CloudFront distribution found. Creating one..."
    echo ""
    echo "📝 You'll need to:"
    echo "   1. Create a CloudFront distribution pointing to: $BUCKET_NAME.s3-website-us-east-1.amazonaws.com"
    echo "   2. Request an SSL certificate in ACM (us-east-1) for: $DOMAIN and $WWW_DOMAIN"
    echo "   3. Add the certificate to CloudFront"
    echo "   4. Add $DOMAIN and $WWW_DOMAIN as alternate domain names (CNAMEs)"
    echo "   5. Create Route53 A record (alias) pointing to CloudFront"
    echo ""
    echo "💡 Or run: ./create-cloudfront-distribution.sh"
else
    echo "✅ Found CloudFront distribution: $DIST_ID"
    DIST_DOMAIN=$(aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.DomainName' --output text)
    echo "   Domain: $DIST_DOMAIN"
fi

# 4. Check Route53 hosted zone
echo ""
echo "🌍 Step 3: Checking Route53 for $DOMAIN..."
ZONE_ID=$(aws route53 list-hosted-zones --query "HostedZones[?Name=='$DOMAIN.' || Name=='$DOMAIN'].Id" --output text | head -1 | sed 's|/hostedzone/||')

if [ -z "$ZONE_ID" ]; then
    echo "⚠️  No hosted zone found for $DOMAIN"
    echo "   You may need to create one or transfer your domain to Route53"
else
    echo "✅ Found hosted zone: $ZONE_ID"
    
    # Check for existing A record
    RECORD=$(aws route53 list-resource-record-sets --hosted-zone-id $ZONE_ID --query "ResourceRecordSets[?Name=='$DOMAIN.' || Name=='$DOMAIN'].{Name:Name,Type:Type,Alias:AliasTarget.DNSName}" --output json 2>/dev/null)
    
    if [ -z "$RECORD" ] || [ "$RECORD" == "[]" ]; then
        echo "⚠️  No A record found for $DOMAIN"
        if [ ! -z "$DIST_ID" ]; then
            echo ""
            echo "📝 To create the A record, run:"
            echo "   ./create-route53-record.sh $ZONE_ID $DIST_ID"
        fi
    else
        echo "✅ A record exists"
        echo "$RECORD" | jq -r '.[] | "   \(.Name) -> \(.Alias // .Type)"'
    fi
fi

echo ""
echo "✅ Setup check complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Ensure SSL certificate exists in ACM (us-east-1) for $DOMAIN"
echo "   2. Create/update CloudFront distribution with certificate"
echo "   3. Create Route53 A record pointing to CloudFront"
