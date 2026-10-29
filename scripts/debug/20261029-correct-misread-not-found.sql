-- One-off correction (2026-10-29): Insights lookups whose "not found" reply was misread and
-- charged at the FOUND price. Needs migrations/20261029_insights_charge_corrections.sql first.
--
-- Safe to run more than once: each corrected lookup gets a row in insights_charge_corrections
-- (unique per lookup) and is skipped next time, and only rows whose provider_status is still
-- not 1/2/3 are looked at. Run it again after the code fix is deployed to catch lookups made
-- in between. NOT a migration — a migration replay must never refund twice.
--
-- What it does, per misread lookup:
--   * re-reads the stored reply the way readProviderStatus (src/lib/profilex/billing.ts) does;
--   * a miss → provider_status '2', cost = the company's not-found price (its price list, else
--     SamvadX's — catalogue.ts priceFor), never MORE than was charged;
--   * a hit stored as "OK" → provider_status '1', cost unchanged;
--   * gives the difference back to the wallet that paid it:
--       borrower-tab lookup by a manager, from 2026-09-09 14:50 UTC (first manager charge) → that manager
--       borrower-tab lookup by an admin, from 2026-10-28 12:43 UTC (admin charging went live) → company wallet
--       typed-in lookup after the 2026-10-28 back-charge → company wallet
--       typed-in lookup covered by a back-charge that was "Fully deducted" → company wallet
--       anything else was never taken from a wallet → recorded as not_deducted, no money moves
--         (for Axiotta/Demo/Kuber/Kothule this lowers the amount still to bill by hand);
--   * gives SamvadX's ProfileX actual-balance tracker back the over-recorded ProfileX cost.
-- Prices below mirror SAMVADX_PRICES and defaultPrices (catalogue.ts) as of 2026-10-29, with
-- DIN to Contact at the ₹1.42 it was costed at when those lookups ran.

CREATE OR REPLACE FUNCTION pg_temp.has_data(j jsonb, top boolean) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE k text; v jsonb;
BEGIN
  IF j IS NULL OR j = 'null'::jsonb OR j = '""'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(j) LOOP
      IF pg_temp.has_data(v, false) THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  ELSIF jsonb_typeof(j) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
      IF top AND k = ANY (ARRAY['status','status_code','statusCode','message','success','request_id',
        'client_ref_num','http_response_code','result_code','txn_id','transactionId','timestamp',
        'date_time','verify_id','mobile_number']) THEN CONTINUE; END IF;
      IF pg_temp.has_data(v, false) THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- Same rules, same order, as readProviderStatus.
CREATE OR REPLACE FUNCTION pg_temp.read_status(r jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE d jsonb := r->'data'; code text; sub text; msg text;
BEGIN
  IF r IS NULL THEN RETURN NULL; END IF;
  code := CASE WHEN d ? 'status' AND d->'status' <> 'null'::jsonb THEN d->>'status' ELSE r->>'status' END;
  code := coalesce(code, '');
  IF code IN ('1','2','3') THEN RETURN code; END IF;
  sub := CASE WHEN d->'status_code' IS NULL OR d->'status_code' = 'null'::jsonb THEN '' ELSE d->>'status_code' END;
  IF sub <> '' THEN
    IF sub IN ('1','200') THEN RETURN '1'; END IF;
    IF sub ~ '^\d+$' THEN RETURN '2'; END IF;
  END IF;
  IF code = '201' THEN RETURN '2'; END IF;
  msg := coalesce(r->>'message','') || ' ' || coalesce(d->>'message','');
  IF msg ~* 'no\s+record|not\s+found|no\s+data|no\s+bureau' THEN RETURN '2'; END IF;
  IF d IS NOT NULL AND NOT pg_temp.has_data(d, true) THEN RETURN '2'; END IF;
  IF upper(code) = 'OK' AND d IS NOT NULL THEN RETURN '1'; END IF;
  RETURN nullif(code, '');
END $$;

-- priceFrom in catalogue.ts: the status's price; a known status left blank → "1"; else the max.
CREATE OR REPLACE FUNCTION pg_temp.price(prices jsonb, known jsonb, status text) RETURNS numeric
LANGUAGE sql AS $$
  SELECT CASE
    WHEN status IS NOT NULL AND prices ? status THEN (prices->>status)::numeric
    WHEN status IS NOT NULL AND known ? status AND prices ? '1' THEN (prices->>'1')::numeric
    ELSE (SELECT max(value::numeric) FROM jsonb_each_text(prices)) END
$$;

DROP TABLE IF EXISTS pg_temp.fix;
CREATE TEMP TABLE fix AS
WITH provider(p) AS (SELECT '{
  "skip-tracing":{"1":46}, "mobile-to-uan":{"1":3,"2":0}, "employment-latest":{"1":5,"2":1},
  "employment-history":{"1":5,"2":1,"3":1}, "employment-premium-mobile":{"1":2.25,"2":2.25},
  "employment-history-mobile":{"1":9,"2":9}, "phone-to-prefill":{"1":6,"2":5},
  "get-alternate-phone":{"1":6,"2":0}, "get-alternate-address":{"1":4},
  "mobile-to-multiple-upi":{"1":1.58,"2":1.58}, "mobile-to-lpg-advance":{"1":15,"2":15},
  "mobile-to-esic":{"1":9,"2":9}, "financial-behaviour":{"1":11.25,"2":11.25},
  "financial-behaviour-crif":{"1":11.25}, "mobile-to-gst":{"1":1.42,"2":1.42},
  "gst-to-contact":{"1":1.42,"2":1.42}, "din-to-contact":{"1":1.42}, "cibil-report":{"1":76.7}
}'::jsonb),
samvadx(s) AS (SELECT '{
  "skip-tracing":{"1":48}, "mobile-to-uan":{"1":5,"2":0}, "employment-latest":{"1":7,"2":1},
  "employment-history":{"1":7,"2":1,"3":1}, "employment-premium-mobile":{"1":4.25,"2":2.25},
  "employment-history-mobile":{"1":11,"2":9}, "phone-to-prefill":{"1":8,"2":5},
  "get-alternate-phone":{"1":8,"2":0}, "get-alternate-address":{"1":6},
  "mobile-to-multiple-upi":{"1":3.58,"2":1.58}, "mobile-to-lpg-advance":{"1":17,"2":15},
  "mobile-to-esic":{"1":11,"2":9}, "financial-behaviour":{"1":14,"2":11.25},
  "financial-behaviour-crif":{"1":14}, "mobile-to-gst":{"1":3.42,"2":1.42},
  "gst-to-contact":{"1":3.42}, "din-to-contact":{"1":4.98,"2":2.83}
}'::jsonb),
rows AS (
  SELECT 'borrower'::text AS source, t.id, t.client_id, t.service_id, t.created_at, t.provider_status,
         t.cost, t.response, t.requested_by AS run_by
    FROM debtor_traces t
   WHERE t.billable AND t.state = 'done' AND coalesce(t.provider_status, '') NOT IN ('1','2','3')
  UNION ALL
  SELECT 'typed', m.id, m.client_id, m.service_id, m.created_at, m.provider_status, m.cost,
         m.response, m.requested_by
    FROM insights_manual_lookups m
   WHERE m.state = 'done' AND coalesce(m.provider_status, '') NOT IN ('1','2','3')
),
read AS (
  SELECT r.*, pg_temp.read_status(r.response) AS new_status,
         nullif(s.rate_card->r.service_id, '{}'::jsonb) AS own,
         p.p->r.service_id AS prov, sx.s->r.service_id AS std
    FROM rows r
    LEFT JOIN profilex_settings s ON s.client_id = r.client_id
    CROSS JOIN provider p CROSS JOIN samvadx sx
)
SELECT read.*,
       CASE WHEN read.new_status = '2'
            THEN least(read.cost, pg_temp.price(coalesce(read.own, read.std, read.prov), read.prov, '2'))
            ELSE read.cost END AS new_cost,
       CASE WHEN read.created_at >= '2026-09-10 10:51:09+00' AND read.new_status = '2'
            THEN greatest(0, pg_temp.price(read.prov, read.prov, read.provider_status) - pg_temp.price(read.prov, read.prov, '2'))
            ELSE 0 END AS actual_over,
       a.role AS run_by_role,
       CASE
         WHEN read.source = 'borrower' AND a.role = 'manager' AND read.created_at >= '2026-09-09 14:50:21+00' THEN 'manager_wallet'
         WHEN read.source = 'borrower' AND a.role = 'admin' AND read.created_at >= '2026-10-28 12:43:29+00' THEN 'company_wallet'
         WHEN read.source = 'typed' AND read.created_at >= '2026-10-28 12:43:29+00' THEN 'company_wallet'
         WHEN read.source = 'typed' AND EXISTS (
           SELECT 1 FROM profilex_wallet_ledger l
            WHERE l.client_id = read.client_id AND l.scope = 'admin_charge'
              AND l.created_at < '2026-10-28 12:44:00+00' AND l.note ILIKE '%Fully deducted%') THEN 'company_wallet'
         ELSE 'not_deducted' END AS refunded_to
  FROM read
  LEFT JOIN agents a ON a.id = read.run_by
 WHERE new_status IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM insights_charge_corrections c WHERE c.source = read.source AND c.lookup_id = read.id);

DO $$
DECLARE r record;
BEGIN
  -- 1. Record every corrected miss.
  INSERT INTO insights_charge_corrections
    (client_id, source, lookup_id, service_id, lookup_at, old_status, new_status, old_cost, new_cost,
     refunded, refunded_to, manager_id, reason)
  SELECT client_id, source, id, service_id, created_at, provider_status, new_status, cost, new_cost,
         CASE WHEN refunded_to = 'not_deducted' THEN 0 ELSE cost - new_cost END, refunded_to,
         CASE WHEN refunded_to = 'manager_wallet' THEN run_by END,
         'Not-found reply was read as found and charged the found price; corrected to the not-found price.'
    FROM fix WHERE new_status = '2' AND new_cost < cost
  ON CONFLICT (source, lookup_id) DO NOTHING;

  -- 2. Managers' wallets.
  FOR r IN SELECT run_by, client_id, sum(cost - new_cost) amt, count(*) n, min(created_at) f, max(created_at) l
             FROM fix WHERE refunded_to = 'manager_wallet' AND new_status = '2' AND new_cost < cost
            GROUP BY 1, 2 LOOP
    UPDATE profilex_wallets SET balance = balance + r.amt, updated_at = now() WHERE manager_id = r.run_by;
    INSERT INTO profilex_wallet_ledger (scope, client_id, manager_id, amount, note, created_by)
    VALUES ('manager_refund', r.client_id, r.run_by, r.amt,
      format('Refund: %s not-found lookup(s) %s – %s were charged the found price. Corrected to the not-found price.',
             r.n, to_char(r.f AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY'), to_char(r.l AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY')),
      NULL);
  END LOOP;

  -- 3. Company wallets.
  FOR r IN SELECT client_id, sum(cost - new_cost) amt, count(*) n, min(created_at) f, max(created_at) l
             FROM fix WHERE refunded_to = 'company_wallet' AND new_status = '2' AND new_cost < cost
            GROUP BY 1 LOOP
    UPDATE profilex_company_wallets SET balance = balance + r.amt, updated_at = now() WHERE client_id = r.client_id;
    INSERT INTO profilex_wallet_ledger (scope, client_id, amount, note, created_by)
    VALUES ('company_refund', r.client_id, r.amt,
      format('Refund: %s admin not-found lookup(s) %s – %s were charged the found price. Corrected to the not-found price.',
             r.n, to_char(r.f AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY'), to_char(r.l AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY')),
      NULL);
  END LOOP;

  -- 4. SamvadX's ProfileX actual balance (recorded at the found cost for these misses).
  IF (SELECT coalesce(sum(actual_over), 0) FROM fix) > 0 THEN
    UPDATE profilex_actual_wallet SET balance = balance + (SELECT sum(actual_over) FROM fix), updated_at = now() WHERE id = 'main';
    INSERT INTO profilex_wallet_ledger (scope, client_id, amount, note, created_by)
    SELECT 'actual_refund', client_id, sum(actual_over),
           format('Correction: %s not-found lookup(s) had been costed at the found ProfileX price.', count(*)), NULL
      FROM fix WHERE actual_over > 0 GROUP BY client_id;
  END IF;

  -- 5. The lookups themselves, so every report and the company's Charges report agree.
  UPDATE debtor_traces t SET provider_status = f.new_status, cost = f.new_cost
    FROM fix f WHERE f.source = 'borrower' AND f.id = t.id;
  UPDATE insights_manual_lookups m SET provider_status = f.new_status, cost = f.new_cost
    FROM fix f WHERE f.source = 'typed' AND f.id = m.id;
END $$;

SELECT refunded_to, new_status, count(*) AS lookups, sum(cost) AS was_charged, sum(new_cost) AS now_charged,
       sum(cost - new_cost) AS difference, sum(actual_over) AS profilex_cost_corrected
  FROM fix GROUP BY 1, 2 ORDER BY 1, 2;
