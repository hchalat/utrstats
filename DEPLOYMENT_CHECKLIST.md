# Security Improvements Deployment Checklist

## ✅ Completed

1. **Rate Limiting Infrastructure**
   - ✅ Created DynamoDB table: `utr-rate-limits`
   - ✅ Added IAM permissions for rate limit table
   - ✅ Added rate limiting functions to Lambda handler

2. **Request Validation**
   - ✅ Profile ID format validation (numeric only)
   - ✅ Profile ID length validation (4-10 digits)
   - ✅ Year range validation (2000 to current year + 1)

3. **Rate Limiting Logic**
   - ✅ IP-based rate limiting: 5 requests/hour
   - ✅ Profile-based rate limiting: 3 requests/day
   - ✅ Automatic expiration via DynamoDB TTL

## ⏳ Manual Steps Required

### 1. Set Lambda Environment Variable
The `RATE_LIMIT_TABLE` environment variable needs to be added manually:

**Option A: AWS Console**
1. Go to AWS Lambda Console
2. Select function: `utr-year-in-review-scraper`
3. Configuration → Environment variables
4. Add: `RATE_LIMIT_TABLE` = `utr-rate-limits`

**Option B: AWS CLI**
```bash
aws lambda update-function-configuration \
  --function-name utr-year-in-review-scraper \
  --environment "Variables={CHROMIUM_PATH=/opt/chrome,S3_BUCKET=utr-year-in-review,DYNAMODB_TABLE=utr-year-in-review,UTR_EMAIL=your@email.com,UTR_PASSWORD=yourpassword,RATE_LIMIT_TABLE=utr-rate-limits}"
```

### 2. Deploy Updated Lambda Function
```bash
# Zip the Lambda function
zip -r lambda-deployment.zip lambda-handler-v2.js generate-full-review.js scraper-full.js parse-*.js export-csv.js check-cached-files.js node_modules/ -x "*.git*" "*.DS_Store"

# Update Lambda function
aws lambda update-function-code \
  --function-name utr-year-in-review-scraper \
  --zip-file fileb://lambda-deployment.zip
```

### 3. Set Up Cost Alerts
Run the cost alert setup script:
```bash
./setup-cost-alerts.sh
```

Or manually create budgets in AWS Console:
- AWS Console → Billing → Budgets
- Create budgets at $50, $100, $250, $500 thresholds
- Add email notifications

## 🛡️ Security Features Now Active

Once deployed, your site will have:

1. **Rate Limiting**
   - Max 5 requests per hour per IP address
   - Max 3 requests per day per profile ID
   - Automatic blocking of excessive requests

2. **Request Validation**
   - Profile IDs must be 4-10 digits
   - Years must be between 2000 and current year + 1
   - Invalid requests rejected immediately

3. **Cost Protection**
   - Budget alerts at multiple thresholds
   - Early warning system for unexpected costs

## 📊 Expected Behavior

### Normal User
- Can make up to 5 requests per hour
- Can request up to 3 different profiles per day
- Gets clear error messages if limits exceeded

### Abusive User
- Blocked after 5 requests in an hour
- Blocked after 3 profile requests in a day
- Cannot spam the system

## 💰 Cost Impact

**Before**: Unlimited requests = potential $1000s/month
**After**: Rate limited = ~$15-50/month for normal traffic

**Protection**: Even if someone tries to abuse, they're limited to:
- 5 requests/hour = 120 requests/day = ~$1.80/day = ~$54/month max per IP
