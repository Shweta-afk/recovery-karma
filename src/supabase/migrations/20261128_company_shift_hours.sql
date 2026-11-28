-- Each company's working shift (user, 2026-11-28: admins set the shift and the break, and every
-- agent's time is counted from them). "HH:MM" IST; both NULL = the default 08:00–20:00. The fixed
-- break (fixed_break_start/_end, 20261128_company_fixed_break.sql) is set beside it.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS shift_start text,
  ADD COLUMN IF NOT EXISTS shift_end text;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_shift_format') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_shift_format CHECK (
      (shift_start IS NULL AND shift_end IS NULL)
      OR (shift_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND shift_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          AND shift_end > shift_start)
    );
  END IF;
END
$do$;
