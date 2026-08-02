-- Fix: an ad-hoc (Manual Dial) call_logs row saves successfully but is then invisible.
--
-- 20260802_fix_null_debtor_rls.sql fixed the INSERT policies for NULL debtor_id, but missed
-- that call_logs_select has the identical bug:
--   USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
-- NULL IN (...) is NULL, not TRUE, so a row with debtor_id IS NULL is rejected by SELECT too.
--
-- Confirmed directly in Supabase's Edge Logs: POST /rest/v1/call_logs returned 201 (the
-- write succeeded), yet Activity History still showed zero new rows minutes later — the
-- row exists but no SELECT can ever return it under the old policy.

DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS disputes_select ON disputes;
CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
  USING (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS settlements_select ON settlement_requests;
CREATE POLICY settlements_select ON settlement_requests FOR SELECT TO authenticated
  USING (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );
