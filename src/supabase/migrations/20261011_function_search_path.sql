-- Pin search_path on the eleven public functions Supabase's security advisor flags as
-- "Function Search Path Mutable" (lint 0011). Without it, a function resolves unqualified names
-- (debtors, telephony_calls, next_agent_code, agent_code_seq, ...) through whatever search_path
-- the CALLER has, so a caller who can put an object earlier on that path can swap what the
-- function touches. Matters most for cleanup_ghost_live_calls, the only SECURITY DEFINER one.
--
-- Every body here references only public objects and pg_catalog built-ins (checked against the
-- live definitions 2026-10-11), so `public, pg_temp` changes nothing they resolve to today.
-- extra_named / extra_head were already not inlined by the planner (their subqueries prevent
-- it), so the SET clause costs them nothing in the list queries that select them.
--
-- ALTER, not CREATE OR REPLACE: bodies are untouched. A later CREATE OR REPLACE of any of these
-- functions resets its settings — repeat the SET clause there or the advisor will flag it again.
-- Idempotent.

ALTER FUNCTION public.cleanup_ghost_live_calls() SET search_path = public, pg_temp;

ALTER FUNCTION public.clients_protect_admin_fields() SET search_path = public, pg_temp;
ALTER FUNCTION public.agents_guard_extension() SET search_path = public, pg_temp;
ALTER FUNCTION public.assign_agent_code() SET search_path = public, pg_temp;
ALTER FUNCTION public.next_agent_code(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.telephony_reserve_channel(uuid, integer, integer, integer, uuid, text, text, text, text, text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.extra_named(public.debtors) SET search_path = public, pg_temp;
ALTER FUNCTION public.extra_head(public.debtors) SET search_path = public, pg_temp;
ALTER FUNCTION public.agent_book_totals(uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.portfolio_debtor_aggregates() SET search_path = public, pg_temp;
ALTER FUNCTION public.portfolio_debtor_aggregates_for(uuid[]) SET search_path = public, pg_temp;
