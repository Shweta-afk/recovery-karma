-- Who ended each call, for "Disconnected By" on the reports (user, 2026-11-10). SkyCRM's events do
-- not say, so SamvadX records it: an End press = 'agent', an answered call that finished without
-- one = 'customer'. NULL = not recorded (every call before this).
ALTER TABLE public.telephony_calls ADD COLUMN IF NOT EXISTS ended_by TEXT
  CHECK (ended_by IS NULL OR ended_by IN ('agent', 'customer'));

-- The view from 20261109_call_auditor.sql, unchanged except for ended_by as a new last column.
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
  a.updated_at AS audit_updated_at,
  led.ended_by
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
