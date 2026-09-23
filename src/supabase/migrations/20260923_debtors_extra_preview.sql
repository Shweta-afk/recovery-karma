-- Slim views of debtors.extra for list queries (growth plan item #1).
--
-- `extra` holds the bank file's unmapped columns — measured on production 2026-09-23: 88 keys
-- and 1,666 bytes per row on average (87% of the whole row), ~2,400 chars once JSON-encoded.
-- Every list fetch selected it in full, although a list only ever shows a small part of it:
--
--   extra_named(debtors) — the 7 sub-fields the upload wizard always reserves inside `extra`
--     (address/city/state/dob/employer/income/language, see KNOWN_EXTRA_SUBFIELDS in
--     csv-fields.ts) plus the `pos`/`Principal` columns the debtor profile falls back to.
--     All debtorFromRow() reads. A few dozen bytes.
--   extra_head(debtors)  — the first 25 keys, in jsonb order. Exactly the set Call Queue can
--     render as table columns (MAX_EXTRA_COLUMNS in dashboard.call-queue.tsx takes the first
--     25 distinct keys across the queue's rows, and every key it can pick sits within its own
--     row's first 25). Checked against every live row before shipping: 0 mismatches. ~740
--     chars — only Call Queue asks for it.
--
-- Anything that needs the whole bag (debtor profile, in-call panel, Remap Fields) reads
-- `extra` itself for the one account or portfolio it is showing — see src/lib/debtor-extra.ts.
--
-- A function taking the table's row type is a PostgREST "computed column": it is selected like
-- a column (`select=id,extra_named`) and runs on rows debtors_select has ALREADY filtered.
-- SECURITY INVOKER (the default), reads nothing but its argument, touches no other table — so
-- it cannot widen what anyone sees, and is outside the `auth_*` helper class
-- scripts/check-rls-safety.mjs guards. Purely additive: `extra` itself is unchanged, and the
-- client falls back to selecting `extra` if these functions are missing.

CREATE OR REPLACE FUNCTION public.extra_named(d public.debtors)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(CASE WHEN jsonb_typeof(d.extra) = 'object' THEN d.extra ELSE '{}'::jsonb END) AS e
      WHERE e.key = ANY (ARRAY['address', 'city', 'state', 'dob', 'employer', 'income', 'language',
                               'pos', 'Principal'])),
    '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.extra_head(d public.debtors)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(CASE WHEN jsonb_typeof(d.extra) = 'object' THEN d.extra ELSE '{}'::jsonb END)
            WITH ORDINALITY AS e(key, value, n)
      WHERE e.n <= 25),
    '{}'::jsonb)
$$;

GRANT EXECUTE ON FUNCTION public.extra_named(public.debtors) TO authenticated;
GRANT EXECUTE ON FUNCTION public.extra_head(public.debtors) TO authenticated;

NOTIFY pgrst, 'reload schema';
