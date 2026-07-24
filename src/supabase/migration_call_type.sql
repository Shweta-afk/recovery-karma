-- ============================================================
-- Widen call_logs.call_type for AI- and IVR-handled calls
-- Run this in Supabase SQL Editor
-- ============================================================
--
-- The telephony logic layer routes answered calls to an agent, an AI bot, or an IVR
-- menu (per the portfolio's call mode). call_logs.call_type originally only allowed
-- 'human' | 'bot'; add 'ai' and 'ivr' so a persisted disposition records who handled it.
-- 'bot' is kept for backward compatibility with existing rows.

ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_call_type_check;

ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_call_type_check
  CHECK (call_type IN ('human', 'bot', 'ai', 'ivr'));
