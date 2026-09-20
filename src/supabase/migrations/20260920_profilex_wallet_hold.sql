-- Make a manager's ProfileX wallet spend atomic (2026-09-19 security review).
--
-- runProfilexTrace used to READ the balance, call the paid provider, then charge afterwards
-- (best-effort). Two lookups started together both passed the read, both spent real money, and the
-- balance went negative — or the charge failed and the money was spent with nothing deducted.
--
-- Now: HOLD the worst-case price up front in one conditional UPDATE (it cannot go below zero, and
-- two concurrent holds cannot both succeed on the same funds), then SETTLE once the real cost is
-- known — return the unused part of the hold and write the ledger row for what was actually spent.
-- A call that never reached the provider settles with cost 0 and writes no ledger row.
--
-- Service-role only, like the other wallet functions: nothing a browser can call.

CREATE OR REPLACE FUNCTION profilex_wallet_hold(p_manager_id uuid, p_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
      RETURN true;
    END IF;
    UPDATE profilex_wallets
      SET balance = balance - p_amount, updated_at = NOW()
      WHERE manager_id = p_manager_id AND balance >= p_amount;
    RETURN FOUND;
  END; $function$;

CREATE OR REPLACE FUNCTION profilex_wallet_settle(p_manager_id uuid, p_hold numeric, p_cost numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  DECLARE new_balance NUMERIC; v_client_id UUID;
  BEGIN
    IF p_cost > p_hold THEN
      RAISE EXCEPTION 'settled cost % exceeds the held amount %', p_cost, p_hold;
    END IF;

    UPDATE profilex_wallets
      SET balance = balance + p_hold - p_cost, updated_at = NOW()
      WHERE manager_id = p_manager_id
      RETURNING balance, client_id INTO new_balance, v_client_id;

    IF v_client_id IS NOT NULL AND p_cost > 0 THEN
      INSERT INTO profilex_wallet_ledger (scope, client_id, manager_id, amount, created_by)
        VALUES ('manager_charge', v_client_id, p_manager_id, p_cost, p_manager_id);
    END IF;

    RETURN new_balance;
  END; $function$;

REVOKE ALL ON FUNCTION profilex_wallet_hold(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION profilex_wallet_settle(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_wallet_hold(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION profilex_wallet_settle(uuid, numeric, numeric) TO service_role;
