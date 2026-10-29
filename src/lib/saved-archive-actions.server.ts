// Superadmin → Saved Archives: list SamvadX's own copies of company archives, download one to
// hand to a company, and save a copy by hand for an ending or month the daily run did not cover
// (anything older than AUTO_SAVE_WINDOW_DAYS when this feature started). Every action calls
// verifySuperadminCaller first; the data is cross-company and read through the service role.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { fetchAllRows } from "./fetch-all-rows";
import { todayIstKey } from "./date-filter";
import { istMonthOf } from "./archive-snapshot.server";
import {
  loadEndings,
  saveMonthArchive,
  savePortfolioArchive,
  signedSavedArchiveUrl,
} from "./saved-archives.server";
import {
  downloadName,
  endedWithoutCopy,
  type EndedBy,
  type SavedArchiveKind,
} from "./saved-archives";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- saved_archive_files is newer
   than the generated Database types. */
type QueryBuilder = any;
const db = () => getSupabaseAdmin() as unknown as { from: (t: string) => QueryBuilder };

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Superadmin access required");
  return caller;
}

async function companyNames(): Promise<Map<string, string>> {
  const { data } = await db().from("clients").select("id, company_name");
  return new Map(
    ((data ?? []) as { id: string; company_name: string }[]).map((c) => [c.id, c.company_name]),
  );
}

export interface SavedArchiveRow {
  id: string;
  clientId: string;
  companyName: string;
  kind: SavedArchiveKind;
  portfolioName: string | null;
  endedOn: string | null;
  endedBy: EndedBy | null;
  month: string | null;
  sizeBytes: number | null;
  sheetCounts: Record<string, number> | null;
  savedBy: "schedule" | "superadmin";
  downloadCount: number;
  lastDownloadedAt: string | null;
  createdAt: string;
}

export interface UnsavedEnding {
  clientId: string;
  companyName: string;
  portfolioId: string;
  portfolioName: string;
  endedOn: string;
  endedBy: EndedBy;
}

export interface UnsavedMonth {
  clientId: string;
  companyName: string;
  month: string;
}

export const listSavedArchives = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const admin = db();
    const names = await companyNames();
    const company = (id: string) => names.get(id) ?? "Unknown company";

    const [savedRes, endings, runsRes] = await Promise.all([
      fetchAllRows<Record<string, unknown>>((from, to) => {
        let q = admin
          .from("saved_archive_files")
          .select(
            "id, client_id, kind, portfolio_name, ended_on, ended_by, month, size_bytes, " +
              "sheet_counts, saved_by, download_count, last_downloaded_at, created_at",
          );
        if (data.clientId) q = q.eq("client_id", data.clientId);
        return q.order("created_at", { ascending: false }).range(from, to);
      }),
      loadEndings(data.clientId),
      fetchAllRows<{ client_id: string; month: string }>((from, to) => {
        let q = admin.from("monthly_archive_runs").select("client_id, month").eq("status", "done");
        if (data.clientId) q = q.eq("client_id", data.clientId);
        return q.order("month", { ascending: false }).range(from, to);
      }),
    ]);
    if (savedRes.error) throw new Error("Could not load saved archives");

    const saved: SavedArchiveRow[] = savedRes.data.map((r) => ({
      id: r.id as string,
      clientId: r.client_id as string,
      companyName: company(r.client_id as string),
      kind: r.kind as SavedArchiveKind,
      portfolioName: (r.portfolio_name as string | null) ?? null,
      endedOn: (r.ended_on as string | null) ?? null,
      endedBy: (r.ended_by as EndedBy | null) ?? null,
      month: (r.month as string | null) ?? null,
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
      sheetCounts: (r.sheet_counts as Record<string, number> | null) ?? null,
      savedBy: r.saved_by as "schedule" | "superadmin",
      downloadCount: Number(r.download_count ?? 0),
      lastDownloadedAt: (r.last_downloaded_at as string | null) ?? null,
      createdAt: r.created_at as string,
    }));

    const unsavedEndings: UnsavedEnding[] = endedWithoutCopy(
      endings.portfolios,
      endings.saved,
      todayIstKey(),
    ).map((p) => ({
      clientId: p.client_id,
      companyName: company(p.client_id),
      portfolioId: p.id,
      portfolioName: p.name,
      endedOn: p.endedOn,
      endedBy: p.endedBy,
    }));

    // Finished months only: the current month is still changing and is saved on the 1st.
    const thisMonth = istMonthOf(new Date());
    const savedMonths = new Set(
      saved.filter((s) => s.kind === "month").map((s) => `${s.clientId}|${s.month}`),
    );
    const unsavedMonths: UnsavedMonth[] = (runsRes.error ? [] : runsRes.data)
      .filter((r) => r.month < thisMonth && !savedMonths.has(`${r.client_id}|${r.month}`))
      .map((r) => ({ clientId: r.client_id, companyName: company(r.client_id), month: r.month }));

    return { saved, unsavedEndings, unsavedMonths };
  });

export const getSavedArchiveDownload = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    enforceRateLimit(`saved-archive-url:${caller.authUserId}`, 30, 60_000);
    const { data: row } = await db()
      .from("saved_archive_files")
      .select("client_id, kind, portfolio_name, ended_on, month")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("That archive does not exist");
    const names = await companyNames();
    const company = names.get(row.client_id) ?? "company";
    const url = await signedSavedArchiveUrl(data.id, downloadName({ ...row, company }));
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "saved_archive_downloaded",
      clientId: row.client_id,
      summary:
        row.kind === "month"
          ? `Downloaded the saved archive for ${row.month}`
          : `Downloaded the saved archive of ${row.portfolio_name} (ended ${row.ended_on})`,
    });
    return { url };
  });

export const saveArchiveCopyNow = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: z.string().uuid(),
        portfolioId: z.string().uuid().optional(),
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
      })
      .refine((v) => !!v.portfolioId !== !!v.month, "Give a portfolio or a month")
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    enforceRateLimit(`saved-archive-save:${caller.authUserId}`, 10, 60_000);
    const savedBy = { by: "superadmin" as const, superadminId: caller.superadminId };

    if (data.month) {
      if (data.month >= istMonthOf(new Date()))
        throw new Error("This month is not finished yet — it is saved automatically on the 1st");
      const res = await saveMonthArchive(data.clientId, data.month, savedBy);
      if (res.skipped) return { saved: false, note: res.skipped };
      void logSuperadminActivity({
        superadminId: caller.superadminId,
        action: "saved_archive_created",
        clientId: data.clientId,
        summary: `Saved a copy of the ${data.month} archive`,
      });
      return { saved: true };
    }

    const { portfolios, saved } = await loadEndings(data.clientId);
    const target = endedWithoutCopy(
      portfolios.filter((p) => p.id === data.portfolioId),
      saved,
      todayIstKey(),
    )[0];
    if (!target) return { saved: false, note: "already saved, or the portfolio has not ended" };
    await savePortfolioArchive(data.clientId, target, savedBy);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "saved_archive_created",
      clientId: data.clientId,
      summary: `Saved a copy of ${target.name} (ended ${target.endedOn})`,
    });
    return { saved: true };
  });
