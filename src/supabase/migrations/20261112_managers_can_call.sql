-- Per-company switch: may this company's MANAGERS place calls themselves (their own assigned
-- accounts, Manual Dial, any team account)? Off by default — a superadmin turns it on per
-- company (Superadmin → company → Calling card). Enforced on the server before every dial
-- (telephony/manager-calling.server.ts). User, 2026-11-12; switched on for Axiotta by hand.
ALTER TABLE telephony_settings ADD COLUMN IF NOT EXISTS managers_can_call boolean NOT NULL DEFAULT false;
