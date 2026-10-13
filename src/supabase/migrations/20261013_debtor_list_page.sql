-- One page of debtors at a time for the Debtors page and Call Queue (src/lib/debtor-page-store.ts).
--
-- Before this, both screens downloaded the caller's WHOLE book (refreshScopedPortfolios, 1,000
-- rows per request; admins the full refreshPortfolios() sync — 29,800 rows for the largest
-- company) and then filtered, sorted and paged in the browser. Load time grew with every upload.
-- Now the browser asks for one page (≤100 rows) plus, separately, the totals the filters show.
--
-- debtor_list(p jsonb) has three modes, all reading the same filtered set:
--   'rows'   — one page, sorted, p.offset / p.limit (≤1000; the dialer pages through a list)
--   'count'  — how many rows match every filter (the "N debtors" label and the pager)
--   'facets' — counts grouped by the dimensions named in p.dims, over the SCOPE only (user
--              filters ignored) — what the dropdown counts and Call Queue's KPI cards show
--
-- SECURITY INVOKER: every read runs as the caller, so debtors_select (and the call_logs,
-- portfolios, insight_requests and debtor_traces policies) still decide which rows exist.
-- The scope parameters only ever NARROW that set; nothing here can widen it. Not an `auth_*`
-- helper and reads no table on a policy's behalf, so it is outside the recursion class
-- scripts/check-rls-safety.mjs guards.
--
-- The filters mirror what the two screens did in the browser (dashboard.debtors.tsx's
-- `filtered`, dashboard.call-queue.tsx's `filteredQueue`), including:
--   * a debtor with no portfolio, or whose portfolio the caller cannot see, is not listed;
--   * p.open_only drops closed / past-end-date portfolios (isPortfolioEnded, IST) in SQL, so
--     an agent never downloads them (live 2026-10-13: 22,820 rows in closed portfolios and
--     10,369 in past-end-date ones, of 68,659); archived dead accounts are always dropped;
--   * queue status = the debtor's latest call outcome (promised→ptp, callback, no_answer,
--     anything else / never called → fresh), as build-queue.ts derived it from all visible
--     call logs; "own" outcome/reason = the latest call by one of p.agent_ids (Call Queue's
--     Disposition filter);
--   * AI score = clamp(round(10 - dpd/20), 1, 10), the formula debtorFromRow uses.
-- One deliberate difference: the "last contacted" range filters debtors.last_contacted_at. The
-- browser compared against a placeholder "—" (no list fetch ever read the column), so a range
-- with a start date matched everything and one with an end date matched nothing.
--
-- `d.extra_named` / `d.extra_head` are written in attribute notation, which resolves to the
-- stored columns (20261013_debtor_list_speed.sql) or, before that, the computed-column
-- functions (20260923_debtors_extra_preview.sql) — so this works in either order.

CREATE INDEX IF NOT EXISTS idx_call_logs_debtor_created ON call_logs (debtor_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.debtor_list(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  mode text := coalesce(p->>'mode', 'rows');
  queue boolean := coalesce((p->>'queue')::boolean, false);
  agent_ids uuid[];
  portfolio_ids uuid[];
  ids uuid[];
  statuses text[];
  dims text[];
  pattern text;
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  lim int := least(greatest(coalesce((p->>'limit')::int, 100), 1), 1000);
  off int := greatest(coalesce((p->>'offset')::int, 0), 0);
  score_expr constant text := 'greatest(1, least(10, round(10 - coalesce(d.dpd, 0) / 20.0)))';
  status_expr constant text :=
    $$CASE lc.outcome WHEN 'promised' THEN 'ptp' WHEN 'callback' THEN 'callback'
       WHEN 'no_answer' THEN 'no_answer' ELSE 'fresh' END$$;
  bucket_expr constant text :=
    $$CASE WHEN coalesce(d.dpd, 0) = 0 THEN 'X' WHEN d.dpd <= 30 THEN '1' WHEN d.dpd <= 90 THEN '2'
       WHEN d.dpd <= 179 THEN 'NPA' ELSE 'WriteOff' END$$;
  insight_expr constant text :=
    $$CASE WHEN EXISTS (SELECT 1 FROM insight_requests r WHERE r.debtor_id = d.id AND r.status = 'open')
            THEN 'requested'
          WHEN EXISTS (SELECT 1 FROM debtor_traces t WHERE t.debtor_id = d.id AND t.state = 'done')
            THEN 'traced'
          ELSE 'none' END$$;
  from_sql text;
  lc_join text;
  oc_join text;
  scope_sql text;
  filter_sql text := '';
  order_sql text;
  sel text;
  dir text := CASE WHEN p->>'dir' = 'desc' THEN 'DESC' ELSE 'ASC' END;
  result jsonb;
BEGIN
  IF jsonb_typeof(p->'agent_ids') = 'array' THEN
    agent_ids := ARRAY(SELECT jsonb_array_elements_text(p->'agent_ids'))::uuid[];
  END IF;
  IF jsonb_typeof(p->'portfolio_ids') = 'array' THEN
    portfolio_ids := ARRAY(SELECT jsonb_array_elements_text(p->'portfolio_ids'))::uuid[];
  END IF;
  IF jsonb_typeof(p->'ids') = 'array' THEN
    ids := ARRAY(SELECT jsonb_array_elements_text(p->'ids'))::uuid[];
  END IF;
  IF jsonb_typeof(p->'queue_statuses') = 'array' THEN
    statuses := ARRAY(SELECT jsonb_array_elements_text(p->'queue_statuses'));
  END IF;
  IF coalesce(btrim(p->>'search'), '') <> '' THEN
    pattern := '%' || replace(replace(replace(lower(btrim(p->>'search')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  -- The latest call per debtor (any visible agent) and the latest by the scoped agents, joined
  -- only where a filter, sort or facet needs them — idx_call_logs_debtor_created makes each one
  -- index probe per row, but per row of the whole scope adds up. Rows mode joins them again
  -- for just the page it returns.
  lc_join := 'LEFT JOIN LATERAL (SELECT c.outcome, c.promise_amount, c.promise_date FROM call_logs c '
    || '  WHERE c.debtor_id = d.id ORDER BY c.created_at DESC LIMIT 1) lc ON true ';
  oc_join := 'LEFT JOIN LATERAL (SELECT c.outcome, c.outcome_reason FROM call_logs c '
    || '  WHERE c.debtor_id = d.id AND c.agent_id = ANY ($2) ORDER BY c.created_at DESC LIMIT 1) oc ON true ';
  from_sql := 'debtors d JOIN portfolios pf ON pf.id = d.portfolio_id ';
  -- (facets always: Call Queue's PTP total is summed from the latest call.)
  IF queue AND (statuses IS NOT NULL OR p->>'sort' IN ('status', 'scheduled') OR mode = 'facets') THEN
    from_sql := from_sql || lc_join;
  END IF;
  IF queue AND (p->>'own_outcome' IS NOT NULL OR p->>'own_reason' IS NOT NULL
      OR (mode = 'facets' AND p->'dims' ?| ARRAY['own_outcome', 'own_reason'])) THEN
    from_sql := from_sql || oc_join;
  END IF;

  -- Scope: what the screen is about, before any filter the user picks. $1 = p.
  -- archived_at: a dead account stripped 60 days after its portfolio closed
  -- (dead-account-archive.server.ts) is never listed, whichever portfolio it sits in.
  scope_sql := 'coalesce(d.status, ''active'') <> ''removed'' AND d.archived_at IS NULL AND pf.deleted_at IS NULL';
  IF agent_ids IS NOT NULL THEN scope_sql := scope_sql || ' AND d.assigned_agent_id = ANY ($2)'; END IF;
  IF portfolio_ids IS NOT NULL THEN scope_sql := scope_sql || ' AND d.portfolio_id = ANY ($3)'; END IF;
  IF ids IS NOT NULL THEN scope_sql := scope_sql || ' AND d.id = ANY ($4)'; END IF;
  IF coalesce((p->>'open_only')::boolean, false) THEN
    scope_sql := scope_sql || ' AND pf.closed_at IS NULL AND (pf.end_date IS NULL OR pf.end_date >= $6)';
  END IF;
  IF coalesce((p->>'exclude_paid')::boolean, false) THEN
    scope_sql := scope_sql || ' AND coalesce(d.status, '''') <> ''paid''';
  END IF;

  -- Filters the user picks.
  IF p->>'portfolio_id' IS NOT NULL THEN
    filter_sql := filter_sql || ' AND d.portfolio_id = ($1->>''portfolio_id'')::uuid';
  END IF;
  IF pattern IS NOT NULL THEN
    filter_sql := filter_sql || ' AND (lower(coalesce(nullif(d.name, ''''), ''(unknown)'')) LIKE $5'
      || ' OR lower(coalesce(d.loan_reference, d.id::text)) LIKE $5'
      || CASE WHEN queue THEN ' OR d.phone_primary LIKE $5' ELSE '' END || ')';
  END IF;
  IF p->>'bucket' IS NOT NULL THEN
    filter_sql := filter_sql || ' AND (' || bucket_expr || ') = ($1->>''bucket'')';
  END IF;
  IF p->>'assignee' = 'unassigned' THEN
    filter_sql := filter_sql || ' AND d.assigned_agent_id IS NULL';
  ELSIF p->>'assignee' IS NOT NULL THEN
    filter_sql := filter_sql || ' AND d.assigned_agent_id = ($1->>''assignee'')::uuid';
  END IF;
  IF p->>'insight' IS NOT NULL THEN
    filter_sql := filter_sql || ' AND (' || insight_expr || ') = ($1->>''insight'')';
  END IF;
  IF p->>'contacted_from' IS NOT NULL OR p->>'contacted_to' IS NOT NULL THEN
    filter_sql := filter_sql || ' AND d.last_contacted_at IS NOT NULL'
      || ' AND ($1->>''contacted_from'' IS NULL OR (d.last_contacted_at AT TIME ZONE ''Asia/Kolkata'')::date >= ($1->>''contacted_from'')::date)'
      || ' AND ($1->>''contacted_to'' IS NULL OR (d.last_contacted_at AT TIME ZONE ''Asia/Kolkata'')::date <= ($1->>''contacted_to'')::date)';
  END IF;
  IF coalesce((p->>'retained')::boolean, false) THEN
    filter_sql := filter_sql || ' AND d.retained_from_portfolio_id IS NOT NULL';
  END IF;
  IF p->>'outstanding' = 'lt1L' THEN filter_sql := filter_sql || ' AND coalesce(d.loan_amount, 0) < 100000';
  ELSIF p->>'outstanding' = '1to5L' THEN filter_sql := filter_sql || ' AND coalesce(d.loan_amount, 0) BETWEEN 100000 AND 500000';
  ELSIF p->>'outstanding' = 'gt5L' THEN filter_sql := filter_sql || ' AND coalesce(d.loan_amount, 0) > 500000';
  END IF;
  IF p->>'dpd_band' = 'lt30' THEN filter_sql := filter_sql || ' AND coalesce(d.dpd, 0) < 30';
  ELSIF p->>'dpd_band' = '30to60' THEN filter_sql := filter_sql || ' AND coalesce(d.dpd, 0) BETWEEN 30 AND 60';
  ELSIF p->>'dpd_band' = '61to90' THEN filter_sql := filter_sql || ' AND coalesce(d.dpd, 0) BETWEEN 61 AND 90';
  ELSIF p->>'dpd_band' = 'gt90' THEN filter_sql := filter_sql || ' AND coalesce(d.dpd, 0) > 90';
  END IF;
  IF p->>'score_band' = 'high' THEN filter_sql := filter_sql || ' AND ' || score_expr || ' >= 8';
  ELSIF p->>'score_band' = 'mid' THEN filter_sql := filter_sql || ' AND ' || score_expr || ' BETWEEN 5 AND 7';
  ELSIF p->>'score_band' = 'low' THEN filter_sql := filter_sql || ' AND ' || score_expr || ' < 5';
  END IF;
  IF queue THEN
    IF statuses IS NOT NULL THEN
      filter_sql := filter_sql || ' AND (' || status_expr || ') = ANY ($7)';
    END IF;
    IF p->>'own_outcome' IS NOT NULL THEN
      filter_sql := filter_sql || ' AND oc.outcome = ($1->>''own_outcome'')';
    END IF;
    IF p->>'own_reason' IS NOT NULL THEN
      filter_sql := filter_sql || ' AND oc.outcome_reason = ($1->>''own_reason'')';
    END IF;
  END IF;

  IF mode = 'count' THEN
    EXECUTE 'SELECT jsonb_build_object(''total'', count(*)) FROM ' || from_sql
      || ' WHERE ' || scope_sql || filter_sql
      INTO result USING p, agent_ids, portfolio_ids, ids, pattern, today, statuses;
    RETURN result;
  END IF;

  IF mode = 'facets' THEN
    -- Whitelisted dimensions only; every other value of p.dims is ignored.
    SELECT array_agg(x) INTO dims FROM jsonb_array_elements_text(coalesce(p->'dims', '[]'::jsonb)) x
     WHERE x IN ('portfolio_id', 'assigned_agent_id', 'insight', 'bucket', 'retained',
                 'queue_status', 'own_outcome', 'own_reason')
       AND (queue OR x NOT IN ('queue_status', 'own_outcome', 'own_reason'));
    sel := 'count(*) AS n, sum(coalesce(d.loan_amount, 0)) AS loan_sum'
      || ', count(*) FILTER (WHERE d.last_contacted_at IS NOT NULL AND (d.last_contacted_at AT TIME ZONE ''Asia/Kolkata'')::date = $6) AS contacted_today';
    IF queue THEN
      sel := sel || ', sum(CASE WHEN lc.outcome = ''promised'' THEN coalesce(lc.promise_amount, 0) ELSE 0 END) AS ptp_sum';
    END IF;
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(g)), ''[]''::jsonb) FROM (SELECT '
      || coalesce((SELECT string_agg(
           CASE x WHEN 'portfolio_id' THEN 'd.portfolio_id'
                  WHEN 'assigned_agent_id' THEN 'd.assigned_agent_id'
                  WHEN 'insight' THEN '(' || insight_expr || ')'
                  WHEN 'bucket' THEN '(' || bucket_expr || ')'
                  WHEN 'retained' THEN '(d.retained_from_portfolio_id IS NOT NULL)'
                  WHEN 'queue_status' THEN '(' || status_expr || ')'
                  WHEN 'own_outcome' THEN 'oc.outcome'
                  WHEN 'own_reason' THEN 'oc.outcome_reason' END || ' AS ' || x, ', ')
         FROM unnest(dims) x) || ', ', '')
      || sel || ' FROM ' || from_sql || ' WHERE ' || scope_sql
      || CASE WHEN dims IS NULL THEN '' ELSE ' GROUP BY ' || (SELECT string_agg(i::text, ', ') FROM generate_series(1, cardinality(dims)) i) END
      || ') g'
      INTO result USING p, agent_ids, portfolio_ids, ids, pattern, today, statuses;
    RETURN jsonb_build_object('groups', result);
  END IF;

  -- mode = 'rows'. Always ends in d.id so pages never overlap or skip a row.
  order_sql := CASE coalesce(p->>'sort', '')
    WHEN 'dpd_desc' THEN 'coalesce(d.dpd, 0) DESC'
    WHEN 'dpd_asc' THEN 'coalesce(d.dpd, 0) ASC'
    WHEN 'outstanding_desc' THEN 'coalesce(d.loan_amount, 0) DESC'
    WHEN 'outstanding_asc' THEN 'coalesce(d.loan_amount, 0) ASC'
    WHEN 'score_desc' THEN score_expr || ' DESC'
    WHEN 'name_asc' THEN 'lower(coalesce(nullif(d.name, ''''), ''(unknown)'')) ASC'
    -- Call Queue's column headers: a key plus p.dir.
    WHEN 'name' THEN 'lower(coalesce(nullif(d.name, ''''), ''(unknown)'')) ' || dir
    WHEN 'outstanding' THEN 'coalesce(d.loan_amount, 0) ' || dir
    WHEN 'dpd' THEN 'coalesce(d.dpd, 0) ' || dir
    WHEN 'aiScore' THEN score_expr || ' ' || dir
    WHEN 'status' THEN CASE WHEN queue THEN '(' || status_expr || ') ' || dir ELSE 'd.id' END
    WHEN 'scheduled' THEN CASE WHEN queue
      THEN $$(CASE WHEN lc.outcome = 'promised' AND lc.promise_date IS NOT NULL THEN lc.promise_date::text ELSE '—' END) $$ || dir
      ELSE 'd.id' END
    -- No sort chosen: the list order — portfolio by upload, then the order rows were uploaded.
    ELSE 'pf.uploaded_at, d.portfolio_id, d.created_at'
  END || ', d.id';

  sel := 'd.id, d.portfolio_id, pf.name AS portfolio_name, pf.lender_name, pf.product_type, d.name, d.phone_primary, d.email, '
    || 'd.loan_amount, d.dpd, d.loan_reference, d.assigned_agent_id, d.status, d.alt_phones, '
    || 'd.principal_amount, d.emi_amount, d.product_code, d.retained_from_portfolio_id, '
    || 'rp.name AS retained_from_name, d.last_contacted_at';
  IF coalesce((p->>'extra')::boolean, true) THEN sel := sel || ', d.extra_named AS extra_named'; END IF;
  IF coalesce((p->>'extra_head')::boolean, false) THEN sel := sel || ', d.extra_head AS extra_head'; END IF;
  IF queue THEN
    sel := sel || ', lc.outcome AS last_outcome'
      || $$, CASE WHEN lc.outcome = 'promised' THEN lc.promise_amount END AS ptp_amount$$
      || $$, CASE WHEN lc.outcome = 'promised' THEN lc.promise_date END AS ptp_date$$
      || ', oc.outcome AS own_outcome, oc.outcome_reason AS own_reason';
  END IF;

  -- Pick the page's ids first, touching only the columns the filters and sort need; then
  -- build the (much wider) output rows for those ids alone.
  EXECUTE 'SELECT coalesce(array_agg(k.id), ''{}'') FROM (SELECT d.id FROM ' || from_sql
    || ' WHERE ' || scope_sql || filter_sql
    || ' ORDER BY ' || order_sql || ' LIMIT ' || lim || ' OFFSET ' || off || ') k'
    INTO ids USING p, agent_ids, portfolio_ids, ids, pattern, today, statuses;

  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(q) - ''_n'' ORDER BY q._n), ''[]''::jsonb) FROM (SELECT ' || sel
    || ', k.n AS _n FROM unnest($4) WITH ORDINALITY k(id, n) JOIN debtors d ON d.id = k.id'
    || ' JOIN portfolios pf ON pf.id = d.portfolio_id'
    || ' LEFT JOIN portfolios rp ON rp.id = d.retained_from_portfolio_id '
    || CASE WHEN queue THEN lc_join || oc_join ELSE '' END || ') q'
    INTO result USING p, agent_ids, portfolio_ids, ids, pattern, today, statuses;
  RETURN jsonb_build_object('rows', result);
END;
$fn$;

REVOKE ALL ON FUNCTION public.debtor_list(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.debtor_list(jsonb) TO authenticated, service_role;
