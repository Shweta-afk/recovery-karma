# QA checklist — RecoveryAI

Post-merge manual QA for PR #1. Everything below was build/typecheck/test-verified but **not**
click-tested (auth-gated). Prioritize the **⚠️ high-risk** items — the telephony engine wiring
and the extracted `active-call` module — which are behavior-unverified.

**Setup:** run `bun run dev`, open the app, and sign in. Test each role (agent / manager / admin).
Keep the browser console open and note any red errors per screen.

---

## 1. Auth & routing
- [ ] Visiting any `/dashboard`, `/manager`, `/admin` URL while **signed out** redirects to `/login`.
- [ ] Sign in as **agent** → lands on `/dashboard`.
- [ ] Sign in as **manager** → lands on `/manager`.
- [ ] Sign in as **admin** → lands on `/admin`.
- [ ] As an **agent**, navigating to `/manager` or `/admin` is blocked / redirected.
- [ ] Sign out returns to `/login`.
- [ ] No SSR hydration error in console on first load (the `<html class="dark">` fix).

## 2. ⚠️ Agent call queue — telephony engine (`/dashboard/call-queue`)
This is the core of the new work — verify the engine-driven behavior, not just that it renders.
- [ ] **Single manual call:** click **Call** on a queue row → panel opens **ringing**, then flips to
      **connected** after a beat (driven by sim events, not a blind timer). It should reliably connect.
- [ ] While connected: **mute**, **hold**, **minimize** (call bar persists across navigation), restore.
- [ ] **End call** → disposition form appears.
- [ ] Submit each disposition outcome (PTP, paid, callback, refused, no-answer): success toast; row shows
      a logged badge; a PTP/callback sets a reminder + "SMS sent" toast.
- [ ] Submit a **PTP** and a **paid** → confirm they appear in **History** and **Reports** (call_logs write).
- [ ] **Predictive Dial** button → mode status bar shows the portfolio mode; legs appear in the floating
      **Live Calls** panel and progress ring → connected/no-answer; "Currently Ringing" count is non-zero
      then settles. **Stop Dialer** clears it.
- [ ] The **AI-transfer** flourish: ~6s after starting the dialer, an incoming-transfer notification / an
      auto-connected call appears.
- [ ] Column sort + per-column filters on the queue table (filter button shows only on filterable columns).
- [ ] Empty state: an agent with no assigned portfolio sees "no accounts assigned".

## 3. ⚠️ Extracted active-call module (`src/components/call-queue/active-call.tsx`)
These components moved files in the split — confirm each still renders and behaves:
- [ ] Active call **panel** and **modal** views (switch between them).
- [ ] **Debtor profile sheet** opens from a call/row and shows debtor detail tabs.
- [ ] **PTP tracker** renders.
- [ ] **Escalation modal**: escalate a call → it appears in the manager's My Queue.
- [ ] Disposition form fields (PTP amount/date, paid ref, settlement, callback date/time) all work.

## 4. ⚠️ Manager — Agent Live View (`/manager`)
- [ ] "Agent Live View" tab mirrors the **agent's own dashboard** (read-only): collections strip, KPIs,
      queue overview, debtor breakdown, time distribution, retained accounts, KPI-vs-target.
- [ ] Quick-link cards in the mirror do **not** navigate anywhere (read-only).
- [ ] The per-agent stat strip + escalation banner show above the mirror; switching the selected agent updates it.

## 5. ⚠️ Manager call queue (`/manager/queue`)
- [ ] **Agent Live View** tab: mode bar + **Predictive Dial** toggle + Live Calls panel (engine-driven,
      per selected agent). Switching agents resets the dialer.
- [ ] Per-row **Call** works.
- [ ] **Overview** tab: aggregate counts + per-agent cards.
- [ ] **My Queue** tab: manual dial (enter a number → Call), and escalations list (Call an escalation).
- [ ] Recovery-rate chart renders with axis labels/legend.

## 6. Admin (`/admin`)
- [ ] Overview, Users, Teams, Portfolio, Reports, Settings all render.
- [ ] Create a team / assign agents (assign-agents step, incl. CSV mapping) works.

## 7. Cross-cutting
- [ ] **Dark / light** toggle: both themes legible on every screen.
- [ ] **Mobile** (resize to ~375px): the big tables and the dialer/live-calls panel are usable
      (horizontal scroll contained, no page-level sideways scroll).
- [ ] Toasts appear for actions and errors (not silent failures).
- [ ] No uncaught console errors on any screen.

## Known non-issues (don't file)
- Simulated calls only — no real telephony; AI/IVR legs are **not** persisted yet (Phase 2 write is a stub).
- `react-refresh` HMR warnings in the dev console are benign.
