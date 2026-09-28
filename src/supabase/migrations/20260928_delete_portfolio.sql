-- "Delete portfolio" on Portfolio Overview, beside the existing Close.
--
-- Two outcomes, decided server-side in one call so the check and the delete cannot race:
--
--   * 'deleted' — nothing has happened on the portfolio yet (typically a wrong upload): no call
--     log, message, payment, dispute, settlement, escalation, reminder, PTP escalation,
--     retention request, live call or Insights lookup on any of its accounts, and no later
--     portfolio's accounts were retained from it. The portfolio and its debtors are removed.
--   * 'hidden' — anything above exists. A true delete would either hit a NO ACTION foreign key
--     (call_logs/payments/... -> debtors) or, worse, cascade away debtor_traces, the only record
--     of paid Insights spend. So the portfolio is closed (drops out of every call queue) and
--     stamped deleted_at, which hides it from the portfolio lists. All history stays, and
--     Reports keep counting it.
--
-- SECURITY DEFINER so the activity check sees every row, not just what the caller's RLS shows
-- (a manager may not see another team's call on a shared debtor). The caller is authorised
-- explicitly instead: admin of the portfolio's company, or a manager who can see it.

ALTER TABLE public.portfolios ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.delete_portfolio(p_portfolio_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_client uuid;
  v_role text := auth_role();
  v_used boolean;
BEGIN
  SELECT client_id INTO v_client FROM portfolios WHERE id = p_portfolio_id;
  IF v_client IS NULL OR v_client IS DISTINCT FROM auth_client_id() THEN
    RAISE EXCEPTION 'Portfolio not found';
  END IF;
  IF NOT (
    v_role = 'admin'
    OR (v_role = 'manager' AND p_portfolio_id IN (SELECT auth_visible_portfolio_ids()))
  ) THEN
    RAISE EXCEPTION 'Only a manager or admin of this portfolio can delete it';
  END IF;

  v_used :=
       EXISTS (SELECT 1 FROM debtors WHERE retained_from_portfolio_id = p_portfolio_id)
    OR EXISTS (SELECT 1 FROM retention_requests WHERE portfolio_id = p_portfolio_id)
    OR EXISTS (
      SELECT 1 FROM debtors d
       WHERE d.portfolio_id = p_portfolio_id
         AND (
              EXISTS (SELECT 1 FROM call_logs x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM messages x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM payments x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM disputes x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM settlement_requests x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM escalations x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM reminders x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM ptp_escalations x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM retention_requests x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM live_calls x WHERE x.debtor_id = d.id)
           OR EXISTS (SELECT 1 FROM debtor_traces x WHERE x.debtor_id = d.id)
         )
    );

  IF v_used THEN
    UPDATE portfolios
       SET deleted_at = now(),
           closed_at = coalesce(closed_at, now())
     WHERE id = p_portfolio_id;
    RETURN 'hidden';
  END IF;

  -- A later cycle that "continues" this one keeps working; it just loses the link back.
  UPDATE portfolios SET replaces_portfolio_id = NULL WHERE replaces_portfolio_id = p_portfolio_id;
  DELETE FROM debtors WHERE portfolio_id = p_portfolio_id;
  DELETE FROM portfolios WHERE id = p_portfolio_id;
  RETURN 'deleted';
END;
$$;

REVOKE ALL ON FUNCTION public.delete_portfolio(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_portfolio(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
