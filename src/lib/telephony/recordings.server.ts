// Imports call recordings from SkyCRM into SamvadX (2026-11-05). Server-only: started from
// src/server.ts, never imported by browser code.
//
// Every few minutes: take ended SkyCRM calls from the telephony_calls ledger that have no
// recording outcome yet, find each one's CDR row by SkyCRM callid (cdr_report), and for answered
// calls fetch the file (download_audio/ by CDR id), store it in the private "call-recordings"
// bucket and put a marker in call_logs.recording_url (see recording-file.ts for why a marker).
//
// ⚠️ As of 2026-11-05 SkyCRM's download_audio/ fails for EVERY id with
// {"status":500,"error":"HTTPSConnectionPool(host='disk', …)"} — their server can't reach its own
// recording disk. That is treated as a vendor outage: the sweep stops at the first such answer and
// does NOT count it against the call, so the whole backlog (30 days) imports by itself once SkyCRM
// fixes it. recording_error on the ledger row shows the last answer.
import { getSupabaseAdmin } from "@/lib/supabase-admin.server";
import { downloadRecordingRaw, fetchCdrReport, type SkyCrmCdrRow } from "./skycrm-provider";
import {
  CALL_RECORDINGS_BUCKET,
  MAX_RECORDING_ATTEMPTS,
  RECORDING_RETENTION_DAYS,
  extractRecording,
  keptObjectPath,
  recordingRetentionCutoff,
  recordingMarker,
  recordingObjectPath,
  retryDelayMs,
  RECORDING_FIRST_LOOK_MS,
  skycrmIstDate,
  cdrNumberDiffers,
} from "./recording-file";

/* eslint-disable @typescript-eslint/no-explicit-any -- new columns aren't in the generated types yet */
const db = () => getSupabaseAdmin() as any;

// 2026-11-18: was 25 every 5 min (300/hour) while busy hours ran 250–430 calls, so a call from
// early in a busy hour waited up to 4 hours behind newer ones. 100 every 2 min = 3,000/hour; most
// rows are unanswered calls (one CDR lookup per sweep, no download). `state.running` stops a slow
// sweep from overlapping the next tick.
// 2026-11-21: every minute, first look 45 s after hangup (was 2 min / 2 min) — recordings came
// 2–4 min after a call, much later than SkyCRM's own site.
const SWEEP_EVERY_MS = 60_000;
const PER_SWEEP = 100;
const BACKLOG_DAYS = 30;
/** Misses of a call's CDR row before an old call is marked as having no recording. */
const CDR_MISSES_BEFORE_GIVING_UP = 4;

interface TodoRow {
  id: string;
  client_id: string;
  provider_call_id: string | null;
  vendor_callid: string;
  agent_handle: string | null;
  remote_phone: string | null;
  started_at: string;
  ended_at: string;
  recording_attempts: number;
  recording_checked_at: string | null;
}

export interface SweepResult {
  checked: number;
  stored: number;
  none: number;
  vendorDown?: string;
}

const g = globalThis as unknown as {
  __samvadxRecordings?: { timer?: ReturnType<typeof setInterval>; running?: boolean };
};
const state = (g.__samvadxRecordings ??= {}) as {
  timer?: ReturnType<typeof setInterval>;
  running?: boolean;
  lastPurge?: number;
};

function enabled(): boolean {
  return process.env.TELEPHONY_PROVIDER === "skycrm" && !!process.env.SKYCRM_SECRET;
}

/** Start the background sweep once per process (single Railway replica — see CLAUDE.md). */
export function startRecordingImports(): void {
  if (state.timer || typeof setInterval === "undefined") return;
  const tick = () => {
    if (!enabled()) return;
    void importRecordings().catch((err) => console.warn("[recordings] sweep failed:", err));
    // Retention: at most every 6 hours, delete our copies older than RECORDING_RETENTION_DAYS.
    if (!state.lastPurge || Date.now() - state.lastPurge > 6 * 3600_000) {
      state.lastPurge = Date.now();
      void purgeOldRecordings().catch((err) => console.warn("[recordings] purge failed:", err));
    }
  };
  setTimeout(tick, 60_000);
  setTimeout(() => {
    if (enabled()) void probeCdrPaging().catch((e) => console.warn("[cdr-probe] failed:", e));
  }, 30_000);
  state.timer = setInterval(tick, SWEEP_EVERY_MS);
  state.timer.unref?.();
}

async function ensureBucket(): Promise<void> {
  const storage = getSupabaseAdmin().storage;
  const { data } = await storage.getBucket(CALL_RECORDINGS_BUCKET);
  if (data) return;
  // Never above the project's 50 MB upload limit: Supabase refuses to create such a bucket. "100MB"
  // here failed every sweep from 2026-11-15, the day SkyCRM's downloads started working, so no
  // recording was ever stored.
  const { error } = await storage.createBucket(CALL_RECORDINGS_BUCKET, {
    public: false,
    fileSizeLimit: "50MB",
  });
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`could not create the ${CALL_RECORDINGS_BUCKET} bucket: ${error.message}`);
  }
}

/**
 * SkyCRM's call records for the days these rows were made on, keyed by callid.
 *
 * Asked ONE IST DAY AT A TIME (start_date = end_date, as in the vendor's own example). Until
 * 2026-11-26 one request covered the whole batch (first call → last call + 24 h), and for a busy
 * range SkyCRM answered with only the newest part of it: on 5 Nov only the 15:33–18:29 calls were
 * found, on 14 Nov only 18:34–18:36, and ~2,100 answered calls from 4–20 Nov were marked "no
 * recording" though SkyCRM had one. A call that ends after midnight is looked up on the next day
 * too.
 */
async function cdrIndex(rows: TodoRow[]): Promise<Map<string, SkyCrmCdrRow>> {
  const days = new Set<string>();
  for (const r of rows) {
    days.add(skycrmIstDate(new Date(r.started_at)));
    if (r.ended_at) days.add(skycrmIstDate(new Date(r.ended_at)));
  }
  const extension = rows.find((r) => r.agent_handle)?.agent_handle ?? "8601";
  const map = new Map<string, SkyCrmCdrRow>();
  for (const day of days) {
    for (const process of ["Outbound", "Inbound"] as const) {
      const list = await fetchCdrReport({ extension, startDate: day, endDate: day, process }).catch(
        (err: unknown) => {
          console.warn(`[recordings] cdr_report ${process} ${day} failed: ${String(err)}`);
          return [] as SkyCrmCdrRow[];
        },
      );
      for (const row of list) if (row.callid) map.set(String(row.callid), row);
      // Logged so a capped answer (fewer rows than calls that day) shows in Railway's logs.
      console.log(`[recordings] cdr_report ${process} ${day}: ${list.length} rows`);
    }
  }
  return map;
}

/**
 * TEMPORARY (2026-11-26): cdr_report stops at 1,000 rows per request, so on a busy day most calls'
 * records (and so their recordings) can't be found. The vendor documents no paging. This runs
 * once per server start, reads one busy past day with a few likely paging fields, and logs what
 * comes back, so we can see in Railway's logs which field (if any) gives a different 1,000.
 * Read-only. Remove once paging is known.
 */
async function probeCdrPaging(): Promise<void> {
  const day = "16-11-2026"; // 2,732 calls
  const variants: [string, Record<string, string>, string?, string?][] = [
    ["base", {}],
    ["page=2", { page: "2" }],
    ["page=1", { page: "1" }],
    ["offset=1000", { offset: "1000" }],
    ["start=1000", { start: "1000" }],
    ["limit=5000", { limit: "5000" }],
    ["length=5000", { length: "5000" }],
    ["per_page=5000", { per_page: "5000" }],
    ["page_size=5000", { page_size: "5000" }],
    ["start_time/end_time 10-12", { start_time: "10:00:00", end_time: "12:00:00" }],
    ["date with time 10-12", {}, "16-11-2026 10:00:00", "16-11-2026 12:00:00"],
  ];
  const timeKeys = (r: SkyCrmCdrRow | undefined) =>
    r
      ? Object.entries(r)
          .filter(([k]) => /date|time|start|end|id$/i.test(k))
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")
      : "-";
  for (const [label, extra, start, end] of variants) {
    try {
      const rows = await fetchCdrReport({
        extension: "8601",
        startDate: start ?? day,
        endDate: end ?? day,
        process: "Outbound",
        extra,
      });
      const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
      console.log(
        `[cdr-probe] ${label}: ${rows.length} rows, id ${Math.min(...ids)}..${Math.max(...ids)}` +
          ` | first: ${timeKeys(rows[0])} | last: ${timeKeys(rows[rows.length - 1])}`,
      );
      if (label === "base" && rows[0]) {
        console.log(`[cdr-probe] fields: ${Object.keys(rows[0]).join(",")}`);
      }
    } catch (err) {
      console.log(`[cdr-probe] ${label}: error ${String(err).slice(0, 200)}`);
    }
  }
}

async function patch(id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("telephony_calls").update(values).eq("id", id);
  if (error) console.warn(`[recordings] ledger update failed for ${id}: ${error.message}`);
}

/** One sweep. Safe to call any time; overlapping calls return immediately. */
export async function importRecordings(limit = PER_SWEEP): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, stored: 0, none: 0 };
  if (state.running) return result;
  state.running = true;
  try {
    const now = Date.now();
    const { data, error } = await db()
      .from("telephony_calls")
      .select(
        "id, client_id, provider_call_id, vendor_callid, agent_handle, remote_phone, started_at, ended_at, recording_attempts, recording_checked_at",
      )
      .eq("provider", "skycrm")
      .is("recording_status", null)
      .not("vendor_callid", "is", null)
      .not("ended_at", "is", null)
      .lt("ended_at", new Date(now - RECORDING_FIRST_LOOK_MS).toISOString())
      .gt("started_at", new Date(now - BACKLOG_DAYS * 24 * 3600_000).toISOString())
      .order("ended_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const due = ((data ?? []) as TodoRow[])
      .filter(
        (r) =>
          !r.recording_checked_at ||
          now - new Date(r.recording_checked_at).getTime() >= retryDelayMs(r.recording_attempts),
      )
      .slice(0, limit);
    if (!due.length) return result;

    const cdr = await cdrIndex(due);
    let bucketReady = false;

    for (const row of due) {
      result.checked++;
      const checkedAt = new Date().toISOString();
      const rec = cdr.get(row.vendor_callid);
      if (!rec) {
        // SkyCRM writes the CDR at hangup. Give up only after several misses spread over time
        // (retryDelayMs) on a call over a day old — one miss on an old call used to be final,
        // which is how a bad lookup turned into ~2,100 permanently missing recordings.
        const old =
          now - new Date(row.ended_at).getTime() > 24 * 3600_000 &&
          row.recording_attempts + 1 >= CDR_MISSES_BEFORE_GIVING_UP;
        await patch(row.id, {
          recording_checked_at: checkedAt,
          recording_attempts: row.recording_attempts + 1,
          recording_error: "no CDR row for this callid yet",
          ...(old ? { recording_status: "none" } : {}),
        });
        if (old) result.none++;
        continue;
      }
      const answered =
        String(rec.disposition ?? "").toUpperCase() === "ANSWERED" && Number(rec.billsec ?? 0) > 0;
      if (!answered) {
        await patch(row.id, {
          recording_status: "none",
          recording_checked_at: checkedAt,
          recording_error: `not answered (${rec.disposition ?? "?"})`,
        });
        result.none++;
        continue;
      }

      // The call record is for another borrower's number: this row was matched to the wrong
      // SkyCRM call (a late end record). Storing it would let someone play another borrower's
      // call (Health Check "wrong recording", still 3 on 25 Nov 2026), so it is never stored.
      const otherNumber = cdrNumberDiffers(rec, row.remote_phone);
      if (otherNumber) {
        await patch(row.id, {
          recording_status: "mismatched",
          recording_checked_at: checkedAt,
          recording_error: `Recording belongs to another call (number ${otherNumber}) — not stored`,
        });
        result.none++;
        continue;
      }

      const raw = await downloadRecordingRaw(String(rec.id), row.agent_handle ?? "8601").catch(
        (err: unknown) => Buffer.from(JSON.stringify({ error: String(err) })),
      );
      const got = extractRecording(raw);
      if (!got.ok) {
        if (got.kind === "vendor") {
          // SkyCRM can't serve files right now — don't burn this call's attempts; stop the sweep.
          await patch(row.id, { recording_checked_at: checkedAt, recording_error: got.detail });
          result.vendorDown = got.detail;
          break;
        }
        const attempts = row.recording_attempts + 1;
        await patch(row.id, {
          recording_checked_at: checkedAt,
          recording_attempts: attempts,
          recording_error: got.detail,
          ...(attempts >= MAX_RECORDING_ATTEMPTS ? { recording_status: "failed" } : {}),
        });
        continue;
      }

      if (!bucketReady) {
        await ensureBucket();
        bucketReady = true;
      }
      const path = recordingObjectPath(
        row.client_id,
        new Date(row.started_at),
        row.vendor_callid,
        got.file.name,
      );
      const up = await getSupabaseAdmin()
        .storage.from(CALL_RECORDINGS_BUCKET)
        .upload(path, got.file.bytes, { contentType: got.file.contentType, upsert: true });
      if (up.error) {
        await patch(row.id, {
          recording_checked_at: checkedAt,
          recording_attempts: row.recording_attempts + 1,
          recording_error: `storage: ${up.error.message}`,
        });
        continue;
      }
      await patch(row.id, {
        recording_status: "stored",
        recording_object: path,
        recording_bytes: got.file.bytes.length,
        recording_content_type: got.file.contentType,
        recording_checked_at: checkedAt,
        recording_error: null,
      });
      // Link it to the call log (written at disposition time — may not exist yet; the Activity
      // History backfill, fetchRecordings, links it then). Never overwrite a recording already there.
      if (row.provider_call_id) {
        await db()
          .from("call_logs")
          .update({ recording_url: recordingMarker(row.id) })
          .eq("provider_call_id", row.provider_call_id)
          .is("recording_url", null);
      }
      result.stored++;
    }
    if (result.checked)
      console.log(
        `[recordings] checked ${result.checked}, stored ${result.stored}, none ${result.none}` +
          (result.vendorDown
            ? `, SkyCRM download failing: ${result.vendorDown.slice(0, 120)}`
            : ""),
      );
    return result;
  } finally {
    state.running = false;
  }
}

/**
 * Delete SamvadX's own copies of recordings older than RECORDING_RETENTION_DAYS (2026-11-20).
 * The ledger row stays (status 'expired') so reports still know a recording existed; playback,
 * AI and the feedback file then say there is no recording. Files of recordings marked as another
 * call's ('mismatched', path kept in recording_error) are deleted on the same schedule.
 */
export async function purgeOldRecordings(batch = 500): Promise<{ deleted: number }> {
  const cutoff = recordingRetentionCutoff(Date.now()).toISOString();
  const note = `Deleted after ${RECORDING_RETENTION_DAYS} days (SamvadX keeps its copy ${RECORDING_RETENTION_DAYS} days).`;
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const { data, error } = await db()
      .from("telephony_calls")
      .select("id, recording_status, recording_object, recording_error")
      .in("recording_status", ["stored", "mismatched"])
      .lt("started_at", cutoff)
      .limit(batch);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as {
      id: string;
      recording_status: string;
      recording_object: string | null;
      recording_error: string | null;
    }[];
    if (!rows.length) break;
    const paths = rows
      .map((r) => r.recording_object ?? keptObjectPath(r.recording_error))
      .filter((p): p is string => !!p);
    if (paths.length) {
      const { error: rmErr } = await getSupabaseAdmin()
        .storage.from(CALL_RECORDINGS_BUCKET)
        .remove(paths);
      // Leave the rows as they are if Storage refused, so the next run tries again.
      if (rmErr) throw new Error(`storage remove: ${rmErr.message}`);
    }
    const { error: upErr } = await db()
      .from("telephony_calls")
      .update({ recording_status: "expired", recording_object: null, recording_error: note })
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (upErr) throw new Error(upErr.message);
    deleted += rows.length;
    if (rows.length < batch) break;
  }
  if (deleted)
    console.log(
      `[recordings] retention: deleted ${deleted} recordings older than ${RECORDING_RETENTION_DAYS} days`,
    );
  return { deleted };
}
