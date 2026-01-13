# Security & Cost Risk Analysis for utrstats.com

## 🔴 Critical Risks

### 1. **No Rate Limiting**
- **Risk**: Anyone can make unlimited requests
- **Impact**: Could trigger hundreds of Lambda invocations simultaneously
- **Cost**: Each scrape costs ~$0.015 (10 min @ 1500MB)
  - 100 requests = $1.50
  - 1000 requests = $15.00
  - 10,000 requests = $150.00
- **Mitigation Needed**: ✅ **HIGH PRIORITY**

### 2. **Shared UTR Credentials**
- **Risk**: All users share the same UTR account credentials
- **Impact**: 
  - If credentials are exposed, your UTR account could be compromised
  - Multiple simultaneous logins could trigger account lockout
  - UTR might flag the account for suspicious activity
- **Current**: Credentials stored in Lambda environment variables
- **Mitigation Needed**: ✅ **HIGH PRIORITY**

### 3. **No Request Validation**
- **Risk**: No checks for:
  - Valid profile IDs (could request millions of IDs)
  - Reasonable year ranges
  - Request frequency per IP/user
- **Impact**: Someone could spam requests for random profile IDs
- **Mitigation Needed**: ✅ **MEDIUM PRIORITY**

### 4. **DynamoDB Conditional Writes Help, But...**
- **Good**: Prevents duplicate processing for same profileId+year
- **Gap**: Doesn't prevent requests for different profileIds
- **Risk**: Someone could request 1000 different profile IDs

## 🟡 Medium Risks

### 5. **CloudFront Costs**
- **Risk**: High traffic could increase data transfer costs
- **Impact**: $0.085 per GB after first 10TB
- **Mitigation**: CloudFront caching helps, but first requests still cost

### 6. **API Gateway Costs**
- **Risk**: $3.50 per million requests (after free tier)
- **Impact**: Low for normal traffic, but could add up with abuse
- **Mitigation**: First 1M requests/month free for 12 months

### 7. **No IP Blocking**
- **Risk**: Can't block abusive IPs
- **Impact**: Malicious users can continue attacking

## 🟢 Low Risks

### 8. **DynamoDB Costs**
- **Risk**: Minimal - pay-per-request model
- **Impact**: Very low cost per request (~$0.00000025 per write)

## 💰 Cost Scenarios

### Normal Usage (Low Risk)
- 10-50 requests/day = ~$5-15/month ✅ Safe

### Moderate Abuse
- 100 requests/hour = 2,400/day = 72,000/month
- Cost: ~$1,080/month in Lambda alone ❌ **EXPENSIVE**

### Malicious Attack
- 1000 requests/minute = 1.44M/day
- Cost: Could easily exceed $10,000/month ❌ **VERY EXPENSIVE**

## 🛡️ Recommended Mitigations

### Immediate (Before Sharing)
1. **Add Rate Limiting**
   - Per IP: Max 5 requests/hour
   - Per profileId: Max 1 request/10 minutes
   - Use API Gateway throttling or custom logic

2. **Add Request Validation**
   - Validate profileId format (numbers only, reasonable length)
   - Validate year (current year ± 2 years)
   - Reject obviously invalid requests

3. **Add Cost Alerts**
   - AWS Budget alerts at $50, $100, $500
   - CloudWatch alarms for Lambda invocations

4. **Consider Authentication**
   - Simple API key or CAPTCHA
   - Or require email verification

### Short Term
5. **IP-based Rate Limiting**
   - Track requests per IP in DynamoDB
   - Block IPs exceeding limits

6. **Request Queue**
   - Limit concurrent Lambda invocations
   - Queue requests instead of immediate processing

### Long Term
7. **Separate User Credentials**
   - Each user provides their own UTR credentials
   - Don't use shared account

8. **Cost Budget Limits**
   - Set hard limits on Lambda spending
   - Auto-disable if budget exceeded

## 📊 Current Protection Level: **LOW**

**Recommendation**: Add rate limiting and cost alerts BEFORE sharing publicly.
