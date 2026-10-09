-- Contracts: documents, published changes, and admins' acceptances (2026-10-09).
--
-- Two kinds of document (contract_documents):
--   * client_id NULL  — SamvadX's common platform terms, the same for every company, versioned.
--   * client_id set   — one company's own signed agreement (e.g. its MSA PDF), versioned.
-- The PDF itself lives in the private Storage bucket `contracts` (created by the server on first
-- upload, like `dead-accounts`); `file_path` is the object path inside it.
--
-- A change (contract_changes) is a note a superadmin writes and publishes when a feature is added
-- or changed — e.g. "Employment lookups added at ₹5 per lookup". It applies to every company
-- (client_ids NULL) or to the listed ones. Publishing notifies each target company's admins in
-- the app; when requires_acceptance is set, an admin must accept it on Admin → Contracts, and that
-- acceptance is recorded once per company (contract_acceptances) with who accepted and when.
--
-- Access: server-only, like invoices. Superadmins read/write everything through the service role
-- (src/lib/contracts.server.ts after verifySuperadminCaller); company admins read their own
-- company's rows and accept through the same file after verifyCaller (role 'admin', which already
-- implies the emailed sign-in code). No authenticated grant and no policy.
--
-- check:sql server-only: contract_documents, contract_changes, contract_acceptances

CREATE TABLE IF NOT EXISTS contract_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID REFERENCES clients(id),
  title          TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  version_label  TEXT CHECK (char_length(version_label) <= 40),
  effective_date DATE NOT NULL,
  file_path      TEXT NOT NULL UNIQUE CHECK (char_length(file_path) <= 300),
  file_name      TEXT NOT NULL CHECK (char_length(file_name) <= 200),
  file_size      BIGINT,
  notes          TEXT CHECK (char_length(notes) <= 2000),
  created_by     UUID REFERENCES superadmins(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS contract_documents_client_idx
  ON contract_documents (client_id, effective_date DESC, created_at DESC);
ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_documents TO service_role;

CREATE TABLE IF NOT EXISTS contract_changes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body                TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  effective_date      DATE NOT NULL,
  -- NULL = every company; otherwise the companies it applies to.
  client_ids          UUID[] CHECK (client_ids IS NULL OR cardinality(client_ids) > 0),
  requires_acceptance BOOLEAN NOT NULL DEFAULT TRUE,
  document_id         UUID REFERENCES contract_documents(id),
  created_by          UUID REFERENCES superadmins(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when a superadmin withdraws a change published by mistake. Kept, not deleted: it was
  -- shown to companies, so the record that it existed stays.
  withdrawn_at        TIMESTAMPTZ,
  withdrawn_by        UUID REFERENCES superadmins(id)
);
CREATE INDEX IF NOT EXISTS contract_changes_created_idx ON contract_changes (created_at DESC);
ALTER TABLE contract_changes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_changes TO service_role;

CREATE TABLE IF NOT EXISTS contract_acceptances (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id      UUID NOT NULL REFERENCES contract_changes(id),
  client_id      UUID NOT NULL REFERENCES clients(id),
  agent_id       UUID REFERENCES agents(id),
  -- Snapshotted: the record of who agreed must not change if the user is later renamed/removed.
  accepted_name  TEXT NOT NULL CHECK (char_length(accepted_name) BETWEEN 1 AND 200),
  accepted_email TEXT NOT NULL CHECK (char_length(accepted_email) <= 254),
  accepted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One acceptance per company per change: any one of the company's admins accepts for it.
  UNIQUE (change_id, client_id)
);
CREATE INDEX IF NOT EXISTS contract_acceptances_client_idx ON contract_acceptances (client_id);
ALTER TABLE contract_acceptances ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_acceptances TO service_role;

-- Supabase's default privileges auto-grant new public tables to anon/authenticated (until its
-- 2026-10-30 change). RLS with no policy already returns nothing; revoke too so company users
-- hold no privilege at all — same as the invoice tables.
REVOKE ALL ON public.contract_documents, public.contract_changes, public.contract_acceptances
  FROM anon, authenticated;
