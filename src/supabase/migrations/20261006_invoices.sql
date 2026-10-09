-- GST tax invoices that a superadmin raises to a company (2026-10-06).
--
-- Two kinds, per the user: one for an Insights wallet top-up (tied to the exact
-- profilex_wallet_ledger 'master_to_company' row it bills, so the same top-up can never be
-- invoiced twice), and one for the setup fee. Amounts are EXCLUSIVE of GST (the MSA says so);
-- GST is 18%, split 9% CGST + 9% SGST when the place of supply is in Axiotta's own state, else
-- 18% IGST. Arithmetic lives in src/lib/invoice-math.ts; this file only stores the result.
--
-- Each invoice SNAPSHOTS the supplier and recipient details (name, GSTIN, address) as they
-- were when it was issued. An issued tax invoice must not change when a company later edits its
-- address, so nothing here joins back to the live details for printing.
--
-- Access:
--   * billing_profile, client_billing, invoice_counters — server-only (superadmin actions,
--     service role). Company users never read them directly.
--   * invoices — server-only too, FOR NOW: superadmin-only while invoicing is still being
--     developed (user, 2026-10-09). Company users have no grant and no policy, so they can't
--     read a single row. To open them to company admins later, add:
--       GRANT SELECT ON public.invoices TO authenticated;
--       CREATE POLICY invoices_select ON invoices FOR SELECT TO authenticated
--         USING (client_id = auth_client_id() AND auth_role() = 'admin');
--     (auth_role() = 'admin' also means "signed in with the emailed code" since
--     20261006_admin_email_otp.sql) and bring back an Admin → Invoices page.
--
-- check:sql server-only: billing_profile, client_billing, invoice_counters, invoices

-- ── Supplier (Axiotta) — exactly one row ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_profile (
  id                 TEXT PRIMARY KEY DEFAULT 'main' CHECK (id = 'main'),
  legal_name         TEXT NOT NULL DEFAULT '',
  gstin              TEXT,
  pan                TEXT,
  address            TEXT NOT NULL DEFAULT '',
  state_code         TEXT,
  email              TEXT,
  phone              TEXT,
  invoice_prefix     TEXT NOT NULL DEFAULT 'SX' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,5}$'),
  sac_insights       TEXT,
  sac_setup          TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 15 CHECK (payment_terms_days BETWEEN 0 AND 365),
  bank_name          TEXT,
  bank_account       TEXT,
  bank_ifsc          TEXT,
  terms              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES superadmins(id)
);
-- Starting values supplied by the user on 2026-10-09. GSTIN and PAN are still to be added on
-- Superadmin → Invoices; issuing is blocked until the GSTIN is there. DO NOTHING keeps any
-- edits made on that page if this file is replayed.
INSERT INTO billing_profile (id, legal_name, address, state_code, email)
VALUES (
  'main',
  'Axiotta Communication',
  E'86 Central by Crystal Group, Andheri Ghatkopar Link Rd, near Shreyas Signal,\noff Lal Bahadur Shastri Marg, Gangawadi, Ghatkopar West, Mumbai, Maharashtra 400086',
  '27',
  'operations@samvadx.com'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE billing_profile ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_profile TO service_role;

-- ── Recipient details per company ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_billing (
  client_id   UUID PRIMARY KEY REFERENCES clients(id),
  legal_name  TEXT NOT NULL DEFAULT '',
  gstin       TEXT,
  address     TEXT NOT NULL DEFAULT '',
  state_code  TEXT,
  email       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES superadmins(id)
);

ALTER TABLE client_billing ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_billing TO service_role;

-- ── Per-financial-year sequence ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_counters (
  fy        TEXT PRIMARY KEY,           -- "2026-27"
  last_seq  INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoice_counters TO service_role;

-- ── Invoices ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id),
  invoice_number    TEXT NOT NULL UNIQUE CHECK (char_length(invoice_number) <= 16),
  fy                TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('insights_topup', 'setup')),
  issue_date        DATE NOT NULL,
  due_date          DATE NOT NULL,
  description       TEXT NOT NULL,      -- one-line summary; the printed rows are `lines`
  sac               TEXT,
  -- [{ "description": text, "amount": numeric }, ...] — what is charged, line by line. A setup
  -- invoice itemises Domain Setup / API Configuration / Administrator Configuration / Cloud
  -- Storage; a top-up invoice has one line. taxable_amount is their sum (checked in the app,
  -- src/lib/invoice-math.ts, where the rounding lives).
  lines             JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  place_of_supply   TEXT NOT NULL,      -- GST state code
  taxable_amount    NUMERIC(14,2) NOT NULL CHECK (taxable_amount > 0),
  cgst              NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst              NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst              NUMERIC(14,2) NOT NULL DEFAULT 0,
  total             NUMERIC(14,2) NOT NULL,
  supplier          JSONB NOT NULL,
  recipient         JSONB NOT NULL,
  wallet_ledger_id  UUID REFERENCES profilex_wallet_ledger(id),
  status            TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'cancelled')),
  paid_at           TIMESTAMPTZ,
  notes             TEXT,
  -- The "Terms & disclaimer" text as printed, one paragraph per line, frozen at issue time
  -- (src/lib/invoice-math.ts invoiceDisclaimer — restates MSA clauses).
  disclaimer        TEXT,
  created_by        UUID REFERENCES superadmins(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total = taxable_amount + cgst + sgst + igst),
  CHECK ((kind = 'insights_topup') = (wallet_ledger_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS invoices_client_idx ON invoices (client_id, issue_date DESC);

-- One live invoice per top-up. Cancelled ones don't count, so a top-up invoiced with a wrong
-- GSTIN can be cancelled and invoiced again under a new number.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_topup_once
  ON invoices (wallet_ledger_id) WHERE wallet_ledger_id IS NOT NULL AND status <> 'cancelled';

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO service_role;
-- No authenticated grant and no policy: superadmin-only for now (see header).

-- Supabase's default privileges auto-grant new public tables to anon/authenticated (until its
-- 2026-10-30 change). RLS with no policy already returns nothing, but revoke too so company
-- users hold no privilege at all on billing data — checked live 2026-10-09.
REVOKE ALL ON public.billing_profile, public.client_billing, public.invoice_counters,
  public.invoices FROM anon, authenticated;

-- ── Issue one invoice: number + row in a single transaction ──────────────────
-- Called only by the superadmin server action (service role). Taking the next number and
-- inserting the row together means a failed insert rolls the counter back too — GST expects
-- the numbers within a financial year to run without gaps.
CREATE OR REPLACE FUNCTION issue_invoice(
  p_client_id UUID, p_prefix TEXT, p_fy TEXT, p_kind TEXT, p_issue_date DATE, p_due_date DATE,
  p_description TEXT, p_lines JSONB, p_sac TEXT, p_place_of_supply TEXT, p_taxable NUMERIC, p_cgst NUMERIC,
  p_sgst NUMERIC, p_igst NUMERIC, p_total NUMERIC, p_supplier JSONB, p_recipient JSONB,
  p_wallet_ledger_id UUID, p_notes TEXT, p_disclaimer TEXT, p_superadmin_id UUID
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
      wallet_ledger_id, notes, disclaimer, created_by
    ) VALUES (
      p_client_id, p_prefix || '/' || fy_short || '/' || lpad(seq::text, 4, '0'), p_fy, p_kind,
      p_issue_date, p_due_date, p_description, p_lines, p_sac, p_place_of_supply, p_taxable, p_cgst,
      p_sgst, p_igst, p_total, p_supplier, p_recipient, p_wallet_ledger_id, p_notes,
      p_disclaimer, p_superadmin_id
    ) RETURNING * INTO inv;

    RETURN inv;
  END; $$;

REVOKE ALL ON FUNCTION issue_invoice(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, JSONB, TEXT, TEXT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_invoice(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT, JSONB, TEXT, TEXT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB, UUID, TEXT, TEXT, UUID) TO service_role;
