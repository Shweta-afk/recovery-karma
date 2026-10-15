-- Who first opened each agreement/terms document, per company — so Superadmin → Contracts can
-- say "Viewed 16 Oct by <admin>" (invoices already record this in invoices.viewed_by_agent).
-- Set once, by the server (contracts.server.ts markDocumentViewed), alongside viewed_at.
-- contract_document_status stays server-only; no policy or grant changes.
ALTER TABLE contract_document_status
  ADD COLUMN IF NOT EXISTS viewed_by_agent UUID REFERENCES agents(id) ON DELETE SET NULL;
