-- Queue status: a PTP stays PTP until paid; a callback stays through no-answers (user,
-- 2026-11-12). debtor_list used to take the debtor's LATEST call, so a "No answer — Ringing"
-- logged on a borrower who had promised to pay put them back in the ordinary queue.
--
-- The status call is now, in order:
--   1. the latest PTP with no Paid logged after it;
--   2. else the latest real conversation (anything but no_answer / voicemail) if it is a callback;
--   3. else the latest call.
-- Same rule as effectiveDisposition() in src/lib/disposition-store.ts (PTP tracker, follow-ups,
-- escalations) — change them together.
--
-- Edits ONLY the lc_join text inside the live function (pg_get_functiondef + replace), so it
-- can't overwrite other changes made to debtor_list; it refuses if that text isn't found, and
-- does nothing if already applied. Applied live 2026-11-12.
DO $do$
DECLARE
  d text := pg_get_functiondef('public.debtor_list(jsonb)'::regprocedure);
  old_join text := $old$lc_join := 'LEFT JOIN LATERAL (SELECT c.outcome, c.promise_amount, c.promise_date FROM call_logs c '
    || '  WHERE c.debtor_id = d.id ORDER BY c.created_at DESC LIMIT 1) lc ON true ';$old$;
  new_join text := $new$lc_join := 'LEFT JOIN LATERAL (SELECT e.outcome, e.promise_amount, e.promise_date FROM ('
    -- 1. A PTP stays the account's status until a Paid is logged after it.
    || '(SELECT c.outcome, c.promise_amount, c.promise_date, 1 AS pri FROM call_logs c '
    || '  WHERE c.debtor_id = d.id AND c.outcome = ''promised'' AND NOT EXISTS (SELECT 1 FROM call_logs y '
    || '  WHERE y.debtor_id = d.id AND y.outcome = ''paid'' AND y.created_at > c.created_at) '
    || '  ORDER BY c.created_at DESC LIMIT 1) '
    -- 2. A callback stays through later no-answers / voicemails.
    || 'UNION ALL (SELECT k.outcome, k.promise_amount, k.promise_date, 2 FROM (SELECT c.outcome, '
    || '  c.promise_amount, c.promise_date FROM call_logs c WHERE c.debtor_id = d.id '
    || '  AND c.outcome NOT IN (''no_answer'', ''voicemail'') ORDER BY c.created_at DESC LIMIT 1) k '
    || '  WHERE k.outcome = ''callback'') '
    -- 3. Otherwise the latest call.
    || 'UNION ALL (SELECT c.outcome, c.promise_amount, c.promise_date, 3 FROM call_logs c '
    || '  WHERE c.debtor_id = d.id ORDER BY c.created_at DESC LIMIT 1)'
    || ') e ORDER BY e.pri LIMIT 1) lc ON true ';$new$;
BEGIN
  IF position(new_join IN d) > 0 THEN
    RETURN; -- already applied
  END IF;
  IF position(old_join IN d) = 0 THEN
    RAISE EXCEPTION 'debtor_list: expected latest-call join not found; not changed';
  END IF;
  EXECUTE replace(d, old_join, new_join);
END
$do$;
