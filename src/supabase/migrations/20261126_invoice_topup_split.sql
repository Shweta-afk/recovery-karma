-- One recharge, up to two invoices (user, 2026-11-26): the recharge the company paid for, and
-- the extra credit SamvadX gave on top. The superadmin decides the split.
--
-- invoices_topup_once allowed ONE live invoice per top-up. It now allows one per top-up PER PART.
-- The part rides on the invoice's first line ("part": "extra_credit"); a line without it is the
-- recharge itself, so every invoice issued before this keeps its meaning and the old rule still
-- holds for it. No column and no change to issue_invoice(). A cancelled invoice frees its part.
DROP INDEX IF EXISTS invoices_topup_once;
CREATE UNIQUE INDEX invoices_topup_once
  ON invoices (wallet_ledger_id, (COALESCE(lines -> 0 ->> 'part', 'recharge')))
  WHERE wallet_ledger_id IS NOT NULL AND status <> 'cancelled';
