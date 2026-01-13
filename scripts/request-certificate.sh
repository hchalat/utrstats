#!/bin/bash
# Request SSL certificate for utrstats.com

set -e

DOMAIN="utrstats.com"
WWW_DOMAIN="www.utrstats.com"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "🔒 Requesting SSL certificate for $DOMAIN and $WWW_DOMAIN"
echo "   Region: us-east-1 (required for CloudFront)"
echo ""

CERT_ARN=$(aws acm request-certificate \
  --domain-name $DOMAIN \
  --subject-alternative-names $WWW_DOMAIN \
  --validation-method DNS \
  --region us-east-1 \
  --query 'CertificateArn' --output text)

echo "✅ Certificate requested!"
echo "   ARN: $CERT_ARN"
echo ""
echo "📋 Validation records needed:"
echo ""

VALIDATION=$(aws acm describe-certificate \
  --certificate-arn $CERT_ARN \
  --region us-east-1 \
  --query 'Certificate.DomainValidationOptions' --output json)

echo "$VALIDATION" | jq -r '.[] | "Domain: \(.DomainName)\nType: CNAME\nName: \(.ResourceRecord.Name)\nValue: \(.ResourceRecord.Value)\n"'

echo ""
echo "📝 Next steps:"
echo "   1. Add the CNAME records above to your Route53 hosted zone"
echo "   2. Wait for validation (usually 5-10 minutes)"
echo "   3. Check status: aws acm describe-certificate --certificate-arn $CERT_ARN --region us-east-1 --query 'Certificate.Status'"
echo ""
echo "💡 To auto-create validation records in Route53, run:"
echo "   ./validate-certificate.sh $CERT_ARN"
