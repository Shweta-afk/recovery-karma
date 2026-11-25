// The Insights PDF — pure part. Turns lookups (any service, any shape) into a flat list of
// printable blocks, and works out the watermark and the "downloaded by" stamp. No jsPDF here:
// the renderer (src/lib/insights-pdf-render.ts) only draws what this decides, so the layout
// rules are testable (scripts/insights-pdf.test.ts).
//
// Who gets which PDF (user, 2026-11-25): admins can save any single lookup (borrower Insights
// tab, Admin → Insights typed-in and CIBIL); managers and admins can save ONE file holding every
// lookup ever run on a borrower. Agents get no download. Every page carries a faint diagonal
// SamvadX + company watermark and the name of whoever downloaded it, with the IST time.

import type { ReportSection } from "./report-layout";

export type LookupResult = "found" | "not_found" | "unknown";

/** One lookup as it goes into the PDF. `layout` is buildReportLayout(response) — null when the
 *  provider sent nothing usable (a not-found, usually). */
export interface PdfLookup {
  serviceLabel: string;
  ranAt: string;
  ranBy: string | null;
  result: LookupResult;
  layout: ReportSection | null;
  /** Extra summary lines shown under the lookup's heading (e.g. a CIBIL score). */
  extra?: { label: string; value: string }[];
}

export interface InsightsPdfDoc {
  /** "Insights report — Ravi Kumar" */
  title: string;
  /** Lines under the title: borrower, loan ID… */
  about: { label: string; value: string }[];
  companyName: string;
  downloadedBy: string;
  /** ISO time the server stamped the download. */
  downloadedAt: string;
  lookups: PdfLookup[];
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────

const REPLACEMENTS: Record<string, string> = {
  "₹": "Rs ",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
  "•": "-",
  "·": "-",
};

/** The PDF's built-in fonts only carry Latin-1. Map the common typographic characters to
 *  plain ones and mark anything else (e.g. Devanagari in an address) with "?" rather than let
 *  it print as garbage. */
export function pdfText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (ch === "\t" || ch === "\n") out += " ";
    else if (ch.codePointAt(0)! < 0x20) continue;
    else if (ch.codePointAt(0)! <= 0xff) out += ch;
    else out += "?";
  }
  return out.replace(/\?{2,}/g, "?").trim();
}

const IST = "Asia/Kolkata";

/** "25 Nov 2026, 3:42 pm IST" */
export function istStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d
    .toLocaleTimeString("en-IN", {
      timeZone: IST,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`);
  return `${date}, ${time} IST`;
}

export function resultLabel(r: LookupResult): string {
  return r === "found" ? "Found" : r === "not_found" ? "Not found" : "Result unclear";
}

export function resultOf(providerStatus: string | null): LookupResult {
  if (providerStatus === "1") return "found";
  if (providerStatus === "2" || providerStatus === "3") return "not_found";
  return "unknown";
}

/** "samvadx-insights-ravi-kumar-2026-11-25.pdf" — the date is the IST download day. */
export function pdfFileName(subject: string, downloadedAt: string): string {
  const slug =
    subject
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report";
  const day = new Date(downloadedAt).toLocaleDateString("en-CA", { timeZone: IST });
  return `samvadx-insights-${slug}-${day}.pdf`;
}

/** The trail printed in every page's footer and in each watermark tile. */
export function downloadStamp(doc: Pick<InsightsPdfDoc, "downloadedBy" | "downloadedAt">) {
  return `Downloaded by ${doc.downloadedBy} on ${istStamp(doc.downloadedAt)}`;
}

// ── Blocks ──────────────────────────────────────────────────────────────────────────────────

/** A row table wider than this is printed one record per item instead (label/value per row):
 *  a credit report's loan accounts have 30+ columns, unreadable across an A4 page. */
export const MAX_GRID_COLUMNS = 7;

export type PdfBlock =
  | { kind: "lookup"; title: string; meta: { label: string; value: string }[] }
  | { kind: "heading"; text: string; level: number }
  | { kind: "fields"; rows: [string, string][] }
  | { kind: "grid"; title: string; columns: string[]; rows: string[][] }
  | { kind: "record"; title: string; rows: [string, string][] }
  | { kind: "note"; text: string };

function sectionBlocks(s: ReportSection, level: number, out: PdfBlock[]) {
  if (level > 0) out.push({ kind: "heading", text: pdfText(s.title), level });
  if (s.fields.length) {
    out.push({
      kind: "fields",
      rows: s.fields.map((f) => [pdfText(f.label), pdfText(f.value)]),
    });
  }
  for (const t of s.tables) {
    const title = pdfText(t.title);
    if (t.columns.length <= MAX_GRID_COLUMNS) {
      out.push({
        kind: "grid",
        title: `${title} (${t.rows.length})`,
        columns: ["#", ...t.columns.map(pdfText)],
        rows: t.rows.map((r, i) => [String(i + 1), ...r.map(pdfText)]),
      });
    } else {
      t.rows.forEach((r, i) => {
        const rows = t.columns
          .map((c, j) => [pdfText(c), pdfText(r[j] ?? "")] as [string, string])
          .filter(([, v]) => v !== "");
        if (rows.length) {
          out.push({ kind: "record", title: `${title} - ${i + 1} of ${t.rows.length}`, rows });
        }
      });
    }
  }
  for (const sub of s.sections) sectionBlocks(sub, level + 1, out);
}

/** Everything the PDF prints after its cover lines, in order. */
export function pdfBlocks(doc: InsightsPdfDoc): PdfBlock[] {
  const out: PdfBlock[] = [];
  if (doc.lookups.length === 0) {
    out.push({ kind: "note", text: "No lookups have been run yet." });
    return out;
  }
  doc.lookups.forEach((l, i) => {
    out.push({
      kind: "lookup",
      title: pdfText(doc.lookups.length > 1 ? `${i + 1}. ${l.serviceLabel}` : l.serviceLabel),
      meta: [
        { label: "Run on", value: istStamp(l.ranAt) },
        { label: "Run by", value: pdfText(l.ranBy || "Not recorded") },
        { label: "Result", value: resultLabel(l.result) },
        ...(l.extra ?? []).map((e) => ({ label: pdfText(e.label), value: pdfText(e.value) })),
      ],
    });
    const before = out.length;
    if (l.layout) sectionBlocks(l.layout, 0, out);
    if (out.length === before) {
      out.push({
        kind: "note",
        text:
          l.result === "not_found"
            ? "Nothing was found for this lookup."
            : "The lookup returned no details.",
      });
    }
  });
  return out;
}

// ── Watermark ───────────────────────────────────────────────────────────────────────────────

export interface WatermarkTile {
  x: number;
  y: number;
  /** Big line: alternates "SamvadX" and the company's name, row by row. */
  text: string;
  /** Small line under it: who downloaded it, when. */
  stamp: string;
}

/** Watermark opacity — faint enough to read every table through it. */
export const WATERMARK_OPACITY = 0.07;
/** Degrees, counter-clockwise. */
export const WATERMARK_ANGLE = 30;

/** Tile positions covering the whole page (in the page's own units), staggered every other
 *  row so the diagonal lines don't stack into columns. Starts above/left of the page so a
 *  rotated tile's tail still reaches the corners. */
export function watermarkTiles(
  pageW: number,
  pageH: number,
  companyName: string,
  stamp: string,
  stepX = 220,
  stepY = 150,
): WatermarkTile[] {
  const company = pdfText(companyName) || "SamvadX";
  const tiles: WatermarkTile[] = [];
  let row = 0;
  for (let y = stepY * 0.6; y < pageH + stepY; y += stepY, row++) {
    const offset = row % 2 ? stepX / 2 : 0;
    for (let x = -stepX / 2 + offset; x < pageW + stepX / 2; x += stepX) {
      tiles.push({ x, y, text: row % 2 ? company : "SamvadX", stamp: pdfText(stamp) });
    }
  }
  return tiles;
}
