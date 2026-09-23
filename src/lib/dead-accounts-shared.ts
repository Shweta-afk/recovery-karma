// Pure rules for archiving "dead" accounts — no Supabase, no Excel writer — so the selection
// rules and the sheet contents are unit-tested (scripts/dead-accounts.test.ts) independently of
// the server job that applies them (dead-account-archive.server.ts).
//
// A dead account: its portfolio has been CLOSED for at least DEAD_AFTER_DAYS, and nothing is
// still open on it — no recent promise-to-pay/callback, no retention request in flight. The job
// saves a slim Excel file (who, phone, every call and its feedback, every Insights result) to
// storage, then STRIPS the row (bank-file `extra` columns and email cleared, archived_at set)
// rather than deleting it: call_logs/payments/disputes/settlements all reference debtors with no
// cascade, and Reports' past months read payments — deleting would either fail or rewrite
// history. Chosen by the user on 2026-09-23: 60 days, strip not delete.
import { OUTCOME_META, type CallOutcome } from "./call-queue/types";
import { istDayKey } from "./monthly-trend";
import { getService } from "./profilex/catalogue";
import { flatten } from "./profilex/flatten";

export const DEAD_AFTER_DAYS = 60;

/** Retention statuses that still mean "this account may come back" — anything else
 * (rejected, carried, not_honored) is settled. From migrations/20260813_retention_requests.sql. */
export const OPEN_RETENTION_STATUSES = ["pending_manager", "approved", "sent_to_bank"] as const;

/** 'YYYY-MM-DD' (IST) `days` before `dayKey`. Calendar arithmetic on the key itself, never via
 * toISOString — see the "every day boundary is midnight IST" note in CLAUDE.md. */
export function istDayKeyMinus(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - days * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Was this portfolio closed long enough ago for its accounts to count as dead? */
export function isPastDeadCutoff(closedAt: string | null | undefined, todayKey: string): boolean {
  if (!closedAt) return false;
  const closedKey = istDayKey(closedAt);
  if (!closedKey) return false;
  return closedKey <= istDayKeyMinus(todayKey, DEAD_AFTER_DAYS);
}

export interface CallLogLite {
  id: string;
  debtor_id: string | null;
  agent_id: string | null;
  outcome: string | null;
  outcome_reason?: string | null;
  raw_notes?: string | null;
  ai_notes?: string | null;
  promise_amount?: number | string | null;
  promise_date?: string | null;
  callback_date?: string | null;
  callback_time?: string | null;
  duration_seconds?: number | null;
  dial_mode?: string | null;
  call_type?: string | null;
  sentiment?: string | null;
  recording_url?: string | null;
  created_at: string;
}

/**
 * A commitment still worth honouring: the LATEST disposition on the account is a PTP or a
 * callback whose due date falls within the dead-account window (or is still ahead). "Latest"
 * matches how escalations decide a case is open (see getCaseFollowups in disposition-store).
 * An ancient PTP on a long-closed portfolio does not keep the account alive forever.
 */
export function hasOpenCommitment(logsNewestFirst: CallLogLite[], todayKey: string): boolean {
  const latest = logsNewestFirst[0];
  if (!latest || (latest.outcome !== "promised" && latest.outcome !== "callback")) return false;
  const due = latest.outcome === "promised" ? latest.promise_date : latest.callback_date;
  if (!due) return true; // a commitment with no date is treated as open — fail safe, keep it
  return due.slice(0, 10) >= istDayKeyMinus(todayKey, DEAD_AFTER_DAYS);
}

export type SkipReason = "open_commitment" | "open_retention";

/** Splits a closed portfolio's not-yet-archived debtors into archivable and kept-alive. */
export function pickDeadDebtors(
  debtorIds: string[],
  logsByDebtor: Map<string, CallLogLite[]>,
  openRetentionDebtorIds: Set<string>,
  todayKey: string,
): { archive: string[]; skipped: { id: string; reason: SkipReason }[] } {
  const archive: string[] = [];
  const skipped: { id: string; reason: SkipReason }[] = [];
  for (const id of debtorIds) {
    if (openRetentionDebtorIds.has(id)) skipped.push({ id, reason: "open_retention" });
    else if (hasOpenCommitment(logsByDebtor.get(id) ?? [], todayKey))
      skipped.push({ id, reason: "open_commitment" });
    else archive.push(id);
  }
  return { archive, skipped };
}

// ── Sheet contents ────────────────────────────────────────────────────────────

export interface DebtorLite {
  id: string;
  name: string | null;
  phone_primary: string | null;
  alt_phones: string[] | null;
  loan_reference: string | null;
}

export interface TraceLite {
  id: string;
  debtor_id: string;
  service_id: string;
  provider_status: string | null;
  cost: number | string | null;
  response: unknown;
  created_at: string;
}

type Cell = string | number | null;
export interface SheetData {
  name: string;
  columns: string[];
  rows: Cell[][];
}

const IST_DATETIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** '2026-09-23 14:05' in IST. */
export function istDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return IST_DATETIME.format(d).replace(",", "");
}

/** Excel rejects a cell over 32,767 characters and would corrupt the whole file. */
const CELL_LIMIT = 32_000;
function clip(s: string): string {
  return s.length > CELL_LIMIT ? `${s.slice(0, CELL_LIMIT)}…[truncated]` : s;
}

function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "";
  return OUTCOME_META[outcome as CallOutcome]?.label ?? outcome;
}

function traceStatusLabel(status: string | null): string {
  if (status === "1") return "Found";
  if (status === "2" || status === "3") return "Not found";
  return status ?? "";
}

/**
 * The three sheets of one dead-account file. Deliberately slim — the user asked for phone,
 * feedback, call log, disposition and Insights only; name and loan ID are added so a borrower
 * the bank sends back later can be matched to their history, which a phone number alone can't
 * reliably do. Nothing else from the bank file goes in.
 */
export function buildDeadAccountSheets(
  debtors: DebtorLite[],
  logsByDebtor: Map<string, CallLogLite[]>,
  tracesByDebtor: Map<string, TraceLite[]>,
  agentNameById: Map<string, string>,
): SheetData[] {
  const accounts: SheetData = {
    name: "Accounts",
    columns: [
      "Name",
      "Loan ID",
      "Phone",
      "Alternate phones",
      "Last disposition",
      "Last contacted (IST)",
      "Calls logged",
      "Insights lookups",
    ],
    rows: [],
  };
  const calls: SheetData = {
    name: "Calls & feedback",
    columns: [
      "Name",
      "Loan ID",
      "Phone",
      "Date (IST)",
      "Agent",
      "Disposition",
      "Reason",
      "Feedback / notes",
      "AI notes",
      "Promise amount",
      "Promise date",
      "Callback",
      "Duration (s)",
      "Sentiment",
      "Recording",
    ],
    rows: [],
  };
  const insights: SheetData = {
    name: "Insights",
    columns: ["Name", "Loan ID", "Phone", "Lookup", "Result", "Date (IST)", "Cost (₹)", "Details"],
    rows: [],
  };

  for (const d of debtors) {
    const who: Cell[] = [d.name ?? "", d.loan_reference ?? "", d.phone_primary ?? ""];
    const logs = logsByDebtor.get(d.id) ?? []; // newest first
    const traces = tracesByDebtor.get(d.id) ?? [];

    accounts.rows.push([
      ...who,
      (d.alt_phones ?? []).join(", "),
      outcomeLabel(logs[0]?.outcome),
      istDateTime(logs[0]?.created_at),
      logs.length,
      traces.length,
    ]);

    for (const l of logs) {
      calls.rows.push([
        ...who,
        istDateTime(l.created_at),
        (l.agent_id && agentNameById.get(l.agent_id)) || "",
        outcomeLabel(l.outcome),
        l.outcome_reason ?? "",
        clip(l.raw_notes ?? ""),
        clip(l.ai_notes ?? ""),
        l.promise_amount != null && l.promise_amount !== "" ? Number(l.promise_amount) : null,
        l.promise_date ?? "",
        [l.callback_date, l.callback_time].filter(Boolean).join(" "),
        l.duration_seconds ?? null,
        l.sentiment ?? "",
        l.recording_url ?? "",
      ]);
    }

    for (const t of traces) {
      const data = (t.response as { data?: unknown } | null)?.data ?? t.response;
      const details = flatten(data)
        .map((leaf) => `${leaf.label}: ${leaf.value}`)
        .join("\n");
      insights.rows.push([
        ...who,
        getService(t.service_id)?.label ?? t.service_id,
        traceStatusLabel(t.provider_status),
        istDateTime(t.created_at),
        t.cost != null ? Number(t.cost) : null,
        clip(details),
      ]);
    }
  }

  return [accounts, calls, insights];
}

/** Storage path for one file. Company first — the one folder level an admin download is
 * checked against — then portfolio, so every archive of a portfolio sits together. */
export function deadAccountFilePath(
  clientId: string,
  portfolioId: string,
  portfolioName: string,
  dayKey: string,
  count: number,
): string {
  const safeName =
    portfolioName
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "portfolio";
  return `${clientId}/${portfolioId}/${dayKey}_${safeName}_${count}-accounts.xlsx`;
}
