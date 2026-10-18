-- Visibility fingerprint (READ-ONLY). For each user listed below, counts the rows they can see in
-- each table and hashes the exact row ids, then prints one fingerprint per user. Run it before
-- and after any change to RLS policies or auth_* helpers: identical fingerprints = nobody's
-- visibility changed. Paste into the Supabase SQL Editor; replace the user list first.
-- Admins are simulated with an OTP sign-in (auth_role() otherwise reports 'admin_unverified').
create temp table _v(u text, t text, n bigint, h text);
grant all on _v to authenticated;
do $$
declare uid text; tbl text; n bigint; h text; is_admin boolean;
begin
  foreach uid in array string_to_array('<auth_user_id>,<auth_user_id>,...', ',') loop
    select role='admin' into is_admin from agents where auth_user_id=uid::uuid limit 1;
    perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated',
      'amr', case when is_admin then json_build_array(json_build_object('method','otp')) else '[]'::json end)::text, true);
    set local role authenticated;
    foreach tbl in array array['debtors','call_logs','debtor_traces','insight_requests','portfolios','agents','payments','messages','ptp_escalations','teams','team_agents','settlement_requests','disputes'] loop
      execute format('select count(*), md5(coalesce(string_agg(id::text, '','' order by id),'''')) from %I', tbl) into n, h;
      insert into _v values (uid, tbl, n, left(h,8));
    end loop;
    foreach tbl in array array['auth_client_debtor_ids','auth_visible_debtor_ids','auth_my_debtor_ids','auth_client_agent_ids','auth_visible_team_ids'] loop
      execute format('select count(*), md5(coalesce(string_agg(x::text, '','' order by x),'''')) from %I() x', tbl) into n, h;
      insert into _v values (uid, tbl, n, left(h,8));
    end loop;
    reset role;
  end loop;
end $$;
select left(u,8) u, string_agg(t||'='||n, ' ' order by t) counts, md5(string_agg(t||n||h, '' order by t)) fp from _v group by u order by u;
