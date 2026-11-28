// Admin actions for scheduled report emails: the Collection MIS (Collection MIS page) and
// Feedback Files (Feedback File page). Admins only, their own company only. Every schedule needs
// "Report emails"; MIS schedules also need "Collection MIS".
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, shortText } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { requireFeature } from "./company-features.server";
import { emailConfigured } from "./email.server";
import { sendSchedule, toSchedule } from "./report-schedule-runner.server";
import { MIS_SHEETS } from "./collection-mis-email";
import type { ReportSchedule, ScheduleKind } from "./report-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables newer than generated types
const db = () => getSupabaseAdmin() as any;

async function admin(accessToken: string, kind?: ScheduleKind) {
  const c = await verifyCaller(accessToken);
  if (!c) throw new Error("Not authenticated");
  if (c.role !== "admin") throw new Error("Only admins can manage scheduled emails");
  await requireFeature(c.clientId, "reportEmails");
  if (kind === "mis") await requireFeature(c.clientId, "misReports");
  return c;
}

async function ownSchedule(clientId: string, id: string) {
  const { data: row } = await db()
    .from("report_email_schedules")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!row) throw new Error("Schedule not found");
  return toSchedule(row);
}

const kindSchema = z.enum(["mis", "feedback"]);

export const listReportSchedules = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, kind: kindSchema }).parse(d))
  .handler(async ({ data }): Promise<{ schedules: ReportSchedule[]; emailReady: boolean }> => {
    const c = await admin(data.accessToken, data.kind);
    const { data: rows, error } = await db()
      .from("report_email_schedules")
      .select("*")
      .eq("client_id", c.clientId)
      .eq("kind", data.kind)
      .order("send_time");
    if (error) throw new Error(error.message);
    return { schedules: (rows ?? []).map(toSchedule), emailReady: emailConfigured() };
  });

const scheduleSchema = z.object({
  accessToken: tokenSchema,
  id: idSchema.optional(),
  kind: kindSchema,
  name: shortText(80),
  listId: idSchema,
  sheets: z.array(z.enum(MIS_SHEETS)).max(MIS_SHEETS.length),
  period: z.enum(["day", "month", "all"]),
  sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  reportDay: z.enum(["yesterday", "today"]),
  enabled: z.boolean(),
});

export const saveReportSchedule = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => scheduleSchema.parse(d))
  .handler(async ({ data }) => {
    const c = await admin(data.accessToken, data.kind);
    if (data.kind === "mis" && !data.sheets.length) throw new Error("Pick at least one sheet");
    if (data.id) {
      const existing = await ownSchedule(c.clientId, data.id);
      if (existing.kind !== data.kind) throw new Error("Schedule not found");
    }
    const { data: list } = await db()
      .from("report_email_lists")
      .select("id")
      .eq("id", data.listId)
      .eq("client_id", c.clientId)
      .maybeSingle();
    if (!list) throw new Error("Email list not found");
    const row = {
      name: data.name,
      list_id: data.listId,
      kind: data.kind,
      sheets: data.kind === "mis" ? data.sheets : [],
      period: data.period,
      send_time: data.sendTime,
      weekdays: [...new Set(data.weekdays)].sort(),
      report_day: data.reportDay,
      enabled: data.enabled,
      updated_at: new Date().toISOString(),
    };
    const q = data.id
      ? db()
          .from("report_email_schedules")
          .update(row)
          .eq("id", data.id)
          .eq("client_id", c.clientId)
      : db()
          .from("report_email_schedules")
          .insert({ ...row, client_id: c.clientId, created_by: c.agentId });
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteReportSchedule = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const c = await admin(data.accessToken);
    const { error } = await db()
      .from("report_email_schedules")
      .delete()
      .eq("id", data.id)
      .eq("client_id", c.clientId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** "Send now": builds and sends this schedule immediately. Doesn't move its own next send. */
export const sendReportScheduleNow = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const c = await admin(data.accessToken);
    if (!emailConfigured())
      throw new Error("Email is not set up yet (RESEND_API_KEY / EMAIL_FROM)");
    const schedule = await ownSchedule(c.clientId, data.id);
    if (schedule.kind === "mis") await requireFeature(c.clientId, "misReports");
    const { data: me } = await db().from("agents").select("name").eq("id", c.agentId).maybeSingle();
    const r = await sendSchedule(schedule, new Date(), `${me?.name ?? "Admin"} (send now)`);
    if (!r.sent) throw new Error(`Nothing was sent (${r.result})`);
    return r;
  });
