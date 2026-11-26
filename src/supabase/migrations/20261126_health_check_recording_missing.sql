-- Health Check gains "recording_missing" (2026-11-26): answered SkyCRM calls, ended 2+ hours ago,
-- with no stored recording. ~2,100 answered calls from 4–20 Nov were marked "no recording" though
-- SkyCRM had one (the importer asked for a multi-day call-record range and got only its newest
-- part); nothing flagged it for a week. Same function as 20261120_platform_health_checks.sql plus
-- that one branch; rules in src/lib/health-checks.ts.

CREATE OR REPLACE FUNCTION public.platform_health_checks(p_since timestamptz, p_until timestamptz)
RETURNS TABLE (check_id text, client_id uuid, subject text, n bigint, total bigint, amount numeric)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH calls AS (
    SELECT * FROM telephony_calls t
     WHERE t.started_at >= p_since AND t.started_at < p_until
  ), traces AS (
    SELECT x.client_id, x.debtor_id, x.service_id, x.state, x.http_status, x.provider_status,
           x.transaction_id, x.cost, x.error, x.created_at
      FROM debtor_traces x WHERE x.created_at >= p_since AND x.created_at < p_until
    UNION ALL
    SELECT m.client_id, NULL::uuid, m.service_id, m.state, m.http_status, m.provider_status,
           m.transaction_id, m.cost, m.error, m.created_at
      FROM insights_manual_lookups m WHERE m.created_at >= p_since AND m.created_at < p_until
  )
  SELECT 'wrong_recording', c.client_id, NULL, count(*), NULL::bigint, NULL::numeric
    FROM calls c
   WHERE c.recording_path ~ 'out-\d+-\d+-'
     AND coalesce(c.recording_status, '') <> 'mismatched'
     AND right(substring(c.recording_path from 'out-\d+-(\d+)-'), 10)
         <> right(regexp_replace(coalesce(c.remote_phone, ''), '\D', '', 'g'), 10)
   GROUP BY c.client_id

  UNION ALL
  SELECT 'ended_but_talked', c.client_id, NULL, count(*), NULL, NULL
    FROM calls c
    JOIN call_logs l ON l.provider_call_id = coalesce(c.provider_call_id, c.id::text)
   WHERE c.status IN ('no_answer', 'failed', 'busy', 'canceled', 'superseded')
     AND l.outcome NOT IN ('no_answer', 'voicemail', 'wrong_number')
   GROUP BY c.client_id

  UNION ALL
  SELECT 'stuck_open', c.client_id, NULL, count(*), NULL, NULL
    FROM calls c
   WHERE c.ended_at IS NULL AND c.started_at < now() - interval '2 hours'
   GROUP BY c.client_id

  UNION ALL
  SELECT 'no_end_records', c.client_id, c.agent_handle,
         count(*) FILTER (WHERE c.status IN ('completed', 'no_answer', 'busy', 'failed')),
         count(*), NULL
    FROM calls c
   WHERE c.provider = 'skycrm' AND c.agent_handle IS NOT NULL AND c.direction = 'outbound'
   GROUP BY c.client_id, c.agent_handle

  UNION ALL
  SELECT 'phone_offline', c.client_id, c.agent_handle, count(*), NULL, NULL
    FROM calls c
   WHERE c.vendor_events ILIKE '%SX-3106%'
   GROUP BY c.client_id, c.agent_handle

  UNION ALL
  SELECT 'calls_failed', c.client_id, NULL,
         count(*) FILTER (WHERE c.status = 'failed' AND coalesce(c.vendor_events, '') NOT ILIKE '%refused%'),
         count(*) FILTER (WHERE coalesce(c.vendor_events, '') NOT ILIKE '%refused%'), NULL
    FROM calls c WHERE c.provider = 'skycrm'
   GROUP BY c.client_id

  UNION ALL
  SELECT 'no_callid', c.client_id, NULL,
         count(*) FILTER (WHERE c.vendor_callid IS NULL),
         count(*), NULL
    FROM calls c
   WHERE c.provider = 'skycrm' AND c.ended_at IS NOT NULL
     AND coalesce(c.vendor_events, '') NOT ILIKE '%refused%'
   GROUP BY c.client_id

  UNION ALL
  SELECT 'talk_not_copied', c.client_id, NULL, count(*), NULL, NULL
    FROM calls c
    JOIN call_logs l ON l.provider_call_id = coalesce(c.provider_call_id, c.id::text)
   WHERE c.status = 'completed' AND coalesce(c.duration_seconds, 0) > 0
     AND l.duration_seconds IS NULL AND c.ended_at < now() - interval '10 minutes'
   GROUP BY c.client_id

  UNION ALL
  SELECT 'recording_missing', c.client_id, NULL,
         count(*) FILTER (WHERE coalesce(c.recording_status, '') NOT IN ('stored', 'mismatched', 'expired')),
         count(*), NULL
    FROM calls c
   WHERE c.provider = 'skycrm' AND c.status = 'completed' AND coalesce(c.duration_seconds, 0) > 0
     AND c.ended_at < now() - interval '2 hours'
   GROUP BY c.client_id

  UNION ALL
  SELECT 'cross_company', a.client_id, 'call_logs', count(*), NULL, NULL
    FROM call_logs l
    JOIN agents a ON a.id = l.agent_id
    JOIN debtors d ON d.id = l.debtor_id
    JOIN portfolios p ON p.id = d.portfolio_id
   WHERE l.created_at >= p_since AND l.created_at < p_until AND p.client_id <> a.client_id
   GROUP BY a.client_id

  UNION ALL
  SELECT 'cross_company', x.client_id, 'insights', count(*), NULL, NULL
    FROM traces x
    JOIN debtors d ON d.id = x.debtor_id
    JOIN portfolios p ON p.id = d.portfolio_id
   WHERE p.client_id <> x.client_id
   GROUP BY x.client_id

  UNION ALL
  SELECT 'insights_errors', NULL, x.service_id,
         count(*) FILTER (WHERE x.http_status >= 400),
         count(*) FILTER (WHERE x.http_status IS NOT NULL), NULL
    FROM traces x
   WHERE coalesce(x.transaction_id, '') NOT LIKE 'reused:%'
   GROUP BY x.service_id

  UNION ALL
  SELECT 'profilex_wallet_empty', NULL, NULL, count(*), NULL, NULL
    FROM traces x
   WHERE x.http_status >= 400 AND x.error ILIKE '%insufficient%'

  UNION ALL
  SELECT 'insights_pending', x.client_id, NULL, count(*), NULL, NULL
    FROM traces x
   WHERE x.state = 'pending' AND x.created_at < now() - interval '30 minutes'
   GROUP BY x.client_id

  UNION ALL
  SELECT 'insights_prices', x.client_id, x.service_id || '|' || coalesce(x.provider_status, ''),
         count(*), count(*) FILTER (WHERE coalesce(x.cost, 0) = 0), sum(coalesce(x.cost, 0))
    FROM traces x
   WHERE x.http_status = 200 AND coalesce(x.transaction_id, '') NOT LIKE 'reused:%'
   GROUP BY x.client_id, x.service_id, x.provider_status
$$;

REVOKE ALL ON FUNCTION public.platform_health_checks(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_health_checks(timestamptz, timestamptz) TO service_role;
