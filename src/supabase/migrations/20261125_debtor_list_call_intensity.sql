-- Call Queue: "Intensity" = how many times an account has been called (user, 2026-11-25), so
-- agents can filter to, and sort by, the accounts called least.
--
-- Counted the same way as the Feedback File's "Intensity of Calls": every call_logs row on the
-- debtor except disposition updates made without dialling (dial_mode 'no_call'), by ANY agent.
-- debtor_list is SECURITY INVOKER, so the count is what call_logs_select lets the caller see —
-- for an agent that is every call on an account they can see (shared notes, 2026-08-27).
--
-- Adds to debtor_list (queue mode only for the column; filter + sort work in both modes):
--   p.intensity  '0' | '1to2' | '3to5' | '6to10' | 'gt10'   filter
--   p.sort       'intensity' (with p.dir)                       sort
--   rows         call_count                                     column
-- Same bands as INTENSITY_BANDS in src/lib/debtor-page-store.ts; change together.
-- Edits fragments of the live function; skipped if already applied, refused if an anchor isn't
-- there.
DO $do$
DECLARE
  d text := pg_get_functiondef('public.debtor_list(jsonb)'::regprocedure);
  decl_anchor constant text := $a$  from_sql text;$a$;
  decl_new constant text := $a$  intensity_expr constant text :=
    $$(SELECT count(*) FROM call_logs ci WHERE ci.debtor_id = d.id AND ci.dial_mode IS DISTINCT FROM 'no_call')$$;
  from_sql text;$a$;
  filter_anchor constant text := $a$  IF queue THEN
    IF statuses IS NOT NULL THEN$a$;
  filter_new constant text := $a$  IF p->>'intensity' = '0' THEN filter_sql := filter_sql || ' AND ' || intensity_expr || ' = 0';
  ELSIF p->>'intensity' = '1to2' THEN filter_sql := filter_sql || ' AND ' || intensity_expr || ' BETWEEN 1 AND 2';
  ELSIF p->>'intensity' = '3to5' THEN filter_sql := filter_sql || ' AND ' || intensity_expr || ' BETWEEN 3 AND 5';
  ELSIF p->>'intensity' = '6to10' THEN filter_sql := filter_sql || ' AND ' || intensity_expr || ' BETWEEN 6 AND 10';
  ELSIF p->>'intensity' = 'gt10' THEN filter_sql := filter_sql || ' AND ' || intensity_expr || ' > 10';
  END IF;
  IF queue THEN
    IF statuses IS NOT NULL THEN$a$;
  sort_anchor constant text := $a$    WHEN 'status' THEN CASE WHEN queue$a$;
  sort_new constant text := $a$    WHEN 'intensity' THEN intensity_expr || ' ' || dir
    WHEN 'status' THEN CASE WHEN queue$a$;
  sel_anchor constant text := $a$', oc.outcome AS own_outcome, oc.outcome_reason AS own_reason';$a$;
  sel_new constant text := $a$', oc.outcome AS own_outcome, oc.outcome_reason AS own_reason, ' || intensity_expr || ' AS call_count';$a$;
BEGIN
  IF position('intensity_expr' IN d) > 0 THEN
    RETURN;
  END IF;
  IF position(decl_anchor IN d) = 0 OR position(filter_anchor IN d) = 0
     OR position(sort_anchor IN d) = 0 OR position(sel_anchor IN d) = 0 THEN
    RAISE EXCEPTION 'debtor_list: an anchor for call intensity was not found; not changed';
  END IF;
  d := replace(d, decl_anchor, decl_new);
  d := replace(d, filter_anchor, filter_new);
  d := replace(d, sort_anchor, sort_new);
  d := replace(d, sel_anchor, sel_new);
  EXECUTE d;
END
$do$;
