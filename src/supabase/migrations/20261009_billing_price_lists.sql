-- Billing v2 (2026-10-09): per-company price lists, a monthly invoice, real payments, credit
-- notes, contract templates and draft contract changes.
--
-- Why: every setup invoice and every contract started from blank, so the same prices were typed
-- or uploaded again and again; "Mark paid" recorded the click time rather than when money
-- arrived; and an issued invoice could only be cancelled, never corrected.
--
-- * client_price_lists — set once per company: setup-fee lines, monthly lines, a per-agent-seat
--   price and optional payment terms. Invoices open prefilled from it; contract schedules are
--   generated from it. (Insights prices stay in profilex_settings.rate_card — one place each.)
-- * invoices.kind gains 'monthly', with period_month: at most one live monthly invoice per
--   company per month.
-- * invoice_payments — each payment as it arrived (date, amount, method, reference); part
--   payments allowed. invoices.status becomes 'paid' once payments cover the amount due.
-- * credit_notes — GST credit notes against an issued invoice, with their own number series
--   ("<prefix>C/2627/0001", ≤16 chars) so corrections don't reuse or skip invoice numbers.
-- * contract_templates + contract_documents.body — a company's commercial schedule generated
--   from a template and its prices instead of uploading a PDF per company.
-- * contract_changes.status 'draft' — changing a company's prices drafts a contract change for
--   review; drafts are never shown to companies.
--
-- All new tables are server-only like invoices (superadmin service role). Zero invoices existed
-- in production when this was written (checked 2026-10-09), so the constraint changes rewrite
-- nothing.
--
-- check:sql server-only: client_price_lists, invoice_payments, credit_notes, credit_note_counters, contract_templates

-- ── Price lists ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_price_lists (
  client_id          UUID PRIMARY KEY REFERENCES clients(id),
  -- [{ "description": text, "amount": numeric }] — before GST
  setup_lines        JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(setup_lines) = 'array'),
  monthly_lines      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(monthly_lines) = 'array'),
  per_seat_fee       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (per_seat_fee >= 0),
  -- NULL = the supplier default (billing_profile.payment_terms_days)
  payment_terms_days INTEGER CHECK (payment_terms_days BETWEEN 0 AND 365),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES superadmins(id)
);
ALTER TABLE client_price_lists ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_price_lists TO service_role;

-- ── Monthly invoices ─────────────────────────────────────────────────────────
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS sac_monthly TEXT;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_month TEXT;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_check
  CHECK (kind IN ('insights_topup', 'setup', 'monthly'));
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_period_month_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_period_month_check
  CHECK ((kind = 'monthly') = (period_month IS NOT NULL)
         AND (period_month IS NULL OR period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'));
CREATE UNIQUE INDEX IF NOT EXISTS invoices_monthly_once
  ON invoices (client_id, period_month) WHERE kind = 'monthly' AND status <> 'cancelled';

-- issue_invoice gains p_period_month. Dropped first: an overload with one extra defaulted
-- argument would make named-argument calls through PostgREST ambiguous.
DROP FUNCTION IF EXISTS issue_invoice(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, JSONB, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID, TEXT, TEXT, UUID);
CREATE OR REPLACE FUNCTION issue_invoice(
  p_client_id UUID, p_prefix TEXT, p_fy TEXT, p_kind TEXT, p_issue_date DATE, p_due_date DATE,
  p_description TEXT, p_lines JSONB, p_sac TEXT, p_place_of_supply TEXT, p_taxable NUMERIC, p_cgst NUMERIC,
  p_sgst NUMERIC, p_igst NUMERIC, p_total NUMERIC, p_supplier JSONB, p_recipient JSONB,
  p_wallet_ledger_id UUID, p_notes TEXT, p_disclaimer TEXT, p_superadmin_id UUID,
  p_period_month TEXT DEFAULT NULL
) RETURNS invoices
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    seq INTEGER;
    fy_short TEXT := substr(p_fy, 3, 2) || substr(p_fy, 6, 2);
    inv invoices;
  BEGIN
    INSERT INTO invoice_counters (fy, last_seq) VALUES (p_fy, 1)
      ON CONFLICT (fy) DO UPDATE SET last_seq = invoice_counters.last_seq + 1
      RETURNING last_seq INTO seq;

    INSERT INTO invoices (
      client_id, invoice_number, fy, kind, issue_date, due_date, description, lines, sac,
      place_of_supply, taxable_amount, cgst, sgst, igst, total, supplier, recipient,
      wallet_ledger_id, notes, disclaimer, created_by, period_month
    ) VALUES (
      p_client_id, p_prefix || '/' || fy_short || '/' || lpad(seq::text, 4, '0'), p_fy, p_kind,
      p_issue_date, p_due_date, p_description, p_lines, p_sac, p_place_of_supply, p_taxable, p_cgst,
      p_sgst, p_igst, p_total, p_supplier, p_recipient, p_wallet_ledger_id, p_notes,
      p_disclaimer, p_superadmin_id, p_period_month
    ) RETURNING * INTO inv;

    RETURN inv;
  END; $$;
REVOKE ALL ON FUNCTION issue_invoice(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, JSONB, TEXT, TEXT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_invoice(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, JSONB, TEXT, TEXT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID, TEXT, TEXT, UUID, TEXT) TO service_role;

-- ── Payments ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES invoices(id),
  client_id   UUID NOT NULL REFERENCES clients(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  received_on DATE NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('bank_transfer', 'upi', 'cheque', 'cash', 'other')),
  reference   TEXT CHECK (char_length(reference) <= 100),
  notes       TEXT CHECK (char_length(notes) <= 500),
  created_by  UUID REFERENCES superadmins(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_payments_received_idx ON invoice_payments (received_on);
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_payments TO service_role;

-- ── Credit notes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_note_counters (
  fy       TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);
ALTER TABLE credit_note_counters ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_note_counters TO service_role;

CREATE TABLE IF NOT EXISTS credit_notes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL REFERENCES clients(id),
  invoice_id         UUID NOT NULL REFERENCES invoices(id),
  credit_note_number TEXT NOT NULL UNIQUE CHECK (char_length(credit_note_number) <= 16),
  fy                 TEXT NOT NULL,
  issue_date         DATE NOT NULL,
  reason             TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  lines              JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  taxable_amount     NUMERIC(14,2) NOT NULL CHECK (taxable_amount > 0),
  cgst               NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst               NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst               NUMERIC(14,2) NOT NULL DEFAULT 0,
  total              NUMERIC(14,2) NOT NULL,
  supplier           JSONB NOT NULL,
  recipient          JSONB NOT NULL,
  created_by         UUID REFERENCES superadmins(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total = taxable_amount + cgst + sgst + igst)
);
CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx ON credit_notes (invoice_id);
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_notes TO service_role;

-- Number + row together, like issue_invoice, so a failed insert never burns a number.
CREATE OR REPLACE FUNCTION issue_credit_note(
  p_client_id UUID, p_invoice_id UUID, p_prefix TEXT, p_fy TEXT, p_issue_date DATE, p_reason TEXT,
  p_lines JSONB, p_taxable NUMERIC, p_cgst NUMERIC, p_sgst NUMERIC, p_igst NUMERIC, p_total NUMERIC,
  p_supplier JSONB, p_recipient JSONB, p_superadmin_id UUID
) RETURNS credit_notes
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    seq INTEGER;
    fy_short TEXT := substr(p_fy, 3, 2) || substr(p_fy, 6, 2);
    cn credit_notes;
  BEGIN
    INSERT INTO credit_note_counters (fy, last_seq) VALUES (p_fy, 1)
      ON CONFLICT (fy) DO UPDATE SET last_seq = credit_note_counters.last_seq + 1
      RETURNING last_seq INTO seq;

    INSERT INTO credit_notes (
      client_id, invoice_id, credit_note_number, fy, issue_date, reason, lines, taxable_amount,
      cgst, sgst, igst, total, supplier, recipient, created_by
    ) VALUES (
      p_client_id, p_invoice_id, p_prefix || 'C/' || fy_short || '/' || lpad(seq::text, 4, '0'),
      p_fy, p_issue_date, p_reason, p_lines, p_taxable, p_cgst, p_sgst, p_igst, p_total,
      p_supplier, p_recipient, p_superadmin_id
    ) RETURNING * INTO cn;

    RETURN cn;
  END; $$;
REVOKE ALL ON FUNCTION issue_credit_note(UUID, UUID, TEXT, TEXT, DATE, TEXT, JSONB, NUMERIC, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_credit_note(UUID, UUID, TEXT, TEXT, DATE, TEXT, JSONB, NUMERIC, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID) TO service_role;

-- ── Contract templates and generated documents ──────────────────────────────
CREATE TABLE IF NOT EXISTS contract_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  -- Plain text with {{placeholders}} (src/lib/contract-template.ts) — filled per company.
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 50000),
  created_by UUID REFERENCES superadmins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_templates TO service_role;

-- A document is now EITHER an uploaded file OR text generated from a template (frozen when
-- generated, so later price changes never rewrite a document someone already saw).
ALTER TABLE contract_documents ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE contract_documents ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE contract_documents ADD COLUMN IF NOT EXISTS body TEXT CHECK (char_length(body) <= 100000);
ALTER TABLE contract_documents ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES contract_templates(id);
ALTER TABLE contract_documents DROP CONSTRAINT IF EXISTS contract_documents_file_or_body;
ALTER TABLE contract_documents ADD CONSTRAINT contract_documents_file_or_body
  CHECK ((file_path IS NOT NULL AND file_name IS NOT NULL AND body IS NULL)
         OR (file_path IS NULL AND body IS NOT NULL));

-- ── Draft contract changes ───────────────────────────────────────────────────
ALTER TABLE contract_changes ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE contract_changes DROP CONSTRAINT IF EXISTS contract_changes_status_check;
ALTER TABLE contract_changes ADD CONSTRAINT contract_changes_status_check
  CHECK (status IN ('draft', 'published'));
ALTER TABLE contract_changes ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
UPDATE contract_changes SET published_at = created_at WHERE status = 'published' AND published_at IS NULL;

REVOKE ALL ON public.client_price_lists, public.invoice_payments, public.credit_notes,
  public.credit_note_counters, public.contract_templates FROM anon, authenticated;
