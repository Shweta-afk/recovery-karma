// Server actions around the shared SkyCRM account: per-company settings and extension assignment
// (superadmin), the do-not-call list (company users), and the agent-side SkyCRM calls —
// disposition sync, inbound queue presence, and the incoming-call screen pop.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, noteSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { getTelephonyProvider } from "./telephony";
import { ledgerByProviderCallId, loadTelephonySettings } from "./telephony/guard.server";
import {
  channelAllocationError,
  normalisePhone,
  type TelephonySettingsRow,
} from "./telephony/guard-rules";
import {
  pauseQueue,
  registerQueue,
  sendDisposition,
  skycrmDispositionFor,
  unpauseQueue,
} from "./telephony/skycrm-provider";

// telephony_settings / do_not_call / telephony_calls / agents.agent_extension are not in
// database.types.ts until `bun run gen:types` runs after 20260926_skycrm_telephony.sql.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabaseAdmin() as any;

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/);
const extensionSchema = z.string().trim().regex(/^\d{3,6}$/, "Extensions are 3–6 digits");

async function requireCaller(accessToken: string) {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  return caller;
}

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

// ─── Superadmin: company telephony settings + extensions ─────────────────────────

export interface CompanyTelephony {
  provider: string;
  settings: TelephonySettingsRow | null;
  /** channel_limit held by every OTHER company — the trunk is shared */
  otherCompaniesChannels: number;
  agents: Array<{ id: string; name: string; email: string; role: string; extension: string | null }>;
}

export const getCompanyTelephony = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<CompanyTelephony> => {
    await requireSuperadmin(data.accessToken);
    const [settings, others, agents] = await Promise.all([
      loadTelephonySettings(data.clientId),
      db().from("telephony_settings").select("channel_limit").neq("client_id", data.clientId),
      db()
        .from("agents")
        .select("id, name, email, role, agent_extension, is_active")
        .eq("client_id", data.clientId)
        .order("name"),
    ]);
    if (agents.error) throw new Error(`Could not load users (${agents.error.message})`);
    return {
      provider: getTelephonyProvider().name,
      settings,
      otherCompaniesChannels: ((others.data ?? []) as Array<{ channel_limit: number }>).reduce(
        (sum, r) => sum + (r.channel_limit ?? 0),
        0,
      ),
      agents: (
        agents.data as Array<{
          id: string;
          name: string;
          email: string;
          role: string;
          agent_extension: string | null;
          is_active: boolean | null;
        }>
      )
        .filter((a) => a.is_active !== false)
        .map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          role: a.role,
          extension: a.agent_extension,
        })),
    };
  });

export const saveCompanyTelephony = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        enabled: z.boolean(),
        seatLimit: z.number().int().min(0).max(100000).nullable(),
        channelLimit: z.number().int().min(0).max(1000),
        inboundDid: z.string().trim().max(20).nullable(),
        inboundQueue: z.string().trim().max(50).nullable(),
        callWindowStart: timeSchema,
        callWindowEnd: timeSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    if (data.callWindowStart < "08:00" || data.callWindowEnd > "19:00") {
      throw new Error("Calling hours must stay within 08:00–19:00 IST (RBI rule for recovery calls).");
    }
    if (data.callWindowStart >= data.callWindowEnd) {
      throw new Error("The calling window must start before it ends.");
    }

    const { data: others } = await db()
      .from("telephony_settings")
      .select("channel_limit")
      .neq("client_id", data.clientId);
    const otherTotal = ((others ?? []) as Array<{ channel_limit: number }>).reduce(
      (s, r) => s + (r.channel_limit ?? 0),
      0,
    );
    const allocError = channelAllocationError(otherTotal, data.channelLimit);
    if (allocError) throw new Error(allocError);

    if (data.seatLimit !== null) {
      const { count } = await db()
        .from("agents")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId)
        .not("agent_extension", "is", null);
      if ((count ?? 0) > data.seatLimit) {
        throw new Error(
          `${count} users already have extensions. Remove some before lowering the limit to ${data.seatLimit}.`,
        );
      }
    }

    const row = {
      client_id: data.clientId,
      enabled: data.enabled,
      seat_limit: data.seatLimit,
      channel_limit: data.channelLimit,
      inbound_did: data.inboundDid || null,
      inbound_queue: data.inboundQueue || null,
      call_window_start: data.callWindowStart,
      call_window_end: data.callWindowEnd,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db().from("telephony_settings").upsert(row, { onConflict: "client_id" });
    if (error) throw new Error(`Could not save telephony settings (${error.message})`);

    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "telephony_settings_set",
      clientId: data.clientId,
      summary: `Telephony ${data.enabled ? "enabled" : "disabled"}: ${data.channelLimit} channels, ${data.seatLimit ?? "unlimited"} extensions, ${data.callWindowStart}–${data.callWindowEnd} IST`,
      detail: { ...row, updated_at: null },
    });
    return { ok: true };
  });

export const setAgentExtension = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        agentId: idSchema,
        extension: extensionSchema.nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: agent } = await db()
      .from("agents")
      .select("id, name, agent_extension")
      .eq("id", data.agentId)
      .eq("client_id", data.clientId)
      .maybeSingle();
    if (!agent) throw new Error("That user is not in this company");
    const prior = agent as { name: string; agent_extension: string | null };

    if (data.extension && !prior.agent_extension) {
      const settings = await loadTelephonySettings(data.clientId);
      if (settings?.seat_limit != null) {
        const { count } = await db()
          .from("agents")
          .select("id", { count: "exact", head: true })
          .eq("client_id", data.clientId)
          .not("agent_extension", "is", null);
        if ((count ?? 0) >= settings.seat_limit) {
          throw new Error(
            `This company has used all ${settings.seat_limit} of its extensions. Raise the limit first.`,
          );
        }
      }
    }

    const { error } = await db()
      .from("agents")
      .update({ agent_extension: data.extension })
      .eq("id", data.agentId);
    if (error) {
      if (error.code === "23505") {
        throw new Error(`Extension ${data.extension} is already assigned to another user.`);
      }
      throw new Error(`Could not set the extension (${error.message})`);
    }

    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "agent_extension_set",
      clientId: data.clientId,
      summary: data.extension
        ? `Assigned extension ${data.extension} to ${prior.name}`
        : `Removed extension ${prior.agent_extension ?? ""} from ${prior.name}`,
      detail: { agentId: data.agentId, extension: { from: prior.agent_extension, to: data.extension } },
    });
    return { ok: true };
  });

/** The caller's own company settings (read-only view for admins). */
export const getMyTelephony = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    return {
      provider: getTelephonyProvider().name,
      settings: await loadTelephonySettings(caller.clientId),
    };
  });

// ─── Company users: do-not-call list ─────────────────────────────────────────────

export interface DoNotCallEntry {
  id: string;
  phone: string;
  reason: string | null;
  debtorId: string | null;
  debtorName: string | null;
  addedBy: string | null;
  createdAt: string;
}

export const listDoNotCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, search: z.string().max(20).optional() }).parse(d),
  )
  .handler(async ({ data }): Promise<DoNotCallEntry[]> => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role === "agent") throw new Error("Only managers and admins can view this list");
    let query = db()
      .from("do_not_call")
      .select("id, phone, reason, debtor_id, created_at, debtors(name), agents(name)")
      .eq("client_id", caller.clientId)
      .order("created_at", { ascending: false })
      .limit(500);
    const digits = (data.search ?? "").replace(/\D/g, "");
    if (digits) query = query.like("phone", `%${digits}%`);
    const { data: rows, error } = await query;
    if (error) throw new Error(`Could not load the do-not-call list (${error.message})`);
    return (
      rows as Array<{
        id: string;
        phone: string;
        reason: string | null;
        debtor_id: string | null;
        created_at: string;
        debtors: { name: string } | null;
        agents: { name: string } | null;
      }>
    ).map((r) => ({
      id: r.id,
      phone: r.phone,
      reason: r.reason,
      debtorId: r.debtor_id,
      debtorName: r.debtors?.name ?? null,
      addedBy: r.agents?.name ?? null,
      createdAt: r.created_at,
    }));
  });

/** Any user in the company may add a number (an agent marks it when the borrower asks). */
export const addDoNotCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        phone: z.string().max(20).optional(),
        debtorId: idSchema.optional(),
        reason: noteSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    let phone = data.phone ? normalisePhone(data.phone) : "";
    if (data.debtorId) {
      const { data: debtor } = await db()
        .from("debtors")
        .select("id, phone_primary")
        .eq("id", data.debtorId)
        .eq("client_id", caller.clientId)
        .maybeSingle();
      if (!debtor) throw new Error("That account is not in your company");
      if (!phone) phone = normalisePhone((debtor as { phone_primary: string | null }).phone_primary ?? "");
    }
    if (phone.length !== 10) throw new Error("Enter a valid 10-digit phone number");

    const { error } = await db()
      .from("do_not_call")
      .upsert(
        {
          client_id: caller.clientId,
          phone,
          debtor_id: data.debtorId ?? null,
          reason: data.reason?.trim() || null,
          added_by: caller.agentId,
        },
        { onConflict: "client_id,phone", ignoreDuplicates: true },
      );
    if (error) throw new Error(`Could not add the number (${error.message})`);
    return { ok: true, phone };
  });

export const removeDoNotCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "admin") throw new Error("Only an admin can remove a number from the list");
    const { error } = await db()
      .from("do_not_call")
      .delete()
      .eq("id", data.id)
      .eq("client_id", caller.clientId);
    if (error) throw new Error(`Could not remove the number (${error.message})`);
    return { ok: true };
  });

// ─── Agent: SkyCRM disposition sync, queue presence, incoming calls ──────────────

const isSkycrm = () => getTelephonyProvider().name === "skycrm";

/** Mirror the agent's saved outcome into SkyCRM's disposition_api. Best-effort: our call_logs
 *  row is the record of truth, so a vendor failure is logged, not surfaced. */
export const reportDisposition = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        providerCallId: z.string().min(1).max(200),
        outcome: z.string().min(1).max(40),
        remark: z.string().max(1000).optional(),
        callbackAt: z.string().max(40).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!isSkycrm()) return { ok: true, skipped: true };
    const ledger = await ledgerByProviderCallId(data.providerCallId);
    if (!ledger || ledger.client_id !== caller.clientId || !ledger.agent_handle || !ledger.remote_phone) {
      return { ok: false, skipped: true };
    }
    try {
      await sendDisposition({
        extension: ledger.agent_handle,
        phone_number: ledger.remote_phone,
        caller_name: ledger.id,
        disposition: skycrmDispositionFor(data.outcome),
        sub_disposition: data.outcome,
        remark: (data.remark ?? "").slice(0, 500),
        callback_datetime: data.callbackAt,
        direction: ledger.direction === "inbound" ? "Inbound" : "Outbound",
      });
      return { ok: true };
    } catch (err) {
      console.warn(
        "[reportDisposition] SkyCRM disposition sync failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false };
    }
  });

async function callerExtension(agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const { data } = await db().from("agents").select("agent_extension").eq("id", agentId).maybeSingle();
  return (data as { agent_extension: string | null } | null)?.agent_extension?.trim() || null;
}

/** Available → join the company's inbound queue and unpause; anything else → pause, so the
 *  softphone doesn't ring while the agent is on break. No-op off SkyCRM or with no queue set. */
export const setQueuePresence = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, available: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!isSkycrm()) return { ok: true, skipped: "provider" as const };
    const [extension, settings] = await Promise.all([
      callerExtension(caller.agentId),
      loadTelephonySettings(caller.clientId),
    ]);
    if (!extension || !settings?.enabled || !settings.inbound_queue) {
      return { ok: true, skipped: "not_configured" as const };
    }
    try {
      if (data.available) {
        await registerQueue(extension, settings.inbound_queue);
        await unpauseQueue(extension);
      } else {
        await pauseQueue(extension);
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[setQueuePresence] ${msg}`);
      throw new Error("Could not update your inbound call status. Try again.");
    }
  });

export interface IncomingCall {
  providerCallId: string;
  phone: string | null;
  status: string;
  debtor: { id: string; name: string } | null;
}

/** The caller's live inbound call, if any, with the matching account in their company.
 *  `poll: false` tells the browser to stop asking (no SkyCRM, or no extension to ring). */
export const getIncomingCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<{ poll: boolean; call: IncomingCall | null }> => {
    const caller = await requireCaller(data.accessToken);
    if (!caller.agentId || !isSkycrm() || !(await callerExtension(caller.agentId))) {
      return { poll: false, call: null };
    }
    return { poll: true, call: await findIncomingCall(caller.clientId, caller.agentId) };
  });

async function findIncomingCall(clientId: string, agentId: string): Promise<IncomingCall | null> {
  {
    const caller = { clientId, agentId };
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data: row } = await db()
      .from("telephony_calls")
      .select("id, provider_call_id, remote_phone, status")
      .eq("client_id", caller.clientId)
      .eq("agent_id", caller.agentId)
      .eq("direction", "inbound")
      .is("ended_at", null)
      .gt("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!row) return null;
    const call = row as {
      id: string;
      provider_call_id: string | null;
      remote_phone: string | null;
      status: string;
    };

    let debtor: IncomingCall["debtor"] = null;
    const last10 = call.remote_phone ? normalisePhone(call.remote_phone) : "";
    if (last10.length === 10) {
      const { data: match } = await db()
        .from("debtors")
        .select("id, name")
        .eq("client_id", caller.clientId)
        .like("phone_primary", `%${last10}`)
        .limit(1)
        .maybeSingle();
      if (match) debtor = match as { id: string; name: string };
    }
    return {
      providerCallId: call.provider_call_id ?? call.id,
      phone: call.remote_phone,
      status: call.status,
      debtor,
    };
  }
}
