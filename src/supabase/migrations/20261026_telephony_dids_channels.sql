-- Phone numbers (DIDs) and channel shares on the shared SkyCRM trunk.
--
-- Builds on 20260926_skycrm_telephony.sql (live since 2026-09-30). The vendor supplies ~200 DIDs
-- and a trunk of N concurrent channels (60 expected) for every company on the platform:
--   * each DID belongs to at most ONE company at a time — the number a borrower calls back on is
--     what tells us which company the inbound call is for;
--   * each company has a guaranteed share of the channels (channel_reserved) and a ceiling
--     (channel_limit); between the two it borrows from a shared pool, and a slice of the trunk is
--     kept for inbound calls.
-- Rules live in src/lib/telephony/channel-plan.ts and did-rules.ts (pure, tested in
-- scripts/telephony-numbers.test.ts). telephony_reserve_channel_v2 below mirrors
-- channelHeadroom() — change them together.
--
-- Additive only: the old telephony_reserve_channel is left in place, and code falls back to it
-- while this file is not applied.

-- ─── 1. Platform-wide trunk settings (one row) ────────────────────────────────
-- check:sql server-only: telephony_platform
CREATE TABLE IF NOT EXISTS telephony_platform (
  id                    BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  -- Concurrent channels on the vendor trunk, across every company, inbound + outbound.
  total_channels        INTEGER NOT NULL DEFAULT 60 CHECK (total_channels >= 0),
  -- Channels outbound dialling may never take, so borrowers calling back still get through.
  inbound_reserve       INTEGER NOT NULL DEFAULT 8 CHECK (inbound_reserve >= 0),
  -- Days a released number rests before another company may get it.
  did_cooling_days      INTEGER NOT NULL DEFAULT 60 CHECK (did_cooling_days >= 0),
  -- Outbound calls per number per IST day when the number has no cap of its own.
  default_did_daily_cap INTEGER NOT NULL DEFAULT 150 CHECK (default_did_daily_cap > 0),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (inbound_reserve <= total_channels)
);
INSERT INTO telephony_platform (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE telephony_platform ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telephony_platform FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephony_platform TO service_role;

-- ─── 2. Guaranteed channels per company ───────────────────────────────────────
-- channel_limit (existing) is now the company's CEILING; channel_reserved is what it always gets.
ALTER TABLE telephony_settings
  ADD COLUMN IF NOT EXISTS channel_reserved INTEGER NOT NULL DEFAULT 0 CHECK (channel_reserved >= 0);

-- ─── 3. Number inventory ──────────────────────────────────────────────────────
-- check:sql server-only: telephony_dids
CREATE TABLE IF NOT EXISTS telephony_dids (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Last 10 digits (normaliseDid in did-rules.ts), so 0-/91-prefixed forms of one number collide.
  number        TEXT NOT NULL UNIQUE CHECK (number ~ '^[0-9]{10}$'),
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'assigned', 'cooling', 'blocked', 'retired')),
  use           TEXT NOT NULL DEFAULT 'both' CHECK (use IN ('outbound', 'inbound', 'both')),
  client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- Optional: only this portfolio's calls go out on this number (a lender wanting its own lines).
  portfolio_id  UUID REFERENCES portfolios(id) ON DELETE SET NULL,
  -- The SkyCRM ACD queue an inbound call on this number rings (vendor-assigned, e.g. 3011).
  vendor_queue  TEXT,
  daily_cap     INTEGER CHECK (daily_cap IS NULL OR daily_cap > 0),
  -- Out of outbound rotation until then (e.g. flagged as spam), still owned by the company.
  resting_until TIMESTAMPTZ,
  -- status = 'cooling': nobody may be given it before then.
  cooling_until TIMESTAMPTZ,
  assigned_at   TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'assigned') = (client_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS telephony_dids_client_idx ON telephony_dids (client_id) WHERE client_id IS NOT NULL;

ALTER TABLE telephony_dids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telephony_dids FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephony_dids TO service_role;

-- Who held each number, when. Answers "whose borrower is calling this old number?" after a release.
-- check:sql server-only: telephony_did_assignments
CREATE TABLE IF NOT EXISTS telephony_did_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  did_id      UUID NOT NULL REFERENCES telephony_dids(id) ON DELETE CASCADE,
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS telephony_did_assignments_did_idx ON telephony_did_assignments (did_id, assigned_at DESC);

ALTER TABLE telephony_did_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telephony_did_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephony_did_assignments TO service_role;

-- ─── 4. Ledger: which number each call used, and missed-call follow-up ─────────
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS did_id UUID REFERENCES telephony_dids(id) ON DELETE SET NULL;
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS did_number TEXT;
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS debtor_id UUID REFERENCES debtors(id) ON DELETE SET NULL;
-- Missed inbound calls: set when someone at the company has called the borrower back.
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS callback_done_at TIMESTAMPTZ;
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS callback_by UUID REFERENCES agents(id) ON DELETE SET NULL;

-- Calls per number today (daily cap) and the number a borrower was last called from (same number
-- every time).
CREATE INDEX IF NOT EXISTS telephony_calls_did_started_idx
  ON telephony_calls (did_id, started_at) WHERE did_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telephony_calls_sticky_idx
  ON telephony_calls (client_id, remote_phone, started_at DESC)
  WHERE direction = 'outbound' AND did_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telephony_calls_missed_idx
  ON telephony_calls (client_id, started_at DESC)
  WHERE direction = 'inbound' AND answered_at IS NULL;

-- ─── 5. Refused dials ─────────────────────────────────────────────────────────
-- One row each time a dial was turned away for lack of a free line or number. The count per day
-- is what says the trunk (or a company's share) is too small.
-- check:sql server-only: telephony_refusals
CREATE TABLE IF NOT EXISTS telephony_refusals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL CHECK (reason IN ('company_limit', 'platform_busy', 'no_number')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS telephony_refusals_created_idx ON telephony_refusals (created_at, client_id);

ALTER TABLE telephony_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telephony_refusals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephony_refusals TO service_role;

-- ─── 6. Channel reservation with guaranteed shares ────────────────────────────
-- Same lock as v1 (both may run during a deploy). An outbound call is allowed when:
--   the trunk is not full, AND the company is under its ceiling, AND either
--   (a) it is still inside its own guaranteed share, or
--   (b) the shared pool has a line: total − max(inbound open, inbound reserve)
--       − Σ over companies max(their open outbound, their guaranteed share) > 0.
-- Mirrors channelHeadroom() in src/lib/telephony/channel-plan.ts.
CREATE OR REPLACE FUNCTION telephony_reserve_channel_v2(
  p_client_id     UUID,
  p_stale_minutes INTEGER,
  p_agent_id      UUID,
  p_provider      TEXT,
  p_ref_id        TEXT,
  p_agent_handle  TEXT,
  p_remote_phone  TEXT,
  p_did_id        UUID,
  p_did_number    TEXT,
  p_debtor_id     UUID
) RETURNS UUID
  LANGUAGE plpgsql
  SET search_path = public
  AS $$
  DECLARE
    v_total        INTEGER;
    v_in_reserve   INTEGER;
    v_reserved     INTEGER;
    v_max          INTEGER;
    v_all          INTEGER;
    v_inbound      INTEGER;
    v_mine         INTEGER;
    v_held         INTEGER;
    v_id           UUID;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('telephony_reserve_channel'));

    SELECT total_channels, inbound_reserve INTO v_total, v_in_reserve FROM telephony_platform LIMIT 1;
    v_total := COALESCE(v_total, 60);
    v_in_reserve := COALESCE(v_in_reserve, 8);

    SELECT channel_reserved, channel_limit INTO v_reserved, v_max
      FROM telephony_settings WHERE client_id = p_client_id;
    -- No row: only the simulator gets this far (a real provider is refused before dialling).
    v_reserved := COALESCE(v_reserved, 0);
    v_max := COALESCE(v_max, v_total);

    SELECT count(*),
           count(*) FILTER (WHERE direction = 'inbound'),
           count(*) FILTER (WHERE direction = 'outbound' AND client_id = p_client_id)
      INTO v_all, v_inbound, v_mine
      FROM telephony_calls
     WHERE ended_at IS NULL AND started_at > NOW() - make_interval(mins => p_stale_minutes);

    IF v_all >= v_total THEN
      RAISE EXCEPTION 'CHANNEL_LIMIT_GLOBAL';
    END IF;
    IF v_mine >= v_max THEN
      RAISE EXCEPTION 'CHANNEL_LIMIT_COMPANY';
    END IF;
    IF v_mine >= v_reserved THEN
      SELECT COALESCE(SUM(GREATEST(COALESCE(o.n, 0), COALESCE(s.reserved, 0))), 0)
        INTO v_held
        FROM (SELECT client_id, count(*) AS n FROM telephony_calls
               WHERE ended_at IS NULL AND direction = 'outbound'
                 AND started_at > NOW() - make_interval(mins => p_stale_minutes)
               GROUP BY client_id) o
        FULL JOIN (SELECT client_id, channel_reserved AS reserved FROM telephony_settings
                    WHERE enabled) s
          ON s.client_id = o.client_id;
      v_held := v_held + GREATEST(v_inbound, v_in_reserve);
      IF v_held >= v_total THEN
        RAISE EXCEPTION 'CHANNEL_LIMIT_GLOBAL';
      END IF;
    END IF;

    INSERT INTO telephony_calls
      (client_id, agent_id, provider, ref_id, direction, agent_handle, remote_phone,
       did_id, did_number, debtor_id)
    VALUES
      (p_client_id, p_agent_id, p_provider, p_ref_id, 'outbound', p_agent_handle, p_remote_phone,
       p_did_id, p_did_number, p_debtor_id)
    RETURNING id INTO v_id;
    RETURN v_id;
  END $$;

REVOKE ALL ON FUNCTION telephony_reserve_channel_v2(UUID, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION telephony_reserve_channel_v2(UUID, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, UUID)
  TO service_role;

-- ─── 7. Usage per number, refusals per company (reports + daily cap) ──────────
-- Plain reads stop at 1,000 rows; a company with 15 numbers at 150 calls each passes that by
-- mid-day, so the counts are done here.
CREATE OR REPLACE FUNCTION telephony_did_usage(
  p_did_ids    UUID[],
  p_day_start  TIMESTAMPTZ,
  p_week_start TIMESTAMPTZ
) RETURNS TABLE (did_id UUID, calls_today INTEGER, calls_7d INTEGER, answered_7d INTEGER)
  LANGUAGE sql
  STABLE
  SET search_path = public
  AS $$
    SELECT c.did_id,
           count(*) FILTER (WHERE c.started_at >= p_day_start)::INTEGER,
           count(*) FILTER (WHERE c.direction = 'outbound')::INTEGER,
           count(*) FILTER (WHERE c.direction = 'outbound' AND c.answered_at IS NOT NULL)::INTEGER
      FROM telephony_calls c
     WHERE c.did_id = ANY (p_did_ids)
       AND c.started_at >= LEAST(p_day_start, p_week_start)
     GROUP BY c.did_id
  $$;

REVOKE ALL ON FUNCTION telephony_did_usage(UUID[], TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION telephony_did_usage(UUID[], TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION telephony_refusal_counts(p_since TIMESTAMPTZ)
  RETURNS TABLE (client_id UUID, reason TEXT, n INTEGER)
  LANGUAGE sql
  STABLE
  SET search_path = public
  AS $$
    SELECT r.client_id, r.reason, count(*)::INTEGER
      FROM telephony_refusals r
     WHERE r.created_at >= p_since
     GROUP BY r.client_id, r.reason
  $$;

REVOKE ALL ON FUNCTION telephony_refusal_counts(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION telephony_refusal_counts(TIMESTAMPTZ) TO service_role;
