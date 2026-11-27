# SamvadX website screenshots

Mock screenshots of SamvadX for the marketing site. They are drawn from hand-made pages that copy
the app's real layout, colours, fonts and icons. **No real company, borrower or user data is
in them.** All names, loan IDs, amounts and emails are made up, and phone numbers are masked.
Lenders are fictional ("Sunrise Finance") and the company domain is `democollect.in`.

Every screen comes in two versions: `png/<name>-light.png` and `png/<name>-dark.png`
(2880×1800, retina 2×).

| File | Screen | Feature it shows |
|---|---|---|
| 01-login | Sign-in page | Each company's own sign-in, brand panel |
| 02-agent-dashboard | Agent dashboard | Collections target, shortfall, DRR, EOD projection, PTPs, callbacks due, daily call target |
| 03-call-queue | Agent call queue | Ranked queue, KPI cards, filters, DPD buckets, statuses, Productive / Progressive Dial |
| 04-live-call | On a call | Browser phone (timer, mute, hold, end), shared call history, disposition form (Paid / PTP / Settlement…), compliance check |
| 05-productive-dial | Productive Dial running | Several lines at once, ringing → connected to free agent, abandon rate, line usage |
| 06-borrower-profile | Borrower profile | Full timeline of calls, recordings, missed-PTP escalation, extra numbers from Insights |
| 07-insights | Insights tab | Skip tracing and other lookups, wallet, results as tables, match / differs vs bank file |
| 08-manager-dashboard | Manager dashboard | Team collections, target, team DRR, open/missed PTPs, daily chart, agent leaderboard |
| 09-live-calls | Live Calls monitoring | Who is on a call; Listen / Whisper / Barge |
| 10-portfolio-overview | Portfolio overview | Accounts, allocation, contact rate, DPD bucket progress, dial-mode mix, agent targets |
| 11-portfolio-upload | Portfolio upload | Bank file column mapping, saved templates, continuing last month's portfolio |
| 12-auditor-review | Call review (Auditor) | Recording player, AI transcript + tone (suggestion only), weighted scorecard, feedback |
| 13-auditor-overview | Auditor overview | Calls reviewed, average score, fatal errors, team scores, where points are lost |
| 14-reports | Reports | Collections vs last month, PTP kept rate, contact rate, company DRR, by portfolio, Excel |
| 15-feedback-file | Bank feedback file | Feedback by loan in the bank's layout, disposition codes, CC report, Excel download |
| 16-admin-users | Users | Roles (agent / manager / admin / auditor), seats, teams, security features |
| 17-activity-history | Call history | Every call, outcome, talk time, dial type, who hung up, recordings |
| 18-billing | Billing & Agreements | Invoices, wallet, e-signed agreement, change notices, data purging certificate |

## Rebuilding

The screens are the files in `pages/`. To change one, edit it, then run:

```bash
node build.mjs --shoot              # all screens
node build.mjs --shoot --only=reports
```

`build.mjs` adds the app's sidebar and header and takes the colour tokens straight from
`../src/styles.css`, so the images keep matching the app if its colours change. It needs
Google Chrome installed and an internet connection (it loads the fonts, Tailwind and the icons).
