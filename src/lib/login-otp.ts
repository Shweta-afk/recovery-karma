// Admins and superadmins confirm every sign-in with a one-time code emailed by Supabase
// (signInWithOtp + verifyOtp), on top of their password. This file holds the one rule shared
// by the browser (auth.tsx), the server actions (supabase-admin.server.ts) and, in SQL form,
// the database (migrations/20261006_admin_email_otp.sql's auth_role()):
//
//   a session counts as email-verified when its access token's `amr` claim records an email
//   code (`otp`) or the link in that same email (`magiclink`).
//
// A password-only session for an elevated account is still a valid Supabase session — it just
// carries no admin power anywhere. Keep EMAIL_OTP_AMR_METHODS identical to the SQL list.
//
// Pure: no imports, so the browser bundle and the server can both use it.

import type { Role } from "./auth";

export const EMAIL_OTP_AMR_METHODS = ["otp", "magiclink"] as const;

/** Roles that must pass the emailed code before they get their powers. */
export function roleNeedsEmailOtp(role: Role | string | null | undefined): boolean {
  return role === "admin" || role === "superadmin";
}

/** Reads the `amr` claim straight out of the JWT payload. Does NOT verify the signature —
 * callers only use this on a token Supabase has already accepted (getUser on the server, or
 * the client's own session in the browser). Any malformed token reads as "not verified". */
export function tokenHasEmailOtp(accessToken: string | null | undefined): boolean {
  if (!accessToken) return false;
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return false;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as {
      amr?: unknown;
    };
    if (!Array.isArray(json.amr)) return false;
    return json.amr.some(
      (e) =>
        !!e &&
        typeof e === "object" &&
        (EMAIL_OTP_AMR_METHODS as readonly string[]).includes(
          String((e as { method?: unknown }).method),
        ),
    );
  } catch {
    return false;
  }
}
