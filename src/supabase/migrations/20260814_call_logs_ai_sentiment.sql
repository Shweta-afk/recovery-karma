-- AI-suggested call sentiment — separate from the manual `sentiment` QA tag added in
-- 20260811_call_logs_sentiment.sql. A manager triggers this on-demand (not automatically on
-- every call) from Call Audit; it transcribes the recording (Groq Whisper) and classifies tone
-- (Gemini) using the SAME happy/neutral/frustrated/rude vocabulary as the manual tag, so the
-- two are directly comparable. The manual `sentiment`/`audited_by`/`audited_at` fields are left
-- untouched — this is a suggestion the manager can agree or disagree with, not a replacement.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_transcript TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_agent_tone TEXT
  CHECK (ai_agent_tone IN ('happy', 'neutral', 'frustrated', 'rude'));
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_debtor_tone TEXT
  CHECK (ai_debtor_tone IN ('happy', 'neutral', 'frustrated', 'rude'));
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_sentiment TEXT
  CHECK (ai_sentiment IN ('happy', 'neutral', 'frustrated', 'rude'));
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_sentiment_confidence NUMERIC;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_sentiment_reasoning TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ai_sentiment_analyzed_at TIMESTAMPTZ;

-- No new RLS policy needed: this is written via the service-role client (see
-- call-sentiment-actions.server.ts, same pattern as user-admin-actions.server.ts), which
-- bypasses RLS after verifying the caller is a manager/admin server-side. Reads are already
-- covered by the existing call_logs_select policy — RLS is row-scoped, not column-scoped, so
-- no policy change is needed for managers/agents to read these new columns back.
