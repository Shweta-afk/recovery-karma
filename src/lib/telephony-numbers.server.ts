// Superadmin: the platform's phone numbers (DIDs) and how the trunk's channels are shared.
// Tables from migrations/20261026_telephony_dids_channels.sql, all server-only — every read and
// write here is service role after verifySuperadminCaller. Rules: telephony/did-rules.ts and
// telephony/channel-plan.ts.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema } from "./schemas";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { getTelephonyProvider } from "./telephony";
import { didUsage, loadChannelState, loadTrunk } from "./telephony/guard.server";
import { channelHeadroom, trunkError } from "./telephony/channel-plan";
import {
  coolingUntil,
  didHealth,
  isAssignable,
  istDayStart,
  parseNumbersWithPrefixes,
  type DidHealth,
  type DidRow,
  type DidStatus,
  type DidUse,
} from "./telephony/did-rules";

// New tables aren't in database.types.ts until types are regenerated after the migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabaseAdmin() as any;

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

const DID_BASE_COLS =
  "id, number, label, status, use, client_id, portfolio_id, vendor_queue, daily_cap, resting_until, cooling_until, assigned_at, notes";
/** With the prefix + Manual Dial flag (20261120_calling_numbers_prefix_manual_portfolio.sql). */
const DID_COLS = `${DID_BASE_COLS}, prefix, manual`;

/** Read numbers with the new columns, or without them before the migration is applied. */
async function readDids(build: (cols: string) => PromiseLike<{ data: unknown; error: any }>) {
  const first = await build(DID_COLS);
  if (first.error && /prefix|manual/.test(first.error.message ?? "")) return build(DID_BASE_COLS);
  return first;
}

function missing(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    (error.code === "PGRST205" ||
      error.code === "42P01" ||
      error.code === "PGRST202" ||
      /does not exist/i.test(error.message ?? ""))
  );
}

const NOT_APPLIED =
  "Phone numbers aren't set up in the database yet — apply migrations/20261026_telephony_dids_channels.sql first.";

// ─── Overview ──────────────────────────────────────────────────────────────────

export interface NumberRow {
  id: string;
  number: string;
  label: string | null;
  status: DidStatus;
  use: DidUse;
  clientId: string | null;
  clientName: string | null;
  /** What SkyCRM dials with to show this number (3701 → …3701). Null = can't be used on SkyCRM. */
  prefix: string | null;
  /** The company's admin kept it for Manual Dial. */
  manual: boolean;
  /** How many of the company's portfolios call from it (portfolio_dids). */
  portfolios: number;
  vendorQueue: string | null;
  dailyCap: number | null;
  restingUntil: string | null;
  coolingUntil: string | null;
  assignedAt: string | null;
  notes: string | null;
  /** Free to hand to a company now (available, or cooling-off over). */
  assignable: boolean;
  callsToday: number;
  calls7d: number;
  answered7d: number;
  health: DidHealth;
}

export interface CompanyLines {
  clientId: string;
  name: string;
  enabled: boolean;
  reserved: number;
  max: number;
  activeOutbound: number;
  /** Lines this company could open this second. */
  headroom: number;
  numbers: number;
  /** Minutes today (IST) when its agents waited for a line, by reason. */
  waitedCompanyLimit: number;
  waitedPlatformBusy: number;
  noNumber: number;
}

export interface NumbersOverview {
  ready: boolean;
  provider: string;
  trunk: {
    totalChannels: number;
    inboundReserve: number;
    didCoolingDays: number;
    defaultDidDailyCap: number;
  };
  inboundActive: number;
  outboundActive: number;
  guaranteed: number;
  companies: CompanyLines[];
  numbers: NumberRow[];
  /** Every approved company, for the assign picker. */
  allCompanies: Array<{ id: string; name: string }>;
}

export const getNumbersOverview = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<NumbersOverview> => {
    await requireSuperadmin(data.accessToken);
    const now = new Date();
    const [trunk, state, didsRes, clientsRes, refusals] = await Promise.all([
      loadTrunk(),
      loadChannelState(),
      readDids((cols) => db().from("telephony_dids").select(cols).order("number")),
      db().from("clients").select("id, company_name, status").order("company_name"),
      db().rpc("telephony_refusal_counts", { p_since: istDayStart(now).toISOString() }),
    ]);
    const clients = (
      (clientsRes.data ?? []) as Array<{ id: string; company_name: string; status: string | null }>
    ).map((c) => ({ id: c.id, name: c.company_name, status: c.status }));
    const nameOf = new Map(clients.map((c) => [c.id, c.name]));
    const ready = !missing(didsRes.error);
    if (didsRes.error && ready)
      throw new Error(`Could not load numbers (${didsRes.error.message})`);

    const dids = (didsRes.data ?? []) as Array<
      DidRow & {
        label: string | null;
        assigned_at: string | null;
        notes: string | null;
        prefix?: string | null;
        manual?: boolean;
      }
    >;
    const usage = ready
      ? await didUsage(
          dids.map((d) => d.id),
          now,
        )
      : new Map();

    const portfolioCount = new Map<string, number>();
    {
      const { data: links } = await db().from("portfolio_dids").select("did_id");
      for (const l of (links ?? []) as Array<{ did_id: string }>)
        portfolioCount.set(l.did_id, (portfolioCount.get(l.did_id) ?? 0) + 1);
    }

    // A number's pick-up rate is judged against its own company's average.
    const companyRate = new Map<string, number>();
    const totals = new Map<string, { calls: number; answered: number }>();
    for (const d of dids) {
      if (!d.client_id) continue;
      const u = usage.get(d.id);
      const t = totals.get(d.client_id) ?? { calls: 0, answered: 0 };
      t.calls += u?.calls7d ?? 0;
      t.answered += u?.answered7d ?? 0;
      totals.set(d.client_id, t);
    }
    for (const [id, t] of totals) companyRate.set(id, t.calls ? t.answered / t.calls : 0);

    const numbers: NumberRow[] = dids.map((d) => {
      const u = usage.get(d.id) ?? { callsToday: 0, calls7d: 0, answered7d: 0 };
      return {
        id: d.id,
        number: d.number,
        label: d.label,
        status: d.status,
        use: d.use,
        clientId: d.client_id,
        clientName: d.client_id ? (nameOf.get(d.client_id) ?? null) : null,
        prefix: d.prefix ?? null,
        manual: !!d.manual,
        portfolios: portfolioCount.get(d.id) ?? 0,
        vendorQueue: d.vendor_queue,
        dailyCap: d.daily_cap,
        restingUntil: d.resting_until,
        coolingUntil: d.cooling_until,
        assignedAt: d.assigned_at,
        notes: d.notes,
        assignable: isAssignable(d, now),
        ...u,
        health: d.client_id
          ? didHealth({
              calls7d: u.calls7d,
              answered7d: u.answered7d,
              companyRate: companyRate.get(d.client_id) ?? 0,
            })
          : "too_few_calls",
      };
    });

    const refusalRows = (refusals.error ? [] : (refusals.data ?? [])) as Array<{
      client_id: string;
      reason: string;
      n: number;
    }>;
    const waited = (clientId: string, reason: string) =>
      refusalRows.find((r) => r.client_id === clientId && r.reason === reason)?.n ?? 0;

    const companies: CompanyLines[] = state.companies
      .filter((c) => nameOf.has(c.clientId))
      .map((c) => ({
        clientId: c.clientId,
        name: nameOf.get(c.clientId) as string,
        enabled: c.enabled,
        reserved: c.reserved,
        max: c.max,
        activeOutbound: c.activeOutbound,
        headroom: channelHeadroom({ ...state, clientId: c.clientId }),
        numbers: numbers.filter((n) => n.clientId === c.clientId).length,
        waitedCompanyLimit: waited(c.clientId, "company_limit"),
        waitedPlatformBusy: waited(c.clientId, "platform_busy"),
        noNumber: waited(c.clientId, "no_number"),
      }))
      .sort((a, b) => b.activeOutbound - a.activeOutbound || a.name.localeCompare(b.name));

    return {
      ready,
      provider: getTelephonyProvider().name,
      trunk,
      inboundActive: state.inboundActive,
      outboundActive: state.companies.reduce((s, c) => s + c.activeOutbound, 0),
      guaranteed: state.companies.reduce((s, c) => s + (c.enabled ? c.reserved : 0), 0),
      companies,
      numbers,
      allCompanies: clients
        .filter((c) => c.status !== "rejected")
        .map((c) => ({ id: c.id, name: c.name })),
    };
  });

// ─── Trunk ─────────────────────────────────────────────────────────────────────

export const saveTrunkSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        totalChannels: z.number().int().min(0).max(5000),
        inboundReserve: z.number().int().min(0).max(5000),
        didCoolingDays: z.number().int().min(0).max(365),
        defaultDidDailyCap: z.number().int().min(1).max(10000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const state = await loadChannelState();
    const allReserved = state.companies.reduce((s, c) => s + (c.enabled ? c.reserved : 0), 0);
    const err = trunkError(
      { totalChannels: data.totalChannels, inboundReserve: data.inboundReserve },
      allReserved,
    );
    if (err) throw new Error(err);
    const maxCeiling = Math.max(0, ...state.companies.filter((c) => c.enabled).map((c) => c.max));
    if (maxCeiling > data.totalChannels - data.inboundReserve) {
      throw new Error(
        `A company may use up to ${maxCeiling} lines; that is more than the ${data.totalChannels - data.inboundReserve} left for outbound. Lower it first.`,
      );
    }
    const row = {
      id: true,
      total_channels: data.totalChannels,
      inbound_reserve: data.inboundReserve,
      did_cooling_days: data.didCoolingDays,
      default_did_daily_cap: data.defaultDidDailyCap,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db().from("telephony_platform").upsert(row, { onConflict: "id" });
    if (error) throw new Error(missing(error) ? NOT_APPLIED : `Could not save (${error.message})`);
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "telephony_trunk_set",
      summary: `Calling lines: ${data.totalChannels} on the trunk, ${data.inboundReserve} kept for inbound; numbers rest ${data.didCoolingDays} days after release, ${data.defaultDidDailyCap} calls a day each`,
      detail: { ...row, updated_at: null },
    });
    return { ok: true };
  });

// ─── Numbers ───────────────────────────────────────────────────────────────────

export const addNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        text: z.string().max(20000),
        label: z.string().trim().max(60).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { rows: parsed, bad } = parseNumbersWithPrefixes(data.text);
    const numbers = parsed.map((r) => r.number);
    const prefixOf = new Map(parsed.map((r) => [r.number, r.prefix]));
    if (!numbers.length)
      throw new Error(
        bad.length
          ? `No phone numbers found (couldn't read: ${bad.slice(0, 5).join(", ")})`
          : "Paste at least one number.",
      );
    const withPrefix = parsed.some((r) => r.prefix);
    const { data: existing, error: readErr } = await db()
      .from("telephony_dids")
      .select(withPrefix ? "id, number, prefix" : "id, number")
      .in("number", numbers);
    if (readErr) {
      if (withPrefix && /prefix/.test(readErr.message ?? ""))
        throw new Error(
          "Prefixes need migrations/20261120_calling_numbers_prefix_manual_portfolio.sql applied first.",
        );
      throw new Error(missing(readErr) ? NOT_APPLIED : readErr.message);
    }
    const existingRows = (existing ?? []) as Array<{
      id: string;
      number: string;
      prefix?: string | null;
    }>;
    const have = new Set(existingRows.map((r) => r.number));
    const fresh = numbers.filter((n) => !have.has(n));
    // A number already in the list without a prefix gets the one pasted with it now.
    let prefixed = 0;
    for (const r of existingRows) {
      const p = prefixOf.get(r.number);
      if (!p || r.prefix) continue;
      const { error } = await db()
        .from("telephony_dids")
        .update({ prefix: p, updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (error) throw new Error(prefixError(error.message, p));
      prefixed++;
    }
    if (fresh.length) {
      const { error } = await db()
        .from("telephony_dids")
        .insert(
          fresh.map((number) => ({
            number,
            label: data.label || null,
            ...(withPrefix ? { prefix: prefixOf.get(number) ?? null } : {}),
          })),
        );
      if (error) throw new Error(prefixError(`Could not add numbers (${error.message})`, ""));
      await logSuperadminActivity({
        superadminId: caller.superadminId,
        action: "telephony_numbers_added",
        summary: `Added ${fresh.length} phone number${fresh.length === 1 ? "" : "s"}${data.label ? ` (${data.label})` : ""}`,
        detail: { numbers: fresh.map((n) => ({ number: n, prefix: prefixOf.get(n) ?? null })) },
      });
    }
    return {
      added: fresh.length,
      alreadyThere: numbers.length - fresh.length,
      prefixed,
      withoutPrefix: parsed.filter((r) => !r.prefix).length,
      unreadable: bad,
    };
  });

/** A duplicate prefix (unique index) explained; anything else passed through. */
function prefixError(message: string, prefix: string): string {
  return /telephony_dids_prefix_unique/.test(message)
    ? `Prefix ${prefix || ""} is already used by another number.`.replace("  ", " ")
    : message;
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), clientId: idSchema }),
  z.object({ action: z.literal("release") }),
  z.object({ action: z.literal("block") }),
  z.object({ action: z.literal("unblock") }),
  z.object({ action: z.literal("retire") }),
  z.object({ action: z.literal("rest"), days: z.number().int().min(1).max(90) }),
  z.object({ action: z.literal("wake") }),
  z.object({
    action: z.literal("edit"),
    use: z.enum(["outbound", "inbound", "both"]).optional(),
    vendorQueue: z.string().trim().max(50).nullable().optional(),
    dailyCap: z.number().int().min(1).max(10000).nullable().optional(),
    label: z.string().trim().max(60).nullable().optional(),
    /** One number at a time: prefixes are unique. */
    prefix: z
      .string()
      .trim()
      .regex(/^\d{3,6}$/, "A prefix is 3–6 digits")
      .nullable()
      .optional(),
  }),
]);

export type NumberChange = z.infer<typeof actionSchema>;

export const updateNumbers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        ids: z.array(idSchema).min(1).max(500),
        change: actionSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: rowsData, error } = await readDids((cols) =>
      db().from("telephony_dids").select(cols).in("id", data.ids),
    );
    if (error) throw new Error(missing(error) ? NOT_APPLIED : error.message);
    const rows = (rowsData ?? []) as DidRow[];
    const now = new Date();
    const nowIso = now.toISOString();
    const change = data.change;
    const trunk = await loadTrunk();

    let targets: DidRow[] = rows;
    let patch: Record<string, unknown> = {};
    let skipped = 0;
    let summary = "";

    const closeHistory = async (ids: string[]) => {
      if (!ids.length) return;
      await db()
        .from("telephony_did_assignments")
        .update({ released_at: nowIso })
        .in("did_id", ids)
        .is("released_at", null);
    };

    switch (change.action) {
      case "assign": {
        // Only free numbers: a number another company holds, or one still cooling off, is never
        // moved — its borrowers would reach the wrong company when they call back.
        targets = rows.filter((r) => isAssignable(r, now));
        skipped = rows.length - targets.length;
        const { data: client } = await db()
          .from("clients")
          .select("id, company_name")
          .eq("id", change.clientId)
          .maybeSingle();
        if (!client) throw new Error("Company not found");
        patch = {
          status: "assigned",
          client_id: change.clientId,
          portfolio_id: null,
          assigned_at: nowIso,
          cooling_until: null,
          resting_until: null,
        };
        summary = `Gave ${targets.length} number${targets.length === 1 ? "" : "s"} to ${(client as { company_name: string }).company_name}`;
        break;
      }
      case "release":
        targets = rows.filter((r) => r.status === "assigned");
        skipped = rows.length - targets.length;
        patch = {
          status: "cooling",
          client_id: null,
          portfolio_id: null,
          resting_until: null,
          cooling_until: coolingUntil(now, trunk.didCoolingDays),
        };
        summary = `Took back ${targets.length} number${targets.length === 1 ? "" : "s"} (resting ${trunk.didCoolingDays} days before anyone else gets them)`;
        break;
      case "block":
        targets = rows.filter((r) => r.status !== "retired");
        patch = { status: "blocked", client_id: null, portfolio_id: null };
        summary = `Blocked ${targets.length} number${targets.length === 1 ? "" : "s"}`;
        break;
      case "unblock":
        targets = rows.filter((r) => r.status === "blocked");
        patch = { status: "available" };
        summary = `Unblocked ${targets.length} number${targets.length === 1 ? "" : "s"}`;
        break;
      case "retire":
        patch = { status: "retired", client_id: null, portfolio_id: null };
        summary = `Retired ${targets.length} number${targets.length === 1 ? "" : "s"}`;
        break;
      case "rest":
        targets = rows.filter((r) => r.status === "assigned");
        patch = { resting_until: new Date(now.getTime() + change.days * 86_400_000).toISOString() };
        summary = `Rested ${targets.length} number${targets.length === 1 ? "" : "s"} for ${change.days} days`;
        break;
      case "wake":
        patch = { resting_until: null };
        summary = `Put ${targets.length} number${targets.length === 1 ? "" : "s"} back in use`;
        break;
      case "edit": {
        if (change.use !== undefined) patch.use = change.use;
        if (change.vendorQueue !== undefined) patch.vendor_queue = change.vendorQueue || null;
        if (change.dailyCap !== undefined) patch.daily_cap = change.dailyCap;
        if (change.label !== undefined) patch.label = change.label || null;
        if (change.prefix !== undefined) {
          if (rows.length !== 1 && change.prefix)
            throw new Error("Set a prefix one number at a time.");
          patch.prefix = change.prefix || null;
        }
        summary = `Changed ${targets.length} number${targets.length === 1 ? "" : "s"}: ${Object.keys(patch).join(", ")}`;
        break;
      }
    }
    if (!targets.length) {
      return { changed: 0, skipped: rows.length };
    }
    const ids = targets.map((t) => t.id);
    const { error: upErr } = await db()
      .from("telephony_dids")
      .update({ ...patch, updated_at: nowIso })
      .in("id", ids);
    if (upErr)
      throw new Error(
        prefixError(`Could not update numbers (${upErr.message})`, String(patch.prefix ?? "")),
      );

    // A number leaving its company (or moving to another) takes none of the old company's choices
    // with it: not its Manual Dial flag, not its place on their portfolios.
    if (["assign", "release", "block", "retire"].includes(change.action)) {
      const { error: flagErr } = await db()
        .from("telephony_dids")
        .update({ manual: false })
        .in("id", ids);
      if (flagErr && !/manual/.test(flagErr.message ?? ""))
        console.warn(`[numbers] manual flag not cleared: ${flagErr.message}`);
      const { error: linkErr } = await db().from("portfolio_dids").delete().in("did_id", ids);
      if (linkErr && !missing(linkErr))
        console.warn(`[numbers] portfolio lists not cleared: ${linkErr.message}`);
    }

    if (change.action === "assign") {
      await db()
        .from("telephony_did_assignments")
        .insert(ids.map((did_id) => ({ did_id, client_id: change.clientId, assigned_at: nowIso })));
    } else if (["release", "block", "retire"].includes(change.action)) {
      await closeHistory(targets.filter((t) => t.status === "assigned").map((t) => t.id));
    }

    const clientIds = [...new Set(targets.map((t) => t.client_id).filter(Boolean))] as string[];
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: `telephony_numbers_${change.action}`,
      clientId:
        change.action === "assign" ? change.clientId : clientIds.length === 1 ? clientIds[0] : null,
      summary,
      detail: { numbers: targets.map((t) => t.number), ...(skipped ? { skipped } : {}) },
    });
    return { changed: targets.length, skipped };
  });

/** Who held a number, and when — for "whose borrower is calling this old number?". */
export const getNumberHistory = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, didId: idSchema }).parse(d))
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const { data: rows, error } = await db()
      .from("telephony_did_assignments")
      .select("client_id, assigned_at, released_at, clients(company_name)")
      .eq("did_id", data.didId)
      .order("assigned_at", { ascending: false });
    if (error) throw new Error(missing(error) ? NOT_APPLIED : error.message);
    return (
      (rows ?? []) as Array<{
        client_id: string;
        assigned_at: string;
        released_at: string | null;
        clients: { company_name: string } | null;
      }>
    ).map((r) => ({
      clientId: r.client_id,
      clientName: r.clients?.company_name ?? "—",
      assignedAt: r.assigned_at,
      releasedAt: r.released_at,
    }));
  });
