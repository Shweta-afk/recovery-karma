-- Admin-run Insights lookups come off the COMPANY Insights wallet (user, 2026-10-28).
--
-- Until now only managers were wallet-gated (profilex_wallet_hold/settle on profilex_wallets).
-- An admin's lookup — from a borrower's Insights tab, Admin → Insights (typed-in), or a CIBIL
-- pull — was recorded in debtor_traces / insights_manual_lookups with its price, but no wallet
-- moved, so the company's balance never went down. These two functions mirror the manager pair
-- for profilex_company_wallets: hold the worst-case price before the provider is called (one
-- conditional UPDATE, so the balance can't go below zero and two lookups can't spend the same
-- money), then settle with what was really billed and write an 'admin_charge' ledger row.
--
-- The one-off charge for admin lookups made before this went live is NOT in this file (it is
-- data, applied once by hand on 2026-10-28; see CLAUDE.md) — replaying migrations must never
-- charge a company twice.

ALTER TABLE public.profilex_wallet_ledger DROP CONSTRAINT IF EXISTS profilex_wallet_ledger_scope_check;
ALTER TABLE public.profilex_wallet_ledger ADD CONSTRAINT profilex_wallet_ledger_scope_check
  CHECK (scope = ANY (ARRAY[
    'master_topup', 'master_to_company', 'company_to_manager', 'manager_charge',
    'actual_topup', 'actual_charge', 'admin_charge'
  ]));

CREATE OR REPLACE FUNCTION public.profilex_company_hold(p_client_id uuid, p_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN true;
  END IF;
  UPDATE profilex_company_wallets
     SET balance = balance - p_amount, updated_at = NOW()
   WHERE client_id = p_client_id AND balance >= p_amount;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.profilex_company_settle(
  p_client_id uuid, p_hold numeric, p_cost numeric, p_admin_id uuid, p_note text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF p_cost > p_hold THEN
    RAISE EXCEPTION 'cost % exceeds hold %', p_cost, p_hold;
  END IF;
  UPDATE profilex_company_wallets
     SET balance = balance + p_hold - p_cost, updated_at = NOW()
   WHERE client_id = p_client_id
  RETURNING balance INTO v_balance;
  IF p_cost > 0 THEN
    INSERT INTO profilex_wallet_ledger (scope, client_id, amount, note, created_by)
    VALUES ('admin_charge', p_client_id, p_cost, p_note, p_admin_id);
  END IF;
  RETURN v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.profilex_company_hold(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profilex_company_settle(uuid, numeric, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profilex_company_hold(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.profilex_company_settle(uuid, numeric, numeric, uuid, text) TO service_role;
