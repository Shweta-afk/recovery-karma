-- Invoices from Axiotta Communications Private Limited (user, 2026-11-20).
--
-- 1. One number series PER PREFIX. Counters were keyed by financial year only, so a new prefix
--    ("SX", the new GST-registered company) would have continued the old proprietorship's series
--    (SAT/2627/0035 → SX/2627/0036). A new GSTIN starts at 0001. Counter keys become
--    "<prefix>:<fy>"; existing rows are re-keyed to the prefix of their latest number.
--    Credit notes follow the same rule (they already take the prefix of the invoice they correct).
-- 2. Letterhead fields on the supplier profile. They are snapshotted into each invoice's
--    `supplier` with the rest, so an invoice issued before the change never prints on the new
--    letterhead.

UPDATE invoice_counters c
   SET fy = sub.prefix || ':' || c.fy
  FROM (
    SELECT DISTINCT ON (fy) fy, split_part(invoice_number, '/', 1) AS prefix
      FROM invoices ORDER BY fy, created_at DESC
  ) sub
 WHERE sub.fy = c.fy AND position(':' IN c.fy) = 0;

UPDATE credit_note_counters c
   SET fy = sub.prefix || ':' || c.fy
  FROM (
    SELECT DISTINCT ON (fy) fy, regexp_replace(split_part(credit_note_number, '/', 1), 'C$', '') AS prefix
      FROM credit_notes ORDER BY fy, created_at DESC
  ) sub
 WHERE sub.fy = c.fy AND position(':' IN c.fy) = 0;

CREATE OR REPLACE FUNCTION public.issue_invoice(p_client_id uuid, p_prefix text, p_fy text, p_kind text, p_issue_date date, p_due_date date, p_description text, p_lines jsonb, p_sac text, p_place_of_supply text, p_taxable numeric, p_cgst numeric, p_sgst numeric, p_igst numeric, p_total numeric, p_supplier jsonb, p_recipient jsonb, p_wallet_ledger_id uuid, p_notes text, p_disclaimer text, p_superadmin_id uuid, p_period_month text DEFAULT NULL::text)
 RETURNS invoices
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  DECLARE
    seq INTEGER;
    fy_short TEXT := substr(p_fy, 3, 2) || substr(p_fy, 6, 2);
    inv invoices;
  BEGIN
    INSERT INTO invoice_counters (fy, last_seq) VALUES (p_prefix || ':' || p_fy, 1)
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
  END; $function$;

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
    INSERT INTO credit_note_counters (fy, last_seq) VALUES (p_prefix || ':' || p_fy, 1)
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

ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS registered_address TEXT;
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS legal_name_local TEXT;
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS letterhead BOOLEAN NOT NULL DEFAULT false;
