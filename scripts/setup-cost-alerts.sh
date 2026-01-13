#!/bin/bash
# Set up AWS cost budget alerts

set -e

# Load AWS credentials from .aws file
if [ -f .aws ]; then
    source .aws
    echo "✅ Loaded AWS credentials from .aws file"
else
    echo "⚠️  No .aws file found, using default AWS credentials"
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "💰 Setting up cost budget alerts"
echo "   Account: $ACCOUNT_ID"
echo ""

# Get email address (you'll need to provide this)
echo "Enter your email address for budget alerts:"
read -r EMAIL_ADDRESS

if [ -z "$EMAIL_ADDRESS" ]; then
    echo "❌ Email address is required"
    exit 1
fi

# Create budgets for different thresholds
for AMOUNT in 50 100 250 500; do
    BUDGET_NAME="UTR-Year-In-Review-\$${AMOUNT}"
    
    echo ""
    echo "📊 Creating budget: \$$AMOUNT/month"
    
    # Create budget JSON
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
    "Service": ["Amazon Lambda", "Amazon CloudFront", "Amazon API Gateway", "Amazon DynamoDB"]
  }
}
EOBUDGET

    # Check if budget exists
    EXISTING=$(aws budgets describe-budgets \
        --account-id "$ACCOUNT_ID" \
        --query "Budgets[?BudgetName=='${BUDGET_NAME}'].BudgetName" \
        --output text 2>/dev/null || echo "")
    
    if [ -z "$EXISTING" ]; then
        # Create budget
        aws budgets create-budget \
            --account-id "$ACCOUNT_ID" \
            --budget file:///tmp/budget-${AMOUNT}.json \
            --notifications-with-subscribers \
                NotificationType=ACTUAL,ThresholdType=PERCENTAGE,Threshold=80,SubscriberType=EMAIL,SubscriberAddress="$EMAIL_ADDRESS" \
                NotificationType=ACTUAL,ThresholdType=PERCENTAGE,Threshold=100,SubscriberType=EMAIL,SubscriberAddress="$EMAIL_ADDRESS" \
                NotificationType=FORECASTED,ThresholdType=PERCENTAGE,Threshold=100,SubscriberType=EMAIL,SubscriberAddress="$EMAIL_ADDRESS" \
            2>/dev/null || {
                echo "  ⚠️  Note: Budget creation may require additional permissions"
                echo "     You can create budgets manually in AWS Console → Billing → Budgets"
            }
        
        if [ $? -eq 0 ]; then
            echo "  ✅ Budget \$$AMOUNT created with email notifications"
        else
            echo "  ⚠️  Budget creation failed - you may need to set up budgets manually"
        fi
    else
        echo "  ⏭️  Budget \$$AMOUNT already exists"
    fi
    
    rm -f /tmp/budget-${AMOUNT}.json
done

echo ""
echo "✅ Cost alerts configured!"
echo ""
echo "📧 Email notifications will be sent to: $EMAIL_ADDRESS"
echo ""
echo "💡 Note: If budgets weren't created automatically, you can:"
echo "   1. Go to AWS Console → Billing → Budgets"
echo "   2. Create budgets manually"
echo "   3. Add email notifications"
