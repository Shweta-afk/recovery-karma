-- Add index on auth_user_id for faster agent profile lookups during login
-- This speeds up the fetchAgentProfile query used in auth.tsx

CREATE INDEX IF NOT EXISTS idx_agents_auth_user_id ON agents(auth_user_id);
