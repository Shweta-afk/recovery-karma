-- Corrections to past Insights charges, and refund entries in the wallet ledger (2026-10-29).
--
-- Until 2026-10-29 many ProfileX "not found" replies (status "OK" + "No record(s) found", 201
-- "Record Not Found", an empty body) were read as an unknown status and charged at the FOUND
-- price. The code fix is readProviderStatus (src/lib/profilex/billing.ts). This file only adds
-- the places a correction is recorded:
--
--   insights_charge_corrections — one row per corrected lookup: what it was charged, what it
--     should have been, how much went back and to which wallet. Server-only; the company's
--     "Charges report" reads it through the service role, scoped by client.
--   ledger scopes manager_refund / company_refund / actual_refund — money given back to a
--     manager's wallet, the company wallet, and SamvadX's ProfileX actual-balance tracker.
--
-- The refunds themselves are DATA, applied once by scripts/debug/20261029-correct-misread-
-- not-found.sql — never from a migration, so a replay can't refund twice.

ALTER TABLE public.profilex_wallet_ledger DROP CONSTRAINT IF EXISTS profilex_wallet_ledger_scope_check;
ALTER TABLE public.profilex_wallet_ledger ADD CONSTRAINT profilex_wallet_ledger_scope_check
  CHECK (scope = ANY (ARRAY[
    'master_topup', 'master_to_company', 'company_to_manager', 'manager_charge',
    'actual_topup', 'actual_charge', 'admin_charge',
    'manager_refund', 'company_refund', 'actual_refund'
  ]));

-- check:sql server-only: insights_charge_corrections
CREATE TABLE IF NOT EXISTS public.insights_charge_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES public.clients(id),
  -- 'borrower' = debtor_traces.id, 'typed' = insights_manual_lookups.id
  source           text NOT NULL CHECK (source IN ('borrower', 'typed')),
  lookup_id        uuid NOT NULL,
  service_id       text NOT NULL,
  lookup_at        timestamptz NOT NULL,
  old_status       text,
  new_status       text,
  old_cost         numeric(10, 2) NOT NULL,
  new_cost         numeric(10, 2) NOT NULL,
  refunded         numeric(10, 2) NOT NULL DEFAULT 0,
  -- manager_wallet | company_wallet | not_deducted (the old charge never left a wallet)
  refunded_to      text NOT NULL CHECK (refunded_to IN ('manager_wallet', 'company_wallet', 'not_deducted')),
  manager_id       uuid,
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, lookup_id)
);
CREATE INDEX IF NOT EXISTS insights_charge_corrections_client
  ON public.insights_charge_corrections (client_id, lookup_at);

ALTER TABLE public.insights_charge_corrections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.insights_charge_corrections TO service_role;
