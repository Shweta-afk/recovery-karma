-- Insights outcome report: what each lookup turned up, and what happened on the account after.
--
-- The usage reports (20260905_profilex_usage_detail.sql) answer "who spent what". This answers
-- "was it worth it": one row per lookup, joined to the account's portfolio, manager and agent,
-- plus the calls, contacts, promises and payments recorded on that debtor AFTER the lookup ran
-- (and a before-count, so a lookup on an account that was already in contact is not credited
-- with the contact). Attribution is by time on the same account — it cannot prove the lookup
-- caused a payment, and the report says so.
--
-- call_logs.dialed_phone is new: the number the agent actually rang. Until now a call on a
-- debtor recorded only debtor_id, so "an Insights-found number was called and it connected" was
-- unanswerable. saveDisposition writes it best-effort; older rows stay NULL.
--
-- Whether a lookup was useful is CALCULATED, not rated by hand (src/lib/profilex/outcome.ts):
-- from the dispositions after it and from payments — split by source, so a payment that arrived
-- through the bank's paid file ('bank_reported') is shown as such. A paid-file row with no amount
-- only sets debtors.status = 'paid' (applyBulkPaidFile) with no timestamp, hence debtor_status +
-- paid_before: "marked paid, and nothing was paid before the lookup" still counts.
--
-- DROP then CREATE rather than CREATE OR REPLACE: the return shape changed once already (a
-- manual-feedback version was applied on 2026-09-27 and withdrawn the same day — see
-- 20260927_insights_outcome_report_v2.sql), and OR REPLACE cannot change a return type.
--
-- SECURITY INVOKER, called with the user's own token (asCaller in profilex-actions.server.ts):
-- debtor_traces / call_logs / payments / debtors RLS scopes it exactly as the rest of the app —
-- an admin sees their company, a manager their own team. Never call it through service_role.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS dialed_phone TEXT;

DROP FUNCTION IF EXISTS insights_outcome_report(TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, INT);

CREATE FUNCTION insights_outcome_report(
  p_since        TIMESTAMPTZ,
  p_until        TIMESTAMPTZ DEFAULT NULL,
  p_manager_id   UUID DEFAULT NULL,
  p_portfolio_id UUID DEFAULT NULL,
  p_limit        INT DEFAULT 5000
)
  RETURNS TABLE (
    trace_id               UUID,
    created_at             TIMESTAMPTZ,
    service_id             TEXT,
    state                  TEXT,
    provider_status        TEXT,
    billable               BOOLEAN,
    cost                   NUMERIC,
    response               JSONB,
    requested_by_name      TEXT,
    requested_by_role      TEXT,
    debtor_id              UUID,
    debtor_name            TEXT,
    loan_reference         TEXT,
    phone_primary          TEXT,
    loan_amount            NUMERIC,
    dpd                    INTEGER,
    portfolio_id           UUID,
    portfolio_name         TEXT,
    lender_name            TEXT,
    product_type           TEXT,
    manager_id             UUID,
    manager_name           TEXT,
    agent_name             TEXT,
    calls_before           INTEGER,
    contacted_before       BOOLEAN,
    calls_after            INTEGER,
    contacts_after         INTEGER,
    first_call_after_at    TIMESTAMPTZ,
    first_contact_after_at TIMESTAMPTZ,
    best_outcome_after     TEXT,
    best_notes_after       TEXT,
    last_outcome_after     TEXT,
    last_outcome_at        TIMESTAMPTZ,
    last_notes_after       TEXT,
    ptp_amount             NUMERIC,
    ptp_date               DATE,
    dialed_after           TEXT[],
    dialed_contacted_after TEXT[],
    paid_amount_after      NUMERIC,
    last_paid_at           TIMESTAMPTZ,
    paid_file_amount_after NUMERIC,
    paid_before            BOOLEAN,
    debtor_status          TEXT
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    WITH base AS (
      SELECT
        t.*,
        d.name            AS d_name,
        d.loan_reference  AS d_loan_ref,
        d.phone_primary   AS d_phone,
        d.loan_amount     AS d_loan_amount,
        d.dpd             AS d_dpd,
        d.assigned_agent_id,
        d.status          AS d_status,
        p.id              AS p_id,
        p.name            AS p_name,
        p.lender_name     AS p_lender,
        p.product_type    AS p_product,
        -- The portfolio's manager, else its team's manager. Null on an orphaned portfolio (see
        -- the orphaned-portfolio note in CLAUDE.md) — then whoever ran the lookup, if a manager.
        COALESCE(p.manager_id, tm.manager_id,
                 CASE WHEN rb.role = 'manager' THEN rb.id END) AS mgr_id,
        rb.name           AS rb_name,
        rb.role           AS rb_role
      FROM debtor_traces t
      LEFT JOIN debtors d    ON d.id = t.debtor_id
      LEFT JOIN portfolios p ON p.id = d.portfolio_id
      LEFT JOIN teams tm     ON tm.id = p.team_id
      LEFT JOIN agents rb    ON rb.id = t.requested_by
      WHERE t.created_at >= p_since
        AND (p_until IS NULL OR t.created_at < p_until)
        AND (p_portfolio_id IS NULL OR p.id = p_portfolio_id)
    )
    SELECT
      b.id, b.created_at, b.service_id::text, b.state, b.provider_status, b.billable, b.cost,
      b.response,
      COALESCE(b.rb_name, 'Unknown')::text, COALESCE(b.rb_role, '')::text,
      b.debtor_id, COALESCE(b.d_name, 'Unknown')::text, COALESCE(b.d_loan_ref, '')::text,
      COALESCE(b.d_phone, '')::text, b.d_loan_amount, b.d_dpd,
      b.p_id, COALESCE(b.p_name, '')::text, COALESCE(b.p_lender, '')::text,
      COALESCE(b.p_product, '')::text,
      b.mgr_id, COALESCE(mg.name, '')::text, COALESCE(ag.name, '')::text,
      COALESCE(bef.calls, 0)::int, COALESCE(bef.contacted, FALSE),
      COALESCE(aft.calls, 0)::int, COALESCE(aft.contacts, 0)::int,
      aft.first_call, aft.first_contact,
      best.outcome, best.raw_notes,
      last.outcome, last.created_at, last.raw_notes,
      ptp.promise_amount, ptp.promise_date,
      COALESCE(aft.dialed, '{}'), COALESCE(aft.dialed_contacted, '{}'),
      COALESCE(pay.amount, 0), pay.last_at,
      COALESCE(pay.file_amount, 0), COALESCE(pay.before, FALSE), COALESCE(b.d_status, '')::text
    FROM base b
    LEFT JOIN agents mg ON mg.id = b.mgr_id
    LEFT JOIN agents ag ON ag.id = b.assigned_agent_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS calls,
             bool_or(c.outcome IN ('paid','promised','refused','callback','dispute','settlement','escalated')) AS contacted
      FROM call_logs c
      WHERE c.debtor_id = b.debtor_id AND c.created_at < b.created_at
    ) bef ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS calls,
             count(*) FILTER (WHERE c.outcome IN ('paid','promised','refused','callback','dispute','settlement','escalated')) AS contacts,
             min(c.created_at) AS first_call,
             min(c.created_at) FILTER (WHERE c.outcome IN ('paid','promised','refused','callback','dispute','settlement','escalated')) AS first_contact,
             array_agg(DISTINCT c.dialed_phone) FILTER (WHERE c.dialed_phone IS NOT NULL) AS dialed,
             array_agg(DISTINCT c.dialed_phone) FILTER (
               WHERE c.dialed_phone IS NOT NULL
                 AND c.outcome IN ('paid','promised','refused','callback','dispute','settlement','escalated')
             ) AS dialed_contacted
      FROM call_logs c
      WHERE c.debtor_id = b.debtor_id AND c.created_at >= b.created_at
    ) aft ON TRUE
    -- Best = most advanced disposition after the lookup, the same idea as the "Best Disposition"
    -- column in the collections-platform export this report is modelled on.
    LEFT JOIN LATERAL (
      SELECT c.outcome, c.raw_notes
      FROM call_logs c
      WHERE c.debtor_id = b.debtor_id AND c.created_at >= b.created_at
      ORDER BY CASE c.outcome
                 WHEN 'paid' THEN 1 WHEN 'settlement' THEN 2 WHEN 'promised' THEN 3
                 WHEN 'callback' THEN 4 WHEN 'dispute' THEN 5 WHEN 'refused' THEN 6
                 WHEN 'escalated' THEN 7 WHEN 'wrong_number' THEN 8 WHEN 'voicemail' THEN 9
                 WHEN 'no_answer' THEN 10 ELSE 11 END,
               c.created_at DESC
      LIMIT 1
    ) best ON TRUE
    LEFT JOIN LATERAL (
      SELECT c.outcome, c.created_at, c.raw_notes
      FROM call_logs c
      WHERE c.debtor_id = b.debtor_id AND c.created_at >= b.created_at
      ORDER BY c.created_at DESC
      LIMIT 1
    ) last ON TRUE
    LEFT JOIN LATERAL (
      SELECT c.promise_amount, c.promise_date
      FROM call_logs c
      WHERE c.debtor_id = b.debtor_id AND c.created_at >= b.created_at AND c.outcome = 'promised'
      ORDER BY c.created_at DESC
      LIMIT 1
    ) ptp ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        sum(py.amount) FILTER (WHERE COALESCE(py.received_at, py.created_at) >= b.created_at) AS amount,
        sum(py.amount) FILTER (WHERE COALESCE(py.received_at, py.created_at) >= b.created_at
                                 AND py.source = 'bank_reported') AS file_amount,
        max(COALESCE(py.received_at, py.created_at))
          FILTER (WHERE COALESCE(py.received_at, py.created_at) >= b.created_at) AS last_at,
        bool_or(COALESCE(py.received_at, py.created_at) < b.created_at) AS before
      FROM payments py
      WHERE py.debtor_id = b.debtor_id
        AND COALESCE(py.status, 'completed') = 'completed'
    ) pay ON TRUE
    WHERE p_manager_id IS NULL OR b.mgr_id = p_manager_id OR b.requested_by = p_manager_id
    ORDER BY b.created_at DESC
    LIMIT p_limit
  $$;

REVOKE ALL ON FUNCTION insights_outcome_report(TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION insights_outcome_report(TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, INT) TO authenticated, service_role;
