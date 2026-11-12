// Server actions around the shared SkyCRM account: per-company settings and extension assignment
// (superadmin), the do-not-call list (company users), and the agent-side SkyCRM calls —
// disposition sync, inbound queue presence, and the incoming-call screen pop.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z, tokenSchema, idSchema, noteSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { getTelephonyProvider } from "./telephony";
import {
  debtorByPhone,
  doNotCallSet,
  insertInboundLedger,
  ledgerByProviderCallId,
  loadChannelState,
  loadTelephonySettings,
  type LedgerRow,
} from "./telephony/guard.server";
import { skycrmCallbackDatetime, skycrmSubDisposition } from "./telephony/skycrm-disposition";
import { copyRingTimeToCallLogs, copyTalkTimeToCallLogs } from "./telephony/talk-time";
import { normalisePhone, type TelephonySettingsRow } from "./telephony/guard-rules";
import { shareError, type TrunkSettings } from "./telephony/channel-plan";
import { groupMissedCalls } from "./telephony/missed-calls";
import { turnLogin, type TurnLogin } from "./telephony/webrtc/turn-credentials.server";
import { skycrmPassword, skycrmUserLevel, skycrmUsername } from "./telephony/skycrm-users";
import { enforceRateLimit } from "./rate-limit.server";
import {
  createSkycrmUser,
  loginSkycrmUser,
  startCallMonitor,
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
const extensionSchema = z
  .string()
  .trim()
  .regex(/^\d{3,6}$/, "Extensions are 3–6 digits");

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
  settings: (TelephonySettingsRow & { channel_reserved: number }) | null;
  trunk: TrunkSettings;
  /** Lines guaranteed to every OTHER company — the trunk is shared */
  otherCompaniesReserved: number;
  /** Open outbound calls for this company right now. */
  activeOutbound: number;
  /** This company's phone numbers (empty until 20261026 is applied). */
  numbers: Array<{
    number: string;
    use: string;
    label: string | null;
    vendorQueue: string | null;
    restingUntil: string | null;
  }>;
  agents: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    extension: string | null;
    /** Their SkyCRM user, if SamvadX has tried to create one (never the password). */
    skycrmUser: {
      username: string;
      status: "created" | "failed";
      error: string | null;
      lastLoginAt: string | null;
      lastLoginError: string | null;
    } | null;
  }>;
}

export const getCompanyTelephony = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<CompanyTelephony> => {
    await requireSuperadmin(data.accessToken);
    const [settings, state, nums, agents, skyUsers] = await Promise.all([
      loadTelephonySettings(data.clientId),
      loadChannelState(),
      db()
        .from("telephony_dids")
        .select("number, use, label, vendor_queue, resting_until")
        .eq("client_id", data.clientId)
        .order("number"),
      db()
        .from("agents")
        .select("id, name, email, role, agent_extension, is_active")
        .eq("client_id", data.clientId)
        .order("name"),
      // Empty until 20261105_skycrm_users.sql is applied.
      db()
        .from("skycrm_users")
        .select("agent_id, username, status, last_error, last_login_at, last_login_error")
        .eq("client_id", data.clientId),
    ]);
    if (agents.error) throw new Error(`Could not load users (${agents.error.message})`);
    type SkyRow = {
      agent_id: string;
      username: string;
      status: "created" | "failed";
      last_error: string | null;
      last_login_at: string | null;
      last_login_error: string | null;
    };
    const skyByAgent = new Map<
      string,
      NonNullable<CompanyTelephony["agents"][number]["skycrmUser"]>
    >(
      ((skyUsers.error ? [] : skyUsers.data) ?? []).map((u: SkyRow) => [
        u.agent_id,
        {
          username: u.username,
          status: u.status,
          error: u.last_error,
          lastLoginAt: u.last_login_at,
          lastLoginError: u.last_login_error,
        },
      ]),
    );
    const me = state.companies.find((c) => c.clientId === data.clientId);
    return {
      provider: getTelephonyProvider().name,
      settings: settings ? { ...settings, channel_reserved: me?.reserved ?? 0 } : null,
      trunk: state.trunk,
      otherCompaniesReserved: state.companies
        .filter((c) => c.clientId !== data.clientId && c.enabled)
        .reduce((sum, c) => sum + c.reserved, 0),
      activeOutbound: me?.activeOutbound ?? 0,
      numbers: ((nums.error ? [] : nums.data) ?? []).map(
        (n: {
          number: string;
          use: string;
          label: string | null;
          vendor_queue: string | null;
          resting_until: string | null;
        }) => ({
          number: n.number,
          use: n.use,
          label: n.label,
          vendorQueue: n.vendor_queue,
          restingUntil: n.resting_until,
        }),
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
          skycrmUser: skyByAgent.get(a.id) ?? null,
        })),
    };
  });

/**
 * Create a SkyCRM user for every active person in a company who doesn't have one yet (or whose
 * last attempt failed). SkyCRM asked for this so they can count users (2026-11-05). One at a time,
 * since their API crashes on duplicates rather than answering cleanly. Username rules:
 * telephony/skycrm-users.ts. A failed attempt keeps the same username and password for the retry.
 */
export const createSkycrmUsers = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const [{ data: people, error }, existing] = await Promise.all([
      db()
        .from("agents")
        .select("id, name, role, agent_extension, is_active")
        .eq("client_id", data.clientId),
      db()
        .from("skycrm_users")
        .select("agent_id, username, password, status")
        .eq("client_id", data.clientId),
    ]);
    if (error) throw new Error(`Could not load users (${error.message})`);
    if (existing.error) {
      throw new Error("SkyCRM users table is missing — apply 20261105_skycrm_users.sql first");
    }
    const prior = new Map<string, { username: string; password: string; status: string }>(
      (existing.data ?? []).map(
        (r: { agent_id: string; username: string; password: string; status: string }) => [
          r.agent_id,
          r,
        ],
      ),
    );

    const results: Array<{ name: string; username: string; ok: boolean; detail?: string }> = [];
    for (const p of (people ?? []) as Array<{
      id: string;
      name: string | null;
      role: string;
      agent_extension: string | null;
      is_active: boolean | null;
    }>) {
      if (p.is_active === false) continue;
      const before = prior.get(p.id);
      if (before?.status === "created") continue;
      const username =
        before?.username ??
        skycrmUsername({ id: p.id, name: p.name, extension: p.agent_extension });
      const password = before?.password ?? skycrmPassword();
      const userLevel = skycrmUserLevel(p.role);
      // Saved BEFORE the call, so a crash mid-way can't leave a SkyCRM user whose password we lost.
      const saved = await db().from("skycrm_users").upsert(
        {
          agent_id: p.id,
          client_id: data.clientId,
          username,
          password,
          user_level: userLevel,
          status: "failed",
          last_error: "creating…",
          attempted_at: new Date().toISOString(),
        },
        { onConflict: "agent_id" },
      );
      if (saved.error) {
        results.push({
          name: p.name ?? username,
          username,
          ok: false,
          detail: saved.error.message,
        });
        continue;
      }
      const res = await createSkycrmUser({ name: username, password, userLevel });
      await db()
        .from("skycrm_users")
        .update(
          res.ok
            ? { status: "created", last_error: null, created_at: new Date().toISOString() }
            : { status: "failed", last_error: res.detail },
        )
        .eq("agent_id", p.id);
      results.push({
        name: p.name ?? username,
        username,
        ok: res.ok,
        detail: res.ok ? undefined : res.detail,
      });
    }

    const created = results.filter((r) => r.ok).length;
    if (results.length) {
      await logSuperadminActivity({
        superadminId: caller.superadminId,
        action: "skycrm_users_created",
        clientId: data.clientId,
        summary: `Created ${created} of ${results.length} SkyCRM users`,
        detail: {
          results: results.map((r) => ({
            username: r.username,
            ok: r.ok,
            detail: r.detail ?? null,
          })),
        },
      });
    }
    return { created, failed: results.length - created, results };
  });

export const saveCompanyTelephony = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        enabled: z.boolean(),
        seatLimit: z.number().int().min(0).max(100000).nullable(),
        /** The most lines this company may use at once. */
        channelLimit: z.number().int().min(0).max(1000),
        /** Lines it always gets, whatever other companies are doing. */
        channelReserved: z.number().int().min(0).max(1000),
        inboundDid: z.string().trim().max(20).nullable(),
        inboundQueue: z.string().trim().max(50).nullable(),
        /** Managers may place calls themselves. Left out = unchanged. */
        managersCanCall: z.boolean().optional(),
        callWindowStart: timeSchema,
        callWindowEnd: timeSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    if (data.callWindowStart < "08:00" || data.callWindowEnd > "19:00") {
      throw new Error(
        "Calling hours must stay within 08:00–19:00 IST (RBI rule for recovery calls).",
      );
    }
    if (data.callWindowStart >= data.callWindowEnd) {
      throw new Error("The calling window must start before it ends.");
    }

    const state = await loadChannelState();
    const othersReserved = state.companies
      .filter((c) => c.clientId !== data.clientId && c.enabled)
      .reduce((s, c) => s + c.reserved, 0);
    const allocError = shareError({
      trunk: state.trunk,
      reserved: data.enabled ? data.channelReserved : 0,
      max: data.channelLimit,
      othersReserved,
    });
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
      channel_reserved: data.channelReserved,
      inbound_did: data.inboundDid || null,
      inbound_queue: data.inboundQueue || null,
      call_window_start: data.callWindowStart,
      call_window_end: data.callWindowEnd,
      ...(data.managersCanCall === undefined ? {} : { managers_can_call: data.managersCanCall }),
      updated_at: new Date().toISOString(),
    };
    let { error } = await db().from("telephony_settings").upsert(row, { onConflict: "client_id" });
    if (error && /channel_reserved/.test(error.message ?? "")) {
      if (data.channelReserved > 0) {
        throw new Error(
          "Guaranteed lines need migrations/20261026_telephony_dids_channels.sql applied first.",
        );
      }
      const { channel_reserved: _drop, ...legacy } = row;
      ({ error } = await db()
        .from("telephony_settings")
        .upsert(legacy, { onConflict: "client_id" }));
    }
    if (error) throw new Error(`Could not save telephony settings (${error.message})`);

    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "telephony_settings_set",
      clientId: data.clientId,
      summary: `Telephony ${data.enabled ? "enabled" : "disabled"}: ${data.channelReserved} guaranteed / ${data.channelLimit} most lines, ${data.seatLimit ?? "unlimited"} extensions, ${data.callWindowStart}–${data.callWindowEnd} IST`,
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
      detail: {
        agentId: data.agentId,
        extension: { from: prior.agent_extension, to: data.extension },
      },
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

/** Which of these numbers are on the caller's company do-not-call list — returns only the
 *  matches, as 10-digit numbers, so an agent learns nothing beyond the numbers they asked about.
 *  Progressive Dial uses it to leave blocked borrowers out of a run before dialling. */
export const checkDoNotCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, phones: z.array(z.string().max(20)).max(2000) }).parse(d),
  )
  .handler(async ({ data }): Promise<string[]> => {
    const caller = await requireCaller(data.accessToken);
    enforceRateLimit(`dnc-check:${caller.authUserId}`, 60, 60_000);
    return [...(await doNotCallSet(caller.clientId, data.phones))];
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
      if (!phone)
        phone = normalisePhone((debtor as { phone_primary: string | null }).phone_primary ?? "");
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
        /** The call's id when the screen knew it. Without one, the caller's latest call to
         *  `phone` (last 12 h) is used — about a third of calls reached the disposition with no
         *  id, and none of those were sent to SkyCRM before 2026-11-05. */
        providerCallId: z.string().min(1).max(200).optional(),
        phone: z.string().max(20).optional(),
        outcome: z.string().min(1).max(40),
        reason: z.string().max(200).optional(),
        remark: z.string().max(1000).optional(),
        followUpDate: z.string().max(10).optional(),
        followUpTime: z.string().max(8).optional(),
        /** Older clients sent a ready-made "YYYY-MM-DD HH:MM:SS". */
        callbackAt: z.string().max(40).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!isSkycrm()) return { ok: true, skipped: true };
    let ledger = data.providerCallId ? await ledgerByProviderCallId(data.providerCallId) : null;
    if (!ledger && data.phone && caller.agentId)
      ledger = await latestCallTo(caller.agentId, data.phone);
    if (
      !ledger ||
      ledger.client_id !== caller.clientId ||
      !ledger.agent_handle ||
      !ledger.remote_phone
    ) {
      return { ok: false, skipped: true };
    }
    const callback =
      skycrmCallbackDatetime(data.followUpDate, data.followUpTime) ??
      skycrmCallbackDatetime(data.callbackAt?.slice(0, 10), data.callbackAt?.slice(11));
    // SkyCRM shows caller_name as "Agent Name" on its Quality page; until 2026-11-12 we sent the
    // ledger id there, so their reports listed long codes. The agent who took the call, by name.
    const agentName = await agentDisplayName(ledger.agent_id ?? caller.agentId);
    try {
      await sendDisposition({
        extension: ledger.agent_handle,
        phone_number: ledger.remote_phone,
        caller_name: (agentName || ledger.agent_handle).slice(0, 100),
        disposition: skycrmDispositionFor(data.outcome),
        sub_disposition: skycrmSubDisposition(data.outcome, data.reason),
        remark: (data.remark ?? "").slice(0, 500),
        // Always present: their view may read the key directly.
        callback_datetime: callback ?? "",
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

/** The agent pressed End on the browser phone itself, which drops their leg without going through
 *  hangupCall. Marks their latest call, so Disconnected By doesn't read as the customer. */
export const markAgentEndedCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!caller.agentId) return { ok: false };
    const since = new Date(Date.now() - 2 * 3600_000).toISOString();
    const { data: latest } = await db()
      .from("telephony_calls")
      .select("id")
      .eq("agent_id", caller.agentId)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest) return { ok: false };
    const { error } = await db()
      .from("telephony_calls")
      .update({ ended_by: "agent" })
      .eq("id", (latest as { id: string }).id);
    return { ok: !error };
  });

/** Copy a call's talk time from the ledger onto its call log, for when the provider's final event
 *  arrived before the agent saved the disposition (a later event copies it itself). Server-side
 *  because agents can neither read the ledger nor UPDATE call_logs. */
export const syncCallLogTalkTime = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, providerCallId: z.string().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const ledger = await ledgerByProviderCallId(data.providerCallId);
    if (!ledger || ledger.client_id !== caller.clientId) return { ok: false };
    await copyTalkTimeToCallLogs(db(), data.providerCallId, ledger.status, ledger.duration_seconds);
    await copyRingTimeToCallLogs(db(), data.providerCallId, ledger);
    return { ok: true };
  });

/** The caller's most recent call (last 12 h) to this number, from the call ledger. */
async function latestCallTo(agentId: string, phone: string): Promise<LedgerRow | null> {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  const since = new Date(Date.now() - 12 * 3600_000).toISOString();
  const { data } = await db()
    .from("telephony_calls")
    .select(
      "id, client_id, agent_id, provider_call_id, direction, agent_handle, remote_phone, vendor_callid, status, answered_at, ended_at",
    )
    .eq("agent_id", agentId)
    .ilike("remote_phone", `%${digits}`)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as LedgerRow | null) ?? null;
}

async function agentDisplayName(agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const { data } = await db().from("agents").select("name").eq("id", agentId).maybeSingle();
  return (data as { name: string | null } | null)?.name?.trim() || null;
}

async function callerExtension(agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const { data } = await db()
    .from("agents")
    .select("agent_extension")
    .eq("id", agentId)
    .maybeSingle();
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

/** What the browser phone needs to register the caller's own extension through our gateway
 *  (infra/sip-gateway). Null `login` says why there is none, so the UI can show it.
 *  The SIP password reaches the browser only here, only for the caller's own extension; the
 *  extensions share one password today, so SKYCRM_SIP_PASSWORD is a single server setting. */
export type WebphoneLogin =
  | {
      login: {
        wssUrl: string;
        domain: string;
        extension: string;
        password: string;
        displayName: string;
        /** TURN relay into the tunnel, when TURN_SECRET + TURN_URLS are set (turn-credentials). */
        iceServers: TurnLogin["iceServers"];
        iceTransportPolicy?: TurnLogin["iceTransportPolicy"];
      };
    }
  | { login: null; reason: "provider" | "not_enabled" | "no_extension" | "not_configured" };

// SkyCRM wants each agent's own SkyCRM user logged in while they work (Login API, 2026-11-05), so
// it can see who is active. Done when the agent's browser phone connects (it re-reads its login
// every 2 minutes), at most once per LOGIN_EVERY_MS per extension, in the background — a refusal
// never stops the phone. The outcome is kept on skycrm_users and shown on the superadmin card.
const LOGIN_EVERY_MS = 30 * 60_000;
const lastSkycrmLogin = new Map<string, number>();

async function keepSkycrmUserLoggedIn(agentId: string, extension: string): Promise<void> {
  const last = lastSkycrmLogin.get(extension) ?? 0;
  if (Date.now() - last < LOGIN_EVERY_MS) return;
  lastSkycrmLogin.set(extension, Date.now());
  const res = await loginSkycrmUser(extension);
  if (!res.ok && res.detail === "no SkyCRM user for this extension") return;
  if (!res.ok) {
    console.warn(`[skycrm-login] ${extension}: ${res.detail}`);
    lastSkycrmLogin.set(extension, Date.now() - LOGIN_EVERY_MS + 5 * 60_000); // retry in 5 min
  }
  await db()
    .from("skycrm_users")
    .update(
      res.ok
        ? { last_login_at: new Date().toISOString(), last_login_error: null }
        : { last_login_error: res.detail.slice(0, 300) },
    )
    .eq("agent_id", agentId);
}

export const getMyWebphoneLogin = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<WebphoneLogin> => {
    const caller = await requireCaller(data.accessToken);
    if (!isSkycrm()) return { login: null, reason: "provider" };
    const [extension, settings] = await Promise.all([
      callerExtension(caller.agentId),
      loadTelephonySettings(caller.clientId),
    ]);
    if (!settings?.enabled) return { login: null, reason: "not_enabled" };
    if (!extension) return { login: null, reason: "no_extension" };
    const wssUrl = process.env.SKYCRM_WSS_URL?.trim();
    const domain = process.env.SKYCRM_SIP_DOMAIN?.trim();
    const password = process.env.SKYCRM_SIP_PASSWORD;
    if (!wssUrl || !domain || !password) {
      console.warn(
        "[getMyWebphoneLogin] missing:",
        ["SKYCRM_WSS_URL", "SKYCRM_SIP_DOMAIN", "SKYCRM_SIP_PASSWORD"].filter(
          (k) => !process.env[k],
        ),
      );
      return { login: null, reason: "not_configured" };
    }
    if (caller.agentId) {
      void keepSkycrmUserLoggedIn(caller.agentId, extension).catch((err) =>
        console.warn("[skycrm-login] failed:", err instanceof Error ? err.message : String(err)),
      );
    }
    const turn = turnLogin(extension, {
      secret: process.env.TURN_SECRET,
      urls: process.env.TURN_URLS,
    });
    return {
      login: {
        wssUrl,
        domain,
        extension,
        password,
        displayName: extension,
        iceServers: turn?.iceServers ?? [],
        ...(turn ? { iceTransportPolicy: turn.iceTransportPolicy } : {}),
      },
    };
  });

/**
 * An incoming call that rang this agent's browser phone and was not answered. SkyCRM's inbound
 * webhook events have never reached us (0 inbound ledger rows as of 2026-11-12), so the phone
 * reports the miss itself: it goes in the ledger as an ended inbound call, which is what the
 * "Missed calls" card lists (with Call back) and what clears once anyone calls the number back.
 */
export const logMissedInbound = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, phone: z.string().min(3).max(30) }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    enforceRateLimit(`missed-inbound:${caller.authUserId}`, 30, 60_000);
    const extension = await callerExtension(caller.agentId);
    if (!caller.agentId || !extension) return { ok: false };
    const phone = normalisePhone(data.phone);
    if (phone.length !== 10) return { ok: false };
    const debtor = await debtorByPhone(caller.clientId, phone).catch(() => null);
    const row = await insertInboundLedger({
      clientId: caller.clientId,
      agentId: caller.agentId,
      provider: getTelephonyProvider().name,
      agentHandle: extension,
      remotePhone: phone,
      vendorCallId: `browser-${crypto.randomUUID()}`,
      debtorId: debtor?.id ?? null,
    });
    if (row) {
      await db()
        .from("telephony_calls")
        .update({ status: "no_answer", ended_at: new Date().toISOString() })
        .eq("id", row.id);
    }
    return { ok: !!row };
  });

/** What the signed-in person may do with calling — the browser hides what the server refuses. */
export const getMyCallingAccess = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<{ canCall: boolean }> => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "manager") return { canCall: caller.role === "agent" };
    const settings = await loadTelephonySettings(caller.clientId);
    return { canCall: !!settings?.managers_can_call };
  });

export interface MissedInboundEntry {
  id: string;
  at: string;
  phone: string | null;
  debtorName: string | null;
  loanReference: string | null;
  /** Someone in the company called the number after this missed call. */
  calledBack: boolean;
}

/** One agent's missed incoming calls (last 30 days) for Activity History. Agents get only their
 *  own; managers and admins any agent in their company. */
export const listMissedInboundForAgent = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, agentEmail: z.string().max(320) }).parse(d),
  )
  .handler(async ({ data }): Promise<MissedInboundEntry[]> => {
    const caller = await requireCaller(data.accessToken);
    const { data: agent } = await db()
      .from("agents")
      .select("id, client_id")
      .eq("email", data.agentEmail)
      .maybeSingle();
    const target = agent as { id: string; client_id: string } | null;
    if (!target || target.client_id !== caller.clientId) return [];
    if (caller.role === "agent" && target.id !== caller.agentId) return [];
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: rows, error } = await db()
      .from("telephony_calls")
      .select("id, remote_phone, started_at, callback_done_at, debtors(name, loan_reference)")
      .eq("client_id", caller.clientId)
      .eq("agent_id", target.id)
      .eq("direction", "inbound")
      .is("answered_at", null)
      .not("ended_at", "is", null)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) return [];
    const missed = (rows ?? []) as Array<{
      id: string;
      remote_phone: string | null;
      started_at: string;
      callback_done_at: string | null;
      debtors: { name: string; loan_reference: string | null } | null;
    }>;
    // Called back = any outbound call from the company to that number after the miss.
    const phones = [
      ...new Set(
        missed.map((r) => normalisePhone(r.remote_phone ?? "")).filter((p) => p.length === 10),
      ),
    ];
    const lastOut = new Map<string, string>();
    for (let i = 0; i < phones.length; i += 100) {
      const { data: out } = await db()
        .from("telephony_calls")
        .select("remote_phone, started_at")
        .eq("client_id", caller.clientId)
        .eq("direction", "outbound")
        .gte("started_at", since)
        .or(
          phones
            .slice(i, i + 100)
            .map((p) => `remote_phone.like.%${p}`)
            .join(","),
        );
      for (const o of (out ?? []) as Array<{ remote_phone: string | null; started_at: string }>) {
        const k = normalisePhone(o.remote_phone ?? "");
        if ((lastOut.get(k) ?? "") < o.started_at) lastOut.set(k, o.started_at);
      }
    }
    return missed.map((r) => {
      const k = normalisePhone(r.remote_phone ?? "");
      return {
        id: r.id,
        at: r.started_at,
        phone: r.remote_phone,
        debtorName: r.debtors?.name ?? null,
        loanReference: r.debtors?.loan_reference ?? null,
        calledBack: !!r.callback_done_at || (lastOut.get(k) ?? "") > r.started_at,
      };
    });
  });

export interface IncomingCall {
  providerCallId: string;
  phone: string | null;
  status: string;
  debtor: { id: string; name: string } | null;
  /** The borrower's own agent, when that isn't the person this call rang. */
  assignedTo: string | null;
  /** The number they dialled. */
  didNumber: string | null;
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
    const query = (cols: string) =>
      db()
        .from("telephony_calls")
        .select(cols)
        .eq("client_id", caller.clientId)
        .eq("agent_id", caller.agentId)
        .eq("direction", "inbound")
        .is("ended_at", null)
        .gt("started_at", since)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    let { data: row, error } = await query(
      "id, provider_call_id, remote_phone, status, did_number",
    );
    // did_number arrives with 20261026_telephony_dids_channels.sql.
    if (error) ({ data: row } = await query("id, provider_call_id, remote_phone, status"));
    if (!row) return null;
    const call = row as {
      id: string;
      provider_call_id: string | null;
      remote_phone: string | null;
      status: string;
      did_number?: string | null;
    };

    const match = await debtorByPhone(caller.clientId, call.remote_phone).catch(() => null);
    let assignedTo: string | null = null;
    if (match?.assigned_agent_id && match.assigned_agent_id !== caller.agentId) {
      const { data: owner } = await db()
        .from("agents")
        .select("name")
        .eq("id", match.assigned_agent_id)
        .maybeSingle();
      assignedTo = (owner as { name: string } | null)?.name ?? null;
    }
    const debtor: IncomingCall["debtor"] = match ? { id: match.id, name: match.name } : null;
    return {
      providerCallId: call.provider_call_id ?? call.id,
      phone: call.remote_phone,
      status: call.status,
      debtor,
      assignedTo,
      didNumber: call.did_number ?? null,
    };
  }
}

// ─── Missed inbound calls → callbacks ───────────────────────────────────────────

/** Reads AS the caller, so RLS decides which borrowers they may see. */
function asCaller(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("This is not available right now.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  }) as any;
}

export interface MissedCallEntry {
  phone: string;
  count: number;
  firstAt: string;
  lastAt: string;
  didNumber: string | null;
  debtor: {
    id: string;
    name: string;
    loanReference: string | null;
    assignedAgentName: string | null;
  } | null;
}

/**
 * Borrowers who called and reached nobody, not yet called back — last `days` days. Agents see
 * callers who are their own borrowers; managers and admins also see unknown numbers. Entries drop
 * off by themselves once anyone at the company calls the number (groupMissedCalls).
 */
export const listMissedCalls = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({ accessToken: tokenSchema, days: z.number().int().min(1).max(30).default(7) })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ ready: boolean; entries: MissedCallEntry[] }> => {
    const caller = await requireCaller(data.accessToken);
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const { data: rows, error } = await db()
      .from("telephony_calls")
      .select("id, remote_phone, started_at, debtor_id, did_number")
      .eq("client_id", caller.clientId)
      .eq("direction", "inbound")
      .is("answered_at", null)
      .not("ended_at", "is", null)
      .is("callback_done_at", null)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1000);
    if (error) {
      // debtor_id / callback_done_at arrive with 20261026_telephony_dids_channels.sql.
      return { ready: false, entries: [] };
    }
    const missed = (rows ?? []) as Array<{
      id: string;
      remote_phone: string | null;
      started_at: string;
      debtor_id: string | null;
      did_number: string | null;
    }>;
    const phones = [
      ...new Set(
        missed.map((r) => normalisePhone(r.remote_phone ?? "")).filter((p) => p.length === 10),
      ),
    ];
    if (!phones.length) return { ready: true, entries: [] };

    const outbound: Array<{ phone: string; startedAt: string }> = [];
    for (let i = 0; i < phones.length; i += 100) {
      const ors = phones
        .slice(i, i + 100)
        .map((p) => `remote_phone.like.%${p}`)
        .join(",");
      const { data: out } = await db()
        .from("telephony_calls")
        .select("remote_phone, started_at")
        .eq("client_id", caller.clientId)
        .eq("direction", "outbound")
        .gte("started_at", since)
        .or(ors)
        .limit(1000);
      for (const o of (out ?? []) as Array<{ remote_phone: string; started_at: string }>) {
        outbound.push({ phone: o.remote_phone, startedAt: o.started_at });
      }
    }
    const groups = groupMissedCalls(
      missed.map((r) => ({
        id: r.id,
        phone: r.remote_phone ?? "",
        startedAt: r.started_at,
        debtorId: r.debtor_id,
        didNumber: r.did_number,
      })),
      outbound,
    );

    // Which of those borrowers this user may see — RLS, as the caller.
    const debtorIds = [...new Set(groups.map((g) => g.debtorId).filter(Boolean))] as string[];
    const visible = new Map<string, MissedCallEntry["debtor"]>();
    if (debtorIds.length) {
      const { data: ds } = await asCaller(data.accessToken)
        .from("debtors")
        .select("id, name, loan_reference, assigned_agent_id, agents:assigned_agent_id(name)")
        .in("id", debtorIds);
      for (const d of (ds ?? []) as Array<{
        id: string;
        name: string;
        loan_reference: string | null;
        assigned_agent_id: string | null;
        agents: { name: string } | null;
      }>) {
        // An agent's list is their own borrowers — a teammate's caller isn't theirs to call back.
        if (caller.role === "agent" && d.assigned_agent_id !== caller.agentId) continue;
        visible.set(d.id, {
          id: d.id,
          name: d.name,
          loanReference: d.loan_reference,
          assignedAgentName: d.agents?.name ?? null,
        });
      }
    }
    const seesUnknown = caller.role === "manager" || caller.role === "admin";
    const entries = groups.flatMap((g): MissedCallEntry[] => {
      const debtor = g.debtorId ? visible.get(g.debtorId) : undefined;
      if (g.debtorId ? !debtor : !seesUnknown) return [];
      return [
        {
          phone: g.phone,
          count: g.count,
          firstAt: g.firstAt,
          lastAt: g.lastAt,
          didNumber: g.didNumber,
          debtor: debtor ?? null,
        },
      ];
    });
    return { ready: true, entries };
  });

/** "Handled" without calling back through SamvadX (e.g. reached on WhatsApp). */
export const dismissMissedCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, phone: z.string().trim().min(10).max(20) }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const last10 = normalisePhone(data.phone);
    if (last10.length !== 10) throw new Error("Not a phone number");
    if (caller.role === "agent") {
      const debtor = await debtorByPhone(caller.clientId, last10);
      if (!debtor || debtor.assigned_agent_id !== caller.agentId) {
        throw new Error("Only this borrower's agent or a manager can clear this missed call.");
      }
    }
    const { error } = await db()
      .from("telephony_calls")
      .update({ callback_done_at: new Date().toISOString(), callback_by: caller.agentId })
      .eq("client_id", caller.clientId)
      .eq("direction", "inbound")
      .is("answered_at", null)
      .is("callback_done_at", null)
      .like("remote_phone", `%${last10}`);
    if (error) throw new Error(`Could not update (${error.message})`);
    return { ok: true };
  });

// ─── Live call monitoring: listen / whisper / barge (2026-11-05) ─────────────────
/**
 * A manager or admin joins an agent's live call from the Live Calls board. Who may: whoever
 * can SEE that live call under their own RLS (live_calls_select — admins: their company;
 * managers: agents on their teams) — read as the caller, so the team rule is the database's,
 * not re-implemented here. SkyCRM then rings the caller's own extension; their browser phone
 * answers it (the board fires the dial-started event first). Stopping = hanging up that phone.
 */
export const monitorLiveCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        liveCallId: idSchema,
        mode: z.enum(["listen", "whisper", "barge"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers and admins can listen in to calls");
    }
    if (!isSkycrm()) throw new Error("Listening in is not available on this calling setup");
    enforceRateLimit(`monitor:${caller.authUserId}`, 10, 60_000);

    const myExtension = await callerExtension(caller.agentId);
    if (!myExtension) {
      throw new Error("You need your own extension to listen in — ask SamvadX support for one");
    }

    // RLS decides whether this call is one the caller may see (their team / their company).
    const { data: live } = await asCaller(data.accessToken)
      .from("live_calls")
      .select("id, agent_id, ended_at")
      .eq("id", data.liveCallId)
      .maybeSingle();
    if (!live) throw new Error("Call not found");
    if (live.ended_at) throw new Error("This call has already ended");

    const { data: agent } = await db()
      .from("agents")
      .select("agent_extension, client_id, name")
      .eq("id", live.agent_id)
      .maybeSingle();
    const agentExtension = (agent?.agent_extension as string | null)?.trim();
    if (!agent || agent.client_id !== caller.clientId || !agentExtension) {
      throw new Error("This agent has no extension, so their call can't be joined");
    }
    if (agentExtension === myExtension) throw new Error("That is your own call");

    const res = await startCallMonitor(data.mode, myExtension, agentExtension);
    const vendorMessage = String(res.message ?? res.Message ?? "").slice(0, 120);
    console.log(
      `[monitor] ${caller.role} ext ${myExtension} → ${data.mode} on ext ${agentExtension}: ${vendorMessage}`,
    );
    return {
      ok: true,
      agentName: (agent.name as string | null) ?? agentExtension,
      myExtension,
      agentExtension,
      vendorMessage,
    };
  });
