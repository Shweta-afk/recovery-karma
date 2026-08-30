# SamvadX — Change Backlog

Living doc. Started 2026-08-27 from a working session brain-dump. Items are triaged by risk,
not by the order they were mentioned. **Nothing here is committed scope until it has an
Owner decision where one is marked.**

> **Decisions taken 2026-08-27 are recorded in the Decisions Log at the bottom of this file.
> Where a `❓` below has since been answered, the log wins.**


Bucket key:
- **A · Cosmetic** — UI/copy only. Batch several per branch.
- **B · Wiring** — new data plumbing over existing tables, follows the `*-store.ts` pattern.
- **C · Schema** — needs a migration. One per branch, `bun run check:sql` must pass, verify
  against the live DB (see CLAUDE.md on schema drift).
- **D · Blocked** — needs a decision or a thing that doesn't exist yet.

---

## 1. Replace "Run Rate / Pace" with DRR (Daily Run Rate)

**Now:** [dashboard.index.tsx:381-430](../src/routes/dashboard.index.tsx#L381) shows
Target / Shortfall / Run Rate / EOD Projection. "Run Rate" is a *projection*
(`actual / hours-elapsed × shift`), sub-labelled "pace × shift" / "pace × month".

**Wanted:** DRR = what the agent must do **per remaining day** to hit the monthly target.
Recalculates daily as days-left shrinks, so it rises when you fall behind.

    DRR = (monthly target − achieved so far) / days remaining in month

**Both sides:** agent (`dashboard.index.tsx`) and manager (`manager.index.tsx`, which uses a
hardcoded `DEFAULT_DAILY_TARGET = 80` at line 85).

**Bucket: D → C → B.** ⚠️ **Blocked on two decisions:**
- **Denominator.** The dump said "divided by thirty" (calendar days), but the existing helper
  `workingDaysInMonth` counts **Mon–Fri only** and every current target is a working-day
  target. Calendar-30 and working-days give materially different numbers. Pick one.
- **There is no monthly ₹ target to divide.** `agents.daily_target` is a *call count*.
  `portfolio_agent_targets.target_amount` (migration `20260806`) exists but has **no period
  column** — unclear if it means monthly or portfolio-lifetime. `TARGETS.collections` in
  `dashboard.index.tsx:61` is a hardcoded placeholder. DRR cannot be computed until a real
  monthly target exists and someone can set it.

---

## 2. Queue card → Today's Generation + Today's Performance

**Wanted:** alongside "cases in queue", show today's generation and today's performance, with
the assigned target expressed against those.

**Now:** `todayGeneration` already exists at `dashboard.index.tsx:320` (`{count, ptpAmount}`),
pinned to today independent of the period toggle. Partly built.

**Bucket: B** (A once the target question in #1 is settled).

---

## 3. Monthly Trend — add PTP count, case count, totals

**Now:** [monthly-trend.ts](../src/lib/monthly-trend.ts) `TrendMetrics` already carries
`calls, contacts, ptps, ptpAmount, collected, payments`. So "sum of PTP", "total generated"
and "total PTP value" are **already computed** — they may just not be surfaced on every page.

**Genuinely new:** "count of the loan ID" — distinct accounts/loan IDs touched in the period.
Not currently a metric.

**Bucket: B.** Small. Add a `uniqueAccounts` metric + surface the existing ones.
❓ Confirm "count of loan ID" = distinct debtors contacted, not total calls.

---

## 4. Queue status → show "Remaining" only

Strip the status breakdown on the queue card down to remaining count.
**Bucket: A.** Trivial.

---

## 5. Date in Call Queue

Show the date in the call queue view.
**Bucket: A.** ❓ Which date — today's working date, or per-row last-contacted / PTP date?

---

## 6. Escalation notifications for any case type, not just PTP

**Now:** [ptp-escalation-store.ts](../src/lib/ptp-escalation-store.ts) already implements the
exact chain wanted — agent → manager, then unresolved next day → all admins — deduped via the
`ptp_escalations` table. It is **PTP-only** and runs client-side/opportunistically on dashboard
load (no cron in this app).

**Wanted:** same chain for other outcomes, explicitly including `callback`.

**Bucket: C.** Generalise the store to take an outcome type; `ptp_escalations` needs a
`case_type` column (its UNIQUE key is `debtor_id + ptp_date + level`, which would collide
across types otherwise).
❓ Which outcomes escalate, and after how long? PTP uses "overdue and still open".
`callback` needs its own definition of missed.

---

## 7. Manual Dial — always-on box, bottom-left, with history

**Now:** a toggle panel inside Call Queue only —
[dashboard.call-queue.tsx:977-1050](../src/routes/dashboard.call-queue.tsx#L977). Fields are
name + number + caller ID.

**Wanted:**
- Always available to the agent, as a small persistent box, **bottom-left of the dashboard**.
- Side-by-side history panel next to the dial box.
- Agent/manager see their **last 4–5** manual calls. **Admin sees all** manual-dial history.

**Bucket: B**, plus depends on #8 for what the history rows show.
Note there is already a persistent [global-call-bar.tsx](../src/components/global-call-bar.tsx)
— the manual dial box should live with it rather than becoming a second floating widget.

---

## 8. Manual Dial — map the call to a debtor via Loan ID

**Now:** manual dial fabricates a **synthetic debtor** — `id: manual-<timestamp>`,
`loanReference: "Manual Dial"` (`dashboard.call-queue.tsx:1032`). It is attached to no real
debtor row; `isUuid()` in `disposition-store.ts` exists specifically to guard tables with a
UUID `debtor_id` FK against these fake ids.

**Wanted:** two fields — **Loan ID** + **number**. Calling an alternate number for a known
account then maps the call to the real debtor.

**Bucket: B.** This is the highest-value item in the batch — it turns manual calls from
orphaned records into real account activity, which is also what makes #7's history and #10's
split meaningful.
❓ Is Loan ID **mandatory** (no unmapped manual calls at all) or optional (fall back to
today's synthetic behaviour when the number isn't tied to an account)?

---

## 9. Notes & feedback visible during a call, and visible to everyone

**Wanted:** a notes/feedback section shown *while on a call* and on the debtor profile; a note
written by any agent is visible to everyone.

**Bucket: C — highest risk in this batch.** Notes live on `call_logs.notes`, and Activity
History is deliberately filtered to "my own calls" (`dashboard.history.tsx:223-225`). "Visible
to everyone" means widening **RLS on `call_logs`** — the single most fragile area of this
codebase (took production down twice; see CLAUDE.md).
❓ Does "everyone" mean **all agents**, or **manager/admin only**? The second is far cheaper
and safer. Also: is this a new per-debtor notes thread, or just un-hiding existing call notes?

---

## 10. Split Activity History by dial type

**Wanted:** separate histories for Productive / Progressive / Manual / normal Call Queue,
instead of one merged list.

**Blocker:** `call_logs.call_type` is `human|bot|ai|ivr` — that records **who handled** the
call, not **which dialer produced** it. There is no dial-mode column anywhere. Needs a new
`call_logs.dial_mode` written at dial time by `dialer/engine.ts` + the manual dial path.

**Bucket: C.**
❓ Existing rows have no mode. Backfill them all as "queue", or show them as "unknown"?

⚠️ **Naming trap — read before writing the enum.** The UI labels and the internal values are
deliberately swapped: button **"Productive Dial"** = internal `dialerMode: "predictive"`;
button **"Progressive Dial"** = internal `dialerMode: "productive"`. Do not "fix" this while
passing through; pick storage values that can't be confused with either and map explicitly.

---

## Suggested sequence

1. **Batch 1 (safe, visible):** #4, #5, #3 — cosmetic + metrics already computed. Ships fast,
   no migration, proves the loop.
2. **Batch 2 (high value):** #8 then #7 — loan-ID mapping first, then the persistent box and
   history on top of it.
3. **Batch 3 (needs decisions):** #1 + #2 — once the monthly-target question is answered.
4. **Batch 4 (schema, one at a time):** #10, then #6, then #9. Each its own branch and deploy.

`#9` last on purpose: it is the only item that touches RLS.


---

# Decisions Log

## 2026-08-27

**DRR denominator — calendar days (÷30).** Not working days.
⚠️ Known consequence, accepted: the collections DRR is calendar-based while the call-count
target rendered beside it stays working-day (Mon–Fri). Two notions of "a day" on one screen.
Open: convert the call-count target to calendar days too, or leave it.

**DRR target source — reuse `portfolio_agent_targets.target_amount`,** summed across the
agent's portfolios. No new column.
⚠️ **`target_amount` is hereby defined as a MONTHLY figure.** The column has no period of its
own, so this is a convention, not something the schema enforces. Anyone who later sets a
portfolio-lifetime number in that field will silently corrupt every DRR on the platform. This
needs a comment on the migration and a label in the target-setting UI saying "per month".

**Manual dial loan ID — optional to dial, required to map.** (Reverses the earlier
"mandatory" answer.) A bare number still places a call and still logs it. Supplying the loan
ID is what binds the call to the **debtor** — explicitly the debtor's history, *not* routing
the call to the account's assigned agent. Agent attribution is automatic either way, from the
logged-in user.

**Retro-attach — yes.** An agent can attach a loan ID *after* the call, from the disposition
screen, so an orphaned manual call can be pulled onto the right account later.

**Notes visibility — per-debtor, not global.** Managers see notes. Agents see notes on the
specific debtor they are working. Notes + feedback + disposition must persist so that if the
same account returns later as a retained account, the earlier history is still attached.

---

## Finding: notes already survive a portfolio cycle (mostly)

Investigated because the notes requirement above appeared to need debtor identity keyed on
loan ID rather than row UUID. It largely already is:

- `mergePortfolioRows` (`portfolio-store.ts:495`) matches a re-uploaded CSV against existing
  debtors **by `loan_reference`** and updates the matched row **in place** — same UUID.
- `reconcileRetentionRequests` (`portfolio-store.ts:311`) does the same for a retained account
  against the *next* portfolio's CSV: matched by `loan_reference`, the existing row is updated
  in place with the new `portfolio_id` and a `retained_from_portfolio_id` breadcrumb.

Because the debtor UUID is preserved, `call_logs.debtor_id` keeps pointing at it — so notes,
dispositions and feedback carry across automatically. **The retention case you described is
already handled by existing machinery.**

**The gap:** this only holds on the merge and retention paths. An account arriving in a
genuinely new portfolio with **no** retention request gets a **new** debtor row and a new
UUID — its previous notes stay attached to the old row and won't show. If notes must follow a
loan ID across *any* portfolio boundary, retention request or not, that is a separate piece of
work: a history lookup by `loan_reference` rather than by `debtor_id`.
❓ Is the retention path sufficient, or do notes need to follow the loan ID unconditionally?

---

# Batch 1 — DONE 2026-08-27

Shipped, no migrations, nothing removed from the UI.

- **New:** `src/lib/date-filter.ts` (IST-correct range test) + `src/components/date-range-filter.tsx`
  (the one date control, used by all six pages).
- **Activity History** (#5): date picker added *beside* the today/yesterday/older dropdown —
  the dropdown is kept, both filters AND together.
- **Date filters added** to Manager Activity, Call Audit, Payments, Messages (IVR + SMS tabs),
  and Debtors. Deliberately NOT applied to the WhatsApp thread list: a conversation spans
  days, so date-filtering it would hide live threads rather than narrow a log.
- **Manager Activity** defaults to an empty range = today, i.e. its previous behaviour
  unchanged; picking a range widens it and the labels follow.
- **Payments** applies the range at `scoped`, so every total, chip count and collector split
  inherits it — not just the visible table.
- **Queue** (#4): a **Remaining** tile added and highlighted (amber), = accounts not worked
  today by `lastContacted`. All existing counts kept; row went 3-wide to 4-wide.
- **Monthly Trend** (#3): new `uniqueAccounts` metric = distinct accounts touched (contacted
  or collected from). Correctly **unioned**, never summed — see `DayMetrics`. Cumulative
  series unions progressively too. 6 new tests.

## Bug fixed in passing

`lastContacted` was built with `new Date(...).toISOString().split("T")[0]` — the **UTC** day.
A call taken between midnight and 05:30 IST displayed as the *previous* day and dropped out of
same-day filters. Now uses `istDayKey` (midnight IST), matching the new filters.
Two sites in `fetch-debtors.ts`.

## Known, not fixed

- `tsc --noEmit` reports **314 pre-existing errors** on `main` (untyped Supabase client →
  `never`). Unchanged by this batch. `bun run build` does not run typecheck, which is why this
  has gone unnoticed.
- Agent dashboard "Run Rate" and "EOD Projection" still render the *same* variable. Resolves
  itself in Batch 2 when DRR replaces Run Rate.

---

# Batch 2 — DONE 2026-08-27 (DRR)

- **New:** `src/lib/daily-run-rate.ts` + `scripts/daily-run-rate.test.ts` (9 tests).

      DRR = max(0, monthlyTarget − collectedThisMonth) / calendarDaysRemaining

- **Calendar days**, per the owner decision, counted in **IST** so the month rolls at midnight
  IST. `remaining` includes today and never drops below 1 (on the 31st, the whole remaining
  target is due today — correct, and a safe divisor).
- **Target source:** `portfolio_agent_targets.target_amount` summed across the agent's
  portfolios, read as a MONTHLY figure. Team target = every team agent's, summed.
- **Agent dashboard:** the "Run Rate" tile is now **DRR**. Target and Shortfall now use the
  real monthly target instead of the hardcoded ₹80,000 placeholder. DRR always reads the
  MONTH's collections even when the Today/Month toggle says Today — flipping the view must not
  change what the month still demands.
- **Manager dashboard:** new **Team DRR** tile, *added* beside "Daily Target" rather than
  replacing it — that one is a call-count goal and answers a different question. Stat row went
  6-wide to 7-wide.

## Duplicate-value bug: fixed

"Run Rate" and "EOD Projection" both rendered `formatINR(projection)` — the same variable
under two labels. DRR is a genuinely different quantity (required rate, not projected
landing), so the two tiles now differ by construction. The projection is judged against the
month's target (or today's DRR ask) instead of the placeholder.

## No target set is rendered as "—", never ₹0

`drr: null` means "nobody set a target"; `0` means "target met". Showing both as ₹0 would tell
an agent with no target that they are done. Tiles show "—" plus "no monthly target set".

❓ **Still open:** the Performance KPI row lower on the agent dashboard still compares
Collected against the ₹80,000 placeholder (`TARGETS.collections`), alongside four other
placeholder targets. Left alone deliberately — fixing one of five would look broken next to
the rest. Worth its own pass: either give those metrics real target columns, or label the
block as indicative.

---

# Batch 3 — DONE 2026-08-27 (manual dial, mapping, dial-type history)

⚠️ **Needs a migration applied before deploy:**
`src/supabase/migrations/20260827_call_logs_dial_mode.sql`. Until it runs, `dial_mode` is
silently dropped by the same best-effort update that already guards `outcome_reason` /
`promise_time` — dispositions still save, they just carry no mode.

## Why a migration was unavoidable (#7 + #8 + #10 are one change)

A manual call was only identifiable because it wrote `debtor_id: null`. Attaching manual calls
to real accounts by Loan ID **destroys that marker** — so manual-call history and the
Activity-History split both needed an explicit `call_logs.dial_mode`. One migration, three
backlog items.

**Stored values deliberately avoid the words "productive"/"predictive"**, because the UI labels
and the internal enum are swapped from each other:

    manual | single | multi_line | sequential

`multi_line` is the button labelled "Productive Dial" (internally `predictive`); `sequential`
is the button labelled "Progressive Dial" (internally `productive`). `DIAL_MODE_META` in
`src/lib/call-queue/types.ts` is the **only** place that translation happens.

Old rows stay NULL and display as **"Before tracking"** — not backfilled to `single`, since
manual calls are in that history too and the mode is genuinely unknown.

## What shipped

- **`ManualDialDock`** (`src/components/manual-dial-dock.tsx`), mounted in the dashboard AND
  manager layouts next to `GlobalCallBar`, so it survives navigation. Collapsed pill →
  expanded dialer with the recent-manual-calls panel **side by side**: last 5 for an agent or
  manager, up to 50 for an admin.
- **The in-page Manual Dial panel in Call Queue was REMOVED** (owner-approved) — 85 lines. A
  comment marks where it was and points at the dock.
- **Loan ID binds the call to the debtor.** Optional to dial. `findDebtorByLoanReference`
  (portfolio-store) matches on the same trimmed/lowercased `loan_reference` key that
  `mergePortfolioRows` and retention reconciliation use. The matched account is shown inline
  **before** dialling. No match → old ad-hoc behaviour, nothing blocked.
- **Retro-attach** on the disposition screen for an unmapped manual call, with the same live
  "will be logged against …" confirmation.
- **Activity History** gained a dial-type filter (including "Before tracking") and a per-row
  mode badge under the channel.
- Dial mode is recorded at dial time on every path: queue rows and PTP tracker (`single`),
  legs taken off a dialer run (mapped from the internal enum), and the dock (`manual`).

## Known limitation

The dock and the Productive/Progressive dialer boards both occupy **bottom-left**. The dock is
`z-30` (under the boards' `z-40`) and hides entirely while a call is active, so they do not
fight in practice — but during a dial run with no call taken yet, the board sits on top of the
dock's pill. Fixing properly means lifting dialer-run state to a shared place. Not done.

---

# Batch 4 — DONE 2026-08-27 (escalation notifications for any case)

⚠️ **Second migration to apply:** `src/supabase/migrations/20260827_case_escalations.sql`
(alongside the dial_mode one from Batch 3).

## Two blockers found, both fixed

**1. A callback had no date to escalate from.** The agreed date reached only the auto-note
text and a `reminders` row — `call_logs.promise_date` is written *only* for outcome
'promised'. And `reminders` is scoped to the owning agent, so a manager could not read their
team's to run step 2 of the chain. Added `call_logs.callback_date` / `callback_time`.

Deliberately **not** reusing `promise_date` for callbacks: a callback carries no
`promise_amount`, and any future query reading "rows with a promise_date" as "promises" would
silently start counting callbacks. Same overloading trap as `target_amount` in Batch 2 — worth
one migration to avoid.

**2. The dedupe key would have collided.** `UNIQUE(debtor_id, ptp_date, level)` is what stops
the opportunistic check re-sending. A debtor with a PTP *and* a callback due on the same date
collapses to one row — one escalation silently never sends, with no error. Key is now
`(debtor_id, ptp_date, level, case_type)`.

## Also fixed in passing

`ptp_escalations`' policies read `debtors` **directly** from inside a policy — the exact
pattern that took production down twice (CLAUDE.md's RLS section). It never recursed only
because nothing in debtors' policy reads this table back; that is luck, not design. Both
policies now go through `auth_client_debtor_ids()`, the SECURITY DEFINER helper `call_logs`
already uses.

## Behaviour

- Escalates **PTPs and callbacks**, both on "due date passed and still the latest outcome".
- Same chain and same one-day grace before admins are paged.
- Notification wording is per case type — telling a manager a callback "promised ₹0" would be
  nonsense. Sender reads "PTP Alert" or "Callback Alert".
- A callback logged before this migration has no `callback_date` and simply never escalates,
  rather than escalating on a guessed date.
- `computeCaseFollowups` is exported and covered by 8 tests
  (`scripts/case-followups.test.ts`) — superseded promises, superseded callbacks, pre-migration
  callbacks, and one-live-commitment-per-debtor.

The table keeps the name `ptp_escalations` and the column `ptp_date`; read them as
"commitment" and "due date". Renaming would touch every policy for cosmetic gain.

❓ **Open:** only PTP and callback escalate. "Any case" could extend to disputes or
settlements, but neither carries a due date today, so each would need the same
treatment callbacks just got.

---

# Batch 5 — DONE 2026-08-27 (notes & feedback)

⚠️ **Third migration to apply:** `20260827_notes_visible_on_shared_debtor.sql`.
Running total for this session: `_dial_mode`, `_case_escalations`, `_notes_visible_on_shared_debtor`.

## The panel was never real

"Previous notes & call history", shown beside the disposition form during a live call, read
`debtor.contactHistory`. That field is populated **only on the dead MOCK_DEBTORS fixture** —
`debtorFromRow`, the path every real debtor takes, never sets it. The panel has been
permanently empty in production while looking like a working feature. The Contact History tab
in the same component had the identical bug.

Both now read this debtor's real `call_logs`, showing **the disposition and the note together**
(`Promised — debtor asked to call after salary date`). Showing the outcome alone is what would
have made the panel near-useless even once populated.

## RLS widened — SELECT only

`call_logs_select` let an agent read only rows where `agent_id = auth_agent_id()`. So when an
account changed hands — reassignment, or a borrower returning as a retained account — the new
agent saw an empty history and re-learned what the previous agent had already written down.
The notes were never lost, just unreadable by the person who needed them.

New rule: **an agent may read any call log on a debtor they can already see.** Scoped by the
DEBTOR, not by the tenant — agents still see nothing about accounts never assigned to them.
This is "the notes on my accounts, whoever wrote them", not "every agent reads every call".

Implemented via a new `auth_visible_debtor_ids()` helper: `plpgsql` (never `sql` — an inlinable
SECURITY DEFINER function silently loses its privilege escalation and the policy recurses),
`SECURITY DEFINER`, `SET row_security = off` for the whole body. Its body mirrors
`debtors_select`; **if that policy changes, this must change with it** or notes visibility will
drift from debtor visibility.

**Writes are untouched.** An agent still cannot edit or delete another agent's disposition or
notes.

## Attribution added

The debtor profile's call list showed outcome, duration, type, date and notes — but not WHO
wrote them. Fine while every note was your own; not fine now that the list is cross-agent. It
now shows the agent's name.

## Bug caught in review

The new `priorHistory` useMemo was first placed *below* the component's `phase === "ringing"`
early return — a Rules-of-Hooks violation that would have changed hook order between the
ringing and connected renders. Caught by lint, moved up with the other hooks.

## Persistence: already handled, with one gap

Per the Batch-1 finding, notes survive a portfolio cycle because `mergePortfolioRows` and
`reconcileRetentionRequests` match on `loan_reference` and update the existing debtor row
**in place**, preserving its UUID — so `call_logs.debtor_id` keeps pointing at it.

❓ **Still open (asked, not yet answered):** an account arriving in a genuinely new portfolio
with **no** retention request gets a NEW row and a new UUID; its previous notes stay on the old
row. Making notes follow the loan ID unconditionally is separate work — a history lookup keyed
on `loan_reference` rather than `debtor_id`.
