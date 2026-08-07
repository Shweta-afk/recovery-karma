-- Adds a soft-remove status for debtors, backing the new "Remove" action in the per-account
-- transfer table (manager.portfolio.tsx). A hard DELETE isn't viable here: call_logs,
-- messages, payments, disputes, and settlement_requests all reference debtor_id with no
-- ON DELETE cascade (schema.sql), so removing a debtor who already has any history would
-- either fail outright on the FK or, if forced through, destroy that history.
--
-- 'removed' debtors are excluded from portfolio-store.ts's refreshPortfolios() cache, so they
-- disappear from the call queue, portfolio counts, and assignment/transfer UI everywhere that
-- reads from it — while call_logs/payments/etc. stay completely intact and the debtor can be
-- brought back via restoreDebtor() (sets status back to 'active').
ALTER TABLE debtors DROP CONSTRAINT IF EXISTS debtors_status_check;
ALTER TABLE debtors ADD CONSTRAINT debtors_status_check CHECK (status IN (
  'active','paid','settled','legal','dispute','uncontactable','removed'
));
