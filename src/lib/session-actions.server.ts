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

// Matches a single-label subdomain of samvadx.com — "raerae.samvadx.com" -> "raerae". Deliberately
// does NOT match a bare "samvadx.com", "www.samvadx.com", any *.up.railway.app domain, or
// "localhost": only an exact one-label samvadx.com subdomain can ever be scoped, so the
// platform's own domains and local dev are never accidentally restricted.
const SUBDOMAIN_HOSTNAME_RE = /^([a-z0-9-]+)\.samvadx\.com$/i;

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
 * the browser is actually on. If that hostname is a company's assigned subdomain
 * (clients.subdomain, set by a superadmin — 20260909_company_verification_and_subdomain.sql),
 * only that company's own users may sign in there; anyone else's login is rejected outright,
 * before enforceSingleSession or the profile fetch ever run. A superadmin (no client_id) and
 * any hostname that ISN'T a claimed company subdomain (including axiotta.samvadx.com today,
 * since nothing has claimed "axiotta" as a subdomain) are unaffected — this only restricts
 * logins on a subdomain a superadmin has actually assigned to one specific company. */
export const verifySubdomainAccess = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        hostname: shortText(255),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const match = SUBDOMAIN_HOSTNAME_RE.exec(data.hostname.trim().toLowerCase());
    if (!match) return { ok: true as const };
    const slug = match[1];

    const admin = getSupabaseAdmin();
    const { data: client, error: clientErr } = await admin
      .from("clients")
      .select("id, company_name")
      .eq("subdomain", slug)
      .maybeSingle();
    if (clientErr) {
      // Fail OPEN on a lookup error rather than locking everyone on this subdomain out over a
      // transient DB blip — the worst case is the same as before this feature existed.
      console.error(`[verifySubdomainAccess] lookup failed for subdomain "${slug}":`, clientErr);
      return { ok: true as const };
    }
    if (!client) return { ok: true as const }; // nobody's claimed this subdomain — unscoped

    const {
      data: { user },
      error: userErr,
    } = await admin.auth.getUser(data.accessToken);
    if (userErr || !user) {
      return { ok: false as const, error: "Your session has expired — please sign in again." };
    }

    // A superadmin isn't scoped to any one client_id, so they're never blocked by a company's
    // own subdomain — they're expected to be able to reach any company from anywhere.
    const { data: superadmin } = await admin
      .from("superadmins")
      .select("id")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (superadmin) return { ok: true as const };

    const { data: agent } = await admin
      .from("agents")
      .select("client_id")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (agent?.client_id === client.id) return { ok: true as const };

    return {
      ok: false as const,
      error: `This address is only for ${client.company_name}'s team — sign in at your own company's address instead.`,
    };
  });

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
