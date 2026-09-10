-- The "actual wallet" — the real remaining balance in the ONE real ProfileX/Neokred account,
-- separate from profilex_master_wallet.
--
-- Why two wallets: profilex_master_wallet (20260909_superadmin_and_wallets.sql) is an
-- allocation pool a superadmin can put any number into, then hand slices of to companies — it
-- exists to control each company's BUDGET, and nothing stops a superadmin typing in a number
-- that doesn't match what's really sitting with ProfileX. profilex_actual_wallet tracks the
-- other, true number: what's really left with ProfileX/Neokred right now. It goes up only when
-- a superadmin manually records a real top-up (ProfileX has no balance API — see
-- profilex-actions.server.ts's "no balance or usage endpoint" note), and it goes DOWN
-- automatically, in real time, by the REAL price ProfileX charges on every billable lookup from
-- every company — not by whatever that company's rate_card says they're charged. That
-- distinction is the whole point: a company's rate_card (profilex_settings.rate_card) can be
-- marked up/down from ProfileX's own published price (catalogue.ts's defaultPrices), so the
-- amount a company's wallet loses and the amount actually leaving the ProfileX account can
-- legitimately differ. This wallet is the second, ground-truth number to compare against.
--
-- No BEGIN/COMMIT/ROLLBACK — see the same note in 20260909_superadmin_and_wallets.sql.

CREATE TABLE IF NOT EXISTS profilex_actual_wallet (
  id                     TEXT PRIMARY KEY DEFAULT 'main',
  balance                NUMERIC(12,2) NOT NULL DEFAULT 0,
  low_balance_threshold  NUMERIC(12,2) NOT NULL DEFAULT 500,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             UUID REFERENCES superadmins(id)
);

ALTER TABLE profilex_actual_wallet ENABLE ROW LEVEL SECURITY;
-- No policies, same reasoning as profilex_master_wallet: superadmin-only, service-role only.

INSERT INTO profilex_actual_wallet (id, balance)
  VALUES ('main', 0)
  ON CONFLICT (id) DO NOTHING;

-- Widen the ledger's scope vocabulary to cover the two new kinds of movement this wallet makes.
ALTER TABLE profilex_wallet_ledger DROP CONSTRAINT IF EXISTS profilex_wallet_ledger_scope_check;
ALTER TABLE profilex_wallet_ledger ADD CONSTRAINT profilex_wallet_ledger_scope_check
  CHECK (scope IN (
    'master_topup', 'master_to_company', 'company_to_manager', 'manager_charge',
    'actual_topup', 'actual_charge'
  ));

-- Manual top-up, recording real money the superadmin actually paid ProfileX/Neokred. Same shape
-- as profilex_master_topup.
CREATE OR REPLACE FUNCTION profilex_actual_topup(
  p_amount NUMERIC, p_superadmin_id UUID, p_note TEXT DEFAULT NULL
) RETURNS NUMERIC
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE new_balance NUMERIC;
  BEGIN
    IF p_amount <= 0 THEN
      RAISE EXCEPTION 'Top-up amount must be positive';
    END IF;

    UPDATE profilex_actual_wallet
      SET balance = balance + p_amount, updated_at = NOW(), updated_by = p_superadmin_id
      WHERE id = 'main'
      RETURNING balance INTO new_balance;

    INSERT INTO profilex_wallet_ledger (scope, amount, note, created_by)
      VALUES ('actual_topup', p_amount, p_note, p_superadmin_id);

    RETURN new_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_actual_topup(NUMERIC, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_actual_topup(NUMERIC, UUID, TEXT) TO service_role;

-- Automatic deduction, called from runProfilexTrace (profilex-actions.server.ts) right alongside
-- the existing manager wallet charge, for every billable lookup from any company. Deliberately
-- allowed to go negative (and deliberately not a spend gate — nothing blocks the real ProfileX
-- call on this balance): the whole reason this wallet exists is to surface the true remaining
-- balance, including when it's run out, not to enforce a cap on it. p_amount = 0 is a no-op
-- (e.g. a genuinely free "not found" status), same guard profilex_wallet_charge uses.
CREATE OR REPLACE FUNCTION profilex_actual_wallet_charge(p_amount NUMERIC, p_client_id UUID)
  RETURNS NUMERIC
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE new_balance NUMERIC;
  BEGIN
    IF p_amount <= 0 THEN
      RETURN (SELECT balance FROM profilex_actual_wallet WHERE id = 'main');
    END IF;

    UPDATE profilex_actual_wallet
      SET balance = balance - p_amount, updated_at = NOW()
      WHERE id = 'main'
      RETURNING balance INTO new_balance;

    INSERT INTO profilex_wallet_ledger (scope, client_id, amount, note, created_by)
      VALUES ('actual_charge', p_client_id, p_amount, 'Real ProfileX cost for one lookup', NULL);

    RETURN new_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_actual_wallet_charge(NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_actual_wallet_charge(NUMERIC, UUID) TO service_role;
