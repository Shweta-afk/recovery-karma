-- Every agent needs their own personal number to bridge through (click_to_call rings
-- agents.agent_phone — see agent-pool.ts). Nothing stopped two agents in the same company
-- sharing a number, and agent_phone defaults to NULL with no seed data populating it, so in
-- practice every agent fell back to use-single-call.ts's "agent-self" placeholder — the same
-- non-number for everyone, which is why manual dial didn't actually reach anyone.
--
-- A unique index (not a plain UNIQUE constraint) so it can be partial: NULL stays allowed
-- for roles that don't take calls (e.g. an admin with no dialer duties), while any two
-- agents that DO have a number set can never collide within the same company.

CREATE UNIQUE INDEX IF NOT EXISTS agents_client_phone_unique
  ON agents (client_id, agent_phone)
  WHERE agent_phone IS NOT NULL;
