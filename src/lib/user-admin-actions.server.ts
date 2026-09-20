// Invite a new manager/agent with a real, working login — replaces the old flow where
// "Invite User" only created a database profile row and an admin had to manually create a
// matching login in the Supabase Dashboard.
//
// Uses the service-role client, which bypasses RLS entirely, so this file is the other half
// of the security-critical pattern started in supabase-admin.server.ts: every write below is
// scoped to caller.clientId (resolved server-side via verifyCaller), never to anything the
// browser claims about itself.

import { z, tokenSchema, idSchema, shortText, emailSchema, grantableRoleSchema } from "./schemas";
import { randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import type { Role } from "./auth";

function generatePassword(): string {
  return randomBytes(12).toString("base64url"); // 16 chars, URL-safe
}

export const inviteUser = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        name: shortText(),
        email: emailSchema,
        role: grantableRoleSchema,
        managerId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) {
      return { ok: false as const, error: "Your session has expired — please sign in again." };
    }
    if (caller.role !== "admin") {
      return { ok: false as const, error: "Only admins can invite users." };
    }
    enforceRateLimit(`invite-user:${caller.authUserId}`, 30, 60 * 60_000);

    const name = data.name.trim();
    const email = data.email.trim().toLowerCase();
    if (!name || !email) {
      return { ok: false as const, error: "Fill in all fields." };
    }

    const admin = getSupabaseAdmin();

    // Seat limit check (20260909_company_seat_limits.sql) — superadmin-set, NULL means
    // unlimited. Only agent/manager invites are capped; admin invites are not.
    if (data.role === "agent" || data.role === "manager") {
      const [{ data: clientRow, error: clientErr }, { count: currentCount, error: countErr }] =
        await Promise.all([
          admin
            .from("clients")
            .select("max_agents, max_managers")
            .eq("id", caller.clientId)
            .maybeSingle(),
          admin
            .from("agents")
            .select("id", { count: "exact", head: true })
            .eq("client_id", caller.clientId)
            .eq("role", data.role),
        ]);
      if (clientErr) {
        return { ok: false as const, error: `Could not verify seat limits (${clientErr.message})` };
      }
      if (countErr) {
        return { ok: false as const, error: `Could not verify seat limits (${countErr.message})` };
      }
      const limit = data.role === "agent" ? clientRow?.max_agents : clientRow?.max_managers;
      if (limit !== null && limit !== undefined && (currentCount ?? 0) >= limit) {
        return {
          ok: false as const,
          error: `Your company's ${data.role} limit (${limit}) has been reached — contact SamvadX support to raise it.`,
        };
      }
    }

    const temporaryPassword = generatePassword();

    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
    });
    if (authErr || !authData.user) {
      const msg = authErr?.message ?? "";
      if (/already.*registered|already exists/i.test(msg)) {
        return { ok: false as const, error: "That email already has an account." };
      }
      return { ok: false as const, error: msg || "Could not create the login." };
    }
    const authUserId = authData.user.id;

    const { data: agentRow, error: agentErr } = await admin
      .from("agents")
      .insert({
        auth_user_id: authUserId,
        client_id: caller.clientId,
        name,
        email,
        role: data.role,
      })
      .select("id")
      .single();
    if (agentErr || !agentRow) {
      await admin.auth.admin.deleteUser(authUserId).catch((err) => {
        console.error(
          `[inviteUser] failed to roll back orphaned auth user ${authUserId} after agents insert failure:`,
          err,
        );
      });
      return {
        ok: false as const,
        error:
          agentErr && /duplicate key|already exists/i.test(agentErr.message)
            ? "That email already has an account."
            : (agentErr?.message ?? "Could not create the user."),
      };
    }

    if (data.role === "agent" && data.managerId) {
      const teamErr = await addAgentToManagerTeam(
        caller.clientId,
        data.managerId,
        agentRow.id as string,
      );
      if (teamErr) {
        // The login and profile were created successfully — team assignment is a secondary
        // step, so surface it as a warning rather than rolling back the whole invite.
        console.error(
          `[inviteUser] created ${email} but failed to assign to manager's team:`,
          teamErr,
        );
      }
    }

    return { ok: true as const, temporaryPassword, name, email };
  });

/** Finds the manager's existing team (creating one if they don't have one yet) and adds
 * agentId to it. Reimplements the shape of team-store.ts's saveTeam() using the service-role
 * client instead of the anon-key browser client — saveTeam() itself can't be called from a
 * server action since it's built around the browser's Supabase singleton. */
async function addAgentToManagerTeam(
  clientId: string,
  managerId: string,
  agentId: string,
): Promise<string | null> {
  const admin = getSupabaseAdmin();

  const { data: manager, error: managerErr } = await admin
    .from("agents")
    .select("id, name, role")
    .eq("id", managerId)
    .eq("client_id", clientId)
    .single();
  if (managerErr || !manager || manager.role !== "manager") {
    return managerErr?.message ?? "Manager not found in this company.";
  }

  const { data: existingTeam, error: findErr } = await admin
    .from("teams")
    .select("id")
    .eq("client_id", clientId)
    .eq("manager_id", managerId)
    .maybeSingle();
  if (findErr) return findErr.message;

  let teamId = existingTeam?.id as string | undefined;
  if (!teamId) {
    const { data: newTeam, error: createErr } = await admin
      .from("teams")
      .insert({ client_id: clientId, manager_id: managerId, name: `${manager.name}'s Team` })
      .select("id")
      .single();
    if (createErr || !newTeam) return createErr?.message ?? "Could not create team.";
    teamId = newTeam.id as string;
  }

  const { error: memberErr } = await admin
    .from("team_agents")
    .upsert({ team_id: teamId, agent_id: agentId }, { onConflict: "team_id,agent_id" });
  return memberErr?.message ?? null;
}

/**
 * Admin-only: (re)issue a login password for an existing agent row.
 *
 * Handles both cases the Users table can show: an agent who already has a working login
 * (auth_user_id set) gets their password overwritten via updateUserById; a "Pending login"
 * agent (a profile row with no auth_user_id — e.g. added before invite-with-login existed)
 * gets a brand-new auth user created and linked, same as inviteUser's first step. Either way
 * the admin sees one new one-time password to hand off, same UX as the original invite.
 */
export const resetUserPassword = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        agentId: idSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) {
      return { ok: false as const, error: "Your session has expired — please sign in again." };
    }
    if (caller.role !== "admin") {
      return { ok: false as const, error: "Only admins can reset passwords." };
    }
    enforceRateLimit(`reset-password:${caller.authUserId}`, 20, 60 * 60_000);

    const admin = getSupabaseAdmin();
    const { data: agent, error: agentErr } = await admin
      .from("agents")
      .select("id, name, email, auth_user_id")
      .eq("id", data.agentId)
      .eq("client_id", caller.clientId)
      .single();
    if (agentErr || !agent) {
      return { ok: false as const, error: "User not found in this company." };
    }

    const temporaryPassword = generatePassword();
    const authUserId = agent.auth_user_id as string | null;

    if (authUserId) {
      const { error: updateErr } = await admin.auth.admin.updateUserById(authUserId, {
        password: temporaryPassword,
      });
      if (updateErr) {
        return { ok: false as const, error: updateErr.message };
      }
    } else {
      // No login yet — create one and link it, same as inviteUser.
      const { data: authData, error: createErr } = await admin.auth.admin.createUser({
        email: agent.email as string,
        password: temporaryPassword,
        email_confirm: true,
      });
      if (createErr || !authData.user) {
        return { ok: false as const, error: createErr?.message ?? "Could not create the login." };
      }
      const { error: linkErr } = await admin
        .from("agents")
        .update({ auth_user_id: authData.user.id })
        .eq("id", agent.id);
      if (linkErr) {
        await admin.auth.admin.deleteUser(authData.user.id).catch((err) => {
          console.error(
            `[resetUserPassword] failed to roll back orphaned auth user ${authData.user.id} after agents link failure:`,
            err,
          );
        });
        return { ok: false as const, error: linkErr.message };
      }
    }

    return {
      ok: true as const,
      temporaryPassword,
      name: agent.name as string,
      email: agent.email as string,
    };
  });
