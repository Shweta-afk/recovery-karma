// Pure rules for SamvadX's own copies of company archives — no Supabase, no Excel writer — so
// which portfolios get a copy, where it is stored and what is in it are unit-tested
// (scripts/saved-archives.test.ts) apart from the job (saved-archives.server.ts). Table and the
// why: migrations/20261029_saved_archive_files.sql.
import { istDayKey } from "./monthly-trend";
import { shapeSheet } from "./archive-shared";
import {
  buildDeadAccountSheets,
  istDateTime,
  istDayKeyMinus,
  safeFileName,
  type CallLogLite,
  type DebtorLite,
  type TraceLite,
} from "./dead-accounts-shared";

export const SAVED_ARCHIVES_BUCKET = "saved-archives";

/**
 * The daily run saves a portfolio that ended within this many IST days. Older endings are left
 * for a superadmin to save by hand (Superadmin → Saved Archives), so switching this on never
 * back-fills every portfolio that ever closed; the window covers a few missed daily runs.
 */
export const AUTO_SAVE_WINDOW_DAYS = 7;

export type SavedArchiveKind = "portfolio_end" | "month";
export type EndedBy = "closed" | "end_date";

export interface PortfolioEndInput {
  id: string;
  name: string;
  closed_at: string | null;
  end_date: string | null;
  deleted_at?: string | null;
}

/**
 * When and how a portfolio ended, or null while it is still running. Closed wins over an end
 * date: closing is the deliberate act. An end date counts once it has PASSED (the portfolio is
 * still worked on its last day — same rule as isPortfolioEnded in portfolio-store).
 */
export function portfolioEnding(
  p: Pick<PortfolioEndInput, "closed_at" | "end_date">,
  todayKey: string,
): { endedOn: string; endedBy: EndedBy } | null {
  if (p.closed_at) {
    const day = istDayKey(p.closed_at);
    return day ? { endedOn: day, endedBy: "closed" } : null;
  }
  const end = p.end_date?.slice(0, 10);
  if (end && end < todayKey) return { endedOn: end, endedBy: "end_date" };
  return null;
}

/** Ledger key for "this ending of this portfolio already has a copy". */
export const endingKey = (portfolioId: string, endedOn: string) => `${portfolioId}|${endedOn}`;

export interface EndedPortfolio extends PortfolioEndInput {
  endedOn: string;
  endedBy: EndedBy;
}

/**
 * Ended portfolios that have no copy for their current ending yet. Deleted portfolios are
 * skipped (their accounts may already be gone). With `windowDays`, only endings that recent —
 * what the daily run uses; without, every ending (the superadmin's "not saved yet" list).
 */
export function endedWithoutCopy<T extends PortfolioEndInput>(
  portfolios: T[],
  saved: Set<string>,
  todayKey: string,
  windowDays?: number,
): (T & { endedOn: string; endedBy: EndedBy })[] {
  const from = windowDays === undefined ? "" : istDayKeyMinus(todayKey, windowDays);
  const out: (T & { endedOn: string; endedBy: EndedBy })[] = [];
  for (const p of portfolios) {
    if (p.deleted_at) continue;
    const ending = portfolioEnding(p, todayKey);
    if (!ending || ending.endedOn < from) continue;
    if (saved.has(endingKey(p.id, ending.endedOn))) continue;
    out.push({ ...p, ...ending });
  }
  return out.sort((a, b) => b.endedOn.localeCompare(a.endedOn));
}

/** Company first, so a download can be checked against the company it belongs to. */
export function portfolioArchivePath(
  clientId: string,
  portfolioId: string,
  portfolioName: string,
  endedOn: string,
): string {
  return `${clientId}/portfolios/${portfolioId}/${endedOn}_${safeFileName(portfolioName)}.xlsx`;
}

export function monthArchivePath(clientId: string, month: string): string {
  return `${clientId}/months/${month}.xlsx`;
}

/** The file name a superadmin's download gets (the stored path's last part is not friendly). */
export function downloadName(row: {
  kind: SavedArchiveKind;
  portfolio_name: string | null;
  ended_on: string | null;
  month: string | null;
  company: string;
}): string {
  const company = safeFileName(row.company);
  return row.kind === "month"
    ? `samvadx-archive-${company}-${row.month}.xlsx`
    : `samvadx-portfolio-${company}-${safeFileName(row.portfolio_name ?? "portfolio")}-ended-${row.ended_on}.xlsx`;
}

// ── Sheet contents ────────────────────────────────────────────────────────────

type Cell = string | number | boolean | null;
export interface ArchiveSheet {
  name: string;
  columns: string[];
  rows: Cell[][];
}

/** A full debtor row as read with `select("*")` — the bank file's columns sit in `extra`. */
export type FullDebtorRow = DebtorLite & Record<string, unknown>;

export interface PortfolioArchiveInput {
  portfolio: Record<string, unknown> & { name: string };
  ending: { endedOn: string; endedBy: EndedBy };
  savedAtIso: string;
  debtors: FullDebtorRow[];
  /** Newest first per debtor (as buildDeadAccountSheets expects). */
  logsByDebtor: Map<string, CallLogLite[]>;
  tracesByDebtor: Map<string, TraceLite[]>;
  payments: Record<string, unknown>[];
  settlements: Record<string, unknown>[];
  disputes: Record<string, unknown>[];
  agentNameById: Map<string, string>;
}

/** Puts the borrower's name and loan ID in front of each row so a sheet reads on its own. */
function withBorrower(
  rows: Record<string, unknown>[],
  byId: Map<string, FullDebtorRow>,
): Record<string, unknown>[] {
  return rows.map((r) => {
    const d = byId.get(String(r.debtor_id ?? ""));
    return { Name: d?.name ?? "", "Loan ID": d?.loan_reference ?? "", ...r };
  });
}

function rawSheet(name: string, rows: Record<string, unknown>[]): ArchiveSheet {
  const { columns, values } = shapeSheet(rows);
  return { name, columns, rows: values };
}

/**
 * Every sheet of one portfolio's end-of-portfolio copy: a summary, every account with every
 * bank-file column (the full row — unlike the slim dead-account file), then calls, Insights,
 * payments, settlements and disputes. Empty sheets are kept, so "no payments" reads as such.
 */
export function buildPortfolioArchiveSheets(input: PortfolioArchiveInput): ArchiveSheet[] {
  const { portfolio: p, ending } = input;
  const byId = new Map(input.debtors.map((d) => [d.id, d]));
  const str = (v: unknown) => (v == null ? "" : String(v));

  const summary: ArchiveSheet = {
    name: "Portfolio",
    columns: ["Field", "Value"],
    rows: [
      ["Portfolio", p.name],
      ["Lender", str(p.lender_name)],
      ["Product", str(p.product_type)],
      ["Uploaded (IST)", istDateTime(str(p.uploaded_at))],
      ["End date", str(p.end_date)],
      ["Closed (IST)", istDateTime(str(p.closed_at))],
      ["Ended on", ending.endedOn],
      ["Ended by", ending.endedBy === "closed" ? "Closed" : "End date passed"],
      ["Accounts", input.debtors.length],
      ["Copy saved by SamvadX (IST)", istDateTime(input.savedAtIso)],
    ],
  };

  const [, calls, insights] = buildDeadAccountSheets(
    input.debtors,
    input.logsByDebtor,
    input.tracesByDebtor,
    input.agentNameById,
  );

  return [
    summary,
    rawSheet("Accounts", input.debtors),
    calls,
    insights,
    rawSheet("Payments", withBorrower(input.payments, byId)),
    rawSheet("Settlements", withBorrower(input.settlements, byId)),
    rawSheet("Disputes", withBorrower(input.disputes, byId)),
  ];
}

/** Rows per sheet, recorded in the ledger so the list can say what a file holds unopened. */
export function sheetCounts(sheets: ArchiveSheet[]): Record<string, number> {
  return Object.fromEntries(sheets.map((s) => [s.name, s.rows.length]));
}
