// CSV export helper for the call queue, extracted from dashboard.call-queue.tsx.
export function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  // Prefix values starting with =+-@ with a tab to prevent Excel formula injection
  const sanitize = (v: string | number) => {
    const s = String(v);
    return /^[=+\-@]/.test(s) ? `\t${s}` : s;
  };
  const escape = (v: string | number) => `"${sanitize(v).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
