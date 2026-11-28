// Sends scheduled Collection MIS emails. A once-a-minute timer in this server process (single
// Railway replica, like the recordings importer) finds due schedules and claims each by moving
// last_sent_on to today in one conditional update — so a restart or a slow tick can't send twice.
// Only companies with BOTH mis_reports and report_emails switched on (client_features).
import { getSupabaseAdmin } from "./supabase-admin.server";
import { emailConfigured, sendOneEmail } from "./email.server";
import { loadFeatures } from "./company-features.server";
import { companyMisInput } from "./collection-mis-data.server";
import {
  MIS_SHEETS,
  buildMisSheets,
  misSheetsForXlsx,
  misSheetsHtml,
  type MisSheetKey,
} from "./collection-mis-email";
import { longDay } from "./collection-mis";
import { isDue, istParts, reportDayFor, type ReportSchedule } from "./report-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables newer than generated types
const db = () => getSupabaseAdmin() as any;

export function toSchedule(r: Record<string, unknown>): ReportSchedule {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    listId: String(r.list_id),
    name: String(r.name),
    sheets: ((r.sheets as string[]) ?? []).filter((k): k is MisSheetKey =>
      (MIS_SHEETS as readonly string[]).includes(k),
    ),
    sendTime: String(r.send_time),
    weekdays: ((r.weekdays as number[]) ?? []).map(Number),
    reportDay: r.report_day === "today" ? "today" : "yesterday",
    enabled: !!r.enabled,
    lastSentOn: (r.last_sent_on as string | null) ?? null,
    lastResult: (r.last_result as string | null) ?? null,
  };
}

async function excelBase64(sheets: ReturnType<typeof misSheetsForXlsx>): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name.replace(/[:\\/?*[\]]/g, " "));
    ws.addRow([sh.title]).font = { bold: true };
    ws.addRow(sh.headers).font = { bold: true };
    for (const r of sh.rows) ws.addRow(r);
    sh.headers.forEach(
      (h, i) => (ws.getColumn(i + 1).width = Math.max(10, Math.min(30, h.length + 4))),
    );
  }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

/** Build and send one schedule's MIS now. Returns a short result line (also stored). */
export async function sendScheduledMis(
  s: ReportSchedule,
  at: Date,
  sentByName: string,
): Promise<{ sent: number; total: number; result: string }> {
  const { data: list } = await db()
    .from("report_email_lists")
    .select("id, name, emails")
    .eq("id", s.listId)
    .eq("client_id", s.clientId)
    .maybeSingle();
  if (!list) return { sent: 0, total: 0, result: "Email list no longer exists" };
  const emails = (list.emails ?? []) as string[];

  const asOf = reportDayFor(s, at);
  const stamp =
    s.reportDay === "today"
      ? `${longDay(asOf)}, ${istParts(at).time}`
      : `${longDay(asOf)}, 08:00 PM`;
  const data = await companyMisInput(s.clientId, asOf);
  const sheets = buildMisSheets(data, stamp, s.sheets);
  const html = `<p style="font-family:Arial,sans-serif;font-size:13px;">Collection MIS for <b>${longDay(asOf)}</b>, sent automatically by SamvadX (${s.name}). The same sheets are attached as Excel.</p>${misSheetsHtml(sheets)}`;
  const filename = `collection-mis-${asOf}.xlsx`;
  const content = await excelBase64(misSheetsForXlsx(sheets));

  let sent = 0;
  for (const to of emails) {
    const ok = await sendOneEmail({
      to,
      subject: `Collection MIS — ${longDay(asOf)}`,
      text: `Collection MIS for ${longDay(asOf)} is attached (${filename}).`,
      html,
      attachments: [{ filename, content }],
    });
    if (ok) sent++;
  }
  const result = `${sent}/${emails.length} sent for ${longDay(asOf)}`;
  await db()
    .from("report_email_log")
    .insert({
      client_id: s.clientId,
      list_id: list.id,
      list_name: list.name,
      sent_by: null,
      sent_by_name: sentByName,
      report_name: `Collection MIS — ${longDay(asOf)}`,
      filename,
      recipients: emails,
      sent_count: sent,
      note: null,
    });
  await db()
    .from("report_email_schedules")
    .update({ last_result: `${result} at ${istParts(new Date()).time}` })
    .eq("id", s.id);
  return { sent, total: emails.length, result };
}

async function tick(): Promise<void> {
  if (!emailConfigured()) return;
  const now = new Date();
  const { data, error } = await db().from("report_email_schedules").select("*").eq("enabled", true);
  if (error || !data) return;
  for (const s of (data as Record<string, unknown>[]).map(toSchedule)) {
    if (!isDue(s, now)) continue;
    const f = await loadFeatures(s.clientId);
    if (!f.misReports || !f.reportEmails) continue;
    const today = istParts(now).day;
    // Claim: only one tick (or process) can move last_sent_on forward for today.
    const q = db().from("report_email_schedules").update({ last_sent_on: today }).eq("id", s.id);
    const { data: claimed } = await (
      s.lastSentOn ? q.eq("last_sent_on", s.lastSentOn) : q.is("last_sent_on", null)
    ).select("id");
    if (!claimed?.length) continue;
    try {
      const r = await sendScheduledMis(s, now, `Scheduled: ${s.name}`);
      console.log(`[report-schedule] ${s.name}: ${r.result}`);
    } catch (e) {
      console.warn(`[report-schedule] ${s.name} failed:`, e);
      await db()
        .from("report_email_schedules")
        .update({ last_result: `Failed: ${String((e as Error)?.message ?? e).slice(0, 200)}` })
        .eq("id", s.id);
    }
  }
}

const g = globalThis as unknown as { __samvadxReportSchedules?: ReturnType<typeof setInterval> };

/** Start the once-a-minute check (once per process). */
export function startReportSchedules(): void {
  if (g.__samvadxReportSchedules || typeof setInterval === "undefined") return;
  let running = false;
  g.__samvadxReportSchedules = setInterval(() => {
    if (running) return;
    running = true;
    void tick()
      .catch((e) => console.warn("[report-schedule] tick failed:", e))
      .finally(() => (running = false));
  }, 60_000);
  g.__samvadxReportSchedules.unref?.();
}
