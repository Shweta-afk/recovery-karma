-- Per-manager prepaid wallet for ProfileX Insights spend, replacing the single org-wide
-- profilex_settings.monthly_budget as the thing that actually blocks a lookup (see
-- profilex-actions.server.ts's runProfilexTrace — the old "Budget" check there is now a
-- per-manager wallet check instead). monthly_budget itself is left in place, unused, rather
-- than dropped — cheap to leave, and nothing else references it.
--
-- Deliberately a balance that only ever moves by an admin top-up or a charge, never an
-- auto-reset: "wallet", not "monthly cap". Only managers have one — an admin's own lookups
-- (Manager/admin-triggered per CLAUDE.md) are not wallet-gated, since admins are the ones who
-- fund every manager's wallet in the first place.
CREATE TABLE IF NOT EXISTS profilex_wallets (
  manager_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  client_id  UUID NOT NULL REFERENCES clients(id),
  balance    NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS profilex_wallets_client_idx ON profilex_wallets (client_id);

ALTER TABLE profilex_wallets ENABLE ROW LEVEL SECURITY;

-- A manager reads only their own wallet (what the Trace tab shows them); an admin reads every
-- wallet in their own client (the Insights Settings wallet table).
DROP POLICY IF EXISTS profilex_wallets_select ON profilex_wallets;
CREATE POLICY profilex_wallets_select ON profilex_wallets FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (manager_id = auth_agent_id() OR auth_role() = 'admin')
  );

-- No insert/update/delete policy — same reasoning as profilex_settings: a balance a manager
-- could edit isn't a spend control. Every write (admin top-up, or a charge fired from inside
-- runProfilexTrace) goes through the service-role server action.

-- Atomic decrement so two concurrent lookups by the same manager's team can't both read a
-- pre-charge balance and double-spend it. Returns the new balance; NULL if the manager has no
-- wallet row yet (treated as "no funds" by the caller — see profilex-actions.server.ts).
CREATE OR REPLACE FUNCTION profilex_wallet_charge(p_manager_id UUID, p_amount NUMERIC)
  RETURNS NUMERIC
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE new_balance NUMERIC;
  BEGIN
    UPDATE profilex_wallets
      SET balance = balance - p_amount, updated_at = NOW()
      WHERE manager_id = p_manager_id
      RETURNING balance INTO new_balance;
    RETURN new_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_wallet_charge(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_wallet_charge(UUID, NUMERIC) TO service_role;
