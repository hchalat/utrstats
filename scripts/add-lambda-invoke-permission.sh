#!/bin/bash
# Add permission for Lambda to invoke itself

set -e

ROLE_NAME="utr-year-in-review-scraper-role-nj68sgvb"
FUNCTION_NAME="utr-year-in-review-scraper"
ACCOUNT_ID="686756213571"
REGION="us-east-1"

echo "Adding lambda:InvokeFunction permission to role: $ROLE_NAME"

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

# Create a policy document
cat > /tmp/lambda-invoke-policy.json << EOP
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
    }
  ]
}
EOP

# Attach the policy to the role
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "LambdaInvokeSelf" \
  --policy-document file:///tmp/lambda-invoke-policy.json

echo "✅ Permission added!"
echo ""
echo "Policy attached. The Lambda can now invoke itself."
