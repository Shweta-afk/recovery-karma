-- Migration: Add provider-agnostic telephony fields to agents table
-- Date: 2026-07-28
-- Purpose: Store agent phone/extension and provider ID for Click-to-Call integration
--          Generic names work with any provider (Exotel, Twilio, Plivo, etc.)

-- Add agent_phone column (the phone/extension registered in the active provider)
-- Works across any provider: Exotel (+919876543210), Twilio (+1234567890), etc.
ALTER TABLE agents ADD COLUMN agent_phone TEXT;

-- Add provider_agent_id column (the provider's internal agent ID)
-- Populated when agent is created in the active provider (via POST /v1/user or equivalent)
ALTER TABLE agents ADD COLUMN provider_agent_id TEXT;

-- Create index on agent_phone for faster lookups during call placement
CREATE INDEX idx_agents_agent_phone ON agents(agent_phone);

-- Create index on provider_agent_id for tracking/reconciliation
CREATE INDEX idx_agents_provider_agent_id ON agents(provider_agent_id);

-- Add comments for documentation
COMMENT ON COLUMN agents.agent_phone IS 'Phone number or extension registered in the active telephony provider (Exotel, Twilio, Plivo, etc.). Example: +919876543210 (Exotel) or +1234567890 (Twilio)';
COMMENT ON COLUMN agents.provider_agent_id IS 'Internal agent ID returned by the provider when agent is created (e.g., response.sid for Exotel/Twilio). Used for call operations.';
