// Shared CSV export — sanitizes against Excel formula injection and triggers a download.
// Single source of truth for the pattern previously duplicated in dashboard.call-queue.tsx,
// dashboard.history.tsx, and manager.upload.tsx.

function sanitize(v: string | number): string {
  const s = String(v);
  // Prefix values starting with =+-@ with a tab to prevent Excel formula injection
  return /^[=+\-@]/.test(s) ? `\t${s}` : s;
}

function escapeCell(v: string | number): string {
  return `"${sanitize(v).replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map((r) => r.map(escapeCell).join(",")).join("\n");
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number)[][],
): void {
  const csv = toCsv(headers, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
