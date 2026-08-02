-- Fix: ad-hoc (Manual Dial) call_logs rows could never be inserted.
--
-- 20260730_harden_rls.sql wrote:
--   WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
--
-- call_logs.debtor_id is intentionally NULL for a Manual Dial call (see
-- 20260731_call_logs_adhoc_contacts.sql — contact_name/contact_phone carry the ad-hoc
-- contact instead). In SQL, `NULL IN (...)` evaluates to NULL, not TRUE, so the WITH CHECK
-- silently failed and every disposition on a manual-dialled call was rejected. Reproduced
-- today: "failed to save outcome" on a call to an ad-hoc number.
--
-- Same shape exists on messages/payments/disputes/settlement_requests. Nothing writes a
-- NULL debtor_id there today, but fixing the pattern everywhere now avoids hitting this
-- exact bug again the next time ad-hoc rows are needed.

DROP POLICY IF EXISTS call_logs_insert ON call_logs;
CREATE POLICY call_logs_insert ON call_logs FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS messages_insert ON messages;
CREATE POLICY messages_insert ON messages FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS payments_insert ON payments;
CREATE POLICY payments_insert ON payments FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS disputes_insert ON disputes;
CREATE POLICY disputes_insert ON disputes FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );

DROP POLICY IF EXISTS settlements_insert ON settlement_requests;
CREATE POLICY settlements_insert ON settlement_requests FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IS NULL
    OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
  );
