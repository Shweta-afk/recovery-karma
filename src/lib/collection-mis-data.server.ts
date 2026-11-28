// Collection MIS rows from SQL collection_mis() — shared by the MIS page and scheduled emails.
// Plain server module (no server functions), imported only from server code.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { sameDayLastMonth, type MisInput, type MisRow } from "./collection-mis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- function newer than generated types
const db = () => getSupabaseAdmin() as any;

export async function loadMisRows(
  clientId: string,
  teamIds: string[],
  asOf: string,
): Promise<MisRow[]> {
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

/** The MIS for every team of a company, and the same day last month. */
export async function companyMisInput(clientId: string, asOf: string): Promise<MisInput> {
  const { data: teams } = await db().from("teams").select("id").eq("client_id", clientId);
  const teamIds = ((teams ?? []) as { id: string }[]).map((t) => t.id);
  const prevAsOf = sameDayLastMonth(asOf);
  const [rows, prevRows] = await Promise.all([
    loadMisRows(clientId, teamIds, asOf),
    loadMisRows(clientId, teamIds, prevAsOf),
  ]);
  return { asOf, rows, prevAsOf, prevRows };
}
