// Sends scheduled report emails. A once-a-minute timer in this server process (single Railway
// replica, like the recordings importer) finds due schedules and claims each by moving
// last_sent_on to today in one conditional update — so a restart or a slow tick can't send twice.
// MIS schedules need mis_reports AND report_emails; feedback schedules need report_emails.
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
import {
  FEEDBACK_PERIOD_LABEL,
  feedbackRange,
  isDue,
  istParts,
  reportDayFor,
  type ReportSchedule,
} from "./report-schedule";
import { buildFeedbackSheets } from "./portfolio-feedback";
import { loadPortfolioFeedback } from "./portfolio-feedback-data.server";
import { xlsxBuffer } from "./xlsx-server.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables newer than generated types
const db = () => getSupabaseAdmin() as any;

export function toSchedule(r: Record<string, unknown>): ReportSchedule {
  return {
    id: String(r.id),
    kind: r.kind === "feedback" ? "feedback" : "mis",
    period: r.period === "month" || r.period === "all" ? r.period : "day",
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

/** Resend refuses an email over 40 MB (attachments base64-encoded); stay well under. */
const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

const safeName = (s: string) =>
  s
    .replace(/[^\w\- ]+/g, "_")
    .trim()
    .slice(0, 60) || "portfolio";

/** One email per team: that team's open portfolios' Feedback Files, one Excel each. */
export async function sendScheduledFeedback(
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

  const { from, to } = feedbackRange(s, at);
  const day = reportDayFor(s, at);
  const periodText =
    s.period === "all" ? "all feedback to date" : from === to ? longDay(day) : `${from} to ${to}`;
  const [{ data: portfolios }, { data: teams }, { data: agents }] = await Promise.all([
    db()
      .from("portfolios")
      .select("id, name, lender_name, team_id")
      .eq("client_id", s.clientId)
      .is("deleted_at", null)
      .is("closed_at", null)
      .order("name"),
    db().from("teams").select("id, name").eq("client_id", s.clientId).order("name"),
    db().from("agents").select("id, name").eq("client_id", s.clientId),
  ]);
  const teamName = new Map(
    ((teams ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const byTeam = new Map<string, { id: string; name: string; lender_name: string | null }[]>();
  for (const p of (portfolios ?? []) as {
    id: string;
    name: string;
    lender_name: string | null;
    team_id: string | null;
  }[]) {
    const team = (p.team_id && teamName.get(p.team_id)) || "No team";
    byTeam.set(team, [...(byTeam.get(team) ?? []), p]);
  }

  let sent = 0;
  let emailsTried = 0;
  let files = 0;
  for (const [team, pfs] of byTeam) {
    const attachments: {
      filename: string;
      content: string;
      bytes: number;
      loans: number;
      name: string;
    }[] = [];
    for (const p of pfs) {
      const d = await loadPortfolioFeedback(s.clientId, p, {
        from,
        to,
        includeRecordingLinks: false,
      });
      const sheets = buildFeedbackSheets(
        {
          ...d,
          agentNames: new Map(
            ((agents ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
          ),
          recordingLinks: new Map(),
          from: from ?? "",
          to: to ?? "",
          // "All feedback ever" lists every loan; a day or month only those worked in it.
          includeNoActivity: s.period === "all",
        },
        istParts(at).day,
      );
      const buf = await xlsxBuffer(sheets);
      attachments.push({
        filename: `feedback-${safeName(p.name)}-${s.period === "all" ? "all-time" : `${from}_to_${to}`}.xlsx`,
        content: buf.toString("base64"),
        bytes: buf.length,
        loans: sheets[0]?.rows.length ?? 0,
        name: p.name,
      });
    }
    files += attachments.length;
    // Normally one email for the team; split if the files together are too big for one.
    const groups: (typeof attachments)[] = [];
    let cur: typeof attachments = [];
    let size = 0;
    for (const a of attachments) {
      if (cur.length && size + a.bytes * 1.37 > MAX_EMAIL_BYTES) {
        groups.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(a);
      size += a.bytes * 1.37;
    }
    if (cur.length) groups.push(cur);
    for (const [gi, group] of groups.entries()) {
      const part = groups.length > 1 ? ` (part ${gi + 1} of ${groups.length})` : "";
      const lines = group.map((a) => `${a.name}: ${a.loans} loans`).join("\n");
      const html = `<p style="font-family:Arial,sans-serif;font-size:13px;">Feedback Files for team <b>${team.replace(/[<>&]/g, "")}</b> — ${periodText} (${FEEDBACK_PERIOD_LABEL[s.period]}), sent automatically by SamvadX (${s.name.replace(/[<>&]/g, "")}).</p><ul style="font-family:Arial,sans-serif;font-size:13px;">${group
        .map((a) => `<li>${a.name.replace(/[<>&]/g, "")}: ${a.loans} loans</li>`)
        .join("")}</ul>`;
      for (const to of emails) {
        emailsTried++;
        const ok = await sendOneEmail({
          to,
          subject: `Feedback File — ${team} — ${periodText}${part}`,
          text: `Feedback Files for team ${team}, ${periodText}:\n${lines}`,
          html,
          attachments: group.map(({ filename, content }) => ({ filename, content })),
        });
        if (ok) sent++;
      }
    }
  }

  const result = byTeam.size
    ? `${sent}/${emailsTried} emails sent — ${byTeam.size} team${byTeam.size === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}, ${periodText}`
    : "No open portfolios to send";
  await db()
    .from("report_email_log")
    .insert({
      client_id: s.clientId,
      list_id: list.id,
      list_name: list.name,
      sent_by: null,
      sent_by_name: sentByName,
      report_name: `Feedback Files — ${periodText}`,
      filename: `${files} file${files === 1 ? "" : "s"}, ${byTeam.size} team email${byTeam.size === 1 ? "" : "s"}`,
      recipients: emails,
      sent_count: sent,
      note: null,
    });
  await db()
    .from("report_email_schedules")
    .update({ last_result: `${result} at ${istParts(new Date()).time}` })
    .eq("id", s.id);
  return { sent, total: emailsTried, result };
}

/** Send any kind of schedule now. */
export function sendSchedule(s: ReportSchedule, at: Date, sentByName: string) {
  return s.kind === "feedback"
    ? sendScheduledFeedback(s, at, sentByName)
    : sendScheduledMis(s, at, sentByName);
}

async function tick(): Promise<void> {
  if (!emailConfigured()) return;
  const now = new Date();
  const { data, error } = await db().from("report_email_schedules").select("*").eq("enabled", true);
  if (error || !data) return;
  for (const s of (data as Record<string, unknown>[]).map(toSchedule)) {
    if (!isDue(s, now)) continue;
    const f = await loadFeatures(s.clientId);
    if (!f.reportEmails || (s.kind === "mis" && !f.misReports)) continue;
    const today = istParts(now).day;
    // Claim: only one tick (or process) can move last_sent_on forward for today.
    const q = db().from("report_email_schedules").update({ last_sent_on: today }).eq("id", s.id);
    const { data: claimed } = await (
      s.lastSentOn ? q.eq("last_sent_on", s.lastSentOn) : q.is("last_sent_on", null)
    ).select("id");
    if (!claimed?.length) continue;
    try {
      const r = await sendSchedule(s, now, `Scheduled: ${s.name}`);
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
