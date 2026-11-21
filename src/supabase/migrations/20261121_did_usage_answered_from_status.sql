-- "Picked up (7d)" on Superadmin → Numbers & Lines counted a call as answered only when
-- telephony_calls.answered_at was set — and SkyCRM never sends the moment of answer, so it is
-- NULL on every row and every number showed 0% (found 2026-11-21, the day numbers went live).
-- Answered now means the ledger says the call connected (status 'completed', or answered_at set
-- for a provider that does send it) — the same rule as Call Audit's "Connected".
CREATE OR REPLACE FUNCTION public.telephony_did_usage(p_did_ids uuid[], p_day_start timestamptz, p_week_start timestamptz)
 RETURNS TABLE(did_id uuid, calls_today integer, calls_7d integer, answered_7d integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    SELECT c.did_id,
           count(*) FILTER (WHERE c.started_at >= p_day_start)::INTEGER,
           count(*) FILTER (WHERE c.direction = 'outbound')::INTEGER,
           count(*) FILTER (WHERE c.direction = 'outbound'
                              AND (c.status = 'completed' OR c.answered_at IS NOT NULL))::INTEGER
      FROM telephony_calls c
     WHERE c.did_id = ANY (p_did_ids)
       AND c.started_at >= LEAST(p_day_start, p_week_start)
     GROUP BY c.did_id
  $function$;
