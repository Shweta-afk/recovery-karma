-- Per-company seat limits: how many managers and how many agents ("users") a company's admin
-- may invite. Superadmin-only to set, same reasoning as the Insights rate card
-- (20260909_superadmin_and_wallets.sql's saveCompanyProfilexSettings): a cap an admin could
-- edit themselves isn't a cap.
--
-- NULL means unlimited, and NULL is the default with no backfill needed — every existing
-- company (Axiotta included) gets NULL automatically the moment the column is added, so nothing
-- currently running is newly restricted. Only companies a superadmin explicitly sets a number
-- for are capped; that's expected to mean newly-created companies going forward.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS max_agents INTEGER CHECK (max_agents IS NULL OR max_agents >= 0),
  ADD COLUMN IF NOT EXISTS max_managers INTEGER CHECK (max_managers IS NULL OR max_managers >= 0);

-- Covered by the same clients_protect_admin_fields trigger
-- (20260909_company_verification_and_subdomain.sql) that already pins status/verified_at/
-- verified_by/subdomain back to their prior value for any non-service-role UPDATE — extending
-- it here rather than adding a second trigger on the same table.
CREATE OR REPLACE FUNCTION clients_protect_admin_fields() RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user <> 'service_role' THEN
      NEW.status       := OLD.status;
      NEW.verified_at  := OLD.verified_at;
      NEW.verified_by  := OLD.verified_by;
      NEW.subdomain    := OLD.subdomain;
      NEW.max_agents   := OLD.max_agents;
      NEW.max_managers := OLD.max_managers;
    END IF;
    RETURN NEW;
  END; $$;

-- No new SELECT policy needed: clients_select (20260730_harden_rls.sql) already lets an agent
-- read their own client row, so an admin's Users page can read max_agents/max_managers
-- client-side to show "3 of 5 used" without a dedicated server action.
