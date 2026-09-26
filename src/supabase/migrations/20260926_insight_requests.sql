-- Agents asking their manager to run Insights on a debtor.
--
-- Agents cannot run a lookup (it costs money — see 20260826_profilex_traces.sql), so the Insights
-- tab gives them "Request from manager" instead. One row per request. The request is closed
-- automatically the moment any lookup on that debtor completes, so a manager never has to tidy
-- the list by hand.
--
-- Notifications are sent from triggers rather than the browser: working out "who is this agent's
-- manager" needs teams/team_agents/portfolios, and doing it here keeps it one atomic step with the
-- insert — a request can't exist without its notification, or vice versa.
--
-- RLS follows 20260821_rls_no_direct_table_reads.sql: policies only call SECURITY DEFINER
-- helpers (auth_my_debtor_ids() mirrors debtors_select), never read a protected table directly.

CREATE TABLE IF NOT EXISTS insight_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id),
  debtor_id     UUID NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
  requested_by  UUID REFERENCES agents(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES agents(id) ON DELETE SET NULL
);

-- At most one open request per debtor: a second agent (or a double-click) asking again is the
-- same request, not a second notification.
CREATE UNIQUE INDEX IF NOT EXISTS insight_requests_one_open_idx
  ON insight_requests (debtor_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS insight_requests_client_status_idx
  ON insight_requests (client_id, status);

ALTER TABLE insight_requests ENABLE ROW LEVEL SECURITY;

-- Visible to exactly the people who can see the debtor.
DROP POLICY IF EXISTS insight_requests_select ON insight_requests;
CREATE POLICY insight_requests_select ON insight_requests FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND debtor_id IN (SELECT auth_my_debtor_ids()));

-- Anyone who can see the debtor may open a request, in their own name only.
DROP POLICY IF EXISTS insight_requests_insert ON insight_requests;
CREATE POLICY insight_requests_insert ON insight_requests FOR INSERT TO authenticated
  WITH CHECK (
    client_id = auth_client_id()
    AND requested_by = auth_agent_id()
    AND status = 'open'
    AND debtor_id IN (SELECT auth_my_debtor_ids())
  );

-- Managers/admins may close a request (done or dismissed) on a debtor they can see.
DROP POLICY IF EXISTS insight_requests_update ON insight_requests;
CREATE POLICY insight_requests_update ON insight_requests FOR UPDATE TO authenticated
  USING (
    client_id = auth_client_id()
    AND auth_role() IN ('manager', 'admin')
    AND debtor_id IN (SELECT auth_my_debtor_ids())
  )
  WITH CHECK (client_id = auth_client_id());

GRANT SELECT, INSERT, UPDATE ON TABLE insight_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE insight_requests TO service_role;

-- ── Notify the manager(s) when a request is opened ───────────────────────────
-- Recipients: the manager of every team the requester is on, plus the debtor's portfolio
-- manager (covers accounts on a portfolio owned outside the agent's team). Falls back to every
-- admin in the company if neither exists, so a request never goes nowhere.
CREATE OR REPLACE FUNCTION insight_requests_notify_open() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    who TEXT;
    debtor_name TEXT;
    recipients UUID[];
  BEGIN
    SELECT name INTO who FROM agents WHERE id = NEW.requested_by;
    SELECT name INTO debtor_name FROM debtors WHERE id = NEW.debtor_id;

    SELECT array_agg(DISTINCT m) INTO recipients FROM (
      SELECT t.manager_id AS m FROM team_agents ta JOIN teams t ON t.id = ta.team_id
        WHERE ta.agent_id = NEW.requested_by AND t.manager_id IS NOT NULL
      UNION
      SELECT p.manager_id FROM debtors d JOIN portfolios p ON p.id = d.portfolio_id
        WHERE d.id = NEW.debtor_id AND p.manager_id IS NOT NULL
    ) s WHERE m IS DISTINCT FROM NEW.requested_by;

    IF recipients IS NULL OR array_length(recipients, 1) IS NULL THEN
      SELECT array_agg(id) INTO recipients FROM agents
        WHERE client_id = NEW.client_id AND role = 'admin' AND id IS DISTINCT FROM NEW.requested_by;
    END IF;

    IF recipients IS NOT NULL THEN
      INSERT INTO notifications (client_id, to_agent_id, from_name, message)
      SELECT NEW.client_id, r, 'Insights Request',
             coalesce(who, 'An agent') || ' asked for Insights on ' || coalesce(debtor_name, 'a debtor')
               || coalesce(' — "' || nullif(trim(NEW.note), '') || '"', '')
               || '. Open the debtor''s Insights tab to run a lookup.'
      FROM unnest(recipients) AS r;
    END IF;
    RETURN NEW;
  END; $$;

DROP TRIGGER IF EXISTS insight_requests_notify_open ON insight_requests;
CREATE TRIGGER insight_requests_notify_open
  AFTER INSERT ON insight_requests
  FOR EACH ROW EXECUTE FUNCTION insight_requests_notify_open();

-- ── Close open requests when a lookup completes ─────────────────────────────
-- A fresh lookup writes a debtor_traces row, which closes the request here. A lookup served from
-- an earlier result writes no row, so the Insights panel also marks the request done itself after
-- any successful run — both paths end in the same UPDATE, and the trigger below notifies once.
CREATE OR REPLACE FUNCTION insight_requests_close_on_trace() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    IF NEW.state = 'done' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'done') THEN
      UPDATE insight_requests
         SET status = 'done', resolved_at = NOW(), resolved_by = NEW.requested_by
       WHERE debtor_id = NEW.debtor_id AND status = 'open';
    END IF;
    RETURN NEW;
  END; $$;

DROP TRIGGER IF EXISTS insight_requests_close_on_trace ON debtor_traces;
CREATE TRIGGER insight_requests_close_on_trace
  AFTER INSERT OR UPDATE OF state ON debtor_traces
  FOR EACH ROW EXECUTE FUNCTION insight_requests_close_on_trace();

-- ── Tell the agent when their request is fulfilled ───────────────────────────
-- Only on open -> done. A dismissal is a manager deciding not to spend; it stays silent.
CREATE OR REPLACE FUNCTION insight_requests_notify_done() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE debtor_name TEXT;
  BEGIN
    IF OLD.status = 'open' AND NEW.status = 'done' AND NEW.requested_by IS NOT NULL THEN
      SELECT name INTO debtor_name FROM debtors WHERE id = NEW.debtor_id;
      INSERT INTO notifications (client_id, to_agent_id, from_name, message)
      VALUES (NEW.client_id, NEW.requested_by, 'Insights Ready',
              'Your manager ran Insights on ' || coalesce(debtor_name, 'a debtor')
                || '. See the Insights tab on their profile.');
    END IF;
    RETURN NEW;
  END; $$;

DROP TRIGGER IF EXISTS insight_requests_notify_done ON insight_requests;
CREATE TRIGGER insight_requests_notify_done
  AFTER UPDATE OF status ON insight_requests
  FOR EACH ROW EXECUTE FUNCTION insight_requests_notify_done();

-- ── Per-debtor flags for the debtor list's colouring ─────────────────────────
-- One jsonb row rather than a set: PostgREST caps set-returning results at 1000 rows, and a
-- truncated list would silently leave debtors uncoloured. SECURITY INVOKER, so the caller's own
-- RLS on debtor_traces / insight_requests decides what is counted.
CREATE OR REPLACE FUNCTION insight_debtor_flags() RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    RETURN jsonb_build_object(
      'traced', coalesce((SELECT jsonb_agg(DISTINCT debtor_id) FROM debtor_traces WHERE state = 'done'), '[]'::jsonb),
      'requested', coalesce((SELECT jsonb_agg(debtor_id) FROM insight_requests WHERE status = 'open'), '[]'::jsonb)
    );
  END; $$;

REVOKE ALL ON FUNCTION insight_debtor_flags() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insight_debtor_flags() TO authenticated;

-- Supabase's default privileges hand authenticated every table privilege and anon EXECUTE on
-- every new function. TRUNCATE in particular ignores RLS, so strip back to what is used.
REVOKE TRUNCATE, DELETE, TRIGGER, REFERENCES ON TABLE insight_requests FROM authenticated;
REVOKE EXECUTE ON FUNCTION insight_debtor_flags() FROM anon;
REVOKE EXECUTE ON FUNCTION insight_requests_notify_open() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION insight_requests_close_on_trace() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION insight_requests_notify_done() FROM PUBLIC, anon, authenticated;
