// Loads one portfolio's feedback for the banker's file (see portfolio-feedback.ts).
//
// Who gets which portfolios, enforced here on every request: a manager only those on their own
// teams; admins and call auditors every portfolio of their company. Rows are read with the service
// role and always scoped to the caller's company.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, isoDateSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, type VerifiedCaller } from "./supabase-admin.server";
import { appError } from "./app-error";
import { loadPortfolioFeedback, pageAll } from "./portfolio-feedback-data.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- newer tables and views than the generated types */

async function requireCaller(accessToken: string): Promise<VerifiedCaller> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Your session has expired — please sign in again.");
  if (caller.role !== "manager" && caller.role !== "admin" && caller.role !== "auditor") {
    throw new Error("Only managers, admins and call auditors can download feedback files.");
  }
  return caller;
}

/** Limits a portfolios query to what this caller may download. */
async function portfolioScope(caller: VerifiedCaller) {
  if (caller.role !== "manager") return (q: any) => q;
  if (!caller.agentId) throw new Error("Your session has expired — please sign in again.");
  const { data: teams, error } = await (getSupabaseAdmin() as any)
    .from("teams")
    .select("id")
    .eq("client_id", caller.clientId)
    .eq("manager_id", caller.agentId);
  if (error) throw appError("SX-7204", "Could not load your teams.", error);
  const ids = (teams as { id: string }[]).map((t) => t.id);
  const mine = ids.length
    ? `manager_id.eq.${caller.agentId},team_id.in.(${ids.join(",")})`
    : `manager_id.eq.${caller.agentId}`;
  return (q: any) => q.or(mine);
}

export const listFeedbackPortfolios = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const admin = getSupabaseAdmin() as any;
    const inScope = await portfolioScope(caller);
    const [portfolios, teams, agents] = await Promise.all([
      pageAll<{
        id: string;
        name: string;
        lender_name: string | null;
        total_accounts: number | null;
        closed_at: string | null;
        team_id: string | null;
      }>((a, b) =>
        inScope(
          admin
            .from("portfolios")
            .select("id, name, lender_name, total_accounts, closed_at, team_id")
            .eq("client_id", caller.clientId)
            .is("deleted_at", null),
        )
          .order("uploaded_at", { ascending: false })
          .order("id")
          .range(a, b),
      ),
      pageAll<{ id: string; name: string; manager_id: string | null }>((a, b) =>
        admin
          .from("teams")
          .select("id, name, manager_id")
          .eq("client_id", caller.clientId)
          .order("id")
          .range(a, b),
      ),
      pageAll<{ id: string; name: string }>((a, b) =>
        admin
          .from("agents")
          .select("id, name")
          .eq("client_id", caller.clientId)
          .order("id")
          .range(a, b),
      ),
    ]);
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return portfolios.map((p) => {
      const team = p.team_id ? teamById.get(p.team_id) : undefined;
      return {
        ...p,
        team_name: team?.name ?? null,
        manager_name: team?.manager_id ? (nameById.get(team.manager_id) ?? null) : null,
      };
    });
  });

export const getPortfolioFeedbackData = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        portfolioId: idSchema,
        // Both left out: every piece of feedback ever recorded on these loans.
        from: isoDateSchema.optional(),
        to: isoDateSchema.optional(),
        includeRecordingLinks: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const inScope = await portfolioScope(caller);
    const { data: portfolio, error: pfErr } = await inScope(
      (getSupabaseAdmin() as any)
        .from("portfolios")
        .select("id, name, lender_name")
        .eq("id", data.portfolioId)
        .eq("client_id", caller.clientId)
        .is("deleted_at", null),
    ).maybeSingle();
    if (pfErr) throw appError("SX-7203", "Could not load this portfolio.", pfErr);
    if (!portfolio) throw new Error("This portfolio isn't available to you.");

    return loadPortfolioFeedback(caller.clientId, portfolio, data);
  });
