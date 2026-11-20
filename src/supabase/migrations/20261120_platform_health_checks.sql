-- Daily health check for the superadmin (user, 2026-11-20: "we cannot risk such things").
--
-- One read-only function that counts, for a time window, the symptoms of bugs we have actually
-- had, so they show up within a day instead of a week:
--   wrong_recording      a call carries another call's recording (late end record matched to
--                        the wrong call — found 2026-11-20, hidden for 8 days)
--   ended_but_talked     SamvadX recorded a call as not connected, but the agent saved a real
--                        conversation for it (screen ended a live call)
--   stuck_open           a call still "open" 2+ hours after it was dialled
--   no_end_records       an extension with 20+ dials and not one end-of-call record (ext 8621)
--   phone_offline        an extension refused 5+ times as "phone not connected" (SX-3106)
--   calls_failed         share of calls SkyCRM ended as failed, per company
--   no_callid            calls that never got SkyCRM's call id (events not arriving/matching)
--   talk_not_copied      connected calls whose talk time never reached the call log
--   cross_company        a call log or Insights lookup whose company differs from the
--                        borrower's company (data leaking between companies)
--   insights_errors      Insights lookups ProfileX answered with an error, per service
--   profilex_wallet_empty ProfileX refused for lack of balance
--   insights_pending     lookups stuck "pending" 30+ minutes
--   insights_prices      billed lookups per service + status with what companies were charged
--                        (the server compares this with ProfileX's cost)
-- Rules for what counts as a problem live in src/lib/health-checks.ts (tested); this only counts.
-- service_role only: it reads across every company.

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
