// Enforces "one account, one active device": called once, right after a successful login (see
// auth.tsx's login()). Revokes every OTHER session's refresh token immediately via Supabase
// Auth's admin API, then rotates agents.session_nonce so any tab still open elsewhere notices
// over Realtime and signs itself out — see the migration note in
// 20260908_single_active_session.sql for why both halves are needed.

import { randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";

export const enforceSingleSession = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
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
