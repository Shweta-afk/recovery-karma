// ProfileX (Neokred) skip-tracing — the only place that spends money with the provider.
//
// Every paid request funnels through runProfilexTrace(), which enforces, in order: the caller
// is a manager/admin, the number being looked up belongs to a debtor in their own client's
// portfolio, a cached result isn't already on hand, and — for a manager — their own prepaid
// Insights wallet has enough left (migrations/20260907_profilex_manager_wallets.sql; admins
// aren't wallet-gated). None of those can be enforced in the browser, and ProfileX has no
// balance API to fall back on — the `debtor_traces` ledger this writes is the only record that
// spend happened.
//
// Credentials are read from server env only; there is deliberately no VITE_ fallback, so they
// cannot end up in a client bundle. See .env.example for the four vars.
import {
  z,
  tokenSchema,
  idSchema,
  shortText,
  isoDateSchema,
  limitSchema,
  offsetSchema,
  amountSchema,
} from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import {
  extractPhones,
  normaliseBaseUrl,
  type Row,
  isHit,
  istMonthStart,
  normalisePhone,
  readProviderStatus,
  phoneVariants,
  pickReusable,
  type ReuseCandidate,
} from "./profilex/billing";
import {
  LEGACY_SERVICE_IDS,
  getService,
  priceFor,
  type DerivedFrom,
  type ProfilexService,
} from "./profilex/catalogue";
import { toOutcomeRow, type OutcomeRpcRow } from "./profilex/outcome";
import { buildLoanLookupData, type LoanTraceInput } from "./profilex/loan-lookup-data";
import { fetchAllRows } from "./fetch-all-rows";

// This project has no generated Supabase `Database` types, so every `.from(...)` resolves to
// `never` and each column read is a type error (the older stores simply live with ~300 of
// them). Narrowing the client once here keeps that noise out of this file without pretending
// to a row typing we don't actually have.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST's fluent builder has
   no useful static type without generated Database types; the chain is `any` by necessity. */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
  rpc: (fn: string, args?: Row) => Promise<{ data: unknown; error: { message: string } | null }>;
}
const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;

/** A client authenticated AS THE CALLER (their own verified access token), for read-only report
 * RPCs that must stay scoped by RLS — as opposed to `db()`, which is service_role and bypasses
 * RLS entirely. Using `db()` for profilex_usage_by_user used to mean every manager/admin saw
 * EVERY client's ProfileX usage, since debtor_traces_select's client_id/team scoping only ever
 * fires under a real user's session, never under service_role. See
 * migrations/20260905_profilex_usage_detail.sql for the full story. */
function asCaller(accessToken: string): LooseDb {
  const url = typeof process !== "undefined" ? process.env?.SUPABASE_URL : undefined;
  const anonKey = typeof process !== "undefined" ? process.env?.SUPABASE_ANON_KEY : undefined;
  if (!url || !anonKey) {
    throw new Error("Missing SUPABASE_URL/SUPABASE_ANON_KEY (server env) for a caller-scoped read");
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  }) as unknown as LooseDb;
}

/** One row of profilex_spend_report. Declared concretely because a server fn's return value is
 *  serialised across the wire, and an index-signature type there widens the whole result to
 *  `unknown` for callers. */
/** One row of profilex_usage_by_user: a single user's activity on a single service. */
export interface UsageRow {
  agent_id: string | null;
  agent_name: string;
  agent_email: string;
  agent_role: string;
  service_id: string;
  lookups: number;
  hits: number;
  misses: number;
  failures: number;
  cached_reuses: number;
  debtors_touched: number;
  spend: number;
  last_used: string | null;
}

export interface ServiceSpendRow {
  service_id: string;
  calls: number;
  hits: number;
  misses: number;
  failures: number;
  spend: number;
}

export interface ProfilexSettings {
  enabled: boolean;
  monthly_budget: number;
  hit_ttl_hours: number;
  miss_ttl_hours: number;
  rate_card: Record<string, Record<string, number>>;
  /** The services this company may use, chosen by a superadmin. An allow-list: empty means
   *  none, never "all" — see migrations/20260917_profilex_enabled_services.sql. */
  enabled_services: string[];
}

const FALLBACK_SETTINGS: ProfilexSettings = {
  enabled: false,
  monthly_budget: 0,
  hit_ttl_hours: 720,
  miss_ttl_hours: 168,
  rate_card: {},
  enabled_services: [],
};

export async function loadSettings(clientId: string): Promise<ProfilexSettings> {
  const admin = db();
  let { data, error } = await admin
    .from("profilex_settings")
    .select("enabled, monthly_budget, hit_ttl_hours, miss_ttl_hours, rate_card, enabled_services")
    .eq("client_id", clientId)
    .maybeSingle();

  // Deployed before migrations/20260917_profilex_enabled_services.sql was applied: the column
  // does not exist, the select above errors, and `data` is null — which used to read as "no
  // settings" and switch Insights OFF for every company at once. Re-read without the column
  // and treat the company as being on the pre-plans service list, which is exactly what the
  // migration backfills, so behaviour is identical on either side of it.
  let enabledServices: string[] | null = null;
  if (error) {
    ({ data, error } = await admin
      .from("profilex_settings")
      .select("enabled, monthly_budget, hit_ttl_hours, miss_ttl_hours, rate_card")
      .eq("client_id", clientId)
      .maybeSingle());
    enabledServices = [...LEGACY_SERVICE_IDS];
  }

  if (!data) return { ...FALLBACK_SETTINGS };
  return {
    enabled: !!data.enabled,
    monthly_budget: Number(data.monthly_budget ?? 0),
    hit_ttl_hours: Number(data.hit_ttl_hours ?? FALLBACK_SETTINGS.hit_ttl_hours),
    miss_ttl_hours: Number(data.miss_ttl_hours ?? FALLBACK_SETTINGS.miss_ttl_hours),
    rate_card: (data.rate_card as ProfilexSettings["rate_card"]) ?? {},
    enabled_services:
      enabledServices ??
      (Array.isArray(data.enabled_services) ? (data.enabled_services as string[]) : []),
  };
}

/**
 * A value produced by an earlier lookup on this same debtor — a UAN from Mobile to UAN, a GSTIN
 * from Mobile to GST. Employment and GST-contact services take these rather than a phone, so
 * this is the link that keeps them inside the "portfolio data only" rule: the value is read from
 * a stored trace, never accepted from the browser.
 */
async function derivedValue(debtorId: string, from: DerivedFrom): Promise<string | null> {
  const admin = db();
  // Sources in catalogue order: the standalone service first, then any bundle that carries the
  // same block. The first one holding a value wins.
  for (const source of from.sources) {
    const { data } = await admin
      .from("debtor_traces")
      .select("response")
      .eq("debtor_id", debtorId)
      .eq("service_id", source.service)
      .eq("state", "done")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const payload = (data?.response as Row | undefined)?.data as Row | undefined;
    const value = payload ? source.extract(payload) : null;
    if (value) return value;
  }
  return null;
}

/** First and last four characters of an identifier — enough to compare against what the
 *  provider's console shows, without putting the value itself in a log or a database row.
 *  Never use this on secret-key/access-key; those are secrets, the client id is an identifier. */
function fingerprint(v: string | undefined): string {
  if (!v) return "(unset)";
  if (v.length <= 8) return "(too short)";
  // Length included so a stray character is visible: these ids are 36-char UUIDs, so anything
  // else means the value was pasted with whitespace or truncated.
  return `${v.slice(0, 4)}…${v.slice(-4)} len=${v.length}`;
}

/** Env values pasted into a dashboard routinely arrive with a trailing newline or space, and a
 *  credential header carrying one is rejected by the provider with the same opaque error as a
 *  wrong credential — indistinguishable, and not worth a second day of debugging. */
function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

async function callProfilex(
  service: ProfilexService,
  body: Record<string, string>,
): Promise<{ httpStatus: number; json: Row | null; text: string }> {
  const base = normaliseBaseUrl(env("PROFILEX_BASE_URL"));
  // Named for the console's own "Client Hash ID" field, because the field sitting next to it is
  // called "User Hash ID" and sending that one yields an error indistinguishable from having no
  // account access at all. Naming the variable after anything else invites picking the wrong
  // field, which is exactly what happened. PROFILEX_CLIENT_USER_ID is the legacy name, still
  // honoured so existing deployments keep working.
  const clientUserId = env("PROFILEX_CLIENT_HASH_ID") ?? env("PROFILEX_CLIENT_USER_ID");
  const secretKey = env("PROFILEX_SECRET_KEY");
  const accessKey = env("PROFILEX_ACCESS_KEY");

  if (!clientUserId || !secretKey || !accessKey) {
    throw new Error(
      "Insights is not configured. Set PROFILEX_CLIENT_HASH_ID, PROFILEX_SECRET_KEY and " +
        "PROFILEX_ACCESS_KEY in the server environment (and in Railway for production).",
    );
  }

  const headers: Record<string, string> = {
    "client-user-id": clientUserId,
    "secret-key": secretKey,
    "access-key": accessKey,
    "Content-Type": "application/json",
  };
  // Only when the service defines one: the skip-tracing bundles are called without it, and ANY
  // service-id sent to them is rejected as "Invalid service url".
  if (service.serviceId) headers["service-id"] = service.serviceId;

  // The provider intermittently returns HTTP 500 "You Dont Have UAT Access!!!" for a service
  // that works seconds earlier and seconds later — observed on employment-latest, which
  // succeeded 2 of 3 times in a row. Retrying costs NOTHING, because ProfileX bills on HTTP 200
  // only, so a spurious failure is free to absorb and an agent gets an answer instead of an
  // error they can do nothing about. A service genuinely not enabled fails all attempts and
  // still surfaces, just a couple of seconds later.
  const TRANSIENT = /UAT Access/i;
  const ATTEMPTS = 3;

  let res!: Response;
  let text = "";
  let json: Row | null = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    res = await fetch(`${base}${service.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    text = await res.text();
    json = null;
    try {
      json = JSON.parse(text) as Row;
    } catch {
      // Left null — a non-JSON body means something upstream is broken, and the raw text is
      // preserved on the trace row so it can be diagnosed without re-running (and re-paying).
    }

    const retryable =
      res.status === 500 && TRANSIENT.test(typeof json?.message === "string" ? json.message : text);
    if (!retryable || attempt === ATTEMPTS - 1) break;
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  return { httpStatus: res.status, json, text };
}

/** Any dialable number a trace surfaced joins the debtor's alternate numbers so it reaches the
 * agent's dialer without anyone re-keying it. Deduped against the primary and what's already
 * stored. Shared by a fresh lookup and a reused one — a reused result must still enrich the new
 * debtor row, which is the whole reason the agent asked. */
async function writebackPhones(
  admin: ReturnType<typeof db>,
  debtor: { id?: unknown; phone_primary?: unknown; alt_phones?: unknown },
  discovered: string[],
): Promise<void> {
  if (!discovered.length) return;
  const primary = normalisePhone(debtor.phone_primary as string);
  const existing = ((debtor.alt_phones as string[] | null) ?? []).map(normalisePhone);
  const fresh = discovered.filter((p) => p !== primary && !existing.includes(p));
  if (!fresh.length) return;
  await admin
    .from("debtors")
    .update({ alt_phones: [...((debtor.alt_phones as string[] | null) ?? []), ...fresh] })
    .eq("id", debtor.id as string);
}

/** Looks for a lookup this company already paid for on the same phone + service — first on other
 * debtor rows (an earlier upload of the same borrower), then in the monthly archive. Returns
 * null when nothing usable exists, including when the archive table has not been created yet
 * (code can deploy ahead of migrations/20260922_monthly_archive.sql). Reads only; the caller
 * records the copy. */
async function findReusableTrace(
  admin: ReturnType<typeof db>,
  a: {
    clientId: string;
    debtorId: string;
    debtorName: string | null;
    mobile: string;
    service: { id: string; input: string };
    settings: { hit_ttl_hours: number; miss_ttl_hours: number };
  },
): Promise<ReuseCandidate | null> {
  const nameSensitive = a.service.input === "mobile+name" || a.service.input === "mobile+firstName";
  const candidates: ReuseCandidate[] = [];

  const { data: live } = await admin
    .from("debtor_traces")
    .select(
      "id, transaction_id, provider_status, http_status, response, created_at, debtors!inner(name, phone_primary, client_id)",
    )
    .eq("client_id", a.clientId)
    .eq("service_id", a.service.id)
    .eq("state", "done")
    .neq("debtor_id", a.debtorId)
    .in("debtors.phone_primary", phoneVariants(a.mobile))
    .order("created_at", { ascending: false })
    .limit(25);
  for (const t of (live ?? []) as unknown as Array<Record<string, unknown>>) {
    // Skip copies. A copy is stamped with today's date, so reusing it would restart the freshness
    // clock: data bought on day 0 could be served on day 50 via a copy made on day 25. The
    // original purchase is always itself a candidate.
    if (String(t.transaction_id ?? "").startsWith("reused:")) continue;
    const debtors = t.debtors as { name: string | null } | null;
    candidates.push({
      id: t.id as string,
      source: "live",
      providerStatus: (t.provider_status as string | null) ?? null,
      createdAt: t.created_at as string,
      debtorName: debtors?.name ?? null,
      httpStatus: (t.http_status as number | null) ?? null,
      response: t.response,
    });
  }

  const { data: archived, error: archErr } = await admin
    .from("monthly_archive_rows")
    .select("source_id, occurred_at, data")
    .eq("client_id", a.clientId)
    .eq("kind", "trace")
    .eq("tag", a.service.id)
    .eq("phone_key", a.mobile)
    .order("occurred_at", { ascending: false })
    .limit(25);
  if (!archErr) {
    for (const r of (archived ?? []) as unknown as Array<Record<string, unknown>>) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      if (d.state !== "done") continue;
      if (String(d.transaction_id ?? "").startsWith("reused:")) continue; // see live loop above
      candidates.push({
        id: r.source_id as string,
        source: "archive",
        providerStatus: (d.provider_status as string | null) ?? null,
        createdAt: (r.occurred_at as string) ?? (d.created_at as string),
        debtorName: (d.debtor_name as string | null) ?? null,
        httpStatus: (d.http_status as number | null) ?? null,
        response: d.response,
      });
    }
  }

  return pickReusable(candidates, {
    hitTtlHours: a.settings.hit_ttl_hours,
    missTtlHours: a.settings.miss_ttl_hours,
    sameFirstNameAs: nameSensitive ? a.debtorName : undefined,
  });
}

export const runProfilexTrace = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        debtorId: idSchema,
        serviceId: shortText(64),
        force: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can run a lookup");
    }
    // Every lookup is billed per call, so cap the burst rate regardless of wallet balance.
    enforceRateLimit(`profilex-trace:${caller.authUserId}`, 30, 60_000);

    const service = getService(data.serviceId);
    if (!service) throw new Error(`Unknown lookup service "${data.serviceId}"`);
    // Defense in depth: trace-panel.tsx already hides a manualOnly service from the debtor Trace
    // tab, since nothing on a debtor row can supply its input (e.g. a DIN). Refuse it here too,
    // in case this is ever called directly.
    if (service.manualOnly) {
      throw new Error(`"${service.label}" can only be run from Admin > Insights.`);
    }

    const admin = db();

    // The "portfolio numbers only" boundary. The phone is read from the debtor's own row, and
    // the row must belong to the caller's client — nothing dialable is ever taken from the
    // request body, so there is no way to bill a lookup on a number we don't already hold.
    const { data: debtor, error: debtorErr } = await admin
      .from("debtors")
      .select("id, client_id, name, phone_primary, alt_phones")
      .eq("id", data.debtorId)
      .maybeSingle();
    if (debtorErr) throw new Error(`Could not load the debtor (${debtorErr.message})`);
    if (!debtor) throw new Error("That debtor no longer exists");
    if (debtor.client_id !== caller.clientId) {
      throw new Error("That debtor belongs to another organisation");
    }

    const settings = await loadSettings(caller.clientId);
    if (!settings.enabled) {
      throw new Error("Insights is turned off. An admin can enable it in Settings.");
    }
    // The superadmin's per-company choice. Enforced here, before anything can be charged, so a
    // hidden button is not the only thing keeping a company off a service it has not bought.
    if (!settings.enabled_services.includes(service.id)) {
      throw new Error(`"${service.label}" is not available on your company's Insights plan.`);
    }

    // Resolve the input, still without trusting the browser for any of it.
    let requestBody: Record<string, string>;
    const PHONE_INPUTS = ["mobile", "phone", "mobile+name", "mobile+firstName"];
    if (PHONE_INPUTS.includes(service.input)) {
      const mobile = normalisePhone(debtor.phone_primary as string);
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        throw new Error(
          `${debtor.name} has no valid mobile number on file, so there is nothing to look up.`,
        );
      }
      // Same number either way; a couple of endpoints just name the field `phone`.
      requestBody = service.input === "phone" ? { phone: mobile } : { mobile };
      if (service.input === "mobile+name" || service.input === "mobile+firstName") {
        // Split the stored name rather than asking for one: the provider requires firstName,
        // and anything typed in the browser would be an input we cannot vouch for.
        const parts = String(debtor.name ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (parts.length === 0) {
          throw new Error(`${debtor.name || "This debtor"} has no name on file to look up with.`);
        }
        requestBody.firstName = parts[0];
        // Send exactly the fields each endpoint documents — skip tracing takes firstName only.
        if (service.input === "mobile+name") requestBody.lastName = parts.slice(1).join(" ");
      }
    } else {
      const from = service.derivedFrom;
      if (!from) throw new Error(`"${service.label}" is misconfigured — no source for its input`);
      const value = await derivedValue(debtor.id as string, from);
      if (!value) {
        throw new Error(
          `No ${service.input.toUpperCase()} on file for ${debtor.name}. Run "${from.label}" ` +
            `first — the value it returns is what this lookup needs.`,
        );
      }
      requestBody = { [service.input]: value };
    }

    // Cache. A found result stays good for hit_ttl_hours, a miss for the shorter miss_ttl_hours,
    // so a dead lookup isn't re-purchased daily but can still refresh once data appears.
    if (!data.force) {
      const { data: prior } = await admin
        .from("debtor_traces")
        .select("*")
        .eq("debtor_id", debtor.id)
        .eq("service_id", service.id)
        .eq("state", "done")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prior) {
        const ttlHours = isHit(prior.provider_status as string | null)
          ? settings.hit_ttl_hours
          : settings.miss_ttl_hours;
        const ageMs = Date.now() - new Date(prior.created_at as string).getTime();
        if (ageMs < ttlHours * 3_600_000) {
          return { trace: prior, cached: true, cost: 0 };
        }
      }
    }

    // Same borrower, different upload. The per-debtor cache above is keyed by debtor_id, and a
    // re-uploaded portfolio gets brand-new debtor rows — so a borrower we already paid to look up
    // would be bought again. Look the phone up across the company's other debtor rows and the
    // monthly archive (which outlives deleted/closed portfolios) before spending anything.
    if (!data.force && PHONE_INPUTS.includes(service.input)) {
      const reused = await findReusableTrace(admin, {
        clientId: caller.clientId,
        debtorId: debtor.id as string,
        debtorName: debtor.name as string | null,
        mobile: normalisePhone(debtor.phone_primary as string),
        service,
        settings,
      });
      if (reused) {
        const { data: copy, error: copyErr } = await admin
          .from("debtor_traces")
          .insert({
            client_id: caller.clientId,
            debtor_id: debtor.id,
            service_id: service.id,
            requested_by: caller.agentId ?? null,
            state: "done",
            http_status: reused.httpStatus ?? 200,
            provider_status: reused.providerStatus,
            // Nothing was bought: cost 0 and not billable, so spend reports and wallets are
            // untouched and the row counts as a cached reuse (profilex_usage_by_user).
            billable: false,
            cost: 0,
            transaction_id: `reused:${reused.id}`,
            response: reused.response,
            completed_at: new Date().toISOString(),
          })
          .select()
          .single();
        if (copy) {
          const discovered = [...extractPhones(reused.response)];
          await writebackPhones(admin, debtor, discovered);
          return { trace: copy, cached: true, cost: 0, discoveredPhones: discovered };
        }
        // Could not record the copy — fall through and buy it rather than show the agent nothing.
        console.error("[profilex] reuse copy failed:", copyErr?.message);
      }
    }

    // Wallet. Managers spend from their own prepaid balance (migrations/20260907_profilex_
    // manager_wallets.sql) — replaces the old org-wide monthly_budget check. Admins are not
    // wallet-gated: they're the ones who fund every manager's wallet, so there is nothing to
    // check against. Pre-checked against the WORST-CASE price for this service — the real
    // provider status, and so the real cost, isn't known until after the call below, and
    // letting a lookup start only to fail on charging afterward would mean it already spent
    // real money with the provider with nothing to show for it in the manager's own balance.
    if (caller.role === "manager") {
      const { data: wallet, error: walletErr } = await admin
        .from("profilex_wallets")
        .select("balance")
        .eq("manager_id", caller.agentId)
        .maybeSingle();
      if (walletErr) throw new Error(`Could not check your Insights wallet (${walletErr.message})`);
      const balance = Number(wallet?.balance ?? 0);
      const worstCase = priceFor(service, null, settings.rate_card);
      if (balance < worstCase) {
        throw new Error(
          `Your Insights wallet has ₹${balance.toFixed(2)} left — this lookup can cost up to ` +
            `₹${worstCase.toFixed(2)}. Ask an admin to top it up in Settings.`,
        );
      }
    }

    // Release an abandoned claim first. If the process died between claiming the slot and
    // recording the outcome, the pending row would otherwise hold the unique index forever and
    // permanently block this debtor+service — the lock protecting spend would become a lockout.
    // Nothing legitimate takes minutes, so anything older is dead.
    const STALE_CLAIM_MS = 5 * 60 * 1000;
    await admin
      .from("debtor_traces")
      .update({
        state: "failed",
        error: "Abandoned — no response was recorded, so it is not counted as spend.",
        completed_at: new Date().toISOString(),
      })
      .eq("debtor_id", debtor.id)
      .eq("service_id", service.id)
      .eq("state", "pending")
      .lt("created_at", new Date(Date.now() - STALE_CLAIM_MS).toISOString());

    // Claim the in-flight slot before spending anything. The partial unique index on
    // (debtor_id, service_id) WHERE state = 'pending' means a double-click or a second manager
    // on the same debtor collides here instead of firing a second billable request.
    const { data: pending, error: claimErr } = await admin
      .from("debtor_traces")
      .insert({
        client_id: caller.clientId,
        debtor_id: debtor.id,
        service_id: service.id,
        requested_by: caller.agentId ?? null,
        state: "pending",
      })
      .select()
      .single();
    if (claimErr || !pending) {
      throw new Error(
        `A ${service.label} lookup is already running for ${debtor.name}. Give it a moment.`,
      );
    }

    // Hold the worst-case price in ONE conditional UPDATE (it cannot go below zero, and two
    // concurrent lookups cannot both spend the same funds — the read-then-charge check above is
    // only a friendly early message). Settled below with what the provider really billed.
    let held = 0;
    if (caller.role === "manager" && caller.agentId) {
      const worstCase = priceFor(service, null, settings.rate_card);
      const { data: ok, error: holdErr } = await admin.rpc("profilex_wallet_hold", {
        p_manager_id: caller.agentId,
        p_amount: worstCase,
      });
      if (holdErr || !ok) {
        await admin
          .from("debtor_traces")
          .update({
            state: "failed",
            error: holdErr
              ? `Wallet hold failed: ${holdErr.message}`
              : "Insufficient wallet balance",
            completed_at: new Date().toISOString(),
          })
          .eq("id", pending.id);
        throw new Error(
          holdErr
            ? `Could not reserve funds for this lookup (${holdErr.message})`
            : "Your Insights wallet does not have enough left for this lookup. Ask an admin to top it up in Settings.",
        );
      }
      held = worstCase;
    }
    /** Give back whatever part of the hold was not actually spent. Never throws. */
    const settle = async (cost: number) => {
      if (!held || !caller.agentId) return;
      const { error: settleErr } = await admin.rpc("profilex_wallet_settle", {
        p_manager_id: caller.agentId,
        p_hold: held,
        p_cost: Math.min(cost, held),
      });
      if (settleErr) console.error("[profilex] wallet settle failed:", settleErr.message);
    };

    let httpStatus = 0;
    let json: Row | null = null;
    let raw = "";
    try {
      ({ httpStatus, json, text: raw } = await callProfilex(service, requestBody));
    } catch (err) {
      // Never reached the provider, so nothing was billed. Record it, release the slot and the hold.
      await settle(0);
      await admin
        .from("debtor_traces")
        .update({
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
        })
        .eq("id", pending.id);
      throw err;
    }

    const providerStatus = readProviderStatus(json);
    // ProfileX's documented billing rule: HTTP 200 bills whether the record was found (status 1)
    // or not (status 2/3); a 500 does not. Anything else (auth failure, bad request) never
    // reached a data source, so it isn't billed either.
    const billable = httpStatus === 200;
    const cost = billable ? priceFor(service, providerStatus, settings.rate_card) : 0;

    const { data: finished } = await admin
      .from("debtor_traces")
      .update({
        state: httpStatus === 200 ? "done" : "failed",
        http_status: httpStatus,
        provider_status: providerStatus,
        billable,
        cost,
        transaction_id: (json?.transactionId as string | undefined) ?? null,
        response: json ?? { raw: raw.slice(0, 4000) },
        // Record WHICH client id produced a failure. The provider returns an identical error for
        // "no access" and "could not resolve your account from this id", so without this there is
        // no way to tell a genuine entitlement problem from a deployment still running a stale
        // env var — which is exactly the ambiguity that cost a day here, and Railway's variables
        // have silently drifted from local before.
        error:
          httpStatus === 200
            ? null
            : `HTTP ${httpStatus} [client-user-id ${fingerprint(process.env.PROFILEX_CLIENT_HASH_ID ?? process.env.PROFILEX_CLIENT_USER_ID) /* raw, NOT trimmed: the whole point is to expose a stray character */}]: ${raw.slice(0, 400)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", pending.id)
      .select()
      .single();

    // Settle the hold against what was actually billed — real cost, not the worst-case figure.
    // debtor_traces.cost stays the authoritative billing record (see profilex_spend_report).
    await settle(cost);

    // Deduct the REAL ProfileX price (catalogue.ts's defaultPrices, ignoring this client's own
    // rate_card override) from the superadmin's actual-balance wallet — the true remaining
    // balance with ProfileX/Neokred, tracked separately from what this company's own wallet was
    // just charged above. The two amounts can differ whenever a rate_card override exists, which
    // is the entire reason both wallets exist (20260910_profilex_actual_wallet.sql). Best-effort:
    // the real ProfileX call already happened and was already paid for by this point, so a
    // failure here must not fail the request.
    if (billable) {
      const realCost = priceFor(service, providerStatus, null);
      if (realCost > 0) {
        const { error: actualErr } = await admin.rpc("profilex_actual_wallet_charge", {
          p_amount: realCost,
          p_client_id: caller.clientId,
        });
        if (actualErr) console.error("[profilex] actual wallet charge failed:", actualErr.message);
      }
    }

    if (httpStatus !== 200) {
      // Spell out that this is a FAULT, not a "no record found". A real not-found comes back
      // HTTP 200 with provider status 2 and IS charged; a non-200 means the request never
      // reached a data source. Conflating the two is exactly the confusion this caused in
      // practice, so surface the provider's own message rather than just the status code.
      const providerMessage =
        typeof json?.message === "string" ? json.message : raw.slice(0, 200) || "no detail given";

      // The provider returns this same message for "your account cannot use this service" and
      // for "your credentials are wrong", with nothing to tell them apart. Since a wrong
      // credential fails EVERY service and this one is per-service, seeing it here almost always
      // means the service is not on the account — say that, rather than making a manager decode
      // "You Dont Have UAT Access!!!".
      if (/UAT Access/i.test(providerMessage)) {
        throw new Error(
          `"${service.label}" is not enabled on your account with the data provider, so this ` +
            `lookup cannot run. Nothing was charged. An admin needs to ask them to enable it — ` +
            `other lookups may still work.`,
        );
      }

      throw new Error(
        `The data provider rejected this request (HTTP ${httpStatus}: ${providerMessage}). ` +
          `This is a fault on their side, not a "nothing found" result — nothing was charged.`,
      );
    }

    // Writeback: any dialable number the trace surfaced joins the debtor's alternate numbers so
    // it reaches the agent's dialer without anyone re-keying it. Deduped against the primary and
    // what's already stored. (Of the four services wired today only Employment History carries a
    // number, and often an empty one — this matters mainly for contact-returning services added
    // to the catalogue later.)
    const discovered = [...extractPhones(json)];
    await writebackPhones(admin, debtor, discovered);

    return { trace: finished, cached: false, cost, discoveredPhones: discovered };
  });

/** Per-service spend for the admin report. SECURITY INVOKER on the RPC means the caller's own
 *  RLS still applies, so a manager sees their team's spend and an admin the whole client's. */
export const getProfilexSpend = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        since: isoDateSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view Insights spend");
    }
    const since = data.since ?? istMonthStart().toISOString();
    // The report RPC is SECURITY INVOKER, so it must run as the caller (asCaller) for RLS to
    // scope it — through the service-role client it saw every company's lookups. Manual admin
    // lookups are folded in by the RPC itself and are visible to admins only.
    const [{ data: rows }, settings] = await Promise.all([
      asCaller(data.accessToken).rpc("profilex_spend_report", { p_since: since }),
      loadSettings(caller.clientId),
    ]);
    const byService = (rows as ServiceSpendRow[] | null) ?? [];
    return {
      since,
      byService,
      // Summed from the same scoped rows, so the headline can never disagree with the table
      // (profilex_month_spend is company-wide and would count admin-only manual spend for a
      // manager).
      totalSpend: byService.reduce((n, r) => n + Number(r.spend), 0),
      monthlyBudget: settings.monthly_budget,
    };
  });

/** Read-only for a company admin — they can see their current Insights configuration (whether
 * it's on, the rate card, the TTLs) but can no longer change it; see the note on
 * superadmin-actions.server.ts's saveCompanyProfilexSettings for why that moved to
 * superadmin-only. */
export const getProfilexSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    return await loadSettings(caller.clientId);
  });

/** A manager's own Insights wallet balance — what the Trace tab shows them before they run a
 * lookup. Admins get null (they aren't wallet-gated — see runProfilexTrace). */
export const getMyWallet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager") return { balance: null };
    const admin = db();
    const { data: wallet, error } = await admin
      .from("profilex_wallets")
      .select("balance")
      .eq("manager_id", caller.agentId)
      .maybeSingle();
    if (error) throw new Error(`Could not load your Insights wallet (${error.message})`);
    return { balance: Number(wallet?.balance ?? 0) };
  });

/** One row of getManagerWallets: a manager and their current Insights wallet balance. */
export interface ManagerWalletRow {
  manager_id: string;
  name: string;
  email: string;
  balance: number;
  updated_at: string | null;
}

/** Every manager in the admin's client, with their wallet balance (0 for one that's never been
 * funded — no profilex_wallets row exists until the first top-up). Admin only. */
export const getManagerWallets = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") throw new Error("Only admins can view manager wallets");
    const admin = db();
    const [{ data: managers, error: mErr }, { data: wallets, error: wErr }] = await Promise.all([
      admin
        .from("agents")
        .select("id, name, email")
        .eq("client_id", caller.clientId)
        .eq("role", "manager"),
      admin
        .from("profilex_wallets")
        .select("manager_id, balance, updated_at")
        .eq("client_id", caller.clientId),
    ]);
    if (mErr) throw new Error(`Could not load managers (${mErr.message})`);
    if (wErr) throw new Error(`Could not load wallets (${wErr.message})`);
    const balanceByManager = new Map(
      ((wallets ?? []) as { manager_id: string; balance: number; updated_at: string }[]).map(
        (w) => [w.manager_id, w],
      ),
    );
    const rows: ManagerWalletRow[] = (
      (managers ?? []) as { id: string; name: string; email: string }[]
    )
      .map((m) => ({
        manager_id: m.id,
        name: m.name,
        email: m.email,
        balance: Number(balanceByManager.get(m.id)?.balance ?? 0),
        updated_at: balanceByManager.get(m.id)?.updated_at ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { rows };
  });

/** This company's own ProfileX budget — the ceiling on what its admin can hand out to managers
 * (see 20260909_superadmin_and_wallets.sql: it can only ever grow via a superadmin allocation).
 * Admin only. */
export const getCompanyWallet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") return { balance: null };
    const admin = db();
    const { data: wallet, error } = await admin
      .from("profilex_company_wallets")
      .select("balance, updated_at")
      .eq("client_id", caller.clientId)
      .maybeSingle();
    if (error) throw new Error(`Could not load your company's Insights budget (${error.message})`);
    return { balance: Number(wallet?.balance ?? 0), updatedAt: wallet?.updated_at ?? null };
  });

/** Tops up one manager's Insights wallet by `amount`, drawn from this company's own wallet — an
 * admin can never hand out more than their company was allocated by the superadmin. Replaces
 * the old setManagerWallet, which upserted any balance with no ceiling at all. Admin only. */
export const allocateToManager = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        managerId: idSchema,
        amount: amountSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") throw new Error("Only admins can top up a manager's wallet");
    if (!(data.amount > 0)) throw new Error("Enter a positive amount to add");

    const admin = db();
    // Confirm the manager is actually this admin's own, not an id from another client passed by
    // a tampered request — client_id passed to the RPC must come from a verified lookup, never
    // trusted from the browser.
    const { data: manager, error: mErr } = await admin
      .from("agents")
      .select("id, client_id, role")
      .eq("id", data.managerId)
      .maybeSingle();
    if (mErr) throw new Error(`Could not verify that manager (${mErr.message})`);
    if (!manager || manager.client_id !== caller.clientId || manager.role !== "manager") {
      throw new Error("That manager was not found in your organisation");
    }

    const { data: newBalance, error } = await admin.rpc("profilex_company_allocate", {
      p_client_id: caller.clientId,
      p_manager_id: data.managerId,
      p_amount: data.amount,
      p_admin_id: caller.agentId,
      p_note: null,
    });
    if (error) {
      if (/insufficient/i.test(error.message)) {
        throw new Error("Your company's Insights budget doesn't have enough left for that top-up.");
      }
      throw new Error(`Could not update the wallet (${error.message})`);
    }
    return { balance: Number(newBalance) };
  });

/**
 * Who has been running lookups, and what it cost — the question an admin actually has when the
 * monthly bill lands. Returns one row per user per service; the caller aggregates for the
 * top-level view and reuses the same rows for the drill-down.
 *
 * Called via asCaller(), not db() — the RPC is SECURITY INVOKER so debtor_traces' own policy
 * scopes this (an admin sees their whole client, a manager only their own team) ONLY when it
 * actually runs as that real, RLS-bound session. Running it through the service-role admin
 * client used to bypass that scoping entirely (service_role has BYPASSRLS) — every manager/
 * admin saw every client's usage. See migrations/20260905_profilex_usage_detail.sql.
 */
export const getProfilexUsage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        since: isoDateSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view Insights usage");
    }
    const asUser = asCaller(data.accessToken);
    const since = data.since ?? istMonthStart().toISOString();
    const { data: rows, error } = await asUser.rpc("profilex_usage_by_user", { p_since: since });
    if (error) throw new Error(`Could not load Insights usage (${error.message})`);
    return { since, rows: (rows as UsageRow[] | null) ?? [] };
  });

/** One row of profilex_usage_detail: a single lookup, who ran it, and which debtor it was for
 * — the detail behind the per-agent/per-service totals above, so "where did an agent use
 * Insights" has an actual answer instead of only a monthly aggregate. */
export interface UsageDetailRow {
  trace_id: string;
  created_at: string;
  agent_name: string;
  agent_email: string;
  debtor_id: string;
  debtor_name: string;
  loan_reference: string;
  service_id: string;
  provider_status: string | null;
  billable: boolean;
  cost: number;
  state: string;
}

/** Same RLS-scoping requirement as getProfilexUsage above — asCaller(), never db(). */
export const getProfilexUsageDetail = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        since: isoDateSchema.optional(),
        limit: limitSchema.optional(),
        offset: offsetSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view Insights usage");
    }
    const asUser = asCaller(data.accessToken);
    const since = data.since ?? istMonthStart().toISOString();
    const { data: rows, error } = await asUser.rpc("profilex_usage_detail", {
      p_since: since,
      p_limit: data.limit ?? 200,
      p_offset: data.offset ?? 0,
    });
    if (error) throw new Error(`Could not load Insights detail log (${error.message})`);
    return { since, rows: (rows as UsageDetailRow[] | null) ?? [] };
  });

/**
 * Every lookup with what happened on the account afterwards — see
 * migrations/20260927_insights_outcome_report.sql and src/lib/profilex/outcome.ts. Same
 * RLS-scoping rule as the two reports above: asCaller(), never db(). The raw provider responses
 * are reduced to a summary here, server-side, so kilobytes per lookup never reach the browser.
 */
export const getInsightsOutcomeReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        since: isoDateSchema.optional(),
        until: isoDateSchema.optional(),
        managerId: idSchema.optional(),
        portfolioId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view Insights reports");
    }
    const asUser = asCaller(data.accessToken);
    const since = data.since ?? istMonthStart().toISOString();
    const { data: rows, error } = await asUser.rpc("insights_outcome_report", {
      p_since: since,
      p_until: data.until ?? null,
      p_manager_id: data.managerId ?? null,
      p_portfolio_id: data.portfolioId ?? null,
      p_limit: OUTCOME_REPORT_LIMIT,
    });
    if (error) {
      throw new Error(
        /insights_outcome_report/.test(error.message)
          ? "The outcome report isn't set up yet — run migrations/20260927_insights_outcome_report.sql"
          : `Could not load the Insights outcome report (${error.message})`,
      );
    }
    const list = ((rows as OutcomeRpcRow[] | null) ?? []).map(toOutcomeRow);
    return { since, rows: list, truncated: list.length >= OUTCOME_REPORT_LIMIT };
  });

const OUTCOME_REPORT_LIMIT = 5000;

/** Portfolios the caller can see, for the "Lookup data by Loan ID" picker. RLS-scoped. */
export const listInsightsPortfolios = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view Insights reports");
    }
    const { data: rows, error } = await asCaller(data.accessToken)
      .from("portfolios")
      .select("id, name, lender_name, product_type, closed_at")
      .order("uploaded_at", { ascending: false });
    if (error) throw new Error(`Could not load portfolios (${error.message})`);
    return {
      portfolios: ((rows ?? []) as Row[]).map((p) => ({
        id: String(p.id),
        name: String(p.name ?? ""),
        lender: String(p.lender_name ?? ""),
        product: String(p.product_type ?? ""),
        closed: !!p.closed_at,
      })),
    };
  });

/** Every lookup on one portfolio, merged per loan — see src/lib/profilex/loan-lookup-data.ts.
 * Read as the caller so RLS decides which accounts are included (a manager: their own team's).
 * All lookups ever run on the portfolio, not a period: this is the portfolio's saved Insights
 * data, not an activity report. */
async function loadPortfolioLookupData(accessToken: string, portfolioId: string) {
  const asUser = asCaller(accessToken);
  const read = (extraCol: "extra_named" | "extra") =>
    fetchAllRows<Row>((from, to) =>
      asUser
        .from("debtor_traces")
        .select(
          `id, debtor_id, service_id, state, provider_status, billable, cost, created_at, response,
           debtors!inner(name, loan_reference, phone_primary, email, portfolio_id, ${extraCol})`,
        )
        .eq("debtors.portfolio_id", portfolioId)
        .in("state", ["done", "failed"])
        .order("created_at", { ascending: false })
        .range(from, to),
    );
  // extra_named is a computed column (20260923_debtors_extra_preview.sql); fall back to the
  // full bag if this runs against a database without it, like debtor-extra.ts does.
  let res = await read("extra_named");
  if (res.error && /extra_named/.test(res.error.message)) res = await read("extra");
  if (res.error) throw new Error(`Could not load lookup data (${res.error.message})`);

  const traces: LoanTraceInput[] = res.data.map((t) => {
    const d = (t.debtors ?? {}) as Row;
    const extra = (d.extra_named ?? d.extra ?? {}) as Record<string, unknown>;
    return {
      traceId: String(t.id),
      debtorId: String(t.debtor_id),
      serviceId: String(t.service_id),
      state: String(t.state),
      providerStatus: (t.provider_status as string | null) ?? null,
      billable: !!t.billable,
      cost: Number(t.cost ?? 0),
      createdAt: String(t.created_at),
      response: t.response,
      loanReference: String(d.loan_reference ?? ""),
      name: String(d.name ?? ""),
      phonePrimary: String(d.phone_primary ?? ""),
      email: (d.email as string | null) ?? null,
      bankExtra: Object.fromEntries(
        ["address", "city", "state", "dob", "employer"].map((k) => [k, String(extra[k] ?? "")]),
      ),
    };
  });
  return buildLoanLookupData(traces);
}

async function requireReportCaller(accessToken: string) {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  if (caller.role !== "manager" && caller.role !== "admin") {
    throw new Error("Only managers or admins can view Insights reports");
  }
  return caller;
}

/** The on-screen view: one row per loan. The per-lookup "All fields" detail is deliberately NOT
 * returned here — it only leaves the server through getPortfolioLookupExport, which is gated. */
export const getPortfolioLookupData = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, portfolioId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireReportCaller(data.accessToken);
    const { rows } = await loadPortfolioLookupData(data.accessToken, data.portfolioId);
    return { rows };
  });

// ── Lookup-data Excel: request-only unless the company is exempt ─────────────────────────────
// migrations/20260927_insights_export_requests.sql. A company asks, a superadmin approves
// (superadmin-actions.server.ts), and the approval opens that portfolio's download for
// EXPORT_APPROVAL_DAYS. profilex_settings.direct_export skips the request (the platform's own
// company). All reads/writes use the service role, after the caller checks here.

export const EXPORT_APPROVAL_DAYS = 7;

export interface LookupExportRequest {
  id: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  downloadCount: number;
}

export interface LookupExportStatus {
  /** The company may download without asking. */
  direct: boolean;
  /** Latest request for this portfolio, if any. */
  request: LookupExportRequest | null;
  canDownload: boolean;
}

async function readDirectExport(clientId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("profilex_settings")
    .select("direct_export")
    .eq("client_id", clientId)
    .maybeSingle();
  // Column missing (code ahead of the migration) reads as "must request" — fail closed.
  if (error || !data) return false;
  return !!data.direct_export;
}

async function exportStatus(clientId: string, portfolioId: string): Promise<LookupExportStatus> {
  const direct = await readDirectExport(clientId);
  const { data } = await db()
    .from("insights_export_requests")
    .select("id, status, note, created_at, decided_at, decision_note, expires_at, download_count")
    .eq("client_id", clientId)
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const r = data as Row | null;
  const request: LookupExportRequest | null = r
    ? {
        id: String(r.id),
        status: r.status as LookupExportRequest["status"],
        note: (r.note as string | null) ?? null,
        createdAt: String(r.created_at),
        decidedAt: (r.decided_at as string | null) ?? null,
        decisionNote: (r.decision_note as string | null) ?? null,
        expiresAt: (r.expires_at as string | null) ?? null,
        downloadCount: Number(r.download_count ?? 0),
      }
    : null;
  const approvedNow =
    request?.status === "approved" &&
    !!request.expiresAt &&
    new Date(request.expiresAt).getTime() > Date.now();
  return { direct, request, canDownload: direct || approvedNow };
}

/** The portfolio must be one the caller can see — checked as the caller, so RLS decides. */
async function requireVisiblePortfolio(accessToken: string, portfolioId: string): Promise<void> {
  const { data, error } = await asCaller(accessToken)
    .from("portfolios")
    .select("id")
    .eq("id", portfolioId)
    .maybeSingle();
  if (error) throw new Error(`Could not check the portfolio (${error.message})`);
  if (!data) throw new Error("Portfolio not found");
}

export const getLookupExportStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, portfolioId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<LookupExportStatus> => {
    const caller = await requireReportCaller(data.accessToken);
    await requireVisiblePortfolio(data.accessToken, data.portfolioId);
    return exportStatus(caller.clientId, data.portfolioId);
  });

export const requestLookupExport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        portfolioId: idSchema,
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<LookupExportStatus> => {
    const caller = await requireReportCaller(data.accessToken);
    await requireVisiblePortfolio(data.accessToken, data.portfolioId);
    const current = await exportStatus(caller.clientId, data.portfolioId);
    if (current.canDownload || current.request?.status === "pending") return current;
    const { error } = await db()
      .from("insights_export_requests")
      .insert({
        client_id: caller.clientId,
        portfolio_id: data.portfolioId,
        requested_by: caller.agentId,
        note: data.note || null,
      });
    // 23505: someone else's request landed first (one pending per portfolio) — that's fine.
    if (error && !/duplicate key|23505/.test(error.message)) {
      throw new Error(`Could not send the request (${error.message})`);
    }
    return exportStatus(caller.clientId, data.portfolioId);
  });

/** The full Excel data (per-loan rows + every field of every lookup). Refused unless the company
 * is exempt or holds an approved, unexpired request for this portfolio; each download is
 * counted on the request. */
export const getPortfolioLookupExport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, portfolioId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireReportCaller(data.accessToken);
    await requireVisiblePortfolio(data.accessToken, data.portfolioId);
    const status = await exportStatus(caller.clientId, data.portfolioId);
    if (!status.canDownload) {
      throw new Error("This download needs approval — request it first");
    }
    const result = await loadPortfolioLookupData(data.accessToken, data.portfolioId);
    if (!status.direct && status.request) {
      await db()
        .from("insights_export_requests")
        .update({
          download_count: status.request.downloadCount + 1,
          last_download_at: new Date().toISOString(),
        })
        .eq("id", status.request.id);
    }
    return result;
  });

// ── Admin > Insights: lookups typed in by hand ───────────────────────────────────────────────
// runProfilexTrace deliberately never takes a number from the browser. This is the one place
// that does, and it is admin-only: the admin types the mobile (or UAN / GSTIN) themselves. Every
// other guardrail carries over — the company's Insights switch and plan, the rate limit, the
// in-flight lock, and the real-price charge to the superadmin's actual wallet. Admins are not
// wallet-gated, same as runProfilexTrace. Results go to insights_manual_lookups, not
// debtor_traces (no debtor to hang them on), and nothing is written back to any debtor.

const UAN_RE = /^\d{12}$/;
const GSTIN_RE = /^[0-9A-Z]{15}$/;
const DIN_RE = /^\d{8}$/;

export const runManualInsight = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        serviceId: shortText(64),
        /** Mobile number, UAN or GSTIN — whichever the chosen service takes. */
        value: shortText(40),
        firstName: z.string().trim().max(80).optional(),
        lastName: z.string().trim().max(80).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") throw new Error("Only admins can run a manual lookup");
    enforceRateLimit(`profilex-manual:${caller.authUserId}`, 20, 60_000);

    const service = getService(data.serviceId);
    if (!service) throw new Error(`Unknown lookup service "${data.serviceId}"`);

    const settings = await loadSettings(caller.clientId);
    if (!settings.enabled) {
      throw new Error("Insights is turned off for your company. Ask your platform contact.");
    }
    if (!settings.enabled_services.includes(service.id)) {
      throw new Error(`"${service.label}" is not available on your company's Insights plan.`);
    }

    // Build the request body from what was typed, validating each shape before any money moves.
    let requestBody: Record<string, string>;
    let queryKey: string;
    if (["mobile", "phone", "mobile+name", "mobile+firstName"].includes(service.input)) {
      const mobile = normalisePhone(data.value);
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        throw new Error("Enter a valid 10-digit Indian mobile number (starting 6–9).");
      }
      queryKey = mobile;
      requestBody = service.input === "phone" ? { phone: mobile } : { mobile };
      if (service.input === "mobile+name" || service.input === "mobile+firstName") {
        const first = data.firstName?.trim();
        if (!first) throw new Error(`"${service.label}" also needs the person's first name.`);
        requestBody.firstName = first;
        if (service.input === "mobile+name") requestBody.lastName = data.lastName?.trim() ?? "";
      }
    } else if (service.input === "uan") {
      const uan = data.value.replace(/\s+/g, "");
      if (!UAN_RE.test(uan)) throw new Error("A UAN is 12 digits.");
      queryKey = uan;
      requestBody = { uan };
    } else if (service.input === "gstin") {
      const gstin = data.value.replace(/\s+/g, "").toUpperCase();
      if (!GSTIN_RE.test(gstin)) throw new Error("A GSTIN is 15 letters and digits.");
      queryKey = gstin;
      requestBody = { gstin };
    } else {
      // service.input === "din" — the only other case a manual lookup can be.
      const din = data.value.replace(/\s+/g, "");
      if (!DIN_RE.test(din)) throw new Error("A DIN is 8 digits.");
      queryKey = din;
      requestBody = { din };
    }

    const admin = db();

    // Release an abandoned claim, then take the in-flight slot — see runProfilexTrace.
    await admin
      .from("insights_manual_lookups")
      .update({
        state: "failed",
        error: "Abandoned — no response was recorded, so it is not counted as spend.",
        completed_at: new Date().toISOString(),
      })
      .eq("client_id", caller.clientId)
      .eq("service_id", service.id)
      .eq("query_key", queryKey)
      .eq("state", "pending")
      .lt("created_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

    const { data: pending, error: claimErr } = await admin
      .from("insights_manual_lookups")
      .insert({
        client_id: caller.clientId,
        service_id: service.id,
        requested_by: caller.agentId ?? null,
        query_key: queryKey,
        input: requestBody,
        state: "pending",
      })
      .select()
      .single();
    if (claimErr || !pending) {
      throw new Error(`A ${service.label} lookup for that value is already running.`);
    }

    let httpStatus = 0;
    let json: Row | null = null;
    let raw = "";
    try {
      ({ httpStatus, json, text: raw } = await callProfilex(service, requestBody));
    } catch (err) {
      await admin
        .from("insights_manual_lookups")
        .update({
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
        })
        .eq("id", pending.id);
      throw err;
    }

    const providerStatus = readProviderStatus(json);
    const billable = httpStatus === 200;
    const cost = billable ? priceFor(service, providerStatus, settings.rate_card) : 0;

    const { data: finished } = await admin
      .from("insights_manual_lookups")
      .update({
        state: billable ? "done" : "failed",
        http_status: httpStatus,
        provider_status: providerStatus,
        billable,
        cost,
        transaction_id: (json?.transactionId as string | undefined) ?? null,
        response: json ?? { raw: raw.slice(0, 4000) },
        error: billable ? null : `HTTP ${httpStatus}: ${raw.slice(0, 400)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", pending.id)
      .select()
      .single();

    if (billable) {
      const realCost = priceFor(service, providerStatus, null);
      if (realCost > 0) {
        const { error: actualErr } = await admin.rpc("profilex_actual_wallet_charge", {
          p_amount: realCost,
          p_client_id: caller.clientId,
        });
        if (actualErr) console.error("[profilex] actual wallet charge failed:", actualErr.message);
      }
    }

    if (!billable) {
      const providerMessage =
        typeof json?.message === "string" ? json.message : raw.slice(0, 200) || "no detail given";
      if (/UAT Access/i.test(providerMessage)) {
        throw new Error(
          `"${service.label}" is not enabled on the data provider account, so this lookup cannot ` +
            `run. Nothing was charged.`,
        );
      }
      throw new Error(
        `The data provider rejected this request (HTTP ${httpStatus}: ${providerMessage}). ` +
          `Nothing was charged.`,
      );
    }

    return { lookup: finished, cost };
  });

/** The company's manual lookups, newest first. Admin only. */
export const listManualInsights = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, limit: limitSchema.optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") throw new Error("Only admins can view manual lookups");
    const { data: rows, error } = await db()
      .from("insights_manual_lookups")
      .select(
        "id, service_id, query_key, input, state, provider_status, cost, response, error, created_at",
      )
      .eq("client_id", caller.clientId)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);
    if (error) throw new Error(`Could not load lookups (${error.message})`);
    return {
      rows: (rows as ManualLookupRow[] | null) ?? [],
      settings: await loadSettings(caller.clientId),
    };
  });

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ManualLookupRow {
  id: string;
  service_id: string;
  query_key: string;
  input: Record<string, string>;
  state: "pending" | "done" | "failed";
  provider_status: string | null;
  cost: number;
  response: Json | null;
  error: string | null;
  created_at: string;
}
