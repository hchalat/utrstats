#!/bin/bash
# Auto-validate SSL certificate by creating DNS records in Route53

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <certificate-arn>"
    echo ""
    echo "Example: $0 arn:aws:acm:us-east-1:123456789012:certificate/abc123..."
    exit 1
fi

CERT_ARN=$1
DOMAIN="utrstats.com"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "🔒 Validating certificate: $CERT_ARN"
echo ""

# Get validation records
VALIDATION=$(aws acm describe-certificate \
  --certificate-arn $CERT_ARN \
  --region us-east-1 \
  --query 'Certificate.DomainValidationOptions' --output json)

# Get hosted zone ID
ZONE_ID=$(aws route53 list-hosted-zones --query "HostedZones[?Name=='$DOMAIN.'].Id" --output text | head -1 | sed 's|/hostedzone/||')

if [ -z "$ZONE_ID" ]; then
    echo "❌ No Route53 hosted zone found for $DOMAIN"
    echo "   Please create one or provide the zone ID manually"
    exit 1
fi

echo "✅ Found hosted zone: $ZONE_ID"
echo ""

# Create validation records
echo "$VALIDATION" | jq -c '.[]' | while read -r record; do
    DOMAIN_NAME=$(echo "$record" | jq -r '.DomainName')
    RECORD_NAME=$(echo "$record" | jq -r '.ResourceRecord.Name')
    RECORD_VALUE=$(echo "$record" | jq -r '.ResourceRecord.Value')
    
    echo "📝 Creating validation record for $DOMAIN_NAME..."
    echo "   Name: $RECORD_NAME"
    echo "   Value: $RECORD_VALUE"
    
    cat > /tmp/validation-record.json << EOREC
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$RECORD_NAME",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [
          {
            "Value": "$RECORD_VALUE"
          }
        ]
      }
    }
  ]
}
EOREC
    
    CHANGE_ID=$(aws route53 change-resource-record-sets \
      --hosted-zone-id $ZONE_ID \
      --change-batch file:///tmp/validation-record.json \
      --query 'ChangeInfo.Id' --output text | sed 's|/change/||')
    
    echo "   ✅ Created (Change ID: $CHANGE_ID)"
    echo ""
done

echo "✅ Validation records created!"
echo ""
echo "⏳ Waiting for certificate validation (this may take 5-10 minutes)..."
echo "   Checking status every 30 seconds..."
echo ""

while true; do
    STATUS=$(aws acm describe-certificate \
      --certificate-arn $CERT_ARN \
      --region us-east-1 \
      --query 'Certificate.Status' --output text)
    
    echo "   Status: $STATUS"
    
    if [ "$STATUS" == "ISSUED" ]; then
        echo ""
        echo "✅ Certificate validated and issued!"
        echo "   You can now use it in CloudFront: $CERT_ARN"
        break
    elif [ "$STATUS" == "VALIDATION_TIMED_OUT" ] || [ "$STATUS" == "FAILED" ]; then
        echo ""
        echo "❌ Certificate validation failed or timed out"
        exit 1
    fi
    
    sleep 30
done
