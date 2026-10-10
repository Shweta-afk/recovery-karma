-- A saved copy of each CIBIL report page, captured from PayPrime's htmlUrl when the report is
-- pulled (those links may expire). Served as a file download by downloadCibilReport
-- (src/lib/cibil-actions.server.ts). NULL = not captured; the download then builds a report from
-- the structured data instead. cibil_reports stays server-only. Idempotent.
ALTER TABLE cibil_reports ADD COLUMN IF NOT EXISTS report_html TEXT;
