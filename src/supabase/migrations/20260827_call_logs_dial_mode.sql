-- How a call was placed, as distinct from who handled it.
--
-- `call_type` already records WHO took the call (human/ai/ivr/bot). It says nothing about
-- HOW the call was originated, so Activity History could only ever show one merged list and
-- there was no way to separate a manual call from a queue call at all.
--
-- Until now the only thing marking a manual call was `debtor_id IS NULL` — a side effect of
-- ad-hoc calls having no debtor to point at (see saveDisposition's isAdHoc branch). That
-- marker disappears the moment Manual Dial gains a Loan ID field and starts attaching calls
-- to real accounts, which is exactly what this column exists to replace.
--
-- ── On the value names ──────────────────────────────────────────────────────────────────
-- The dialer's UI labels and its internal enum are deliberately SWAPPED from each other:
-- the button reading "Productive Dial" is internally dialerMode 'predictive', and the button
-- reading "Progressive Dial" is internally 'productive'. (A rename commit changed only the
-- on-screen text; see the dial-mode note in CLAUDE.md.)
--
-- Storing either of those words here would bake that ambiguity into the database forever, so
-- these values describe the BEHAVIOUR instead and are mapped to display labels in exactly one
-- place in the app (DIAL_MODE_META in src/lib/call-queue/types.ts):
--
--   manual      -- agent dialled a number by hand from the Manual Dial dock
--   single      -- ordinary one-at-a-time click-to-call from the Call Queue
--   multi_line  -- several lines opened at once      (button labelled "Productive Dial")
--   sequential  -- one debtor at a time, in list order (button labelled "Progressive Dial")
--
-- NULL means the call predates this column. It is deliberately NOT backfilled to 'single':
-- manual calls are in that history too, and asserting a mode we cannot know would be a
-- fabrication. The UI shows those rows as "Before tracking".
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS dial_mode TEXT;

ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_dial_mode_check;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_dial_mode_check
  CHECK (dial_mode IS NULL OR dial_mode IN ('manual', 'single', 'multi_line', 'sequential'));

-- Activity History filters by mode within one agent's own calls, and the manual-call history
-- panel asks for "the most recent manual calls" directly.
CREATE INDEX IF NOT EXISTS idx_call_logs_dial_mode ON call_logs(dial_mode);

-- PostgREST caches the schema; without this the new column 404s for the next few minutes and
-- the app looks broken for no visible reason.
NOTIFY pgrst, 'reload schema';
