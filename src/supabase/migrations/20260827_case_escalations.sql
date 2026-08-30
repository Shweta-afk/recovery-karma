-- Generalises the miss-escalation chain from PTPs to any committed follow-up, starting with
-- callbacks. Same shape as before: agent's missed commitment -> their manager; still
-- unresolved the NEXT calendar day -> every admin. See src/lib/ptp-escalation-store.ts.
--
-- Two things had to change.

-- ── 1. Callbacks had no date to escalate FROM ────────────────────────────────────────────
-- When an agent dispositions a call as "callback", the date they agreed is written into the
-- auto-note text and into a `reminders` row, and nowhere else — call_logs.promise_date is
-- only ever populated for outcome 'promised'. So there was no team-visible record of when a
-- callback was due, and a manager cannot read their team's `reminders` (those are scoped to
-- the owning agent), which is exactly what step 2 of the chain needs.
--
-- Deliberately NOT overloading promise_date/promise_time for this. A callback is not a
-- promise to pay: promise_amount stays NULL for one, and any future query that reasonably
-- reads "rows with a promise_date" as "promises" would silently start counting callbacks.
-- Separate columns cost one migration and remove that whole class of bug.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS callback_date DATE;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS callback_time TEXT;

-- ── 2. The dedupe key would have collided ────────────────────────────────────────────────
-- ptp_escalations exists so the opportunistic, runs-on-every-dashboard-load check never sends
-- the same escalation twice; UNIQUE(debtor_id, ptp_date, level) was that guard. Add a second
-- case type and a debtor with a PTP *and* a callback due on the same date collapses to one
-- row — one of the two escalations silently never sends, with no error anywhere.
--
-- The table keeps its name. Renaming it would touch every policy and both client call sites
-- for cosmetic gain; the comment here is cheaper than the churn. Read "ptp_date" as "the date
-- the commitment was due".
ALTER TABLE ptp_escalations ADD COLUMN IF NOT EXISTS case_type TEXT NOT NULL DEFAULT 'ptp';

ALTER TABLE ptp_escalations DROP CONSTRAINT IF EXISTS ptp_escalations_case_type_check;
ALTER TABLE ptp_escalations ADD CONSTRAINT ptp_escalations_case_type_check
  CHECK (case_type IN ('ptp', 'callback'));

-- Existing rows are all PTPs by definition (nothing else could escalate before now), so the
-- 'ptp' default backfills them correctly — unlike call_logs.dial_mode, this one IS knowable.
ALTER TABLE ptp_escalations DROP CONSTRAINT IF EXISTS ptp_escalations_debtor_id_ptp_date_level_key;
ALTER TABLE ptp_escalations DROP CONSTRAINT IF EXISTS ptp_escalations_dedupe_key;
ALTER TABLE ptp_escalations ADD CONSTRAINT ptp_escalations_dedupe_key
  UNIQUE (debtor_id, ptp_date, level, case_type);

-- ── 3. While we're here: stop the policies reading `debtors` directly ─────────────────────
-- The original policies (20260811_ptp_escalations.sql) do
-- `debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())`, which reads an
-- RLS-protected table from inside a policy — the exact pattern that took production down
-- twice (see the RLS section in CLAUDE.md). It has not recursed only because nothing in
-- debtors' own policy happens to read this table back. That is luck, not design.
-- auth_client_debtor_ids() is the SECURITY DEFINER helper the call_logs policies already use.
DROP POLICY IF EXISTS ptp_escalations_select ON ptp_escalations;
CREATE POLICY ptp_escalations_select ON ptp_escalations FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT auth_client_debtor_ids()));

DROP POLICY IF EXISTS ptp_escalations_insert ON ptp_escalations;
CREATE POLICY ptp_escalations_insert ON ptp_escalations FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT auth_client_debtor_ids()));

NOTIFY pgrst, 'reload schema';
