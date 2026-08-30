import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Splits one line of CSV text into cells, honoring double-quoted fields. */
/**
 * Parse a whole CSV document into rows.
 *
 * Use this, not `parseCsvLine`, for any file that becomes debtor data. Splitting the text on
 * newlines first and parsing each line separately — which every import path used to do — breaks
 * on a quoted field that CONTAINS a newline. Bank files carry addresses and notes, so this is
 * not hypothetical: one such field shifts every column from that point on, and the import
 * writes a whole portfolio of misaligned records with no error anywhere.
 *
 * Handles: quoted fields, embedded newlines and commas, `""` as an escaped quote, CRLF, and a
 * UTF-8 BOM (which otherwise glues itself to the first header and stops it matching any alias).
 *
 * Fields are trimmed, matching the previous behaviour the mapping resolver was tuned against.
 */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;

  // A BOM is invisible but not whitespace, so trimming will not remove it.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'; // escaped quote — emit one, consume both
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch; // includes newlines: this is the whole point
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cur.trim());
      cur = "";
    } else if (ch === "\n") {
      row.push(cur.trim());
      cur = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") cur += ch;
  }
  row.push(cur.trim());
  rows.push(row);

  // Blank lines (very common as a trailing newline, or from Excel) carry no record.
  return rows.filter((r) => r.some((c) => c !== ""));
}

export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // `""` inside a quoted field is one literal quote, not two toggles — the old
      // toggle-on-every-quote silently deleted escaped quotes from the value.
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}
