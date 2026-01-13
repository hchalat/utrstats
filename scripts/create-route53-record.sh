#!/bin/bash
# Create Route53 A record for CloudFront distribution

set -e

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <hosted-zone-id> <cloudfront-distribution-id>"
    echo ""
    echo "Example: $0 Z1234567890ABC E1234567890ABC"
    exit 1
fi

ZONE_ID=$1
DIST_ID=$2
DOMAIN="utrstats.com"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

# Get CloudFront domain name
DIST_DOMAIN=$(aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.DomainName' --output text)
DIST_HOSTED_ZONE=$(aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.DomainName' --output text | sed 's/\.cloudfront\.net$//')

echo "🌍 Creating Route53 A record for $DOMAIN"
echo "   Pointing to CloudFront: $DIST_DOMAIN"
echo ""

# Create A record (alias) pointing to CloudFront
cat > /tmp/route53-change.json << EOR53
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$DOMAIN",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "$DIST_DOMAIN",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "www.$DOMAIN",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "$DIST_DOMAIN",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
EOR53

CHANGE_ID=$(aws route53 change-resource-record-sets \
  --hosted-zone-id $ZONE_ID \
  --change-batch file:///tmp/route53-change.json \
  --query 'ChangeInfo.Id' --output text | sed 's|/change/||')

echo "✅ Route53 records created/updated"
echo "   Change ID: $CHANGE_ID"
echo ""
echo "⏳ DNS propagation may take a few minutes"
echo "   Check status: aws route53 get-change --id $CHANGE_ID"
