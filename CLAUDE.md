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

**Status:** Live in production (Railway, **`axiotta.samvadx.com`**). Most core pages are wired to
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
  Gemini (tone classification), ProfileX/Neokred (skip tracing — the only _paid-per-call_
  integration in the app). **Present in `.env.example` but NOT wired to anything:**
  `ANTHROPIC_API_KEY`, `INTERAKT_API_KEY`, `RAZORPAY_KEY_ID`/`SECRET`,
  `ELEVENLABS_API_KEY`/`VOICE_ID` — zero references in `src/`. Don't assume any of these do
  something; see "What's real vs. aspirational" below.

### Build & Deploy

- **Vite config:** Uses `@lovable.dev/vite-tanstack-config` with `nitro: { preset: "node" }`
- **Build output:** `dist/` (client) + `.output/server/` (nitro server)
- **Start command:** `node .output/server/index.mjs`
- **Deployment:** Railway (`railway.json`, nixpacks builder). Project `bubbly-communication`,
  service `recoveryai-app`. Custom domain **`axiotta.samvadx.com`** (verified 2026-08-21 in
  Railway → Settings → Networking, serving on port 8080). Sibling custom domains on the same
  service: `rrdebt.samvadx.com`, `kuber.samvadx.com`, `abhiyanta.samvadx.com`. The old default
  domains `recoveryai-app-production.up.railway.app` and `karmaapp-production.up.railway.app`
  now return Railway's "Application not found" (checked 2026-09-23) — don't use them.
  ⚠️ An earlier version of this file said `axiora.axiotta.com` — that domain is DEAD and
  returns Railway's `x-railway-fallback` "Application not found" 404. Checking it wastes real
  debugging time (it did on 2026-08-21); use `axiotta.samvadx.com`. Auto-deploys on push to
  `main`, GitHub repo `Shweta-afk/recovery-karma`.
- **Company addresses (2026-10-10, `src/lib/company-address.ts`).** A company with
  `clients.subdomain` signs in ONLY at `<subdomain>.samvadx.com`; one without (new/pending) at
  the platform address `app.samvadx.com`, which is assigned to no company (user's decision —
  Axiotta's own team has `axiotta` like any other company; Demo held `app` and moves to `demo`). Wrong address → signed out locally and sent to the right one, at login
  (`verifySubdomainAccess`) and on page load (`auth.tsx`). Superadmins may be anywhere; hosts
  outside `*.samvadx.com` (localhost, previews) are never checked. `/setup` always runs on the
  platform address. Saving a subdomain refuses reserved names (`RESERVED_SUBDOMAINS`) and any address that doesn't answer `/api/samvadx-ping` yet — saving one
  before its Railway domain + Hostinger record exist would lock that company out. This is routing,
  not data security; RLS is the boundary. A company on its own custom domain (not
  `*.samvadx.com`) is not handled yet.
- **⚠️ Railway's env vars can silently drift from `.env.local`/`.env.example`.** This has
  already broken production once: `TELEPHONY_PROVIDER` stayed `"tata"` on Railway for over a
  week after Tata was removed from the code, silently no-op'ing every call in production. When
  touching any env-dependent feature, check Railway's Variables tab actually matches — don't
  assume local and deployed env are in sync.

### User roles & routes

| Role       | Entry route   | What they do                                                                                                                      |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Agent      | `/dashboard`  | Work the call queue, log outcomes, view debtor profiles, daily targets                                                            |
| Manager    | `/manager`    | Upload portfolios, assign accounts, audit calls, view team performance                                                            |
| Admin      | `/admin`      | Assign portfolios to managers, manage teams/users, org settings, reports                                                          |
| Superadmin | `/superadmin` | SamvadX itself (Axiotta): approve companies, Insights wallets, invoices, platform usage + revenue — see "Superadmin portal" below |

`login.tsx` routes by `role` after auth (`homeRouteForRole` in `src/lib/auth.tsx`): `superadmin` →
`/superadmin`, `admin` → `/admin`, `manager` → `/manager`, else `/dashboard`. Superadmins live in
the `superadmins` table, not `agents`, and every superadmin read goes through the service role
after `verifySuperadminCaller`. Route files live in `src/routes/`; nested routes use dot-notation
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
`useStorageSync` hook in `src/lib/storage-sync.ts`) so a write from _anywhere else_ in the app
shows up live.

**Existing stores** (`src/lib/*-store.ts`): `portfolio-store.ts` (portfolios + debtors, the
biggest one), `disposition-store.ts` (call_logs — also backs the Calls tab on debtor
profiles, Call Audit, and the IVR tab on Messages), `payments-store.ts`
(payments + settlement_requests), `messages-store.ts`, `team-store.ts` (agents/teams),
`client-store.ts`, `escalation-store.ts`, `notification-store.ts`, `org-settings-store.ts`,
`ptp-escalation-store.ts`, `reminder-store.ts`, `retention-store.ts`,
`mapping-template-store.ts` (CSV column-mapping templates).

**Pure helper modules** in `src/lib/` that are NOT stores and hold no cache — import freely:
`date-filter.ts` (IST range tests), `daily-run-rate.ts` (DRR + `istMonthKey`),
`monthly-trend.ts` (`istDayKey`, month comparisons), `agent-time-stats.ts` (mostly
placeholders — see the warning below), `call-queue/build-queue.ts`.

**`extra` on a list-fetched debtor is a SUBSET (2026-09-23).** List queries select the computed
columns `extra_named` (address/city/…/language, pos, Principal) and — Call Queue only —
`extra_head` (first 25 keys), not the ~2.4KB `extra` bag
(`migrations/20260923_debtors_extra_preview.sql`, `src/lib/debtor-extra.ts`). Screens that show
every bank-file column read the full bag themselves (`useFullExtra`, `fetchPortfolioFullExtra`).
Never write a cached row's `extra` back to the database; the client falls back to plain `extra`
if the functions are missing.

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

### ⚠️ RLS "infinite recursion detected in policy" — SOLVED 2026-08-21, guarded by a check

**Took production down twice (2026-08-14, 2026-08-21). Root cause found and fixed on
2026-08-21 — read this before touching anything under `src/supabase/`.**

**Why it kept coming back:** migrations apply in **filename order**, and
`20260814_scope_remaining_tables_to_agent_and_manager.sql` sorts _after_ both
`20260814_disable_row_security_in_auth_helpers.sql` and `20260814_fix_auth_agent_id_recursion.sql`.
So every replay of the directory re-declared `auth_agent_id()` as `LANGUAGE sql` and restored
the inline policy bodies — silently re-breaking production **on every deploy**. A fix applied
by hand in the SQL Editor survives only until the next deploy, which is why this looked
unfixable and was misattributed for weeks.

**Fixed by making every file converge on the correct end state** — `20260730_harden_rls.sql`,
`20260814_scope_remaining_tables...`, `schema.sql` and `migration_rls_hardening.sql` were all
amended so every `auth_*` helper is `plpgsql`. Replay is now idempotent, full or partial. The
authoritative policy definitions live in
`src/supabase/migrations/20260821_rls_no_direct_table_reads.sql`.

**A guard now enforces this: `bun run check:sql`** (`scripts/check-rls-safety.ts`), wired into
`bun run build` and `bun run test:logic`, so a bad migration fails the Railway deploy instead
of taking the app down. It fails on:

- any `auth_*` helper declared `LANGUAGE sql STABLE SECURITY DEFINER` (gets inlined — see below)
- any migration containing its own `BEGIN;`/`COMMIT;`/`ROLLBACK;` — runners supply a
  transaction, and a nested one can abort the migration or silently roll back its DDL. This
  bit us directly: the breaking file applied while the fixing file did not.
- any migration containing debug scaffolding (`SET LOCAL ROLE`, `_rls_probe`,
  `request.jwt.claims`) — keep verification in `scripts/debug/`, never in a file a runner executes.
- **Table grants (added 2026-09-23).** From 2026-10-30 Supabase stops auto-granting Data API
  access to new `public` tables. Any migration dated `20260924` or later that creates a public
  table must `GRANT` it to `service_role`, and to `authenticated` unless marked
  `-- check:sql server-only: <table>`. No SQL file may grant a table to `anon`/`PUBLIC` — every
  live table (checked 2026-09-23) has RLS on and no `anon` access; Supabase's own notice suggests
  `grant select ... to anon`, which this project must not copy.

**Two rules that follow from all of this:**

1. **No policy may read an RLS-protected table directly.** Every lookup goes through a
   `SECURITY DEFINER` helper (`auth_agent_id`, `auth_client_id`, `auth_role`,
   `auth_visible_agent_ids`, `auth_visible_portfolio_ids`, `auth_client_debtor_ids`). Fixing
   policies one at a time just relocates the cycle — observed live moving
   agents → team_agents → debtors → portfolios across four rounds.
2. **`SET row_security = off` does NOT grant a bypass** (a belief that misled three earlier
   fixes). Per the Postgres docs it makes a query _error_ instead of applying a policy; it only
   ever looked load-bearing because the roles involved were already exempt. The real mechanism
   is `SECURITY DEFINER` + an owner that can bypass RLS (here `postgres`, `rolbypassrls=true`).

**Diagnose with a smoke test over ALL tables at once**, never one 500 at a time — see
`scripts/debug/rls-smoke-test.sql`. Which _relation_ each error names tells you where the cycle
really is (8 tables all naming `agents` meant one bug, not eight). Note the Supabase SQL Editor
renders **only the last statement's result**, so UNION diagnostics into a single result set or
they come back blank.

--- Original notes on the two underlying causes ---

Two distinct causes, two different fixes:

1. A `SECURITY DEFINER` function written `LANGUAGE sql` and simple enough gets **inlined** by
   Postgres's planner, silently discarding the privilege escalation `SECURITY DEFINER` is
   supposed to give — so a helper like `auth_agent_id()` called from a policy _on `agents`
   itself_ recurses into that same policy. Fix: `LANGUAGE plpgsql` (never inlined).
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

Migrations live in `src/supabase/migrations/`, applied roughly chronologically (35 as of this
writing) — several of the most recent ones are exactly this class of RLS fix.

### RLS changed on 2026-08-27 — call notes are now shared per debtor

`call_logs_select` used to allow an agent only `agent_id = auth_agent_id()`. An account that
changed hands — reassignment, or a borrower returning as a retained account — showed the new
agent an empty history. Now an agent may also read **any call log on a debtor they can already
see**: `OR debtor_id IN (SELECT auth_visible_debtor_ids())`. Scoped by DEBTOR, not by tenant.
**SELECT only** — nobody can edit another agent's notes.

`auth_visible_debtor_ids()` is a new helper in
`migrations/20260827_notes_visible_on_shared_debtor.sql`, written to the rules above
(`plpgsql`, `SECURITY DEFINER`, `SET row_security = off`). **Its body mirrors `debtors_select`;
if that policy changes, this must change with it**, or notes visibility drifts away from debtor
visibility.

The same date, `ptp_escalations`' two policies were moved off reading `debtors` directly (the
banned pattern — they had been doing it since 20260811 and simply never recursed, which was
luck) onto `auth_client_debtor_ids()`.

**If a debtor profile or Activity History starts 500ing, this is the first thing to revert** —
restore `call_logs_select` to its `20260821_rls_no_direct_table_reads.sql` definition. Note
that is a DATABASE change: rolling back application code will not undo it.

---

---

## Telephony

**Auth (2026-09-19):** every function in `src/lib/telephony/server.ts` is a public HTTP endpoint (TanStack
server functions ship their ids in the client bundle), so each takes `accessToken` and calls
`verifyCaller` first — get it in the browser with `getAccessToken()` (`src/lib/access-token.ts`). Agent numbers
are checked against `agents.agent_phone`, dialer-run phones come from the `debtors` table (never the
request), runs/calls are tied to the starting company, and dial/SMS are rate-limited per user. The webhook
(`/api/telephony/webhook`) requires `TELEPHONY_WEBHOOK_SECRET` and returns 503 while it is unset. There is no
`ingestProviderWebhook` or `sendWhatsAppMessage` server function any more; WhatsApp sends are recorded `failed`.

Single entry point: `src/lib/telephony/index.ts` → `getTelephonyProvider()`, keyed off the
server-side `TELEPHONY_PROVIDER` env var. **Never import a vendor file directly** from feature
code — always go through this.

| Provider          | Env value       | Status                                                                                                                                                             |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simulator         | `sim` (default) | Local dev — no real calls, drives the same dialer engine/state machine so the UI behaves identically to production                                                 |
| Exotel            | —               | **Removed 2026-09-19** (`exotel-provider.ts` deleted, `exotel` no longer a valid `TELEPHONY_PROVIDER`). Old notes elsewhere in this file about Exotel are history. |
| KooKoo (Ozonetel) | `kookoo`        | Implemented (`kookoo-provider.ts`) but not the active choice — evaluated as an alternative, not currently used in production                                       |

**Tata SmartFlo was evaluated, went live briefly, then was fully removed on 2026-08-06** ("nothing we did was working and aligning with our goals" — user's call). If you see "Tata" or "SmartFlo" referenced anywhere outside this note, it's stale.

### ⚠️ Decision (2026-09-07): moving off Exotel for voice too — vendor not chosen yet

**Direction set, nothing executed.** The user has said the org is done with Exotel's
click-to-call and will bring in a new telephony vendor — this is broader than the 2026-09-05
WhatsApp decision above, which was scoped to messaging and explicitly left voice alone. This
one covers voice/click-to-call itself.

**Exotel is still the live production provider right now** — `TELEPHONY_PROVIDER` is unchanged,
every real call still goes through `exotel-provider.ts`, and nothing in this note is a
migration in progress. No new vendor has been named yet; don't assume KooKoo, WebRTC/SIP, or
anything else is the successor without being told.

What this DID change: the Live Calls board (`live-calls-board.tsx`,
`docs/LIVE_CALLS_SCOPE.md`) got Listen/Whisper/Merge buttons back, **deliberately disabled and
not wired to anything** — a placeholder for whichever vendor lands next, per the user's explicit
instruction not to omit them again. Do not wire them up against Exotel; that wall (legs bridged
inside the provider, no conference API) is exactly why they were removed once already. Wire
them only once a real vendor with call-control support is chosen and integrated.

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

True predictive dialing (debtor dialed _before_ an agent is committed) and browser-only
agents (no personal phone) both require **WebRTC/SIP**, which is a _separate, heavier_
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
the `AiSentimentPanel` in `manager.audit.tsx`. It's a _suggestion_ alongside the manager's own
manual sentiment tag — never overwrites it.

**ProfileX skip tracing IS real, and it costs money per call.** Shown to users as **Insights**
(the vendor name is deliberately absent from the UI). Manager/admin-triggered from the Insights tab
on a debtor profile. The services are data, not code: `src/lib/profilex/catalogue.ts` — as of
2026-09-17: Skip Tracing (the ₹46 "VRE Skip Tracing" card — `/exp/vre-skip-tracing`, NOT "VRE
Skip Tracing V2" at ₹15, which was wired by mistake for a day and replaced before it ever ran), Mobile→UAN, Employment Latest/History, Phone to
Prefill, Alternate Phone Numbers, Alternate Addresses, UPI IDs, LPG Connection, Mobile→GST,
GST→Contact. Note a couple of
endpoints name the debtor's number `phone` rather than `mobile` in the body — that is what
`input: "phone"` means; sending the wrong key returns "Missing required input fields: phone".

**Each company only gets the services a superadmin puts on its plan** —
`profilex_settings.enabled_services`, set per company on the superadmin company page, and enforced
in `runProfilexTrace` (not just by hiding buttons). It is an allow-list: empty means none, never
"all", so a newly catalogued (possibly pricier) service reaches no tenant until opted in.
`loadSettings` falls back to `LEGACY_SERVICE_IDS` if the column is missing, so code deployed ahead
of `migrations/20260917_profilex_enabled_services.sql` does not switch Insights off everywhere; a
test keeps that constant identical to the migration's backfill.

⚠️ **Some endpoints must be called WITHOUT a `service-id` header** (the skip-tracing bundles).
Sending any service-id to them returns HTTP 500 `Invalid service url`. `serviceId` is optional in
the catalogue for this reason — omit it where the provider's docs do.

⚠️ **The alt-numbers writeback must never store a third party's number.** `extractPhones`
skips keys naming someone else (distributor, dealer, branch, office, employer…): LPG Connection
returns the gas distributor's landline, and "08023…" normalises to a 10-digit number starting 8 —
indistinguishable from a mobile. An agent ringing a dealer about somebody's debt is a disclosure
problem, not just a wasted call.

⚠️ **`client-user-id` is the console's _Client_ Hash ID, not the User Hash ID beside it** (env
`PROFILEX_CLIENT_HASH_ID`). The wrong one returns `You Dont Have UAT Access!!!`, which is also
what a genuinely unentitled service returns — so that message alone does not tell you which.

Unlike every other integration here:

- **A "not found" is still billed.** ProfileX's rule is HTTP 200 + status `1` (found) → billed,
  HTTP 200 + status `2`/`3` (not found) → **also billed**, HTTP 500 → not billed. Prices are per
  service _and_ per status (₹5 found / ₹1 not, etc.), so the rate card is
  `{service: {status: ₹}}`, never a flat per-call cost. `priceFor()` deliberately fails
  _expensive_ on an unrecognised status — Employment Latest has been seen returning a null status
  on success, and under-recording spend is the failure that matters.
- **There is no balance or usage endpoint.** `debtor_traces` is the only record that spend
  happened; it is what gets reconciled against Neokred's invoice. The `x-ratelimit-*` response
  headers are a rate limit, _not_ a credit balance — don't confuse the two.
- **Chained inputs (UAN, GSTIN) come from stored traces, never the browser.** Employment takes a
  UAN, GST→Contact a GSTIN; each declares `derivedFrom.sources` — the standalone service first,
  then any bundle that nests the same block. Skip Tracing carries `vreMobileToUan`, so a paid skip
  trace unlocks the employment lookups. It has **no** GST block, so it does not unlock GST→Contact. The phone and name are read from the debtor row
  server-side; that is what keeps every lookup to data already in a portfolio.

**CIBIL reports via PayPrime (2026-10-10, reworked 2026-10-11).** Catalogue id `cibil-report`
(`provider: "payprime"`), ₹65 + 18% GST = ₹76.70 per report from the PayPrime wallet
(b2b.payprime.in; API spec at `/cibilDocs`). Server `src/lib/cibil-actions.server.ts`, pure logic
`src/lib/cibil/payprime.ts` (tested in `scripts/cibil-payprime.test.ts`); `runProfilexTrace` /
`runManualInsight` refuse it.
- **One switch per company** (superadmin → company → Insights card → "CIBIL reports",
  `setCompanyCibil`). On = `cibil-report` in `enabled_services` AND `cibil_consent_at` set —
  turning it on asks where the consent agreement is (every request asserts borrower consent).
  Off → admin, manager and agent see nothing CIBIL and the server refuses. Independent of the
  ProfileX "Enable Insights" toggle; the plan checkbox list can't change it.
- **Borrower pulls — managers** (`runCibilBorrower`, `components/profilex/cibil-panel.tsx` at the
  top of the borrower's Insights tab). Phone = the borrower's own; PAN/DOB/address prefilled from
  the bank file + earlier lookups (Skip Tracing returns PAN). Manager wallet hold/settle like other
  lookups. Ledger `debtor_traces`. Visible to whoever can see the borrower (checked by running
  `debtors_select` AS the caller) — so the assigned agent sees it too.
- **Manual pulls — admins** (`runCibilManual`, `cibil-admin-section.tsx` on Admin → Insights):
  any person's details typed in. Ledger `insights_manual_lookups` (admins only). `debtor_id` NULL.
- **Required fields: name, PAN, date of birth + mobile only** (user's call, 2026-10-11; PayPrime's
  docs mark everything required). Blank optional fields are left out of the request; if PayPrime
  answers "Bad Parameter Request" (no txn, not charged) the error asks for the rest.
- **Reports download as an .html file** (`downloadCibilReport`; open in a browser, print → PDF).
  At pull time the server saves a copy of CIBIL's own page (`report_html`, captured from htmlUrl —
  https on cibil.com/payprime.in only, content-checked); if none, the file is built from the
  structured data. A manual pull downloads automatically.
- Reports in server-only `cibil_reports` (`trace_id` or `lookup_id` → ledger row); ledger rows
  hold billing fields only. No RLS policy was changed.
- **IP allow-list:** PayPrime accepts calls only from the IPs/domain on its portal (Developer
  Setting → Api Token): `152.55.177.192/.193`, `162.220.232.251` = Railway's static outbound IPs
  (all three "Shared"; any call may leave from any). Can't work from localhost.
  `PAYPRIME_API_TOKEN` = all three tokens comma-separated; tried in order, moving on only on
  "Invalid Api token" (no transaction, never charged). Confirmed working 2026-10-10.
- Billing: success → status "1"; a `txn_id` without a report → "2", treated as charged — e.g.
  "No Record Found" (details match nobody at the bureau; seen live 2026-10-10). Not deducted from
  the ProfileX actual-balance wallet — PayPrime's balance is only on its portal.
- Migrations `20261010_cibil_reports.sql`, `20261010_cibil_ledger_admin_only.sql`,
  `20261011_cibil_borrower_and_manual.sql`, `20261011_cibil_report_html.sql` (all live).

**Monthly archive + cross-upload lookup reuse (2026-09-22).** `monthly_archive_rows` /
`monthly_archive_runs` (`migrations/20260922_monthly_archive.sql`) permanently keep every Insights
lookup, call log/feedback, payment etc. per IST month; admins download a month as Excel from
**Admin → Archive History**. `runProfilexTrace` reuses an earlier paid lookup for the same
phone + service (other debtor rows, then the archive) at ₹0 instead of re-buying it after a
re-upload. The schedule is deliberately NOT a migration — see `docs/MONTHLY_ARCHIVE.md`.

**Dead accounts are stripped, not deleted (2026-09-23).** 60 IST days after a portfolio closes,
each account with no open PTP/callback or retention request is written to an Excel file in the
private `dead-accounts` Storage bucket (ledger: `dead_account_files`), then its `extra` and
`email` are cleared and `debtors.archived_at` is set (`src/lib/dead-account-archive.server.ts`,
rules in `dead-accounts-shared.ts`). Never delete debtor rows instead: call_logs/payments/disputes/
settlements reference them with no cascade and Reports' past months read payments. Runs from
Admin → Archive History ("Archive now") and daily via `POST /api/cron/archive` (needs
`ARCHIVE_CRON_SECRET`; 503 without it).

Guardrails, all server-enforced in `profilex-actions.server.ts` (budget/TTL live in the
`profilex_settings` table, **not** `org-settings-store.ts`, which is localStorage-only and so
unreadable by the server): manager/admin role gate, per-client monthly budget in IST, a
found/not-found cache TTL, and a partial unique index that stops a double-click paying twice.
`debtor_traces` has a SELECT policy only — every write goes through the service-role action, so an
agent cannot create a trace and a manager cannot forge one. Agents see results read-only via the
same `debtors_select` visibility the rest of the app uses.

**No Razorpay.** Payment links are provided by the lending bank directly; an agent
pastes/enters the bank's link manually, then shares it via WhatsApp/SMS/logs it. The
`razorpay_payment_id`/`razorpay_link_id` DB columns are just generic text storage for that —
not FK'd to an actual Razorpay integration. `RAZORPAY_KEY_ID`/`SECRET` in `.env.example` are
vestigial; don't build against them without confirming this has changed.

**WhatsApp/SMS now go through Exotel — this section was stale until 2026-08-27.**
`messages-store.ts`'s `sendMessage()` calls `sendWhatsAppMessage` / SMS in
`telephony/server.ts`, which hit Exotel's real API before the row is written; `status` records
**Insights outcome report + lookup feedback (2026-09-27).** `insights_outcome_report` RPC
(`migrations/20260927_insights_outcome_report.sql`, applied live) gives one row per lookup with the
calls/contacts/PTPs/payments on that account AFTER it — attribution by time, not causation; logic
in `src/lib/profilex/outcome.ts`, UI `components/profilex/outcome-report.tsx` (Admin Reports →
Insights, Manager Reports → Insights). Called via `asCaller` so RLS scopes it (verified: manager =
own lookups, admin = own company). `call_logs.dialed_phone` (written best-effort by
`saveDisposition`) is what lets it say a found number connected; older calls are NULL.
Paid-file payments (`payments.source 'bank_reported'`, or a no-amount paid-file row that only
set `debtors.status='paid'`) are split out as "Paid Via: Bank paid file". They carry the UPLOAD
time as `received_at`, so "paid after" means "reported after". **No usefulness rating** — a manual
Useful/Not useful and then a calculated one were both built and removed on 2026-09-27 at the
user's request (`_v2.sql` drops the manual columns); don't reintroduce either without asking.

**Lookup data by Loan ID** (same Insights tab, second view; `components/profilex/loan-lookup-report.tsx`,
pure logic `src/lib/profilex/loan-lookup-data.ts`, server `getPortfolioLookupData`): pick a
portfolio → one row per loan with every lookup ever run on it merged (new numbers, emails,
PAN/UAN/DOB/father's name, employer, addresses, UPI, GST) beside the bank file's
`extra_named` address/city/dob/employer, with Match/Differs per field. Excel download = "By Loan
ID" sheet + "All fields" sheet (every flattened field of every lookup). Fields are extracted by
KEY NAME across the whole response, so the skip-tracing bundle and standalone services share one
extractor.

**That Excel is request-only for companies** (`migrations/20260927_insights_export_requests.sql`).
A company admin/manager clicks Request → a superadmin approves/declines on **Superadmin → Insights
Activity → Excel requests** → approval opens that portfolio's download for 7 days (requester is
notified; decision is in the superadmin activity log). `profilex_settings.direct_export` exempts a
company — ON for Axiotta Technologies (`0a3aedc6…`, set 2026-09-27), off for everyone else; toggle
on the superadmin company page. Enforced server-side: the "All fields" data only leaves via
`getPortfolioLookupExport`, which checks direct_export or an unexpired approval;
`getPortfolioLookupData` (the on-screen view) returns per-loan rows only. `insights_export_requests`
is server-only (RLS on, no policies, no `authenticated` grant).

whether the provider accepted it, and a failure is stored as `"failed"` rather than optimistic
"sent". `INTERAKT_API_KEY` remains unused — Interakt was never the gateway.

⚠️ Two caveats that decide whether a message actually lands: `sendWhatsApp` in
`exotel-provider.ts` is marked **UNCONFIRMED against a real account** (the payload shape was
written from Exotel's overview docs, not a tested integration), and WhatsApp sends fail until
each template in `WA_TEMPLATES` is registered and Meta-approved. So "wired" is not the same as
"delivering" — but it is no longer true that nothing leaves the building, and the Messages page
no longer claims otherwise.

### ⚠️ Decision (2026-09-05): do NOT pursue Exotel as the WhatsApp path — Tata and SkyCRM are also off the table

The `sendWhatsApp` code above still physically exists and is described accurately, but **the
user has decided against completing the Exotel WhatsApp Business API route** (WABA connection +
Meta template approval). **Tata SmartFlo and SkyCRM are equally not being considered** for
WhatsApp. A different way to connect WhatsApp will be found later — nothing chosen yet.

**Until the user names a new direction, do not propose or default to Exotel/Tata/SkyCRM again
when asked about WhatsApp integration** — surface this decision instead and ask what they'd
like to explore. This is a product-direction decision, not a code change: Exotel's _voice_
calling (click-to-call, the production telephony provider) is unaffected and keeps working
exactly as documented above — this note is scoped to WhatsApp only.

---

## Dates: every day boundary is midnight IST

`src/lib/date-filter.ts` (`inDateRange`, `inDayRange`, `todayIstKey`) over `istDayKey` from
`monthly-trend.ts`. `src/components/date-range-filter.tsx` is the one date control, used by
Activity History, Manager Activity, Call Audit, Payments, Messages, Debtors and Reports.

**Never bucket a day with `toISOString().slice(0, 10)`.** That is the UTC day: anything logged
between midnight and 05:30 IST lands on the _previous_ day, silently dropping rows out of
same-day filters and moving collections across month boundaries on the 1st. This bug was found
and fixed in three separate places on 2026-08-27 (`fetch-debtors.ts`'s `lastContacted`, four
sites in `dashboard.reports.tsx`, and `agent-time-stats.ts`), and it had been producing wrong
numbers in production the whole time. `enumerateDays`-style helpers that build a `Date` from
`` `${iso}T00:00:00` `` are the same trap in reverse — that is LOCAL midnight.

---

## DRR (Daily Run Rate) — and the target column it depends on

`src/lib/daily-run-rate.ts`. `DRR = max(0, monthlyTarget − collectedThisMonth) / calendarDays
Remaining`. **Calendar** days (an explicit product decision, 2026-08-27), counted in IST;
`remaining` includes today and never drops below 1. Shown on the agent dashboard (replacing the
old "Run Rate" tile) and as Team DRR on the manager dashboard.

⚠️ **`portfolio_agent_targets.target_amount` is read as a MONTHLY figure, and the schema does
not enforce that.** The column has no period of its own. Anyone who sets a portfolio-lifetime
number there silently distorts every DRR on the platform — no error, just wrong numbers. The
target-setting UI labels it "per month"; that is the only guard.

Note the agent dashboard now mixes two notions of "a day" on one screen, knowingly: the ₹ DRR
is calendar-based, while the call-count target beside it is still scaled by Mon–Fri working
days (`workingDaysInMonth`).

---

## ⚠️ Numbers that are NOT measured

Two places generate plausible figures that are not observations. Both are labelled in the UI;
do not quietly promote either to fact.

- **`agent-time-stats.ts` — ringing, wrap, break, idle, login/logout.** Generated by a seeded
  RNG (stable per agent+day). Only `callingSeconds` is real (Σ `call_logs.duration_seconds`).
  There is no presence/status history in the schema and the dialer never persists when a leg
  starts ringing. The Reports "Time & Effort" report shows them, separated from the measured
  figures, with "(est.)" in the table and "ESTIMATED" in the CSV headers. Making them real
  needs an `agent_status_log` table plus ring/answer timestamps out of `use-single-call.ts`.
- **`debtors.outstanding_balance` is a straight copy of `loan_amount`** (three write sites in
  `portfolio-store.ts`). Principal and outstanding are the same number; do not render them as
  two columns. A real recovery-rate denominator needs the bank file to carry outstanding.

---

## Manual Dial lives in a dock, and calls carry how they were dialled

`src/components/manual-dial-dock.tsx`, mounted in `dashboard.tsx` and `manager.tsx` beside
`GlobalCallBar` so it survives navigation. The panel that used to be inside Call Queue was
removed on 2026-08-27.

A **Loan ID** field binds an off-queue call to a real account via
`findDebtorByLoanReference()` (portfolio-store), matched on the same trimmed/lowercased
`loan_reference` key `mergePortfolioRows` and retention reconciliation use. Optional: blank or
unmatched still dials and still logs, as an ad-hoc call with `debtor_id: null`. An unmapped
call can be attached afterwards from the disposition screen (`attachLoanId`).

`call_logs.dial_mode` records HOW a call was placed, as opposed to `call_type`, which records
who handled it. It exists _because_ loan-ID mapping destroys `debtor_id IS NULL`, which was
previously the only thing identifying a manual call.

⚠️ **Its stored values deliberately use none of the confusing words**, given the swapped
labels documented above: `manual` / `single` / `multi_line` (button "Productive Dial",
internally `predictive`) / `sequential` (button "Progressive Dial", internally `productive`).
`DIAL_MODE_META` in `call-queue/types.ts` is the ONLY place that translation happens — keep it
that way rather than spreading either vocabulary into new queries.

---

## Escalations cover any dated commitment, not just PTPs

`src/lib/ptp-escalation-store.ts` (name kept; so is the `ptp_escalations` table and its
`ptp_date` column — read them as "commitment" and "due date"). Missed commitment → the agent's
manager; still unresolved the next calendar day → every admin. Still client-side and
opportunistic on dashboard load; there is no cron.

`escalateMissedCasesToManager` / `escalateMissedCasesToAdmin` take `CaseFollowup[]` from
`getCaseFollowups` / `getTeamCaseFollowups` (disposition-store), which covers PTPs **and**
callbacks. "Open" means the latest disposition per debtor still is that commitment.

The dedupe key is `UNIQUE(debtor_id, ptp_date, level, case_type)`. **`case_type` is
load-bearing** — without it a PTP and a callback due on the same date for the same debtor
collapse into one row and one escalation silently never sends.

Callback dates live in `call_logs.callback_date`/`callback_time`, deliberately NOT in
`promise_date`: a callback carries no `promise_amount`, and any query reading "rows with a
promise_date" as promises would start counting callbacks.

---

## Superadmin portal (platform owner) — rebuilt 2026-10-09

The view for SamvadX/Axiotta itself, across every company. Pages (sidebar order): **Overview**
(`/superadmin`, the home page), **Companies** (`/superadmin/companies`), **Insights Wallet**,
**Insights Activity**, **Invoices**, **Revenue**, **Contracts**, **Superadmin Activity**, **Help**.

⚠️ **Feature usage only — never a company's collections.** No payments, promise amounts,
recovery figures or anything a company collected from borrowers appears in this portal (product
decision, 2026-10-09). Calling = calls, contacts, talk time, active callers, seats; Insights =
lookups, found, billed, ProfileX cost, margin, wallet. Call outcomes are used only to tell a
contact (any outcome except `no_answer`/`voicemail`) from a non-contact. Counts only, never
borrower details. Revenue means SamvadX's OWN invoices to companies, which is fine.

**Not the store pattern.** Superadmin pages call server functions directly (no `*-store.ts`) —
the data is cross-company and only the service role may read it.

- **Usage report** — `getPlatformUsage` (`src/lib/platform-usage.server.ts`) feeds Overview,
  Companies, the company detail page (with `clientId`) and Revenue. Sums come from the SQL function
  **`superadmin_usage_totals`** (`migrations/20261009_superadmin_usage_totals.sql`, applied live
  2026-10-09; EXECUTE for `service_role` only). If the function is missing (PGRST202/42883) the
  server pages raw rows and sums them with `aggregateUsageRows` instead — same numbers, slower.
  The response's `source` (`"database"` | `"rows"`) says which ran; `"rows"` in production means
  the function was lost. The contact rule exists in BOTH the SQL and `NON_CONTACT_OUTCOMES` in
  `platform-usage.ts` — change them together. "Actual ProfileX cost" is priced in JS per group
  (catalogue `priceFor`), deliberately not copied into SQL. Rules (health labels, attention list,
  previous period) are pure in `platform-usage.ts`, tested in `scripts/platform-usage.test.ts`.
- **Health labels** (Companies): Active; Slowing = calls + lookups below 60% of the previous
  period (only once that period had ≥10); Dormant = none this period; New = joined < 14 days ago
  with no usage; Not live = pending/rejected.
- **Overview "Needs attention"**: pending approvals, companies that went quiet, Insights wallets
  that run out within 7 days at the current pace (only judged when the range reaches today),
  seat use ≥ 90% of a cap, pending Excel export requests.
- **Company detail** (`superadmin.companies.$clientId.tsx`) is four tabs kept in `?tab=`
  (`overview` | `users` | `billing` | `settings`). Users shows each person's **last sign-in**,
  read from Supabase Auth (`auth.admin.listUsers` → `last_sign_in_at`) — the app itself records
  no login history. **Billing** holds seat limits, the company's **price list**, its invoices
  (setup + monthly forms prefilled from the price list, top-ups to invoice, and each invoice's
  payments/credit notes) and its Insights wallet history — see "Billing" below.
- **Revenue** (`superadmin.revenue.tsx`; pure logic `src/lib/revenue-report.ts`, tested in
  `scripts/superadmin-reports.test.ts`) reads `invoices`, `invoice_payments` and `credit_notes`:
  billed (issued in range, not cancelled), credit notes (issued in range) and net billed;
  received = **payments by the date the money arrived** (`received_on`; an invoice marked paid
  before payments were recorded counts once on its `paid_at`); outstanding/overdue = what is
  **still owed today after payments and credit notes, whatever the dates**, with ageing buckets
  by days past `due_date`; GST by month (invoices by invoice date, less credit notes in the month
  THEY were issued); Insights margin per company (flags rate cards below ProfileX cost);
  seat-upsell list. Excel adds the invoice register, credit-note register (recipient GSTINs, for
  filing), payments received and unpaid invoices. Says so instead of failing if `invoices` is
  missing.

**One date filter on every superadmin page**: `SuperadminDateFilter` in
`src/components/superadmin/usage-shared.tsx` = the admin `DateRangeFilter` plus presets (7/30/90
days, this month, last month). The range is shared across superadmin pages and remembered per
browser (localStorage, preset stored as a preset so "30 days" keeps rolling). IST maths in
`src/lib/superadmin-range.ts`; reports clamp to a bounded range (default last 30 days, max 366),
list pages also allow "All". The **Invoices** list follows it too, so it opens on the last 30 days.

**Built-in help.** Every number and column heading has an ⓘ (hover, or tap on a phone), each
page has a closable "How to read this page" box, and **Help** (`/superadmin/help`) lists it all.
The text lives in ONE place, `src/lib/superadmin-glossary.ts` — **when you change what a number
means (e.g. the Slowing threshold), update its glossary entry too.** A test fails if a glossary
entry is missing from the Help page.

**Every superadmin table downloads as Excel** via `downloadXlsx` (`src/lib/xlsx-export.ts`,
exceljs loaded on demand). The one exception is the invoice table on a company's Billing tab
(`components/billing/company-invoices-card.tsx`) — Revenue and the Invoices page cover those. Excel exports
leave out the typed-in mobile/UAN of manual Insights lookups on purpose.

### Billing: price lists, three invoice kinds, payments, credit notes — 2026-10-10

`migrations/20261009_billing_price_lists.sql` (applied live 2026-10-10, when zero invoices
existed). Server: `invoice-actions.server.ts` (issue/cancel), `billing-actions.server.ts`
(price lists, payments, credit notes), `price-list.server.ts` (`loadPriceList`, shared so
billing ↔ contracts don't import each other). Rules: `invoice-math.ts` (pure, tested).

- **Price list per company** (`client_price_lists`, company Billing tab): setup lines, monthly
  lines, per-agent-seat price, payment terms (NULL = supplier default). Invoices open prefilled
  from it. Insights prices stay in `profilex_settings.rate_card` — one place each.
- **Three invoice kinds**: `insights_topup` (from a wallet allocation), `setup`, `monthly`
  (`period_month`; partial unique index `invoices_monthly_once` = one live invoice per company per
  month). Due date uses the company's terms, else the supplier's.
- **Payments** (`invoice_payments`): date received, amount, method, reference; part payments.
  `invoices.status` is synced — `paid` once payments (less credit notes) cover it. "Mark paid" is
  gone; `setInvoiceStatus` only cancels, and refuses once a payment or credit note exists.
  Revenue's "Received" counts payments by `received_on`; an invoice marked paid before this (no
  payment rows) counts once on its `paid_at`.
- **Credit notes** (`credit_notes`, `issue_credit_note()`): own number series `<prefix>C/2627/0001`
  (≤16 chars for GST), same CGST/SGST vs IGST split as the invoice, capped at the taxable value
  left. They count in the month THEY are issued and reduce what is owed.
- **Price change → draft contract change**: saving a price list that already had prices, or
  changing an existing Insights plan's prices/services, drafts a `contract_changes` row
  (`status='draft'`, never shown to companies) for review on Superadmin → Contracts.
- **Contract templates** (`contract_templates`, `src/lib/contract-template.ts`): text with
  `{{placeholders}}` filled from billing details, price list, seats and Insights prices; a
  generated document stores its frozen text in `contract_documents.body` (file XOR body).
- **Screens**: company Billing tab = `CompanyPriceListCard` + `CompanyInvoicesCard` (setup form
  prefilled with "Reset to price list"; monthly form = month picker of the current + 3 previous
  IST months, seats default to active agents, already-invoiced months disabled). Opening an
  invoice anywhere (`InvoiceTable` with `onChanged`) shows `InvoiceLedger`: what is still owed,
  record/remove payments, issue/print credit notes, cancel. The invoice table's status badge and
  "Still owed" column come from `invoiceBalance` (Paid / Part paid / Overdue / Unpaid /
  Credited / Cancelled).
- **Printing**: `PrintButton` (`invoice-document.tsx`) mounts its print copy ONLY while printing —
  several print buttons can be on screen (invoice + credit notes) and print CSS shows every
  `.invoice-print-root`. Credit notes print on the invoice layout (`InvoiceDocument` with
  `credit`), generated contracts via `ContractBody` (`components/contracts/contract-body.tsx`).
- **Types**: `database.types.ts` was regenerated after this migration (51 tables), but
  `billing-actions.server.ts`, `price-list.server.ts`, `contracts.server.ts` and parts of
  `invoice-actions.server.ts` / `revenue-report.server.ts` still read the new tables through an
  untyped client cast (written before the regeneration). Safe to replace with the typed client.

### Contracts (Admin → Contracts, Superadmin → Contracts) — 2026-10-09

Tables `contract_documents` / `contract_changes` / `contract_acceptances`
(`migrations/20261009_contracts.sql`, server-only like invoices); server `src/lib/contracts.server.ts`,
rules `src/lib/contracts.ts`. Files live in the private Storage bucket `contracts` (created by the
server on first upload; the browser uploads straight to a signed upload URL).

- **Documents**: `client_id NULL` = SamvadX platform terms for every company; otherwise one
  company's signed agreement. Versions are kept; "current" = latest already in effect.
- **Changes**: a superadmin writes and publishes one when a feature is added or changes, to every
  company or selected ones. Publishing inserts an in-app notification for each active admin of
  those companies. With "Admins must accept", one admin per company accepts (ticks a box + types
  their name) — recorded once per company with name, email and time. An admin-wide banner
  (`admin.tsx`) shows while anything is waiting. Withdrawn changes are kept, marked Withdrawn.
- **Email** goes through **Resend** (`src/lib/email.server.ts`, REST API, no SDK), one email per
  admin. Off until `RESEND_API_KEY` and `EMAIL_FROM` are set on Railway (EMAIL_FROM's domain must
  be verified in Resend). Supabase can't send these — its email is sign-in only, Pro included.
  Without Resend, "Email the admins" opens the superadmin's own mail app instead (`changeMailto`).
- ⚠️ **Superadmin-only for now** (user, 2026-10-09): `CONTRACTS_VISIBLE_TO_COMPANIES = false` in
  `src/lib/contracts.ts` hides the admin link and banner, makes the company-admin actions refuse,
  and makes publishing notify/email nobody. Flipping it to `true` opens everything to admins; a
  test pins it to `false` so it can't flip by accident — change the test with it.
- Company admins only (`role = 'admin'`); managers/agents don't see contracts.

---

## Page-by-page status

| Page                                                                                        | Status                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard/` (Call Queue)                                                                   | ✅ Real debtors via `portfolio-store.ts`, real dialer. Manual Dial is **no longer on this page** — see `ManualDialDock` below                                                                                                                                     |
| `dashboard/debtors`                                                                         | ✅ Real debtor list + Calls/Payments tabs. Messages/Disputes tabs are intentionally honest empty-states (no write path yet)                                                                                                                                       |
| `dashboard/history` (Activity History)                                                      | ✅ Real `call_logs`, with async recording backfill. Filters by date range and by dial type (`call_logs.dial_mode`)                                                                                                                                                |
| `dashboard/payments`                                                                        | ✅ Real `payments`/`settlement_requests` via `payments-store.ts`                                                                                                                                                                                                  |
| `dashboard/messages`                                                                        | 🟡 Real `messages` table, but Send has no gateway behind it (see above)                                                                                                                                                                                           |
| `dashboard/reports`                                                                         | ✅ Real. **Was wrongly listed here as an unwired placeholder until 2026-08-27** — it has been reading real dispositions/payments/portfolios for a while, and the page says so on screen. Seven reports incl. Time & Effort (see the estimated-time warning below) |
| Debtor profile → Insights tab (`components/profilex/`)                                      | ✅ Real ProfileX lookups; manager/admin run them, agents read-only. Needs `PROFILEX_*` env + the admin toggle                                                                                                                                                     |
| `manager/portfolio` (Portfolio Overview)                                                    | ✅ Real, full-screen dashboard per portfolio incl. call-activity/AI-handling breakdown                                                                                                                                                                            |
| `manager/queue`, `manager/audit`, `manager/upload`, `manager/activity`                      | ✅ Real                                                                                                                                                                                                                                                           |
| `admin/portfolio` (Portfolio Assignment)                                                    | ✅ Real; reuses the same full-screen dashboard as Manager Portfolio Overview, read-only                                                                                                                                                                           |
| `admin/reports`, `admin/users`, `admin/teams`, `admin/settings`                             | ✅ Real                                                                                                                                                                                                                                                           |
| `admin/index`                                                                               | ✅ Real (navigation tiles)                                                                                                                                                                                                                                        |
| `superadmin/` (Overview), `superadmin/companies`, company detail tabs, `superadmin/revenue` | ✅ Real (2026-10-09) — usage via `superadmin_usage_totals`, revenue via `invoices`. See "Superadmin portal" above                                                                                                                                                 |
| `superadmin/wallet`, `superadmin/insights`, `superadmin/invoices`, `superadmin/activity`    | ✅ Real; shared date filter + Excel added 2026-10-09. Invoices: payments, credit notes and "Still owed" since 2026-10-10                                                                                                                                          |
| `superadmin/contracts`, `superadmin/help`                                                   | ✅ Real. Contracts = uploads, templates, drafts, published changes + acceptances; superadmin-only for now (`CONTRACTS_VISIBLE_TO_COMPANIES`). Help = glossary + page guides                                                                                       |
| `admin/contracts`                                                                           | ⏸ Built but switched off (`CONTRACTS_VISIBLE_TO_COMPANIES = false`) — shows "not available yet"                                                                                                                                                                   |

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
  _types and helpers_ from the same file (`Debtor`, `DPDBucket`, `bucketOf`, `BUCKET_META`,
  `formatINR`) are very much alive and used everywhere — don't touch those, just the array.
- `CallOutcome` + its label/color map is defined twice — `src/lib/disposition-store.ts` and
  `src/lib/call-queue/types.ts` — identical unions, two sources of truth to keep in sync by
  hand.
- **`bun run typecheck` is clean as of 2026-10-09** (0 errors) now that Supabase `Database`
  types are generated into `src/lib/database.types.ts` — it used to fail with ~313 `never`
  errors from the untyped client. Keep it at zero, and **regenerate the types after a migration**
  (a new function or table is invisible to them until then; `platform-usage.server.ts` casts
  `rpc` for `superadmin_usage_totals` for that reason). `bun run build` still runs `check:sql` +
  `test:routes` + `vite build` and **not** `typecheck`, so CI won't catch a type error — run it
  yourself.
- `contactHistory` and `paymentHistory` on `Debtor` are only ever populated by the dead
  `MOCK_DEBTORS` array. **Both were un-wired from the UI on 2026-08-27** — the in-call notes
  panel and Contact History tab now read real `call_logs`, and the Payments tab reads real
  `payments`. The two fields themselves survive only as the fallback for an ad-hoc manual call
  (no debtor row behind it) and go away with the `MOCK_DEBTORS` array.

**Done (2026-08-27):** the agent Reports page was listed as an unwired placeholder for weeks
while being fully wired — check a page before believing this file about it. Manual Dial moved
out of Call Queue into `ManualDialDock`. Notes/feedback surfaced during a call from real
`call_logs` rather than the mock-only `contactHistory` field.

**Done (2026-08-20):** `dashboard.call-queue.tsx` and `manager.portfolio.tsx` used to double as
the de facto shared module other routes cross-imported components from. Extracted the
genuinely-shared pieces into proper homes: `buildAssignedQueue` → `src/lib/call-queue/build-queue.ts`;
`DialerModeBar`/`DialingBoard`/`ProductiveDialBoard`/`LiveCallsPanel` →
`src/components/call-queue/dialer-boards.tsx`; the whole portfolio dashboard
(`Portfolio` type, `toPortfolio`, `PortfolioDetail`, `StatCard`, the call-activity/AI-handling
breakdown, and its supporting `AccountsTable`/`RemovedAccountsPanel`/`RetentionRequestsPanel`) →
`src/components/portfolio/portfolio-dashboard.tsx`. The two route files still re-export these
(so nothing else that imported from the old route paths breaks), but `manager.queue.tsx` and
`admin.portfolio.tsx` now import directly from the real modules.

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
