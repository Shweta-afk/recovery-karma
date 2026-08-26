-- ProfileX (Neokred) skip-tracing: the spend ledger and the result store.
--
-- One row per API call in `debtor_traces` — it is simultaneously the audit trail (who spent
-- money on whom), the billing record (ProfileX has NO balance/usage endpoint, so this is the
-- only place spend exists on our side) and the cache (a repeat lookup inside the TTL is served
-- from here for free). `profilex_settings` holds the per-client budget cap and rate card.
--
-- RLS follows the rule from 20260821_rls_no_direct_table_reads.sql that no policy may read an
-- RLS-protected table directly: `auth_my_debtor_ids()` is a plpgsql SECURITY DEFINER helper
-- (never LANGUAGE sql — that gets inlined and re-enters agents' policy, which is what took
-- production down on 2026-08-14 and -08-21).

CREATE TABLE IF NOT EXISTS debtor_traces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id),
  debtor_id        UUID NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  -- Slug from src/lib/profilex/catalogue.ts, not a ProfileX UUID: the catalogue is the source
  -- of truth for paths/service-ids and those can change without invalidating history.
  service_id       TEXT NOT NULL,
  requested_by     UUID REFERENCES agents(id),
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','done','failed')),
  http_status      INTEGER,
  -- The provider's own `data.status`: '1' found, '2'/'3' not found. Nullable because at least
  -- one endpoint returns success with a null status.
  provider_status  TEXT,
  billable         BOOLEAN NOT NULL DEFAULT FALSE,
  cost             NUMERIC(10,2) NOT NULL DEFAULT 0,
  transaction_id   TEXT,
  response         JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

-- Cache lookups and the debtor's Trace tab: newest call for one debtor+service.
CREATE INDEX IF NOT EXISTS debtor_traces_debtor_service_idx
  ON debtor_traces (debtor_id, service_id, created_at DESC);

-- Monthly spend rollup for the budget check and the admin report.
CREATE INDEX IF NOT EXISTS debtor_traces_client_created_idx
  ON debtor_traces (client_id, created_at DESC);

-- Stops a double-click, or two managers on the same debtor, from paying twice: the second
-- insert collides with the in-flight row instead of firing a second billable request.
CREATE UNIQUE INDEX IF NOT EXISTS debtor_traces_one_in_flight_idx
  ON debtor_traces (debtor_id, service_id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS profilex_settings (
  client_id       UUID PRIMARY KEY REFERENCES clients(id),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  -- ₹ per calendar month (IST). Enforced server-side in profilex-actions.server.ts — it cannot
  -- live in org-settings-store.ts, which is localStorage-only and unreadable by the server.
  monthly_budget  NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Employment data moves slowly, so a found result is reusable for a month. A miss caches for
  -- a week: long enough not to re-buy a dead lookup daily, short enough that data appearing
  -- later is still reachable.
  hit_ttl_hours   INTEGER NOT NULL DEFAULT 720,
  miss_ttl_hours  INTEGER NOT NULL DEFAULT 168,
  -- { "<service-slug>": { "<provider status>": <₹> } }, overriding catalogue list prices.
  rate_card       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES agents(id)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────

-- "Which debtors may I see" — mirrors debtors_select exactly, so a trace is visible to precisely
-- the people who can already see the debtor it belongs to: the assigned agent, their manager,
-- and admins. Wrapping it in a SECURITY DEFINER helper keeps debtor_traces_select from reading
-- `debtors` directly, which would re-enter debtors_select and risk a new recursion cycle.
CREATE OR REPLACE FUNCTION auth_my_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; r TEXT; cid UUID;
  BEGIN
    me := auth_agent_id();
    r := auth_role();
    cid := auth_client_id();
    RETURN QUERY
    SELECT id FROM debtors
      WHERE client_id = cid
        AND (
          r = 'admin'
          OR assigned_agent_id = me
          OR (
            r = 'manager'
            AND (
              assigned_agent_id IN (SELECT auth_visible_agent_ids())
              OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
            )
          )
        );
  END; $$;

ALTER TABLE debtor_traces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS debtor_traces_select ON debtor_traces;
CREATE POLICY debtor_traces_select ON debtor_traces FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND debtor_id IN (SELECT auth_my_debtor_ids()));

-- Deliberately NO insert/update/delete policy. Every write goes through the service-role server
-- action, which is the only thing that has verified the caller is a manager/admin, checked the
-- budget and actually paid ProfileX. An agent cannot create a trace and a manager cannot forge
-- one from the browser.

ALTER TABLE profilex_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profilex_settings_select ON profilex_settings;
CREATE POLICY profilex_settings_select ON profilex_settings FOR SELECT TO authenticated
  USING (client_id = auth_client_id());

-- Writes are service-role only too: the budget cap is worthless if a manager can PATCH it.

-- ── Spend aggregates ─────────────────────────────────────────────────────────
-- Summing in SQL rather than pulling rows into JS: PostgREST caps a select at 1000 rows by
-- default, and a silently truncated sum would under-report spend and let the budget cap be
-- sailed straight past — the one number this whole feature exists to get right.

-- The budget gate, called by the service-role server action before every paid request.
-- SECURITY DEFINER + an explicit client_id (service_role has no agents row, so auth_client_id()
-- is null for it), locked down to service_role so a browser can never aim it at another tenant.
CREATE OR REPLACE FUNCTION profilex_month_spend(p_client_id UUID, p_since TIMESTAMPTZ)
  RETURNS NUMERIC
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE total NUMERIC;
  BEGIN
    SELECT COALESCE(SUM(cost), 0) INTO total
      FROM debtor_traces
      WHERE client_id = p_client_id AND created_at >= p_since;
    RETURN total;
  END; $$;

REVOKE ALL ON FUNCTION profilex_month_spend(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_month_spend(UUID, TIMESTAMPTZ) TO service_role;

-- The admin report. SECURITY INVOKER on purpose so debtor_traces' own policy still applies and
-- a manager sees only their team's spend — same masking as report_agent_account_counts().
CREATE OR REPLACE FUNCTION profilex_spend_report(p_since TIMESTAMPTZ)
  RETURNS TABLE (
    service_id  TEXT,
    calls       BIGINT,
    hits        BIGINT,
    misses      BIGINT,
    failures    BIGINT,
    spend       NUMERIC
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    SELECT
      t.service_id::text,
      count(*)                                                        AS calls,
      count(*) FILTER (WHERE t.provider_status = '1')                 AS hits,
      -- Paid for, returned nothing: the number that says whether this is worth continuing.
      count(*) FILTER (WHERE t.billable AND t.provider_status <> '1') AS misses,
      count(*) FILTER (WHERE t.state = 'failed')                      AS failures,
      COALESCE(SUM(t.cost), 0)                                        AS spend
    FROM debtor_traces t
    WHERE t.created_at >= p_since
    GROUP BY t.service_id
    ORDER BY spend DESC;
  $$;
