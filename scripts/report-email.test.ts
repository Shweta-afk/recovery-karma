import { describe, expect, test } from "bun:test";
import {
  attachmentExt,
  parseEmailList,
  reportNameFromFile,
  safeAttachmentName,
} from "../src/lib/report-email";
import { captureNextDownload, deliverOrCapture } from "../src/lib/download-capture";

describe("parseEmailList", () => {
  test("splits on commas, semicolons and lines; dedupes; lower-cases", () => {
    expect(parseEmailList("A@x.com, b@y.in;\n a@X.com  <c@z.co>")).toEqual({
      valid: ["a@x.com", "b@y.in", "c@z.co"],
      invalid: [],
    });
  });
  test("reports bad entries", () => {
    expect(parseEmailList("ok@x.com nope").invalid).toEqual(["nope"]);
  });
});

describe("attachments", () => {
  test("only report file types", () => {
    expect(attachmentExt("a.xlsx")).toBe("xlsx");
    expect(attachmentExt("a.CSV")).toBe("csv");
    expect(attachmentExt("a.exe")).toBeNull();
  });
  test("names can't carry paths or header breaks", () => {
    expect(safeAttachmentName("../x\r\n.csv")).toBe(".._x__.csv");
  });
  test("subject from file name", () => {
    expect(reportNameFromFile("agent-performance.csv")).toBe("Agent performance");
  });
});

describe("download capture", () => {
  test("captures exactly one download, then downloads normally", () => {
    let got = "";
    captureNextDownload((f) => (got = f.filename));
    expect(deliverOrCapture("a.csv", new Blob(["x"]))).toBe(true);
    expect(got).toBe("a.csv");
    expect(deliverOrCapture("b.csv", new Blob(["x"]))).toBe(false);
  });
});
