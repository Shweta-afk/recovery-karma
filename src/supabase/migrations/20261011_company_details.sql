-- Company details for invoices and agreements, filled in by each company's ADMIN on Admin →
-- Settings (src/lib/company-details.server.ts). Until every required detail is saved, every admin
-- page shows a red banner that can't be dismissed (admin.tsx).
--
-- Extends client_billing — the recipient details invoices and contract templates already read —
-- rather than a new table, so invoices and agreements pick up what the company typed with no
-- second copy to keep in sync. Superadmins can still edit the same row (company Billing tab).
-- client_billing stays server-only (RLS on, no policies). Idempotent.
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS pan TEXT;
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS cin TEXT;
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS pin_code TEXT;
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS signatory_name TEXT;
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS signatory_designation TEXT;
-- A company not registered for GST says so explicitly instead of leaving GSTIN blank.
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS gst_unregistered BOOLEAN NOT NULL DEFAULT FALSE;
-- Which company admin last saved it (updated_by is the superadmin column).
ALTER TABLE client_billing ADD COLUMN IF NOT EXISTS updated_by_agent UUID
  REFERENCES agents(id) ON DELETE SET NULL;
