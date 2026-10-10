// Enforces "one account, one active device": called once, right after a successful login (see
// auth.tsx's login()). Revokes every OTHER session's refresh token immediately via Supabase
// Auth's admin API, then rotates agents.session_nonce so any tab still open elsewhere notices
// over Realtime and signs itself out — see the migration note in
// 20260908_single_active_session.sql for why both halves are needed.

import { z, tokenSchema, shortText } from "./schemas";
import { randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { roleNeedsEmailOtp } from "./login-otp";
import { addressFor, subdomainFromHostname, wrongAddressRedirect } from "./company-address";

/** Whether this account must confirm the sign-in with an emailed code (admins and
 * superadmins — see login-otp.ts). Called by login() with the PASSWORD session's token, so it
 * deliberately does not go through verifyCaller/verifySuperadminCaller: those refuse exactly
 * this password-only token for an elevated account. Fails closed — on a lookup error the
 * caller is told a code is required, never waved through. */
export const checkLoginOtpRequired = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const admin = getSupabaseAdmin();
    const {
      data: { user },
      error: userErr,
    } = await admin.auth.getUser(data.accessToken);
    if (userErr || !user) return { required: true as const };

    const [superadmin, agent] = await Promise.all([
      admin.from("superadmins").select("id").eq("auth_user_id", user.id).maybeSingle(),
      admin.from("agents").select("role").eq("auth_user_id", user.id).maybeSingle(),
    ]);
    if (superadmin.error || agent.error) return { required: true as const };
    if (superadmin.data) return { required: true as const };
    return { required: roleNeedsEmailOtp((agent.data as { role?: string } | null)?.role) };
  });

/** Called once, right after a successful sign-in (see auth.tsx's login()), with the hostname
 * the browser is on. Each company signs in only at its own address: <subdomain>.samvadx.com if a
 * superadmin assigned one, else the platform address — see company-address.ts for the rule and
 * why it is routing, not data security. A user on the wrong address gets `redirectTo`, the
 * subdomain they belong on; the browser sends them there. Superadmins may sign in anywhere, and
 * hosts outside samvadx.com (localhost, previews) are never checked. */
export const verifySubdomainAccess = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        hostname: shortText(255),
      })
      .parse(d),
  )
  .handler(
    async ({ data }): Promise<{ ok: true } | { ok: false; error: string; redirectTo?: string }> => {
      if (!subdomainFromHostname(data.hostname)) return { ok: true };

      const admin = getSupabaseAdmin();
      const {
        data: { user },
        error: userErr,
      } = await admin.auth.getUser(data.accessToken);
      if (userErr || !user) {
        return { ok: false, error: "Your session has expired — please sign in again." };
      }

      const [superadmin, agent] = await Promise.all([
        admin.from("superadmins").select("id").eq("auth_user_id", user.id).maybeSingle(),
        admin.from("agents").select("client_id").eq("auth_user_id", user.id).maybeSingle(),
      ]);
      if (superadmin.error || agent.error) {
        // Fail OPEN on a lookup error rather than locking people out over a transient DB blip —
        // this check is routing, not the data boundary (RLS is).
        console.error("[verifySubdomainAccess] lookup failed:", superadmin.error ?? agent.error);
        return { ok: true };
      }
      if (superadmin.data) return { ok: true };
      // No company profile at all: nothing to route by; the app shows its own error for this.
      if (!agent.data?.client_id) return { ok: true };

      const { data: company, error: companyErr } = await admin
        .from("clients")
        .select("company_name, subdomain")
        .eq("id", agent.data.client_id)
        .maybeSingle();
      if (companyErr || !company) {
        console.error("[verifySubdomainAccess] company lookup failed:", companyErr);
        return { ok: true };
      }
      const target = wrongAddressRedirect(data.hostname, company.subdomain);
      if (!target) return { ok: true };

      return {
        ok: false,
        error: company.subdomain
          ? `${company.company_name} signs in at ${addressFor(target)} — taking you there now.`
          : `Your company signs in at ${addressFor(target)} — taking you there now.`,
        redirectTo: target,
      };
    },
  );

export const enforceSingleSession = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) {
      return { ok: false as const, error: "Your session has expired — please sign in again." };
    }

    const admin = getSupabaseAdmin();

    // Takes the JWT that was just issued (not a user id) and revokes every OTHER session
    // belonging to the same user, keeping this one alive.
    const { error: signOutErr } = await admin.auth.admin.signOut(data.accessToken, "others");
    if (signOutErr) {
      console.error(
        `[enforceSingleSession] signOut(others) failed for ${caller.authUserId}:`,
        signOutErr,
      );
    }

    const sessionNonce = randomBytes(16).toString("hex");
    if (caller.agentId) {
      const { error: nonceErr } = await admin
        .from("agents")
        .update({ session_nonce: sessionNonce })
        .eq("id", caller.agentId);
      if (nonceErr) {
        console.error(
          `[enforceSingleSession] session_nonce update failed for agent ${caller.agentId}:`,
          nonceErr,
        );
      }
    }

    return { ok: true as const, sessionNonce };
  });
