#!/bin/bash
# Add DynamoDB permissions to Lambda role

set -e

ROLE_NAME="utr-year-in-review-scraper-role-nj68sgvb"
TABLE_NAME="utr-year-in-review"
ACCOUNT_ID="686756213571"
REGION="us-east-1"

echo "📊 Adding DynamoDB permissions to role: $ROLE_NAME"
echo "   Table: $TABLE_NAME"
echo ""

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

# Create a policy document for DynamoDB access
cat > /tmp/dynamodb-policy.json << EOP
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}/index/*"
      ]
    }
  ]
}
EOP

# Attach the policy to the role
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "DynamoDBAccess" \
  --policy-document file:///tmp/dynamodb-policy.json

echo "✅ DynamoDB permissions added!"
echo ""
echo "📋 Permissions granted:"
echo "   • GetItem - Read items"
echo "   • PutItem - Create/update items"
echo "   • UpdateItem - Update items"
echo "   • Query - Query by partition key"
echo "   • Scan - Scan table (for checkCachedFiles)"
echo ""
echo "🌐 Lambda can now access DynamoDB table: $TABLE_NAME"
