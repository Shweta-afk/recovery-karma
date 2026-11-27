-- Emailing reports to a company's own staff (user, 2026-11-27). An admin keeps named recipient
-- lists; admins, managers and auditors email any report file to one list from the Reports pages.
-- Internal recipients only — never borrowers. Both tables server-only: read and written only from
-- src/lib/report-email.server.ts (service role, after verifyCaller, scoped to the caller's company).

-- check:sql server-only: report_email_lists
CREATE TABLE IF NOT EXISTS report_email_lists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  emails      TEXT[] NOT NULL DEFAULT '{}',
  created_by  UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, name)
);

ALTER TABLE report_email_lists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE report_email_lists FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE report_email_lists TO service_role;

-- check:sql server-only: report_email_log
CREATE TABLE IF NOT EXISTS report_email_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  list_id      UUID REFERENCES report_email_lists(id) ON DELETE SET NULL,
  list_name    TEXT NOT NULL,
  sent_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
  sent_by_name TEXT,
  report_name  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  recipients   TEXT[] NOT NULL,
  sent_count   INT NOT NULL DEFAULT 0,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS report_email_log_client_idx ON report_email_log (client_id, created_at DESC);

ALTER TABLE report_email_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE report_email_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE report_email_log TO service_role;
