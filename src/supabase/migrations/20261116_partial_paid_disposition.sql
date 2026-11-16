-- "Partially Paid" disposition (user, 2026-11-16).
--
-- The agent records what the borrower paid now (call_logs.promise_amount, as for "paid", plus a
-- payments row with payment_type 'partial') and, optionally, when the rest will be paid:
-- balance_amount + balance_date. With a balance date the call is a PTP for the balance — queue
-- status 'ptp', sticky until a later Paid / Settlement / Partially Paid — exactly like a
-- "promised" call. Without one it leaves the account where a Paid does.
-- Same rule as effectiveDisposition() in src/lib/disposition-store.ts; change them together.

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS balance_amount numeric;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS balance_date date;

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_outcome_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_outcome_check CHECK (outcome = ANY (ARRAY[
  'paid', 'partial_paid', 'promised', 'refused', 'no_answer', 'voicemail', 'dispute', 'callback',
  'wrong_number', 'deceased', 'escalated', 'settlement'
]));

-- debtor_list: a Partially Paid with a balance date is the account's PTP (reported as
-- 'promised' with the balance as its amount and date), and any Partially Paid ends an earlier
-- PTP. Edits only these fragments of the live function; each is skipped if already applied
-- and refused if its original text isn't there.
DO $do$
DECLARE
  d text := pg_get_functiondef('public.debtor_list(jsonb)'::regprocedure);
  pairs text[][] := ARRAY[
    ARRAY[$a$(SELECT c.outcome, c.promise_amount, c.promise_date, 1 AS pri FROM call_logs c '$a$,
          $b$(SELECT ''promised''::text AS outcome, CASE WHEN c.outcome = ''partial_paid'' THEN c.balance_amount ELSE c.promise_amount END AS promise_amount, CASE WHEN c.outcome = ''partial_paid'' THEN c.balance_date ELSE c.promise_date END AS promise_date, 1 AS pri FROM call_logs c '$b$],
    ARRAY[$a$WHERE c.debtor_id = d.id AND c.outcome = ''promised'' AND NOT EXISTS (SELECT 1 FROM call_logs y '$a$,
          $b$WHERE c.debtor_id = d.id AND (c.outcome = ''promised'' OR (c.outcome = ''partial_paid'' AND c.balance_date IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM call_logs y '$b$],
    ARRAY[$a$WHERE y.debtor_id = d.id AND y.outcome IN (''paid'', ''settlement'') AND y.created_at > c.created_at) '$a$,
          $b$WHERE y.debtor_id = d.id AND y.outcome IN (''paid'', ''settlement'', ''partial_paid'') AND y.created_at > c.created_at) '$b$]
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
