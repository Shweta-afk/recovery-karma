-- SkyCRM-ACD as the production voice provider, shared across every company on the platform.
--
-- One SkyCRM account (one set of extensions, one trunk of 60 channels, 3 DIDs) serves all tenants,
-- so this migration adds what the server needs to enforce who may use how much of it, plus the
-- compliance rules the MSA's indemnity makes Axiotta liable for. Enforcement lives in
-- src/lib/telephony/guard.server.ts, called before every dial in src/lib/telephony/server.ts.

-- ─── 1. Per-company telephony settings ─────────────────────────────────────────
-- Superadmin-written (saveCompanyTelephonySettings), read by the company's own users. A company
-- with no row may only use the simulator; a real provider requires enabled = true.
CREATE TABLE IF NOT EXISTS telephony_settings (
  client_id         UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  enabled           BOOLEAN NOT NULL DEFAULT false,
  -- How many SkyCRM extensions this company may hold. NULL = no cap.
  seat_limit        INTEGER CHECK (seat_limit IS NULL OR seat_limit >= 0),
  -- This company's share of the trunk's concurrent channels.
  channel_limit     INTEGER NOT NULL DEFAULT 0 CHECK (channel_limit >= 0),
  inbound_did       TEXT,
  inbound_queue     TEXT,
  -- IST calling window. Defaults follow RBI's recovery-agent rule (no calls before 08:00 or
  -- after 19:00); a superadmin may only narrow it, never widen it (CHECK below).
  call_window_start TIME NOT NULL DEFAULT '08:00',
  call_window_end   TIME NOT NULL DEFAULT '19:00',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (call_window_start >= '08:00' AND call_window_end <= '19:00'
         AND call_window_start < call_window_end)
);

ALTER TABLE telephony_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telephony_settings_select ON telephony_settings;
CREATE POLICY telephony_settings_select ON telephony_settings FOR SELECT TO authenticated
  USING (client_id = auth_client_id());
-- No write policies: only the service-role client (superadmin actions) writes.

REVOKE ALL ON TABLE telephony_settings FROM PUBLIC, anon;
GRANT SELECT ON TABLE telephony_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephony_settings TO service_role;

-- ─── 2. Agent extensions ───────────────────────────────────────────────────────
-- Unique across ALL companies: one SkyCRM account spans every tenant, so an extension is a
-- platform-wide resource. Assigned only by a superadmin (setAgentExtension).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_extension TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS agents_extension_unique
  ON agents (agent_extension) WHERE agent_extension IS NOT NULL;

-- agents_update lets a user edit their own row; without this they could claim an unassigned
-- extension (another company's seat). A separate trigger so the existing
-- agents_guard_privileged_columns (last redefined 20260920) is left untouched.
CREATE OR REPLACE FUNCTION agents_guard_extension() RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'service_role' AND NEW.agent_extension IS DISTINCT FROM OLD.agent_extension THEN
      RAISE EXCEPTION 'agent_extension can only be changed by a superadmin';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS agents_guard_extension_trg ON agents;
CREATE TRIGGER agents_guard_extension_trg
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_guard_extension();

-- ─── 3. Do-not-call list ───────────────────────────────────────────────────────
-- Per company. `phone` is the last 10 digits (see normalisePhone in guard-rules.ts) so +91 /
-- 0-prefixed / spaced variants of one number collide. Written only through server functions
-- (dnc-actions.server.ts) so the role checks and normalisation can't be skipped.
CREATE TABLE IF NOT EXISTS do_not_call (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  phone      TEXT NOT NULL CHECK (phone ~ '^[0-9]{10}$'),
  debtor_id  UUID REFERENCES debtors(id) ON DELETE SET NULL,
  reason     TEXT,
  added_by   UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, phone)
);

ALTER TABLE do_not_call ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS do_not_call_select ON do_not_call;
CREATE POLICY do_not_call_select ON do_not_call FOR SELECT TO authenticated
  USING (client_id = auth_client_id());

REVOKE ALL ON TABLE do_not_call FROM PUBLIC, anon;
GRANT SELECT ON TABLE do_not_call TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE do_not_call TO service_role;

-- ─── 4. Call ledger (server-only) ──────────────────────────────────────────────
-- One row per provider call, written by the server at dial time. call_logs can't carry this:
-- that row is only written when the agent submits a disposition, after the call. The ledger is
-- what makes SkyCRM hangup survive a restart (it needs extension + phone, not a call id), what
-- webhook events are matched against, and the authoritative count of channels in use.
-- check:sql server-only: telephony_calls
CREATE TABLE IF NOT EXISTS telephony_calls (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
  provider         TEXT NOT NULL,
  -- The id handed back to the browser / dialer engine for this call.
  provider_call_id TEXT,
  -- The callLogId the browser sent (a debtor id for single calls, a leg id for dialer runs).
  ref_id           TEXT,
  direction        TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  -- What the provider rang on our side: an extension for SkyCRM, a phone for the simulator.
  agent_handle     TEXT,
  remote_phone     TEXT,
  -- SkyCRM's own call id ("1756471568.293338"), learned from the first webhook event.
  vendor_callid    TEXT,
  status           TEXT NOT NULL DEFAULT 'dialing',
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  duration_seconds INTEGER,
  -- SkyCRM's recordfile: a path on the vendor's private network, NOT a playable URL.
  recording_path   TEXT
);

CREATE INDEX IF NOT EXISTS telephony_calls_open_idx
  ON telephony_calls (client_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS telephony_calls_open_handle_idx
  ON telephony_calls (agent_handle) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS telephony_calls_provider_call_idx ON telephony_calls (provider_call_id);
-- UNIQUE: two webhook events for a new inbound call can arrive together and both find no row;
-- the loser's insert fails here and it re-reads the winner's row (webhook-reconcile.server.ts).
CREATE UNIQUE INDEX IF NOT EXISTS telephony_calls_vendor_callid_idx
  ON telephony_calls (vendor_callid) WHERE vendor_callid IS NOT NULL;

ALTER TABLE telephony_calls ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.
REVOKE ALL ON TABLE telephony_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE telephony_calls TO service_role;

-- ─── 5. Atomic channel reservation ─────────────────────────────────────────────
-- Counting open calls and inserting the new one must happen under one lock, or two dials at the
-- same instant can both see 59/60 and both go through. Rows older than p_stale_minutes with no
-- end are ignored, so a lost hangup webhook can't hold a channel forever.
CREATE OR REPLACE FUNCTION telephony_reserve_channel(
  p_client_id     UUID,
  p_client_limit  INTEGER,
  p_global_limit  INTEGER,
  p_stale_minutes INTEGER,
  p_agent_id      UUID,
  p_provider      TEXT,
  p_ref_id        TEXT,
  p_direction     TEXT,
  p_agent_handle  TEXT,
  p_remote_phone  TEXT
) RETURNS UUID
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v_client INTEGER;
    v_global INTEGER;
    v_id     UUID;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('telephony_reserve_channel'));
    SELECT count(*) FILTER (WHERE client_id = p_client_id), count(*)
      INTO v_client, v_global
      FROM telephony_calls
     WHERE ended_at IS NULL
       AND started_at > NOW() - make_interval(mins => p_stale_minutes);
    IF v_client >= p_client_limit THEN
      RAISE EXCEPTION 'CHANNEL_LIMIT_COMPANY';
    END IF;
    IF v_global >= p_global_limit THEN
      RAISE EXCEPTION 'CHANNEL_LIMIT_GLOBAL';
    END IF;
    INSERT INTO telephony_calls
      (client_id, agent_id, provider, ref_id, direction, agent_handle, remote_phone)
    VALUES
      (p_client_id, p_agent_id, p_provider, p_ref_id, p_direction, p_agent_handle, p_remote_phone)
    RETURNING id INTO v_id;
    RETURN v_id;
  END $$;

REVOKE ALL ON FUNCTION telephony_reserve_channel(UUID, INTEGER, INTEGER, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION telephony_reserve_channel(UUID, INTEGER, INTEGER, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;
