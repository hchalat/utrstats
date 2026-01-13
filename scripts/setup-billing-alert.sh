#!/bin/bash
# Setup AWS billing alert

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <email-address> [budget-amount]"
    echo ""
    echo "Example: $0 your@email.com 50"
    echo "   This will alert you when costs exceed $50/month"
    exit 1
fi

EMAIL=$1
BUDGET=${2:-50}  # Default to $50

# Source AWS credentials if .aws file exists
if [ -f ".aws" ]; then
    source .aws
fi

echo "💰 Setting up billing alert for $EMAIL"
echo "   Alert threshold: \$$BUDGET/month"
echo ""

# Create budget
cat > /tmp/budget.json << EOBUDGET
{
  "BudgetName": "UTR-Year-In-Review-Monthly",
  "BudgetLimit": {
    "Amount": "$BUDGET",
    "Unit": "USD"
  },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": {},
  "CalculatedSpend": {
    "ActualSpend": {
      "Amount": "0",
      "Unit": "USD"
    }
  }
}
EOBUDGET

aws budgets create-budget \
  --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget file:///tmp/budget.json \
  --notifications-with-subscribers \
    NotificationType=ACTUAL,ThresholdType=PERCENTAGE,Threshold=80,SubscriberType=EMAIL,SubscriberAddress=$EMAIL \
    NotificationType=ACTUAL,ThresholdType=PERCENTAGE,Threshold=100,SubscriberType=EMAIL,SubscriberAddress=$EMAIL \
    NotificationType=FORECASTED,ThresholdType=PERCENTAGE,Threshold=100,SubscriberType=EMAIL,SubscriberAddress=$EMAIL

echo "✅ Billing alert created!"
echo "   You'll receive emails at $EMAIL when:"
echo "   - Costs reach 80% of \$$BUDGET"
echo "   - Costs reach 100% of \$$BUDGET"
echo "   - Forecasted costs exceed \$$BUDGET"
