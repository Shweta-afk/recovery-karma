-- "Fresh" means never called (user, 2026-11-24).
--
-- debtor_list's queue status mapped only promised / callback / settlement / no_answer and sent
-- every other outcome to 'fresh', so accounts last dispositioned Paid, Partially Paid, Refused,
-- Dispute, Wrong Number, Deceased, Escalated or Voicemail showed as Fresh. Now:
--   no call log at all        → fresh
--   voicemail                 → no_answer
--   paid / partial_paid       → paid   (a Partially Paid WITH a balance date is already a PTP —
--                                       rule 1 of lc_join reports it as 'promised')
--   refused, dispute, wrong_number, deceased, escalated → their own status, same name
-- Same mapping as OUTCOME_TO_QUEUE_STATUS in src/lib/call-queue/build-queue.ts; change together.
-- Edits only this fragment of the live function; skipped if already applied, refused if the
-- original text isn't there.
DO $do$
DECLARE
  d text := pg_get_functiondef('public.debtor_list(jsonb)'::regprocedure);
  old_frag constant text := $a$WHEN 'no_answer' THEN 'no_answer' ELSE 'fresh' END$a$;
  new_frag constant text := $b$WHEN 'no_answer' THEN 'no_answer' WHEN 'voicemail' THEN 'no_answer'
       WHEN 'paid' THEN 'paid' WHEN 'partial_paid' THEN 'paid' WHEN 'refused' THEN 'refused'
       WHEN 'dispute' THEN 'dispute' WHEN 'wrong_number' THEN 'wrong_number'
       WHEN 'deceased' THEN 'deceased' WHEN 'escalated' THEN 'escalated' ELSE 'fresh' END$b$;
BEGIN
  IF position($c$WHEN 'voicemail' THEN 'no_answer'$c$ IN d) > 0 THEN
    RETURN;
  END IF;
  IF position(old_frag IN d) = 0 THEN
    RAISE EXCEPTION 'debtor_list: queue status fragment not found; not changed';
  END IF;
  EXECUTE replace(d, old_frag, new_frag);
END
$do$;
