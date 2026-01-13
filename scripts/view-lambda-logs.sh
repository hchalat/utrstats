#!/bin/bash
# View Lambda logs easily
# Usage: ./view-lambda-logs.sh [minutes] [follow]

source .aws

MINUTES=${1:-10}
FOLLOW=${2:-false}

FUNCTION_NAME="utr-year-in-review-scraper"
LOG_GROUP="/aws/lambda/$FUNCTION_NAME"
REGION="us-east-1"

echo "📋 Viewing logs for: $FUNCTION_NAME"
echo "   Last $MINUTES minutes"
echo ""

if [ "$FOLLOW" = "true" ] || [ "$FOLLOW" = "follow" ]; then
    echo "🔄 Following logs (Ctrl+C to stop)..."
    aws logs tail "$LOG_GROUP" --follow --region "$REGION" --format short
else
    aws logs tail "$LOG_GROUP" --since ${MINUTES}m --region "$REGION" --format short
fi


