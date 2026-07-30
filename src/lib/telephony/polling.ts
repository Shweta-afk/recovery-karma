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

/** Timezone the Tata account reports and filters in. */
const TATA_TIMEZONE = "Asia/Kolkata";

/** Format as "YYYY-MM-DD HH:mm:ss" in the account's timezone, which is what Tata expects. */
function toTataStamp(d: Date): string {
  // "sv-SE" renders as "YYYY-MM-DD HH:mm:ss", already the shape Tata wants.
  return d.toLocaleString("sv-SE", { timeZone: TATA_TIMEZONE });
}

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

  // Tata's from_date/to_date are interpreted in the account's local time (IST), and its
  // records come back stamped the same way. Sending UTC silently queries a window 5.5 hours
  // in the past and always returns zero rows.
  const fromStr = toTataStamp(from);
  const toStr = toTataStamp(now);

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
    ref_id?: string;
    call_id?: string;
    uuid?: string;
    custom_identifier?: string;
    status?: string;
    call_status?: string;
    answered_seconds?: number;
    call_duration?: number;
    duration?: number;
    recording_url?: string;
    [key: string]: unknown;
  };

  // ref_id FIRST: click_to_call hands back a ref_id at dial time and that is what we stored
  // as providerCallId. A record's call_id/uuid are different values that would never match.
  const callId = r.ref_id ?? r.call_id ?? r.uuid;
  if (!callId) return null;

  const status = r.status ?? r.call_status ?? "";
  if (!status) return null;

  const duration = r.answered_seconds ?? r.call_duration ?? r.duration;

  const statusMap: Record<string, CallStatusEvent["status"]> = {
    answered: "connected",
    "answered by customer": "connected",
    completed: "completed",
    missed: "no_answer",
    "no-answer": "no_answer",
    failed: "failed",
  };

  return {
    providerCallId: String(callId),
    customIdentifier: r.custom_identifier,
    status: statusMap[status.toLowerCase()] ?? "failed",
    durationSeconds: typeof duration === "number" ? duration : undefined,
    recordingUrl: r.recording_url ? String(r.recording_url) : undefined,
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

    if (records.length > 0) {
      console.debug(
        `[polling] Fetched ${records.length} records from Tata. First record:`,
        JSON.stringify(records[0], null, 2),
      );
    }

    let processed = 0;
    let skipped = 0;

    for (const record of records) {
      const event = convertTataRecordToEvent(record);
      if (!event) {
        console.debug(`[polling] Could not convert record to event:`, JSON.stringify(record, null, 2));
        continue;
      }

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

if (typeof process !== "undefined" && typeof process.on === "function") {
  // Stop polling on process exit (server-side only)
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
