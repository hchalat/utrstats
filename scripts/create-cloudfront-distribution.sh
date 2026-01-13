#!/bin/bash
# Create CloudFront distribution for custom domain

set -e

BUCKET_NAME="utr-year-in-review"
DOMAIN="utrstats.com"
WWW_DOMAIN="www.utrstats.com"

echo "☁️  Creating CloudFront distribution for $DOMAIN"
echo ""

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

# Check for SSL certificate
echo "🔒 Step 1: Checking for SSL certificate..."
CERT_ARN=$(aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?Status=='ISSUED' && (DomainName=='$DOMAIN' || DomainName=='$WWW_DOMAIN' || contains(SubjectAlternativeNameList, '$DOMAIN') || contains(SubjectAlternativeNameList, '$WWW_DOMAIN'))].CertificateArn" --output text | head -1)

if [ -z "$CERT_ARN" ]; then
    echo "⚠️  No SSL certificate found!"
    echo ""
    echo "📝 You need to request a certificate first:"
    echo "   aws acm request-certificate \\"
    echo "     --domain-name $DOMAIN \\"
    echo "     --subject-alternative-names $WWW_DOMAIN \\"
    echo "     --validation-method DNS \\"
    echo "     --region us-east-1"
    echo ""
    echo "   Then validate it via DNS records in Route53"
    echo ""
    read -p "Do you want to request a certificate now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        CERT_ARN=$(aws acm request-certificate \
          --domain-name $DOMAIN \
          --subject-alternative-names $WWW_DOMAIN \
          --validation-method DNS \
          --region us-east-1 \
          --query 'CertificateArn' --output text)
        echo "✅ Certificate requested: $CERT_ARN"
        echo "⚠️  You need to validate it via DNS before using it!"
    else
        echo "❌ Cannot proceed without certificate"
        exit 1
    fi
else
    echo "✅ Found certificate: $CERT_ARN"
fi

# Create CloudFront distribution config
echo ""
echo "☁️  Step 2: Creating CloudFront distribution..."

cat > /tmp/cloudfront-config.json << EOCF
{
  "CallerReference": "$(date +%s)",
  "Comment": "$BUCKET_NAME - Custom domain",
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "S3-$BUCKET_NAME",
        "DomainName": "$BUCKET_NAME.s3-website-us-east-1.amazonaws.com",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "http-only",
          "OriginSslProtocols": {
            "Quantity": 1,
            "Items": ["TLSv1.2"]
          }
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "S3-$BUCKET_NAME",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      "CachedMethods": {
        "Quantity": 2,
        "Items": ["GET", "HEAD"]
      }
    },
    "Compress": true,
    "ForwardedValues": {
      "QueryString": true,
      "Cookies": {
        "Forward": "all"
      }
    },
    "MinTTL": 0,
    "DefaultTTL": 86400,
    "MaxTTL": 31536000
  },
  "Aliases": {
    "Quantity": 2,
    "Items": ["$DOMAIN", "$WWW_DOMAIN"]
  },
  "ViewerCertificate": {
    "ACMCertificateArn": "$CERT_ARN",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "Enabled": true
}
EOCF

DIST_ID=$(aws cloudfront create-distribution \
  --distribution-config file:///tmp/cloudfront-config.json \
  --query 'Distribution.Id' --output text)

echo "✅ CloudFront distribution created: $DIST_ID"
echo "   Domain: $(aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.DomainName' --output text)"
echo ""
echo "⏳ Distribution is deploying (this takes 10-15 minutes)"
echo "   You can check status with: aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.Status'"
echo ""
echo "📝 Next: Create Route53 A record pointing to this distribution"
