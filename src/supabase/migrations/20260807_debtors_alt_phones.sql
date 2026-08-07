-- Lets an agent record more than one alternative number for a debtor as they learn them
-- during calls (e.g. a family member's number, a new number the debtor gives). The existing
-- `phone_alternate` column is singular and was never actually written to anywhere in the app
-- (checked: no INSERT/UPDATE touches it) — this adds a proper multi-value column instead of
-- trying to repurpose that dead one.
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS alt_phones TEXT[] NOT NULL DEFAULT '{}';
