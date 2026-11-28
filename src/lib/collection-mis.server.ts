// Collection MIS data (Reports → MIS). Admins and auditors see every team of their company;
// a manager sees only teams they manage. Sums come from SQL collection_mis()
// (migrations/20261127_collection_mis.sql); sheet layouts are built in collection-mis.ts.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { loadMisRows } from "./collection-mis-data.server";
import { requireFeature } from "./company-features.server";
import { sameDayLastMonth, type MisInput } from "./collection-mis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- function newer than generated types
const db = () => getSupabaseAdmin() as any;

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const getCollectionMis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, asOf: daySchema }).parse(d))
  .handler(async ({ data }): Promise<MisInput & { teamCount: number }> => {
    const c = await verifyCaller(data.accessToken);
    if (!c) throw new Error("Not authenticated");
    if (!["admin", "manager", "auditor"].includes(c.role)) throw new Error("Not allowed");
    await requireFeature(c.clientId, "misReports");
    let q = db().from("teams").select("id").eq("client_id", c.clientId);
    if (c.role === "manager") q = q.eq("manager_id", c.agentId);
    const { data: teams, error } = await q;
    if (error) throw new Error(error.message);
    const teamIds = (teams as { id: string }[]).map((t) => t.id);
    const prevAsOf = sameDayLastMonth(data.asOf);
    const [rows, prevRows] = await Promise.all([
      loadMisRows(c.clientId, teamIds, data.asOf),
      loadMisRows(c.clientId, teamIds, prevAsOf),
    ]);
    return { asOf: data.asOf, rows, prevAsOf, prevRows, teamCount: teamIds.length };
  });
