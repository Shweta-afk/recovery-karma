-- Distinguishes a payment an agent actually collected from one the bank simply reported paid
-- via a bulk file the lender sends daily (manager upload — see applyBulkPaidFile() in
-- portfolio-store.ts). Bank-reported payments are inserted with agent_id NULL and this column
-- set to 'bank_reported' specifically so they never look like — or get credited as — an
-- agent's own collection: every agent performance number in this app (Team Activity, dashboard
-- KPIs, Call Audit) is computed from call_logs, not payments, and this flow never touches
-- call_logs at all, but the payments list itself still needed a way to show "the bank marked
-- this paid, not an agent" instead of silently looking identical to a real collection call.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent'
  CHECK (source IN ('agent', 'bank_reported'));
