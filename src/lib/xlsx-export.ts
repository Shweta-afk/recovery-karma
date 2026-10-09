// Browser-side Excel (.xlsx) download for report tables. exceljs is loaded on demand so it
// never lands in a page's initial bundle — same approach as the Insights loan-lookup export.

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

/** Excel sheet names: max 31 chars, none of : \ / ? * [ ] */
const sheetName = (s: string) => s.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";

export async function downloadXlsx(filename: string, sheets: XlsxSheet[]): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sheetName(sh.name));
    ws.addRow(sh.headers);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of sh.rows) ws.addRow(r.map((v) => (v === null || v === undefined ? "" : v)));
    sh.headers.forEach((h, i) => {
      const longest = Math.max(
        h.length,
        ...sh.rows.slice(0, 200).map((r) => String(r[i] ?? "").length),
      );
      ws.getColumn(i + 1).width = Math.min(48, Math.max(10, longest + 2));
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "samvadx-<what>-<from>_to_<to>.xlsx" */
export const reportFilename = (what: string, range?: { from: string; to: string }) =>
  `samvadx-${what}${range?.from || range?.to ? `-${range.from || "start"}_to_${range.to || "today"}` : ""}.xlsx`;
