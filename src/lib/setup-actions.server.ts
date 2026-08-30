// Bootstrap a brand-new company + its first admin account. Internal tool for spinning up a
// new customer — intentionally has NO abuse-prevention (no rate limiting, no email
// verification, no CAPTCHA). If this route ever needs to be reachable by untrusted parties,
// all of that needs to be added first; until then it must never be linked anywhere public.
//
// Unlike inviteUser (user-admin-actions.server.ts), this action has no existing caller to
// verify — the whole point is creating the very first account for a company that doesn't
// exist yet — so it skips the verifyCaller() chokepoint by design.

import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin } from "./supabase-admin.server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createCompany = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { companyName: string; adminName: string; adminEmail: string; adminPassword: string }) => d,
  )
  .handler(async ({ data }) => {
    const companyName = data.companyName.trim();
    const adminName = data.adminName.trim();
    const adminEmail = data.adminEmail.trim().toLowerCase();
    const adminPassword = data.adminPassword;

    if (!companyName || !adminName || !adminEmail) {
      return { ok: false as const, error: "Fill in all fields." };
    }
    if (!EMAIL_RE.test(adminEmail)) {
      return { ok: false as const, error: "Enter a valid email address." };
    }
    if (adminPassword.length < 8) {
      return { ok: false as const, error: "Password must be at least 8 characters." };
    }

    const admin = getSupabaseAdmin();

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
    });
    if (authErr || !authData.user) {
      const msg = authErr?.message ?? "";
      if (/already.*registered|already exists/i.test(msg)) {
        return { ok: false as const, error: "That email already has an account." };
      }
      return { ok: false as const, error: msg || "Could not create the admin login." };
    }
    const authUserId = authData.user.id;

    const { data: client, error: clientErr } = await admin
      .from("clients")
      .insert({ company_name: companyName })
      .select("id")
      .single();
    if (clientErr || !client) {
      // No cross-service transaction between GoTrue and Postgres — roll back the Auth
      // account manually so a failed company row doesn't leave an orphaned login.
      await admin.auth.admin.deleteUser(authUserId).catch((err) => {
        console.error(
          `[createCompany] failed to roll back orphaned auth user ${authUserId} after clients insert failure:`,
          err,
        );
      });
      return { ok: false as const, error: clientErr?.message ?? "Could not create the company." };
    }

    const { error: agentErr } = await admin.from("agents").insert({
      auth_user_id: authUserId,
      client_id: client.id,
      name: adminName,
      email: adminEmail,
      role: "admin",
    });
    if (agentErr) {
      await admin.auth.admin.deleteUser(authUserId).catch((err) => {
        console.error(
          `[createCompany] failed to roll back orphaned auth user ${authUserId} after agents insert failure:`,
          err,
        );
      });
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
          : agentErr.message,
      };
    }

    return { ok: true as const, clientId: client.id as string, authUserId };
  });
