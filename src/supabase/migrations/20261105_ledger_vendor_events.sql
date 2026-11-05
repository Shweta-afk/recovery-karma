-- The vendor's own words for each live event on a call, in order ("event/status > event/status").
-- SkyCRM's live events have never mapped to "answered" (2026-11-05: 0 of 560 calls in 3 hours),
-- so the Live Calls board shows nearly every call as Ringing. This keeps what SkyCRM actually
-- sends, to find its "answered" word. telephony_calls stays server-only; no policy change.
ALTER TABLE telephony_calls ADD COLUMN IF NOT EXISTS vendor_events TEXT;
