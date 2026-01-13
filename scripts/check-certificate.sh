#!/bin/bash
# Check SSL certificate status

set -e

DOMAIN="utrstats.com"
WWW_DOMAIN="www.utrstats.com"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "🔒 Checking SSL certificates for $DOMAIN..."
echo ""

# Check certificates in us-east-1 (required for CloudFront)
echo "📋 Certificates in us-east-1:"
aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?contains(DomainName, '$DOMAIN') || contains(SubjectAlternativeNameList, '$DOMAIN')].{Domain:DomainName,Status:Status,ARN:CertificateArn}" --output table

echo ""
echo "📋 All certificates in us-east-1:"
aws acm list-certificates --region us-east-1 --output table

echo ""
echo "💡 If no certificate exists, you need to:"
echo "   1. Request a certificate"
echo "   2. Validate it via DNS"
echo "   3. Wait for status to be 'ISSUED'"
echo ""
echo "Run: ./request-certificate.sh"
