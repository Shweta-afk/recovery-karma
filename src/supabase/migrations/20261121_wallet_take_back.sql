-- Taking Insights money back down the wallet chain (user, 2026-11-21).
--
-- Until now money only flowed DOWN: master wallet -> company wallet -> manager wallet. When a
-- manager leaves, or a company was given too much, there was no way to get it back. These two
-- functions are the reverse of profilex_master_allocate / profilex_company_allocate:
--
--   profilex_manager_reclaim  — company admin takes money from one manager's wallet back into
--                               the company wallet (ledger scope 'manager_to_company').
--   profilex_company_reclaim  — superadmin takes money from a company's wallet back into the
--                               master wallet (ledger scope 'company_to_master').
--
-- Each is one conditional UPDATE (balance >= amount), so a wallet can never go below zero and
-- money held for a lookup still running (profilex_wallet_hold / profilex_company_hold already
-- took it off the balance) can't be taken back from under it. Service-role only.

ALTER TABLE public.profilex_wallet_ledger DROP CONSTRAINT IF EXISTS profilex_wallet_ledger_scope_check;
ALTER TABLE public.profilex_wallet_ledger ADD CONSTRAINT profilex_wallet_ledger_scope_check
  CHECK (scope = ANY (ARRAY[
    'master_topup', 'master_to_company', 'company_to_manager', 'manager_charge',
    'actual_topup', 'actual_charge', 'admin_charge',
    'manager_refund', 'company_refund', 'actual_refund',
    'manager_to_company', 'company_to_master'
  ]));

CREATE OR REPLACE FUNCTION public.profilex_manager_reclaim(
  p_client_id uuid, p_manager_id uuid, p_amount numeric, p_admin_id uuid, p_note text DEFAULT NULL
) RETURNS numeric
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE v_manager_balance numeric;
  BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
      RAISE EXCEPTION 'Amount to take back must be positive';
    END IF;

    UPDATE profilex_wallets
      SET balance = balance - p_amount, updated_at = NOW(), updated_by = p_admin_id
      WHERE manager_id = p_manager_id AND client_id = p_client_id AND balance >= p_amount
      RETURNING balance INTO v_manager_balance;

    IF v_manager_balance IS NULL THEN
      RAISE EXCEPTION 'Manager wallet has insufficient balance to take back that amount';
    END IF;

    INSERT INTO profilex_company_wallets (client_id, balance, updated_at, updated_by)
      VALUES (p_client_id, p_amount, NOW(), p_admin_id)
      ON CONFLICT (client_id) DO UPDATE
        SET balance = profilex_company_wallets.balance + p_amount, updated_at = NOW(),
            updated_by = p_admin_id;

    INSERT INTO profilex_wallet_ledger (scope, client_id, manager_id, amount, note, created_by)
      VALUES ('manager_to_company', p_client_id, p_manager_id, p_amount, p_note, p_admin_id);

    RETURN v_manager_balance;
  END; $$;

REVOKE ALL ON FUNCTION public.profilex_manager_reclaim(uuid, uuid, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profilex_manager_reclaim(uuid, uuid, numeric, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.profilex_company_reclaim(
  p_client_id uuid, p_amount numeric, p_superadmin_id uuid, p_note text DEFAULT NULL
) RETURNS numeric
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE v_company_balance numeric;
  BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
      RAISE EXCEPTION 'Amount to take back must be positive';
    END IF;

    UPDATE profilex_company_wallets
      SET balance = balance - p_amount, updated_at = NOW(), updated_by = p_superadmin_id
      WHERE client_id = p_client_id AND balance >= p_amount
      RETURNING balance INTO v_company_balance;

    IF v_company_balance IS NULL THEN
      RAISE EXCEPTION 'Company wallet has insufficient balance to take back that amount';
    END IF;

    UPDATE profilex_master_wallet
      SET balance = balance + p_amount, updated_at = NOW(), updated_by = p_superadmin_id
      WHERE id = 'main';

    INSERT INTO profilex_wallet_ledger (scope, client_id, amount, note, created_by)
      VALUES ('company_to_master', p_client_id, p_amount, p_note, p_superadmin_id);

    RETURN v_company_balance;
  END; $$;

REVOKE ALL ON FUNCTION public.profilex_company_reclaim(uuid, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.profilex_company_reclaim(uuid, numeric, uuid, text) TO service_role;
