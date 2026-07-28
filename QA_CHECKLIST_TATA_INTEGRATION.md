# QA Checklist: Tata Tele SmartFlo Integration

**Build Date:** 2026-07-28  
**Scope:** Verify Tata telephony provider wiring, webhook handling, and fallback polling  
**Environments:** Staging (primary), Production (after approval)

---

## Pre-Test Setup

- [ ] **Staging server deployed** with `TELEPHONY_PROVIDER=tata`
- [ ] **Webhook URL registered** with Tata sandbox
- [ ] **Test agents created** with phone numbers assigned in admin UI
- [ ] **Test debtors available** in staging database
- [ ] **Server logs accessible** for real-time monitoring

---

## Feature 1: Admin Phone Management (UI)

### 1.1 Admin Create/Edit Agent
- [ ] Navigate to **Admin → Users**
- [ ] Click **Invite** to create new agent
- [ ] Fill: Name, Email, Role (Agent/Manager/Admin)
- [ ] Click **Invite**
- [ ] Agent created (should appear in roster)
- [ ] Click **Edit Details** on created agent
- [ ] Verify **Agent Phone** field exists and is empty
- [ ] Enter phone: `050XXXXXXX0`
- [ ] Click **Save**
- [ ] Page refreshes; phone is persisted
- [ ] Re-open edit dialog; phone still shows

### 1.2 Admin Assign Auth User
- [ ] In Supabase Dashboard → Auth → Users, create test login (email/password)
- [ ] Copy UUID of new user
- [ ] Back to admin UI, **Edit Details** on agent
- [ ] Paste UUID into **Auth User ID** field
- [ ] Save
- [ ] Verify agent can now log in with that email/password

---

## Feature 2: Single Call Placement (Server Mode)

### 2.1 Agent Manual Dial with Real Phone
- [ ] Log in as test **Agent A** (phone: `050XXXXXXX0`)
- [ ] Navigate to **Dashboard → Call Queue** (or single-call view)
- [ ] Select a debtor to call
- [ ] Click **Dial**
- [ ] UI phase should change to **"Ringing"** immediately
- [ ] Check server logs for:
  ```
  [telephony:server] startCall: agentNumber=050XXXXXXX0, debtorNumber=<debtor-phone>
  ```

**If Webhook arrives (< 1 second):**
- [ ] Server log shows:
  ```
  [webhook] Processing Tata webhook: status=ringing
  [webhook] 200 OK
  ```
- [ ] UI advances to **"Connected"** or **"No Answer"** based on webhook

**If Webhook missing (30s timeout):**
- [ ] Server log shows:
  ```
  [polling] Fetched N records, processed M, skipped K
  [polling] Ingesting event for <call-id>: status=connected
  ```
- [ ] UI eventually advances (within 30s after polling ingests event)

### 2.2 Agent Hangup
- [ ] While call is connected, click **Hangup**
- [ ] UI phase should change to **"Ended"**
- [ ] Server logs should show:
  ```
  [telephony:server] hangupCall: providerCallId=<id>
  ```

### 2.3 Verify Call Log Recorded
- [ ] After call ends, navigate to **Debtor Profile** → **Call History**
- [ ] New call entry should appear with:
  - Duration, Outcome (connected/no-answer), Timestamp
  - Agent name

---

## Feature 3: Batch Dialing (Live View)

### 3.1 Start Campaign
- [ ] Log in as **Manager**
- [ ] Go to **Manager → Live View** (or **Dashboard → Campaign**)
- [ ] Configure campaign:
  - Portfolio: Test portfolio
  - Agents available: 2
  - Debtors per batch: 10
- [ ] Click **Start Campaign**
- [ ] Live view should show opening concurrent legs:
  - 2 calls placed simultaneously
  - Legs show in "Ringing" → "Connected" → "Ended" flow

### 3.2 Monitor Concurrent Calls
- [ ] Watch live view for:
  - [ ] Calls dial in sequence
  - [ ] Multiple concurrent states visible
  - [ ] Call durations increment
  - [ ] Outcomes recorded (promised, refused, no-answer)
- [ ] Check server logs for:
  ```
  [polling] Fetched N records, processed M
  [engine] Leg <leg-id> advanced: ringing → connected
  [engine] Leg <leg-id> completed: promised (amount: ₹8000)
  ```

### 3.3 Stop Campaign
- [ ] Click **Stop Campaign**
- [ ] In-flight calls should hang up
- [ ] Live view should show all legs in "Ended" state
- [ ] Campaign stats should display:
  - Total calls placed, connected, promised, refused, no-answer

---

## Feature 4: Webhook Resilience

### 4.1 Webhook Primary Path
- [ ] Place a single call (Test 2.1)
- [ ] Monitor server logs for webhook:
  ```
  [webhook] Processing Tata webhook: $uuid=<id>, status=<status>
  [webhook] 200 OK
  ```
- [ ] Verify < 1s latency between call placement and webhook arrival

### 4.2 Webhook Failure → Polling Fallback
- [ ] Temporarily block webhook delivery:
  - Firewall rule, or
  - Server endpoint returns HTTP 500 for 30s
- [ ] Place a call
- [ ] UI shows "Ringing" but no webhook arrives
- [ ] Wait 30s for polling cycle:
  ```
  [polling] Fetched N records, processed 1, skipped 0
  ```
- [ ] UI advances to real call state from polling
- [ ] Restore webhook delivery
- [ ] Verify future webhooks arrive again (< 1s)

---

## Feature 5: Error Handling

### 5.1 Invalid Agent Phone
- [ ] Admin creates agent with phone: `invalid-phone`
- [ ] Agent tries to dial
- [ ] Server returns error (401 Unauthorized or 400 Bad Request)
- [ ] UI shows error toast: "Failed to place call: <reason>"
- [ ] Server logs show:
  ```
  [telephony:tata] startCall failed: Invalid phone number format
  ```

### 5.2 Tata API Unreachable
- [ ] Simulate API down (e.g., temporary network block)
- [ ] Agent tries to dial
- [ ] Server returns error (connection timeout)
- [ ] UI shows error: "Failed to connect to telephony provider"
- [ ] Polling gracefully handles the error:
  ```
  [polling] Failed to fetch Tata call records: Connection refused
  ```

### 5.3 Missing Auth Token
- [ ] Remove `TATA_ACCESS_TOKEN` from environment
- [ ] Restart server
- [ ] Agent tries to dial
- [ ] Server returns 401 Unauthorized
- [ ] Polling logs:
  ```
  [polling] TATA_ACCESS_TOKEN not set — skipping Tata API call
  ```

---

## Feature 6: Data Integrity

### 6.1 Call Logs Recorded Correctly
- [ ] Place 5 test calls (mix of outcomes: connected, no-answer, promised)
- [ ] Check database:
  ```sql
  SELECT * FROM call_logs WHERE agent_id = 'test-agent' ORDER BY created_at DESC LIMIT 5;
  ```
- [ ] Verify each log has:
  - [ ] `debtor_id` matches called debtor
  - [ ] `agent_id` matches logged-in agent
  - [ ] `outcome` is correct (connected, no_answer, promised, refused)
  - [ ] `duration_seconds` is positive
  - [ ] `created_at` timestamp is recent

### 6.2 Call States Normalized
- [ ] Tata webhook status "answered by customer" → UI shows "Connected" ✓
- [ ] Tata webhook status "missed" → UI shows "No Answer" ✓
- [ ] Tata webhook status "completed" → Call ends with correct duration ✓

### 6.3 Recording URLs Stored
- [ ] If Tata provides recording_url in webhook:
  ```json
  {"$uuid":"123", "status":"completed", "recording_url":"https://..."}
  ```
- [ ] Database should store:
  ```sql
  SELECT recording_url FROM call_logs WHERE id = '...' LIMIT 1;
  ```

---

## Feature 7: Agent Phone Used Correctly

### 7.1 Single Call Uses Agent Phone
- [ ] Agent A (phone: `050XXXXXXX0`) dials debtor
- [ ] Server log shows:
  ```
  [telephony:tata] startCall: agentNumber=050XXXXXXX0
  ```
- [ ] Tata API receives call with agent's phone

### 7.2 Agent Without Phone Cannot Dial
- [ ] Create agent with NO phone number
- [ ] Try to dial as that agent
- [ ] Server returns error or uses fallback
- [ ] Behavior is documented in logs/UI

---

## Feature 8: Regression (Ensure No Breakage)

### 8.1 Local Simulator Still Works
- [ ] On **local dev**, set `TELEPHONY_PROVIDER=sim`
- [ ] Restart dev server
- [ ] Agent dials a debtor
- [ ] Simulator events fire (ring → answer → hangup)
- [ ] UI advances without real API calls
- [ ] No Tata API errors logged

### 8.2 Dashboard Pages Still Load
- [ ] All dashboard routes load without error:
  - [ ] Dashboard → Call Queue
  - [ ] Dashboard → Debtors
  - [ ] Dashboard → Messages
  - [ ] Dashboard → Payments
  - [ ] Dashboard → Reports
  - [ ] Admin → Users
  - [ ] Admin → Portfolio
  - [ ] Manager → Live View

### 8.3 Auth Still Works
- [ ] Login with valid credentials → redirects to dashboard
- [ ] Login with invalid credentials → error message
- [ ] Logout → redirects to login page
- [ ] Session persists on refresh

---

## Sign-Off

| Tester | Role | Passed | Date | Notes |
|--------|------|--------|------|-------|
| QA-1   | QA Engineer | ☐ | __ | |
| QA-2   | QA Engineer | ☐ | __ | |
| Manager | Product Manager | ☐ | __ | |

---

## Known Limitations (To Document)

- [ ] Batch dialing doesn't yet assign specific agents to each call (uses placeholder)
- [ ] AI scoring and WhatsApp messaging deferred to Phase 3
- [ ] Polling has 30s latency (acceptable for now; real-time webhooks are primary)
- [ ] No retry logic for failed calls (manual retry via UI)

---

## Appendix: Common Issues & Fixes

**Issue:** Calls hang in "Ringing" state  
**Fix:** Check if webhook is arriving. If not, verify Tata webhook URL is registered and server is reachable (curl test the endpoint).

**Issue:** Polling logs show "TATA_ACCESS_TOKEN not set"  
**Fix:** Set `TATA_ACCESS_TOKEN` in environment, restart server.

**Issue:** "500 Internal Server Error" on dial button  
**Fix:** Check server logs for actual error, verify Tata API credentials, check network connectivity.

---

**Version:** 1.0  
**Last Updated:** 2026-07-28  
**Next Review:** After staging deployment
