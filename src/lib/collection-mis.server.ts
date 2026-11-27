// Collection MIS data (Reports → MIS). Admins and auditors see every team of their company;
// a manager sees only teams they manage. Sums come from SQL collection_mis()
// (migrations/20261127_collection_mis.sql); sheet layouts are built in collection-mis.ts.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { sameDayLastMonth, type MisInput, type MisRow } from "./collection-mis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- function newer than generated types
const db = () => getSupabaseAdmin() as any;

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function load(clientId: string, teamIds: string[], asOf: string): Promise<MisRow[]> {
  if (!teamIds.length) return [];
  const { data, error } = await db().rpc("collection_mis", {
    p_client: clientId,
    p_team_ids: teamIds,
    p_month_start: `${asOf.slice(0, 8)}01`,
    p_as_of: asOf,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883")
      throw new Error("The MIS reports need a database update that hasn't been applied yet.");
    throw new Error(error.message);
  }
  return (data ?? []).map(
    (r: {
      team_id: string;
      team_name: string;
      agent_id: string;
      agent_name: string;
      pos: number | string;
      loans: number | string;
      paid_by_day: Record<string, number | string>;
      projection: number | string;
    }) => ({
      teamId: r.team_id,
      teamName: r.team_name,
      agentId: r.agent_id,
      agentName: r.agent_name,
      pos: Number(r.pos) || 0,
      loans: Number(r.loans) || 0,
      paidByDay: Object.fromEntries(
        Object.entries(r.paid_by_day ?? {}).map(([d, v]) => [d, Number(v) || 0]),
      ),
      projection: Number(r.projection) || 0,
    }),
  );
}

export const getCollectionMis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, asOf: daySchema }).parse(d))
  .handler(async ({ data }): Promise<MisInput & { teamCount: number }> => {
    const c = await verifyCaller(data.accessToken);
    if (!c) throw new Error("Not authenticated");
    if (!["admin", "manager", "auditor"].includes(c.role)) throw new Error("Not allowed");
    let q = db().from("teams").select("id").eq("client_id", c.clientId);
    if (c.role === "manager") q = q.eq("manager_id", c.agentId);
    const { data: teams, error } = await q;
    if (error) throw new Error(error.message);
    const teamIds = (teams as { id: string }[]).map((t) => t.id);
    const prevAsOf = sameDayLastMonth(data.asOf);
    const [rows, prevRows] = await Promise.all([
      load(c.clientId, teamIds, data.asOf),
      load(c.clientId, teamIds, prevAsOf),
    ]);
    return { asOf: data.asOf, rows, prevAsOf, prevRows, teamCount: teamIds.length };
  });
