-- Company verification gate + subdomain slot.
--
-- Until now createCompany (setup-actions.server.ts) gave a brand-new admin full access the
-- instant they finished signup — no superadmin review at all. This adds a `status` gate: a
-- newly created company starts 'pending' and its admin (and anyone else at that company) is
-- shown a "waiting for verification" screen instead of the app until a superadmin approves it.
--
-- ⚠️ Every EXISTING company must be backfilled to 'approved' explicitly — ADD COLUMN ... DEFAULT
-- 'pending' applies that default to existing rows too, and without the backfill below this
-- migration would instantly lock every current admin/manager/agent out of production.
--
-- subdomain is a separate, independent addition: a slot for the per-company subdomain the
-- platform is moving to (e.g. raerae.samvadx.com). Only the DNS/Railway domain wiring is out of
-- scope here (infra, not app code) — this just gives the superadmin somewhere to record the
-- slug so the rest of the app has it once that wiring exists.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- Backfill: every company that existed before this migration is already in active use — do not
-- newly gate it. Only clients created AFTER this point default to 'pending'.
UPDATE clients SET status = 'approved' WHERE status = 'pending';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES superadmins(id),
  ADD COLUMN IF NOT EXISTS subdomain TEXT UNIQUE
    CHECK (subdomain IS NULL OR subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');

CREATE INDEX IF NOT EXISTS clients_status_idx ON clients (status);

-- ⚠️ Load-bearing: 20260804_clients_update_and_teams_rls.sql already gives an admin a `clients_update`
-- policy scoped to THEIR OWN row (for editing company_name in Admin -> Settings), with no
-- column-level restriction. Without this trigger, that same policy would let an admin simply
-- UPDATE their own status to 'approved' from the browser client — defeating the entire gate.
-- Postgres RLS has no native column-level WITH CHECK, so this is enforced with a trigger
-- instead: any UPDATE not coming from the service-role connection (supabase-admin.server.ts,
-- which is the only place approveCompany/rejectCompany/setCompanySubdomain run) has these four
-- columns silently pinned back to their previous value, no matter what the caller sent.
CREATE OR REPLACE FUNCTION clients_protect_admin_fields() RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'service_role' THEN
      NEW.status      := OLD.status;
      NEW.verified_at := OLD.verified_at;
      NEW.verified_by := OLD.verified_by;
      NEW.subdomain   := OLD.subdomain;
    END IF;
    RETURN NEW;
  END; $$;

DROP TRIGGER IF EXISTS clients_protect_admin_fields_trg ON clients;
CREATE TRIGGER clients_protect_admin_fields_trg
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION clients_protect_admin_fields();

-- No new SELECT policy needed: clients_select (20260730_harden_rls.sql) already lets an agent
-- read their own client row, status/verified_at/subdomain included — exactly what the
-- "pending verification" gate screen needs to read client-side.
