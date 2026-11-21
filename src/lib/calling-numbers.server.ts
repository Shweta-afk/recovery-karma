// Company side of the calling numbers (user, 2026-11-20). A superadmin gives a company its numbers
// (telephony-numbers.server.ts); here the company's ADMIN marks which are for Manual Dial, and a
// MANAGER picks which of the rest each of their portfolios calls from (portfolio_dids). Picking a
// number per call happens in telephony/guard.server.ts chooseDid → did-rules.ts pickCallerNumber.
// Tables are server-only: every read and write here is the service role after verifyCaller, scoped
// to the caller's company (and, for a manager, to portfolios they own).
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, type VerifiedCaller } from "./supabase-admin.server";
import { didUsage, loadCompanyDids, loadTrunk, type CompanyDid } from "./telephony/guard.server";
import { capLevel, portfolioNumberChoices, type CapLevel } from "./telephony/did-rules";

// telephony_dids / portfolio_dids aren't in database.types.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabaseAdmin() as any;

async function requireCaller(accessToken: string): Promise<VerifiedCaller> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  return caller;
}

function missing(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    (error.code === "PGRST205" ||
      error.code === "42P01" ||
      error.code === "42703" ||
      /does not exist/i.test(error.message ?? ""))
  );
}

const NOT_APPLIED =
  "Calling numbers aren't set up in the database yet — apply migrations/20261120_calling_numbers_prefix_manual_portfolio.sql first.";

export interface CallingNumber {
  id: string;
  number: string;
  /** Always null on company screens — see companyNumbers. */
  label: string | null;
  manual: boolean;
  /** False when SkyCRM can't show this number yet (no prefix entered). */
  hasPrefix: boolean;
  dailyCap: number | null;
  resting: boolean;
  callsToday: number;
}

async function usageToday(dids: CompanyDid[]): Promise<Map<string, number>> {
  try {
    const u = await didUsage(dids.map((d) => d.id));
    return new Map([...u].map(([id, v]) => [id, v.callsToday]));
  } catch {
    return new Map();
  }
}

function toCallingNumber(d: CompanyDid, used: Map<string, number>, now: Date): CallingNumber {
  return {
    id: d.id,
    number: d.number,
    label: null,
    manual: d.manual,
    hasPrefix: !!d.prefix,
    dailyCap: d.daily_cap,
    resting: !!d.resting_until && new Date(d.resting_until) > now,
    callsToday: used.get(d.id) ?? 0,
  };
}

/** Outbound-capable numbers the company holds. Never with the superadmin's label: that is
 *  SamvadX's own note (it once said "SkyCRM …" on every number) and companies don't see it. */
async function companyNumbers(clientId: string): Promise<CompanyDid[]> {
  return (await loadCompanyDids(clientId))
    .filter((d) => d.use !== "inbound")
    .sort((a, b) => a.number.localeCompare(b.number));
}

/** Throws unless the caller may choose numbers for this portfolio: an admin of its company, or a
 *  manager who owns it (manager_id) or manages its team. */
async function requirePortfolioOwner(caller: VerifiedCaller, portfolioId: string) {
  if (caller.role !== "admin" && caller.role !== "manager")
    throw new Error("Only a manager or admin can choose a portfolio's calling numbers.");
  const { data: p } = await db()
    .from("portfolios")
    .select("id, client_id, manager_id, team_id, name")
    .eq("id", portfolioId)
    .maybeSingle();
  const portfolio = p as {
    id: string;
    client_id: string;
    manager_id: string | null;
    team_id: string | null;
    name: string;
  } | null;
  if (!portfolio || portfolio.client_id !== caller.clientId) throw new Error("Portfolio not found");
  if (caller.role === "admin") return portfolio;
  if (portfolio.manager_id && portfolio.manager_id === caller.agentId) return portfolio;
  if (portfolio.team_id && caller.agentId) {
    const { data: team } = await db()
      .from("teams")
      .select("id")
      .eq("id", portfolio.team_id)
      .eq("manager_id", caller.agentId)
      .maybeSingle();
    if (team) return portfolio;
  }
  throw new Error("You can only choose calling numbers for your own portfolios.");
}

// ─── Manual Dial dock ─────────────────────────────────────────────────────────

/** The numbers the caller may pick on Manual Dial. `companyHasNumbers` false = the company holds
 *  no numbers at all, so calls go out on the vendor's default (no picker needed). */
export const getMyManualNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const dids = await companyNumbers(caller.clientId);
    const manual = dids.filter((d) => d.manual);
    // Today's calls per number, so the picker can show green / yellow / red (2026-11-21). A
    // failure leaves the counts out rather than hiding the numbers.
    const [usage, trunk] = await Promise.all([
      didUsage(manual.map((d) => d.id)).catch(() => new Map()),
      loadTrunk().catch(() => ({ defaultDidDailyCap: 150 })),
    ]);
    return {
      companyHasNumbers: dids.length > 0,
      numbers: manual.map((d) => {
        const usedToday: number = usage.get(d.id)?.callsToday ?? 0;
        const cap = d.daily_cap ?? trunk.defaultDidDailyCap;
        return {
          number: d.number,
          label: null as string | null,
          usedToday,
          cap,
          level: capLevel(usedToday, cap) as CapLevel,
        };
      }),
    };
  });

// ─── Admin: which numbers are for Manual Dial ──────────────────────────────────

export interface CompanyCallingNumbers {
  numbers: Array<CallingNumber & { portfolios: Array<{ id: string; name: string }> }>;
}

export const getCompanyCallingNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<CompanyCallingNumbers> => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "admin") throw new Error("Only an admin can see the company's numbers.");
    const dids = await companyNumbers(caller.clientId);
    if (!dids.length) return { numbers: [] };
    const [used, links] = await Promise.all([
      usageToday(dids),
      db()
        .from("portfolio_dids")
        .select("did_id, portfolio_id, portfolios(name)")
        .eq("client_id", caller.clientId),
    ]);
    const byDid = new Map<string, Array<{ id: string; name: string }>>();
    for (const r of (links.data ?? []) as Array<{
      did_id: string;
      portfolio_id: string;
      portfolios: { name: string } | null;
    }>) {
      const list = byDid.get(r.did_id) ?? [];
      list.push({ id: r.portfolio_id, name: r.portfolios?.name ?? "Portfolio" });
      byDid.set(r.did_id, list);
    }
    const now = new Date();
    return {
      numbers: dids.map((d) => ({
        ...toCallingNumber(d, used, now),
        portfolios: byDid.get(d.id) ?? [],
      })),
    };
  });

/** Mark numbers as Manual Dial (or not). A number marked manual leaves every portfolio's list —
 *  Manual Dial numbers are never used for Call Queue calls. */
export const setManualNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        ids: z.array(idSchema).min(1).max(500),
        manual: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "admin") throw new Error("Only an admin can choose Manual Dial numbers.");
    const owned = new Set((await companyNumbers(caller.clientId)).map((d) => d.id));
    const ids = data.ids.filter((id) => owned.has(id));
    if (!ids.length) throw new Error("Those numbers don't belong to your company.");
    const { error } = await db()
      .from("telephony_dids")
      .update({ manual: data.manual, updated_at: new Date().toISOString() })
      .eq("client_id", caller.clientId)
      .in("id", ids);
    if (error) throw new Error(missing(error) ? NOT_APPLIED : error.message);
    let removedFromPortfolios = 0;
    if (data.manual) {
      const { data: gone, error: delErr } = await db()
        .from("portfolio_dids")
        .delete()
        .eq("client_id", caller.clientId)
        .in("did_id", ids)
        .select("portfolio_id");
      if (delErr && !missing(delErr)) throw new Error(delErr.message);
      removedFromPortfolios = (gone ?? []).length;
    }
    return { changed: ids.length, removedFromPortfolios };
  });

// ─── Manager: which numbers a portfolio calls from ─────────────────────────────

export interface PortfolioNumbers {
  /** The company holds no numbers at all: calls use the vendor default, nothing to choose. */
  companyHasNumbers: boolean;
  /** Numbers a portfolio may use (the company's, minus Manual Dial ones). */
  choices: CallingNumber[];
  /** Ids chosen for this portfolio (empty for a portfolio not created yet). */
  chosen: string[];
}

export const getPortfolioNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, portfolioId: idSchema.nullable() }).parse(d),
  )
  .handler(async ({ data }): Promise<PortfolioNumbers> => {
    const caller = await requireCaller(data.accessToken);
    if (data.portfolioId) await requirePortfolioOwner(caller, data.portfolioId);
    else if (caller.role !== "admin" && caller.role !== "manager")
      throw new Error("Only a manager or admin can choose calling numbers.");
    const dids = await companyNumbers(caller.clientId);
    if (!dids.length) return { companyHasNumbers: false, choices: [], chosen: [] };
    let chosen: string[] = [];
    if (data.portfolioId) {
      const { data: rows, error } = await db()
        .from("portfolio_dids")
        .select("did_id")
        .eq("portfolio_id", data.portfolioId);
      if (error && !missing(error)) throw new Error(error.message);
      chosen = ((rows ?? []) as Array<{ did_id: string }>).map((r) => r.did_id);
    }
    const used = await usageToday(dids);
    const now = new Date();
    const choices = portfolioNumberChoices(dids).map((d) =>
      toCallingNumber(d as CompanyDid, used, now),
    );
    const allowed = new Set(choices.map((c) => c.id));
    return { companyHasNumbers: true, choices, chosen: chosen.filter((id) => allowed.has(id)) };
  });

export const setPortfolioNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        portfolioId: idSchema,
        ids: z.array(idSchema).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    await requirePortfolioOwner(caller, data.portfolioId);
    const allowed = new Set(
      portfolioNumberChoices(await companyNumbers(caller.clientId)).map((d) => d.id),
    );
    const wanted = [...new Set(data.ids)];
    const bad = wanted.filter((id) => !allowed.has(id));
    if (bad.length)
      throw new Error("Some of those numbers are for Manual Dial or aren't your company's.");

    const { data: current, error } = await db()
      .from("portfolio_dids")
      .select("did_id")
      .eq("portfolio_id", data.portfolioId);
    if (error) throw new Error(missing(error) ? NOT_APPLIED : error.message);
    const have = new Set(((current ?? []) as Array<{ did_id: string }>).map((r) => r.did_id));
    const add = wanted.filter((id) => !have.has(id));
    const drop = [...have].filter((id) => !wanted.includes(id));
    if (drop.length) {
      const { error: delErr } = await db()
        .from("portfolio_dids")
        .delete()
        .eq("portfolio_id", data.portfolioId)
        .in("did_id", drop);
      if (delErr) throw new Error(delErr.message);
    }
    if (add.length) {
      const { error: insErr } = await db()
        .from("portfolio_dids")
        .insert(
          add.map((did_id) => ({
            portfolio_id: data.portfolioId,
            did_id,
            client_id: caller.clientId,
            chosen_by: caller.agentId,
          })),
        );
      if (insErr) throw new Error(insErr.message);
    }
    return { chosen: wanted.length };
  });
