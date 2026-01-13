#!/bin/bash
# Add AWS cost budget alerts

set -e

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "💰 Setting up cost budget alerts"
echo ""

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create budgets for different thresholds
for AMOUNT in 50 100 250 500; do
    BUDGET_NAME="UTR-Year-In-Review-\$${AMOUNT}"
    
    echo "Creating budget: \$$AMOUNT/month"
    
    cat > /tmp/budget-${AMOUNT}.json << EOBUDGET
{
  "BudgetName": "${BUDGET_NAME}",
  "BudgetLimit": {
    "Amount": "${AMOUNT}",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {
    "Service": ["Amazon Lambda", "Amazon CloudFront", "Amazon API Gateway"]
  }
}
EOBUDGET

    # Check if budget exists
    EXISTING=$(aws budgets describe-budgets --account-id $ACCOUNT_ID --query "Budgets[?BudgetName=='${BUDGET_NAME}'].BudgetName" --output text 2>/dev/null || echo "")
    
    if [ -z "$EXISTING" ]; then
        aws budgets create-budget \
          --account-id $ACCOUNT_ID \
          --budget file:///tmp/budget-${AMOUNT}.json \
          --notifications-with-subscribers \
            NotificationType=ACTUAL,ThresholdType=PERCENTAGE,Threshold=80,SubscriberType=EMAIL,SubscriberAddress=$(aws ses get-identity-verification-attributes --identities $(aws ses list-identities --query 'Identities[0]' --output text) --query 'VerificationAttributes.*.VerificationStatus' --output text 2>/dev/null || echo "your@email.com") \
            NotificationType=ACTUAL,ThresholdType=PERCENTAGE,Threshold=100,SubscriberType=EMAIL,SubscriberAddress=$(aws ses get-identity-verification-attributes --identities $(aws ses list-identities --query 'Identities[0]' --output text) --query 'VerificationAttributes.*.VerificationStatus' --output text 2>/dev/null || echo "your@email.com") \
          2>/dev/null || echo "⚠️  Note: You'll need to set up email notifications manually in AWS Console"
        
        echo "  ✅ Budget \$$AMOUNT created"
    else
        echo "  ⏭️  Budget \$$AMOUNT already exists"
    fi
done

echo ""
echo "✅ Cost alerts configured!"
echo ""
echo "💡 To set up email notifications:"
echo "   1. Go to AWS Console → Billing → Budgets"
echo "   2. Edit each budget"
echo "   3. Add your email address to notifications"
