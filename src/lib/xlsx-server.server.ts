// Excel files built on the server (scheduled emails), laid out like the browser's downloadXlsx:
// bold frozen header row, columns sized to their content.
import type { XlsxSheet } from "./xlsx-export";

const sheetName = (s: string) => s.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";

export async function xlsxBuffer(sheets: XlsxSheet[]): Promise<Buffer> {
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
  return Buffer.from(await wb.xlsx.writeBuffer());
}
