-- Two more optional, mappable CSV fields for the upload wizard, same treatment as
-- principal_amount (migrations/20260905_debtors_principal_amount.sql): a real column, a
-- STD_FIELD in csv-fields.ts, and alias auto-detection in column-mapper.ts.
--
-- emi_amount: the borrower's monthly instalment. debtors already had an unused emiAmount field
-- on the client-side Debtor type (mock-debtors.ts) that nothing ever populated from real data —
-- this is what activates it.
--
-- product_code: a PER-DEBTOR product identifier from the bank's own file, distinct from the
-- portfolio-wide Product Type picker in the upload wizard (portfolios.product_type /
-- PRODUCT_LABEL_TO_ENUM), which applies one label to every row in the file. A book that mixes
-- products (e.g. several card variants in one credit-card file) can carry its own per-row code
-- here instead of losing that distinction under one portfolio-level label.
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS emi_amount NUMERIC;
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS product_code TEXT;
