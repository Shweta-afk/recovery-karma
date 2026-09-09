// Superadmin server actions — companies, users, and the ProfileX wallet ledger, all read via
// the service-role client (never the RLS-governed browser client). See
// 20260909_superadmin_and_wallets.sql: `superadmins` and `profilex_master_wallet` have no RLS
// policy at all, so this file is the ONLY place that can ever read them. Every handler except
// resolveSuperadmin calls verifySuperadminCaller first and throws if it returns null — same
// chokepoint discipline supabase-admin.server.ts documents for verifyCaller.

import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { loadSettings, type ProfilexSettings } from "./profilex-actions.server";

function db() {
  return getSupabaseAdmin();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Bootstrap tool for creating a superadmin account — modeled on setup-actions.server.ts's
 *  createCompany, but gated more tightly: a superadmin reaches every company on the platform,
 *  so unlike company setup this can't stay open forever just because the route is unlinked.
 *  Once at least one superadmin row exists, creating another REQUIRES the caller to already be
 *  a verified superadmin (accessToken must resolve via verifySuperadminCaller). Only the very
 *  first superadmin — when the table is empty — can be created without that, the same one-time
 *  bootstrap gap createCompany accepts for a brand-new company's first admin. Keep this route
 *  unlinked from anything customer-facing regardless.
 *
 *  If the email already has an auth login (typically an existing company agent/manager/admin
 *  who should also be a superadmin), this LINKS the new superadmins row to that same auth
 *  account instead of failing — one login, both identities. See the inline comment below for
 *  why that's safe only once the bootstrap gap above has closed. */
export const createSuperadmin = createServerFn({ method: "POST" })
  .inputValidator((d: { name: string; email: string; password: string; accessToken?: string }) => d)
  .handler(async ({ data }) => {
    const name = data.name.trim();
    const email = data.email.trim().toLowerCase();
    const password = data.password;

    if (!name || !email) return { ok: false as const, error: "Fill in all fields." };
    if (!EMAIL_RE.test(email)) return { ok: false as const, error: "Enter a valid email address." };
    if (password.length < 8) {
      return { ok: false as const, error: "Password must be at least 8 characters." };
    }

    const admin = db();

    const { count, error: countErr } = await admin
      .from("superadmins")
      .select("id", { count: "exact", head: true });
    if (countErr)
      return { ok: false as const, error: `Could not verify setup state (${countErr.message})` };

    if ((count ?? 0) > 0) {
      const caller = data.accessToken ? await verifySuperadminCaller(data.accessToken) : null;
      if (!caller) {
        return {
          ok: false as const,
          error: "A superadmin already exists — sign in as one to create another.",
        };
      }
    }

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    let authUserId: string;
    if (authErr || !authData.user) {
      const msg = authErr?.message ?? "";
      if (!/already.*registered|already exists/i.test(msg)) {
        return { ok: false as const, error: msg || "Could not create the login." };
      }
      // This email already has an auth login — most commonly because it's an existing company
      // agent/manager/admin who should ALSO be a superadmin (a platform owner who also holds a
      // seat somewhere), rather than needing a second, separate login. Link the superadmin row
      // to that SAME auth account instead of failing outright; auth.tsx already resolves
      // superadmin status ahead of any agents row on login, so this makes the one login work
      // for both. We deliberately do NOT verify the submitted password against that existing
      // account — reachable only once the bootstrap gap above has already closed (an existing
      // verified superadmin caller), the same trust level that already lets a superadmin do
      // anything else in this file.
      const { data: existingAgent } = await admin
        .from("agents")
        .select("auth_user_id")
        .eq("email", email)
        .maybeSingle();
      const { data: existingSuperadmin } = await admin
        .from("superadmins")
        .select("auth_user_id")
        .eq("email", email)
        .maybeSingle();
      const linkedId =
        (existingAgent as { auth_user_id: string } | null)?.auth_user_id ??
        (existingSuperadmin as { auth_user_id: string } | null)?.auth_user_id ??
        null;
      if (!linkedId) {
        return {
          ok: false as const,
          error: "That email already has an account we couldn't find a matching user for.",
        };
      }
      if (existingSuperadmin) {
        return { ok: false as const, error: "That email is already a superadmin." };
      }
      authUserId = linkedId;
    } else {
      authUserId = authData.user.id;
    }
    // Only roll back by DELETING the auth user when this handler just created it — deleting a
    // pre-existing account (the linked-existing-email path above) because the superadmins
    // insert happened to fail would destroy that person's whole login, not just this action.
    const justCreatedAuthUser = !authErr && !!authData?.user;

    const { error: insertErr } = await admin.from("superadmins").insert({
      auth_user_id: authUserId,
      name,
      email,
    });
    if (insertErr) {
      if (justCreatedAuthUser) {
        await admin.auth.admin.deleteUser(authUserId).catch((err) => {
          console.error(
            `[createSuperadmin] failed to roll back orphaned auth user ${authUserId}:`,
            err,
          );
        });
      }
      return {
        ok: false as const,
        error: /duplicate key|already exists/i.test(insertErr.message)
          ? "That email already has an account."
          : insertErr.message,
      };
    }

    return { ok: true as const, authUserId };
  });

/** Called from auth.tsx during login/session-resolve, for ANY signed-in user — not gated,
 *  since the whole point is finding out whether this auth user is a superadmin. Returns
 *  { superadmin: null } rather than throwing when they aren't, so a normal agent/manager/admin
 *  login is unaffected. */
export const resolveSuperadmin = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) return { superadmin: null };
    return { superadmin: { id: caller.superadminId, name: caller.name, email: caller.email } };
  });

export interface CompanyRow {
  id: string;
  companyName: string;
  plan: string;
  createdAt: string;
  adminCount: number;
  managerCount: number;
  agentCount: number;
  walletBalance: number;
  status: "pending" | "approved" | "rejected";
  subdomain: string | null;
  /** Every admin's email at this company — who to actually contact/vet before approving.
   *  Almost always exactly one, since a company has only its founding admin at signup. */
  adminEmails: string[];
}

/** Every company, with role counts and its ProfileX company-wallet balance — the "see users of
 *  each company, admins, managers" overview. */
export const getCompanies = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();

    const [
      { data: clients, error: cErr },
      { data: agents, error: aErr },
      { data: wallets, error: wErr },
    ] = await Promise.all([
      admin.from("clients").select("id, company_name, plan, created_at, status, subdomain"),
      admin.from("agents").select("client_id, role, email"),
      admin.from("profilex_company_wallets").select("client_id, balance"),
    ]);
    if (cErr) throw new Error(`Could not load companies (${cErr.message})`);
    if (aErr) throw new Error(`Could not load users (${aErr.message})`);
    if (wErr) throw new Error(`Could not load wallets (${wErr.message})`);

    const roleCounts = new Map<string, { admin: number; manager: number; agent: number }>();
    const adminEmailsByClient = new Map<string, string[]>();
    for (const a of (agents ?? []) as { client_id: string; role: string; email: string }[]) {
      const counts = roleCounts.get(a.client_id) ?? { admin: 0, manager: 0, agent: 0 };
      if (a.role === "admin") {
        counts.admin++;
        adminEmailsByClient.set(a.client_id, [
          ...(adminEmailsByClient.get(a.client_id) ?? []),
          a.email,
        ]);
      } else if (a.role === "manager") counts.manager++;
      else counts.agent++;
      roleCounts.set(a.client_id, counts);
    }
    const balanceByClient = new Map(
      ((wallets ?? []) as { client_id: string; balance: number }[]).map((w) => [
        w.client_id,
        Number(w.balance),
      ]),
    );

    const rows: CompanyRow[] = (
      (clients ?? []) as {
        id: string;
        company_name: string;
        plan: string;
        created_at: string;
        status: "pending" | "approved" | "rejected";
        subdomain: string | null;
      }[]
    )
      .map((c) => {
        const counts = roleCounts.get(c.id) ?? { admin: 0, manager: 0, agent: 0 };
        return {
          id: c.id,
          companyName: c.company_name,
          plan: c.plan,
          createdAt: c.created_at,
          adminCount: counts.admin,
          managerCount: counts.manager,
          agentCount: counts.agent,
          walletBalance: balanceByClient.get(c.id) ?? 0,
          status: c.status,
          subdomain: c.subdomain,
          adminEmails: adminEmailsByClient.get(c.id) ?? [],
        };
      })
      // Pending companies first — that's the queue a superadmin actually needs to work through.
      .sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (b.status === "pending" && a.status !== "pending") return 1;
        return a.companyName.localeCompare(b.companyName);
      });

    return { rows };
  });

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Approves a pending company, optionally assigning its subdomain slug in the same step (the
 *  DNS/Railway domain itself is provisioned outside the app — this just records the slug once
 *  the superadmin has picked one). Until this runs, every user at the company sees the
 *  "awaiting verification" gate (auth.tsx / app-shell.tsx) instead of the app. */
export const approveCompany = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; clientId: string; subdomain?: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");

    const subdomain = data.subdomain?.trim().toLowerCase() || null;
    if (subdomain && !SUBDOMAIN_RE.test(subdomain)) {
      throw new Error("Subdomain must be lowercase letters, numbers and hyphens only");
    }

    const admin = db();
    const patch: {
      status: "approved";
      verified_at: string;
      verified_by: string;
      subdomain?: string;
    } = {
      status: "approved",
      verified_at: new Date().toISOString(),
      verified_by: caller.superadminId,
    };
    if (subdomain) patch.subdomain = subdomain;

    const { error } = await admin.from("clients").update(patch).eq("id", data.clientId);
    if (error) {
      if (/duplicate key|already exists/i.test(error.message)) {
        throw new Error("That subdomain is already taken by another company");
      }
      throw new Error(`Could not approve the company (${error.message})`);
    }
    return { ok: true };
  });

/** Rejects a pending company — status only, nothing is deleted (the auth account and client
 *  row survive so a superadmin can revisit the decision later). */
export const rejectCompany = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; clientId: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const { error } = await admin
      .from("clients")
      .update({
        status: "rejected",
        verified_at: new Date().toISOString(),
        verified_by: caller.superadminId,
      })
      .eq("id", data.clientId);
    if (error) throw new Error(`Could not reject the company (${error.message})`);
    return { ok: true };
  });

/** Sets (or changes) an already-approved company's subdomain slug on its own, separate from
 *  the approve step above. */
export const setCompanySubdomain = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; clientId: string; subdomain: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const subdomain = data.subdomain.trim().toLowerCase();
    if (!SUBDOMAIN_RE.test(subdomain)) {
      throw new Error("Subdomain must be lowercase letters, numbers and hyphens only");
    }
    const admin = db();
    const { error } = await admin.from("clients").update({ subdomain }).eq("id", data.clientId);
    if (error) {
      if (/duplicate key|already exists/i.test(error.message)) {
        throw new Error("That subdomain is already taken by another company");
      }
      throw new Error(`Could not update the subdomain (${error.message})`);
    }
    return { ok: true };
  });

export interface CompanyUserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
}

/** Every agents-table row (admins/managers/agents) for one company. */
export const getCompanyUsers = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; clientId: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();

    const [{ data: client, error: clErr }, { data: users, error: uErr }] = await Promise.all([
      admin
        .from("clients")
        .select("id, company_name, status, subdomain")
        .eq("id", data.clientId)
        .maybeSingle(),
      admin
        .from("agents")
        .select("id, name, email, role, is_active")
        .eq("client_id", data.clientId),
    ]);
    if (clErr) throw new Error(`Could not load company (${clErr.message})`);
    if (uErr) throw new Error(`Could not load users (${uErr.message})`);
    if (!client) throw new Error("Company not found");

    const rows: CompanyUserRow[] = (
      (users ?? []) as {
        id: string;
        name: string;
        email: string;
        role: string;
        is_active: boolean;
      }[]
    )
      .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.is_active }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      companyName: client.company_name as string,
      status: client.status as "pending" | "approved" | "rejected",
      subdomain: client.subdomain as string | null,
      rows,
    };
  });

/** Changes one company user's role — the superadmin equivalent of admin.users.tsx's
 *  EditUserDialog, which writes `agents.role` directly through the browser client because an
 *  admin's own RLS write policy (agents_own_client) covers it. A superadmin has no agents row
 *  scoping them to that client (often no agents row at all), so that RLS path doesn't apply —
 *  this goes through the service-role client instead, with the same "does this user actually
 *  belong to this company" check the browser-side RLS policy would otherwise have enforced. */
export const updateCompanyUserRole = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      accessToken: string;
      clientId: string;
      userId: string;
      role: "agent" | "manager" | "admin";
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (!["agent", "manager", "admin"].includes(data.role)) {
      throw new Error("Invalid role");
    }

    const admin = db();
    const { data: user, error: findErr } = await admin
      .from("agents")
      .select("id, client_id")
      .eq("id", data.userId)
      .maybeSingle();
    if (findErr) throw new Error(`Could not verify that user (${findErr.message})`);
    if (!user || user.client_id !== data.clientId) {
      throw new Error("That user was not found in this company");
    }

    const { error: updateErr } = await admin
      .from("agents")
      .update({ role: data.role })
      .eq("id", data.userId);
    if (updateErr) throw new Error(`Could not update role (${updateErr.message})`);

    return { ok: true };
  });

/** The one real ProfileX/Neokred wallet's current balance. */
export const getMasterWallet = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const { data: wallet, error } = await admin
      .from("profilex_master_wallet")
      .select("balance, updated_at")
      .eq("id", "main")
      .maybeSingle();
    if (error) throw new Error(`Could not load the master wallet (${error.message})`);
    return { balance: Number(wallet?.balance ?? 0), updatedAt: wallet?.updated_at ?? null };
  });

/** Records real money the superadmin actually paid ProfileX. */
export const topUpMasterWallet = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; amount: number; note?: string }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (!(data.amount > 0)) throw new Error("Top-up amount must be positive");
    const admin = db();
    const { data: newBalance, error } = await admin.rpc("profilex_master_topup", {
      p_amount: data.amount,
      p_superadmin_id: caller.superadminId,
      p_note: data.note ?? null,
    });
    if (error) throw new Error(`Top-up failed (${error.message})`);
    return { balance: Number(newBalance) };
  });

/** Moves a slice of the master wallet into one company's wallet — the budget that company
 *  admin can then hand out to their own managers. */
export const allocateToCompany = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { accessToken: string; clientId: string; amount: number; note?: string }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (!(data.amount > 0)) throw new Error("Allocation amount must be positive");
    const admin = db();
    const { data: newBalance, error } = await admin.rpc("profilex_master_allocate", {
      p_client_id: data.clientId,
      p_amount: data.amount,
      p_superadmin_id: caller.superadminId,
      p_note: data.note ?? null,
    });
    if (error) throw new Error(`Allocation failed (${error.message})`);
    return { companyBalance: Number(newBalance) };
  });

export interface WalletLedgerRow {
  id: string;
  scope: string;
  clientId: string | null;
  companyName: string | null;
  managerId: string | null;
  managerName: string | null;
  amount: number;
  note: string | null;
  createdAt: string;
}

/** Cross-company wallet activity — every top-up, allocation, and manager charge, at every
 *  level. The audit trail behind "all transactions from multiple companies". */
export const getWalletLedger = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { accessToken: string; clientId?: string; scope?: string; limit?: number }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();

    let query = admin
      .from("profilex_wallet_ledger")
      .select("id, scope, client_id, manager_id, amount, note, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.clientId) query = query.eq("client_id", data.clientId);
    if (data.scope) query = query.eq("scope", data.scope);

    const { data: ledger, error } = await query;
    if (error) throw new Error(`Could not load the wallet ledger (${error.message})`);

    const rows = (ledger ?? []) as {
      id: string;
      scope: string;
      client_id: string | null;
      manager_id: string | null;
      amount: number;
      note: string | null;
      created_at: string;
    }[];

    const clientIds = [...new Set(rows.map((r) => r.client_id).filter((v): v is string => !!v))];
    const managerIds = [...new Set(rows.map((r) => r.manager_id).filter((v): v is string => !!v))];

    const [{ data: clients }, { data: managers }] = await Promise.all([
      clientIds.length
        ? admin.from("clients").select("id, company_name").in("id", clientIds)
        : Promise.resolve({ data: [] as { id: string; company_name: string }[] }),
      managerIds.length
        ? admin.from("agents").select("id, name").in("id", managerIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);
    const companyNameById = new Map(
      ((clients ?? []) as { id: string; company_name: string }[]).map((c) => [
        c.id,
        c.company_name,
      ]),
    );
    const managerNameById = new Map(
      ((managers ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]),
    );

    const result: WalletLedgerRow[] = rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      clientId: r.client_id,
      companyName: r.client_id ? (companyNameById.get(r.client_id) ?? null) : null,
      managerId: r.manager_id,
      managerName: r.manager_id ? (managerNameById.get(r.manager_id) ?? null) : null,
      amount: Number(r.amount),
      note: r.note,
      createdAt: r.created_at,
    }));

    return { rows: result };
  });

export interface InsightsActivityRow {
  id: string;
  clientId: string;
  companyName: string | null;
  managerName: string | null;
  serviceId: string;
  state: string;
  providerStatus: string | null;
  billable: boolean;
  cost: number;
  createdAt: string;
}

/** Every ProfileX ("Insights") trace across every company — who ran it, on which debtor's
 *  behalf, and what it cost. Scoped read via service role, so no cross-client RLS policy on
 *  debtor_traces needs to change for this to work. */
export const getInsightsActivity = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; clientId?: string; limit?: number }) => d)
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();

    let query = admin
      .from("debtor_traces")
      .select(
        "id, client_id, requested_by, service_id, state, provider_status, billable, cost, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.clientId) query = query.eq("client_id", data.clientId);

    const { data: traces, error } = await query;
    if (error) throw new Error(`Could not load Insights activity (${error.message})`);

    const rows = (traces ?? []) as {
      id: string;
      client_id: string;
      requested_by: string | null;
      service_id: string;
      state: string;
      provider_status: string | null;
      billable: boolean;
      cost: number;
      created_at: string;
    }[];

    const clientIds = [...new Set(rows.map((r) => r.client_id))];
    const agentIds = [...new Set(rows.map((r) => r.requested_by).filter((v): v is string => !!v))];

    const [{ data: clients }, { data: agents }] = await Promise.all([
      clientIds.length
        ? admin.from("clients").select("id, company_name").in("id", clientIds)
        : Promise.resolve({ data: [] as { id: string; company_name: string }[] }),
      agentIds.length
        ? admin.from("agents").select("id, name").in("id", agentIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);
    const companyNameById = new Map(
      ((clients ?? []) as { id: string; company_name: string }[]).map((c) => [
        c.id,
        c.company_name,
      ]),
    );
    const agentNameById = new Map(
      ((agents ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
    );

    const result: InsightsActivityRow[] = rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      companyName: companyNameById.get(r.client_id) ?? null,
      managerName: r.requested_by ? (agentNameById.get(r.requested_by) ?? null) : null,
      serviceId: r.service_id,
      state: r.state,
      providerStatus: r.provider_status,
      billable: r.billable,
      cost: Number(r.cost),
      createdAt: r.created_at,
    }));

    return { rows: result };
  });

/** One company's Insights configuration (enable toggle, cache TTLs, rate card) — superadmin
 * read, paired with saveCompanyProfilexSettings below for the write. Reuses profilex-actions.
 * server.ts's loadSettings so the shape/fallback defaults never drift between the two. */
export const getCompanyProfilexSettings = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; clientId: string }) => d)
  .handler(async ({ data }): Promise<ProfilexSettings> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    return await loadSettings(data.clientId);
  });

/** Sets one company's Insights pricing/config. Moved here from profilex-actions.server.ts's
 * old saveProfilexSettings (which let a company admin edit their own rate card) because the
 * rate card is what SamvadX actually gets billed against by ProfileX/Neokred — a company admin
 * changing it was really editing SamvadX's own cost basis, not just their own spend. Company
 * admins now see this read-only (getProfilexSettings) and can only manage their managers'
 * wallets, not the pricing those wallets spend against. */
export const saveCompanyProfilexSettings = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      accessToken: string;
      clientId: string;
      enabled: boolean;
      hitTtlHours: number;
      missTtlHours: number;
      rateCard: Record<string, Record<string, number>>;
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");

    const admin = db();
    const { error } = await admin.from("profilex_settings").upsert(
      {
        client_id: data.clientId,
        enabled: data.enabled,
        hit_ttl_hours: data.hitTtlHours,
        miss_ttl_hours: data.missTtlHours,
        rate_card: data.rateCard,
        updated_at: new Date().toISOString(),
        // profilex_settings.updated_by references agents(id), not superadmins(id) — a
        // superadmin has no agents row to attribute this to, so leave it null rather than
        // writing an id the FK would reject.
        updated_by: null,
      },
      { onConflict: "client_id" },
    );
    if (error) throw new Error(`Could not save Insights settings (${error.message})`);
    return { ok: true };
  });
