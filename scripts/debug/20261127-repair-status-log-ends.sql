-- Repair agent_status_log end times (run by hand 2026-11-27, user's go-ahead).
-- On 2026-11-25 rows left open since September were closed with "now" as their end, so each one
-- counted as weeks of logged-in time and Idle came out huge. 3,563 rows, 744,960 h → ~1,348 h.
-- New end for a row:
--   with a heartbeat  → its last heartbeat (when it ended more than 3 min after it);
--   without one       → earliest of: the agent's next status row, 8 pm IST that day, its recorded
--                       end — but not before the agent's last call in that stretch; never before
--                       it started. Only rows over 30 min long are touched.
-- Original values are kept in agent_status_log_end_backup_20261127. Undo:
--   UPDATE agent_status_log s SET ended_at = b.old_ended_at
--   FROM agent_status_log_end_backup_20261127 b WHERE b.id = s.id;

CREATE TABLE IF NOT EXISTS agent_status_log_end_backup_20261127 (
  id           UUID PRIMARY KEY,
  old_ended_at TIMESTAMPTZ,
  new_ended_at TIMESTAMPTZ
);
ALTER TABLE agent_status_log_end_backup_20261127 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agent_status_log_end_backup_20261127 FROM PUBLIC, anon, authenticated;

WITH s AS (
  SELECT s.*,
    lead(s.started_at) OVER (PARTITION BY s.agent_id ORDER BY s.started_at, s.id) AS next_start,
    ((s.started_at AT TIME ZONE 'Asia/Kolkata')::date + time '20:00') AT TIME ZONE 'Asia/Kolkata' AS day_end
  FROM agent_status_log s
),
fix AS (
  SELECT s.id, s.ended_at,
    CASE WHEN s.last_seen_at IS NOT NULL THEN s.last_seen_at
    ELSE greatest(s.started_at, least(
      coalesce(s.next_start, s.ended_at), s.day_end, s.ended_at,
      coalesce((SELECT max(coalesce(t.ended_at, t.started_at)) FROM telephony_calls t
         WHERE t.agent_id = s.agent_id AND t.started_at >= s.started_at
           AND t.started_at < least(coalesce(s.next_start, s.day_end), s.day_end)), s.started_at)
    )) END AS new_end
  FROM s
  WHERE s.ended_at IS NOT NULL
    AND (CASE WHEN s.last_seen_at IS NOT NULL THEN s.ended_at > s.last_seen_at + interval '3 minutes'
         ELSE s.ended_at - s.started_at > interval '30 minutes' END)
)
INSERT INTO agent_status_log_end_backup_20261127 (id, old_ended_at, new_ended_at)
SELECT id, ended_at, new_end FROM fix
ON CONFLICT (id) DO NOTHING;

UPDATE agent_status_log s
SET ended_at = b.new_ended_at
FROM agent_status_log_end_backup_20261127 b
WHERE b.id = s.id AND s.ended_at = b.old_ended_at;
