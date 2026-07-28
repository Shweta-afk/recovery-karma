# Staging Test Setup (Task 3.3)

## Overview
This guide walks through registering the webhook with Tata sandbox and deploying to a staging environment to verify live call flows with real API integration.

## Prerequisites
- ✅ Admin UI wired to manage agent phone numbers (Task 3.1)
- ✅ Agent phone numbers fetched in call placement (Task 3.2)
- ✅ Webhook handler implemented at `POST /api/telephony/webhook`
- ✅ Polling fallback running every 30s as redundancy

## Phase 1: Tata Sandbox Registration

### Step 1.1: Get Sandbox Credentials
Contact your Tata Tele account manager to request:
- **Sandbox API endpoint** (typically: `https://api-smartflo.tatateleservices.com/v1`)
- **Sandbox access token** (Permanent Access Token — valid indefinitely)
- **Test agent phone numbers** (e.g., `050XXXXXXX0` — phone/extension to register)

### Step 1.2: Register Webhook URL
In Tata SmartFlo admin console:
1. Go to **Settings** → **Webhooks** or **Integrations**
2. Add new webhook endpoint:
   - **URL:** `https://{staging-url}/api/telephony/webhook`
   - **Events:** `call.answered`, `call.missed`, `call.failed`, `call.completed`
   - **Method:** POST
   - **Retry policy:** Exponential backoff (typically 3 retries)
3. Save and test (Tata usually sends a test event)
4. Verify that your `POST /api/telephony/webhook` handler receives and logs it

### Step 1.3: Verify Webhook Delivery
Check server logs for webhook ingestion:
```bash
# On staging server, tail logs for webhook delivery
tail -f /var/log/recovery-karma/webhook.log
# Should see: "[webhook] Error processing Tata webhook: ..." or "[webhook] 200 OK"
```

## Phase 2: Deploy to Staging

### Step 2.1: Configure Staging Environment
Set these variables on your staging server (Render, Heroku, AWS, etc.):

```env
TELEPHONY_PROVIDER=tata
TATA_ACCESS_TOKEN=<sandbox-token-from-step-1.1>
TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1
TATA_WEBHOOK_URL=https://{staging-url}/api/telephony/webhook
```

**For Render deployment:**
- Go to dashboard → Select service → Environment
- Add the above variables
- Render auto-redeploys on save

### Step 2.2: Push Code & Deploy
```bash
git add .env.staging
git commit -m "chore: staging env vars for Tata integration"
git push origin main
# Render auto-deploys on push (if auto-deploy is enabled)
```

Monitor deployment:
```bash
# Render dashboard → Logs
# Should see: "[polling] Starting background polling job"
#            "Webhook registered at POST /api/telephony/webhook"
```

### Step 2.3: Create Test Agents in Staging
On the staging app:
1. Log in as **admin**
2. Go to **Admin → Users** (now has agent_phone field)
3. Create test agents, set their **Agent Phone** to test numbers from Tata:
   - Agent A: `050XXXXXXX0`
   - Agent B: `050XXXXXXX1`
4. Create corresponding login in Supabase (via Dashboard → Auth → Users)
5. Edit agent profile and paste auth UUID

## Phase 3: Manual Test Flows

### Test 3.1: Single Agent Call (Server Mode)
**Goal:** Verify a single agent can place a call to a debtor using real Tata API.

1. Log in as **Agent A**
2. Go to **Dashboard → Call Queue** (or **Single Call** view if available)
3. Select a debtor to call
4. Click **Dial** (mode should default to "server" for production)
5. Monitor:
   - Client should show "Ringing" phase immediately
   - Server logs should show: `[webhook] 200 OK` (or polling should pick up the call status within 30s)
   - UI should advance to "Connected" when Tata POSTs the webhook

**Expected outcome:**
- Call placed through Tata (real phone rings)
- Status updates via webhook (or polling fallback)
- UI reflects real-time call phase

### Test 3.2: Batch Calling (Live View)
**Goal:** Verify manager can run a batch dialing campaign.

1. Log in as **Manager** or **Admin**
2. Go to **Manager → Live View** (or **Dashboard → Campaign**)
3. Start a campaign:
   - Portfolio: select test portfolio
   - Agents available: 2
   - Queue size: 10 debtors
4. Monitor:
   - Multiple concurrent calls should place with Tata
   - Live view shows concurrent legs advancing through states
   - Webhook events arrive < 1s or polling catches within 30s

**Expected outcome:**
- Concurrent calls placed
- Real-time status updates
- No errors in server logs

### Test 3.3: Polling Fallback
**Goal:** Verify polling catches calls if webhooks are missed.

1. Start a batch campaign (Test 3.2)
2. In staging server, pause/block webhook delivery (e.g., firewall rule or temp endpoint return 500)
3. Watch logs for polling fallback:
   ```
   [polling] Fetched N records, processed M, skipped K
   ```
4. Wait ~30s, verify UI still updates call states from polling

**Expected outcome:**
- Polling catches up with missed webhook events
- UI eventually converges to real state
- No hung calls

## Phase 4: Verify Infrastructure

### Checklist
- [ ] Webhook URL registered with Tata sandbox
- [ ] Webhook endpoint deployed and accessible (HTTPS, no auth needed)
- [ ] `TATA_ACCESS_TOKEN` and `TATA_BASE_URL` set on staging server
- [ ] `TELEPHONY_PROVIDER=tata` on staging (not `sim`)
- [ ] Test agents created with phone numbers in admin UI
- [ ] Single agent call places and connects (Test 3.1)
- [ ] Batch calling works with multiple concurrent calls (Test 3.2)
- [ ] Polling fallback catches events if webhooks missed (Test 3.3)
- [ ] No errors in server logs (`tail -f /var/log/recovery-karma/*`)

### Troubleshooting

**Q: Calls don't place (dial button does nothing)**
- Check `TELEPHONY_PROVIDER=tata` and `TATA_ACCESS_TOKEN` are set
- Check server logs for API errors (401 Unauthorized, 404 Not Found, etc.)
- Verify Tata API is reachable: `curl -H "Authorization: Bearer $TOKEN" https://api-smartflo.tatateleservices.com/v1/click_to_call`

**Q: Webhook events don't arrive**
- Verify webhook URL is correct: `https://{staging-url}/api/telephony/webhook`
- Check firewall/network allows inbound POST to that path
- Verify Tata has the URL registered (check Tata admin console)
- Manually test: `curl -X POST https://{staging-url}/api/telephony/webhook -d '{"$uuid":"test"}'`

**Q: Polling works but no webhooks**
- Expected! That's the fallback design
- Webhooks will arrive once network issues resolve
- Keep 30s polling interval as redundancy

**Q: Agent phone not used (calls still say "sim-agent")**
- For single calls: verify `TELEPHONY_PROVIDER=tata` (not `sim`)
- For batch calls: agent assignment not yet wired to batch dialer (future task)
- Single calls should use agent's phone from admin UI

## Next Steps (Task 3.4)

Once staging tests pass:
1. Get production Tata token and register production webhook URL
2. Deploy to production environment
3. Set `TELEPHONY_PROVIDER=tata` on production
4. Run same test flows on production (with real debtors, real calls)
5. Monitor live view and call_logs for accuracy

---

**Created:** 2026-07-28
**Status:** Ready for staging deployment
**Owner:** Development team
