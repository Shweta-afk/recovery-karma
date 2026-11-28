-- A company's fixed daily break (user, 2026-11-28: Axiotta's is 1:10–2:30 pm). Agents' time
-- reports cut it out of signed-in/idle time and show it on its own line, so nobody looks idle at
-- lunch. "HH:MM" IST; both NULL = the company has no fixed break. The values for Axiotta are set
-- by hand (UPDATE clients ...), not in this file, so replaying it never overwrites a change.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS fixed_break_start text,
  ADD COLUMN IF NOT EXISTS fixed_break_end text;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_fixed_break_format') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_fixed_break_format CHECK (
      (fixed_break_start IS NULL AND fixed_break_end IS NULL)
      OR (fixed_break_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND fixed_break_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND fixed_break_end > fixed_break_start)
    );
  END IF;
END
$do$;
