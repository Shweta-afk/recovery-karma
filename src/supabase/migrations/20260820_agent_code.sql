-- ============================================================
-- SamvadX — auto-generated Agent ID for every agent/manager/admin
-- Run in Supabase → SQL Editor, after schema.sql (+ every later migration).
--
-- Adds agents.agent_code — a short, stable identifier (AGT-0001, MGR-0002,
-- ADM-0003, ...) independent of name/email, meant to be the primary match
-- key in "Upload Mapping CSV" instead of an agent's full name — matching
-- on name is fragile (spelling variants, duplicate names, case), matching
-- on this code is exact by construction.
--
-- Assigned automatically, no app code needs to set it:
--   - backfilled below for every existing row
--   - auto-assigned on every future INSERT via trigger (the app's plain
--     `.insert({...})` in user-admin-actions.server.ts never sets
--     agent_code, so it's always NULL going in and the trigger fills it)
--
-- Safe to re-run — every statement is idempotent.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS agent_code_seq;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_code TEXT;

-- Shared by the backfill below and the insert trigger — LANGUAGE sql is fine
-- here (unlike the SECURITY DEFINER helpers elsewhere in this repo) since
-- this is never called from inside an RLS policy, so the inlining pitfall
-- documented in CLAUDE.md's RLS-recursion section doesn't apply.
CREATE OR REPLACE FUNCTION next_agent_code(p_role TEXT)
RETURNS TEXT
LANGUAGE sql
AS $$
  SELECT
    (CASE p_role
      WHEN 'agent' THEN 'AGT'
      WHEN 'manager' THEN 'MGR'
      WHEN 'admin' THEN 'ADM'
      ELSE 'USR'
    END) || '-' || LPAD(nextval('agent_code_seq')::TEXT, 4, '0');
$$;

-- One-time backfill for rows that predate this column. Looped (not a set-
-- based UPDATE) so nextval() is called in created_at order — cosmetic, but
-- keeps early accounts numbered lower. Guarded by agent_code IS NULL so a
-- re-run only touches rows that still need one.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id, role FROM agents WHERE agent_code IS NULL ORDER BY created_at LOOP
    UPDATE agents SET agent_code = next_agent_code(r.role) WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_agent_code ON agents(agent_code);

CREATE OR REPLACE FUNCTION assign_agent_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.agent_code IS NULL THEN
    NEW.agent_code := next_agent_code(NEW.role);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_agent_code ON agents;
CREATE TRIGGER trg_assign_agent_code
  BEFORE INSERT ON agents
  FOR EACH ROW
  EXECUTE FUNCTION assign_agent_code();
