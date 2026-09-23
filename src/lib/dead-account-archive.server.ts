// Dead-account archiving job — see migrations/20260923_dead_account_archive.sql for the what and
// why, and dead-accounts-shared.ts for the selection rules and sheet contents (both unit-tested).
//
// Server-only, service role. Never called with a client id taken from a request: the admin
// "Archive now" action passes the VERIFIED caller's company, and the scheduled route
// (/api/cron/archive, see archive-cron.server.ts) runs every company.
//
// Order is what makes it safe to re-run or to fail half-way:
//   1. snapshot the company's full rows into monthly_archive_rows (archive_month) — so nothing
//      the strip clears is ever lost, even though the Excel file itself is deliberately slim;
//   2. build the file and upload it;
//   3. record it in dead_account_files;
//   4. only then strip the accounts (`archived_at IS NULL` guard, so a retry never double-strips).
// A failure at 1–3 leaves every account untouched and gets picked up by the next run.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { fetchAllRows } from "./fetch-all-rows";
import { todayIstKey } from "./date-filter";
import {
  OPEN_RETENTION_STATUSES,
  buildDeadAccountSheets,
  deadAccountFilePath,
  isPastDeadCutoff,
  pickDeadDebtors,
  type CallLogLite,
  type DebtorLite,
  type SheetData,
  type TraceLite,
} from "./dead-accounts-shared";

export const DEAD_ACCOUNTS_BUCKET = "dead-accounts";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** ids per `.in(...)` request — keeps each request's URL small (see fetchDebtorsByIds). */
const ID_CHUNK = 300;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- no generated Database types;
   the PostgREST builder chain has no useful static type without them. */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  storage: ReturnType<typeof getSupabaseAdmin>["storage"];
}
const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;

export interface PortfolioArchiveResult {
  portfolioId: string;
  portfolioName: string;
  archived: number;
  keptOpenCommitment: number;
  keptOpenRetention: number;
  filePath?: string;
  error?: string;
}

export interface ClientArchiveResult {
  clientId: string;
  portfolios: PortfolioArchiveResult[];
  error?: string;
}

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs one `.in(column, chunk)` query per chunk and concatenates the rows. */
async function selectIn<T>(
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await query(part);
    if (error) throw new Error(error.message);
    if (data) out.push(...data);
  }
  return out;
}

async function ensureBucket(): Promise<void> {
  const storage = db().storage;
  const { data } = await storage.getBucket(DEAD_ACCOUNTS_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(DEAD_ACCOUNTS_BUCKET, {
    public: false,
    allowedMimeTypes: [XLSX_MIME],
    fileSizeLimit: "50MB",
  });
  // A concurrent run may have just created it — only a genuine failure matters.
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(
      `Could not create the ${DEAD_ACCOUNTS_BUCKET} storage bucket: ${error.message}`,
    );
  }
}

async function toXlsx(sheets: SheetData[]): Promise<Uint8Array> {
  // Loaded on demand: large, and only this job needs it server-side.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "SamvadX";
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow(s.columns).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of s.rows) ws.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const istMonth = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
    .format(d)
    .slice(0, 7);

async function archivePortfolio(
  clientId: string,
  portfolio: { id: string; name: string; closed_at: string },
  agentNameById: Map<string, string>,
  todayKey: string,
): Promise<PortfolioArchiveResult> {
  const admin = db();
  const result: PortfolioArchiveResult = {
    portfolioId: portfolio.id,
    portfolioName: portfolio.name,
    archived: 0,
    keptOpenCommitment: 0,
    keptOpenRetention: 0,
  };

  const { data: debtorRows, error: dErr } = await fetchAllRows<DebtorLite>((from, to) =>
    admin
      .from("debtors")
      .select("id, name, phone_primary, alt_phones, loan_reference")
      .eq("client_id", clientId)
      .eq("portfolio_id", portfolio.id)
      .is("archived_at", null)
      .order("id")
      .range(from, to),
  );
  if (dErr) throw new Error(`debtors: ${dErr.message}`);
  if (!debtorRows.length) return result;
  const ids = debtorRows.map((d) => d.id);

  const [logs, openRetention] = await Promise.all([
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
    selectIn<{ debtor_id: string }>(ids, (part) =>
      admin
        .from("retention_requests")
        .select("debtor_id")
        .in("debtor_id", part)
        .in("status", [...OPEN_RETENTION_STATUSES]),
    ),
  ]);

  const logsByDebtor = new Map<string, CallLogLite[]>();
  for (const l of logs) {
    if (!l.debtor_id) continue;
    const list = logsByDebtor.get(l.debtor_id) ?? [];
    list.push(l);
    logsByDebtor.set(l.debtor_id, list);
  }
  for (const list of logsByDebtor.values())
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const { archive, skipped } = pickDeadDebtors(
    ids,
    logsByDebtor,
    new Set(openRetention.map((r) => r.debtor_id)),
    todayKey,
  );
  result.keptOpenCommitment = skipped.filter((s) => s.reason === "open_commitment").length;
  result.keptOpenRetention = skipped.filter((s) => s.reason === "open_retention").length;
  if (!archive.length) return result;

  const traces = await selectIn<TraceLite>(archive, (part) =>
    admin
      .from("debtor_traces")
      .select("id, debtor_id, service_id, provider_status, cost, response, created_at")
      .in("debtor_id", part)
      .eq("state", "done"),
  );
  const tracesByDebtor = new Map<string, TraceLite[]>();
  for (const t of traces) {
    const list = tracesByDebtor.get(t.debtor_id) ?? [];
    list.push(t);
    tracesByDebtor.set(t.debtor_id, list);
  }
  for (const list of tracesByDebtor.values())
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const archiveSet = new Set(archive);
  const sheets = buildDeadAccountSheets(
    debtorRows.filter((d) => archiveSet.has(d.id)),
    logsByDebtor,
    tracesByDebtor,
    agentNameById,
  );
  const bytes = await toXlsx(sheets);
  const filePath = deadAccountFilePath(
    clientId,
    portfolio.id,
    portfolio.name,
    todayKey,
    archive.length,
  );

  const { error: upErr } = await admin.storage
    .from(DEAD_ACCOUNTS_BUCKET)
    .upload(filePath, bytes, { contentType: XLSX_MIME, upsert: false });
  if (upErr) throw new Error(`upload: ${upErr.message}`);

  const { error: ledgerErr } = await admin.from("dead_account_files").insert({
    client_id: clientId,
    portfolio_id: portfolio.id,
    portfolio_name: portfolio.name,
    closed_at: portfolio.closed_at,
    file_path: filePath,
    account_count: archive.length,
    size_bytes: bytes.byteLength,
  });
  if (ledgerErr) {
    // No ledger entry means no admin can find the file — remove it and leave the accounts
    // untouched, so the next run redoes the whole thing cleanly.
    await admin.storage.from(DEAD_ACCOUNTS_BUCKET).remove([filePath]);
    throw new Error(`ledger: ${ledgerErr.message}`);
  }

  // The file is safely stored and findable — now strip. `archived_at IS NULL` makes a retry
  // after a partial failure strip only what is left, never an account twice.
  const stampedAt = new Date().toISOString();
  for (const part of chunks(archive)) {
    const { error: stripErr } = await admin
      .from("debtors")
      .update({ extra: {}, email: null, archived_at: stampedAt })
      .in("id", part)
      .is("archived_at", null);
    if (stripErr) throw new Error(`strip (file already saved at ${filePath}): ${stripErr.message}`);
    result.archived += part.length;
  }
  result.filePath = filePath;
  return result;
}

async function archiveClient(clientId: string, now: Date): Promise<ClientArchiveResult> {
  const admin = db();
  const out: ClientArchiveResult = { clientId, portfolios: [] };
  const todayKey = todayIstKey();

  const { data: closed, error: pErr } = await admin
    .from("portfolios")
    .select("id, name, closed_at")
    .eq("client_id", clientId)
    .not("closed_at", "is", null);
  if (pErr) return { ...out, error: `portfolios: ${pErr.message}` };
  const due = ((closed ?? []) as { id: string; name: string; closed_at: string }[]).filter((p) =>
    isPastDeadCutoff(p.closed_at, todayKey),
  );
  if (!due.length) return out;

  // Step 1 — the safety copy. Refuse to strip anything if it can't be taken (e.g. the monthly
  // archive migration isn't applied yet): the Excel file alone is deliberately too slim to undo
  // a strip from.
  const { error: snapErr } = await admin.rpc("archive_month", {
    p_month: istMonth(now),
    p_client: clientId,
  });
  if (snapErr)
    return { ...out, error: `safety snapshot (archive_month) failed: ${snapErr.message}` };

  const { data: agentRows } = await admin
    .from("agents")
    .select("id, name, email")
    .eq("client_id", clientId);
  const agentNameById = new Map(
    ((agentRows ?? []) as { id: string; name: string | null; email: string | null }[]).map((a) => [
      a.id,
      a.name || a.email || "",
    ]),
  );

  for (const p of due) {
    try {
      out.portfolios.push(await archivePortfolio(clientId, p, agentNameById, todayKey));
    } catch (e) {
      // One portfolio's failure must not stop the rest of the company's.
      out.portfolios.push({
        portfolioId: p.id,
        portfolioName: p.name,
        archived: 0,
        keptOpenCommitment: 0,
        keptOpenRetention: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

let running: Promise<ClientArchiveResult[]> | null = null;

/**
 * Archives dead accounts for one company, or every company when `clientId` is omitted.
 * Single-flight within this server process: a second call while one is running waits for and
 * returns that run instead of starting an overlapping one.
 */
export function archiveDeadAccounts(clientId?: string): Promise<ClientArchiveResult[]> {
  if (running) return running;
  running = (async () => {
    try {
      await ensureBucket();
      const now = new Date();
      let clientIds: string[];
      if (clientId) {
        clientIds = [clientId];
      } else {
        const { data, error } = await db().from("clients").select("id");
        if (error) throw new Error(`clients: ${error.message}`);
        clientIds = ((data ?? []) as { id: string }[]).map((c) => c.id);
      }
      const results: ClientArchiveResult[] = [];
      for (const id of clientIds) results.push(await archiveClient(id, now));
      return results;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** A short-lived download link for one ledger entry. Caller must already be verified as an
 * admin of `clientId`; this re-checks that the file belongs to that company. */
export async function signedDeadAccountFileUrl(clientId: string, fileId: string): Promise<string> {
  const admin = db();
  const { data: row, error } = await admin
    .from("dead_account_files")
    .select("client_id, file_path")
    .eq("id", fileId)
    .maybeSingle();
  if (error) throw new Error(`Could not load that file (${error.message})`);
  if (!row || row.client_id !== clientId || !String(row.file_path).startsWith(`${clientId}/`)) {
    throw new Error("That file does not exist");
  }
  const { data, error: sErr } = await admin.storage
    .from(DEAD_ACCOUNTS_BUCKET)
    .createSignedUrl(row.file_path, 300, { download: true });
  if (sErr || !data?.signedUrl)
    throw new Error(`Could not create a download link (${sErr?.message})`);
  return data.signedUrl;
}
