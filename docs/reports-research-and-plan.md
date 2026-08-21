# Reports: competitor research + what SamvadX actually needs

Research pass done 2026-08-21 to answer "how many reports do we need and what kind." Scope:
what report types collections/recovery platforms standardly ship, compared against what
exists in this repo today (`dashboard/reports`, `admin/reports`, `manager/*`), so we can
decide what to build next instead of guessing.

**Trust level:** this is a planning doc, not architecture truth — see `CLAUDE.md`'s "Other
docs in this repo" section for how the docs hierarchy works. Supersede/delete this file once
the reports work described here actually ships (fold the decisions into `CLAUDE.md`'s
page-by-page status table instead of leaving two sources of truth).

---

## 1. What competitors/industry standard collections platforms report on

Sources: see citations inline. Categories that show up across essentially every vendor
(Katabat/Ontario Systems FACS, InterProse ACE, LiveVox, TrueAccord, Provana, generic
call-center collections tooling) and every "collections KPI" writeup:

1. **Aging / DPD bucket distribution** — accounts segmented into bands (0-30, 31-60, 61-90,
   90+, often finer in India: 30/60/90/120/180+) with $ and count per bucket.
   [Tratta](https://www.tratta.io/blog/debt-collection-dashboard)
2. **Roll-rate / bucket movement** — how accounts migrate between DPD bands period over
   period (early-stage cure vs. deterioration into charge-off risk).
   [Bryt Software](https://www.brytsoftware.com/debt-collections-performance-metrics-kpis/)
3. **Recovery rate** — $ recovered ÷ $ placed, usually segmented by portfolio/lender/product.
   Industry target commonly cited as 60-70% depending on paper age.
   [Tratta](https://www.tratta.io/blog/debt-collection-dashboard)
4. **Cost to collect** — total collection cost ÷ $ recovered (cited target: under $0.10 per
   $1). Used to decide which accounts justify manual agent effort vs. digital-only treatment.
   [Enformion](https://www.enformion.com/blog/five-kpis-collections-department-monitor/)
5. **Right-Party Contact (RPC) rate** — successful contact with the actual debtor ÷ total
   attempts. Foundational metric basically every source treats as non-negotiable.
   [Enformion](https://www.enformion.com/blog/five-kpis-collections-department-monitor/)
6. **Promise-to-Pay (PTP) rate + PTP-kept rate** — PTPs secured ÷ RPCs, and separately what
   fraction of PTPs actually convert to payment (this second half is often missing from
   naive implementations).
   [Enformion](https://www.enformion.com/blog/five-kpis-collections-department-monitor/)
7. **Collector/agent productivity & scorecards** — calls, talk time, resolutions/day, PTPs,
   $ collected per agent; plus a QA/compliance scoring layer (call quality, script/regulatory
   adherence) separate from raw volume.
   [SlideTeam](https://www.slideteam.net/blog/top-5-call-center-agent-scorecard-templates-with-samples-and-examples),
   [Balto](https://www.balto.ai/blog/call-center-quality-monitoring-scorecard/)
8. **Channel effectiveness** — response/contact rate broken out by call vs. SMS vs. WhatsApp
   vs. email vs. self-service, used to decide default outreach sequencing.
   [LiveVox](https://help.livevox.com/en_US/reporting-and-analytics)
9. **Vintage analysis** — recovery curves grouped by the cohort/period an account entered
   collections, used to separate "portfolio is behaving worse" from "this cohort was always
   worse." Distinct from aging (which is a snapshot, not a cohort curve).
   [Enformion](https://www.enformion.com/blog/five-kpis-collections-department-monitor/)
10. **Compliance / audit reports** — contact-hour adherence, complaint volume + resolution
    time, dispute aging, call recording audit trail. In India specifically this maps to RBI's
    Fair Practices Code (contact only 07:00–19:00, documented calls/visits) and Scale-Based
    Regulation board-reporting expectations (DPD-bucket efficiency, model monitoring for any
    scoring model, compliance violation rates) for NBFCs.
    [iTuring – NBFC SBR collections guide](https://ituring.ai/nbfc-scale-based-regulation-collections/)
11. **Executive/board summary** — a small, high-density rollup (top overdue accounts, bad-debt
    forecast, aging %, a single trend number) meant for someone who won't open the detail
    views. [FasterCapital](https://fastercapital.com/content/Debt-Collection-Reporting--How-to-Create-and-Analyze-Meaningful-Reports-and-Dashboards-for-Debt-Recovery.html)
12. **Dispute & settlement reports** — dispute volume/aging by type and resolution outcome;
    settlement requests by approval status and discount-from-outstanding.

That's **~11-12 distinct report _categories_** industry-wide (some vendors split a few of
these further, e.g. per-portfolio vs. cross-portfolio aging as separate views, but the above
is the real list of distinct _questions_ a collections report answers — more report screens
than this is usually the same data re-sliced, not new information).

---

## 2. What SamvadX has today (verified against the actual route files, 2026-08-21)

| Report category (from §1)                                                                       | Where it lives now                                                                              | Real or mock?                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collector/agent productivity & scorecard                                                        | `admin/reports` → By Team / By Agent tabs                                                       | ✅ Real — pulls `disposition-store.ts` + `team-store.ts`, has CSV export                                                                                                                                       |
| Outcome/disposition breakdown                                                                   | `admin/reports` → Outcome Breakdown tab                                                         | ✅ Real                                                                                                                                                                                                        |
| Raw call log / audit trail                                                                      | `admin/reports` → Call Log tab                                                                  | ✅ Real                                                                                                                                                                                                        |
| Aging / DPD distribution (per portfolio)                                                        | `manager/portfolio` (`portfolio-dashboard.tsx`)                                                 | ✅ Real, but scoped to one portfolio at a time, not a standalone report                                                                                                                                        |
| Weekly summary, Portfolio health, Agent performance, Channel effectiveness, DPD bucket movement | `dashboard/reports` (agent-facing)                                                              | ❌ **Fully mock** — hardcoded `REPORTS`/`WEEKLY_DATA`/`AGENT_DATA`/`CHANNEL_DATA`/`DPD_DATA` arrays, static "AI Summary" narrative strings, Excel/Email buttons just fire a toast. Nothing reads from a store. |
| Roll-rate / bucket movement over time                                                           | —                                                                                               | ❌ Not built anywhere (the mock `dpd` report in `dashboard/reports` fakes this)                                                                                                                                |
| Recovery rate, cost to collect                                                                  | —                                                                                               | ❌ Not built                                                                                                                                                                                                   |
| Right-Party Contact rate                                                                        | Contact rate % exists in `admin/reports` (`calcStats` in `disposition-store.ts`)                | 🟡 Partially real — contact rate is tracked, but not broken out as RPC specifically vs. any-contact                                                                                                            |
| PTP rate + PTP-kept conversion                                                                  | PTP count/amount tracked in `admin/reports`                                                     | 🟡 Partial — PTPs _secured_ are real; PTP-kept (did the promised payment actually land) is not computed anywhere                                                                                               |
| Channel effectiveness (call/WhatsApp/SMS/email)                                                 | Only faked in `dashboard/reports`                                                               | ❌ Not real. Also: `dashboard/messages` has no send gateway yet (see `CLAUDE.md`), so a real channel-effectiveness report has nothing to measure for non-call channels today                                   |
| Vintage analysis                                                                                | —                                                                                               | ❌ Not built                                                                                                                                                                                                   |
| Compliance/audit (contact-hour adherence, complaint tracking)                                   | Call sentiment (Groq/Gemini) exists in `manager/audit` but that's tone analysis, not compliance | ❌ Not built as a report                                                                                                                                                                                       |
| Executive/board summary                                                                         | —                                                                                               | ❌ Not built. `admin/reports`' top KPI cards are the closest thing but aren't a distinct rollup view                                                                                                           |
| Dispute report                                                                                  | Disputes are fetched read-only in `fetch-debtors.ts` for the debtor-profile tab                 | ❌ No aggregate dispute report anywhere                                                                                                                                                                        |
| Settlement report                                                                               | `payments-store.ts` has `settlement_requests`                                                   | 🟡 Data exists, no report view built on it yet                                                                                                                                                                 |

**Key finding: there is no `manager/reports` route at all.** Managers currently get
per-portfolio detail (`manager/portfolio`) and call audit (`manager/audit`), but nothing that
rolls up across their whole team the way `admin/reports` does for the org. Admin already has
the best-covered report surface in the app; the agent-facing page is the one that's actively
misleading (looks real, is 100% hardcoded).

---

## 3. Recommendation — what to actually build, and how many

Don't build ~12 separate screens; industry vendors mostly re-slice ~5-6 underlying datasets
(call_logs, payments/settlements, debtors/portfolios, disputes) into different views. Given
the store-file pattern already established in this codebase (see `CLAUDE.md` → "Data
layer"), each report is just a new read/aggregation over an existing store — no new backend
needed for most of these.

**Priority order:**

1. **Fix `dashboard/reports` first.** It's the most visible integrity problem — an agent
   sees a polished "AI Summary" that's a static string, on data that doesn't correspond to
   their real day. Rewire its 5 existing report slots (Weekly Summary, Portfolio Health,
   Agent Performance, Channel Effectiveness, DPD Bucket Movement) to real data from
   `disposition-store.ts` / `portfolio-store.ts` / `payments-store.ts`, scoped to the logged-in
   agent, and either compute the "AI Summary" text from real numbers (template, not literal
   LLM call — see `CLAUDE.md`'s "What's real vs. aspirational") or drop the narrative box
   until an LLM is actually wired.
2. **Add a `manager/reports` route** — team-scoped version of what `admin/reports` already
   does (by-agent, outcome breakdown, call log), since managers currently have no rollup view
   of their own team's numbers outside per-portfolio drill-down.
3. **Extend `admin/reports` with the categories it's missing**, since it's the real
   already-wired surface: recovery rate & cost-to-collect (needs $ placed per portfolio,
   which `portfolios` already has), PTP-kept conversion (cross-reference `call_logs.promise_amount`
   against `payments`), a dispute report tab (aggregate the same `disputes` query
   `fetch-debtors.ts` already does per-debtor), and a settlement report tab off
   `settlement_requests`.
4. **Vintage analysis and roll-rate** are genuinely new aggregations (need a placement-date
   cohort view and a period-over-period bucket-transition calculation) — lowest priority,
   build only if a manager/admin actually asks, since nothing in the schema currently
   prevents computing them, they're just non-trivial queries nobody has requested yet.
5. **Channel effectiveness stays deferred** until `dashboard/messages` has a real send
   gateway (Interakt or similar) — a channel-effectiveness report is meaningless when only
   the call channel has real delivery/response data.
6. **RBI compliance report (contact-hour adherence)** — flagged as a real regulatory
   requirement in the India NBFC research above, not currently built anywhere. Worth a
   dedicated admin-only report: flag any `call_logs` row logged outside 07:00–19:00.

**Net count:** ~4 report _surfaces_ (agent reports rewired, new manager reports, admin
reports extended with 4 new tabs, one compliance report), not ~12 new pages — most of the
industry categories collapse into tabs/filters on those four, matching how `admin/reports`
already organizes itself (tabs, not separate routes).
