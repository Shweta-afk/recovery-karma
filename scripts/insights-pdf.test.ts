// The Insights PDF's pure rules (src/lib/profilex/insights-pdf.ts): blocks, text clean-up,
// watermark tiling and the downloader stamp. Values are made up.
import { describe, expect, test } from "bun:test";
import { buildReportLayout } from "../src/lib/profilex/report-layout";
import {
  MAX_GRID_COLUMNS,
  WATERMARK_OPACITY,
  downloadStamp,
  istStamp,
  pdfBlocks,
  pdfFileName,
  pdfText,
  resultOf,
  watermarkTiles,
  type InsightsPdfDoc,
} from "../src/lib/profilex/insights-pdf";

const base: Omit<InsightsPdfDoc, "lookups"> = {
  title: "Insights report - Ravi Kumar",
  about: [{ label: "Borrower", value: "Ravi Kumar" }],
  companyName: "Demo Collections Pvt Ltd",
  downloadedBy: "Priya Mehta (Manager)",
  downloadedAt: "2026-11-25T09:44:00Z",
};

const wide = Object.fromEntries(
  Array.from({ length: MAX_GRID_COLUMNS + 3 }, (_, i) => [`col${i + 1}`, `v${i + 1}`]),
);

describe("pdfBlocks", () => {
  test("one lookup heading per lookup, numbered when there are several, with who/when/result", () => {
    const blocks = pdfBlocks({
      ...base,
      lookups: [
        {
          serviceLabel: "Skip Tracing",
          ranAt: "2026-11-20T05:12:00Z",
          ranBy: "Priya Mehta",
          result: "found",
          layout: buildReportLayout({ status: "1", data: { name: "RAVI" } }, "Skip Tracing"),
        },
        {
          serviceLabel: "UPI IDs",
          ranAt: "2026-11-22T10:02:00Z",
          ranBy: null,
          result: "not_found",
          layout: buildReportLayout({ status: "2", message: "No record found" }, "UPI IDs"),
        },
      ],
    });
    const heads = blocks.filter((b) => b.kind === "lookup");
    expect(heads.map((h) => h.kind === "lookup" && h.title)).toEqual([
      "1. Skip Tracing",
      "2. UPI IDs",
    ]);
    const meta = heads[1].kind === "lookup" ? heads[1].meta : [];
    expect(meta).toEqual([
      { label: "Run on", value: "22 Nov 2026, 3:32 pm IST" },
      { label: "Run by", value: "Not recorded" },
      { label: "Result", value: "Not found" },
    ]);
    // A not-found with nothing to show says so instead of leaving a bare heading.
    expect(blocks.at(-1)).toEqual({ kind: "note", text: "Nothing was found for this lookup." });
    expect(blocks).toContainEqual({ kind: "fields", rows: [["Name", "RAVI"]] });
  });

  test("a single lookup is not numbered", () => {
    const blocks = pdfBlocks({
      ...base,
      lookups: [
        {
          serviceLabel: "CIBIL Report",
          ranAt: base.downloadedAt,
          ranBy: "A",
          result: "found",
          layout: null,
        },
      ],
    });
    expect(blocks[0]).toMatchObject({ kind: "lookup", title: "CIBIL Report" });
  });

  test("narrow lists print as a grid; wide ones as one record per item", () => {
    const layout = buildReportLayout(
      {
        Addresses: [
          { address: "Flat 1", city: "Mumbai" },
          { address: "Flat 2", city: "Pune" },
        ],
        Loans: [wide, { ...wide, col2: "" }],
      },
      "Report",
    );
    const blocks = pdfBlocks({
      ...base,
      lookups: [
        { serviceLabel: "X", ranAt: base.downloadedAt, ranBy: "A", result: "found", layout },
      ],
    });
    expect(blocks).toContainEqual({
      kind: "grid",
      title: "Addresses (2)",
      columns: ["#", "Address", "City"],
      rows: [
        ["1", "Flat 1", "Mumbai"],
        ["2", "Flat 2", "Pune"],
      ],
    });
    const records = blocks.filter((b) => b.kind === "record");
    expect(records.map((r) => r.kind === "record" && r.title)).toEqual([
      "Loans - 1 of 2",
      "Loans - 2 of 2",
    ]);
    // Blank cells are left out of a record rather than printed as empty rows.
    const second = records[1].kind === "record" ? records[1].rows : [];
    expect(second.length).toBe(MAX_GRID_COLUMNS + 2);
    expect(second.find(([l]) => l === "Col2")).toBeUndefined();
  });

  test("no lookups → a note, not an empty file", () => {
    expect(pdfBlocks({ ...base, lookups: [] })).toEqual([
      { kind: "note", text: "No lookups have been run yet." },
    ]);
  });
});

describe("text and stamps", () => {
  test("only Latin-1 reaches the PDF fonts", () => {
    expect(pdfText("₹5,000 – paid “today”…")).toBe('Rs 5,000 - paid "today"...');
    expect(pdfText("Flat 4, मुंबई")).toBe("Flat 4, ?");
    expect(pdfText("José\tÁlvarez")).toBe("José Álvarez");
  });

  test("times are IST", () => {
    expect(istStamp("2026-11-24T19:00:00Z")).toBe("25 Nov 2026, 12:30 am IST");
    expect(downloadStamp(base)).toBe(
      "Downloaded by Priya Mehta (Manager) on 25 Nov 2026, 3:14 pm IST",
    );
  });

  test("file name uses the IST day and a clean slug", () => {
    expect(pdfFileName("Ravi Kumar / Sharma", "2026-11-24T19:00:00Z")).toBe(
      "samvadx-insights-ravi-kumar-sharma-2026-11-25.pdf",
    );
    expect(pdfFileName("मुंबई", base.downloadedAt)).toBe("samvadx-insights-report-2026-11-25.pdf");
  });

  test("provider status → result", () => {
    expect(resultOf("1")).toBe("found");
    expect(resultOf("2")).toBe("not_found");
    expect(resultOf("3")).toBe("not_found");
    expect(resultOf(null)).toBe("unknown");
  });
});

describe("watermark", () => {
  const W = 595;
  const H = 842;
  const tiles = watermarkTiles(W, H, "Demo Collections Pvt Ltd", downloadStamp(base));

  test("both names, and the downloader on every tile", () => {
    expect(new Set(tiles.map((t) => t.text))).toEqual(
      new Set(["SamvadX", "Demo Collections Pvt Ltd"]),
    );
    expect(tiles.every((t) => t.stamp.startsWith("Downloaded by Priya Mehta"))).toBe(true);
  });

  test("covers the whole page", () => {
    expect(Math.min(...tiles.map((t) => t.x))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.x))).toBeGreaterThanOrEqual(W - 220);
    expect(Math.min(...tiles.map((t) => t.y))).toBeLessThan(150);
    expect(Math.max(...tiles.map((t) => t.y))).toBeGreaterThanOrEqual(H);
  });

  test("faint", () => {
    expect(WATERMARK_OPACITY).toBeGreaterThan(0);
    expect(WATERMARK_OPACITY).toBeLessThanOrEqual(0.1);
  });

  test("a company with no name still gets a SamvadX mark", () => {
    expect(watermarkTiles(W, H, "", "x").every((t) => t.text === "SamvadX")).toBe(true);
  });
});
