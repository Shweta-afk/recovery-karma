// Draws the Insights PDF (a real .pdf file) from the pure model in lib/profilex/insights-pdf.ts.
// jsPDF + its table plugin are loaded on demand, like exceljs in xlsx-export.ts, so neither lands
// in a page's first bundle. Runs in the browser; the same function runs under bun to make the
// sample file (scripts/insights-pdf-sample.ts).
import {
  WATERMARK_ANGLE,
  WATERMARK_OPACITY,
  downloadStamp,
  pdfBlocks,
  pdfFileName,
  pdfText,
  watermarkTiles,
  type InsightsPdfDoc,
} from "./profilex/insights-pdf";

const M = 40; // page margin, pt
const TOP = 68; // content starts below the header (logo + rule)
const BOTTOM = 52; // and stops above the footer
const PRIMARY: [number, number, number] = [37, 99, 235];
const INK: [number, number, number] = [30, 30, 30];
const MUTED: [number, number, number] = [110, 110, 110];

/** The full SamvadX logo — "Samvad" + the X mark (public/logo.png, 500×125), top-left of every
 *  page. PNG bytes; the browser fetches it, the sample script reads the file. */
export const LOGO_PATH = "/logo.png";
const LOGO_RATIO = 500 / 125;

export async function renderInsightsPdf(
  model: InsightsPdfDoc,
  logo?: Uint8Array | null,
): Promise<ArrayBuffer> {
  const { jsPDF } = await import("jspdf");
  const { autoTable } = await import("jspdf-autotable");
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const contentW = W - 2 * M;
  let y = TOP;

  const lastY = () =>
    ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 10;
  const ensure = (space: number) => {
    if (y + space > H - BOTTOM) {
      doc.addPage();
      y = TOP;
    }
  };
  const tableBase = {
    margin: { top: TOP, bottom: BOTTOM, left: M, right: M },
    theme: "grid" as const,
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: 3.5,
      textColor: INK,
      lineColor: [215, 215, 215] as [number, number, number],
      lineWidth: 0.5,
      overflow: "linebreak" as const,
      valign: "top" as const,
    },
    headStyles: { fillColor: [236, 239, 244] as [number, number, number], textColor: INK },
  };
  const kv = (rows: [string, string][], labelWidth = 170) => {
    autoTable(doc, {
      ...tableBase,
      startY: y,
      body: rows,
      columnStyles: {
        0: {
          cellWidth: labelWidth,
          fontStyle: "bold",
          fillColor: [246, 246, 246],
          textColor: [70, 70, 70],
        },
      },
    });
    y = lastY();
  };

  // ── Cover lines ─────────────────────────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(...INK);
  doc.text(pdfText(model.title), M, y + 6);
  y += 22;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(
    pdfText(
      `${model.companyName} - ${model.lookups.length} lookup${model.lookups.length === 1 ? "" : "s"} - ${downloadStamp(model)}`,
    ),
    M,
    y,
  );
  y += 12;
  if (model.about.length)
    kv(
      model.about.map((a) => [pdfText(a.label), pdfText(a.value)]),
      120,
    );

  // ── Body ────────────────────────────────────────────────────────────────────────────────
  for (const b of pdfBlocks(model)) {
    if (b.kind === "lookup") {
      ensure(90);
      y += 6;
      doc.setFillColor(...PRIMARY);
      doc.rect(M, y, contentW, 22, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(255, 255, 255);
      doc.text(b.title, M + 8, y + 15);
      y += 26;
      kv(
        b.meta.map((m) => [m.label, m.value]),
        120,
      );
    } else if (b.kind === "heading") {
      ensure(40);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(b.level <= 1 ? 10 : 9);
      doc.setTextColor(...(b.level <= 1 ? PRIMARY : INK));
      doc.text(b.level <= 1 ? b.text.toUpperCase() : b.text, M, y + 8);
      y += 13;
    } else if (b.kind === "fields") {
      kv(b.rows);
    } else if (b.kind === "record") {
      ensure(40);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text(b.title, M, y + 7);
      y += 11;
      kv(b.rows);
    } else if (b.kind === "grid") {
      ensure(40);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text(b.title, M, y + 7);
      y += 11;
      autoTable(doc, {
        ...tableBase,
        startY: y,
        head: [b.columns],
        body: b.rows,
        columnStyles: { 0: { cellWidth: 22, textColor: MUTED } },
      });
      y = lastY();
    } else {
      ensure(24);
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      doc.text(b.text, M, y + 8);
      y += 18;
    }
  }

  // ── Every page: header, footer, watermark ─────────────────────────────────────────────────
  const stamp = downloadStamp(model);
  const company = pdfText(model.companyName);
  const pages = doc.getNumberOfPages();
  const rad = (WATERMARK_ANGLE * Math.PI) / 180;
  // Space tiles by the longer of the two big lines, so a long company name doesn't run into
  // the next tile.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(30);
  const longest = Math.max(doc.getTextWidth("SamvadX"), doc.getTextWidth(company));
  const tiles = watermarkTiles(W, H, model.companyName, stamp, longest * Math.cos(rad) + 70, 190);
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    // Header: the SamvadX logo (or its name, if the logo couldn't load); company on the right.
    const textX = logo ? M + 18 * LOGO_RATIO + 8 : M + 44;
    if (logo) {
      doc.addImage(logo, "PNG", M, 16, 18 * LOGO_RATIO, 18, "samvadx-logo", "FAST");
    } else {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(...PRIMARY);
      doc.text("SamvadX", M, 31);
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("Insights report", textX, 31);
    doc.text(company, W - M, 31, { align: "right" });
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.6);
    doc.line(M, 42, W - M, 42);
    // Footer
    doc.line(M, H - 34, W - M, H - 34);
    doc.setFontSize(7.5);
    doc.text(pdfText(`${stamp} - Confidential, for ${company} only`), M, H - 22);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 22, { align: "right" });
    // Watermark — faint, diagonal, tiled across the whole page.
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: WATERMARK_OPACITY }));
    doc.setTextColor(20, 20, 20);
    for (const t of tiles) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(30);
      doc.text(t.text, t.x, t.y, { angle: WATERMARK_ANGLE });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.text(t.stamp, t.x + 14 * Math.sin(rad), t.y + 14 * Math.cos(rad), {
        angle: WATERMARK_ANGLE,
      });
    }
    doc.restoreGraphicsState();
  }

  doc.setProperties({
    title: pdfText(model.title),
    subject: "SamvadX Insights report",
    author: pdfText(`${model.downloadedBy} (${company})`),
    creator: "SamvadX",
  });
  return doc.output("arraybuffer");
}

/** Build the PDF and save it on the user's computer. */
export async function downloadInsightsPdf(model: InsightsPdfDoc, subject: string): Promise<void> {
  // A missing logo never stops the download — the page just has the name alone.
  const logo = await fetch(LOGO_PATH)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? new Uint8Array(b) : null))
    .catch(() => null);
  const buf = await renderInsightsPdf(model, logo);
  const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = pdfFileName(subject, model.downloadedAt);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
