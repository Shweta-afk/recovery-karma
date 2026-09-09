-- Superadmin tier + the two missing rungs of the ProfileX Insights prepaid ledger.
--
-- Until now `profilex_wallets` (20260907_profilex_manager_wallets.sql) was the only wallet: a
-- company admin could set any manager's balance to any number, unconstrained by anything. As
-- SamvadX goes multi-company, all companies still bill through the ONE real ProfileX/Neokred
-- account, so this adds the two levels above it:
--
--   profilex_master_wallet (one row, the real account) --allocate--> profilex_company_wallets
--     (one row per client, a company's budget) --allocate--> profilex_wallets (existing,
--     per-manager) --spend--> profilex_wallet_charge (existing, unchanged behavior)
--
-- profilex_wallet_ledger records every step of that chain for the superadmin's activity feed.
--
-- `superadmins` is intentionally a separate table from `agents`, not a new agents.role value:
-- a superadmin isn't scoped to any client_id, and every existing RLS policy in this schema
-- assumes client_id = auth_client_id() resolves to something. Keeping it separate means ZERO
-- existing policy on agents/portfolios/debtors/etc. needs to change.
--
-- RLS strategy: `superadmins` and `profilex_master_wallet` get ENABLE ROW LEVEL SECURITY and
-- NO policies at all — nobody using the anon/authenticated Supabase client can read them under
-- any circumstance, by construction. All superadmin access goes through
-- src/lib/superadmin-actions.server.ts using the service-role client, which bypasses RLS
-- entirely. This is deliberate: it keeps superadmin's cross-company reach completely outside
-- the policy graph that has caused recursion outages twice before (see
-- 20260821_rls_no_direct_table_reads.sql) — there is nothing here for a future policy change
-- to recurse into.
--
-- No BEGIN/COMMIT/ROLLBACK: the runner supplies its own transaction, and a nested one has
-- previously aborted a migration or silently rolled back its DDL.

-- ── 1. Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS superadmins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE superadmins ENABLE ROW LEVEL SECURITY;
-- No policies — see header. Service-role only.

CREATE TABLE IF NOT EXISTS profilex_master_wallet (
  id          TEXT PRIMARY KEY DEFAULT 'main',
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES superadmins(id)
);

ALTER TABLE profilex_master_wallet ENABLE ROW LEVEL SECURITY;
-- No policies — see header. Service-role only.

-- Exactly one row, so the allocate function always has something to UPDATE ... WHERE id='main'.
INSERT INTO profilex_master_wallet (id, balance)
  VALUES ('main', 0)
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS profilex_company_wallets (
  client_id   UUID PRIMARY KEY REFERENCES clients(id),
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set by a superadmin allocation (no agents row) or left NULL; not FK'd to agents for that
  -- reason — same non-FK'd "created_by" reasoning as profilex_wallet_ledger below.
  updated_by  UUID
);

CREATE INDEX IF NOT EXISTS profilex_company_wallets_client_idx
  ON profilex_company_wallets (client_id);

ALTER TABLE profilex_company_wallets ENABLE ROW LEVEL SECURITY;

-- A company admin reads their own company's wallet (what admin.settings.tsx shows above the
-- manager wallet table). Mirrors profilex_wallets_select exactly.
DROP POLICY IF EXISTS profilex_company_wallets_select ON profilex_company_wallets;
CREATE POLICY profilex_company_wallets_select ON profilex_company_wallets FOR SELECT TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');
-- No insert/update/delete policy — same reasoning as profilex_wallets: a balance an admin
-- could edit isn't a spend control. Every write goes through profilex_master_allocate below.

CREATE TABLE IF NOT EXISTS profilex_wallet_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       TEXT NOT NULL CHECK (scope IN (
                'master_topup', 'master_to_company', 'company_to_manager', 'manager_charge'
              )),
  -- NULL only for master_topup, which has no company yet.
  client_id   UUID REFERENCES clients(id),
  -- Set for company_to_manager and manager_charge only.
  manager_id  UUID REFERENCES agents(id),
  -- Always a positive magnitude; `scope` says what kind of movement it was, not the sign.
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note        TEXT,
  -- Either a superadmins.id (master_topup, master_to_company) or an agents.id
  -- (company_to_manager, manager_charge) depending on scope — not FK'd to either single table
  -- for that reason, same as clients/portfolios elsewhere don't FK a polymorphic actor.
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profilex_wallet_ledger_client_idx
  ON profilex_wallet_ledger (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS profilex_wallet_ledger_manager_idx
  ON profilex_wallet_ledger (manager_id, created_at DESC);

ALTER TABLE profilex_wallet_ledger ENABLE ROW LEVEL SECURITY;

-- Admin sees every ledger row for their own client (allocations in and out, every manager's
-- spend). A manager sees only rows about their own wallet. master_topup rows have client_id
-- NULL, so they never match this policy for anyone — superadmin-only, via service role.
DROP POLICY IF EXISTS profilex_wallet_ledger_select ON profilex_wallet_ledger;
CREATE POLICY profilex_wallet_ledger_select ON profilex_wallet_ledger FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR (auth_role() = 'manager' AND manager_id = auth_agent_id()))
  );
-- No insert/update/delete policy — every row is written by the allocate/charge functions below.

-- ── 2. Ledger-writing functions (service-role only, plpgsql — never LANGUAGE sql; see the
--      2026-08-21 postmortem in 20260821_rls_no_direct_table_reads.sql for why inlining a
--      SECURITY DEFINER function is dangerous) ──────────────────────────────────

CREATE OR REPLACE FUNCTION profilex_master_topup(
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

    UPDATE profilex_master_wallet
      SET balance = balance + p_amount, updated_at = NOW(), updated_by = p_superadmin_id
      WHERE id = 'main'
      RETURNING balance INTO new_balance;

    INSERT INTO profilex_wallet_ledger (scope, amount, note, created_by)
      VALUES ('master_topup', p_amount, p_note, p_superadmin_id);

    RETURN new_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_master_topup(NUMERIC, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_master_topup(NUMERIC, UUID, TEXT) TO service_role;

-- Atomically moves money from the master wallet into one company's wallet. Fails (no partial
-- write) if the master wallet doesn't have enough — the WHERE balance >= p_amount makes the
-- UPDATE itself the check, so no separate read-then-write race is possible.
CREATE OR REPLACE FUNCTION profilex_master_allocate(
  p_client_id UUID, p_amount NUMERIC, p_superadmin_id UUID, p_note TEXT DEFAULT NULL
) RETURNS NUMERIC
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE master_balance NUMERIC; new_company_balance NUMERIC;
  BEGIN
    IF p_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be positive';
    END IF;

    UPDATE profilex_master_wallet
      SET balance = balance - p_amount, updated_at = NOW(), updated_by = p_superadmin_id
      WHERE id = 'main' AND balance >= p_amount
      RETURNING balance INTO master_balance;

    IF master_balance IS NULL THEN
      RAISE EXCEPTION 'Master wallet has insufficient balance for this allocation';
    END IF;

    INSERT INTO profilex_company_wallets (client_id, balance, updated_at)
      VALUES (p_client_id, p_amount, NOW())
      ON CONFLICT (client_id) DO UPDATE
        SET balance = profilex_company_wallets.balance + p_amount, updated_at = NOW()
      RETURNING balance INTO new_company_balance;

    INSERT INTO profilex_wallet_ledger (scope, client_id, amount, note, created_by)
      VALUES ('master_to_company', p_client_id, p_amount, p_note, p_superadmin_id);

    RETURN new_company_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_master_allocate(UUID, NUMERIC, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_master_allocate(UUID, NUMERIC, UUID, TEXT) TO service_role;

-- Same shape one level down: company wallet -> one manager's profilex_wallets row. Replaces
-- setManagerWallet's old unconstrained upsert (profilex-actions.server.ts) — a company admin
-- can now never allocate more than their own company's wallet holds.
CREATE OR REPLACE FUNCTION profilex_company_allocate(
  p_client_id UUID, p_manager_id UUID, p_amount NUMERIC, p_admin_id UUID, p_note TEXT DEFAULT NULL
) RETURNS NUMERIC
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE company_balance NUMERIC; new_manager_balance NUMERIC;
  BEGIN
    IF p_amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amount must be positive';
    END IF;

    UPDATE profilex_company_wallets
      SET balance = balance - p_amount, updated_at = NOW(), updated_by = p_admin_id
      WHERE client_id = p_client_id AND balance >= p_amount
      RETURNING balance INTO company_balance;

    IF company_balance IS NULL THEN
      RAISE EXCEPTION 'Company wallet has insufficient balance for this allocation';
    END IF;

    INSERT INTO profilex_wallets (manager_id, client_id, balance, updated_at, updated_by)
      VALUES (p_manager_id, p_client_id, p_amount, NOW(), p_admin_id)
      ON CONFLICT (manager_id) DO UPDATE
        SET balance = profilex_wallets.balance + p_amount, updated_at = NOW(), updated_by = p_admin_id
      RETURNING balance INTO new_manager_balance;

    INSERT INTO profilex_wallet_ledger (scope, client_id, manager_id, amount, note, created_by)
      VALUES ('company_to_manager', p_client_id, p_manager_id, p_amount, p_note, p_admin_id);

    RETURN new_manager_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_company_allocate(UUID, UUID, NUMERIC, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_company_allocate(UUID, UUID, NUMERIC, UUID, TEXT) TO service_role;

-- profilex_wallet_charge (20260907_profilex_manager_wallets.sql) — same balance-decrement
-- behavior, unchanged, plus a manager_charge ledger row so spend shows up in the same audit
-- trail as top-ups/allocations. client_id comes from the wallet row itself (RETURNING), never
-- passed in, so a caller can't misattribute a charge to another company's ledger.
CREATE OR REPLACE FUNCTION profilex_wallet_charge(p_manager_id UUID, p_amount NUMERIC)
  RETURNS NUMERIC
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE new_balance NUMERIC; v_client_id UUID;
  BEGIN
    UPDATE profilex_wallets
      SET balance = balance - p_amount, updated_at = NOW()
      WHERE manager_id = p_manager_id
      RETURNING balance, client_id INTO new_balance, v_client_id;

    IF v_client_id IS NOT NULL AND p_amount > 0 THEN
      INSERT INTO profilex_wallet_ledger (scope, client_id, manager_id, amount, created_by)
        VALUES ('manager_charge', v_client_id, p_manager_id, p_amount, p_manager_id);
    END IF;

    RETURN new_balance;
  END; $$;

REVOKE ALL ON FUNCTION profilex_wallet_charge(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_wallet_charge(UUID, NUMERIC) TO service_role;
