// Bootstrap a brand-new company + its first admin account. Internal tool for spinning up a
// new customer — unlinked from anything customer-facing, reached only via the low-key link on
// the login page. It now DOES require proof the caller owns adminEmail: setup.tsx sends a
// Supabase email OTP (signInWithOtp) before ever calling this, and passes the resulting
// session's accessToken here — see the accessToken handling below. There is still no rate
// limiting or CAPTCHA beyond whatever Supabase's own OTP endpoint enforces.
//
// Unlike inviteUser (user-admin-actions.server.ts), this action has no existing agents-row
// caller to verify — the whole point is creating the very first account for a company that
// doesn't exist yet — so it skips the verifyCaller() chokepoint by design. The accessToken it
// does require comes from GoTrue's own OTP verification, not from an existing agents row.

import { GSTIN_RE, normaliseGstin, stateFromGstin } from "./invoice-math";
import { z, tokenSchema, shortText, emailSchema, passwordSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import { appError } from "./app-error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createCompany = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        companyName: shortText(),
        /** GSTIN — required unless the company says it isn't registered for GST. */
        gstin: z.string().trim().max(20).optional(),
        gstUnregistered: z.boolean().optional(),
        adminName: shortText(),
        adminEmail: emailSchema,
        adminPassword: passwordSchema,
        /** Session token from supabase.auth.verifyOtp() — proves the caller owns adminEmail. */
        accessToken: tokenSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const companyName = data.companyName.trim();
    const adminName = data.adminName.trim();
    const adminEmail = data.adminEmail.trim().toLowerCase();
    const adminPassword = data.adminPassword;

    if (!companyName || !adminName || !adminEmail) {
      return { ok: false as const, error: "Fill in all fields." };
    }
    // The GSTIN goes on every invoice SamvadX issues this company, so it's asked at sign-up.
    const gstin = data.gstUnregistered ? null : normaliseGstin(data.gstin ?? "");
    if (!data.gstUnregistered && !GSTIN_RE.test(gstin ?? "")) {
      return {
        ok: false as const,
        error:
          "Enter your company's 15-character GSTIN (e.g. 27AAPFU0939F1ZV), or tick “not registered for GST”.",
      };
    }
    if (!EMAIL_RE.test(adminEmail)) {
      return { ok: false as const, error: "Enter a valid email address." };
    }
    if (adminPassword.length < 8) {
      return { ok: false as const, error: "Password must be at least 8 characters." };
    }
    if (!data.accessToken) {
      return { ok: false as const, error: "Verify your email first." };
    }

    const admin = getSupabaseAdmin();

    // Confirm the accessToken really is a GoTrue session for adminEmail that came out of a
    // completed OTP verification (email_confirmed_at set) — never trust the email string in
    // the form body on its own.
    const {
      data: { user: otpUser },
      error: otpUserErr,
    } = await admin.auth.getUser(data.accessToken);
    if (otpUserErr || !otpUser) {
      return {
        ok: false as const,
        error: "Your verification session expired — verify your email again.",
      };
    }
    if (otpUser.email?.toLowerCase() !== adminEmail) {
      return {
        ok: false as const,
        error: "That verification code was for a different email address.",
      };
    }
    if (!otpUser.email_confirmed_at) {
      return { ok: false as const, error: "Verify your email first." };
    }
    const authUserId = otpUser.id;
    // Each attempt sets a password and can create a company + admin; nobody needs more than a few.
    try {
      enforceRateLimit(`create-company:${authUserId}`, 5, 60 * 60_000);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }

    // signInWithOtp(shouldCreateUser: true) signs into an EXISTING auth user if adminEmail
    // already has one — including one that already belongs to a company. Without this check,
    // someone who merely knows a rival admin's email could "verify" it (they do receive the
    // OTP, since it's genuinely their inbox... unless it's a shared/role email) and end up
    // attached here. Block it outright: an email with an existing company must sign in there,
    // not spin up a second one under the same login.
    const { data: existingAgent } = await admin
      .from("agents")
      .select("id")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (existingAgent) {
      return {
        ok: false as const,
        error: "That email already has a company — sign in instead.",
      };
    }

    // The OTP session has no password on it yet (signInWithOtp never collects one) — set the
    // one the form just captured now that we know this really is adminEmail's inbox.
    const { error: pwErr } = await admin.auth.admin.updateUserById(authUserId, {
      password: adminPassword,
    });
    if (pwErr) {
      return {
        ok: false as const,
        error: appError("SX-5301", "Could not set your password.", pwErr).message,
      };
    }

    const { data: client, error: clientErr } = await admin
      .from("clients")
      .insert({ company_name: companyName })
      .select("id")
      .single();
    if (clientErr || !client) {
      // Unlike the old direct-createUser path, authUserId is a real, OTP-verified login that
      // predates this handler — don't delete it on a failed company row. The caller can just
      // retry (a fresh OTP re-verifies the same account) rather than losing their login.
      return {
        ok: false as const,
        error: appError("SX-5302", "Could not create the company.", clientErr).message,
      };
    }

    const { error: agentErr } = await admin.from("agents").insert({
      auth_user_id: authUserId,
      client_id: client.id,
      name: adminName,
      email: adminEmail,
      role: "admin",
    });
    if (agentErr) {
      // Same reasoning as above — leave the OTP-verified auth user alone, only roll back the
      // client row.
      await admin
        .from("clients")
        .delete()
        .eq("id", client.id as string)
        .then(({ error }) => {
          if (error)
            console.error(
              `[createCompany] failed to roll back orphaned client ${client.id} after agents insert failure:`,
              error,
            );
        });
      return {
        ok: false as const,
        error: /duplicate key|already exists/i.test(agentErr.message)
          ? "That email already has an account."
          : appError("SX-5303", "Could not create your account.", agentErr).message,
      };
    }

    // Start the company's invoice/agreement details (client_billing) with what sign-up knows:
    // the name, and from the GSTIN its state and PAN. The admin completes the rest on Admin →
    // Settings (company-details.ts) — the red banner asks them to. Best-effort: a failure here
    // must not undo a company that was just created.
    const { error: billErr } = await admin.from("client_billing").insert({
      client_id: client.id as string,
      legal_name: companyName,
      address: "",
      gstin,
      gst_unregistered: !!data.gstUnregistered,
      state_code: gstin ? stateFromGstin(gstin) : null,
      pan: gstin ? gstin.slice(2, 12) : null,
    });
    if (billErr) console.error("[createCompany] could not save the company's GSTIN:", billErr);

    return { ok: true as const, clientId: client.id as string, authUserId };
  });
