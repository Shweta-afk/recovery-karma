-- ============================================================
-- SamvadX — account seed (5 users: 1 admin, 1 manager, 3 agents)
-- Run AFTER schema.sql, in Supabase → SQL Editor.
--
-- BEFORE running, create the 5 login users in
--   Supabase Dashboard → Authentication → Users → "Add user"
-- with these emails, then copy each user's UUID and paste it
-- into the matching <<<REPLACE_...>>> below.
--
-- Default demo password for all five: Axiotta@2026  (change later)
--   admin@axiotta.in     · Aditya Rao      · admin
--   manager@axiotta.in   · Sanjay Menon    · manager
--   agent1@axiotta.in    · Priya Nair      · agent
--   agent2@axiotta.in    · Ravi Kumar      · agent
--   agent3@axiotta.in    · Neha Shah       · agent
--
-- Portfolios & debtors are NOT seeded here — those are created by
-- the manager uploading a CSV in the app (Portfolio Upload).
-- ============================================================

SET LOCAL row_security = off;

-- ────────────────────────────────────────────────────────────
-- 1.  CLIENT (tenant)
-- ────────────────────────────────────────────────────────────
INSERT INTO clients (id, company_name, plan) VALUES
  ('a1000000-0000-0000-0000-000000000001',
   'Axiotta Risk Management Pvt Ltd',
   'growth')
ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 2.  ACCOUNTS  (1 admin · 1 manager · 3 agents)
--     Replace each auth_user_id with the real UUID from
--     Authentication → Users after you create that login.
-- ────────────────────────────────────────────────────────────
INSERT INTO agents (id, auth_user_id, client_id, name, email, role, daily_target) VALUES
  (
    'b1000000-0000-0000-0000-000000000000',
    '5376fc68-1035-424e-b3c1-1f734e25e2ad',
    'a1000000-0000-0000-0000-000000000001',
    'Aditya Rao', 'admin@axiotta.in', 'admin', 0
  ),
  (
    'b1000000-0000-0000-0000-000000000001',
    '07fe6b1f-24b4-46d0-a6dd-4a6ee8d77264',
    'a1000000-0000-0000-0000-000000000001',
    'Sanjay Menon', 'manager@axiotta.in', 'manager', 0
  ),
  (
    'b1000000-0000-0000-0000-000000000002',
    '2161e66d-851a-411c-9842-1fecd68c7931',
    'a1000000-0000-0000-0000-000000000001',
    'Priya Nair', 'agent1@axiotta.in', 'agent', 80
  ),
  (
    'b1000000-0000-0000-0000-000000000003',
    '43e86bee-a864-48d7-bb74-64536ec55ba4',
    'a1000000-0000-0000-0000-000000000001',
    'Ravi Kumar', 'agent2@axiotta.in', 'agent', 80
  ),
  (
    'b1000000-0000-0000-0000-000000000004',
    'e37f6e62-998d-4f5c-adfd-db744c7f1b7e',
    'a1000000-0000-0000-0000-000000000001',
    'Neha Shah', 'agent3@axiotta.in', 'agent', 80
  )
ON CONFLICT (id) DO UPDATE
  SET auth_user_id = EXCLUDED.auth_user_id,
      client_id    = EXCLUDED.client_id,
      name         = EXCLUDED.name,
      email        = EXCLUDED.email,
      role         = EXCLUDED.role,
      daily_target = EXCLUDED.daily_target;
