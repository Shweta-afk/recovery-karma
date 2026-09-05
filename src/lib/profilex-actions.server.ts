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
import { createClient } from "@supabase/supabase-js";
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
import { getService, priceFor, type DerivedFrom, type ProfilexService } from "./profilex/catalogue";

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

/**
 * A value produced by an earlier lookup on this same debtor — a UAN from Mobile to UAN, a GSTIN
 * from Mobile to GST. Employment and GST-contact services take these rather than a phone, so
 * this is the link that keeps them inside the "portfolio data only" rule: the value is read from
 * a stored trace, never accepted from the browser.
 */
async function derivedValue(debtorId: string, from: DerivedFrom): Promise<string | null> {
  const admin = db();
  const { data } = await admin
    .from("debtor_traces")
    .select("response")
    .eq("debtor_id", debtorId)
    .eq("service_id", from.service)
    .eq("state", "done")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const payload = (data?.response as Row | undefined)?.data as Row | undefined;
  return payload ? from.extract(payload) : null;
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

  const headers = {
    "client-user-id": clientUserId,
    "secret-key": secretKey,
    "access-key": accessKey,
    "service-id": service.serviceId,
    "Content-Type": "application/json",
  };

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

    // Resolve the input, still without trusting the browser for any of it.
    let requestBody: Record<string, string>;
    if (service.input === "mobile" || service.input === "mobile+name") {
      const mobile = normalisePhone(debtor.phone_primary as string);
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        throw new Error(
          `${debtor.name} has no valid mobile number on file, so there is nothing to look up.`,
        );
      }
      requestBody = { mobile };
      if (service.input === "mobile+name") {
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
        requestBody.lastName = parts.slice(1).join(" ");
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
    return await loadSettings(caller.clientId);
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
  .inputValidator((d: { accessToken: string; since?: string }) => d)
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
  .inputValidator(
    (d: { accessToken: string; since?: string; limit?: number; offset?: number }) => d,
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
