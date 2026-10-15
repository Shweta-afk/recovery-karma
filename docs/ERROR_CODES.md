# SamvadX error codes

**Internal — do not share with companies.** Companies see only a short sentence and a code,
e.g. _"Could not load your Insights wallet. (SX-1003)"_. This file says what each code really
means and where to look.

## How to look one up

1. A user reports a code → find it below.
2. The real cause (database message, provider response, missing setting) is in the **server
   log** with the code in front: Railway → `recoveryai-app` → Logs → search `[SX-1003]`.
3. **SX-9000** comes from the browser, not the server: some database or provider text reached
   a screen and was hidden. The original is in that user's browser console (search `[SX-9000]`).

## Rules for new errors

- Server: `throw appError("SX-xxxx", "Plain sentence.", detail)` from `src/lib/app-error.ts`.
  The sentence must not name a vendor, a setting, a table or an HTTP status. Pass the real
  cause as `detail` — it goes to the log only.
- Screens: `toast.error(errorText(e, "Could not save"))`, never `e.message`.
- Add the code here. `scripts/error-codes.test.ts` fails the build if a code is used twice or
  is missing from this file.
- Plain validation messages we wrote ("Enter a valid 10-digit mobile number") need no code.
- Superadmin-only screens and server files (`superadmin-actions.server.ts`,
  `platform-usage.server.ts`, `revenue-report.server.ts`, the billing/contracts superadmin
  panels) still show full detail — only Axiotta sees them.

## Codes

Ranges: 1xxx Insights · 2xxx CIBIL · 3xxx calling + call analysis · 4xxx invoices, billing,
contracts · 5xxx company, users, sign-up · 6xxx archive · 9xxx general.

### Insights (1xxx) — `src/lib/profilex-actions.server.ts` unless noted

| Code    | User sees                                      | What it really means                                                                                                                   |
| ------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| SX-1001 | Could not load the debtor.                     | Database error reading the debtor row before a lookup.                                                                                 |
| SX-1002 | Could not check your Insights wallet.          | Database error reading the manager's wallet balance.                                                                                   |
| SX-1003 | Could not load your Insights wallet.           | Database error reading the caller's wallet.                                                                                            |
| SX-1004 | Could not load managers.                       | Database error listing managers for the wallets card.                                                                                  |
| SX-1005 | Could not load wallets.                        | Database error listing manager wallets.                                                                                                |
| SX-1006 | Could not load your company's Insights budget. | Database error reading `profilex_settings` budget.                                                                                     |
| SX-1007 | Could not verify that manager.                 | Database error checking the manager being topped up.                                                                                   |
| SX-1008 | Could not update the wallet.                   | Wallet top-up RPC failed.                                                                                                              |
| SX-1009 | Could not load Insights usage.                 | Usage RPC failed.                                                                                                                      |
| SX-1010 | Could not load Insights detail log.            | Detail-log query failed.                                                                                                               |
| SX-1011 | Could not load portfolios.                     | Portfolio list for the Loan ID report failed.                                                                                          |
| SX-1012 | Could not load lookup data.                    | Reading traces for the Loan ID report failed.                                                                                          |
| SX-1013 | Could not check the portfolio.                 | Portfolio check for an Excel request failed.                                                                                           |
| SX-1014 | Could not send the request.                    | Inserting an Excel export request failed.                                                                                              |
| SX-1015 | Could not load lookups.                        | Reading manual lookups (Admin → Insights) failed.                                                                                      |
| SX-1016 | This lookup could not be started.              | `profilex_wallet_hold` RPC errored (not "not enough money" — that has its own plain message).                                          |
| SX-1017 | Could not load the Insights outcome report.    | `insights_outcome_report` RPC failed. If the log names the function, `migrations/20260927_insights_outcome_report.sql` is not applied. |
| SX-1018 | Could not send the request.                    | `insight-request-store.ts`: inserting an Insights request failed (browser-side; detail in browser console).                            |
| SX-1019 | Could not update the request.                  | `insight-request-store.ts`: updating an Insights request failed (browser-side).                                                        |
| SX-1901 | This page is not available right now.          | `SUPABASE_URL` / `SUPABASE_ANON_KEY` missing on the server (caller-scoped read).                                                       |
| SX-1902 | Insights is not set up yet.                    | `PROFILEX_CLIENT_HASH_ID` / `PROFILEX_SECRET_KEY` / `PROFILEX_ACCESS_KEY` missing on Railway.                                          |
| SX-1903 | "<service>" is not available right now.        | ProfileX said "You Dont Have UAT Access" — service not enabled on our Neokred account, or wrong client hash id. Not charged.           |
| SX-1904 | This lookup could not be completed.            | ProfileX returned non-200 (status + message in the log). Not charged.                                                                  |
| SX-1905 | "<service>" is not available right now.        | Same as SX-1903, for an admin manual lookup.                                                                                           |
| SX-1906 | This lookup could not be completed.            | Same as SX-1904, for an admin manual lookup.                                                                                           |

### CIBIL (2xxx) — `src/lib/cibil-actions.server.ts`

| Code    | User sees                                             | What it really means                                                                                              |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SX-2001 | Could not load the borrower.                          | Database error reading the debtor.                                                                                |
| SX-2002 | Could not load the report.                            | Database error reading `cibil_reports`.                                                                           |
| SX-2003 | The report was generated (reference …) but not saved. | PayPrime charged and returned a report but the insert into `cibil_reports` failed. Reference = PayPrime `txn_id`. |
| SX-2101 | No credit report was found for these details…         | PayPrime "No Record Found" / code 2 or 7. Usually charged.                                                        |
| SX-2102 | Fill in the <field> and try again.                    | PayPrime validation ("The region field is required."). Not charged.                                               |
| SX-2103 | More of the person's details are needed…              | PayPrime "bad parameter".                                                                                         |
| SX-2104 | CIBIL reports are not available right now.            | PayPrime 401/403 or IP not allowed — check the allow-list (Developer Setting → Api Token) for Railway's IPs.      |
| SX-2105 | No report was returned.                               | Any other PayPrime failure; the provider message is in the log.                                                   |
| SX-2106 | Could not get the report right now…                   | PayPrime could not be reached at all (network/timeout). Not charged.                                              |
| SX-2901 | This report is not available right now.               | `SUPABASE_URL` / `SUPABASE_ANON_KEY` missing on the server.                                                       |
| SX-2902 | CIBIL reports are not set up yet.                     | `PAYPRIME_API_TOKEN` missing on Railway.                                                                          |

### Calling and call analysis (3xxx)

| Code    | User sees                            | What it really means                                                                                    |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| SX-3001 | Calling is not set up yet.           | `SKYCRM_SECRET` / `SKYCRM_USER` / `SKYCRM_PASS` missing (the log lists which). `skycrm-provider.ts`     |
| SX-3002 | Calling is not set up yet.           | `TELEPHONY_PROVIDER` on Railway is not a known value (e.g. stale `tata`/`exotel`). `telephony/index.ts` |
| SX-3101 | Calling is not available right now.  | SkyCRM rejected our token (status 401).                                                                 |
| SX-3102 | Could not reach the calling service. | Network error reaching SkyCRM.                                                                          |
| SX-3103 | The calling service had a problem.   | SkyCRM returned non-JSON (usually their 500 HTML page).                                                 |
| SX-3104 | The call could not be placed.        | SkyCRM returned status ≥ 300; their message is in the log.                                              |
| SX-3105 | SMS is not available yet.            | SkyCRM has no SMS endpoint.                                                                             |
| SX-3201 | Could not transcribe this recording. | Groq Whisper returned an error. `call-sentiment-actions.server.ts`                                      |
| SX-3202 | Could not analyse this call.         | Gemini returned an error.                                                                               |
| SX-3203 | Could not analyse this call.         | Gemini returned an empty answer.                                                                        |
| SX-3204 | Call analysis is busy right now.     | Gemini kept failing (rate limit) after all retries.                                                     |

### Invoices, billing, contracts (4xxx)

All are database errors on the action named; the database message is in the log.

| Code    | User sees                                      | File                        |
| ------- | ---------------------------------------------- | --------------------------- |
| SX-4101 | Could not load billing details.                | `invoice-actions.server.ts` |
| SX-4102 | Could not save billing details.                | `invoice-actions.server.ts` |
| SX-4103 | Could not load billing details.                | `invoice-actions.server.ts` |
| SX-4104 | Could not load invoices.                       | `invoice-actions.server.ts` |
| SX-4105 | Could not load top-ups.                        | `invoice-actions.server.ts` |
| SX-4106 | Could not save billing details.                | `invoice-actions.server.ts` |
| SX-4107 | Could not load the company's billing details.  | `invoice-actions.server.ts` |
| SX-4108 | Could not load that top-up.                    | `invoice-actions.server.ts` |
| SX-4109 | Could not create the invoice.                  | `invoice-actions.server.ts` |
| SX-4110 | Could not update the invoice.                  | `invoice-actions.server.ts` |
| SX-4111 | Could not load invoices.                       | `invoice-actions.server.ts` |
| SX-4201 | Could not save the price list.                 | `billing-actions.server.ts` |
| SX-4202 | Could not load payments.                       | `billing-actions.server.ts` |
| SX-4203 | Could not load credit notes.                   | `billing-actions.server.ts` |
| SX-4204 | Could not update the invoice status.           | `billing-actions.server.ts` |
| SX-4205 | Could not record the payment.                  | `billing-actions.server.ts` |
| SX-4206 | Could not remove the payment.                  | `billing-actions.server.ts` |
| SX-4207 | Could not issue the credit note.               | `billing-actions.server.ts` |
| SX-4301 | Could not create the contracts storage bucket. | `contracts.server.ts`       |
| SX-4302 | Could not load company admins.                 | `contracts.server.ts`       |
| SX-4303 | Could not load contracts.                      | `contracts.server.ts`       |
| SX-4304 | Could not start the upload.                    | `contracts.server.ts`       |
| SX-4305 | Could not save the contract.                   | `contracts.server.ts`       |
| SX-4306 | Could not publish the change.                  | `contracts.server.ts`       |
| SX-4307 | Could not withdraw the change.                 | `contracts.server.ts`       |
| SX-4308 | Could not load contracts.                      | `contracts.server.ts`       |
| SX-4309 | Could not record your acceptance.              | `contracts.server.ts`       |
| SX-4310 | Could not open the file.                       | `contracts.server.ts`       |
| SX-4311 | Could not save the draft.                      | `contracts.server.ts`       |
| SX-4312 | Could not publish the draft.                   | `contracts.server.ts`       |
| SX-4313 | Could not discard the draft.                   | `contracts.server.ts`       |
| SX-4314 | Could not save the template.                   | `contracts.server.ts`       |
| SX-4315 | Could not save the document.                   | `contracts.server.ts`       |
| SX-4316 | Could not publish the agreement.               | `contracts.server.ts`       |
| SX-4317 | Could not record the send.                     | `contracts.server.ts`       |
| SX-4318 | Could not record your signature.               | `contracts.server.ts`       |
| SX-4401 | Could not load invoices.                       | `company-billing.server.ts` |

### Company, users, sign-up (5xxx)

| Code    | User sees                          | What it really means                                                           |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| SX-5101 | Could not load company details.    | Database error reading `client_billing`. `company-details.server.ts`           |
| SX-5102 | Could not save company details.    | Database error writing `client_billing`.                                       |
| SX-5201 | Could not verify seat limits.      | Reading the company's seat caps failed. `user-admin-actions.server.ts`         |
| SX-5202 | Could not verify seat limits.      | Counting existing users failed.                                                |
| SX-5203 | Could not create the login.        | Supabase Auth `createUser` failed (not "already registered").                  |
| SX-5204 | Could not create the user.         | Inserting the `agents` row failed; the new login was rolled back.              |
| SX-5205 | Could not check that manager.      | Reading the chosen manager failed.                                             |
| SX-5206 | Could not load the manager's team. | Reading `teams` failed.                                                        |
| SX-5207 | Could not create the team.         | Inserting into `teams` failed.                                                 |
| SX-5208 | Could not add them to the team.    | Upsert into `team_agents` failed.                                              |
| SX-5209 | Could not reset the password.      | Supabase Auth `updateUserById` failed.                                         |
| SX-5210 | Could not create the login.        | Password reset for a user with no login: `createUser` failed.                  |
| SX-5211 | Could not link the login.          | Writing `auth_user_id` to `agents` failed; the new login was rolled back.      |
| SX-5301 | Could not set your password.       | Sign-up: Supabase Auth `updateUserById` failed. `setup-actions.server.ts`      |
| SX-5302 | Could not create the company.      | Sign-up: inserting into `clients` failed.                                      |
| SX-5303 | Could not create your account.     | Sign-up: inserting the admin `agents` row failed; the company was rolled back. |

### Archive (6xxx)

| Code    | User sees                                                          | What it really means                                                                        |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| SX-6101 | Could not read accounts for the archive.                           | Dead-account archive: reading `debtors` failed. `dead-account-archive.server.ts`            |
| SX-6102 | Could not save the archive file.                                   | Upload to the `dead-accounts` Storage bucket failed.                                        |
| SX-6103 | Could not record the archive file.                                 | Insert into `dead_account_files` failed.                                                    |
| SX-6104 | The archive file was saved, but the accounts could not be cleared. | Stripping `extra`/`email` failed after the Excel was saved — the file path is in the log.   |
| SX-6105 | Could not load portfolios for the archive.                         | Reading closed portfolios failed.                                                           |
| SX-6106 | Could not load companies for the archive.                          | Cron run: reading `clients` failed.                                                         |
| SX-6107 | Could not load that file.                                          | Reading `dead_account_files` for a download failed.                                         |
| SX-6108 | Could not create a download link.                                  | Signed Storage URL failed.                                                                  |
| SX-6201 | Could not save this month's archive.                               | `archive_month` RPC failed. `archive-snapshot.server.ts`                                    |
| SX-6202 | Could not read accounts for the archive.                           | Paging debtor ids failed.                                                                   |
| SX-6203 | Could not save account history for the archive.                    | `archive_debtor_versions` RPC failed.                                                       |
| SX-6301 | Could not archive <month>.                                         | Admin "Archive now": `archive_month` RPC failed for that month. `archive-actions.server.ts` |

### General (9xxx)

| Code    | User sees                                  | What it really means                                                                                                                                                        |
| ------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SX-9000 | <what failed>. Please try again (SX-9000). | Browser-side: the error text named a table, vendor, setting, HTTP code or came straight from the database, so it was hidden. The original is in the user's browser console. |
