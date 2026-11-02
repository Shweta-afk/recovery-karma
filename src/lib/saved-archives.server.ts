// SamvadX's own copies of company archives — see migrations/20261029_saved_archive_files.sql for
// the what and why, and saved-archives.ts for the rules and sheet contents (unit-tested).
//
// Server-only, service role. Called by the daily archive run (archive-cron.server.ts) for every
// company, and by superadmin actions (saved-archive-actions.server.ts) after
// verifySuperadminCaller. Never with a company id a company user chose.
//
// Order, so a failure leaves nothing half-done: build the file → upload it (never overwriting)
// → record it in saved_archive_files. If the record fails (e.g. an overlapping run recorded the
// same ending first) the upload is removed again. Nothing here changes company data.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { fetchAllRows } from "./fetch-all-rows";
import { todayIstKey } from "./date-filter";
import { ARCHIVE_SHEETS, shapeSheet } from "./archive-shared";
import { XLSX_MIME, sheetsToXlsx } from "./dead-account-archive.server";
import type { CallLogLite, TraceLite } from "./dead-accounts-shared";
import {
  AUTO_SAVE_WINDOW_DAYS,
  SAVED_ARCHIVES_BUCKET,
  buildPortfolioArchiveSheets,
  endedWithoutCopy,
  endingKey,
  monthArchivePath,
  portfolioArchivePath,
  sheetCounts,
  type ArchiveSheet,
  type EndedPortfolio,
  type FullDebtorRow,
  type PortfolioEndInput,
} from "./saved-archives";
import { appError } from "./app-error";

/** ids per `.in(...)` request — keeps each request's URL small (see fetchDebtorsByIds). */
const ID_CHUNK = 300;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- saved_archive_files is newer
   than the generated Database types; the PostgREST builder chain has no useful type without. */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
  storage: ReturnType<typeof getSupabaseAdmin>["storage"];
}
const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;

export interface SaveResult {
  clientId: string;
  label: string;
  filePath?: string;
  /** Already had a copy (or nothing to save) — not an error. */
  skipped?: string;
  error?: string;
}

export interface SavedBy {
  by: "schedule" | "superadmin";
  superadminId?: string;
}

async function ensureBucket(): Promise<void> {
  const storage = db().storage;
  const { data } = await storage.getBucket(SAVED_ARCHIVES_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(SAVED_ARCHIVES_BUCKET, {
    public: false,
    allowedMimeTypes: [XLSX_MIME],
    fileSizeLimit: "200MB",
  });
  // A concurrent run may have just created it — only a genuine failure matters.
  if (error && !/already exists/i.test(error.message)) {
    throw appError("SX-6401", "Could not prepare storage for saved archives.", error);
  }
}

async function selectIn<T>(
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await query(ids.slice(i, i + ID_CHUNK));
    if (error) throw appError("SX-6402", "Could not read the portfolio for its archive.", error);
    if (data) out.push(...data);
  }
  return out;
}

function groupNewestFirst<T extends { created_at: string }>(
  rows: T[],
  key: (r: T) => string | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

async function agentNames(clientId: string): Promise<Map<string, string>> {
  const { data } = await db().from("agents").select("id, name, email").eq("client_id", clientId);
  return new Map(
    ((data ?? []) as { id: string; name: string | null; email: string | null }[]).map((a) => [
      a.id,
      a.name || a.email || "",
    ]),
  );
}

/** Upload, then record; removes the upload again if it cannot be recorded. */
async function storeAndRecord(
  filePath: string,
  sheets: ArchiveSheet[],
  ledger: Record<string, unknown>,
): Promise<void> {
  const admin = db();
  await ensureBucket();
  const bytes = await sheetsToXlsx(sheets);
  const { error: upErr } = await admin.storage
    .from(SAVED_ARCHIVES_BUCKET)
    .upload(filePath, bytes, { contentType: XLSX_MIME, upsert: false });
  if (upErr) throw appError("SX-6403", "Could not save the archive copy.", upErr);
  const { error } = await admin.from("saved_archive_files").insert({
    ...ledger,
    file_path: filePath,
    size_bytes: bytes.byteLength,
    sheet_counts: sheetCounts(sheets),
  });
  if (error) {
    await admin.storage.from(SAVED_ARCHIVES_BUCKET).remove([filePath]);
    throw appError("SX-6404", "Could not record the archive copy.", error);
  }
}

/** Builds and stores one portfolio's end-of-portfolio copy. */
export async function savePortfolioArchive(
  clientId: string,
  p: EndedPortfolio,
  savedBy: SavedBy,
  agentNameById?: Map<string, string>,
): Promise<string> {
  const admin = db();
  const { data: portfolio, error: pErr } = await admin
    .from("portfolios")
    .select("*")
    .eq("id", p.id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (pErr || !portfolio)
    throw appError("SX-6405", "Could not read the portfolio for its archive.", pErr);

  // select("*") on purpose: the copy keeps every column, the whole bank file (`extra`) included.
  const { data: debtors, error: dErr } = await fetchAllRows<FullDebtorRow>((from, to) =>
    admin
      .from("debtors")
      .select("*")
      .eq("client_id", clientId)
      .eq("portfolio_id", p.id)
      .order("id")
      .range(from, to),
  );
  if (dErr) throw appError("SX-6406", "Could not read accounts for the archive copy.", dErr);
  const ids = debtors.map((d) => d.id);

  const [logs, traces, payments, settlements, disputes, names] = await Promise.all([
    selectIn<CallLogLite>(ids, (part) =>
      admin
        .from("call_logs")
        .select(
          "id, debtor_id, agent_id, outcome, outcome_reason, raw_notes, ai_notes, promise_amount, " +
            "promise_date, callback_date, callback_time, duration_seconds, dial_mode, call_type, " +
            "sentiment, recording_url, created_at",
        )
        .in("debtor_id", part),
    ),
    selectIn<TraceLite>(ids, (part) =>
      admin
        .from("debtor_traces")
        .select("id, debtor_id, service_id, provider_status, cost, response, created_at")
        .in("debtor_id", part)
        .eq("state", "done"),
    ),
    selectIn<Record<string, unknown>>(ids, (part) =>
      admin.from("payments").select("*").in("debtor_id", part),
    ),
    selectIn<Record<string, unknown>>(ids, (part) =>
      admin.from("settlement_requests").select("*").in("debtor_id", part),
    ),
    selectIn<Record<string, unknown>>(ids, (part) =>
      admin.from("disputes").select("*").in("debtor_id", part),
    ),
    agentNameById ? Promise.resolve(agentNameById) : agentNames(clientId),
  ]);

  const sheets = buildPortfolioArchiveSheets({
    portfolio: portfolio as Record<string, unknown> & { name: string },
    ending: { endedOn: p.endedOn, endedBy: p.endedBy },
    savedAtIso: new Date().toISOString(),
    debtors,
    logsByDebtor: groupNewestFirst(logs, (l) => l.debtor_id),
    tracesByDebtor: groupNewestFirst(traces, (t) => t.debtor_id),
    payments,
    settlements,
    disputes,
    agentNameById: names,
  });
  const filePath = portfolioArchivePath(clientId, p.id, p.name, p.endedOn);
  await storeAndRecord(filePath, sheets, {
    client_id: clientId,
    kind: "portfolio_end",
    portfolio_id: p.id,
    portfolio_name: p.name,
    ended_on: p.endedOn,
    ended_by: p.endedBy,
    saved_by: savedBy.by,
    superadmin_id: savedBy.superadminId ?? null,
  });
  return filePath;
}

/** Every portfolio of the company with its ending state, and which endings already have a copy. */
export async function loadEndings(
  clientId?: string,
): Promise<{ portfolios: (PortfolioEndInput & { client_id: string })[]; saved: Set<string> }> {
  const admin = db();
  // Paged: the ledger grows by one row per portfolio ending and passes 1,000 in time.
  const [pRes, sRes] = await Promise.all([
    fetchAllRows<PortfolioEndInput & { client_id: string }>((from, to) => {
      let q = admin
        .from("portfolios")
        .select("id, name, client_id, closed_at, end_date, deleted_at")
        .or("closed_at.not.is.null,end_date.not.is.null");
      if (clientId) q = q.eq("client_id", clientId);
      return q.order("id").range(from, to);
    }),
    fetchAllRows<{ portfolio_id: string | null; ended_on: string }>((from, to) => {
      let q = admin
        .from("saved_archive_files")
        .select("portfolio_id, ended_on")
        .eq("kind", "portfolio_end");
      if (clientId) q = q.eq("client_id", clientId);
      return q.order("id").range(from, to);
    }),
  ]);
  if (pRes.error)
    throw appError("SX-6407", "Could not load portfolios for saved archives.", pRes.error);
  if (sRes.error) throw appError("SX-6408", "Could not load saved archives.", sRes.error);
  const saved = new Set(
    sRes.data
      .filter((r) => r.portfolio_id)
      .map((r) => endingKey(r.portfolio_id as string, r.ended_on)),
  );
  return { portfolios: pRes.data, saved };
}

let running: Promise<SaveResult[]> | null = null;

/**
 * The daily run's part: a copy of every portfolio that ended in the last AUTO_SAVE_WINDOW_DAYS
 * and has none yet, across every company. Single-flight within this process.
 */
export function saveRecentlyEndedPortfolios(): Promise<SaveResult[]> {
  if (running) return running;
  running = (async () => {
    try {
      const { portfolios, saved } = await loadEndings();
      const due = endedWithoutCopy(portfolios, saved, todayIstKey(), AUTO_SAVE_WINDOW_DAYS);
      const names = new Map<string, Map<string, string>>();
      const results: SaveResult[] = [];
      for (const p of due) {
        const label = `${p.name} (ended ${p.endedOn})`;
        try {
          if (!names.has(p.client_id)) names.set(p.client_id, await agentNames(p.client_id));
          const filePath = await savePortfolioArchive(
            p.client_id,
            p,
            { by: "schedule" },
            names.get(p.client_id),
          );
          results.push({ clientId: p.client_id, label, filePath });
        } catch (e) {
          // One portfolio's failure must not stop the rest; the next run tries it again.
          results.push({
            clientId: p.client_id,
            label,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return results;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Freezes the company's Archive History file for `month` — the same sheets, built the same way
 * (ARCHIVE_SHEETS + shapeSheet) as the admin's download. Skips a month that already has a copy,
 * or has nothing in it.
 */
export async function saveMonthArchive(
  clientId: string,
  month: string,
  savedBy: SavedBy,
): Promise<SaveResult> {
  const admin = db();
  const label = `Month ${month}`;
  const { data: existing } = await admin
    .from("saved_archive_files")
    .select("id")
    .eq("client_id", clientId)
    .eq("kind", "month")
    .eq("month", month)
    .maybeSingle();
  if (existing) return { clientId, label, skipped: "already saved" };

  const sheets: ArchiveSheet[] = [];
  for (const { kind, sheet } of ARCHIVE_SHEETS) {
    const { data, error } = await fetchAllRows<{ data: Record<string, unknown> }>((from, to) =>
      admin
        .from("monthly_archive_rows")
        .select("data")
        .eq("client_id", clientId)
        .eq("month", month)
        .eq("kind", kind)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (error) throw appError("SX-6409", "Could not read the month's archive.", error);
    if (!data.length) continue;
    const { columns, values } = shapeSheet(data.map((r) => r.data));
    sheets.push({ name: sheet, columns, rows: values });
  }
  if (!sheets.length) return { clientId, label, skipped: "nothing archived that month" };

  const filePath = monthArchivePath(clientId, month);
  await storeAndRecord(filePath, sheets, {
    client_id: clientId,
    kind: "month",
    month,
    saved_by: savedBy.by,
    superadmin_id: savedBy.superadminId ?? null,
  });
  return { clientId, label, filePath };
}

/** A 5-minute download link for one copy; counts the download. Caller must be a verified
 *  superadmin. `fileName` is what the browser saves it as. */
export async function signedSavedArchiveUrl(fileId: string, fileName: string): Promise<string> {
  const admin = db();
  const { data: row, error } = await admin
    .from("saved_archive_files")
    .select("file_path, download_count")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw appError("SX-6410", "Could not load that archive.", error);
  if (!row) throw new Error("That archive does not exist");
  const { data, error: sErr } = await admin.storage
    .from(SAVED_ARCHIVES_BUCKET)
    .createSignedUrl(row.file_path, 300, { download: fileName });
  if (sErr || !data?.signedUrl)
    throw appError("SX-6411", "Could not create a download link.", sErr);
  await admin
    .from("saved_archive_files")
    .update({
      download_count: (row.download_count ?? 0) + 1,
      last_downloaded_at: new Date().toISOString(),
    })
    .eq("id", fileId);
  return data.signedUrl;
}
