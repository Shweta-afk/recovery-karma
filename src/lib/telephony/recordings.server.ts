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
  extractRecording,
  recordingMarker,
  recordingObjectPath,
  retryDelayMs,
  skycrmIstDate,
} from "./recording-file";

/* eslint-disable @typescript-eslint/no-explicit-any -- new columns aren't in the generated types yet */
const db = () => getSupabaseAdmin() as any;

const SWEEP_EVERY_MS = 5 * 60_000;
const PER_SWEEP = 25;
const BACKLOG_DAYS = 30;

interface TodoRow {
  id: string;
  client_id: string;
  provider_call_id: string | null;
  vendor_callid: string;
  agent_handle: string | null;
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
const state = (g.__samvadxRecordings ??= {});

function enabled(): boolean {
  return process.env.TELEPHONY_PROVIDER === "skycrm" && !!process.env.SKYCRM_SECRET;
}

/** Start the background sweep once per process (single Railway replica — see CLAUDE.md). */
export function startRecordingImports(): void {
  if (state.timer || typeof setInterval === "undefined") return;
  const tick = () => {
    if (!enabled()) return;
    void importRecordings().catch((err) => console.warn("[recordings] sweep failed:", err));
  };
  setTimeout(tick, 60_000);
  state.timer = setInterval(tick, SWEEP_EVERY_MS);
  state.timer.unref?.();
}

async function ensureBucket(): Promise<void> {
  const storage = getSupabaseAdmin().storage;
  const { data } = await storage.getBucket(CALL_RECORDINGS_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(CALL_RECORDINGS_BUCKET, {
    public: false,
    fileSizeLimit: "100MB",
  });
  if (error && !/already exists/i.test(error.message)) throw error;
}

async function cdrIndex(rows: TodoRow[]): Promise<Map<string, SkyCrmCdrRow>> {
  const times = rows.map((r) => new Date(r.started_at).getTime());
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times) + 24 * 3600_000); // a call can end after midnight
  const extension = rows.find((r) => r.agent_handle)?.agent_handle ?? "8601";
  const map = new Map<string, SkyCrmCdrRow>();
  for (const process of ["Outbound", "Inbound"] as const) {
    const list = await fetchCdrReport({
      extension,
      startDate: skycrmIstDate(from),
      endDate: skycrmIstDate(to),
      process,
    });
    for (const row of list) if (row.callid) map.set(String(row.callid), row);
  }
  return map;
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
        "id, client_id, provider_call_id, vendor_callid, agent_handle, started_at, ended_at, recording_attempts, recording_checked_at",
      )
      .eq("provider", "skycrm")
      .is("recording_status", null)
      .not("vendor_callid", "is", null)
      .not("ended_at", "is", null)
      .lt("ended_at", new Date(now - 2 * 60_000).toISOString())
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
        // SkyCRM writes the CDR at hangup; a day later with none, there is nothing to fetch.
        const old = now - new Date(row.ended_at).getTime() > 24 * 3600_000;
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
          (result.vendorDown ? `, SkyCRM download failing: ${result.vendorDown.slice(0, 120)}` : ""),
      );
    return result;
  } finally {
    state.running = false;
  }
}
