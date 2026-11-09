-- Call Auditor portal (2026-11-09).
--
-- A new company role, 'auditor', who listens to and scores every call in their company, team by
-- team, and gives feedback to agents and managers.
--
-- No existing RLS policy changes. An auditor's own session still sees almost nothing through
-- RLS (every policy compares auth_role() to 'admin'/'manager'); everything they read goes through
-- server functions (call-audit.server.ts) that verify the caller and scope by THEIR company, the
-- same way the superadmin portal works. Both tables below are server-only for the same reason.

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_role_check;
ALTER TABLE public.agents ADD CONSTRAINT agents_role_check
  CHECK (role IN ('agent', 'manager', 'admin', 'auditor'));

-- One audit per call. Re-auditing updates the row and bumps `revision`.
-- check:sql server-only: call_audits, team_audit_reviews
CREATE TABLE IF NOT EXISTS public.call_audits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES public.clients(id),
  call_log_id       UUID NOT NULL UNIQUE REFERENCES public.call_logs(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  auditor_id        UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  -- The team and manager the call belonged to WHEN audited, so a later team change does not move
  -- past scores between managers.
  team_id           UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  manager_id        UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  scorecard_version INTEGER NOT NULL DEFAULT 1,
  -- { "<parameter id>": { "value": "yes|partial|no|na", "remark": "..." } }
  scores            JSONB NOT NULL DEFAULT '{}'::jsonb,
  score_earned      NUMERIC(7,2) NOT NULL DEFAULT 0,
  score_possible    NUMERIC(7,2) NOT NULL DEFAULT 0,
  -- raw_percent ignores fatal errors; final_percent is 0 when one was found.
  raw_percent       NUMERIC(5,2) NOT NULL DEFAULT 0,
  final_percent     NUMERIC(5,2) NOT NULL DEFAULT 0,
  grade             TEXT NOT NULL,
  fatal             BOOLEAN NOT NULL DEFAULT false,
  fatal_codes       TEXT[] NOT NULL DEFAULT '{}',
  sentiment         TEXT CHECK (sentiment IN ('happy', 'neutral', 'frustrated', 'rude')),
  -- The auditor's verdict on the AI's suggestion. NULL when the AI never ran on this call.
  ai_agreement      TEXT CHECK (ai_agreement IN ('agree', 'partly', 'disagree')),
  ai_comment        TEXT,
  exemplary         BOOLEAN NOT NULL DEFAULT false,
  coaching_required BOOLEAN NOT NULL DEFAULT false,
  strengths         TEXT,
  improvements      TEXT,
  feedback_agent    TEXT,
  feedback_manager  TEXT,
  -- Seen only by auditors and admins, never by the agent or manager.
  internal_note     TEXT,
  agent_ack_at      TIMESTAMPTZ,
  agent_response    TEXT,
  manager_seen_at   TIMESTAMPTZ,
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_audits_client_created ON public.call_audits(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_audits_agent ON public.call_audits(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_audits_manager ON public.call_audits(manager_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_audits_auditor ON public.call_audits(auditor_id, created_at DESC);
ALTER TABLE public.call_audits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_audits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_audits TO service_role;

-- An auditor's review of a whole team and its manager for a period.
CREATE TABLE IF NOT EXISTS public.team_audit_reviews (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES public.clients(id),
  team_id          UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  team_name        TEXT NOT NULL,
  manager_id       UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  auditor_id       UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  summary          TEXT NOT NULL,
  strengths        TEXT,
  improvements     TEXT,
  action_items     TEXT,
  acknowledged_at  TIMESTAMPTZ,
  manager_response TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_audit_reviews_client ON public.team_audit_reviews(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_audit_reviews_manager ON public.team_audit_reviews(manager_id, created_at DESC);
ALTER TABLE public.team_audit_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_audit_reviews FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_audit_reviews TO service_role;

-- One row per call with everything any screen or report needs. A view, so company/date/portfolio
-- filters reach the indexes. security_invoker + service_role-only: nobody signed in can read it.
--
-- Team attribution matches disposition-store: the team owning the account's portfolio if the agent
-- is on it, else the agent's first team. A manager who dials is credited to their own team.
CREATE OR REPLACE VIEW public.call_audit_rows WITH (security_invoker = true) AS
SELECT
  ag.client_id,
  c.id AS call_id,
  c.created_at,
  c.agent_id,
  ag.name AS agent_name,
  ag.email AS agent_email,
  ag.agent_code,
  ag.agent_extension,
  c.call_type,
  c.dial_mode,
  c.outcome,
  c.outcome_reason,
  c.promise_amount,
  c.promise_date,
  c.promise_time,
  c.callback_date,
  c.callback_time,
  -- call_logs.duration_seconds has never been written; the ledger's is the call's billed length
  -- when the line connected. For an unanswered call the ledger's figure is ringing, not talk.
  COALESCE(c.duration_seconds, CASE WHEN led.status = 'completed' THEN led.duration_seconds END) AS duration_seconds,
  c.ring_seconds,
  c.wrap_seconds,
  c.raw_notes,
  c.ai_notes,
  c.recording_url,
  c.provider_call_id,
  c.dialed_phone,
  c.sentiment AS manager_sentiment,
  c.audited_at AS manager_audited_at,
  tag.name AS manager_audited_by,
  c.ai_transcript,
  c.ai_agent_tone,
  c.ai_debtor_tone,
  c.ai_sentiment,
  c.ai_sentiment_confidence,
  c.ai_sentiment_reasoning,
  c.ai_sentiment_analyzed_at,
  c.debtor_id,
  COALESCE(d.name, c.contact_name) AS customer_name,
  COALESCE(c.dialed_phone, d.phone_primary, c.contact_phone) AS customer_phone,
  d.phone_alternate,
  d.alt_phones,
  d.email AS customer_email,
  d.loan_reference,
  d.loan_amount,
  d.outstanding_balance,
  d.principal_amount,
  d.emi_amount,
  d.dpd,
  d.lender,
  d.product_type,
  d.product_code,
  d.status AS debtor_status,
  d.ai_score,
  d.extra,
  d.portfolio_id,
  pf.name AS portfolio_name,
  pf.lender_name AS portfolio_lender,
  pf.product_type AS portfolio_product,
  pf.uploaded_at AS portfolio_uploaded_at,
  tm.id AS team_id,
  tm.name AS team_name,
  tm.manager_id,
  mg.name AS manager_name,
  led.id AS ledger_id,
  led.provider AS ledger_provider,
  led.direction,
  led.status AS ledger_status,
  led.remote_phone,
  led.did_number,
  led.agent_handle,
  led.vendor_callid,
  led.started_at AS ledger_started_at,
  led.answered_at AS ledger_answered_at,
  led.ended_at AS ledger_ended_at,
  led.duration_seconds AS ledger_duration_seconds,
  led.recording_status,
  led.recording_error,
  a.id AS audit_id,
  a.auditor_id,
  aud.name AS auditor_name,
  a.scorecard_version,
  a.scores,
  a.score_earned,
  a.score_possible,
  a.raw_percent,
  a.final_percent,
  a.grade,
  a.fatal,
  a.fatal_codes,
  a.sentiment AS audit_sentiment,
  a.ai_agreement,
  a.ai_comment,
  a.exemplary,
  a.coaching_required,
  a.strengths,
  a.improvements,
  a.feedback_agent,
  a.feedback_manager,
  a.internal_note,
  a.agent_ack_at,
  a.agent_response,
  a.manager_seen_at,
  a.revision AS audit_revision,
  a.created_at AS audit_created_at,
  a.updated_at AS audit_updated_at
FROM public.call_logs c
JOIN public.agents ag ON ag.id = c.agent_id
LEFT JOIN public.agents tag ON tag.id = c.audited_by
LEFT JOIN public.debtors d ON d.id = c.debtor_id
LEFT JOIN public.portfolios pf ON pf.id = d.portfolio_id
LEFT JOIN LATERAL (
  SELECT t.id, t.name, t.manager_id
  FROM public.teams t
  WHERE t.client_id = ag.client_id
    AND (
      t.manager_id = c.agent_id
      OR t.id IN (SELECT ta.team_id FROM public.team_agents ta WHERE ta.agent_id = c.agent_id)
    )
  ORDER BY (t.id = pf.team_id) DESC NULLS LAST, t.created_at, t.id
  LIMIT 1
) tm ON TRUE
LEFT JOIN public.agents mg ON mg.id = tm.manager_id
LEFT JOIN LATERAL (
  SELECT l.*
  FROM public.telephony_calls l
  WHERE c.provider_call_id IS NOT NULL
    AND l.provider_call_id = c.provider_call_id
    AND l.client_id = ag.client_id
  ORDER BY l.started_at DESC
  LIMIT 1
) led ON TRUE
LEFT JOIN public.call_audits a ON a.call_log_id = c.id
LEFT JOIN public.agents aud ON aud.id = a.auditor_id;

REVOKE ALL ON public.call_audit_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.call_audit_rows TO service_role;

CREATE INDEX IF NOT EXISTS idx_telephony_calls_provider_call_id
  ON public.telephony_calls(provider_call_id);

-- One page of calls (and, on request, the total). `p` carries client_id, from, to and the
-- optional filters; the server action always sets client_id from the verified caller.
CREATE OR REPLACE FUNCTION public.call_audit_list(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit  INT := LEAST(GREATEST(COALESCE((p->>'limit')::INT, 100), 1), 1000);
  v_offset INT := GREATEST(COALESCE((p->>'offset')::INT, 0), 0);
  v_sort   TEXT := COALESCE(p->>'sort', 'newest');
  v_detail BOOLEAN := COALESCE((p->>'detail')::BOOLEAN, FALSE);
  v_order  TEXT;
  v_row    TEXT;
  v_where  TEXT;
  v_rows   JSONB;
  v_total  BIGINT;
BEGIN
  IF p->>'client_id' IS NULL OR p->>'from' IS NULL OR p->>'to' IS NULL THEN
    RAISE EXCEPTION 'call_audit_list needs client_id, from and to';
  END IF;

  -- Whitelisted: nothing from `p` is ever spliced into the statement.
  v_order := CASE v_sort
    WHEN 'oldest'     THEN 'created_at ASC'
    WHEN 'longest'    THEN 'duration_seconds DESC NULLS LAST, created_at DESC'
    WHEN 'score_high' THEN 'final_percent DESC NULLS LAST, created_at DESC'
    WHEN 'score_low'  THEN 'final_percent ASC NULLS LAST, created_at DESC'
    ELSE 'created_at DESC'
  END;
  v_row := CASE WHEN v_detail THEN 'to_jsonb(v)' ELSE $s$to_jsonb(v) - 'extra' - 'ai_transcript' - 'recording_error'$s$ END;

  v_where := $w$
    client_id = ($1->>'client_id')::UUID
    AND created_at >= ($1->>'from')::TIMESTAMPTZ
    AND created_at <  ($1->>'to')::TIMESTAMPTZ
    AND ($1->>'team_id' IS NULL OR team_id = ($1->>'team_id')::UUID)
    AND ($1->>'manager_id' IS NULL OR manager_id = ($1->>'manager_id')::UUID)
    AND ($1->>'agent_id' IS NULL OR agent_id = ($1->>'agent_id')::UUID)
    AND ($1->>'portfolio_id' IS NULL OR portfolio_id = ($1->>'portfolio_id')::UUID)
    AND ($1->>'outcome' IS NULL OR outcome = $1->>'outcome')
    AND ($1->>'min_seconds' IS NULL OR COALESCE(duration_seconds, 0) >= ($1->>'min_seconds')::INT)
    AND ($1->>'recording' IS NULL
         OR ($1->>'recording' = 'yes' AND recording_url IS NOT NULL)
         OR ($1->>'recording' = 'no' AND recording_url IS NULL))
    AND ($1->>'connected' IS NULL OR COALESCE(ledger_status = 'completed', outcome NOT IN ('no_answer', 'voicemail')))
    AND ($1->>'audit' IS NULL
         OR ($1->>'audit' = 'pending' AND audit_id IS NULL)
         OR ($1->>'audit' = 'ai_waiting' AND audit_id IS NULL AND ai_sentiment IS NOT NULL)
         OR ($1->>'audit' = 'audited' AND audit_id IS NOT NULL)
         OR ($1->>'audit' = 'fatal' AND fatal IS TRUE)
         OR ($1->>'audit' = 'exemplary' AND exemplary IS TRUE)
         OR ($1->>'audit' = 'coaching' AND coaching_required IS TRUE))
    AND ($1->>'search' IS NULL
         OR customer_name ILIKE '%' || ($1->>'search') || '%'
         OR customer_phone ILIKE '%' || ($1->>'search') || '%'
         OR loan_reference ILIKE '%' || ($1->>'search') || '%'
         OR agent_name ILIKE '%' || ($1->>'search') || '%')
  $w$;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(s.r ORDER BY s.n), ''[]''::jsonb) FROM (
       SELECT %s AS r, row_number() OVER (ORDER BY %s) AS n
       FROM (SELECT * FROM public.call_audit_rows WHERE %s ORDER BY %s LIMIT %s OFFSET %s) v
     ) s',
    v_row, v_order, v_where, v_order, v_limit, v_offset
  ) INTO v_rows USING p;

  IF COALESCE((p->>'with_total')::BOOLEAN, FALSE) THEN
    EXECUTE format('SELECT count(*) FROM public.call_audit_rows WHERE %s', v_where)
      INTO v_total USING p;
  END IF;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.call_audit_list(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_audit_list(JSONB) TO service_role;

-- Team-wise and agent-wise totals for the auditor's home page.
CREATE OR REPLACE FUNCTION public.call_audit_summary(p JSONB)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH base AS (
    SELECT
      team_id, team_name, manager_id, manager_name, agent_id, agent_name,
      COALESCE(duration_seconds, 0) AS secs,
      -- The line connected, per telephony; the disposition only for calls with no ledger row.
      COALESCE(ledger_status = 'completed', outcome NOT IN ('no_answer', 'voicemail')) AS connected,
      recording_url IS NOT NULL AS has_recording,
      ai_sentiment IS NOT NULL AS has_ai,
      audit_id IS NOT NULL AS audited,
      final_percent,
      fatal IS TRUE AS is_fatal,
      exemplary IS TRUE AS is_exemplary,
      coaching_required IS TRUE AS needs_coaching
    FROM public.call_audit_rows
    WHERE client_id = (p->>'client_id')::UUID
      AND created_at >= (p->>'from')::TIMESTAMPTZ
      AND created_at <  (p->>'to')::TIMESTAMPTZ
  )
  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'calls', count(*), 'connected', count(*) FILTER (WHERE connected),
        'talk_seconds', COALESCE(sum(secs), 0),
        'with_recording', count(*) FILTER (WHERE has_recording),
        'ai_done', count(*) FILTER (WHERE has_ai),
        'ai_waiting', count(*) FILTER (WHERE has_ai AND NOT audited),
        'audited', count(*) FILTER (WHERE audited),
        'avg_score', round(avg(final_percent), 1),
        'fatal', count(*) FILTER (WHERE is_fatal),
        'exemplary', count(*) FILTER (WHERE is_exemplary),
        'coaching', count(*) FILTER (WHERE needs_coaching)
      ) FROM base
    ),
    'teams', (
      SELECT COALESCE(jsonb_agg(t ORDER BY t.calls DESC), '[]'::jsonb) FROM (
        SELECT team_id, COALESCE(team_name, 'No team') AS team_name, manager_id, manager_name,
          count(*) AS calls, count(*) FILTER (WHERE connected) AS connected,
          COALESCE(sum(secs), 0) AS talk_seconds,
          count(DISTINCT agent_id) AS agents,
          count(*) FILTER (WHERE has_recording) AS with_recording,
          count(*) FILTER (WHERE audited) AS audited,
          round(avg(final_percent), 1) AS avg_score,
          count(*) FILTER (WHERE is_fatal) AS fatal,
          count(*) FILTER (WHERE needs_coaching) AS coaching
        FROM base GROUP BY team_id, team_name, manager_id, manager_name
      ) t
    ),
    'agents', (
      SELECT COALESCE(jsonb_agg(a ORDER BY a.avg_score DESC NULLS LAST, a.calls DESC), '[]'::jsonb) FROM (
        SELECT agent_id, agent_name, team_id, COALESCE(team_name, 'No team') AS team_name,
          count(*) AS calls, count(*) FILTER (WHERE connected) AS connected,
          COALESCE(sum(secs), 0) AS talk_seconds,
          count(*) FILTER (WHERE audited) AS audited,
          round(avg(final_percent), 1) AS avg_score,
          count(*) FILTER (WHERE is_fatal) AS fatal,
          count(*) FILTER (WHERE is_exemplary) AS exemplary
        FROM base GROUP BY agent_id, agent_name, team_id, team_name
      ) a
    )
  );
$$;
REVOKE ALL ON FUNCTION public.call_audit_summary(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_audit_summary(JSONB) TO service_role;
