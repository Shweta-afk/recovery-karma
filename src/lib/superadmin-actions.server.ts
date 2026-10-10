// Superadmin server actions — companies, users, and the ProfileX wallet ledger, all read via
// the service-role client (never the RLS-governed browser client). See
// 20260909_superadmin_and_wallets.sql: `superadmins` and `profilex_master_wallet` have no RLS
// policy at all, so this file is the ONLY place that can ever read them. Every handler except
// resolveSuperadmin calls verifySuperadminCaller first and throws if it returns null — same
// chokepoint discipline supabase-admin.server.ts documents for verifyCaller.

import {
  z,
  tokenSchema,
  idSchema,
  shortText,
  limitSchema,
  isoDateSchema,
  amountSchema,
  noteSchema,
  emailSchema,
  passwordSchema,
  grantableRoleSchema,
} from "./schemas";
import { timingSafeEqual } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { loadSettings, type ProfilexSettings } from "./profilex-actions.server";
import { ALL_SERVICE_IDS, CIBIL_SERVICE, getService, priceFor } from "./profilex/catalogue";
import { insightsPriceChanges } from "./profilex/price-changes";
import { fetchAllRows } from "./fetch-all-rows";
import { APP_PING_BODY, APP_PING_PATH, addressFor, subdomainProblem } from "./company-address";
import type { Json } from "./database.types";

function db() {
  return getSupabaseAdmin();
}

/** Writes one row to superadmin_activity_log (20260925_superadmin_activity_log.sql) — the
 *  non-money half of "whole history of superadmin activities" (money already has a full
 *  history in profilex_wallet_ledger). Fire-and-forget on purpose: a logging failure must
 *  never fail the action it's describing, so this only console.errors, never throws. */
export async function logSuperadminActivity(params: {
  superadminId: string;
  action: string;
  clientId?: string | null;
  summary: string;
  detail?: Record<string, Json>;
}) {
  const { error } = await db()
    .from("superadmin_activity_log")
    .insert({
      superadmin_id: params.superadminId,
      action: params.action,
      client_id: params.clientId ?? null,
      summary: params.summary,
      detail: params.detail ?? null,
    });
  if (error) {
    console.error(`[logSuperadminActivity] failed to log "${params.action}":`, error);
  }
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
  .inputValidator((d: unknown) =>
    z
      .object({
        name: shortText(),
        email: emailSchema,
        password: passwordSchema,
        accessToken: tokenSchema.optional(),
        bootstrapSecret: z.string().max(256).optional(),
      })
      .parse(d),
  )
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
    } else {
      // The table is empty (a fresh or restored database), which used to mean ANYONE who found
      // this route became the platform owner. Now the first superadmin must present a secret that
      // only whoever controls the server's environment knows. Unset secret => closed, not open.
      const expected = process.env.SUPERADMIN_BOOTSTRAP_SECRET?.trim();
      const given = data.bootstrapSecret?.trim() ?? "";
      const a = Buffer.from(given);
      const b = Buffer.from(expected ?? "");
      if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
        return {
          ok: false as const,
          error:
            "Creating the first superadmin needs the setup key from the server's SUPERADMIN_BOOTSTRAP_SECRET.",
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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
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

/** Throws unless `slug` may become this company's address: allowed name (company-address.ts),
 *  and the address already loads THIS app. A company's users are sent to their subdomain as soon
 *  as it is saved, so saving one before its DNS record and Railway domain exist would lock them
 *  out. Re-saving the company's current value skips both checks. */
async function assertSubdomainAssignable(clientId: string, slug: string): Promise<void> {
  const { data: row } = await db()
    .from("clients")
    .select("subdomain")
    .eq("id", clientId)
    .maybeSingle();
  const current = (row as { subdomain: string | null } | null)?.subdomain ?? null;
  const problem = subdomainProblem(slug, current);
  if (problem) throw new Error(problem);
  if (slug === current) return;

  const address = addressFor(slug);
  let live = false;
  try {
    const res = await fetch(`https://${address}${APP_PING_PATH}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    live = res.ok && (await res.text()).trim() === APP_PING_BODY;
  } catch {
    live = false;
  }
  if (!live) {
    throw new Error(
      `${address} doesn't open SamvadX yet. Add it as a domain in Railway and its DNS record in Hostinger first, wait until it loads, then save again.`,
    );
  }
}

/** Approves a pending company, optionally assigning its subdomain slug in the same step (the
 *  DNS/Railway domain itself is provisioned outside the app — this just records the slug once
 *  the superadmin has picked one). Until this runs, every user at the company sees the
 *  "awaiting verification" gate (auth.tsx / app-shell.tsx) instead of the app. */
export const approveCompany = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        subdomain: z.string().max(63).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");

    const subdomain = data.subdomain?.trim().toLowerCase() || null;
    if (subdomain) await assertSubdomainAssignable(data.clientId, subdomain);

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

    const { data: updated, error } = await admin
      .from("clients")
      .update(patch)
      .eq("id", data.clientId)
      .select("company_name")
      .maybeSingle();
    if (error) {
      if (/duplicate key|already exists/i.test(error.message)) {
        throw new Error("That subdomain is already taken by another company");
      }
      throw new Error(`Could not approve the company (${error.message})`);
    }

    const companyName = (updated as { company_name: string } | null)?.company_name ?? null;
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "company_approved",
      clientId: data.clientId,
      summary: subdomain
        ? `Approved ${companyName ?? "a company"} and set subdomain to ${subdomain}`
        : `Approved ${companyName ?? "a company"}`,
      detail: subdomain ? { subdomain } : undefined,
    });

    return { ok: true };
  });

/** Rejects a pending company — status only, nothing is deleted (the auth account and client
 *  row survive so a superadmin can revisit the decision later). */
export const rejectCompany = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const { data: updated, error } = await admin
      .from("clients")
      .update({
        status: "rejected",
        verified_at: new Date().toISOString(),
        verified_by: caller.superadminId,
      })
      .eq("id", data.clientId)
      .select("company_name")
      .maybeSingle();
    if (error) throw new Error(`Could not reject the company (${error.message})`);

    const companyName = (updated as { company_name: string } | null)?.company_name ?? null;
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "company_rejected",
      clientId: data.clientId,
      summary: `Rejected ${companyName ?? "a company"}`,
    });

    return { ok: true };
  });

/** Sets (or changes) an already-approved company's subdomain slug on its own, separate from
 *  the approve step above. */
export const setCompanySubdomain = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        subdomain: z.string().max(63),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const subdomain = data.subdomain.trim().toLowerCase();
    await assertSubdomainAssignable(data.clientId, subdomain);
    const admin = db();
    const { data: before } = await admin
      .from("clients")
      .select("company_name, subdomain")
      .eq("id", data.clientId)
      .maybeSingle();
    const { error } = await admin.from("clients").update({ subdomain }).eq("id", data.clientId);
    if (error) {
      if (/duplicate key|already exists/i.test(error.message)) {
        throw new Error("That subdomain is already taken by another company");
      }
      throw new Error(`Could not update the subdomain (${error.message})`);
    }

    const prior = before as { company_name: string; subdomain: string | null } | null;
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "subdomain_set",
      clientId: data.clientId,
      summary: `Set ${prior?.company_name ?? "a company"}'s subdomain to ${subdomain}`,
      detail: { subdomain: { from: prior?.subdomain ?? null, to: subdomain } },
    });

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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();

    const [{ data: client, error: clErr }, { data: users, error: uErr }] = await Promise.all([
      admin
        .from("clients")
        .select("id, company_name, status, subdomain, max_agents, max_managers, created_at")
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

    const agentCount = rows.filter((r) => r.role === "agent").length;
    const managerCount = rows.filter((r) => r.role === "manager").length;

    return {
      companyName: client.company_name as string,
      status: client.status as "pending" | "approved" | "rejected",
      subdomain: client.subdomain as string | null,
      maxAgents: client.max_agents as number | null,
      maxManagers: client.max_managers as number | null,
      agentCount,
      managerCount,
      createdAt: client.created_at as string,
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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        userId: idSchema,
        role: grantableRoleSchema,
      })
      .parse(d),
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
      .select("id, client_id, name, email, role")
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

    const target = user as { name: string; email: string; role: string };
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "user_role_changed",
      clientId: data.clientId,
      summary: `Changed ${target.name} (${target.email})'s role from ${target.role} to ${data.role}`,
      detail: { userId: data.userId, role: { from: target.role, to: data.role } },
    });

    return { ok: true };
  });

/** Sets (or clears, by passing null) how many managers and agents a company's admin may invite
 *  — enforced in user-admin-actions.server.ts's inviteUser. Passing null for either means
 *  unlimited; that's also every company's starting state (20260909_company_seat_limits.sql),
 *  so an existing company like Axiotta is never retroactively capped by this migration —
 *  only companies a superadmin explicitly sets a number for are restricted. */
export const setCompanyLimits = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        maxAgents: z.number().int().min(0).max(100000).nullable(),
        maxManagers: z.number().int().min(0).max(100000).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (data.maxAgents !== null && data.maxAgents < 0) {
      throw new Error("Manager/agent limits can't be negative");
    }
    if (data.maxManagers !== null && data.maxManagers < 0) {
      throw new Error("Manager/agent limits can't be negative");
    }

    const admin = db();
    const { data: before } = await admin
      .from("clients")
      .select("company_name, max_agents, max_managers")
      .eq("id", data.clientId)
      .maybeSingle();
    const { error } = await admin
      .from("clients")
      .update({ max_agents: data.maxAgents, max_managers: data.maxManagers })
      .eq("id", data.clientId);
    if (error) throw new Error(`Could not update seat limits (${error.message})`);

    const prior = before as {
      company_name: string;
      max_agents: number | null;
      max_managers: number | null;
    } | null;
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "seat_limits_set",
      clientId: data.clientId,
      summary: `Set ${prior?.company_name ?? "a company"}'s seat limits to ${data.maxAgents ?? "unlimited"} agents / ${data.maxManagers ?? "unlimited"} managers`,
      detail: {
        maxAgents: { from: prior?.max_agents ?? null, to: data.maxAgents },
        maxManagers: { from: prior?.max_managers ?? null, to: data.maxManagers },
      },
    });

    return { ok: true };
  });

/** The one real ProfileX/Neokred wallet's current balance. */
export const getMasterWallet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        amount: amountSchema,
        note: noteSchema.optional(),
      })
      .parse(d),
  )
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

/** The other wallet: the true remaining balance with ProfileX/Neokred, separate from the master
 *  wallet above. See 20260910_profilex_actual_wallet.sql for why the two are kept apart — the
 *  master wallet is an allocation pool a superadmin can put any figure into, while this one is
 *  debited automatically, in real time, by the real ProfileX price on every billable lookup
 *  across every company (profilex-actions.server.ts's runProfilexTrace). Only a manual top-up
 *  ever increases it. */
export const getActualWallet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const { data: wallet, error } = await admin
      .from("profilex_actual_wallet")
      .select("balance, low_balance_threshold, updated_at")
      .eq("id", "main")
      .maybeSingle();
    if (error) throw new Error(`Could not load the actual wallet (${error.message})`);
    return {
      balance: Number(wallet?.balance ?? 0),
      lowBalanceThreshold: Number(wallet?.low_balance_threshold ?? 500),
      updatedAt: wallet?.updated_at ?? null,
    };
  });

/** Records real money the superadmin actually paid ProfileX/Neokred into the actual wallet —
 *  distinct from topUpMasterWallet, which only affects the internal allocation pool. */
export const topUpActualWallet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        amount: amountSchema,
        note: noteSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (!(data.amount > 0)) throw new Error("Top-up amount must be positive");
    const admin = db();
    const { data: newBalance, error } = await admin.rpc("profilex_actual_topup", {
      p_amount: data.amount,
      p_superadmin_id: caller.superadminId,
      p_note: data.note ?? null,
    });
    if (error) throw new Error(`Top-up failed (${error.message})`);
    return { balance: Number(newBalance) };
  });

/** The ₹ level below which the superadmin wallet UI shows a low-balance alert. Editable so 500
 *  is a default, not a hardcoded floor. */
export const setActualWalletThreshold = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        threshold: z.number().finite().min(0).max(1_000_000_000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (!(data.threshold >= 0)) throw new Error("Threshold must be zero or more");
    const admin = db();
    const { error } = await admin
      .from("profilex_actual_wallet")
      .update({ low_balance_threshold: data.threshold, updated_by: caller.superadminId })
      .eq("id", "main");
    if (error) throw new Error(`Could not update the threshold (${error.message})`);
    return { ok: true as const };
  });

/** Moves a slice of the master wallet into one company's wallet — the budget that company
 *  admin can then hand out to their own managers. */
export const allocateToCompany = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        amount: amountSchema,
        note: noteSchema.optional(),
      })
      .parse(d),
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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.optional(),
        scope: shortText(40).optional(),
        limit: limitSchema.optional(),
        /** Optional [since, until) bounds — the superadmin date filter. */
        since: isoDateSchema.optional(),
        until: isoDateSchema.optional(),
      })
      .parse(d),
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
    if (data.since) query = query.gte("created_at", data.since);
    if (data.until) query = query.lt("created_at", data.until);
    if (data.until) query = query.lt("created_at", data.until);

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

/** Ledger scopes that are actually a superadmin doing something, as opposed to automatic
 *  per-lookup debits (company_to_manager/manager_charge are a company admin/manager's own
 *  activity, not a superadmin's — deliberately left out of this feed). actual_charge is
 *  included only when created_by is set, i.e. a manual correction rather than the automatic
 *  real-time ProfileX debit (see getSuperadminActivity's filtering below). */
const SUPERADMIN_MONEY_SCOPES = [
  "master_topup",
  "master_to_company",
  "actual_topup",
  "actual_charge",
];

export interface SuperadminActivityRow {
  id: string;
  /** "action" = superadmin_activity_log row (approvals, subdomain, limits, roles, Insights
   *  config). "money" = a profilex_wallet_ledger row a superadmin caused. */
  kind: "action" | "money";
  action: string;
  actorName: string | null;
  clientId: string | null;
  companyName: string | null;
  summary: string;
  amount: number | null;
  detail: Record<string, Json> | null;
  createdAt: string;
}

const MONEY_SCOPE_LABEL: Record<string, string> = {
  master_topup: "Topped up the master Insights wallet",
  master_to_company: "Allocated Insights budget to",
  actual_topup: "Recorded a real ProfileX/Neokred top-up",
  actual_charge: "Corrected the actual ProfileX wallet balance for",
};

/** The unified "whole history of superadmin activities" feed: every non-money action from
 *  superadmin_activity_log (20260925_superadmin_activity_log.sql) merged with every
 *  superadmin-caused money movement from profilex_wallet_ledger — e.g. exactly "how much money
 *  was assigned to the company" — into one chronological list. Two bounded reads merged and
 *  re-sorted in memory rather than a SQL UNION/view, since the two tables have different shapes
 *  and this keeps each one's own reader (getWalletLedger, this) simple and independently
 *  correct. */
export const getSuperadminActivity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.optional(),
        limit: limitSchema.optional(),
        since: isoDateSchema.optional(),
        until: isoDateSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const limit = data.limit ?? 200;

    let actionQuery = admin
      .from("superadmin_activity_log")
      .select("id, superadmin_id, action, client_id, summary, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (data.clientId) actionQuery = actionQuery.eq("client_id", data.clientId);
    if (data.since) actionQuery = actionQuery.gte("created_at", data.since);
    if (data.until) actionQuery = actionQuery.lt("created_at", data.until);

    let moneyQuery = admin
      .from("profilex_wallet_ledger")
      .select("id, scope, client_id, amount, note, created_by, created_at")
      .in("scope", SUPERADMIN_MONEY_SCOPES)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (data.clientId) moneyQuery = moneyQuery.eq("client_id", data.clientId);
    if (data.since) moneyQuery = moneyQuery.gte("created_at", data.since);
    if (data.until) moneyQuery = moneyQuery.lt("created_at", data.until);

    const [{ data: actions, error: actionErr }, { data: money, error: moneyErr }] =
      await Promise.all([actionQuery, moneyQuery]);
    if (actionErr) throw new Error(`Could not load activity log (${actionErr.message})`);
    if (moneyErr) throw new Error(`Could not load wallet ledger (${moneyErr.message})`);

    const actionRows = (actions ?? []) as {
      id: string;
      superadmin_id: string | null;
      action: string;
      client_id: string | null;
      summary: string;
      detail: Record<string, Json> | null;
      created_at: string;
    }[];
    // actual_charge is automatic (created_by NULL) except for a manual correction — exclude the
    // automatic ones here, they belong on the wallet page's balance, not a superadmin's history.
    const moneyRows = (
      (money ?? []) as {
        id: string;
        scope: string;
        client_id: string | null;
        amount: number;
        note: string | null;
        created_by: string | null;
        created_at: string;
      }[]
    ).filter((r) => r.scope !== "actual_charge" || r.created_by !== null);

    const superadminIds = [
      ...new Set([
        ...actionRows.map((r) => r.superadmin_id).filter((v): v is string => !!v),
        ...moneyRows.map((r) => r.created_by).filter((v): v is string => !!v),
      ]),
    ];
    const clientIds = [
      ...new Set([
        ...actionRows.map((r) => r.client_id).filter((v): v is string => !!v),
        ...moneyRows.map((r) => r.client_id).filter((v): v is string => !!v),
      ]),
    ];

    const [{ data: superadmins }, { data: clients }] = await Promise.all([
      superadminIds.length
        ? admin.from("superadmins").select("id, name").in("id", superadminIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      clientIds.length
        ? admin.from("clients").select("id, company_name").in("id", clientIds)
        : Promise.resolve({ data: [] as { id: string; company_name: string }[] }),
    ]);
    const actorNameById = new Map(
      ((superadmins ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]),
    );
    const companyNameById = new Map(
      ((clients ?? []) as { id: string; company_name: string }[]).map((c) => [
        c.id,
        c.company_name,
      ]),
    );

    const fromActions: SuperadminActivityRow[] = actionRows.map((r) => ({
      id: r.id,
      kind: "action",
      action: r.action,
      actorName: r.superadmin_id ? (actorNameById.get(r.superadmin_id) ?? null) : null,
      clientId: r.client_id,
      companyName: r.client_id ? (companyNameById.get(r.client_id) ?? null) : null,
      summary: r.summary,
      amount: null,
      detail: r.detail,
      createdAt: r.created_at,
    }));

    const fromMoney: SuperadminActivityRow[] = moneyRows.map((r) => {
      const companyName = r.client_id ? (companyNameById.get(r.client_id) ?? null) : null;
      const label = MONEY_SCOPE_LABEL[r.scope] ?? r.scope;
      const summary =
        r.scope === "master_topup"
          ? `${label}: ₹${Number(r.amount).toFixed(2)}`
          : `${label} ${companyName ?? "a company"}: ₹${Number(r.amount).toFixed(2)}`;
      return {
        id: r.id,
        kind: "money",
        action: r.scope,
        actorName: r.created_by ? (actorNameById.get(r.created_by) ?? null) : null,
        clientId: r.client_id,
        companyName,
        summary: r.note ? `${summary} — ${r.note}` : summary,
        amount: Number(r.amount),
        detail: null,
        createdAt: r.created_at,
      };
    });

    const rows = [...fromActions, ...fromMoney]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return { rows };
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
  /** What ProfileX actually charged, per catalogue.ts's defaultPrices (their published price),
   *  ignoring this company's own rate_card override. Differs from `cost` whenever a superadmin
   *  has set that company's rate_card away from the real ProfileX price — see
   *  20260910_profilex_actual_wallet.sql. */
  realCost: number;
  createdAt: string;
  /** Typed in by a company admin on Admin > Insights, not run against a debtor. */
  manual: boolean;
  /** The mobile / UAN / GSTIN that was typed in — only set for manual lookups. */
  queryValue: string | null;
}

/** Every ProfileX ("Insights") trace across every company — who ran it, on which debtor's
 *  behalf, and what it cost. Scoped read via service role, so no cross-client RLS policy on
 *  debtor_traces needs to change for this to work. */
export const getInsightsActivity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.optional(),
        limit: limitSchema.optional(),
        since: isoDateSchema.optional(),
        until: isoDateSchema.optional(),
      })
      .parse(d),
  )
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
    if (data.since) query = query.gte("created_at", data.since);

    let manualQuery = admin
      .from("insights_manual_lookups")
      .select(
        "id, client_id, requested_by, service_id, state, provider_status, billable, cost, created_at, query_key",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.clientId) manualQuery = manualQuery.eq("client_id", data.clientId);
    if (data.since) manualQuery = manualQuery.gte("created_at", data.since);
    if (data.until) manualQuery = manualQuery.lt("created_at", data.until);

    const [{ data: traces, error }, { data: manualTraces, error: manualErr }] = await Promise.all([
      query,
      manualQuery,
    ]);
    if (error) throw new Error(`Could not load Insights activity (${error.message})`);
    // Tolerate the manual table not existing yet (code deployed ahead of the migration): the
    // debtor activity must keep loading.
    if (manualErr) console.error("[insights] manual lookups unavailable:", manualErr.message);

    interface TraceRow {
      id: string;
      client_id: string;
      requested_by: string | null;
      service_id: string;
      state: string;
      provider_status: string | null;
      billable: boolean;
      cost: number;
      created_at: string;
      query_key?: string | null;
      manual?: boolean;
    }
    const rows: TraceRow[] = [
      ...((traces ?? []) as TraceRow[]),
      ...((manualTraces ?? []) as TraceRow[]).map((r) => ({ ...r, manual: true })),
    ]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, data.limit ?? 200);

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

    const result: InsightsActivityRow[] = rows.map((r) => {
      const service = getService(r.service_id);
      // No entry (a retired service_id, e.g. mobile-to-prefill-ext) means no known real price —
      // fall back to the stored cost rather than silently showing ₹0 real cost.
      const realCost =
        r.billable && service ? priceFor(service, r.provider_status, null) : Number(r.cost);
      return {
        id: r.id,
        clientId: r.client_id,
        companyName: companyNameById.get(r.client_id) ?? null,
        managerName: r.requested_by ? (agentNameById.get(r.requested_by) ?? null) : null,
        serviceId: r.service_id,
        state: r.state,
        providerStatus: r.provider_status,
        billable: r.billable,
        cost: Number(r.cost),
        realCost,
        createdAt: r.created_at,
        manual: !!r.manual,
        queryValue: r.manual ? (r.query_key ?? null) : null,
      };
    });

    return { rows: result };
  });

export interface InsightsBucket {
  lookups: number;
  found: number;
  /** Charged by ProfileX but returned nothing. */
  paidNoData: number;
  /** Never reached a data source, so never charged. */
  failed: number;
  /** Of `lookups`, how many an admin typed in by hand. */
  manual: number;
  /** What the company's own wallet was charged (its rate card). */
  companyCost: number;
  /** What ProfileX actually bills (published list price). */
  realCost: number;
}
export interface InsightsCompanyReport extends InsightsBucket {
  clientId: string;
  companyName: string;
}
export interface InsightsServiceReport extends InsightsBucket {
  serviceId: string;
}
export interface InsightsReport {
  since: string;
  totals: InsightsBucket;
  byCompany: InsightsCompanyReport[];
  byService: InsightsServiceReport[];
  /** True when the row cap was hit, so the totals are a lower bound. */
  truncated: boolean;
}

const emptyBucket = (): InsightsBucket => ({
  lookups: 0,
  found: 0,
  paidNoData: 0,
  failed: 0,
  manual: 0,
  companyCost: 0,
  realCost: 0,
});

/** Every lookup in the window, aggregated per company and per service — the accurate numbers.
 *  getInsightsActivity only returns the latest N rows, so totals derived from it stop being
 *  true the moment there are more than N lookups; this pages through everything instead.
 *  Debtor lookups and admins' manual lookups are both included. */
export const getInsightsReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        since: isoDateSchema.optional(),
        until: isoDateSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<InsightsReport> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const since = data.since ?? new Date(0).toISOString();
    const MAX_ROWS = 100_000;

    interface Row {
      client_id: string;
      service_id: string;
      state: string;
      provider_status: string | null;
      billable: boolean;
      cost: number;
    }
    const load = async (table: string) => {
      return fetchAllRows<Row>(async (from, to) => {
        const { data: rows, error } = await admin
          .from(table)
          .select("client_id, service_id, state, provider_status, billable, cost")
          .gte("created_at", since)
          .lt("created_at", data.until ?? "9999-12-31T00:00:00Z")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return { data: rows as unknown as Row[] | null, error };
      });
    };
    const [debtor, manual] = await Promise.all([
      load("debtor_traces"),
      load("insights_manual_lookups"),
    ]);
    if (debtor.error) throw new Error(`Could not load Insights report (${debtor.error.message})`);
    // Code deployed ahead of the manual-lookups migration: report debtor lookups regardless.
    if (manual.error) console.error("[insights] manual lookups unavailable:", manual.error.message);

    const all = [
      ...debtor.data.map((r) => ({ r, manual: false })),
      ...(manual.error ? [] : manual.data.map((r) => ({ r, manual: true }))),
    ];
    const truncated = all.length > MAX_ROWS;
    const rows = truncated ? all.slice(0, MAX_ROWS) : all;

    const totals = emptyBucket();
    const companies = new Map<string, InsightsBucket>();
    const services = new Map<string, InsightsBucket>();
    for (const { r, manual: isManual } of rows) {
      const service = getService(r.service_id);
      const realCost =
        r.billable && service ? priceFor(service, r.provider_status, null) : Number(r.cost);
      for (const b of [
        totals,
        companies.get(r.client_id) ?? companies.set(r.client_id, emptyBucket()).get(r.client_id)!,
        services.get(r.service_id) ?? services.set(r.service_id, emptyBucket()).get(r.service_id)!,
      ]) {
        b.lookups += 1;
        if (r.state === "failed") b.failed += 1;
        else if (r.provider_status === "1") b.found += 1;
        else if (r.billable) b.paidNoData += 1;
        if (isManual) b.manual += 1;
        b.companyCost += Number(r.cost);
        b.realCost += realCost;
      }
    }

    const ids = [...companies.keys()];
    const { data: clients } = ids.length
      ? await admin.from("clients").select("id, company_name").in("id", ids)
      : { data: [] as { id: string; company_name: string }[] };
    const nameById = new Map(
      ((clients ?? []) as { id: string; company_name: string }[]).map((c) => [
        c.id,
        c.company_name,
      ]),
    );

    return {
      since,
      totals,
      truncated,
      byCompany: [...companies.entries()]
        .map(([clientId, b]) => ({
          clientId,
          companyName: nameById.get(clientId) ?? "Unassigned",
          ...b,
        }))
        .sort((a, b) => b.realCost - a.realCost),
      byService: [...services.entries()]
        .map(([serviceId, b]) => ({ serviceId, ...b }))
        .sort((a, b) => b.realCost - a.realCost),
    };
  });

/** One company's Insights configuration (enable toggle, cache TTLs, rate card) — superadmin
 * read, paired with saveCompanyProfilexSettings below for the write. Reuses profilex-actions.
 * server.ts's loadSettings so the shape/fallback defaults never drift between the two. */
export const getCompanyProfilexSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
      })
      .parse(d),
  )
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
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        enabled: z.boolean(),
        hitTtlHours: z.number().finite().min(0).max(8760),
        missTtlHours: z.number().finite().min(0).max(8760),
        rateCard: z.record(
          z.string().max(64),
          z.record(z.string().max(16), z.number().finite().min(0).max(100000)),
        ),
        enabledServices: z.array(shortText(64)).max(100),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");

    // Only real catalogue ids are stored. A stale or mistyped id would sit in the allow-list
    // doing nothing, and a service renamed later would silently lose its grant — refuse it
    // loudly instead. De-duplicated so the stored array stays a clean set.
    const unknown = data.enabledServices.filter((id) => !ALL_SERVICE_IDS.includes(id));
    if (unknown.length) {
      throw new Error(`Unknown Insights service(s): ${unknown.join(", ")}`);
    }
    // The plan as it was, to describe what changed (for a draft contract update).
    const before = await loadSettings(data.clientId);

    // CIBIL is not set from this list: it has its own switch (setCompanyCibil), which also
    // records the consent agreement. Whatever the list says, keep CIBIL exactly as it was.
    const enabledServices = [
      ...new Set(data.enabledServices.filter((id) => id !== CIBIL_SERVICE)),
      ...(before.enabled_services.includes(CIBIL_SERVICE) ? [CIBIL_SERVICE] : []),
    ];

    const admin = db();
    const { error } = await admin.from("profilex_settings").upsert(
      {
        client_id: data.clientId,
        enabled: data.enabled,
        hit_ttl_hours: data.hitTtlHours,
        miss_ttl_hours: data.missTtlHours,
        rate_card: data.rateCard,
        enabled_services: enabledServices,
        updated_at: new Date().toISOString(),
        // profilex_settings.updated_by references agents(id), not superadmins(id) — a
        // superadmin has no agents row to attribute this to, so leave it null rather than
        // writing an id the FK would reject.
        updated_by: null,
      },
      { onConflict: "client_id" },
    );
    if (error) throw new Error(`Could not save Insights settings (${error.message})`);

    const { data: client } = await admin
      .from("clients")
      .select("company_name")
      .eq("id", data.clientId)
      .maybeSingle();
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "insights_services_changed",
      clientId: data.clientId,
      summary: `Updated ${(client as { company_name: string } | null)?.company_name ?? "a company"}'s Insights settings (${enabledServices.length} service${enabledServices.length === 1 ? "" : "s"} enabled, ${data.enabled ? "on" : "off"})`,
      detail: { enabled: data.enabled, enabledServices },
    });

    // Price or service changes to a plan that already had services → draft a contract change
    // for review on Superadmin → Contracts (never shown to the company while a draft). Setting
    // up a first plan isn't a "change" — the contract schedule covers it.
    const changes = insightsPriceChanges(before, {
      enabled_services: enabledServices,
      rate_card: data.rateCard,
    });
    let draftId: string | null = null;
    if (changes.length && before.enabled_services.length) {
      // Imported lazily: contracts.server imports this file (logSuperadminActivity).
      const { createPriceChangeDraft } = await import("./contracts.server");
      draftId = await createPriceChangeDraft(caller.superadminId, data.clientId, changes);
    }

    return { ok: true, draftId };
  });

// ── Lookup-data Excel requests ─────────────────────────────────────────────────────────────────
// Companies ask for a portfolio's "Lookup data by Loan ID" Excel; a superadmin decides here. An
// approval opens that portfolio's download for EXPORT_APPROVAL_DAYS (enforced in
// getPortfolioLookupExport, profilex-actions.server.ts). See
// migrations/20260927_insights_export_requests.sql.

const EXPORT_APPROVAL_DAYS = 7;

export interface LookupExportRequestRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  note: string | null;
  clientId: string;
  companyName: string;
  portfolioId: string;
  portfolioName: string;
  lenderName: string;
  requestedByName: string;
  requestedByEmail: string;
  requestedByRole: string;
  decidedAt: string | null;
  decidedByName: string;
  decisionNote: string | null;
  expiresAt: string | null;
  downloadCount: number;
  lastDownloadAt: string | null;
  /** Lookups ever run on the portfolio — how much the file would contain. */
  lookups: number;
}

export const listLookupExportRequests = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, status: z.enum(["pending", "all"]).optional() }).parse(d),
  )
  .handler(async ({ data }): Promise<{ rows: LookupExportRequestRow[] }> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    let q = admin
      .from("insights_export_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (data.status !== "all") q = q.eq("status", "pending");
    const { data: reqs, error } = await q;
    if (error) {
      throw new Error(
        /insights_export_requests/.test(error.message)
          ? "Excel requests aren't set up yet — run migrations/20260927_insights_export_requests.sql"
          : `Could not load requests (${error.message})`,
      );
    }
    const list = reqs ?? [];
    if (!list.length) return { rows: [] };

    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const [clients, portfolios, agents, supers] = await Promise.all([
      admin
        .from("clients")
        .select("id, company_name")
        .in("id", uniq(list.map((r) => r.client_id))),
      admin
        .from("portfolios")
        .select("id, name, lender_name")
        .in("id", uniq(list.map((r) => r.portfolio_id))),
      admin
        .from("agents")
        .select("id, name, email, role")
        .in("id", uniq(list.map((r) => r.requested_by))),
      admin
        .from("superadmins")
        .select("id, name")
        .in("id", uniq(list.map((r) => r.decided_by))),
    ]);
    const byId = <T extends { id: string }>(rows: T[] | null) =>
      new Map((rows ?? []).map((r) => [r.id, r]));
    const cMap = byId(clients.data as { id: string; company_name: string }[] | null);
    const pMap = byId(
      portfolios.data as { id: string; name: string; lender_name: string | null }[] | null,
    );
    const aMap = byId(
      agents.data as { id: string; name: string; email: string; role: string }[] | null,
    );
    const sMap = byId(supers.data as { id: string; name: string }[] | null);

    // Size of each file: lookups on the portfolio's accounts. One count per portfolio.
    const counts = new Map<string, number>();
    await Promise.all(
      uniq(list.map((r) => r.portfolio_id)).map(async (pid) => {
        const { count } = await (
          admin as unknown as {
            from: (t: string) => {
              select: (
                c: string,
                o: { count: "exact"; head: true },
              ) => {
                eq: (c: string, v: string) => Promise<{ count: number | null }>;
              };
            };
          }
        )
          .from("debtor_traces")
          .select("id, debtors!inner(portfolio_id)", { count: "exact", head: true })
          .eq("debtors.portfolio_id", pid);
        counts.set(pid, count ?? 0);
      }),
    );

    return {
      rows: list.map((r) => {
        const a = r.requested_by ? aMap.get(r.requested_by) : undefined;
        const p = pMap.get(r.portfolio_id);
        return {
          id: r.id,
          status: r.status as LookupExportRequestRow["status"],
          createdAt: r.created_at,
          note: r.note,
          clientId: r.client_id,
          companyName: cMap.get(r.client_id)?.company_name ?? "Unknown company",
          portfolioId: r.portfolio_id,
          portfolioName: p?.name ?? "Deleted portfolio",
          lenderName: p?.lender_name ?? "",
          requestedByName: a?.name ?? "Unknown",
          requestedByEmail: a?.email ?? "",
          requestedByRole: a?.role ?? "",
          decidedAt: r.decided_at,
          decidedByName: (r.decided_by && sMap.get(r.decided_by)?.name) || "",
          decisionNote: r.decision_note,
          expiresAt: r.expires_at,
          downloadCount: r.download_count,
          lastDownloadAt: r.last_download_at,
          lookups: counts.get(r.portfolio_id) ?? 0,
        };
      }),
    };
  });

export const decideLookupExportRequest = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        requestId: idSchema,
        approve: z.boolean(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPORT_APPROVAL_DAYS * 86_400_000).toISOString();
    // Only a pending request can be decided — the status filter makes a double-click or two
    // superadmins acting at once a no-op instead of a second decision.
    const { data: updated, error } = await admin
      .from("insights_export_requests")
      .update({
        status: data.approve ? "approved" : "rejected",
        decided_by: caller.superadminId,
        decided_at: now.toISOString(),
        decision_note: data.note || null,
        expires_at: data.approve ? expiresAt : null,
      })
      .eq("id", data.requestId)
      .eq("status", "pending")
      .select("id, client_id, portfolio_id, requested_by")
      .maybeSingle();
    if (error) throw new Error(`Could not save the decision (${error.message})`);
    if (!updated) throw new Error("This request was already decided");

    const [{ data: client }, { data: portfolio }] = await Promise.all([
      admin.from("clients").select("company_name").eq("id", updated.client_id).maybeSingle(),
      admin.from("portfolios").select("name").eq("id", updated.portfolio_id).maybeSingle(),
    ]);
    const pName = (portfolio as { name: string } | null)?.name ?? "a portfolio";
    const cName = (client as { company_name: string } | null)?.company_name ?? "a company";

    if (updated.requested_by) {
      const { error: nErr } = await admin.from("notifications").insert({
        client_id: updated.client_id,
        to_agent_id: updated.requested_by,
        from_name: "SamvadX",
        message: data.approve
          ? `Your Insights Excel request for ${pName} was approved — download it from Reports › Insights › Lookup data by Loan ID within ${EXPORT_APPROVAL_DAYS} days.`
          : `Your Insights Excel request for ${pName} was declined${data.note ? `: ${data.note}` : "."}`,
      });
      if (nErr) console.error("[decideLookupExportRequest] notification failed:", nErr);
    }

    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: data.approve ? "insights_export_approved" : "insights_export_rejected",
      clientId: updated.client_id,
      summary: `${data.approve ? "Approved" : "Declined"} ${cName}'s Insights Excel for ${pName}`,
      detail: {
        requestId: data.requestId,
        portfolioId: updated.portfolio_id,
        note: data.note ?? null,
      },
    });
    return { ok: true };
  });

/** The company's one CIBIL switch. On = CIBIL on its plan AND its consent agreement recorded;
 *  off = neither, and nobody in the company (admin, manager or agent) sees anything CIBIL —
 *  enforced in cibil-actions.server.ts. See migrations/20261010_cibil_reports.sql. */
export const getCompanyCibil = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const { data: row, error } = await db()
      .from("profilex_settings")
      .select("enabled_services, cibil_consent_at, cibil_consent_note, superadmins(name)")
      .eq("client_id", data.clientId)
      .maybeSingle();
    // Column missing = the migration has not been applied yet.
    if (error) return { available: false, on: false, at: null, note: null, byName: null };
    const r = (row ?? {}) as {
      enabled_services?: string[] | null;
      cibil_consent_at?: string | null;
      cibil_consent_note?: string | null;
      superadmins?: { name?: string } | null;
    };
    return {
      available: true,
      on: !!r.cibil_consent_at && (r.enabled_services ?? []).includes(CIBIL_SERVICE),
      at: r.cibil_consent_at ?? null,
      note: r.cibil_consent_note ?? null,
      byName: r.superadmins?.name ?? null,
    };
  });

export const setCompanyCibil = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        on: z.boolean(),
        /** Where the company's consent agreement is — required to switch on. */
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    if (data.on && (!data.note || data.note.length < 3)) {
      throw new Error("Say where the company's consent agreement is recorded.");
    }
    const admin = db();
    const { data: row } = await admin
      .from("profilex_settings")
      .select("enabled_services")
      .eq("client_id", data.clientId)
      .maybeSingle();
    const services = ((row as { enabled_services?: string[] | null } | null)?.enabled_services ??
      []) as string[];
    const nextServices = data.on
      ? [...new Set([...services, CIBIL_SERVICE])]
      : services.filter((s) => s !== CIBIL_SERVICE);
    const patch = data.on
      ? {
          enabled_services: nextServices,
          cibil_consent_at: new Date().toISOString(),
          cibil_consent_by: caller.superadminId,
          cibil_consent_note: data.note ?? null,
        }
      : {
          enabled_services: nextServices,
          cibil_consent_at: null,
          cibil_consent_by: null,
          cibil_consent_note: null,
        };

    // Update, then insert only if the company has no settings row yet (see setCompanyDirectExport).
    const { data: existing, error: updErr } = await admin
      .from("profilex_settings")
      .update(patch)
      .eq("client_id", data.clientId)
      .select("client_id");
    if (updErr) throw new Error(`Could not save (${updErr.message})`);
    if (!existing?.length) {
      const { error } = await admin
        .from("profilex_settings")
        .insert({ client_id: data.clientId, rate_card: {}, ...patch });
      if (error) throw new Error(`Could not save (${error.message})`);
    }

    const { data: client } = await admin
      .from("clients")
      .select("company_name")
      .eq("id", data.clientId)
      .maybeSingle();
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "insights_cibil_changed",
      clientId: data.clientId,
      summary: `Turned CIBIL reports ${data.on ? "on" : "off"} for ${(client as { company_name: string } | null)?.company_name ?? "a company"}`,
      detail: { on: data.on, consentNote: data.note ?? null },
    });
    return { ok: true };
  });

/** Whether a company downloads the lookup-data Excel without asking (the platform's own). */
export const getCompanyDirectExport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const { data: row } = await db()
      .from("profilex_settings")
      .select("direct_export")
      .eq("client_id", data.clientId)
      .maybeSingle();
    return { direct: !!(row as { direct_export?: boolean } | null)?.direct_export };
  });

export const setCompanyDirectExport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema, direct: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = db();
    // Update, then insert only if the company has no settings row yet — an upsert would reset
    // the row's other columns (enabled, rate card) to defaults on a company that has none.
    const { data: existing } = await admin
      .from("profilex_settings")
      .update({ direct_export: data.direct })
      .eq("client_id", data.clientId)
      .select("client_id");
    if (!existing?.length) {
      const { error } = await admin
        .from("profilex_settings")
        .insert({ client_id: data.clientId, direct_export: data.direct, rate_card: {} });
      if (error) throw new Error(`Could not save (${error.message})`);
    }
    const { data: client } = await admin
      .from("clients")
      .select("company_name")
      .eq("id", data.clientId)
      .maybeSingle();
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "insights_direct_export_changed",
      clientId: data.clientId,
      summary: `${data.direct ? "Allowed" : "Removed"} direct Insights Excel download for ${(client as { company_name: string } | null)?.company_name ?? "a company"}`,
      detail: { direct: data.direct },
    });
    return { ok: true };
  });
