# Production Runbook: RecoveryAI Tata Telephony

**For:** On-call engineers  
**Date:** 2026-07-28  
**Critical Service:** Call placement and status updates via Tata Tele SmartFlo  

---

## Quick Reference

| Issue | Symptom | Quick Check | Action |
|-------|---------|-------------|--------|
| **Webhooks not arriving** | Calls stuck in "Ringing" | Logs: `[webhook]` errors | Re-register webhook in Tata dashboard |
| **Polling not running** | Calls stuck after 2+ min | Logs: `[polling]` missing | Check TATA_ACCESS_TOKEN, restart server |
| **401 Unauthorized** | Calls fail immediately | Logs: `401 Unauthorized` | Verify TATA_ACCESS_TOKEN in Render env |
| **Connection timeout** | Calls fail with timeout | Network blocked to Tata | Check firewall, DNS, Tata API status |
| **High latency (> 5s)** | UI updates slow | Logs: webhook latency logged | Monitor Tata status page, polling is fallback |
| **Memory growing** | Server performance degrades | Process memory rising | Polling history trimmed at 1000 entries, check for leaks |
| **500 errors** | "Internal Server Error" in UI | Logs: `[ERROR]` entries | Check logs for root cause, may need rollback |

---

## Escalation Flowchart

```
Customer reports: "Calls not working"
    ↓
[Step 1: Check Logs] → [Step 2: Identify Issue] → [Step 3: Remediation] → [Step 4: Verify]
    ↓                      ↓                         ↓                    ↓
Check last 10m         Webhook? Polling?      Re-register?         Place test
logs for errors        Token? Network?        Restart? Rollback?    call
                       Tata status?
    ↓ (No clear cause)
[Page Senior Engineer]
```

---

## Monitoring Alerts

### Alert: Webhook Latency > 5s
**What it means:** Webhooks are taking too long (or missing entirely, hitting polling fallback)

**Check:**
```bash
# In Render dashboard → Logs, search for:
[webhook] Processing Tata webhook: ...
# Compare timestamps: when call placed vs when webhook arrived
```

**If latency confirmed:**
1. Check Tata status page: https://status.tatateleservices.com/ (if exists)
2. Check network connectivity: `ping api-smartflo.tatateleservices.com`
3. If Tata is down: notify customers, polling will catch up (30s)
4. If network is fine but slow: may be Render region latency, escalate to Render support

**Action:**
- Latency 2-5s: **OK**, monitor
- Latency 5-30s: **WARNING**, check Tata status, monitor polling
- Latency > 30s: **CRITICAL**, escalate

---

### Alert: Error Rate > 1%
**What it means:** More than 1% of calls are failing

**Check:**
```bash
# Count errors in last 1 hour
grep "\[ERROR\]\|\[webhook\] .* error" /var/log/recovery-karma/app.log | wc -l
# Count total calls
grep "\[telephony:server\] startCall" /var/log/recovery-karma/app.log | wc -l
```

**Root causes:**
- **401 Unauthorized:** Token expired or invalid
- **Connection timeout:** Network issue or Tata down
- **400 Bad Request:** Invalid phone number format
- **500 Server Error:** Tata API issue or our bug

**Action:**
1. Identify error type from logs
2. See "Common Issues" section below
3. If > 100 errors in 1 hour: consider rollback to simulator

---

### Alert: Polling Job Not Running
**What it means:** Background polling every 30s has stopped

**Check:**
```bash
# In Render logs, search for:
[polling] Fetched N records, processed M, skipped K
# Should see this every ~30 seconds
```

**If missing:**
1. Check if polling was started:
   ```bash
   grep "[polling] Starting background polling job" /var/log/recovery-karma/app.log
   ```
2. If not started: app may have crashed at startup
3. If started but stopped: check for errors:
   ```bash
   grep "[polling]" /var/log/recovery-karma/app.log | tail -20
   ```

**Action:**
- Restart server (Render: trigger redeploy)
- Monitor logs for `[polling]` messages
- If still not running: escalate

---

## Common Issues

### 1. Calls Stuck in "Ringing" > 2 Minutes

**Diagnosis:**
```bash
# Check if webhook is arriving
grep "[webhook]" /var/log/recovery-karma/app.log | tail -5

# Check if polling is catching up
grep "[polling]" /var/log/recovery-karma/app.log | tail -5
```

**If webhook arriving:**
- System is working, just slow
- Wait for UI to update from webhook
- Monitor latency

**If webhook NOT arriving but polling is:**
- Webhooks are down, polling is catching up (30s latency)
- Expected behavior, no action needed
- Wait for polling cycle or check Tata status

**If neither webhook NOR polling:**
- Critical issue, escalate
- Check network connectivity to Tata
- Check if TATA_ACCESS_TOKEN is set

### 2. API Returns 401 Unauthorized

**Symptoms:**
- Calls fail immediately with "Failed to connect..."
- Logs show: `401 Unauthorized`

**Cause:** `TATA_ACCESS_TOKEN` is invalid, expired, or not set

**Fix:**
1. Verify env var in Render dashboard:
   ```bash
   Render → Select app → Environment → search "TATA_ACCESS_TOKEN"
   ```
2. If empty: Tata token was lost, contact Tata for new token
3. If set: token may be invalid, request new token from Tata
4. Update env var and redeploy

**Fallback:** Set `TELEPHONY_PROVIDER=sim` to allow testing with simulator

---

### 3. Connection Timeout to Tata API

**Symptoms:**
- Calls fail with "Connection refused" or "Timeout after 30s"
- Logs show: `ECONNREFUSED` or `ETIMEDOUT`

**Cause:** Network cannot reach `api-smartflo.tatateleservices.com`

**Check:**
```bash
# From Render container (if SSH available)
curl -I https://api-smartflo.tatateleservices.com/v1

# If fails, check DNS
nslookup api-smartflo.tatateleservices.com

# Check Tata status page
# https://status.tatateleservices.com/ (if exists)
```

**Fix:**
1. If Tata API is down: wait and retry (usually < 1 hour)
2. If DNS fails: may be Render region issue, try again
3. If Render firewall blocks: escalate to Render support
4. Meanwhile: switch to simulator (`TELEPHONY_PROVIDER=sim`)

---

### 4. High Memory Usage

**Symptoms:**
- Server memory growing over time
- Render shows "Memory limit exceeded" or OOM

**Cause:** Polling history not being trimmed, or other memory leak

**Check:**
```bash
# Polling should trim history at 1000 entries
grep "[polling] Trim" /var/log/recovery-karma/app.log

# Check for any memory leak warnings
grep "leak\|OOM\|memory" /var/log/recovery-karma/app.log
```

**Fix:**
1. If polling is trimming regularly: no issue
2. If memory keeps growing: may be a leak
3. **Immediate:** Restart server (Render: redeploy)
4. **Long-term:** File bug to engineering, may need investigation

---

### 5. Webhook Registered But Not Receiving Events

**Symptoms:**
- Webhook URL is correct in Tata dashboard
- Calls placed (Tata confirms in API logs)
- But no webhook POST to our server

**Cause:** Network issue, firewall, or URL validation failure

**Check:**
1. Verify webhook URL in Tata dashboard:
   - Should be: `https://recovery-karma.onrender.com/api/telephony/webhook`
   - Should be HTTPS (not HTTP)
   - Should respond to POST
2. Test endpoint manually:
   ```bash
   curl -X POST https://recovery-karma.onrender.com/api/telephony/webhook \
     -H "Content-Type: application/json" \
     -d '{"$uuid":"test-123", "status":"ringing"}'
   # Should return 200 OK or 400 (bad request, expected)
   ```
3. If curl fails: endpoint not reachable, check:
   - Render app is running (check dashboard)
   - URL is correct
   - Firewall isn't blocking Tata IPs

**Fix:**
1. Re-register webhook in Tata dashboard
2. Re-test with curl
3. Monitor logs for next webhook arrival
4. If still failing: escalate to Tata support with logs

---

### 6. Polling Works, Webhooks Don't

**This is expected!** Polling is the fallback.

**Symptoms:**
- Calls eventually update (via polling every 30s)
- Webhooks never arrive
- Logs show: `[polling] Fetched ... processed ...` but no `[webhook]`

**Why:** Tata webhooks may be delayed or delivery network issues

**Action:**
- This is the fallback design working as intended
- Calls will eventually update (within 30s)
- No immediate action needed
- Monitor Tata status page for ongoing issues
- Re-register webhook once network is stable

---

### 7. Calls Complete But Disposition Not Saved

**Symptoms:**
- Call ends, UI shows "Ended"
- Disposition form shown
- Agent submits outcome
- But database call_logs doesn't update

**Cause:** Database update failed or RLS issue

**Check:**
```bash
# Logs for database errors
grep "error.*call_logs\|RLS\|permission denied" /var/log/recovery-karma/app.log

# Check call_logs was created
SELECT * FROM call_logs WHERE created_at > now() - interval '5 min';
```

**Fix:**
1. If RLS error: check user's client_id matches call's client_id
2. If update failed: check database connectivity
3. Retry manually: agent dials again and submits
4. If persists: escalate to engineering

---

### 8. "TATA_ACCESS_TOKEN not set" Warnings in Polling

**Symptoms:**
- Logs show: `[polling] TATA_ACCESS_TOKEN not set — skipping Tata API call`
- Calls still work (via webhooks)
- Polling doesn't run

**This is expected if:** `TELEPHONY_PROVIDER=sim` (simulator mode)

**If TELEPHONY_PROVIDER=tata:** Token is missing

**Fix:**
1. Verify env var is set: Render dashboard → Environment
2. If not set: add `TATA_ACCESS_TOKEN=<token-value>`
3. Redeploy
4. Polling should resume

---

## Rollback Procedure

**When to rollback:**
- Critical issue affecting > 50% of calls
- Data corruption detected
- Security vulnerability discovered
- Multiple cascading failures

### Rollback Steps (5 minutes)

1. **Notify team:**
   ```
   Slack: @team [INCIDENT] Rolling back Tata integration to simulator. 
   ETA 5 min. Calls will be simulated, no real calls placed.
   ```

2. **Update environment:**
   ```
   Render dashboard → Environment → set:
   TELEPHONY_PROVIDER=sim
   ```

3. **Redeploy:**
   ```
   Render will auto-redeploy, monitor:
   Dashboard → Logs
   Should see: "[sim-provider] Created simulator instance"
   ```

4. **Verify:**
   - Place test call
   - Verify UI shows simulator behavior (instant ring→answer)
   - Check logs: no Tata API calls
   - Notify customers: calls are in test mode

5. **Post-incident:**
   - File incident report
   - Investigate root cause
   - Plan fix
   - Staging test before redeploying to production

### Rollback Status
Once rolled back to simulator:
- ✓ Calls place (not real, safe)
- ✓ UI updates (simulated)
- ✓ Dispositions log (to database)
- ✗ Real debtors not called (simulator only)
- ✗ No real recordings
- ✗ No real call outcomes

**Next:** Fix issue, test in staging, redeploy to production

---

## Escalation Contacts

| Role | Name | Phone | Email | Availability |
|------|------|-------|-------|--------------|
| On-Call Engineer | TBD | +91-9XXX-XXX-XXX | on-call@company.com | 24/7 |
| DevOps Lead | TBD | +91-9XXX-XXX-XXX | devops@company.com | 9am-6pm IST |
| Tata Support | Contact Center | +91-XXXX-XXXX-XXXX | support@tatateleservices.com | 24/7 |
| VP Engineering | TBD | +91-9XXX-XXX-XXX | vp-eng@company.com | 8am-8pm IST |

---

## Monitoring Dashboard

**Set up monitoring for these metrics** (use Render, Datadog, or similar):

### Real-Time Alerts (Page on-call immediately)
- [ ] Error rate > 5% for 2 minutes
- [ ] Webhook latency > 30s for 5 minutes
- [ ] Server down (no HTTP responses for 1 minute)
- [ ] Database connection failure
- [ ] Polling job not running (no log entry in 60 seconds)

### Warning Alerts (Notify Slack, investigate)
- [ ] Error rate > 1% for 5 minutes
- [ ] Webhook latency > 5s for 5 minutes
- [ ] Memory usage > 80%
- [ ] Database slow queries (> 1s)

### Info Alerts (Log only)
- [ ] Daily call volume report
- [ ] Webhook latency percentiles (p50, p95, p99)
- [ ] Polling cycle count per hour

---

## Maintenance Windows

**For planned maintenance (e.g., database updates, Render upgrades):**

1. **Announce:** Slack, email to customers (24h advance)
2. **During maintenance:**
   - Set `TELEPHONY_PROVIDER=sim` 
   - Redeploy
   - Notify customers: "In test mode, no real calls"
3. **Complete maintenance**
4. **Test thoroughly:** place call, verify webhook
5. **Restore:** `TELEPHONY_PROVIDER=tata`
6. **Redeploy and verify**
7. **Announce:** "Production restored"

---

## Log Locations & Queries

### Render Logs
```
Render dashboard → Select app → Logs
Live tail all logs
```

### Useful grep commands:
```bash
# All errors
grep "\[ERROR\]" /var/log/recovery-karma/app.log

# Webhook events
grep "\[webhook\]" /var/log/recovery-karma/app.log

# Polling events
grep "\[polling\]" /var/log/recovery-karma/app.log

# Telephony calls
grep "\[telephony:server\]" /var/log/recovery-karma/app.log

# Last 100 lines (real-time)
tail -100f /var/log/recovery-karma/app.log

# Errors in last hour
grep "\[ERROR\]" /var/log/recovery-karma/app.log | grep "$(date -d '1 hour ago' +%Y-%m-%d)"
```

---

## Key Metrics

**Monitor daily:**

| Metric | Target | Yellow | Red |
|--------|--------|--------|-----|
| Call success rate | > 95% | 90-95% | < 90% |
| Webhook latency (avg) | < 500ms | 500ms-2s | > 2s |
| Webhook success rate | > 99% | 98-99% | < 98% |
| Polling cycle time | 25-35s | 35-60s | > 60s |
| Error logs/hour | < 1 | 1-5 | > 5 |
| Uptime | 99.9% | 99.5% | < 99% |

---

## Quick Decision Tree

```
Issue reported
    ↓
    ├─ [Calls not placing?]
    │  ├─ Logs show 401? → Check TATA_ACCESS_TOKEN
    │  ├─ Logs show timeout? → Check network/Tata status
    │  ├─ Logs show error? → Search error message below
    │  └─ No logs? → Check if TELEPHONY_PROVIDER=tata
    │
    ├─ [Calls stuck in Ringing?]
    │  ├─ > 30 seconds? → Wait for polling (fallback)
    │  ├─ No webhook arriving? → Re-register webhook
    │  └─ Polling also slow? → Check TATA_ACCESS_TOKEN
    │
    ├─ [Polling not running?]
    │  ├─ TATA_ACCESS_TOKEN set? → Restart server
    │  └─ TATA_ACCESS_TOKEN missing? → Add and redeploy
    │
    └─ [Multiple failures?]
       ├─ > 50% calls failing? → ROLLBACK to simulator
       └─ Escalate → Page senior engineer
```

---

## Contact & Feedback

**Found an issue with this runbook?**
- Update this document
- Test your changes
- Commit to `main`
- Share with on-call team

---

**Version:** 1.0  
**Last Updated:** 2026-07-28  
**Reviewed By:** DevOps Team  
**Next Review:** 2026-08-28
