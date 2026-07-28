# API requirements — RecoveryAI

What each feature in the app needs from external APIs, what Tata Tele (SmartFlo) actually
covers, and where the gaps are. Written against the pages in `src/routes/` and the existing
provider-agnostic telephony layer in `src/lib/telephony/` (currently `sim` + `kookoo`).

---

## 1. Feature → API map

| Page / feature | What it needs | API(s) |
|---|---|---|
| `dashboard.call-queue` — agent manual call + predictive dial | place call, live call state, hangup, recording | Telephony provider (Tata SmartFlo or Kookoo) via `TelephonyProvider` interface |
| `dashboard.call-queue` — disposition form | write outcome, trigger SMS/reminder | Supabase (`call_logs`) + SMS API |
| `dashboard.messages` — WhatsApp/SMS/Email chat | send + receive, delivery status | Interakt (WhatsApp), SMS provider, Email provider |
| `dashboard.payments` — payment links | create link, track paid status | Razorpay |
| `dashboard.reports`, `admin.reports` | aggregate call/payment stats | Supabase only (no external API) — CDR data feeds this if pulled from Tata |
| `dashboard.debtors` — AI score | score/re-score a debtor | Anthropic |
| `admin.portfolio`, `manager.upload` — bulk debtor upload | none external; optional dialer list sync | Tata Lead Lists API (only if using Tata's dialer/broadcast) |
| `manager.queue`, `manager.channels` — live call monitoring | live call state, monitor/whisper/barge, transfer | Telephony provider's Call Operations + Live Calls APIs |
| `manager.audit` | reads persisted `call_logs`/disposition data | Supabase only |
| AI voice bot (planned, not yet a route) | real-time audio, STT, LLM, TTS | Twilio (or similar) + Deepgram + Anthropic + ElevenLabs |

---

## 2. What Tata SmartFlo actually gives us

Confirmed from their API docs — and where each maps into the existing codebase:

| Tata SmartFlo API | Use in our app |
|---|---|
| `POST /v1/auth/login`, `/refresh`, `/logout` | Server-side token management for a new `tata-provider.ts` (parallel to `kookoo-provider.ts`). Prefer a **Permanent Access Token** to avoid hourly refresh logic. |
| `POST /v1/click_to_call` | `TelephonyProvider.startCall()` — agent clicks **Call** in `dashboard.call-queue`. `custom_identifier` = our `callLogId`, so webhooks correlate back cleanly (matches the existing `StartCallRequest.callLogId` field). |
| `POST /v1/call/hangup` | `TelephonyProvider.hangup()` |
| `GET /v1/call/records` (CDR) | Backfill/reconcile `call_logs` — duration, recording URL, hangup cause. Useful for `admin.reports` / `manager.audit` if we ever need to reconcile against Tata's own record instead of just our webhook stream. |
| `POST /v1/call/note/{id}` | Optional — could push our disposition note back into Tata's own CDR notes, but not required since we already persist disposition in Supabase. |
| `GET /v1/live_calls` | `manager.queue` — live call monitoring view. |
| `POST /v1/call/options` (Monitor/Whisper/Barge/Transfer) | `manager.channels` — manager listening in on or barging into an agent's call, or transferring to a senior agent/legal. |
| `POST /v1/user`, `GET /v1/users`, `PATCH/DELETE /v1/user/{id}` | `admin.users` — provisioning agents in Tata so they have a `caller_id`/extension to receive Click-to-Call. |
| Dialer campaigns (`/v1/dialer/campaign`, session, disposition, schedule_call) | `manager.queue` predictive-dial mode — replaces the current sim-driven "Predictive Dial" in `dashboard.call-queue` with real auto-dialing through a debtor list. |
| Broadcast (`/v1/broadcast`) | Not currently a page — would back an automated reminder-call feature for low-priority debtors, if built. |
| Leads & Lists (`/v1/broadcast/list`, `/leads`) | Sync path from `admin.portfolio` upload into a Tata dialer list, only if the predictive dialer campaigns above are adopted. |
| Account DND (`/v1/broadcast/dnd/*`), Blocked Number | Compliance gate before any auto-dial or broadcast — suppress debtors who opted out. |
| Time Group (`/v1/timegroup`) | Enforce legal calling-hour windows on campaigns/dialer — required if using Tata's dialer/broadcast, not needed for pure manual click-to-call. |

**What Tata does *not* give us:** a way to put an AI voice bot on the line. Every endpoint above
connects a call to a **human agent**, a **pre-recorded IVR menu**, or **CDR/reporting** — none of
it exposes a live, bidirectional media/audio stream that an LLM loop could read from and speak
into. That has to come from elsewhere (see §3).

**Also missing from the doc set fetched:** webhook payload shapes for call lifecycle events
(ring/answer/hangup). The `TelephonyProvider.parseStatusWebhook()` seam in
[types.ts](src/lib/telephony/types.ts) already exists for this — once Tata's webhook docs are
in hand, a `tata-provider.ts` slots in the same way `kookoo-provider.ts` does.

---

## 3. AI voice calls — the extra pieces

Tata (or any pure telephony API) only opens the line. An autonomous AI call needs this loop:

```
Debtor answers → [media stream] → [STT] → [LLM] → [TTS] → [media stream] → Debtor hears reply
```

| Layer | Service | Notes |
|---|---|---|
| Call + real-time audio transport | **Twilio Programmable Voice** (Media Streams) | Tata's APIs don't expose a real-time audio stream — this leg likely can't run on Tata. Twilio/Plivo/Exotel are the realistic options. |
| Speech-to-Text | **Deepgram** or AssemblyAI | Low-latency streaming transcription of the debtor's speech. |
| LLM brain | **Anthropic** (already planned for scoring) | Same account, different call site — drives the conversation/script logic. |
| Text-to-Speech | **ElevenLabs** (already planned) | ElevenLabs **Conversational AI Agents** can bundle STT+LLM+TTS+turn-taking into one API, which would remove the need for a separate Deepgram integration. |
| Orchestration | Our server (Nitro) | Bridges the loop, applies barge-in, writes transcript + disposition to Supabase. |

**Net new for AI calls specifically:** Twilio (or equivalent) account + Deepgram (unless
ElevenLabs Conversational AI replaces it) + a transcript-storage path in Supabase. Anthropic and
ElevenLabs are already on the roadmap for other reasons.

---

## 4. Non-telephony gaps (not yet named anywhere)

These aren't Tata-related but came up while mapping features to APIs — flagging so they're not
lost:

- **Email provider** — `messages` table has an `email` channel; no provider is named yet
  (Resend / SendGrid / SES).
- **SMS fallback provider** — for when WhatsApp isn't available/opted-in. Could be Tata's own SMS
  if using their dialer/broadcast stack, or a dedicated SMS API (MSG91, Twilio SMS).
- **Webhook receiver routes** — Razorpay (payment success), Interakt (delivery/replies), Tata
  (call lifecycle), Twilio/ElevenLabs (AI call ended) all need inbound webhook endpoints on our
  server — internal plumbing, not an external API, but needs to be built.
- **Call recording storage** — Supabase Storage or S3 for `recording_url` retention (QA,
  compliance, dispute resolution).

---

## 5. Suggested minimal path

1. **Human-agent calling (near-term):** Auth → Click-to-Call → CDR → Call Notes/Disposition →
   Live Calls (for `manager.queue`) → DND/Time Group for compliance. This is a drop-in
   `tata-provider.ts` behind the existing `TelephonyProvider` interface — no UI changes needed.
2. **AI calling (separate track):** Twilio + Deepgram (or ElevenLabs Conversational AI) +
   Anthropic. This is a new call participant type (`"ai"` already exists in
   `CallParticipant` in [types.ts](src/lib/telephony/types.ts)) — the domain model already
   anticipates it.
3. **Everything else** (payments, WhatsApp, email, SMS) is independent of the telephony choice
   and can proceed in parallel.
