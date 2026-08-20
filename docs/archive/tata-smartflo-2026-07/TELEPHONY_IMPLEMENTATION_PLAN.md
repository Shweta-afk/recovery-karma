# Telephony Implementation Plan — Tata Tele Only

**Date:** July 27, 2026  
**Status:** Planning phase  
**Scope:** Replace mock telephony with Tata SmartFlo Click-to-Call for human-agent calling only.

---

## Executive Summary

RecoveryAI's codebase has a **provider-agnostic telephony layer** designed to swap vendors without changing UI code. Currently it supports:
- **Simulator** (`sim`) — local in-browser mock, good for development
- **Kookoo** (`kookoo`) — Ozonetel CPaaS, never implemented (only TODOs)

**Decision:** Remove Kookoo entirely. Build only for **Tata Tele SmartFlo**, and treat it as the canonical provider going forward. This reduces cognitive load and avoids maintaining two vendor integrations.

---

## What Gets Built

### Phase 1: Core Click-to-Call (Manual Agent Dialing)

**Use case:** Agent clicks "Call" on a debtor in the Call Queue → phone rings → debtor answers → agent speaks → agent hangs up.

| Component | File | Status | Notes |
|---|---|---|---|
| Provider implementation | `src/lib/telephony/tata-provider.ts` | 🔨 To build | Replaces kookoo-provider; implements `TelephonyProvider` interface |
| Auth setup | `.env` | 📋 Config | Add `TATA_ACCESS_TOKEN` (Permanent Access Token from Tata support) |
| Provider registration | `src/lib/telephony/index.ts` | 🔨 Minor edit | Swap `kookoo` for `tata` in `PROVIDERS` map; keep `sim` as default for dev |
| Webhook receiver | `src/api/telephony/webhook.ts` (new) | 🔨 To build | Public HTTP endpoint that Tata POSTs call lifecycle to |
| Agent number mapping | `agents` table migration | 🔨 To build | Add `tata_agent_number` column so each agent has their SmartFlo ID |
| Manual call button | `src/lib/dialer/use-single-call.ts` | 🔨 Minor edit | Switch from in-browser `sim` to server `startCall` (server function) |
| Dialer mode toggle | Already exists | ✅ Ready | `use-dialer-run.ts` already has `mode: "local" \| "server"` — just flip to server mode |

### Phase 2: Recording + CDR Backfill (Future, not now)

Tata doesn't send `recording_url` in the webhook — it needs a follow-up query to `GET /v1/call/records` to backfill the recording URL and exact call duration. Deferred until Phase 1 is live and working.

---

## Why Kookoo is Being Removed

| Aspect | Kookoo | Tata Tele |
|---|---|---|
| **Implementation** | Stubbed TODOs only; never had a real account | Vendor you've already chosen; API docs are public |
| **Auth complexity** | Needs login/refresh token cycle (1-hour expiry) | Permanent Access Token (no refresh logic) |
| **Webhook support** | Unknown (docs not reviewed) | Confirmed in public docs; shape documented |
| **Maintenance burden** | Two provider implementations to keep in sync | One path → less code debt |
| **Cost** | Unknown | Already budgeted by client |

**Outcome:** `kookoo-provider.ts` will be deleted. The provider abstraction stays (good design), but it's 1:1 Tata only from here forward.

---

## Architectural Decisions

### Provider Interface (No Change)

The `TelephonyProvider` interface in [types.ts](src/lib/telephony/types.ts) stays unchanged:

```typescript
export interface TelephonyProvider {
  name: string;
  startCall(req: StartCallRequest): Promise<StartCallResult>;
  hangup(providerCallId: string): Promise<void>;
  sendSms(req: SendSmsRequest): Promise<SendSmsResult>;
  parseStatusWebhook(payload: unknown): CallStatusEvent;
  subscribe?(listener: TelephonyEventListener): () => void; // optional; Tata uses webhook instead
}
```

This abstraction remains valuable for testing and for future non-voice additions (e.g., if we later add IVR or AI-bot handling).

### Webhook → Server Function → Dialer State

The webhook flow:

```
Tata sends: POST /api/telephony/webhook
  {
    $uuid: "call-abc123",
    $call_status: "answered by customer",
    $duration: 120,
    $hangup_cause: "normal"
  }

Our webhook route (tata-provider.ts or routes/api):
  1. Parse payload via tataProvider.parseStatusWebhook()
  2. Call ingestProviderWebhook() (existing logic in server.ts)
  3. This mutates in-memory dialer run + advances call state
  4. Return 200 OK to Tata
```

**Why:** `ingestProviderWebhook` already handles state advancement; we're just adding the HTTP entry point.

### Agent Number Mapping

Tata's `POST /v1/click_to_call` requires `agent_number`, which is the agent's SmartFlo-registered phone or extension ID. Today, `agents` table has no such column.

**Solution:** Add a migration that adds `agents.tata_agent_number TEXT`.

How it flows:
1. Admin provisions agent in Tata dashboard → gets a number (e.g., `050XXXXXXX0`)
2. Admin records that number in RecoveryAI's agent record
3. When agent clicks "Call", `startCall()` fetches `agent.tata_agent_number` from Supabase
4. Passes it to Tata's API

**Future:** This could be automated via Tata's `POST /v1/user` API once admin panel supports creating agents directly (Phase 2 work).

---

## Implementation Sequence

### Week 1: Foundation

1. **Migration:** Add `tata_agent_number` to `agents` table
2. **Env setup:** Add `TATA_ACCESS_TOKEN` to `.env.example` and `.env.local`
3. **Provider:** Write `src/lib/telephony/tata-provider.ts`
   - Implement `startCall()` → `POST /v1/click_to_call`
   - Implement `hangup()` → `POST /v1/call/hangup`
   - Implement `parseStatusWebhook()` for the two webhook events (answered / missed)
   - Stub `sendSms()` with `throw new Error("not implemented — Phase 3")`
   - No `subscribe()` (Tata uses webhooks, not push events)
4. **Register:** Update `src/lib/telephony/index.ts` to export `tataProvider`

### Week 2: Wiring & Webhook

5. **Webhook route:** Create public HTTP endpoint (exact path TBD pending TanStack Start routing discovery)
   - Route: `POST /api/telephony/webhook` (best guess)
   - Receives raw Tata payload
   - Calls `ingestProviderWebhook()` logic
   - Responds 200 OK
6. **Manual call path:** Update `use-single-call.ts`
   - Add `mode: "local" | "server"` similar to `use-dialer-run.ts`
   - Use `server.startCall()` when mode is server (real provider)
   - Keep `sim` for local dev
7. **Default provider env:** Set `TELEPHONY_PROVIDER=sim` in dev, `TELEPHONY_PROVIDER=tata` in staging/prod

### Week 3: QA & Cutover

8. **Test in sandbox:** Register webhook in Tata's sandbox dashboard; place test calls
9. **Monitor:** Watch logs for webhook deliveries, call state transitions, recording URLs
10. **Go live:** Switch production `TELEPHONY_PROVIDER` to `tata`

### Later (Phase 2+): Skip Kookoo Cleanup

11. **Remove Kookoo:** Once Tata is live in production for 2+ weeks, delete `src/lib/telephony/kookoo-provider.ts` entirely. It's dead code.

---

## Key Tata API Details

### Click-to-Call
**Endpoint:** `POST https://api-smartflo.tatateleservices.com/v1/click_to_call`

**Request:**
```json
{
  "agent_number": "050XXXXXXX0",
  "destination_number": "+919876543210",
  "caller_id": "050XXXXXXX0",
  "custom_identifier": "callLogId-abc123",
  "async": 1,
  "call_timeout": 300
}
```

**Response:**
```json
{
  "success": true,
  "call_id": "call-uuid-from-tata"
}
```

### Hangup
**Endpoint:** `POST https://api-smartflo.tatateleservices.com/v1/call/hangup`

**Request:**
```json
{
  "call_id": "call-uuid-from-tata"
}
```

### Webhook (inbound)

Tata POSTs to your registered endpoint. Example payload:

**Answered:**
```json
{
  "$uuid": "call-uuid-from-tata",
  "$call_to_number": "+919876543210",
  "$caller_id_number": "050XXXXXXX0",
  "$answer_agent_number": "050XXXXXXX0",
  "$start_stamp": 1706000000,
  "$answer_stamp": 1706000015,
  "$end_stamp": 1706000120,
  "$call_status": "answered by customer",
  "$duration": 105,
  "$customer_ring_time": 5
}
```

**Missed:**
```json
{
  "$uuid": "call-uuid-from-tata",
  "$call_to_number": "+919876543210",
  "$caller_id_number": "050XXXXXXX0",
  "$start_stamp": 1706000000,
  "$end_stamp": 1706000030,
  "$call_status": "missed",
  "$duration": 30,
  "$hangup_cause": "no-answer"
}
```

**Your endpoint must respond with 200 OK within 30 seconds, or Tata retries.**

### Auth
**Header:** `Authorization: Bearer <TATA_ACCESS_TOKEN>`

On all API calls (except webhooks, which have no auth — they're one-way pushes).

---

## Testing Strategy

### Local Development
- Keep `TELEPHONY_PROVIDER=sim` by default
- `use-single-call.ts` and `use-dialer-run.ts` both run in `mode: "local"` by default
- No real calls, no Tata keys needed

### Staging (Tata Sandbox)
- `TELEPHONY_PROVIDER=tata`
- `TATA_ACCESS_TOKEN=<sandbox-token>`
- Register webhook URL in Tata's dashboard (sandbox)
- Place real calls through Tata's sandbox SIP trunk
- Verify webhook payloads arrive and advance call state
- Record the webhook payload shapes for documentation

### Production
- `TELEPHONY_PROVIDER=tata`
- `TATA_ACCESS_TOKEN=<production-token>`
- Register webhook URL in Tata's production dashboard
- Monitor call success rate, webhook latency, error logs

---

## Environment Variables

Add to `.env.example` and `.env.local` (dev):

```bash
# Telephony provider: "sim" (development), "tata" (production)
TELEPHONY_PROVIDER=sim

# Tata Tele SmartFlo API authentication
# Request a Permanent Access Token from your Tata Tele account manager
TATA_ACCESS_TOKEN=<your-permanent-token-here>

# Webhook callback URL (so Tata knows where to send call lifecycle events)
# Set this in Tata's dashboard and ensure it matches your actual deployment URL
TATA_WEBHOOK_URL=https://recovery-karma.onrender.com/api/telephony/webhook
```

---

## FAQ

**Q: Why not keep Kookoo as a fallback?**  
A: Maintaining two providers doubles the test matrix, the bugs, and the cognitive load. Tata is the chosen vendor; simpler to own that one path completely.

**Q: What if we want to switch to a different vendor later?**  
A: The provider abstraction is there. Write a new `other-provider.ts` and swap it in `index.ts`. Takes one file + one env var change.

**Q: When do we add SMS and WhatsApp?**  
A: Phase 3. SMS has a native `sendSms()` method on `TelephonyProvider` already (DLT templates), so it slots in. WhatsApp via Tata Omnichannel is TBD pending API confirmation from Tata's account team (we found no public API docs).

**Q: What about AI voice calls?**  
A: Phase 2. Separate track using Twilio (for real-time audio) + Deepgram/ElevenLabs. Doesn't affect Tata's human-agent call path.

**Q: Do we need a background job to fetch recordings?**  
A: Not yet. Tata's webhook doesn't include `recording_url`, so we'd need to poll `GET /v1/call/records` to backfill it. Deferred to Phase 2.

---

## Rollback Plan

If Tata integration fails in production:

1. Set `TELEPHONY_PROVIDER=sim` (reverts to simulator; no real calls)
2. Revert any database migrations (rollback `tata_agent_number` column)
3. Redeploy

Impact: Calling stops working, but UI doesn't crash. Agents see a toast error ("provider unavailable") instead of silent hangs.

---

## Related Documents

- [API_REQUIREMENTS.md](API_REQUIREMENTS.md) — full feature-to-vendor mapping
- [CLAUDE.md](CLAUDE.md) — project architecture + workflow
- [QA_CHECKLIST.md](QA_CHECKLIST.md) — manual testing checklist (update post-Tata integration)
