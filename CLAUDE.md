# RecoveryAI (product name "SamvadX") — Project Context & Workflow

## Naming note

The repo/internal codename is **RecoveryAI**. The user-facing product is branded
**SamvadX** (by Axiotta Technologies Private Limited) — that's what appears on the login
screen, page titles (`· SamvadX`), and footer. Don't be thrown by the mismatch; they're the
same app.

## Project Overview

An AI-assisted collections platform for debt recovery agents: agents call/message debtors,
log outcomes, and the system prioritizes the call queue. Built with React + Vite + TanStack
Start + Supabase.

**Status:** Live in production (Railway, `axiora.axiotta.com`). Most core pages are wired to
real Supabase data. A few pages are still mock/placeholder — see "Page-by-page status" below.
**This file was rewritten from scratch on 2026-08-20** because the previous version described
a Phase 1/2/3 plan (TanStack Query hooks in `src/lib/queries.ts`, Razorpay, Interakt,
Anthropic-scored debtors) that was **never actually built that way** — the app evolved a
different, consistent pattern instead. Trust this file over any older doc that contradicts it
(see "Other docs in this repo" at the bottom — several are badly stale, describing an entirely
different Cloudflare D1 backend from an earlier iteration of the project).

---

## Architecture

### Tech Stack (verified against `package.json`)

- **Frontend:** React 19 + TanStack Router (file-based) + `@tanstack/react-query` is
  installed and mounted at the router root, but **nothing in the app calls `useQuery`** — see
  "Data layer" below for the pattern actually used.
- **Backend:** TanStack Start (nitro, `preset: "node"`) + Node 22 (`.nvmrc`)
- **Database:** Supabase Postgres + Row-Level Security
- **Package manager:** bun
- **UI:** Tailwind CSS v4 + shadcn/ui (Radix primitives)
- **Real external APIs wired:** Supabase, Exotel (telephony), Groq (Whisper transcription),
  Gemini (tone classification). **Present in `.env.example` but NOT wired to anything:**
  `ANTHROPIC_API_KEY`, `INTERAKT_API_KEY`, `RAZORPAY_KEY_ID`/`SECRET`,
  `ELEVENLABS_API_KEY`/`VOICE_ID` — zero references in `src/`. Don't assume any of these do
  something; see "What's real vs. aspirational" below.

### Build & Deploy

- **Vite config:** Uses `@lovable.dev/vite-tanstack-config` with `nitro: { preset: "node" }`
- **Build output:** `dist/` (client) + `.output/server/` (nitro server)
- **Start command:** `node .output/server/index.mjs`
- **Deployment:** Railway (`railway.json`, nixpacks builder). Project `bubbly-communication`,
  service `recoveryai-app`. Custom domain `axiora.axiotta.com` (DNS on Cloudflare,
  `axiotta.com` zone) alongside the default `*.up.railway.app` domain. Auto-deploys on push to
  `main`, GitHub repo `Shweta-afk/recovery-karma`.
- **⚠️ Railway's env vars can silently drift from `.env.local`/`.env.example`.** This has
  already broken production once: `TELEPHONY_PROVIDER` stayed `"tata"` on Railway for over a
  week after Tata was removed from the code, silently no-op'ing every call in production. When
  touching any env-dependent feature, check Railway's Variables tab actually matches — don't
  assume local and deployed env are in sync.

### User roles & routes

| Role    | Entry route  | What they do                                                                |
| ------- | ------------ | ---------------------------------------------------------------------------- |
| Agent   | `/dashboard` | Work the call queue, log outcomes, view debtor profiles, daily targets       |
| Manager | `/manager`   | Upload portfolios, assign accounts, audit calls, view team performance       |
| Admin   | `/admin`     | Assign portfolios to managers, manage teams/users, org settings, reports     |

`login.tsx` routes by `role` after auth: `admin` → `/admin`, `manager` → `/manager`, else
`/dashboard`. Route files live in `src/routes/`; nested routes use dot-notation
(`dashboard.call-queue.tsx`). `src/routeTree.gen.ts` is auto-generated — never hand-edit it.

---

## Data layer — the actual pattern (read this before wiring any new page)

There is no `src/lib/queries.ts` and no TanStack Query hooks anywhere in the app. Instead,
every resource has its own **`*-store.ts`** file in `src/lib/` following one consistent shape:

```typescript
// getX() — sync read from an in-memory/localStorage cache. Safe default ([] or similar).
export function getPortfolios(): UploadedPortfolio[] { ... }

// refreshX() — async: queries Supabase (joining whatever debtor/agent/portfolio context the
// UI needs), writes the result into the cache, then dispatches a CustomEvent so every open
// component picks up the change without a page reload.
export async function refreshPortfolios(): Promise<void> {
  const { data } = await supabase.from("portfolios").select(/* ... */);
  cache = data;
  window.dispatchEvent(new CustomEvent("portfolios-updated"));
}

// saveX() / other writes — call Supabase directly, then call refreshX() themselves so the
// cache and every listener update immediately.
export async function updatePortfolioMeta(id: string, patch: Partial<PortfolioSettings>) {
  await supabase.from("portfolios").update(patch).eq("id", id);
  await refreshPortfolios();
}
```

A route typically does: call `getX()` for an immediate render, call `refreshX()` in a
`useEffect` on mount, and listen for the `x-updated` event (often via the shared
`useStorageSync` hook in `src/lib/storage-sync.ts`) so a write from *anywhere else* in the app
shows up live.

**Existing stores** (`src/lib/*-store.ts`): `portfolio-store.ts` (portfolios + debtors, the
biggest one), `disposition-store.ts` (call_logs — also backs the Calls tab on debtor
profiles, Call Audit, and the IVR tab on Messages), `payments-store.ts`
(payments + settlement_requests), `messages-store.ts`, `team-store.ts` (agents/teams),
`client-store.ts`, `escalation-store.ts`, `notification-store.ts`, `org-settings-store.ts`,
`ptp-escalation-store.ts`, `reminder-store.ts`, `retention-store.ts`,
`mapping-template-store.ts` (CSV column-mapping templates).

**If asked to wire another page/table, match this pattern** — it's a deliberate, established
convention across the whole app, not an oversight. Don't introduce `useQuery` for it.

### Server actions

Live directly as flat files, `src/lib/*.server.ts` (there is **no** `src/lib/server/`
subdirectory — an older plan called for one, never happened). Use TanStack's
`createServerFn`. Real ones: `call-sentiment-actions.server.ts` (Groq transcription + Gemini
tone classification, manager-triggered from Call Audit), `setup-actions.server.ts`,
`supabase-admin.server.ts`, `user-admin-actions.server.ts`. Telephony's server dispatch lives
in `src/lib/telephony/server.ts`.

---

## Database

### Schema (9 tables, `src/supabase/schema.sql`)

```
clients
  ├─ agents (auth_user_id, role: agent/manager/admin, daily_target)
  ├─ portfolios (lender_name, product_type, priority, total_accounts, settings jsonb)
  └─ debtors (portfolio_id, assigned_agent_id, loan_amount, outstanding_balance, dpd,
              ai_score, status, extra jsonb, ...)
      ├─ call_logs (debtor_id, agent_id, outcome, call_type, promise_amount, ...)
      ├─ messages (debtor_id, agent_id, channel: whatsapp/sms/email, content, status)
      ├─ payments (debtor_id, agent_id, amount, status, payment_type)
      ├─ disputes (debtor_id, raised_by, dispute_type, status)
      └─ settlement_requests (debtor_id, requested_by, proposed_amount, status)
```

**RLS:** every table is scoped by `client_id` via helper functions (`auth_client_id()` etc.),
plus per-role visibility rules on top (agents see only their own rows; managers/admins see
their team's).

### ⚠️ The live database has drifted from `schema.sql` before — don't trust the repo file alone

Confirmed at least once: RLS was switched **off** on `agents`/`portfolios`/`debtors` in the
live project while `schema.sql` showed it enabled, and the live schema has columns
`schema.sql` doesn't (`portfolios.manager_id`/`team_id`/`settings`, `debtors.extra`). When a
security or schema question matters, verify against the running database (Supabase SQL
Editor), not just the committed SQL. `SUPABASE_SERVICE_ROLE_KEY` has been known to be stale —
if it 401s, migrations have to be pasted into the SQL Editor by hand rather than run via CLI.

### ⚠️ RLS "infinite recursion detected in policy" — a recurring failure mode, not a one-off

Hit three times across one debugging window (all downstream of scoping every table by
client_id + role — a real, necessary security fix that introduced self/mutual-referential
policy subqueries). Two distinct causes, two different fixes:

1. A `SECURITY DEFINER` function written `LANGUAGE sql` and simple enough gets **inlined** by
   Postgres's planner, silently discarding the privilege escalation `SECURITY DEFINER` is
   supposed to give — so a helper like `auth_agent_id()` called from a policy *on `agents`
   itself* recurses into that same policy. Fix: `LANGUAGE plpgsql` (never inlined).
2. Two different tables' policies querying each other (e.g. `debtors_select` reads
   `portfolios`, `portfolios_select` reads `debtors`) trips the same recursion guard even with
   a correct `SECURITY DEFINER` + `plpgsql` function. The only fix that reliably worked: wrap
   the **entire cross-table traversal** — not just the final lookup — in one function with
   `SET row_security = off` for its whole execution, so none of its internal reads (across any
   table) ever re-enter RLS. See `src/supabase/migrations/20260814_disable_row_security_in_auth_helpers.sql`
   and `20260817_fix_debtors_portfolios_mutual_recursion.sql` for worked examples.

Diagnose fast by reproducing directly in the SQL Editor (bisect the policy, don't guess from
reading it):

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"<a real auth_user_id>"}';
SELECT <same columns the failing request used> FROM <table>;
ROLLBACK;
```

Migrations live in `src/supabase/migrations/`, applied roughly chronologically (26 as of this
writing) — several of the most recent ones are exactly this class of RLS fix.

---

## Telephony

Single entry point: `src/lib/telephony/index.ts` → `getTelephonyProvider()`, keyed off the
server-side `TELEPHONY_PROVIDER` env var. **Never import a vendor file directly** from feature
code — always go through this.

| Provider | Env value | Status |
| --- | --- | --- |
| Simulator | `sim` (default) | Local dev — no real calls, drives the same dialer engine/state machine so the UI behaves identically to production |
| Exotel | `exotel` | **Production default.** Trial account KYC complete, click-to-call live. `exotel-provider.ts` implements start/hangup/SMS/webhook parsing, written from Exotel's public docs — parts of it (especially `hangup`) have not been battle-tested against every real-account edge case yet |
| KooKoo (Ozonetel) | `kookoo` | Implemented (`kookoo-provider.ts`) but not the active choice — evaluated as an alternative, not currently used in production |

**Tata SmartFlo was evaluated, went live briefly, then was fully removed on 2026-08-06** ("nothing we did was working and aligning with our goals" — user's call). If you see "Tata" or "SmartFlo" referenced anywhere outside this note, it's stale.

### The dialer's architectural ceiling — read before touching predictive/productive dialing

Click-to-call (what Exotel, KooKoo, and Tata all offer) **rings the agent's phone first**,
then bridges the debtor once the agent answers. It's a plain REST call, not an SDK, and it
cannot truly overdial — the agent leg has to be committed before the debtor is ever dialed.
**Confirmed directly against Exotel's own docs: there is no API-level predictive/progressive
dialing product.** Their "4 dialer types" marketing page is conceptual; only a flat-rate
automated campaign API is real. Exotel's own guide says customers must build the call
queue, agent-availability pool, and pacing/retry logic themselves on top of plain
click-to-call — which is exactly what `src/lib/dialer/engine.ts` does. This is the ceiling of
what click-to-call can ever do, not a bug to fix.

True predictive dialing (debtor dialed *before* an agent is committed) and browser-only
agents (no personal phone) both require **WebRTC/SIP**, which is a *separate, heavier*
Exotel onboarding ("IP-PSTN Intermix") — a new legal entity (Veeno Communications), new KYC,
Bangalore-only, feature in Alpha. **This has not been started.** Don't scaffold WebRTC
provider code assuming credentials that don't exist yet.

### Dial-mode UI naming — a deliberate rename, internal values unchanged

The buttons say **"Productive Dial"** (opens several lines at once — internally
`dialerMode: "predictive"`) and **"Progressive Dial"** (one debtor at a time, in list order —
internally `dialerMode: "productive"`). Yes, the display labels and the internal enum values
are swapped from each other on purpose (a rename commit changed only the on-screen text). Read
the code comments, not just the variable names, when working in `dashboard.call-queue.tsx`,
`manager.queue.tsx`, or `portfolio-store.ts`'s `PortfolioSettings.dialerMode`.

---

## What's real vs. aspirational

**AI call scoring is NOT an LLM call.** `debtors.ai_score` is a deterministic formula —
`Math.max(1, Math.min(10, Math.round(10 - dpd / 20)))` — computed client-side at CSV upload
time (`portfolio-store.ts`). `ANTHROPIC_API_KEY` is unused. If asked to "wire up AI scoring,"
that's still an open task, not something to assume already exists.

**There is no conversational AI voice bot.** `ELEVENLABS_API_KEY`/`VOICE_ID` are unused.
When a call log's `call_type` is `"ai"` or `"ivr"`, that's a routing category chosen by the
portfolio's `callMode` setting (`hybrid`/`ai_only`/`agent_only`/`ivr_agent` — see
`routeAnsweredCall()` in `dialer/engine.ts`), not an actual AI conversation happening.

**Call sentiment analysis IS real** — the one genuine AI feature in the app. Manager-triggered
only (never automatic) from Call Audit: Groq's Whisper API transcribes the recording, Gemini
classifies agent/debtor/overall tone. Requires
`migrations/20260814_call_logs_ai_sentiment.sql`. See `call-sentiment-actions.server.ts` and
the `AiSentimentPanel` in `manager.audit.tsx`. It's a *suggestion* alongside the manager's own
manual sentiment tag — never overwrites it.

**No Razorpay.** Payment links are provided by the lending bank directly; an agent
pastes/enters the bank's link manually, then shares it via WhatsApp/SMS/logs it. The
`razorpay_payment_id`/`razorpay_link_id` DB columns are just generic text storage for that —
not FK'd to an actual Razorpay integration. `RAZORPAY_KEY_ID`/`SECRET` in `.env.example` are
vestigial; don't build against them without confirming this has changed.

**No WhatsApp/SMS gateway.** `dashboard/messages`'s Send button writes a real row to the
`messages` table, but nothing actually reaches the debtor's phone — Interakt (or any gateway)
was never wired. `INTERAKT_API_KEY` is unused. The page is honest about this in its own UI.

---

## Page-by-page status

| Page | Status |
| --- | --- |
| `dashboard/` (Call Queue) | ✅ Real debtors via `portfolio-store.ts`, real dialer |
| `dashboard/debtors` | ✅ Real debtor list + Calls/Payments tabs. Messages/Disputes tabs are intentionally honest empty-states (no write path yet) |
| `dashboard/history` (Activity History) | ✅ Real `call_logs`, with async recording backfill |
| `dashboard/payments` | ✅ Real `payments`/`settlement_requests` via `payments-store.ts` |
| `dashboard/messages` | 🟡 Real `messages` table, but Send has no gateway behind it (see above) |
| `dashboard/reports` | ❌ Still hardcoded narrative placeholder content, not wired |
| `manager/portfolio` (Portfolio Overview) | ✅ Real, full-screen dashboard per portfolio incl. call-activity/AI-handling breakdown |
| `manager/queue`, `manager/audit`, `manager/upload`, `manager/activity` | ✅ Real |
| `admin/portfolio` (Portfolio Assignment) | ✅ Real; reuses the same full-screen dashboard as Manager Portfolio Overview, read-only |
| `admin/reports`, `admin/users`, `admin/teams`, `admin/settings` | ✅ Real |
| `admin/index` | ✅ Real (navigation tiles) |

---

## Local Setup

```bash
cd ~/recovery-karma-main
bun install
bun run dev
```

Serves on **port 8080** by default (`.claude/launch.json`), auto-incrementing to the next free
port if busy — not Vite's default 5173. HMR reloads on save.

### Testing data changes

1. Edit a `*-store.ts` file or a route.
2. HMR reloads automatically.
3. DevTools → Network tab to see the actual Supabase REST calls.
4. An RLS error means the query above's "verify against the live DB" note applies — don't
   assume `schema.sql`'s policies are what's actually enforced.

### Useful scripts

- `bun run lint` / `bun run typecheck` / `bun run format`
- `bun run test:logic` — `scripts/telephony-check.ts`, logic tests for the dialer engine
- `scripts/debug/*.js` — one-off ad-hoc Supabase debugging scripts from past incidents (RLS
  probing, etc.). Not part of any workflow; read before trusting one still applies.

---

## Common patterns

### Fetch + display

```typescript
const [items, setItems] = useState(() => getItems());
useEffect(() => {
  refreshItems();
  window.addEventListener("items-updated", () => setItems(getItems()));
}, []);
```

(Or use the shared `useStorageSync` hook from `src/lib/storage-sync.ts` to dedupe this.)

### Write + refresh

```typescript
await saveDisposition({ ...data });
// saveX already calls refreshX() internally — no manual invalidation needed
```

---

## Known cleanup opportunities (not yet done — flag if picking one up)

- `src/lib/mock-debtors.ts` still carries a ~1,200-line `MOCK_DEBTORS` literal array that
  nothing imports anymore (confirmed zero references outside the file) — dead weight. Its
  *types and helpers* from the same file (`Debtor`, `DPDBucket`, `bucketOf`, `BUCKET_META`,
  `formatINR`) are very much alive and used everywhere — don't touch those, just the array.
- `dashboard.call-queue.tsx` (~2,600 lines) and `manager.portfolio.tsx` (~2,400 lines) are
  route files that have become the de facto shared module other routes cross-import
  components/types from (e.g. `manager.queue.tsx` imports `DialingBoard`,
  `ProductiveDialBoard`, `PortfolioDetail` from them). Works, but a real extraction into
  `src/components/call-queue/` and `src/components/portfolio/` would be healthier.
- `CallOutcome` + its label/color map is defined twice — `src/lib/disposition-store.ts` and
  `src/lib/call-queue/types.ts` — identical unions, two sources of truth to keep in sync by
  hand.

---

## Other docs in this repo — trust level

- `CLAUDE.md` (this file) — kept current.
- `RAILWAY.md` — deploy steps are broadly right, but it names the GitHub repo as
  `recovery-karma-main` (actual: `Shweta-afk/recovery-karma`) and lists Razorpay/Interakt
  among the webhook sources Railway's always-on hosting matters for — neither is actually
  wired (see "What's real vs. aspirational" above). Useful for the Railway walkthrough itself,
  not as a source of truth on what's integrated.
- `CONTEXT.md`, `ARCHITECTURE.md`, `DATA_MODELS.md`, `FLOWS.md` — **describe an entirely
  different, older backend** (Cloudflare Workers + D1 SQLite, React 18, "no global store").
  None of that is true of the current app (Railway/Node + Supabase, React 19, the store-file
  pattern above). Don't use them for architecture questions.
- `docs/archive/tata-smartflo-2026-07/` — 8 docs (`API_REQUIREMENTS.md`,
  `ENVIRONMENT_SETUP.md`, `STAGING_TEST_SETUP.md`, `TELEPHONY_IMPLEMENTATION_PLAN.md`,
  `WEEK3_SUMMARY.md`, `PRODUCTION_DEPLOYMENT.md`, `PRODUCTION_RUNBOOK.md`,
  `QA_CHECKLIST_PRODUCTION.md`) written around the since-removed Tata SmartFlo integration —
  archived 2026-08-20, historical reference only, don't follow their setup/deploy steps.
- `AGENTS.md` — accurate (a short Lovable.dev git-history warning; this project is still
  connected to Lovable, so avoid force-pushing/rewriting published history on `main`).
