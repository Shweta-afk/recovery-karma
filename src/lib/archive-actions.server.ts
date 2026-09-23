// "Archive now" for the admin Archive page. The daily scheduled run (/api/cron/archive, see
// archive-cron.server.ts and docs/MONTHLY_ARCHIVE.md) does the same two things for every company;
// this is the on-demand version for the caller's own company — used to back-fill months before
// the schedule existed, snapshot the current month, and archive any dead accounts now.
//
// archive_month() is executable only by service_role (see 20260922_monthly_archive.sql), so it
// is reached through the service-role client — after verifyCaller() proves the caller is an
// admin, and always scoped to THEIR company (p_client comes from the verified caller, never the
// request body).
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import { monthsBetween } from "./archive-shared";
import { archiveDeadAccounts, signedDeadAccountFileUrl } from "./dead-account-archive.server";

interface LooseDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- no generated Database types
  from: (table: string) => any;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

const istMonth = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
    .format(d)
    .slice(0, 7);

export const runArchiveNow = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") throw new Error("Only admins can archive");
    enforceRateLimit(`archive-now:${caller.authUserId}`, 3, 60_000);

    const admin = getSupabaseAdmin() as unknown as LooseDb;

    // Start from the company's oldest account so history before the first scheduled run is
    // captured too. Nothing older than that can exist for this company.
    const { data: first } = await admin
      .from("debtors")
      .select("created_at")
      .eq("client_id", caller.clientId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const now = new Date();
    const thisMonth = istMonth(now);
    const startMonth = first?.created_at ? istMonth(new Date(first.created_at)) : thisMonth;

    const months = monthsBetween(startMonth, thisMonth);
    const results: { month: string; ok: boolean; error?: string }[] = [];
    // One month per call so no single statement runs long enough to hit a request timeout, and
    // one bad month is reported without abandoning the rest.
    for (const month of months) {
      const { error } = await admin.rpc("archive_month", {
        p_month: month,
        p_client: caller.clientId,
      });
      results.push(error ? { month, ok: false, error: error.message } : { month, ok: true });
    }

    // Dead accounts (portfolio closed 60+ days, nothing open) -> Excel file + strip. Scoped to the
    // verified caller's company only.
    // find(), not [0]: archiveDeadAccounts is single-flight, so if the daily run for every
    // company is already in progress this awaits THAT run, whose results list all companies.
    const dead = (await archiveDeadAccounts(caller.clientId)).find(
      (r) => r.clientId === caller.clientId,
    );
    const deadAccounts = {
      error: dead?.error,
      archived: (dead?.portfolios ?? []).reduce((s, p) => s + p.archived, 0),
      files: (dead?.portfolios ?? []).filter((p) => p.filePath).length,
      keptOpen: (dead?.portfolios ?? []).reduce(
        (s, p) => s + p.keptOpenCommitment + p.keptOpenRetention,
        0,
      ),
      failed: (dead?.portfolios ?? [])
        .filter((p) => p.error)
        .map((p) => ({ portfolio: p.portfolioName, error: p.error as string })),
    };
    return { results, deadAccounts };
  });

/** A 5-minute download link for one dead-account file — admins, own company only. */
export const getDeadAccountFileUrl = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, fileId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "admin") throw new Error("Only admins can download archived accounts");
    enforceRateLimit(`dead-file-url:${caller.authUserId}`, 30, 60_000);
    return { url: await signedDeadAccountFileUrl(caller.clientId, data.fileId) };
  });
