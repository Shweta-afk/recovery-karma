-- Settlement in the Call Queue (user, 2026-11-12). Builds on
-- 20261112_sticky_ptp_callback_status.sql (sorts after it):
--   * a Settlement logged after a PTP ends the PTP, like a Paid;
--   * a Settlement stays the account's status through later no-answers, like a Callback;
--   * queue status 'settlement' (it used to fall through to 'fresh'), so it has its own pill.
-- Same rule as effectiveDisposition() in src/lib/disposition-store.ts.
-- Edits only these fragments of the live function; each is skipped if already applied and
-- refused if its original text isn't there. Applied live 2026-11-12.
DO $do$
DECLARE
  d text := pg_get_functiondef('public.debtor_list(jsonb)'::regprocedure);
  pairs text[][] := ARRAY[
    ARRAY[$a$AND y.outcome = ''paid'' AND$a$, $b$AND y.outcome IN (''paid'', ''settlement'') AND$b$],
    ARRAY[$a$WHERE k.outcome = ''callback'') $a$, $b$WHERE k.outcome IN (''callback'', ''settlement'')) $b$],
    ARRAY[$a$WHEN 'callback' THEN 'callback'
       WHEN 'no_answer' THEN 'no_answer'$a$, $b$WHEN 'callback' THEN 'callback'
       WHEN 'settlement' THEN 'settlement' WHEN 'no_answer' THEN 'no_answer'$b$]
  ];
  i int;
  changed boolean := false;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    IF position(pairs[i][2] IN d) > 0 THEN
      CONTINUE;
    END IF;
    IF position(pairs[i][1] IN d) = 0 THEN
      RAISE EXCEPTION 'debtor_list: fragment % not found; not changed', i;
    END IF;
    d := replace(d, pairs[i][1], pairs[i][2]);
    changed := true;
  END LOOP;
  IF changed THEN
    EXECUTE d;
  END IF;
END
$do$;
