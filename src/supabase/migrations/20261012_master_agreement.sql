-- One master agreement for every company (2026-10-12).
--
-- The agreement is published ONCE as a platform document (contract_documents, client_id NULL)
-- whose text carries {{placeholders}}. Each company sees it filled with BOTH parties' current
-- details — SamvadX's own from billing_profile, theirs from client_billing — and signs it. The
-- exact text they signed is frozen in contract_document_status.signed_body, so a later rename of
-- either company never changes what was agreed.
--
-- Also: SamvadX's own CIN and authorised signatory (billing_profile), needed in the agreement,
-- and contract_change_views — when each company first saw a change notice, so the superadmin can
-- tell "not opened" from "seen but not accepted". All server-only. Idempotent.
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS cin TEXT;
-- The short name the agreement uses for SamvadX's company throughout ("Axiotta").
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS short_name TEXT;
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS signatory_name TEXT;
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS signatory_designation TEXT;

ALTER TABLE contract_document_status ADD COLUMN IF NOT EXISTS signed_body TEXT;

-- check:sql server-only: contract_change_views
CREATE TABLE IF NOT EXISTS contract_change_views (
  change_id  UUID NOT NULL REFERENCES contract_changes(id) ON DELETE CASCADE,
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (change_id, client_id)
);
ALTER TABLE contract_change_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE contract_change_views FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contract_change_views TO service_role;
