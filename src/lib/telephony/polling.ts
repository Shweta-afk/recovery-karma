// Polling job: periodically fetch call records from Tata as a fallback
// if webhooks are missed or delayed.
//
// This runs on a timer: every 30 seconds, queries GET /v1/call/records
// for calls placed in the last 2 minutes, then updates our dialer state.
//
// Server-side only — started once on app boot (see server.ts).

import { getTelephonyProvider } from "./index";
import { ingestCallStatusEvent } from "./server";
import type { CallStatusEvent } from "./types";

// ─── Configuration ────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
const LOOK_BACK_MINUTES = 2; // Fetch calls from last 2 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000; // 5 seconds between retries

// Track which provider call IDs we've already processed to avoid duplicates
const processedCallIds = new Set<string>();

// Keep only recent entries (prevent memory leak on long-running servers)
const MAX_PROCESSED_HISTORY = 1000;

// ─── Tata API Call Records Fetching ───────────────────────────────────────

const TATA_BASE_URL =
  typeof process !== "undefined"
    ? process.env?.TATA_BASE_URL ?? "https://api-smartflo.tatateleservices.com/v1"
    : "https://api-smartflo.tatateleservices.com/v1";

const TATA_ACCESS_TOKEN =
  typeof process !== "undefined" ? process.env?.TATA_ACCESS_TOKEN : undefined;

function getAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TATA_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function fetchTataCallRecords(minutesAgo: number): Promise<unknown> {
  if (!TATA_ACCESS_TOKEN) {
    console.warn("[polling] TATA_ACCESS_TOKEN not set — skipping Tata API call");
    return [];
  }

  const now = new Date();
  const from = new Date(now.getTime() - minutesAgo * 60 * 1000);

  const fromStr = from.toISOString().slice(0, 19).replace("T", " "); // "2026-07-28 14:30:45"
  const toStr = now.toISOString().slice(0, 19).replace("T", " "); // "2026-07-28 14:32:45"

  const url = `${TATA_BASE_URL}/call/records?from_date=${encodeURIComponent(fromStr)}&to_date=${encodeURIComponent(toStr)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tata API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      results?: unknown[];
      data?: unknown[];
    };

    // Tata returns results in either .results or .data
    return data.results ?? data.data ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[polling] Failed to fetch Tata call records: ${msg}`);
    return [];
  }
}

// ─── Convert Tata Call Record to CallStatusEvent ──────────────────────────

function convertTataRecordToEvent(record: unknown): CallStatusEvent | null {
  const r = record as {
    call_id?: string;
    uuid?: string;
    status?: string;
    call_status?: string;
    duration?: number;
    call_duration?: number;
    recording_url?: string;
    recording?: string;
    [key: string]: unknown;
  };

  // Tata uses either call_id or uuid
  const callId = r.call_id ?? r.uuid;
  if (!callId) return null;

  // Status can be in different fields
  const status = r.status ?? r.call_status ?? "";
  if (!status) return null;

  // Duration can be in different fields
  const duration = r.duration ?? r.call_duration;

  // Recording URL may be present
  const recordingUrl = r.recording_url ?? r.recording;

  // Map Tata status to our CallStatus
  const statusMap: Record<string, string> = {
    answered: "connected",
    "answered by customer": "connected",
    completed: "completed",
    missed: "no_answer",
    "no-answer": "no_answer",
    failed: "failed",
  };

  const mappedStatus = statusMap[status] ?? "failed";

  return {
    providerCallId: String(callId),
    status: mappedStatus as "connected" | "no_answer" | "completed" | "failed",
    durationSeconds: typeof duration === "number" ? duration : undefined,
    recordingUrl: recordingUrl ? String(recordingUrl) : undefined,
  };
}

// ─── Main Polling Loop ─────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  try {
    // Only run if we have a Tata token
    if (!TATA_ACCESS_TOKEN) {
      return;
    }

    // Fetch recent call records from Tata
    const records = await fetchTataCallRecords(LOOK_BACK_MINUTES);

    if (!Array.isArray(records)) {
      console.warn("[polling] Unexpected response format from Tata API");
      return;
    }

    let processed = 0;
    let skipped = 0;

    for (const record of records) {
      const event = convertTataRecordToEvent(record);
      if (!event) continue;

      // Skip if we've already processed this call
      if (processedCallIds.has(event.providerCallId)) {
        skipped++;
        continue;
      }

      // Mark as processed
      processedCallIds.add(event.providerCallId);

      // Trim history to prevent memory leak
      if (processedCallIds.size > MAX_PROCESSED_HISTORY) {
        // Clear oldest entries (rough approximation — good enough for a Set)
        const allIds = Array.from(processedCallIds);
        for (let i = 0; i < 100; i++) {
          processedCallIds.delete(allIds[i]);
        }
      }

      // Ingest the event (updates dialer state, persists logs, etc.)
      try {
        await ingestCallStatusEvent(event);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[polling] Failed to ingest event for ${event.providerCallId}: ${msg}`);
      }
    }

    if (processed > 0 || skipped > 0) {
      console.debug(
        `[polling] Fetched ${records.length} records, processed ${processed}, skipped ${skipped}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[polling] Unexpected error: ${msg}`, err);
  }
}

// ─── Start Polling Job ────────────────────────────────────────────────────

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export function startPollingJob(): void {
  if (pollingTimer !== null) {
    console.warn("[polling] Job already started");
    return;
  }

  console.log(
    `[polling] Starting background polling job (interval: ${POLL_INTERVAL_MS}ms, look-back: ${LOOK_BACK_MINUTES} min)`,
  );

  // Run once immediately on startup
  pollOnce().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[polling] Initial poll failed: ${msg}`);
  });

  // Then run periodically
  pollingTimer = setInterval(() => {
    pollOnce().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[polling] Poll cycle failed: ${msg}`);
    });
  }, POLL_INTERVAL_MS);

  // Optional: mark as unref so it doesn't keep the process alive if nothing else is running
  // (comment out if you want polling to keep the server alive)
  if (typeof pollingTimer.unref === "function") {
    pollingTimer.unref();
  }
}

export function stopPollingJob(): void {
  if (pollingTimer === null) return;
  clearInterval(pollingTimer);
  pollingTimer = null;
  console.log("[polling] Background polling job stopped");
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

if (typeof process !== "undefined") {
  // Stop polling on process exit
  process.on("exit", stopPollingJob);
}

// ─── Notes ────────────────────────────────────────────────────────────────
//
// 1. Webhooks are the primary path (fast, <1s latency).
//    Polling is the fallback (30s latency) for when webhooks fail.
//
// 2. Processed call IDs are tracked in memory to avoid duplicate state updates.
//    This is safe because polling and webhooks both call the same
//    ingestProviderWebhook function, which is idempotent.
//
// 3. If Tata API goes down, polling fails gracefully and logs a warning.
//    Webhooks would also fail, so this is not worse than the alternative.
//
// 4. For high-volume scenarios (100+ concurrent calls), consider:
//    - Reducing POLL_INTERVAL_MS to 15s for faster catch-up
//    - Increasing LOOK_BACK_MINUTES to 5 if calls hang longer
//    - Storing processed IDs in Redis instead of memory
//
// 5. Each poll queries Tata, which counts against your API rate limit.
//    At 30-second intervals, that's 120 calls/hour, well within most limits.
