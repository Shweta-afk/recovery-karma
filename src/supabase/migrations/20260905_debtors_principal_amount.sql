-- A second amount field, distinct from loan_amount (labelled "Outstanding Amount" in the
-- upload wizard, and copied into outstanding_balance at write time — see the standing note in
-- CLAUDE.md that outstanding is really just a copy of that one uploaded figure). Some bank
-- files carry the original sanctioned/disbursed principal as a separate column from the current
-- balance; this captures it instead of losing it to "extra" or overwriting the outstanding
-- figure. Optional everywhere (mappable but not required at upload) since most files still only
-- have one amount column.
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS principal_amount NUMERIC;
