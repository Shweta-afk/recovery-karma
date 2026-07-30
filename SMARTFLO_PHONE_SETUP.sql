-- SmartFlo Phone Number Assignment for Testing
-- Assign 5 phone numbers to each agent from your SmartFlo pool

-- Available SmartFlo numbers (from your dashboard):
-- 91796581560, 91796581601, 91796581606, 91796581614, 91796581618
-- 91796581626, 91796581699, 91796581723, 91796581743, 91796581778
-- 91796581787, 91796581816, 91796581819, 91796581822, 91796581832
-- 91796581856, 91796581860, 91796581930, 91796581959, 91796581987
-- ... and many more

-- UPDATE: Assign first 5 numbers to first agent
UPDATE agents
SET agent_phone = '91796581560'
WHERE id IN (SELECT id FROM agents ORDER BY created_at LIMIT 1);

-- UPDATE: Assign next 5 numbers to remaining agents
-- This script assigns 1 phone per agent for now
-- To assign MULTIPLE phones per agent, you'll need a separate phone_numbers table

-- Alternative: Create a new table for agent phone pool
CREATE TABLE IF NOT EXISTS agent_phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp DEFAULT now(),
  CONSTRAINT unique_agent_phone UNIQUE(agent_id, phone_number)
);

-- Enable RLS on phone numbers table
ALTER TABLE agent_phone_numbers ENABLE ROW LEVEL SECURITY;

-- RLS Policy: agents can see their own phone numbers
CREATE POLICY "agents_can_view_own_phones" ON agent_phone_numbers
  FOR SELECT USING (
    agent_id IN (
      SELECT id FROM agents WHERE auth_user_id = auth.uid()
    )
  );

-- RLS Policy: only admins can manage phone numbers
CREATE POLICY "admins_can_manage_phones" ON agent_phone_numbers
  FOR ALL USING (
    auth.uid() IN (
      SELECT auth_user_id FROM agents WHERE role = 'admin'
    )
  );

-- Seed: Insert 5 SmartFlo numbers for each agent
-- Run this after checking which agents you have with:
-- SELECT id, name FROM agents;
-- Then uncomment and update the UUIDs below

/*
-- Example: Assign to agent with id = 'agent-uuid-here'
INSERT INTO agent_phone_numbers (agent_id, phone_number) VALUES
  ('agent-uuid-1', '91796581560'),
  ('agent-uuid-1', '91796581601'),
  ('agent-uuid-1', '91796581606'),
  ('agent-uuid-1', '91796581614'),
  ('agent-uuid-1', '91796581618'),
  ('agent-uuid-2', '91796581626'),
  ('agent-uuid-2', '91796581699'),
  ('agent-uuid-2', '91796581723'),
  ('agent-uuid-2', '91796581743'),
  ('agent-uuid-2', '91796581778');
*/

-- Query to see all agents and their assigned phones
SELECT
  a.id,
  a.name,
  a.agent_phone,
  a.role,
  COUNT(aph.phone_number) as additional_phones,
  STRING_AGG(aph.phone_number, ', ') as phone_pool
FROM agents a
LEFT JOIN agent_phone_numbers aph ON a.id = aph.agent_id
GROUP BY a.id, a.name, a.agent_phone, a.role
ORDER BY a.created_at;
