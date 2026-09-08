-- One account, one active device at a time.
--
-- Supabase Auth allows unlimited concurrent sessions per user by default — nothing stopped the
-- same login working on five devices simultaneously. There is no way to enforce this purely in
-- RLS (it's an auth-layer concern, not a data-visibility one): the mechanism is
-- `auth.admin.signOut(jwt, 'others')`, which revokes every OTHER session's refresh token the
-- moment a new one is issued (src/lib/session-actions.server.ts). That alone has a lag: an
-- already-issued access token stays valid until it expires (Supabase Auth's default is 1 hour),
-- so a just-kicked device can still call the API for up to that long unless the JWT expiry is
-- shortened in the dashboard (Authentication > Sessions).
--
-- session_nonce closes that gap for the UI: it's rewritten to a fresh random value on every
-- login, and every open tab subscribes to its own agents row over Realtime. When the value
-- changes to something a tab didn't itself just set, that tab knows a newer login happened
-- elsewhere and signs itself out immediately client-side — instant UX on top of the token
-- revocation, not a replacement for it.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS session_nonce TEXT;

-- Realtime, same guarded pattern as 20260830_live_calls.sql (the only other table that needed
-- it) — ALTER PUBLICATION ... ADD TABLE errors if the table is already a member or if the
-- publication doesn't exist at all, either of which would abort this migration and take
-- agents_select-dependent policies down with it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not found — session_nonce column added, but enable Realtime for agents in the Supabase dashboard (Database > Replication) for the instant-kick UX to work.';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE agents;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
