-- Call recordings imported from SkyCRM into SamvadX's own Storage (2026-11-05).
--
-- telephony_calls (server-only ledger) already knows each call's SkyCRM callid and recordfile path.
-- The importer (src/lib/telephony/recordings.server.ts) matches the callid to SkyCRM's CDR, fetches
-- the file via download_audio/, stores it in the private bucket "call-recordings" and writes a
-- marker "samvadx-recording:<telephony_calls.id>" into call_logs.recording_url. Playback goes
-- through a short-lived signed link handed only to someone who can see that call log.
--
-- No new table, no policy change: telephony_calls stays service-role only.

ALTER TABLE telephony_calls
  ADD COLUMN IF NOT EXISTS recording_object       TEXT,
  -- stored | none (not answered / no file at SkyCRM) | failed (gave up after retries)
  ADD COLUMN IF NOT EXISTS recording_status       TEXT,
  ADD COLUMN IF NOT EXISTS recording_attempts     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recording_checked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recording_error        TEXT,
  ADD COLUMN IF NOT EXISTS recording_bytes        INTEGER,
  ADD COLUMN IF NOT EXISTS recording_content_type TEXT;

-- What the importer scans: ended calls with a SkyCRM callid and no outcome yet.
CREATE INDEX IF NOT EXISTS telephony_calls_recording_todo_idx
  ON telephony_calls (ended_at)
  WHERE recording_status IS NULL AND vendor_callid IS NOT NULL AND ended_at IS NOT NULL;
