-- Sellable report features, switched per company by a superadmin (user, 2026-11-28):
--   mis_reports   — Collection MIS pages (/admin/mis, /manager/mis)
--   report_emails — "Email a report", recipient lists, and scheduled MIS emails
-- Off unless a row says on. Turned on for Axiotta Technologies only (testing + live use).
-- Server-only: read through src/lib/company-features.server.ts (service role).

-- check:sql server-only: client_features
CREATE TABLE IF NOT EXISTS client_features (
  client_id     UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  mis_reports   BOOLEAN NOT NULL DEFAULT FALSE,
  report_emails BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by    UUID REFERENCES superadmins(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE client_features ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE client_features FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_features TO service_role;

INSERT INTO client_features (client_id, mis_reports, report_emails)
SELECT id, TRUE, TRUE FROM clients WHERE id = '0a3aedc6-4227-455c-8c89-6821194e2442'
ON CONFLICT (client_id) DO NOTHING;

-- Scheduled Collection MIS emails. An admin picks a recipient list, which sheets, a time (IST)
-- and weekdays; a once-a-minute server timer (report-schedule-runner.server.ts) sends what is
-- due. Only for companies with report_emails AND mis_reports on.

-- check:sql server-only: report_email_schedules
CREATE TABLE IF NOT EXISTS report_email_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  list_id      UUID NOT NULL REFERENCES report_email_lists(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- 'differences' | 'ranking' | 'zero' | 'daily' | 'client'
  sheets       TEXT[] NOT NULL,
  -- "HH:MM", IST
  send_time    TEXT NOT NULL CHECK (send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 0 = Sunday … 6 = Saturday, IST
  weekdays     INT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  -- which day the MIS is for: the day before sending, or the sending day so far
  report_day   TEXT NOT NULL DEFAULT 'yesterday' CHECK (report_day IN ('yesterday', 'today')),
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  -- IST day last sent; the timer claims a send by moving this forward, so it can't send twice
  last_sent_on DATE,
  last_result  TEXT,
  created_by   UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS report_email_schedules_client_idx ON report_email_schedules (client_id);

ALTER TABLE report_email_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE report_email_schedules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE report_email_schedules TO service_role;
