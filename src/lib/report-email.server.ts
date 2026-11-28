// Emailing report files to a company's own recipient lists (Reports pages → "Email a report").
// The browser builds the file exactly as its Download button does and sends it here; we check
// the caller, check the list is theirs, and send one email per recipient through Resend.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, shortText, noteSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { emailConfigured } from "./email.server";
import { requireFeature } from "./company-features.server";
import {
  ALLOWED_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_LIST_SIZE,
  attachmentExt,
  parseEmailList,
  safeAttachmentName,
} from "./report-email";

// Tables are newer than database.types.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables newer than generated types
const db = () => getSupabaseAdmin() as unknown as { from: (t: string) => any };

const SENDER_ROLES = new Set(["admin", "manager", "auditor"]);

async function caller(accessToken: string, adminOnly = false) {
  const c = await verifyCaller(accessToken);
  if (!c) throw new Error("Not authenticated");
  if (adminOnly ? c.role !== "admin" : !SENDER_ROLES.has(c.role))
    throw new Error(adminOnly ? "Only admins can change email lists" : "Not allowed");
  await requireFeature(c.clientId, "reportEmails");
  return c;
}

export interface ReportEmailList {
  id: string;
  name: string;
  emails: string[];
}

export interface ReportEmailLogRow {
  id: string;
  listName: string;
  sentByName: string | null;
  reportName: string;
  filename: string;
  recipients: number;
  sentCount: number;
  createdAt: string;
}

export const listReportEmailLists = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const c = await caller(data.accessToken);
    const { data: rows, error } = await db()
      .from("report_email_lists")
      .select("id, name, emails")
      .eq("client_id", c.clientId)
      .order("name");
    if (error) throw new Error(error.message);
    return { lists: (rows ?? []) as ReportEmailList[], emailReady: emailConfigured() };
  });

export const saveReportEmailList = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        id: idSchema.optional(),
        name: shortText(80),
        emails: z.string().max(20_000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const c = await caller(data.accessToken, true);
    const { valid, invalid } = parseEmailList(data.emails);
    if (invalid.length) throw new Error(`Not an email address: ${invalid.slice(0, 3).join(", ")}`);
    if (!valid.length) throw new Error("Add at least one email address");
    if (valid.length > MAX_LIST_SIZE)
      throw new Error(`A list can hold at most ${MAX_LIST_SIZE} addresses`);
    const row = { name: data.name, emails: valid, updated_at: new Date().toISOString() };
    const q = data.id
      ? db().from("report_email_lists").update(row).eq("id", data.id).eq("client_id", c.clientId)
      : db()
          .from("report_email_lists")
          .insert({ ...row, client_id: c.clientId, created_by: c.agentId });
    const { error } = await q;
    if (error)
      throw new Error(
        error.code === "23505" ? "A list with that name already exists" : error.message,
      );
    return { ok: true };
  });

export const deleteReportEmailList = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const c = await caller(data.accessToken, true);
    const { error } = await db()
      .from("report_email_lists")
      .delete()
      .eq("id", data.id)
      .eq("client_id", c.clientId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listReportEmailLog = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<ReportEmailLogRow[]> => {
    const c = await caller(data.accessToken, true);
    const { data: rows, error } = await db()
      .from("report_email_log")
      .select(
        "id, list_name, sent_by_name, report_name, filename, recipients, sent_count, created_at",
      )
      .eq("client_id", c.clientId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped row
    return (rows ?? []).map((r: Record<string, any>) => ({
      id: r.id,
      listName: r.list_name,
      sentByName: r.sent_by_name,
      reportName: r.report_name,
      filename: r.filename,
      recipients: (r.recipients ?? []).length,
      sentCount: r.sent_count,
      createdAt: r.created_at,
    }));
  });

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

export const sendReportEmail = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        listId: idSchema,
        reportName: shortText(120),
        filename: shortText(160),
        // base64; 4/3 of the byte limit plus slack
        contentBase64: z
          .string()
          .min(1)
          .max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 16),
        note: noteSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const c = await caller(data.accessToken);
    if (!emailConfigured())
      throw new Error("Email is not set up yet (RESEND_API_KEY / EMAIL_FROM)");
    const filename = safeAttachmentName(data.filename);
    const ext = attachmentExt(filename);
    if (!ext) throw new Error(`Only ${Object.keys(ALLOWED_TYPES).join(", ")} files can be emailed`);

    const { data: list } = await db()
      .from("report_email_lists")
      .select("id, name, emails")
      .eq("id", data.listId)
      .eq("client_id", c.clientId)
      .maybeSingle();
    if (!list) throw new Error("Email list not found");

    const [{ data: me }, { data: client }] = await Promise.all([
      db().from("agents").select("name").eq("id", c.agentId).maybeSingle(),
      db().from("clients").select("company_name").eq("id", c.clientId).maybeSingle(),
    ]);
    const senderName: string = me?.name ?? "A colleague";
    const company: string = client?.company_name ?? "SamvadX";
    const subject = `${data.reportName} — ${company}`;
    const note = data.note?.trim();
    const text = [
      `${senderName} sent you a report from SamvadX: ${data.reportName}.`,
      note ? `\nNote: ${note}` : "",
      `\nThe file (${filename}) is attached.`,
    ].join("\n");
    const html = `<p>${escapeHtml(senderName)} sent you a report from SamvadX: <b>${escapeHtml(data.reportName)}</b>.</p>${
      note ? `<p><i>${escapeHtml(note)}</i></p>` : ""
    }<p>The file <b>${escapeHtml(filename)}</b> is attached.</p>`;

    let sent = 0;
    for (const to of list.emails as string[]) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: [to],
            subject,
            text,
            html,
            attachments: [{ filename, content: data.contentBase64 }],
          }),
        });
        if (res.ok) sent++;
        else console.error(`[report-email] Resend rejected (${res.status}):`, await res.text());
      } catch (e) {
        console.error("[report-email] could not reach Resend:", e);
      }
    }

    await db()
      .from("report_email_log")
      .insert({
        client_id: c.clientId,
        list_id: list.id,
        list_name: list.name,
        sent_by: c.agentId,
        sent_by_name: senderName,
        report_name: data.reportName,
        filename,
        recipients: list.emails,
        sent_count: sent,
        note: note || null,
      });

    if (!sent) throw new Error("No email could be sent. Check the email setup and try again.");
    return { sent, total: (list.emails as string[]).length };
  });
