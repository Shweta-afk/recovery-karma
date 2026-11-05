-- Undo the 2026-11-05 call_logs backfill (run by hand in the SQL Editor; NOT a migration).
-- The backfill: attached 569 unattached calls to the one open account whose number matched,
-- restored 11 callback dates and ~1,525 reasons from each call's auto-note. The old values of
-- every row it touched (1,545) are in ops_backup.call_logs_20261105 (private schema, no API
-- access). This puts them back exactly.
update public.call_logs cl
set debtor_id = b.debtor_id,
    outcome_reason = b.outcome_reason,
    callback_date = b.callback_date,
    callback_time = b.callback_time,
    dialed_phone = b.dialed_phone
from ops_backup.call_logs_20261105 b
where b.id = cl.id;
