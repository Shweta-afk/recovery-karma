-- Delivery tracking for invoices and agreements (2026-10-12).
--
-- Invoices: when a superadmin emailed one (and to whom, and how — through Resend or by opening
-- their own mail app), and when the company first OPENED it on Admin → Billing. "Viewed" is
-- only ever set by a company admin opening the invoice in the app (company-billing.server.ts);
-- email open-tracking isn't used, it is blocked too often to mean anything.
--
-- Agreements: one row per (document, company). A company's own agreement has one row for that
-- company; the platform terms (contract_documents.client_id NULL) get a row per company as each
-- is sent / views / signs. "Signed" = an admin of that company ticked "I agree" and typed their
-- name (snapshotted, like contract_acceptances).
--
-- Both server-only, like the tables they extend. Idempotent.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS emailed_to TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS emailed_via TEXT
  CHECK (emailed_via IS NULL OR emailed_via IN ('resend', 'mail_app'));
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS viewed_by_agent UUID
  REFERENCES agents(id) ON DELETE SET NULL;

-- check:sql server-only: contract_document_status
CREATE TABLE IF NOT EXISTS contract_document_status (
  document_id     UUID NOT NULL REFERENCES contract_documents(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sent_at         TIMESTAMPTZ,
  sent_to         TEXT,
  sent_via        TEXT CHECK (sent_via IS NULL OR sent_via IN ('resend', 'mail_app')),
  viewed_at       TIMESTAMPTZ,
  signed_at       TIMESTAMPTZ,
  signed_name     TEXT CHECK (signed_name IS NULL OR char_length(signed_name) BETWEEN 1 AND 200),
  signed_email    TEXT CHECK (signed_email IS NULL OR char_length(signed_email) <= 254),
  signed_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  PRIMARY KEY (document_id, client_id)
);
CREATE INDEX IF NOT EXISTS contract_document_status_client_idx
  ON contract_document_status (client_id);

ALTER TABLE contract_document_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE contract_document_status FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contract_document_status TO service_role;
