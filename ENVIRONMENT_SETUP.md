# Environment Setup Guide

Configuration for RecoveryAI across development, staging, and production environments.

---

## Environment Variables Reference

### Supabase (Required for all environments)

| Variable | Where to Get | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase dashboard → Settings → API | URL of your Supabase project |
| `VITE_SUPABASE_ANON_KEY` | Supabase dashboard → Settings → API → `anon` key | Public key for browser (no secrets) |
| `SUPABASE_URL` | Supabase dashboard → Settings → API | Same as VITE_SUPABASE_URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → `service_role` key | Secret key for server-side queries (RLS bypass) |

### API Keys (Required for all environments)

| Variable | Where to Get |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic console → API keys → Create key |
| `INTERAKT_API_KEY` | Interakt dashboard → API settings |
| `RAZORPAY_KEY_ID` | Razorpay dashboard → Settings → API Keys |
| `RAZORPAY_KEY_SECRET` | Razorpay dashboard → Settings → API Keys |
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard → API keys |

### Telephony Provider (New — Task 1.2)

| Variable | Development | Staging | Production |
|---|---|---|---|
| `TELEPHONY_PROVIDER` | `sim` | `tata` | `tata` |
| `TATA_ACCESS_TOKEN` | (empty, not needed) | sandbox-token | production-token |
| `TATA_BASE_URL` | (empty) | https://api-smartflo.tatateleservices.com/v1 | https://api-smartflo.tatateleservices.com/v1 |
| `TATA_WEBHOOK_URL` | (not used) | https://staging-recovery-karma.onrender.com/api/telephony/webhook | https://recovery-karma.onrender.com/api/telephony/webhook |

---

## Setup by Environment

### 1. Local Development (.env.local)

**Goal:** Run the app locally with simulated calling (no Tata account needed).

**Current state:** `.env.local` is already configured for you.

**To verify:**
```bash
cat .env.local | grep TELEPHONY_PROVIDER
# Should output: TELEPHONY_PROVIDER=sim
```

**If you want to test against Tata Sandbox:**

1. Ask your Tata account manager for a **sandbox token** (separate from production)
2. Update `.env.local`:
   ```bash
   TELEPHONY_PROVIDER=tata
   TATA_ACCESS_TOKEN=<sandbox-token-from-tata>
   TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1
   TATA_WEBHOOK_URL=http://localhost:5173/api/telephony/webhook  # local dev
   ```
3. Use ngrok to expose localhost:
   ```bash
   ngrok http 5173
   # Get a public URL like https://abc123.ngrok.io
   ```
4. Update `.env.local` TATA_WEBHOOK_URL to that ngrok URL
5. Register the ngrok URL in Tata's **sandbox** dashboard (API Connect → Webhook)
6. Test a call

**Revert back to sim mode:**
```bash
echo "TELEPHONY_PROVIDER=sim" >> .env.local
```

---

### 2. Staging (Render preview/staging URL)

**Goal:** Test with Tata's sandbox before going live.

**Setup:**

1. In Render dashboard, create a new environment or use preview deployments
2. Set environment variables:
   ```
   TELEPHONY_PROVIDER=tata
   TATA_ACCESS_TOKEN=<sandbox-token-from-tata>
   TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1
   TATA_WEBHOOK_URL=https://staging-recovery-karma.onrender.com/api/telephony/webhook
   ```
3. Deploy the branch
4. In Tata dashboard, register the webhook URL in **sandbox** mode
5. Place test calls, verify recordings and call_logs are written

**When ready for production:** Get production token from Tata support.

---

### 3. Production (recovery-karma.onrender.com)

**Goal:** Live collections with real calls.

**Setup:**

1. Tata Tele contacts: Get production access token and production API URL (usually same)
2. In Render dashboard, set environment variables:
   ```
   TELEPHONY_PROVIDER=tata
   TATA_ACCESS_TOKEN=<production-token-from-tata>
   TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1
   TATA_WEBHOOK_URL=https://recovery-karma.onrender.com/api/telephony/webhook
   ```
3. In Tata production dashboard, register webhook URL under API Connect → Webhook
4. Deploy main branch
5. Smoke test: place 3–5 real calls, verify they connect and are recorded

---

## Getting Tata Tokens

### Sandbox Token (for testing)

1. Contact your Tata Tele account manager
2. Request: "Sandbox/UAT Permanent Access Token for SmartFlo API"
3. They provide a token that works against Tata's sandbox API
4. Token does not expire (it's a "Permanent" token)

### Production Token

1. Contact your Tata Tele account manager
2. Request: "Production Permanent Access Token for SmartFlo API"
3. They verify your business and provide a production token
4. Same token format, works against `https://api-smartflo.tatateleservices.com/v1`

---

## Checklist

### Local Development
- [ ] `.env.local` has `TELEPHONY_PROVIDER=sim`
- [ ] `bun run dev` starts without env var warnings
- [ ] Can click "Call" in dashboard and see simulated dialing

### Before Staging Deploy
- [ ] Sandbox migration applied to Supabase
- [ ] `agent_phone` and `provider_agent_id` columns exist
- [ ] All agents have `agent_phone` populated (admin panel editable)
- [ ] `.env` file prepared with sandbox token
- [ ] Webhook URL registered in Tata sandbox dashboard

### Before Production Deploy
- [ ] Staging tests pass (real Tata sandbox calls work)
- [ ] Production token acquired from Tata
- [ ] Webhook URL registered in Tata production dashboard
- [ ] All agents have `agent_phone` populated
- [ ] Rollback plan documented (flip TELEPHONY_PROVIDER back to sim)
- [ ] Monitoring/alerting set up (webhook delivery, call success rate)

---

## Troubleshooting

### "TATA_ACCESS_TOKEN is not set" error

**Problem:** App started with `TELEPHONY_PROVIDER=tata` but no token provided.

**Solution:**
```bash
# Check if env var is set
echo $TATA_ACCESS_TOKEN

# If empty, add it to .env.local or Render dashboard
export TATA_ACCESS_TOKEN=your_token_here
bun run dev
```

### Webhook not being received

**Problem:** Call placed in Tata, but webhook doesn't arrive at your app.

**Checklist:**
1. Check Tata dashboard → API Connect → Webhook → verify URL is registered and **enabled**
2. If local dev: Is ngrok tunnel still running? URL changes each restart
3. Check server logs for "POST /api/telephony/webhook" — are requests arriving?
4. Test webhook manually:
   ```bash
   curl -X POST http://localhost:5173/api/telephony/webhook \
     -H "Content-Type: application/json" \
     -d '{"$uuid":"test-123","$call_status":"answered by customer"}'
   ```

### "Agent not found" or "agent_phone is null"

**Problem:** Agent exists in database but `agent_phone` is empty.

**Solution:**
1. Go to admin → Users page
2. Edit the agent and fill in "Tata Agent Number" field
3. Make sure it matches what's registered in Tata dashboard (e.g., 050XXXXXXX0)
4. Save and retry

---

## Security Notes

- **Never commit `.env.local`** to git (it has real tokens)
- **`.env.example` is safe** to commit (has no real values)
- **TATA_ACCESS_TOKEN is a secret** — treat like a password
- **Service role key has full DB access** — only use in server-side code, never expose to browser
- **Rotate tokens quarterly** as a security best practice

---

## Next Steps

Once environment is set up:
- Move to **Task 1.3:** Write `tata-provider.ts` (Tata API implementation)
