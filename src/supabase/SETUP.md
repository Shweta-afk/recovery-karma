# Axiora — Account & Data Setup

The app is fully Supabase-backed — accounts, teams, portfolios/debtors, call outcomes,
notifications, escalations, reminders and CSV column-mapping templates all live in Postgres,
not browser localStorage. There is no mock data — an agent only sees the accounts a manager
assigns to them, and any of it is visible from any browser/device once logged in.

## The 5 accounts (default credentials — change later)

| Role    | Name         | Email              | Password     |
| ------- | ------------ | ------------------ | ------------ |
| Admin   | Aditya Rao   | admin@axiotta.in   | Axiotta@2026 |
| Manager | Sanjay Menon | manager@axiotta.in | Axiotta@2026 |
| Agent   | Priya Nair   | agent1@axiotta.in  | Axiotta@2026 |
| Agent   | Ravi Kumar   | agent2@axiotta.in  | Axiotta@2026 |
| Agent   | Neha Shah    | agent3@axiotta.in  | Axiotta@2026 |

The agent emails are also the operational identity used to match uploaded/assigned data.
The agent/manager roster and teams are both read live from Supabase (see `useRoster()` and
`useTeams()` in `src/lib/team-store.ts`) — no separate list to keep in sync, and no team
exists until one is created via Teams.

## One-time setup

1. **Schema** — Supabase → SQL Editor → run `schema.sql` (skip if already applied).
2. **Realtime-sync migration** — run `migration_realtime_sync.sql` (adds `teams`,
   `team_agents`, `notifications`, `escalations`, `reminders`, `mapping_templates`, and
   extends `portfolios`/`debtors`/`call_logs` with the columns the app needs). Safe to re-run.
3. **Create the 5 logins** — Authentication → Users → _Add user_ (email + confirm) for each of
   the 5 emails above, using password `Axiotta@2026`. Enable "Auto Confirm".
4. **Copy each UUID** — click each new user, copy its **User UID**.
5. **Seed the accounts** — open `seed.sql`, replace the five `<<<REPLACE_*_UUID>>>` placeholders
   with the matching UUIDs, then run it in the SQL Editor.
6. **Env** — confirm `.env.local` has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Daily flow

1. Log in as **admin@axiotta.in** → **Admin → Teams** → create a team, assign a manager and
   agents.
2. Log in as **manager@axiotta.in** → lands on Manager.
3. **Portfolio Upload** → drop your bank CSV → map columns (auto-mapped) → set call mode →
   assign to your team's agents → upload — one linear wizard, all persisted to Supabase.
4. Log in as **agent1/2/3@axiotta.in** → Call Queue & Debtors show **only** that agent's
   assigned accounts, from any browser or device.
