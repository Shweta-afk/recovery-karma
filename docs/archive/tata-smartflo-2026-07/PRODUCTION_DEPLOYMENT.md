# Production Deployment (Task 3.4)

## Overview
This guide walks through deploying Tata Tele SmartFlo integration to production with real API credentials and live call handling.

**⚠️ WARNING:** This is production. Test thoroughly in staging first. Mistakes can impact live customer calls.

## Prerequisites
- ✅ All staging tests passed (see `STAGING_TEST_SETUP.md` and `QA_CHECKLIST_TATA_INTEGRATION.md`)
- ✅ Production Tata credentials obtained from account manager
- ✅ Production webhook URL domain reserved (e.g., `recovery-karma.onrender.com`)
- ✅ Team approval to proceed with production deployment

## Phase 1: Get Production Credentials

### Step 1.1: Contact Tata Tele
Email your Tata account manager:

```
Subject: Production API Credentials for RecoveryAI

Dear Tata Tele,

We are ready to move from sandbox to production. Please provide:

1. Production API endpoint (should be same as sandbox: api-smartflo.tatateleservices.com/v1)
2. Production Permanent Access Token (valid indefinitely, no refresh token needed)
3. Test agent phone numbers for production testing (e.g., 050XXXXXXX0)
4. Production webhook configuration (if different from sandbox)

Our webhook will be: POST https://recovery-karma.onrender.com/api/telephony/webhook

Please confirm these credentials and any IP whitelisting requirements.

Best regards,
[Team]
```

### Step 1.2: Receive & Validate Credentials
Once Tata responds:
- [ ] Receive `TATA_PRODUCTION_ACCESS_TOKEN`
- [ ] Test token: `curl -H "Authorization: Bearer $TOKEN" https://api-smartflo.tatateleservices.com/v1/call/records?from_date=2026-07-28%2014:00:00&to_date=2026-07-28%2014:01:00`
- [ ] Should return empty call records (or 401 if invalid)

## Phase 2: Register Production Webhook

### Step 2.1: Access Tata Production Dashboard
1. Log in to Tata SmartFlo admin console (production)
2. Navigate to **Settings** → **Webhooks** or **Integrations**

### Step 2.2: Register Webhook URL
Add new webhook:
- **URL:** `https://recovery-karma.onrender.com/api/telephony/webhook`
- **Events:** `call.answered`, `call.missed`, `call.failed`, `call.completed`
- **Method:** POST
- **Timeout:** 30 seconds
- **Retry:** Exponential backoff (3 attempts)

### Step 2.3: Test Webhook Delivery
Tata should send a test event. Verify in production logs:
```bash
# On production server (Render dashboard → Logs)
tail -f logs
# Should see: "[webhook] Processing Tata webhook: $uuid=test-..."
```

## Phase 3: Deploy to Production

### Step 3.1: Update Environment Variables
On your production server (Render, AWS, etc.):

**Render dashboard:**
1. Select your app → Environment
2. Set these variables:

```env
TELEPHONY_PROVIDER=tata
TATA_ACCESS_TOKEN=<production-token-from-tata>
TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1
TATA_WEBHOOK_URL=https://recovery-karma.onrender.com/api/telephony/webhook
```

3. Click Save (Render auto-redeploys)

**Other platforms** (Heroku, AWS, etc.):
- Update environment variables through your platform's UI
- Trigger deployment

### Step 3.2: Verify Deployment
Monitor deployment logs:
```bash
# Render dashboard → Logs
# Should see:
# "Build complete"
# "[polling] Starting background polling job..."
# "Server running on port 3000"
```

Wait for green status indicator on Render dashboard before proceeding.

### Step 3.3: Health Check
Verify app is running:
```bash
curl https://recovery-karma.onrender.com/
# Should return HTML (login page)
```

## Phase 4: Staging-to-Production Migration

### Step 4.1: Data Validation
Verify production database has:
- ✅ Agents with phone numbers set (via admin UI in production)
- ✅ Debtors loaded (from your portfolio management)
- ✅ Test agent created for first call

### Step 4.2: Create Production Test Agent
1. Log in as **admin** on production
2. Go to **Admin → Users**
3. **Invite** new agent:
   - Name: "QA Test Agent"
   - Email: `qa-test@company.com`
   - Role: Agent
4. Click Edit Details
5. Set **Agent Phone** to Tata-provided test number
6. Create corresponding login in Supabase (Dashboard → Auth → Users)
7. Copy UUID and paste into agent profile

## Phase 5: Monitor First Calls

### Step 5.1: Initiate First Test Call
1. Log in as QA Test Agent
2. Navigate to **Dashboard → Call Queue**
3. Select a debtor from test portfolio
4. Click **Dial**
5. Monitor server logs in real-time:

```bash
# Render dashboard → Logs (tail)
# Watch for:
# [telephony:server] startCall: agentNumber=050XXXXXXX0, debtorNumber=...
# [webhook] Processing Tata webhook: status=ringing
# [engine] Leg ... advanced: queued → dialing → ringing → connected
```

### Step 5.2: Track Webhook Latency
Log shows timestamp when call placed and when webhook arrived:
```
[telephony:server] startCall at 2026-07-28 14:32:15.123 UTC
[webhook] Processing Tata webhook at 2026-07-28 14:32:15.847 UTC
# Latency: ~724ms (good!)
```

**Acceptable ranges:**
- **Excellent:** < 500ms
- **Good:** 500ms - 2s
- **Acceptable:** 2s - 5s (falling back to polling)
- **Concerning:** > 5s (polling may be primary)

### Step 5.3: Test Fallback Polling
Simulate webhook failure:
1. Temporarily disable webhook in Tata dashboard
2. Place a call (should get stuck in "Ringing")
3. Wait ~30s for polling cycle:
   ```
   [polling] Fetched N records, processed 1, skipped 0
   ```
4. UI should advance to real state
5. Re-enable webhook in Tata dashboard
6. Future calls should use webhook again (< 1s)

## Phase 6: 24-Hour Monitoring

### Step 6.1: Logging & Alerts
Set up monitoring for:
- **Error logs:** Search for `[ERROR]` or `[webhook]` errors
- **Webhook latency:** Log webhook arrival times
- **Polling health:** Check polling job runs every 30s
- **Failed calls:** Monitor for API 401/403/500 errors

### Step 6.2: Daily Spot Checks
At 6, 12, 18, 24 hours post-deployment:

| Time | Check | Expected | Status |
|------|-------|----------|--------|
| +6h | Place call, verify webhook | < 2s latency | ☐ |
| +12h | Check call_logs table | 20+ records | ☐ |
| +18h | Review error logs | < 5 errors | ☐ |
| +24h | Check polling job | Still running | ☐ |

### Step 6.3: Production Dashboard
Create dashboard for real-time monitoring:

**Metrics to track:**
- Calls placed (count, rate)
- Webhook latency (avg, p95, p99)
- Failed calls (count, reason)
- Polling cycles (count, records processed)
- Database call_logs growth

## Phase 7: Rollback Plan

If critical issues arise:

### Rollback Steps (Emergency)
1. Set `TELEPHONY_PROVIDER=sim` on production
2. Restart server (Render: trigger redeploy)
3. All calls switch to simulator (safe, no real calls)
4. Notify team and Tata
5. Investigate root cause
6. Re-deploy fixed version

### Partial Rollback
If only webhooks are broken but polling works:
- Webhooks pause automatically
- Polling takes over (30s latency)
- Calls still complete, just slower
- No emergency action needed

## Phase 8: Handoff to Operations

### Documentation for On-Call
Create runbook for ops team:

**File:** `docs/PRODUCTION_RUNBOOK.md`

```markdown
# Production Runbook: Tata Telephony

## Symptoms

### "Calls stuck in Ringing"
- Check webhook delivery: does Tata show successful POSTs?
- Check logs for webhook errors
- Fallback: polling should kick in within 30s
- If stuck > 5m, escalate to Tata support

### "High webhook latency (> 5s)"
- Check Tata API status page
- Check network connectivity
- Review polling logs (should be catching up)
- No action needed if polling is working

### "API 401 Unauthorized"
- Check TATA_ACCESS_TOKEN on production
- Verify token hasn't expired (should be permanent)
- Contact Tata if token issue

## Escalation
1. Page on-call engineer
2. Check production logs (Render dashboard)
3. Check Tata status page
4. If critical: initiate rollback to simulator
4. Contact Tata support if infrastructure issue

## Metrics to Monitor
- Webhook latency (target: < 2s)
- Call success rate (target: > 95%)
- Error rate (alert if > 1%)
```

## Phase 9: Post-Deployment Sign-Off

### Checklist
- [ ] All staging tests passed before production
- [ ] Production credentials received from Tata
- [ ] Webhook registered in Tata production dashboard
- [ ] Production app deployed with correct env vars
- [ ] Health check: app responds to HTTP requests
- [ ] First test call placed and connected successfully
- [ ] Webhook latency measured (< 2s)
- [ ] Polling fallback tested and working
- [ ] 24-hour monitoring shows no critical errors
- [ ] Team briefed on runbook and rollback procedure

### Sign-Off
| Role | Name | Date | Signature |
|------|------|------|-----------|
| DevOps | _____ | ____ | _________ |
| QA Lead | _____ | ____ | _________ |
| Product Manager | _____ | ____ | _________ |

---

## Common Issues & Troubleshooting

### Issue: "502 Bad Gateway" on production app
**Cause:** Build failure or startup error  
**Fix:** Check Render logs for build errors, redeploy if needed

### Issue: "Calls place but no status update"
**Cause:** Webhook not registered or network issue  
**Fix:** Verify webhook URL in Tata dashboard, check network connectivity, wait for polling (30s)

### Issue: "Production token doesn't work"
**Cause:** Wrong token or expired token  
**Fix:** Verify token from Tata, request new one if needed

### Issue: "Polling not catching up"
**Cause:** TATA_ACCESS_TOKEN not set or API unreachable  
**Fix:** Verify env var is set, check Tata API status

---

## Next: Run QA Checklist

Once production deployment is stable, proceed to **Task 3.5: QA Manual Testing** (see `QA_CHECKLIST_TATA_INTEGRATION.md`).

---

**Version:** 1.0  
**Created:** 2026-07-28  
**Status:** Ready for production deployment  
**Owner:** DevOps team
