-- Per-company choice of which Insights (ProfileX) services a company may use.
--
-- Until now every company with Insights switched on saw every service in the catalogue. That
-- stops working as the catalogue grows unevenly in price — Skip Tracing V2 costs ₹15 a pull
-- against ₹1.42–₹6 for the others — and as different companies buy different packages. A
-- superadmin now picks the list per company on the company page; runProfilexTrace refuses
-- anything not in it, so hiding a button is backed by the server, not just the UI.
--
-- Semantics: the column is the ALLOW-LIST. An empty array means the company can run nothing,
-- even with `enabled` on. There is deliberately no "NULL means everything" mode: that would
-- quietly hand every existing tenant each new service the moment it is added to the catalogue.
--
-- Backfill: companies that already had a settings row keep exactly the six services they could
-- use before this change. Skip Tracing V2 is added to nobody — a superadmin opts each company in.
--
-- The backfill runs only when the column is being created. Migrations in this project have been
-- replayed on deploy before (see 20260821_rls_no_direct_table_reads.sql); an unconditional
-- UPDATE here would silently reset every superadmin's choices on each replay.
--
-- No BEGIN/COMMIT/ROLLBACK statements — the runner supplies the transaction. The DO block's own
-- BEGIN/END is plpgsql block syntax, not a transaction.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profilex_settings'
      AND column_name = 'enabled_services'
  ) THEN
    ALTER TABLE profilex_settings
      ADD COLUMN enabled_services TEXT[] NOT NULL DEFAULT '{}';

    UPDATE profilex_settings
      SET enabled_services = ARRAY[
        'mobile-to-uan',
        'employment-latest',
        'employment-history',
        'phone-to-prefill',
        'mobile-to-gst',
        'gst-to-contact'
      ];
  END IF;
END $$;
