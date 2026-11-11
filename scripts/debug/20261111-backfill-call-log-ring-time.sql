-- Fill call_logs.ring_seconds for past calls from the call ledger, by the rule in
-- src/lib/telephony/talk-time.ts (ringTiming): answer time known → dialled→answered; never
-- connected and dispositioned no_answer/voicemail → dialled→ended; anything else stays blank.
-- Only rows with ring_seconds NULL are touched. Undo: UPDATE call_logs SET ring_seconds = NULL
-- WHERE id IN (SELECT id FROM ops_backup.call_logs_ring_20261111);
CREATE SCHEMA IF NOT EXISTS ops_backup;
REVOKE ALL ON SCHEMA ops_backup FROM public, anon, authenticated;

CREATE TABLE ops_backup.call_logs_ring_20261111 AS
SELECT cl.id,
       round(extract(epoch FROM (coalesce(t.answered_at, t.ended_at) - t.started_at)))::int AS ring
FROM call_logs cl
JOIN telephony_calls t ON t.provider_call_id = cl.provider_call_id
WHERE cl.ring_seconds IS NULL
  AND t.started_at IS NOT NULL
  AND (
        t.answered_at IS NOT NULL
     OR (t.status IN ('no_answer','busy','failed','canceled')
         AND t.ended_at IS NOT NULL
         AND cl.outcome IN ('no_answer','voicemail'))
  )
  AND extract(epoch FROM (coalesce(t.answered_at, t.ended_at) - t.started_at)) BETWEEN 0 AND 600;

UPDATE call_logs cl SET ring_seconds = b.ring
FROM ops_backup.call_logs_ring_20261111 b
WHERE cl.id = b.id AND cl.ring_seconds IS NULL;
