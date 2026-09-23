-- Fix for 20260922_monthly_archive.sql: the first real run (2026-09-23) hit the 8s statement
-- timeout PostgREST applies to every API request (authenticator role) and rolled back, saving
-- nothing. Measured on production inside a rolled-back transaction: archive_month('2026-09') for
-- the largest company took 12.81s, almost all of it versioning 14,061 full debtor rows in one
-- statement — and debtor volume is about to grow several-fold.
--
-- So account versioning moves out of archive_month() into archive_debtor_versions(), which takes
-- an explicit list of debtor ids. The server calls it in batches of 1,000 (see
-- src/lib/archive-snapshot.server.ts), each far inside the limit, from three places: "Archive
-- now", the daily schedule on the 1st of each month, and immediately before a dead-account strip
-- (for exactly the accounts about to be stripped). Everything else archive_month() does — calls,
-- lookups, payments, messages, disputes, settlements, portfolio and target versions — is small
-- and stays as it was.
--
-- Raising statement_timeout for service_role instead was considered and rejected: it would lift
-- the limit for every server request, and a single statement would still grow with the data.

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

-- Versions the given accounts for one company and month: a new row only when an account differs
-- from its newest saved version (content_hash), same rule archive_month() used before. Idempotent.
-- Ids outside p_client are ignored, so a caller can never copy another company's rows.
CREATE OR REPLACE FUNCTION archive_debtor_versions(p_month TEXT, p_client UUID, p_debtor_ids UUID[])
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    n INTEGER;
  BEGIN
    IF p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'archive_debtor_versions: bad month "%" (want YYYY-MM)', p_month;
    END IF;

    INSERT INTO monthly_archive_rows
        (client_id, month, kind, source_id, phone_key, occurred_at, content_hash, data)
      SELECT p_client, p_month, 'debtor', s.id::TEXT, s.phone_key, s.created_at, s.h, s.j
        FROM (
          SELECT d.id, d.created_at,
                 right(regexp_replace(COALESCE(d.phone_primary, ''), '\D', '', 'g'), 10)
                   AS phone_key,
                 md5(to_jsonb(d)::TEXT) AS h,
                 to_jsonb(d) || jsonb_build_object('portfolio_name', p.name) AS j
            FROM debtors d LEFT JOIN portfolios p ON p.id = d.portfolio_id
            WHERE d.client_id = p_client AND d.id = ANY(p_debtor_ids)
        ) s
        WHERE NOT EXISTS (
          SELECT 1 FROM monthly_archive_rows r
            WHERE r.client_id = p_client AND r.kind = 'debtor' AND r.source_id = s.id::TEXT
              AND r.content_hash = s.h
              AND r.month = (
                SELECT max(r2.month) FROM monthly_archive_rows r2
                  WHERE r2.client_id = p_client AND r2.kind = 'debtor'
                    AND r2.source_id = s.id::TEXT)
        )
      ON CONFLICT (client_id, month, kind, source_id) DO UPDATE
        SET data = EXCLUDED.data, content_hash = EXCLUDED.content_hash,
            phone_key = EXCLUDED.phone_key, archived_at = NOW();
    GET DIAGNOSTICS n = ROW_COUNT;

    -- Keep the month's run summary meaningful now that accounts are saved in batches.
    UPDATE monthly_archive_runs
      SET counts = counts || jsonb_build_object('debtor', COALESCE((counts->>'debtor')::INT, 0) + n)
      WHERE client_id = p_client AND month = p_month;

    RETURN n;
  END; $$;

REVOKE ALL ON FUNCTION archive_month(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION archive_month(TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION archive_debtor_versions(TEXT, UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION archive_debtor_versions(TEXT, UUID, UUID[]) TO service_role;
