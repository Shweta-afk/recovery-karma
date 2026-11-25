// The borrower's Insights lookups from earlier uploads of the same loan. Rules and the reason
// are in profilex/earlier-lookups.ts. Read-only: nothing is copied, nothing is charged.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z, tokenSchema, idSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { loanKey, sameLoanAndBorrower } from "./profilex/earlier-lookups";
import type { Database } from "./database.types";

export type EarlierTrace = Database["public"]["Tables"]["debtor_traces"]["Row"] & {
  earlier_portfolio: string;
};

/** At most this many earlier lookups come back (newest first); responses can be large. */
const MAX_EARLIER = 100;

/** Whether the caller can see this borrower, decided by debtors_select RLS run AS the caller. */
async function callerCanSeeDebtor(accessToken: string, debtorId: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;
  const asUser = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data } = await asUser.from("debtors").select("id").eq("id", debtorId).maybeSingle();
  return !!data;
}

/** Escapes LIKE wildcards so ilike compares the loan ID literally (case-insensitive). */
function literal(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const getEarlierLookups = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, debtorId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<EarlierTrace[]> => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Your session has expired — please sign in again.");
    if (!(await callerCanSeeDebtor(data.accessToken, data.debtorId))) return [];

    const admin = getSupabaseAdmin();
    const { data: me } = await admin
      .from("debtors")
      .select("id, client_id, name, phone_primary, loan_reference")
      .eq("id", data.debtorId)
      .maybeSingle();
    if (!me || me.client_id !== caller.clientId) return [];
    const loan = loanKey(me.loan_reference);
    if (!loan) return [];

    const { data: rows, error } = await admin
      .from("debtors")
      .select("id, name, phone_primary, loan_reference, portfolio_id")
      .eq("client_id", caller.clientId)
      .neq("id", me.id)
      .ilike("loan_reference", literal(String(me.loan_reference).trim()))
      .limit(200);
    if (error) throw new Error(`Could not load earlier lookups (${error.message})`);
    const current = { loanReference: me.loan_reference, name: me.name, phone: me.phone_primary };
    const others = (rows ?? []).filter((r) =>
      sameLoanAndBorrower(current, {
        loanReference: r.loan_reference,
        name: r.name,
        phone: r.phone_primary,
      }),
    );
    if (others.length === 0) return [];

    const { data: traces, error: tErr } = await admin
      .from("debtor_traces")
      .select("*")
      .in(
        "debtor_id",
        others.map((r) => r.id),
      )
      .eq("state", "done")
      .order("created_at", { ascending: false })
      .limit(MAX_EARLIER);
    if (tErr) throw new Error(`Could not load earlier lookups (${tErr.message})`);
    if (!traces?.length) return [];

    const portfolioOf = new Map(others.map((r) => [r.id, r.portfolio_id as string | null]));
    const ids = [...new Set(others.map((r) => r.portfolio_id).filter(Boolean))] as string[];
    const { data: portfolios } = await admin.from("portfolios").select("id, name").in("id", ids);
    const nameOf = new Map((portfolios ?? []).map((p) => [p.id, p.name as string]));

    return traces.map((t) => ({
      ...t,
      earlier_portfolio:
        nameOf.get(portfolioOf.get(String(t.debtor_id)) ?? "") ?? "an earlier upload",
    }));
  });
