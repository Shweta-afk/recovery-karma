# Archive: monthly history + closed ("dead") accounts

Two jobs, one daily schedule:

1. **Monthly archive** — permanent copy of every Insights lookup, call log (notes + feedback),
   payment, message, dispute, settlement, account and portfolio, per company, per month (IST).
   Also the store that lets a re-uploaded borrower reuse an earlier paid lookup.
2. **Dead accounts** — 60 days after a portfolio is closed, each account with nothing still open
   on it is saved to a slim Excel file in Supabase Storage and then **stripped** (not deleted).

| Piece | Where |
|---|---|
| Monthly tables + `archive_month()` | `src/supabase/migrations/20260922_monthly_archive.sql` |
| Account versions in batches (`archive_debtor_versions()`) | `src/supabase/migrations/20260923_archive_debtor_versions_batched.sql`, `src/lib/archive-snapshot.server.ts` |
| `debtors.archived_at` + `dead_account_files` ledger | `src/supabase/migrations/20260923_dead_account_archive.sql` |
| Dead-account rules + sheet contents (pure, tested) | `src/lib/dead-accounts-shared.ts`, `scripts/dead-accounts.test.ts` |
| Dead-account job (Excel, upload, strip) | `src/lib/dead-account-archive.server.ts` |
| Daily schedule endpoint | `POST /api/cron/archive` — `src/lib/archive-cron.server.ts` |
| Lookup reuse | `findReusableTrace()` in `src/lib/profilex-actions.server.ts` |
| Admin UI | **Admin → Archive History** (`/admin/archive`) — monthly Excel, closed-account files, "Archive now" |

## One-time setup (production) — NOT done by a deploy

1. Apply both migrations (`20260922_monthly_archive.sql`, then `20260923_dead_account_archive.sql`).
2. Set `ARCHIVE_CRON_SECRET` in **Railway → Variables** to a long random string. Until it is set,
   `/api/cron/archive` answers 503 and nothing runs on a schedule (the admin button still works).
3. Store the same secret in Supabase Vault and create the schedule. Intentionally not a migration:
   this directory is replayed on deploy, and a schedule should be created deliberately, once.
   It calls the custom domain: both `*.up.railway.app` default domains return Railway's
   "Application not found" (checked 2026-09-23), so they cannot be used.

```sql
create extension if not exists pg_net;
create extension if not exists pg_cron;

select vault.create_secret('<same value as ARCHIVE_CRON_SECRET>', 'archive_cron_secret');

-- 20:30 UTC = 02:00 IST, daily.
select cron.schedule(
  'samvadx-daily-archive',
  '30 20 * * *',
  $$select net.http_post(
      url     := 'https://axiotta.samvadx.com/api/cron/archive',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                          where name = 'archive_cron_secret')),
      body    := '{}'::jsonb)$$
);
```

4. Back-fill history: sign in as an admin and press **Archive now** once. It walks every month
   from the company's oldest account to today, then archives any dead accounts. Safe to press
   again any time.

Check it ran: `select month, status, counts from monthly_archive_runs order by month desc;`,
`select * from dead_account_files order by created_at desc;`, the Railway logs (`[archive-cron]`),
and `select * from net._http_response order by created desc limit 5;` (expect 202).
Stop it: `select cron.unschedule('samvadx-daily-archive');`

## Each daily run

For each company, one call at a time: `archive_month(<yesterday's IST month>)` — on the 1st that
finalises the month that just ended, otherwise it refreshes the current month. **On the 1st only**,
it also saves every account's month-end version via `archive_debtor_versions()`, 1,000 accounts
per call. Then the dead-account job.

**Why batches (2026-09-23):** every API call to Postgres is cut off at **8s** (PostgREST's
`authenticator` statement timeout). The first scheduled run versioned all accounts in one
statement — 12.8s for a 14,061-account company — was cancelled, and rolled back with nothing
saved. Measured after the change: `archive_month` for all 8 companies 0.69s; 1,000 accounts 1.2s
on a first save, 0.14s when nothing changed. Keep any new archive work under that limit per call.
The endpoint answers 202 straight away and works in the background (pg_net stops waiting after
a few seconds).

## Monthly archive — how it behaves

- **Idempotent.** Re-running a month overwrites its rows; nothing duplicates.
- **Events** (lookups, calls, payments, messages, disputes, settlements) are filed under the IST
  month they happened in.
- **Accounts / portfolios / targets are versioned**: a row is written only when it differs from
  its newest saved version, and only for the current and previous month (so a back-fill never
  stamps today's state onto old months). Copying every account monthly would add hundreds of MB.
- **No foreign keys** to `debtors`, so history survives a portfolio being closed or deleted.
- **RLS:** admins read their own company only; nobody can write through the API.
  `archive_month()` is executable by `service_role` alone.

## Dead accounts — how it behaves

**Dead** = the portfolio has been closed (`closed_at`) for 60+ IST days **and** the account has
no open retention request (`pending_manager` / `approved` / `sent_to_bank`) **and** its latest
disposition is not a PTP/callback due within the last 60 days or later. A commitment with no date
counts as open. Accounts retained into a new cycle already belong to the new portfolio, so they
are never touched.

**The file** — bucket `dead-accounts` (private, created by the job on first use), path
`<client_id>/<portfolio_id>/<YYYY-MM-DD>_<portfolio-name>_<n>-accounts.xlsx`. Three sheets:
Accounts (name, loan ID, phone, alternate phones, last disposition, calls, lookups), Calls &
feedback (every call: date, agent, disposition, reason, notes, AI notes, promise, callback,
duration, sentiment, recording), Insights (every lookup: service, found/not found, date, cost,
all fields). Nothing else from the bank file. Listed in `dead_account_files`; admins download
through a 5-minute signed link after a server-side company check.

**The strip** — `extra = '{}'`, `email = null`, `archived_at = now()`. Name, phone, loan ID,
amounts, DPD and every link (call logs, payments, disputes, settlements, Insights) stay, so
Reports, Activity History and lookup reuse are unaffected.

**Order, so a failure never loses data:** safety snapshot (`archive_debtor_versions` for exactly the
accounts about to be stripped — full row, `extra` included) → build + upload file → ledger row →
strip. If the snapshot fails that portfolio is skipped; if the ledger insert fails the file is removed; a strip
that fails part-way resumes on the next run (`archived_at IS NULL`). A portfolio re-archived later
(e.g. accounts kept alive by a PTP that has since lapsed) gets a second, dated file.

**Undo a strip:** the full row, `extra` included, is in `monthly_archive_rows`
(`kind = 'debtor'`, `source_id = <debtor id>`, newest `month`).

## Lookup reuse

Before a paid lookup, `runProfilexTrace` looks for the same **phone number + service** in:
other debtor rows of the company (an earlier upload), then the archive. A result inside the
freshness window (`profilex_settings.hit_ttl_hours` for a found result, `miss_ttl_hours` for a
miss — 30 / 7 days by default) is copied onto the new debtor at ₹0 (`billable=false`,
`transaction_id = 'reused:<original id>'`) and counts as a cached reuse in the usage reports.
Stripped accounts keep their phone number and their `debtor_traces`, so they are still found.

- Copies are never themselves reused, so a result's age is always measured from the real purchase.
- Name-taking services (`mobile+name`) reuse only when the first name also matches.
- "Force refresh" still buys a fresh lookup.
- Not covered yet: chained services (UAN/GSTIN inputs) and the admin *manual* lookup page.
