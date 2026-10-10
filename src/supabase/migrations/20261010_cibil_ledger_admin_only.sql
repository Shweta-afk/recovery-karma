-- CIBIL pulls are recorded in insights_manual_lookups (SELECT policy: admins of the company only)
-- instead of debtor_traces (readable by the assigned agent and their manager), so nobody but an
-- admin can see that a credit report was pulled, let alone read it.
--
-- 20261010_cibil_reports.sql first shipped with cibil_reports.trace_id → debtor_traces; that file
-- now creates lookup_id → insights_manual_lookups directly. This converges a database that already
-- ran the first version (applied live 2026-10-10 with zero rows) and is a no-op otherwise.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cibil_reports' AND column_name = 'trace_id'
  ) THEN
    ALTER TABLE cibil_reports DROP CONSTRAINT IF EXISTS cibil_reports_trace_id_fkey;
    ALTER TABLE cibil_reports RENAME COLUMN trace_id TO lookup_id;
    UPDATE cibil_reports SET lookup_id = NULL;
    ALTER TABLE cibil_reports ADD CONSTRAINT cibil_reports_lookup_id_fkey
      FOREIGN KEY (lookup_id) REFERENCES insights_manual_lookups(id) ON DELETE SET NULL;
  END IF;
END $$;
