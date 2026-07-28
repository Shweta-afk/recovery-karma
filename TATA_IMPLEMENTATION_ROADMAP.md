# Tata Tele Implementation Roadmap

**Scope:** Wire Tata SmartFlo for human-agent Click-to-Call + call lifecycle management (no AI, no messaging yet)

**Timeline:** 2–3 weeks, Phase 1 only

---

## Deliverables

By end of Phase 1, the following work:
- ✅ Agent clicks "Call" → real call placed through Tata (not simulator)
- ✅ Call state (ringing → connected → ended) flows to UI in real-time
- ✅ Recording URL captured and stored
- ✅ Call outcome (PTP/paid/refused) logged to `call_logs`
- ✅ Manager sees live calls in real-time monitoring page
- ✅ All compliance controls (DND, calling hours) enforced in Tata dashboard

**Out of scope (Phase 2+):**
- AI voice calls
- WhatsApp/SMS messaging
- Predictive dialer campaigns
- Advanced call routing (IVR, transfers to legal teams)

---

## Implementation Tasks

### Week 1: Foundation

#### Task 1.1: Database Schema Update
**File:** `src/supabase/migrations/YYYYMMDD_add_tata_fields.sql`

Add columns to `agents` table:
```sql
ALTER TABLE agents ADD COLUMN agent_phone TEXT;
ALTER TABLE agents ADD COLUMN provider_agent_id TEXT;
```

Why: Tata requires an `agent_number` (SmartFlo-registered phone/extension) for Click-to-Call.

**Acceptance:** Migration runs without error; `agents` table has both columns.

---

#### Task 1.2: Environment Setup
**File:** `.env.example`, `.env.local`

Add:
```bash
# Telephony provider: "sim" (dev), "tata" (staging/prod)
TELEPHONY_PROVIDER=sim

# Tata Tele SmartFlo API
TATA_ACCESS_TOKEN=<permanent-token-from-tata-support>
TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1

# Webhook callback (register this URL in Tata dashboard)
TATA_WEBHOOK_URL=https://recovery-karma.onrender.com/api/telephony/webhook
```

**Acceptance:** `.env.example` has all three vars; `.env.local` has real token for testing.

---

#### Task 1.3: Tata Provider Implementation
**File:** `src/lib/telephony/tata-provider.ts`

Implement `TelephonyProvider` interface:

```typescript
export const tataProvider: TelephonyProvider = {
  name: "tata",
  
  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    // POST /v1/click_to_call
    // Returns: { call_id: "..." }
  },
  
  async hangup(providerCallId: string): Promise<void> {
    // POST /v1/call/hangup
  },
  
  sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
    // Not implemented yet — throw error
    throw new Error("SMS: deferred to Phase 3");
  },
  
  parseStatusWebhook(payload: unknown): CallStatusEvent {
    // Parse Tata webhook (answered / missed)
    // Return normalized { providerCallId, status, durationSeconds, recordingUrl }
  }
};
```

**Acceptance:** All four methods exist; tests pass for click-to-call and hangup; webhook parsing handles Tata's two event types (answered/missed).

---

#### Task 1.4: Provider Registration
**File:** `src/lib/telephony/index.ts`

Update `PROVIDERS` map:

```typescript
const PROVIDERS: Record<string, () => TelephonyProvider> = {
  sim: getSimProvider,
  tata: () => tataProvider,  // ADD THIS
};
```

Keep `sim` as default in dev. Flip to `tata` in production via `TELEPHONY_PROVIDER` env var.

**Acceptance:** `getTelephonyProvider()` returns `tataProvider` when `TELEPHONY_PROVIDER=tata`.

---

### Week 2: Webhook & Wiring

#### Task 2.1: Webhook Route
**File:** `src/routes/api/telephony/webhook.ts` (new)

Public HTTP endpoint that Tata POSTs to:

```typescript
export async function POST(req: Request) {
  const payload = await req.json();
  
  // Validate it's from Tata (basic check: has $uuid field)
  if (!payload.$uuid) return new Response("Invalid", { status: 400 });
  
  // Parse into our normalized CallStatusEvent
  const status = tataProvider.parseStatusWebhook(payload);
  
  // Call the same ingestProviderWebhook logic from server.ts
  await ingestProviderWebhook(status);
  
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}
```

**Acceptance:** Route responds 200 OK to webhook POSTs; call state updates in real-time.

---

#### Task 2.2: Polling Background Job
**File:** `src/lib/telephony/polling.ts` (new)

Background job that polls every 30 seconds:

```typescript
export async function startPollingJob() {
  setInterval(async () => {
    // GET /v1/call/records?from_date=last_2_minutes
    const records = await getTataCallRecords(2);
    
    // For each call in "dialing" or "ringing" state
    for (const record of records) {
      const event = parseCallRecordToEvent(record);
      await ingestProviderWebhook(event);
    }
  }, 30000); // 30 seconds
}
```

**Acceptance:** Job runs in background; fetches call records every 30s; catches any missed webhooks.

---

#### Task 2.3: Start Polling on Server Boot
**File:** `src/lib/telephony/server.ts` (edit)

Add at module level:

```typescript
import { startPollingJob } from "./polling";

// Start polling job when server starts
if (typeof process !== "undefined") {
  startPollingJob();
}
```

**Acceptance:** Server logs "Polling job started"; polling runs without errors.

---

#### Task 2.4: Manual Call Button — Server Mode
**File:** `src/lib/dialer/use-single-call.ts` (edit)

Switch from in-browser simulator to server-side call:

```typescript
export function useSingleCall(...): UseSingleCall {
  const dial = useCallback(
    (debtor: QueueDebtor) => {
      // Get the agent's Tata number from context/store
      const agentTataNumber = getCurrentAgent().agent_phone;
      
      // Call server function instead of creating sim
      startTransition(async () => {
        const { providerCallId } = await startCall({
          agentNumber: agentTataNumber,
          debtorNumber: debtor.phone,
          callLogId: debtor.id,
          aiScore: debtor.aiScore,
        });
        // UI updates via state machine from webhook
      });
    },
    [...],
  );
  
  return { dial, hangup, reset };
}
```

**Acceptance:** Clicking "Call" invokes `startCall` server function; real Tata call placed.

---

#### Task 2.5: Dialer Run — Switch to Server Mode
**File:** `src/lib/dialer/use-dialer-run.ts` (edit)

Update default `mode` to "server" for predictive dialing:

```typescript
export async function start({ 
  settings, 
  targets, 
  agentsAvailable = 3, 
  mode = "server"  // Changed from "local"
}: StartArgs) {
  // Rest stays the same; server mode calls real provider
}
```

**Acceptance:** Predictive dial starts via server; real calls placed through Tata.

---

### Week 3: Integration & QA

#### Task 3.1: Wire Agent Number to UI
**File:** `src/routes/admin.users.tsx` (edit)

Add field to agent edit form:

```typescript
<Input 
  label="Tata Agent Number" 
  value={agent.agent_phone}
  onChange={(val) => updateAgent({ agent_phone: val })}
  placeholder="e.g., 050XXXXXXX0"
/>
```

**Acceptance:** Admin can view/edit `agent_phone` for each agent.

---

#### Task 3.2: Fetch Agent Number in Call
**File:** `src/lib/telephony/server.ts` (edit)

When `startCall` is invoked:

```typescript
export const startCall = createServerFn(...)
  .handler(async ({ data }) => {
    // If agentNumber is an email/ID, fetch agent_phone from Supabase
    const agent = await supabase.from("agents").select("agent_phone").eq("id", data.agentNumber).single();
    
    const { providerCallId } = await getTelephonyProvider().startCall({
      agentNumber: agent.agent_phone,  // Use Tata number
      debtorNumber: data.debtorNumber,
      callLogId: data.callLogId,
      ...
    });
    
    return { providerCallId };
  });
```

**Acceptance:** Real Tata number passed to API; calls actually connect.

---

#### Task 3.3: Staging Test — Sandbox
**File:** `.env.staging`

```bash
TELEPHONY_PROVIDER=tata
TATA_ACCESS_TOKEN=<sandbox-token-from-tata>
TATA_WEBHOOK_URL=https://staging-recovery-karma.onrender.com/api/telephony/webhook
```

**Steps:**
1. Register webhook URL in Tata **sandbox** dashboard (API Connect → Webhook)
2. Deploy to staging
3. Place test call via Tata sandbox
4. Verify webhook received + call state updates

**Acceptance:** Call connects in sandbox; webhook arrives and updates UI.

---

#### Task 3.4: Production Deployment
**File:** `.env.production`

```bash
TELEPHONY_PROVIDER=tata
TATA_ACCESS_TOKEN=<production-token-from-tata>
TATA_WEBHOOK_URL=https://recovery-karma.onrender.com/api/telephony/webhook
```

**Steps:**
1. Get production token from Tata account manager
2. Register webhook URL in Tata **production** dashboard
3. Deploy to production
4. Place live call with real agent
5. Monitor logs for 24 hours

**Acceptance:** Production calls work; webhook latency <2s; error logs clean.

---

#### Task 3.5: QA & Manual Testing
**File:** `QA_CHECKLIST.md` (update)

Add to checklist:

- [ ] **Manual call (single):** Agent clicks Call → ring → answer → speak → hang up
- [ ] **Call state:** UI shows ringing, then connected, then ended
- [ ] **Recording:** Call recording URL captured and displayed
- [ ] **Disposition:** Agent submits outcome → call_logs written
- [ ] **Predictive dial:** Multiple calls dial concurrently; live view shows all
- [ ] **Manager monitoring:** Manager sees active calls in real-time
- [ ] **Webhook resilience:** Simulate webhook drop → polling catches call state within 30s
- [ ] **Compliance:** Debtor on DND list → call blocked (Tata rejects)

**Acceptance:** All items pass; no errors in logs; calls stable for 8+ hours.

---

## File Structure After Implementation

```
src/
├── lib/telephony/
│   ├── types.ts                  (unchanged — provider interface)
│   ├── index.ts                  (edit: register tata provider)
│   ├── call-machine.ts           (unchanged)
│   ├── sim-provider.ts           (unchanged — keep for local dev)
│   ├── kookoo-provider.ts        (DELETE this file entirely)
│   ├── tata-provider.ts          (NEW — Tata implementation)
│   ├── server.ts                 (edit: start polling, fetch agent number)
│   └── polling.ts                (NEW — background polling job)
├── dialer/
│   ├── use-single-call.ts        (edit: use server mode)
│   ├── use-dialer-run.ts         (edit: default to server mode)
│   └── ...
└── routes/
    ├── api/telephony/
    │   └── webhook.ts            (NEW — webhook receiver)
    ├── admin.users.tsx           (edit: add agent_phone field)
    └── ...

.env.example                       (edit: add TATA_* vars)
.env.local                         (TATA_ACCESS_TOKEN for dev)
.env.staging                       (TATA_* for staging)
.env.production                    (TATA_* for production)
```

---

## Checklist for Launch

- [ ] Tata Account Setup
  - [ ] Get Permanent Access Token from Tata support
  - [ ] Create sandbox account (if not included with production)
  - [ ] Confirm Tata-provided documentation on webhook payload format
  - [ ] Get list of 3–5 test phone numbers to use for testing

- [ ] Code Implementation (Tasks 1.1–2.5 above)
  - [ ] Database migration applied
  - [ ] `tata-provider.ts` written and tested
  - [ ] Webhook route created
  - [ ] Polling job implemented
  - [ ] UI wired to server mode
  - [ ] Agent numbers editable in admin panel

- [ ] Staging Test (Task 3.3)
  - [ ] Deploy to staging with sandbox credentials
  - [ ] Register webhook URL in Tata sandbox dashboard
  - [ ] Place 5 test calls; all connect
  - [ ] Verify recordings captured
  - [ ] Verify call_logs written
  - [ ] Test webhook + polling resilience (disable webhook, verify polling catches up)

- [ ] Production Rollout (Task 3.4)
  - [ ] Get production token from Tata
  - [ ] Register webhook in production dashboard
  - [ ] Deploy with `TELEPHONY_PROVIDER=tata`
  - [ ] Agent places 3–5 live calls
  - [ ] Monitor logs for 24 hours (zero errors)
  - [ ] Confirm recording URLs work
  - [ ] Confirm call_logs persisted to Supabase

- [ ] Documentation
  - [ ] Update TELEPHONY_IMPLEMENTATION_PLAN.md with actual webhook payload shapes
  - [ ] Add Tata support contact/escalation path to runbooks
  - [ ] Document how to provision a new agent in Tata (one-time, once we automate it in Phase 2)

---

## Rollback Plan

If something breaks in production:

1. Set `TELEPHONY_PROVIDER=sim` (reverts to simulator; UI doesn't break)
2. Notify support team
3. Investigate logs
4. Roll back to previous git commit if needed
5. Re-deploy

Impact: Calling stops working (agents see error toast), but UI stays up. No data loss.

---

## Success Criteria

1. ✅ Agent places call → Tata connects → UI updates in real-time
2. ✅ Call recordings captured and stored
3. ✅ Call outcomes logged to `call_logs` and persisted to Supabase
4. ✅ Manager live-view shows active calls in real-time
5. ✅ 99.9% webhook delivery (monitored via logs)
6. ✅ Webhook latency <2 seconds
7. ✅ Polling catches any missed webhooks within 30 seconds
8. ✅ Zero errors in production logs over 24-hour test window
