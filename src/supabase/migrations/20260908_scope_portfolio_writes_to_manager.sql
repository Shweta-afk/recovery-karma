-- portfolios_write (FOR ALL: insert/update/delete) only checked
--   (client_id = auth_client_id()) AND (auth_role() IN ('admin','manager'))
-- with no ownership check for UPDATE/DELETE -- so any manager in the client could close,
-- edit, or delete ANY OTHER manager's portfolio via a direct API call (e.g. the same request
-- createPortfolio()'s replacesPortfolioId-close or updatePortfolioMeta() already send, just
-- pointed at a portfolio_id outside their own team). portfolios_select was already correctly
-- scoped via auth_visible_portfolio_ids() (see 20260821_rls_no_direct_table_reads.sql), so the
-- UI itself never surfaces another manager's portfolio to pick -- but RLS, not the UI, is the
-- actual security boundary, and the write side didn't match the read side.
--
-- INSERT stays permissive to any admin/manager (creating a brand-new portfolio has nothing to
-- scope against yet). UPDATE/DELETE now require the same visibility an admin/manager already
-- needs to SELECT the row -- admin unrestricted, manager limited to auth_visible_portfolio_ids()
-- (portfolios they manage, their team's, or containing a debtor assigned to them). This does
-- not change any working flow: every UPDATE/DELETE call site (createPortfolio's
-- replacesPortfolioId close, updatePortfolioMeta, admin assignment) only ever acts on a
-- portfolio_id drawn from getPortfolios(), which was already limited to what the caller can see.
DROP POLICY IF EXISTS portfolios_write ON portfolios;

CREATE POLICY portfolios_insert ON portfolios FOR INSERT TO authenticated
  WITH CHECK (
    client_id = auth_client_id()
    AND auth_role() = ANY (ARRAY['admin', 'manager'])
  );

CREATE POLICY portfolios_update ON portfolios FOR UPDATE TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (auth_role() = 'manager' AND id IN (SELECT auth_visible_portfolio_ids()))
    )
  )
  WITH CHECK (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (auth_role() = 'manager' AND id IN (SELECT auth_visible_portfolio_ids()))
    )
  );

CREATE POLICY portfolios_delete ON portfolios FOR DELETE TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (auth_role() = 'manager' AND id IN (SELECT auth_visible_portfolio_ids()))
    )
  );

NOTIFY pgrst, 'reload schema';
