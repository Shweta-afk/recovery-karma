# QA Checklist: Production Testing (Task 3.5)

**Build Date:** 2026-07-28  
**Environment:** Production  
**Scope:** End-to-end testing with real Tata API and real debtors  
**Duration:** 24+ hours post-deployment  

---

## Pre-Test Setup

- [ ] Production deployment complete (all env vars set)
- [ ] Webhook registered in Tata production dashboard
- [ ] Tata production token validated
- [ ] Production test agent created with phone number
- [ ] Test debtors available in portfolio
- [ ] Server logs accessible and monitored
- [ ] Monitoring dashboard set up (Render, Grafana, etc.)
- [ ] Team on standby for escalation

---

## Phase 1: Deployment Verification (Hour 0)

### 1.1 Health Checks
- [ ] Production app responds to HTTP: `curl https://recovery-karma.onrender.com/` → 200 OK
- [ ] Login page loads: navigate to app, see login form
- [ ] No obvious errors in Render dashboard logs
- [ ] Database connectivity verified (can query agents, debtors)

### 1.2 Environment Validation
- [ ] `TELEPHONY_PROVIDER=tata` (not `sim`)
- [ ] `TATA_ACCESS_TOKEN` is set (not empty)
- [ ] `TATA_BASE_URL` points to production: `https://api-smartflo.tatateleservices.com/v1`
- [ ] `TATA_WEBHOOK_URL` is `https://recovery-karma.onrender.com/api/telephony/webhook`
- [ ] Polling job started: logs show `[polling] Starting background polling job...`

### 1.3 Webhook Registration
- [ ] Tata dashboard confirms webhook registered at production URL
- [ ] Tata sent test webhook (check logs for `[webhook] Processing Tata webhook`)
- [ ] Test webhook received and processed without error

---

## Phase 2: Single Call Testing (Hour 1-2)

### 2.1 Agent Manual Call - Basic Flow
1. [ ] Log in as production **Test Agent**
2. [ ] Navigate to **Dashboard → Call Queue**
3. [ ] Select a test debtor to call
4. [ ] Click **Dial**
5. [ ] Verify **immediate** UI change to "Ringing"
6. [ ] **Simultaneously**, check server logs:
   ```
   [telephony:server] startCall: agentNumber=050XXXXXXX0, debtorNumber=...
   ```
7. [ ] Wait for debtor to answer (or no-answer/disconnect)
8. [ ] Verify UI updates to "Connected" (or appropriate status)
   - If webhook arrives (< 2s): instant update via webhook
   - If polling (30s): update within 30s from polling
9. [ ] Verify call duration increments in UI
10. [ ] Agent clicks **Hangup**
11. [ ] Verify UI changes to "Ended"
12. [ ] Verify call log created in database:
    ```sql
    SELECT * FROM call_logs WHERE agent_id = '...' ORDER BY created_at DESC LIMIT 1;
    ```

### 2.2 Verify Call Log Data
After call completes, check database row has:
- [ ] `debtor_id` matches called debtor
- [ ] `agent_id` matches test agent
- [ ] `status` is "completed" or "ended"
- [ ] `outcome` is empty (not yet submitted)
- [ ] `duration_seconds` > 0 (call length)
- [ ] `created_at` is within last minute
- [ ] `updated_at` is recent

### 2.3 Webhook Latency Measurement
Document webhook latency from server logs:

| Call # | Placed At | Webhook At | Latency | Method |
|--------|-----------|------------|---------|--------|
| 1 | HH:MM:SS.mmm | HH:MM:SS.mmm | ___ms | Webhook / Polling |
| 2 | HH:MM:SS.mmm | HH:MM:SS.mmm | ___ms | Webhook / Polling |
| 3 | HH:MM:SS.mmm | HH:MM:SS.mmm | ___ms | Webhook / Polling |

**Target:** Avg latency < 2s (or first measurement via webhook)

### 2.4 Call Outcomes
Repeat single calls with different outcomes:
- [ ] **Connected call:** Place call, agent connects, verify UI shows "Connected", capture duration
- [ ] **No answer:** Call times out, verify UI shows "No Answer", verify duration is ring time only
- [ ] **Declined by debtor:** Debtor hangs up mid-call, verify status updates correctly

---

## Phase 3: Call Disposition & Logging (Hour 2-3)

### 3.1 Submission of Call Outcome
1. [ ] After call ends, UI shows **Disposition Form** (or similar)
2. [ ] Agent selects outcome: "Promised" / "Refused" / "Paid" / "Callback"
3. [ ] If outcome is "Promised":
   - [ ] Agent enters promise amount (e.g., ₹5000)
   - [ ] Agent selects promise date (e.g., 2026-07-30)
4. [ ] Agent clicks **Submit**
5. [ ] Verify toast: "Disposition saved"
6. [ ] Verify database row updated:
   ```sql
   SELECT outcome, promise_amount, promise_date FROM call_logs WHERE id = '...' LIMIT 1;
   ```
   - [ ] `outcome` = "promised"
   - [ ] `promise_amount` = 5000
   - [ ] `promise_date` = 2026-07-30

### 3.2 Call History Display
1. [ ] Navigate to **Dashboard → Debtors**
2. [ ] Find debtor from test call
3. [ ] Click to open debtor profile (sheet/dialog)
4. [ ] Go to **Call History** tab
5. [ ] Latest call should appear with:
   - [ ] Duration
   - [ ] Outcome
   - [ ] Timestamp
   - [ ] Agent name
   - [ ] Promise details (if promised)

---

## Phase 4: Batch Dialing Testing (Hour 3-4)

### 4.1 Start Batch Campaign
1. [ ] Log in as **Manager** or **Admin**
2. [ ] Navigate to **Manager → Live View** (or similar)
3. [ ] Start new campaign:
   - Portfolio: Test portfolio
   - Agents available: 3
   - Max concurrent: 3
   - Queue: select 20 test debtors
4. [ ] Click **Start Campaign**

### 4.2 Monitor Live View
- [ ] Live view opens and shows call legs
- [ ] Multiple concurrent calls appear (should see 3 legs dialing)
- [ ] Calls advance through states: queued → dialing → ringing → connected → ended
- [ ] Real-time duration display updates

### 4.3 Verify Concurrent Calls via Logs
```bash
# Check Render logs during campaign
# Should see multiple concurrent calls:
[telephony:server] startCall #1: debtor=...
[telephony:server] startCall #2: debtor=...
[telephony:server] startCall #3: debtor=...
[webhook] Processing Tata webhook: call_id=#1, status=ringing
[webhook] Processing Tata webhook: call_id=#2, status=ringing
[webhook] Processing Tata webhook: call_id=#3, status=ringing
```

### 4.4 Campaign Statistics
- [ ] Live view shows real-time stats:
  - [ ] Calls dialed (total count)
  - [ ] Calls connected (count)
  - [ ] Call success rate (%)
  - [ ] Avg duration
- [ ] Stats update in real-time as calls complete

### 4.5 Stop Campaign
1. [ ] Click **Stop Campaign**
2. [ ] All in-flight calls hang up
3. [ ] Live view shows all legs in "Ended" state
4. [ ] Final stats display
5. [ ] Campaign can be restarted (no issues)

### 4.6 Batch Calls in Database
After campaign, verify call_logs:
```sql
SELECT COUNT(*), outcome, AVG(EXTRACT(epoch FROM (ended_at - started_at))) 
FROM call_logs 
WHERE created_at > now() - interval '1 hour' 
GROUP BY outcome;
```

- [ ] 20+ calls logged (all campaign calls)
- [ ] Outcomes distributed (connected, no-answer, promised, refused)
- [ ] Durations vary (not all zeros or same value)

---

## Phase 5: Webhook Resilience (Hour 4-5)

### 5.1 Webhook Delivery Success
- [ ] Monitor logs for pattern:
  ```
  [webhook] Processing Tata webhook: ...
  [webhook] 200 OK
  ```
- [ ] Verify no `[webhook]` error logs
- [ ] Measure latency (as documented in Phase 2.3)

### 5.2 Webhook Failure → Polling Fallback
**Scenario:** Temporarily disable webhooks to test polling resilience

1. [ ] In Tata production dashboard, **temporarily disable** webhook endpoint (or unregister)
2. [ ] Place a single call as test agent
3. [ ] Call will dial but UI stuck in "Ringing" (no webhook)
4. [ ] Wait 30-60 seconds
5. [ ] Check logs for polling:
   ```
   [polling] Fetched N records, processed 1, skipped 0
   [polling] Ingesting event for call_id=...: status=connected
   ```
6. [ ] UI should advance from "Ringing" to actual call status within 30s
7. [ ] Re-enable webhook in Tata dashboard
8. [ ] Place another call; verify webhook works again (< 2s latency)

### 5.3 Extended Polling Test
- [ ] Keep webhooks disabled for 30 minutes
- [ ] Place 5 calls during this window
- [ ] Verify all calls progress via polling every 30s
- [ ] No calls stuck or abandoned
- [ ] Logs show consistent polling cycles

---

## Phase 6: Error Handling & Edge Cases (Hour 5-7)

### 6.1 Invalid Agent Phone
1. [ ] Admin sets agent's phone to invalid value (e.g., "abc123")
2. [ ] Agent tries to dial
3. [ ] Call fails with clear error
4. [ ] UI shows error message to user
5. [ ] No crash, no silent failure
6. [ ] Log shows: `[telephony:tata] startCall failed: Invalid phone format`

### 6.2 Missing Agent Phone
1. [ ] Create new agent without setting phone
2. [ ] Try to dial as that agent
3. [ ] Should fail or use fallback
4. [ ] Error message guides user to set phone
5. [ ] Admin can then edit agent and set phone

### 6.3 Tata API Unreachable
**Scenario:** Simulate API failure

1. [ ] Temporarily add firewall rule to block Tata API (or use DNS block)
2. [ ] Agent tries to dial
3. [ ] Call fails with timeout/connection error
4. [ ] UI shows: "Failed to connect to telephony provider"
5. [ ] Logs show: `[telephony:tata] startCall failed: Connection refused`
6. [ ] Polling also fails gracefully:
   ```
   [polling] Failed to fetch Tata call records: Connection refused
   ```
7. [ ] No crash, server continues running
8. [ ] Restore network; next call succeeds

### 6.4 Expired Access Token
1. [ ] Temporarily change `TATA_ACCESS_TOKEN` to invalid value
2. [ ] Agent tries to dial
3. [ ] Call fails with 401 Unauthorized
4. [ ] Logs show: `[telephony:tata] startCall failed: 401 Unauthorized`
5. [ ] Restore correct token; next call succeeds

### 6.5 Concurrent Calls from Same Agent
1. [ ] Agent is on a call
2. [ ] Agent tries to dial another debtor (should be prevented or queued)
3. [ ] Either:
   - [ ] UI disables **Dial** button while connected (preferred)
   - [ ] Or: call fails with "Agent busy" error
4. [ ] No dropped or corrupted calls

### 6.6 Rapid Dial/Hangup Sequence
1. [ ] Agent clicks **Dial** → immediately clicks **Hangup** (< 1 second)
2. [ ] System handles gracefully:
   - [ ] Call may be placed and instantly hung up
   - [ ] Or: call prevented if still dialing
3. [ ] No errors, no hanging state
4. [ ] Database shows call with very short duration

---

## Phase 7: Performance & Stability (Hour 7-24)

### 7.1 High-Volume Load Test (if safe)
- [ ] Run 50 concurrent calls (or 3x normal peak)
- [ ] Monitor:
  - [ ] Webhook latency (should not spike > 5s)
  - [ ] Polling cycles complete on time (every 30s)
  - [ ] No dropped calls or missed webhooks
  - [ ] Server CPU/memory within limits
  - [ ] Database queries performant

### 7.2 Long-Running Stability
**Run continuously for 24 hours, spot-check every 4 hours:**

| Hour | Calls Placed | Webhook Latency | Polling Status | Errors | Notes |
|------|--------------|-----------------|----------------|--------|-------|
| +2h | _____ | _____ ms | ☐ Running | ____ | |
| +6h | _____ | _____ ms | ☐ Running | ____ | |
| +12h | _____ | _____ ms | ☐ Running | ____ | |
| +18h | _____ | _____ ms | ☐ Running | ____ | |
| +24h | _____ | _____ ms | ☐ Running | ____ | |

**Expected:**
- No memory leaks (polling history trimmed every 1000 entries)
- No dropped webhooks
- Consistent latency
- < 5 error logs per hour

### 7.3 Database Growth
Monitor call_logs growth:
```sql
SELECT DATE(created_at), COUNT(*) FROM call_logs 
WHERE created_at > now() - interval '1 day'
GROUP BY DATE(created_at)
ORDER BY created_at;
```

- [ ] Reasonable growth rate (e.g., 100-1000 calls/day depending on volume)
- [ ] No duplicate entries
- [ ] All fields populated correctly

---

## Phase 8: Regression Testing

### 8.1 Core Dashboard Features
- [ ] Dashboard → Call Queue loads (not broken by Tata changes)
- [ ] Dashboard → Debtors loads
- [ ] Dashboard → Messages loads
- [ ] Dashboard → Payments loads
- [ ] Dashboard → Reports loads

### 8.2 Admin Features
- [ ] Admin → Users (agent phone field works)
- [ ] Admin → Portfolio uploads still work
- [ ] Admin → Settings page loads

### 8.3 Manager Features
- [ ] Manager → Live View loads
- [ ] Manager → Audit page works
- [ ] Manager → Reports page works

### 8.4 Agent Features
- [ ] Agent can log in
- [ ] Agent can view queue
- [ ] Agent can submit disposition
- [ ] Agent can view history

---

## Phase 9: Compliance & Security

### 9.1 DND (Do Not Disturb) Handling
If Tata rejects calls to DND numbers:
- [ ] Call to DND number fails
- [ ] Error logged and visible
- [ ] Agent notified ("Number is on DND list")
- [ ] Call not retried automatically

### 9.2 Recording URL Handling
If Tata provides recording URLs:
- [ ] Recording URL stored in call_logs
- [ ] URL is HTTPS (secure)
- [ ] Recording link accessible only to authorized users
- [ ] No recording URLs logged in plain text error messages

### 9.3 Data Protection
- [ ] No tokens logged in error messages
- [ ] No debtor phone numbers in debug logs
- [ ] Webhook events processed without exposing sensitive data
- [ ] Polling logs don't leak call details

### 9.4 Audit Trail
- [ ] All calls logged to call_logs table
- [ ] Timestamp accurate (UTC)
- [ ] Agent ID captured
- [ ] Outcome recorded
- [ ] Audit logs queryable by compliance team

---

## Phase 10: Final Sign-Off

### Production Test Results Summary
| Area | Status | Notes |
|------|--------|-------|
| Deployment | ✓/✗ | |
| Single calls | ✓/✗ | Avg latency: ___ ms |
| Batch calling | ✓/✗ | Concurrent calls: ___ |
| Webhook latency | ✓/✗ | Avg: ___ ms, p95: ___ ms |
| Polling resilience | ✓/✗ | Fallback latency: ~30s |
| Error handling | ✓/✗ | All scenarios tested |
| 24h stability | ✓/✗ | Uptime: ___ %, Errors: ___ |
| Regression | ✓/✗ | All pages load |
| Compliance | ✓/✗ | DND, recordings, audit |

### Sign-Off
| Role | Name | Result | Date | Signature |
|------|------|--------|------|-----------|
| QA Lead | _____ | ✓/✗ | ____ | _________ |
| DevOps | _____ | ✓/✗ | ____ | _________ |
| Product Manager | _____ | ✓/✗ | ____ | _________ |
| VP Engineering | _____ | ✓/✗ | ____ | _________ |

### Sign-Off Notes
```
[Space for additional observations, issues found, or production readiness assessment]
```

---

## Incident Response (If Issues Found)

### Critical Issue Found
If any **critical** issue found (calls not connecting, data corruption, security issue):

1. [ ] **STOP** production testing
2. [ ] Notify team immediately
3. [ ] Capture logs and debug info
4. [ ] Initiate rollback to simulator (if needed)
5. [ ] File incident report with:
   - [ ] Issue description
   - [ ] Reproduction steps
   - [ ] Impact (# calls affected, severity)
   - [ ] Root cause (if known)
   - [ ] Remediation

### Non-Critical Issue Found
If minor issue (slow latency, UI glitch):
1. [ ] Document in QA report
2. [ ] Assign to engineering for fix
3. [ ] Decide: proceed with current production or wait for fix
4. [ ] Log in follow-up tasks

---

## Appendix: Performance Baselines

**For reference, expected metrics:**

| Metric | Baseline | Threshold | Alert |
|--------|----------|-----------|-------|
| Webhook latency (avg) | < 500ms | < 2s | > 5s |
| Webhook success rate | > 99% | > 98% | < 95% |
| Polling cycle time | ~30s | 25-35s | > 60s |
| Call success rate | > 95% | > 90% | < 85% |
| Error rate | < 0.1% | < 1% | > 5% |
| Server response time | < 200ms | < 1s | > 5s |
| Database query time | < 100ms | < 500ms | > 2s |

---

**Version:** 1.0  
**Created:** 2026-07-28  
**Status:** Ready for production QA  
**Owner:** QA team
