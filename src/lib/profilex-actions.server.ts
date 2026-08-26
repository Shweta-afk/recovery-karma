// ProfileX (Neokred) skip-tracing — the only place that spends money with the provider.
//
// Every paid request funnels through runProfilexTrace(), which enforces, in order: the caller
// is a manager/admin, the number being looked up belongs to a debtor in their own client's
// portfolio, a cached result isn't already on hand, and the monthly budget isn't spent. None of
// those can be enforced in the browser, and ProfileX has no balance API to fall back on — the
// `debtor_traces` ledger this writes is the only record that spend happened.
//
// Credentials are read from server env only; there is deliberately no VITE_ fallback, so they
// cannot end up in a client bundle. See .env.example for the four vars.
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import {
  extractPhones,
  normaliseBaseUrl,
  type Row,
  isHit,
  istMonthStart,
  normalisePhone,
  readProviderStatus,
} from "./profilex/billing";
import {
  PROFILEX_SERVICES,
  UAN_SOURCE_SERVICE,
  getService,
  priceFor,
  type ProfilexService,
} from "./profilex/catalogue";

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

/** One row of profilex_spend_report. Declared concretely because a server fn's return value is
 *  serialised across the wire, and an index-signature type there widens the whole result to
 *  `unknown` for callers. */
export interface ServiceSpendRow {
  service_id: string;
  calls: number;
  hits: number;
  misses: number;
  failures: number;
  spend: number;
}

interface ProfilexSettings {
  enabled: boolean;
  monthly_budget: number;
  hit_ttl_hours: number;
  miss_ttl_hours: number;
  rate_card: Record<string, Record<string, number>>;
}

const FALLBACK_SETTINGS: ProfilexSettings = {
  enabled: false,
  monthly_budget: 0,
  hit_ttl_hours: 720,
  miss_ttl_hours: 168,
  rate_card: {},
};

async function loadSettings(clientId: string): Promise<ProfilexSettings> {
  const admin = db();
  const { data } = await admin
    .from("profilex_settings")
    .select("enabled, monthly_budget, hit_ttl_hours, miss_ttl_hours, rate_card")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!data) return { ...FALLBACK_SETTINGS };
  return {
    enabled: !!data.enabled,
    monthly_budget: Number(data.monthly_budget ?? 0),
    hit_ttl_hours: Number(data.hit_ttl_hours ?? FALLBACK_SETTINGS.hit_ttl_hours),
    miss_ttl_hours: Number(data.miss_ttl_hours ?? FALLBACK_SETTINGS.miss_ttl_hours),
    rate_card: (data.rate_card as ProfilexSettings["rate_card"]) ?? {},
  };
}

/** The debtor's UAN, from a stored mobile-to-uan trace on that same debtor. Employment lookups
 *  take a UAN rather than a phone, so this is the link that keeps them inside the
 *  "portfolio numbers only" rule — a UAN is never accepted from the browser. */
async function storedUan(debtorId: string): Promise<string | null> {
  const admin = db();
  const { data } = await admin
    .from("debtor_traces")
    .select("response")
    .eq("debtor_id", debtorId)
    .eq("service_id", UAN_SOURCE_SERVICE)
    .eq("state", "done")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const uan = ((data?.response as Row | undefined)?.data as Row | undefined)?.uan;
  return uan ? String(uan) : null;
}

async function callProfilex(
  service: ProfilexService,
  body: Record<string, string>,
): Promise<{ httpStatus: number; json: Row | null; text: string }> {
  const base = normaliseBaseUrl(process.env.PROFILEX_BASE_URL);
  const clientUserId = process.env.PROFILEX_CLIENT_USER_ID;
  const secretKey = process.env.PROFILEX_SECRET_KEY;
  const accessKey = process.env.PROFILEX_ACCESS_KEY;

  if (!clientUserId || !secretKey || !accessKey) {
    throw new Error(
      "Insights is not configured. Set PROFILEX_CLIENT_USER_ID, PROFILEX_SECRET_KEY and " +
        "PROFILEX_ACCESS_KEY in the server environment (and in Railway for production).",
    );
  }

  const res = await fetch(`${base}${service.path}`, {
    method: "POST",
    headers: {
      "client-user-id": clientUserId,
      "secret-key": secretKey,
      "access-key": accessKey,
      "service-id": service.serviceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: Row | null = null;
  try {
    json = JSON.parse(text) as Row;
  } catch {
    // Left null — a non-JSON body means something upstream is broken, and the raw text is
    // preserved on the trace row so it can be diagnosed without re-running (and re-paying).
  }
  return { httpStatus: res.status, json, text };
}

export const runProfilexTrace = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { accessToken: string; debtorId: string; serviceId: string; force?: boolean }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can run a lookup");
    }

    const service = getService(data.serviceId);
    if (!service) throw new Error(`Unknown lookup service "${data.serviceId}"`);

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

    // Resolve the input, still without trusting the browser for either value.
    let requestBody: Record<string, string>;
    if (service.input === "mobile") {
      const mobile = normalisePhone(debtor.phone_primary as string);
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        throw new Error(
          `${debtor.name} has no valid mobile number on file, so there is nothing to look up.`,
        );
      }
      requestBody = { mobile };
    } else {
      const uan = await storedUan(debtor.id as string);
      if (!uan) {
        throw new Error(
          `No UAN on file for ${debtor.name}. Run "Mobile to UAN" first — it is free when ` +
            `nothing is found, and the employment lookups need the UAN it returns.`,
        );
      }
      requestBody = { uan };
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

    // Budget. Summed in SQL (see profilex_month_spend) so a truncated page of rows can't
    // under-report spend and wave a call through past the cap.
    if (settings.monthly_budget > 0) {
      const { data: spent, error: spendErr } = await admin.rpc("profilex_month_spend", {
        p_client_id: caller.clientId,
        p_since: istMonthStart().toISOString(),
      });
      if (spendErr) throw new Error(`Could not check the Insights budget (${spendErr.message})`);
      const spend = Number(spent ?? 0);
      if (spend >= settings.monthly_budget) {
        throw new Error(
          `This month's Insights budget is spent — ₹${spend.toFixed(2)} of ` +
            `₹${settings.monthly_budget.toFixed(2)}. An admin can raise it in Settings.`,
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

    let httpStatus = 0;
    let json: Row | null = null;
    let raw = "";
    try {
      ({ httpStatus, json, text: raw } = await callProfilex(service, requestBody));
    } catch (err) {
      // Never reached the provider, so nothing was billed. Record it and release the slot.
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
        error: httpStatus === 200 ? null : `HTTP ${httpStatus}: ${raw.slice(0, 500)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", pending.id)
      .select()
      .single();

    if (httpStatus !== 200) {
      // Spell out that this is a FAULT, not a "no record found". A real not-found comes back
      // HTTP 200 with provider status 2 and IS charged; a non-200 means the request never
      // reached a data source. Conflating the two is exactly the confusion this caused in
      // practice, so surface the provider's own message rather than just the status code.
      const providerMessage =
        typeof json?.message === "string" ? json.message : raw.slice(0, 200) || "no detail given";
      throw new Error(
        `The data provider rejected this request (HTTP ${httpStatus}: ${providerMessage}). ` +
          `This is a fault on their side, not a "nothing found" result — nothing was charged. ` +
          `If it persists, the account may not have access to this lookup.`,
      );
    }

    // Writeback: any dialable number the trace surfaced joins the debtor's alternate numbers so
    // it reaches the agent's dialer without anyone re-keying it. Deduped against the primary and
    // what's already stored. (Of the four services wired today only Employment History carries a
    // number, and often an empty one — this matters mainly for contact-returning services added
    // to the catalogue later.)
    const discovered = [...extractPhones(json)];
    if (discovered.length) {
      const primary = normalisePhone(debtor.phone_primary as string);
      const existing = ((debtor.alt_phones as string[] | null) ?? []).map(normalisePhone);
      const fresh = discovered.filter((p) => p !== primary && !existing.includes(p));
      if (fresh.length) {
        await admin
          .from("debtors")
          .update({ alt_phones: [...((debtor.alt_phones as string[] | null) ?? []), ...fresh] })
          .eq("id", debtor.id);
      }
    }

    return { trace: finished, cached: false, cost, discoveredPhones: discovered };
  });

/** Per-service spend for the admin report. SECURITY INVOKER on the RPC means the caller's own
 *  RLS still applies, so a manager sees their team's spend and an admin the whole client's. */
export const getProfilexSpend = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; since?: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view Insights spend");
    }
    const admin = db();
    const since = data.since ?? istMonthStart().toISOString();
    const [{ data: rows }, settings, { data: spent }] = await Promise.all([
      admin.rpc("profilex_spend_report", { p_since: since }),
      loadSettings(caller.clientId),
      admin.rpc("profilex_month_spend", { p_client_id: caller.clientId, p_since: since }),
    ]);
    return {
      since,
      byService: (rows as ServiceSpendRow[] | null) ?? [],
      totalSpend: Number(spent ?? 0),
      monthlyBudget: settings.monthly_budget,
    };
  });

export const getProfilexSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    return { ...(await loadSettings(caller.clientId)), services: PROFILEX_SERVICES };
  });

export const saveProfilexSettings = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      accessToken: string;
      enabled: boolean;
      monthlyBudget: number;
      hitTtlHours: number;
      missTtlHours: number;
      rateCard: Record<string, Record<string, number>>;
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    // Admin only: the budget cap is worthless if the people spending against it can raise it.
    if (caller.role !== "admin") throw new Error("Only admins can change Insights settings");

    const admin = db();
    const { error } = await admin.from("profilex_settings").upsert(
      {
        client_id: caller.clientId,
        enabled: data.enabled,
        monthly_budget: data.monthlyBudget,
        hit_ttl_hours: data.hitTtlHours,
        miss_ttl_hours: data.missTtlHours,
        rate_card: data.rateCard,
        updated_at: new Date().toISOString(),
        updated_by: caller.agentId ?? null,
      },
      { onConflict: "client_id" },
    );
    if (error) throw new Error(`Could not save Insights settings (${error.message})`);
    return { ok: true };
  });
