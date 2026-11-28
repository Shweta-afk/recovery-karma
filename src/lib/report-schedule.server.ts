// Admin actions for scheduled Collection MIS emails (Collection MIS page → Scheduled emails).
// Admins only, their own company only, and only with BOTH features switched on.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, shortText } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { requireFeature } from "./company-features.server";
import { emailConfigured } from "./email.server";
import { sendScheduledMis, toSchedule } from "./report-schedule-runner.server";
import { MIS_SHEETS } from "./collection-mis-email";
import type { ReportSchedule } from "./report-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables newer than generated types
const db = () => getSupabaseAdmin() as any;

async function admin(accessToken: string) {
  const c = await verifyCaller(accessToken);
  if (!c) throw new Error("Not authenticated");
  if (c.role !== "admin") throw new Error("Only admins can manage scheduled emails");
  await requireFeature(c.clientId, "misReports");
  await requireFeature(c.clientId, "reportEmails");
  return c;
}

export const listReportSchedules = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<{ schedules: ReportSchedule[]; emailReady: boolean }> => {
    const c = await admin(data.accessToken);
    const { data: rows, error } = await db()
      .from("report_email_schedules")
      .select("*")
      .eq("client_id", c.clientId)
      .order("send_time");
    if (error) throw new Error(error.message);
    return { schedules: (rows ?? []).map(toSchedule), emailReady: emailConfigured() };
  });

const scheduleSchema = z.object({
  accessToken: tokenSchema,
  id: idSchema.optional(),
  name: shortText(80),
  listId: idSchema,
  sheets: z.array(z.enum(MIS_SHEETS)).min(1).max(MIS_SHEETS.length),
  sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  reportDay: z.enum(["yesterday", "today"]),
  enabled: z.boolean(),
});

export const saveReportSchedule = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => scheduleSchema.parse(d))
  .handler(async ({ data }) => {
    const c = await admin(data.accessToken);
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
      sheets: data.sheets,
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

/** "Send now": builds and sends this schedule's MIS immediately. Doesn't move the schedule's
 *  own next send. */
export const sendReportScheduleNow = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const c = await admin(data.accessToken);
    if (!emailConfigured())
      throw new Error("Email is not set up yet (RESEND_API_KEY / EMAIL_FROM)");
    const { data: row } = await db()
      .from("report_email_schedules")
      .select("*")
      .eq("id", data.id)
      .eq("client_id", c.clientId)
      .maybeSingle();
    if (!row) throw new Error("Schedule not found");
    const { data: me } = await db().from("agents").select("name").eq("id", c.agentId).maybeSingle();
    const r = await sendScheduledMis(
      toSchedule(row),
      new Date(),
      `${me?.name ?? "Admin"} (send now)`,
    );
    if (!r.sent) throw new Error(`Nothing was sent (${r.result})`);
    return r;
  });
