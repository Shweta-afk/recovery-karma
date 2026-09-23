-- Monthly archive: a permanent copy of every paid Insights lookup, every call log (notes and
-- feedback included), payments, messages, disputes, settlements, and the accounts/portfolios
-- they belong to.
--
-- Two jobs, one store:
--   1. History. Rows here have NO foreign key to debtors, so they survive a portfolio being
--      closed, an account being removed or a debtor row being deleted (debtor_traces itself
--      cascades away with its debtor). Admins download any month as Excel.
--   2. Money. A re-uploaded portfolio gets brand-new debtor rows, so debtor_traces (keyed by
--      debtor_id) has no history for a borrower we already paid to look up. `phone_key` (the
--      normalised 10-digit mobile) + `tag` (the service slug) lets profilex-actions.server.ts
--      find that earlier result and reuse it instead of buying it again.
--
-- Rules from 20260821_rls_no_direct_table_reads.sql are followed: the two policies below call
-- only the auth_* helpers and never read an RLS-protected table. Replay-safe (IF NOT EXISTS /
-- OR REPLACE / DROP POLICY IF EXISTS) because this directory is replayed on every deploy.
--
-- The cron schedule is deliberately NOT in this file — see docs/MONTHLY_ARCHIVE.md.

CREATE TABLE IF NOT EXISTS monthly_archive_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  counts        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  triggered_by  TEXT NOT NULL DEFAULT 'schedule',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (client_id, month)
);

CREATE TABLE IF NOT EXISTS monthly_archive_rows (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     UUID NOT NULL REFERENCES clients(id),
  -- 'YYYY-MM' in IST. Events (calls, payments, lookups...) are filed under the month they
  -- happened; accounts/portfolios under the month whose run first saw that version of them.
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind          TEXT NOT NULL CHECK (kind IN (
                  'trace', 'call_log', 'payment', 'message', 'dispute', 'settlement',
                  'debtor', 'portfolio', 'portfolio_target')),
  source_id     TEXT NOT NULL,
  -- Normalised 10-digit mobile of the borrower; what makes a lookup findable in a later upload.
  phone_key     TEXT,
  -- For traces: the Insights service slug.
  tag           TEXT,
  occurred_at   TIMESTAMPTZ,
  content_hash  TEXT,
  data          JSONB NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, month, kind, source_id)
);

CREATE INDEX IF NOT EXISTS monthly_archive_rows_month_kind_idx
  ON monthly_archive_rows (client_id, month, kind, id);

-- The reuse lookup: newest archived result for one phone + service.
CREATE INDEX IF NOT EXISTS monthly_archive_rows_trace_phone_idx
  ON monthly_archive_rows (client_id, phone_key, tag, occurred_at DESC)
  WHERE kind = 'trace';

-- "Has this version of this account already been saved?" — newest row per source.
CREATE INDEX IF NOT EXISTS monthly_archive_rows_source_idx
  ON monthly_archive_rows (client_id, kind, source_id, month DESC);

-- ── RLS: admins read their own company's archive. No write policies at all — every write is
-- archive_month() below, so nobody can forge or edit history through the API. ──────────────
ALTER TABLE monthly_archive_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_archive_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS monthly_archive_runs_select ON monthly_archive_runs;
CREATE POLICY monthly_archive_runs_select ON monthly_archive_runs FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');

DROP POLICY IF EXISTS monthly_archive_rows_select ON monthly_archive_rows;
CREATE POLICY monthly_archive_rows_select ON monthly_archive_rows FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');

-- ── The archiver ─────────────────────────────────────────────────────────────
-- Idempotent: running a month twice overwrites its rows with the same values, so a retry after
-- a failure, or a manual "Archive now" on the current month, never duplicates anything.
--
-- (2026-09-23) Account rows are no longer versioned here — see
-- 20260923_archive_debtor_versions_batched.sql (one statement timed out at 12.8s). This file is
-- kept identical to that end state so replaying either converges.
--
-- Account/portfolio rows are VERSIONED, not re-copied every month: a new row is written only
-- when the content differs from the newest saved version (content_hash). Copying ~15k accounts
-- with ~150 extra columns each, monthly, would grow the database by hundreds of MB for no gain.
-- They are also only saved for the current and previous month, so back-filling old months does
-- not stamp today's state onto history.
CREATE OR REPLACE FUNCTION archive_month(p_month TEXT, p_client UUID DEFAULT NULL)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    m_start   TIMESTAMPTZ;
    m_end     TIMESTAMPTZ;
    this_ist  TEXT := to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM');
    prev_ist  TEXT := to_char((NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 month', 'YYYY-MM');
    c         UUID;
    n         INTEGER;
    run_counts JSONB;
    all_out   JSONB := '{}'::jsonb;
  BEGIN
    IF p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'archive_month: bad month "%" (want YYYY-MM)', p_month;
    END IF;
    -- Month boundaries are midnight IST, not UTC (see date-filter.ts): a call at 02:00 IST on
    -- the 1st belongs to the new month.
    m_start := (p_month || '-01')::TIMESTAMP AT TIME ZONE 'Asia/Kolkata';
    m_end   := ((p_month || '-01')::TIMESTAMP + INTERVAL '1 month') AT TIME ZONE 'Asia/Kolkata';

    FOR c IN SELECT id FROM clients WHERE p_client IS NULL OR id = p_client LOOP
      run_counts := '{}'::jsonb;

      INSERT INTO monthly_archive_runs (client_id, month, status, triggered_by)
        VALUES (c, p_month, 'running', CASE WHEN p_client IS NULL THEN 'schedule' ELSE 'manual' END)
        ON CONFLICT (client_id, month) DO UPDATE
          SET status = 'running', error = NULL, started_at = NOW(), finished_at = NULL,
              triggered_by = EXCLUDED.triggered_by;

      BEGIN
        -- Insights lookups (every state but an unfinished claim).
        INSERT INTO monthly_archive_rows
            (client_id, month, kind, source_id, phone_key, tag, occurred_at, data)
          SELECT c, p_month, 'trace', t.id::TEXT,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10),
                 t.service_id, t.created_at,
                 to_jsonb(t) || jsonb_build_object(
                   'debtor_name', d.name, 'debtor_phone', d.phone_primary,
                   'loan_reference', d.loan_reference)
            FROM debtor_traces t JOIN debtors d ON d.id = t.debtor_id
            WHERE t.client_id = c AND t.state <> 'pending'
              AND t.created_at >= m_start AND t.created_at < m_end
          ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
            SET data = EXCLUDED.data, phone_key = EXCLUDED.phone_key, archived_at = NOW();
        GET DIAGNOSTICS n = ROW_COUNT;
        run_counts := run_counts || jsonb_build_object('trace', n);

        -- Calls, with the agent's notes / AI notes / transcript / sentiment ("feedback").
        INSERT INTO monthly_archive_rows
            (client_id, month, kind, source_id, phone_key, occurred_at, data)
          SELECT c, p_month, 'call_log', l.id::TEXT,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10),
                 l.created_at,
                 to_jsonb(l) || jsonb_build_object(
                   'debtor_name', d.name, 'debtor_phone', d.phone_primary,
                   'loan_reference', d.loan_reference, 'agent_name', a.name,
                   'agent_email', a.email)
            FROM call_logs l
            JOIN debtors d ON d.id = l.debtor_id
            LEFT JOIN agents a ON a.id = l.agent_id
            WHERE d.client_id = c AND l.created_at >= m_start AND l.created_at < m_end
          ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
            SET data = EXCLUDED.data, archived_at = NOW();
        GET DIAGNOSTICS n = ROW_COUNT;
        run_counts := run_counts || jsonb_build_object('call_log', n);

        INSERT INTO monthly_archive_rows
            (client_id, month, kind, source_id, phone_key, occurred_at, data)
          SELECT c, p_month, 'payment', x.id::TEXT,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10),
                 x.created_at,
                 to_jsonb(x) || jsonb_build_object(
                   'debtor_name', d.name, 'loan_reference', d.loan_reference)
            FROM payments x JOIN debtors d ON d.id = x.debtor_id
            WHERE d.client_id = c AND x.created_at >= m_start AND x.created_at < m_end
          ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
            SET data = EXCLUDED.data, archived_at = NOW();
        GET DIAGNOSTICS n = ROW_COUNT;
        run_counts := run_counts || jsonb_build_object('payment', n);

        INSERT INTO monthly_archive_rows
            (client_id, month, kind, source_id, phone_key, occurred_at, data)
          SELECT c, p_month, 'message', x.id::TEXT,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10),
                 x.sent_at,
                 to_jsonb(x) || jsonb_build_object(
                   'debtor_name', d.name, 'loan_reference', d.loan_reference)
            FROM messages x JOIN debtors d ON d.id = x.debtor_id
            WHERE d.client_id = c AND x.sent_at >= m_start AND x.sent_at < m_end
          ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
            SET data = EXCLUDED.data, archived_at = NOW();
        GET DIAGNOSTICS n = ROW_COUNT;
        run_counts := run_counts || jsonb_build_object('message', n);

        INSERT INTO monthly_archive_rows
            (client_id, month, kind, source_id, phone_key, occurred_at, data)
          SELECT c, p_month, 'dispute', x.id::TEXT,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10),
                 x.created_at,
                 to_jsonb(x) || jsonb_build_object(
                   'debtor_name', d.name, 'loan_reference', d.loan_reference)
            FROM disputes x JOIN debtors d ON d.id = x.debtor_id
            WHERE d.client_id = c AND x.created_at >= m_start AND x.created_at < m_end
          ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
            SET data = EXCLUDED.data, archived_at = NOW();
        GET DIAGNOSTICS n = ROW_COUNT;
        run_counts := run_counts || jsonb_build_object('dispute', n);

        INSERT INTO monthly_archive_rows
            (client_id, month, kind, source_id, phone_key, occurred_at, data)
          SELECT c, p_month, 'settlement', x.id::TEXT,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10),
                 x.created_at,
                 to_jsonb(x) || jsonb_build_object(
                   'debtor_name', d.name, 'loan_reference', d.loan_reference)
            FROM settlement_requests x JOIN debtors d ON d.id = x.debtor_id
            WHERE d.client_id = c AND x.created_at >= m_start AND x.created_at < m_end
          ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
            SET data = EXCLUDED.data, archived_at = NOW();
        GET DIAGNOSTICS n = ROW_COUNT;
        run_counts := run_counts || jsonb_build_object('settlement', n);

        -- Versioned state: portfolios and per-agent targets (accounts: see below).
        IF p_month IN (this_ist, prev_ist) THEN
          -- Account rows are versioned separately, in batches, by archive_debtor_versions() below:
          -- done here in one statement they took 12.8s for a 14,061-account company (2026-09-23),
          -- past the 8s limit on API requests, and the whole month rolled back.
          INSERT INTO monthly_archive_rows
              (client_id, month, kind, source_id, occurred_at, content_hash, data)
            SELECT c, p_month, 'portfolio', s.id::TEXT, s.uploaded_at, s.h, s.j
              FROM (
                SELECT p.id, p.uploaded_at, md5(to_jsonb(p)::TEXT) AS h, to_jsonb(p) AS j
                  FROM portfolios p WHERE p.client_id = c
              ) s
              WHERE NOT EXISTS (
                SELECT 1 FROM monthly_archive_rows r
                  WHERE r.client_id = c AND r.kind = 'portfolio' AND r.source_id = s.id::TEXT
                    AND r.content_hash = s.h
                    AND r.month = (
                      SELECT max(r2.month) FROM monthly_archive_rows r2
                        WHERE r2.client_id = c AND r2.kind = 'portfolio'
                          AND r2.source_id = s.id::TEXT)
              )
            ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
              SET data = EXCLUDED.data, content_hash = EXCLUDED.content_hash, archived_at = NOW();
          GET DIAGNOSTICS n = ROW_COUNT;
          run_counts := run_counts || jsonb_build_object('portfolio', n);

          INSERT INTO monthly_archive_rows
              (client_id, month, kind, source_id, occurred_at, content_hash, data)
            SELECT c, p_month, 'portfolio_target', s.id::TEXT, s.created_at, s.h, s.j
              FROM (
                SELECT t.id, t.created_at, md5(to_jsonb(t)::TEXT) AS h, to_jsonb(t) AS j
                  FROM portfolio_agent_targets t WHERE t.client_id = c
              ) s
              WHERE NOT EXISTS (
                SELECT 1 FROM monthly_archive_rows r
                  WHERE r.client_id = c AND r.kind = 'portfolio_target'
                    AND r.source_id = s.id::TEXT AND r.content_hash = s.h
                    AND r.month = (
                      SELECT max(r2.month) FROM monthly_archive_rows r2
                        WHERE r2.client_id = c AND r2.kind = 'portfolio_target'
                          AND r2.source_id = s.id::TEXT)
              )
            ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
              SET data = EXCLUDED.data, content_hash = EXCLUDED.content_hash, archived_at = NOW();
          GET DIAGNOSTICS n = ROW_COUNT;
          run_counts := run_counts || jsonb_build_object('portfolio_target', n);
        END IF;

        UPDATE monthly_archive_runs
          SET status = 'done', counts = run_counts, finished_at = NOW()
          WHERE client_id = c AND month = p_month;
      EXCEPTION WHEN OTHERS THEN
        -- One company's failure must not stop the others from being archived.
        UPDATE monthly_archive_runs
          SET status = 'failed', error = SQLERRM, finished_at = NOW()
          WHERE client_id = c AND month = p_month;
        run_counts := jsonb_build_object('error', SQLERRM);
      END;

      all_out := all_out || jsonb_build_object(c::TEXT, run_counts);
    END LOOP;

    RETURN all_out;
  END; $$;

-- Only the scheduler and the server's service-role key may run it. Left executable by default
-- it would let any signed-in user copy another company's data into the archive.

REVOKE ALL ON FUNCTION archive_month(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION archive_month(TEXT, UUID) TO service_role;
