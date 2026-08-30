# SamvadX — testing handoff (2026-08-31)

Paste this into a new session to start testing.

## Where things are

- **Production:** https://axiotta.samvadx.com — Railway, auto-deploys on push to `main`.
- `main` is green: `typecheck`, `test:logic`, `format:check`, `check:sql` all pass.
- **5 migrations applied** to the live DB: `dial_mode`, `case_escalations`,
  `notes_visible_on_shared_debtor`, `live_calls`, `agent_time_tracking`.
- Local dev: `bun run dev` (port 8080, auto-increments).

## Test these, in this order

1. **Cross-agent notes (highest risk).** Open a debtor another agent has called. Their notes
   should appear on the profile and in the in-call panel, attributed by name.
   ⚠️ If the page **500s**, that is the RLS widening. Revert `call_logs_select` to its
   `20260821_rls_no_direct_table_reads.sql` definition — a DATABASE change; rolling back code
   will not undo it.
2. **Manual Dial dock** (bottom-left, every page). Dial with a Loan ID → call should attach to
   that debtor's history. Dial without one → still works, logs unmapped, can be attached
   afterwards from the disposition screen.
3. **Live calls board** — manager dashboard "Agent Live View" tab, and the admin panel. Start a
   call as an agent, watch it appear. Kill the tab mid-call: the card should go grey and say the
   call may have ended, not sit there forever.
4. **Escalations** — disposition a callback with a past date; the agent's manager should get a
   notification. Still unresolved next day → admins.
5. **Reports** — POS Worked / POS Promised, the month picker, and clicking an agent for the
   drill-down (manager + admin).
6. **Time tracking** — change your status (available/break) in Call Queue; break and idle should
   start accruing. Forward-only: everything before yesterday reads "—" permanently and that is
   correct.

## Known issues, NOT fixed

- **Agent dashboard "My performance vs target":** only the Calls target is real
  (`agents.daily_target`). The other five are hardcoded placeholders.
- **Manager and admin Reports have no date filter** — only a search box. The per-agent tables
  are all-time with nothing on screen saying so.
- **DRR shows "—" for most agents** — correct, not a bug. It needs a monthly ₹ target set per
  agent per portfolio (Edit Portfolio → Agent Targets). Enter a MONTHLY figure; the column has
  no period and the label is the only guard.
- **Calls a manager places from My Queue do not appear on the live board.** `manager.queue.tsx`
  keeps its own call state instead of the shared context.
- **Manual Dial dock and the Productive/Progressive boards share the bottom-left corner.**
- **Mute, Hold, Whisper, Merge, Transfer, Add Call are disabled** — they never worked (local
  state only) and need provider conference support. Not a regression.

## Uncommitted / unmerged

- `fix/live-agent-issues` — **not merged.** 4 fixes from the first signed-in pass: app-wide
  horizontal overflow (`min-w-0`), a debtor UUID shown in Payments, the false "targets set by
  your manager", and two stale "estimated time" claims.
- **SkyCRM work is uncommitted in the working tree** (`skycrm-provider.ts`, `telephony/index.ts`).
  Also on branch `wip/skycrm-provider`. ⚠️ `.env.example` needs `SKYCRM_BASE_URL`, `SKYCRM_USER`,
  `SKYCRM_PASS`, `SKYCRM_SECRET`, `SKYCRM_PREFIX` re-added — that edit was lost.

## Context

`docs/BACKLOG.md` (decisions + open questions), `docs/LIVE_CALLS_SCOPE.md` (phase 3 = provider
webhooks), `CLAUDE.md` (architecture; trust it over other docs in the repo).
