import { describe, expect, test } from "bun:test";
import {
  canAssign,
  canEditLead,
  canSeeLead,
  followUpState,
  mapImportHeaders,
  parseImportRows,
  parseWebsiteLead,
  phoneKey,
  pipelineSummary,
  type SalesCaller,
} from "../src/lib/sales/sales-rules";

const boss: SalesCaller = { kind: "superadmin" };
const asha: SalesCaller = { kind: "sales", salesUserId: "asha" };

describe("who sees a lead", () => {
  test("a salesperson sees their own and the unassigned pool, not a colleague's", () => {
    expect(canSeeLead(asha, { owner_id: "asha" })).toBe(true);
    expect(canSeeLead(asha, { owner_id: null })).toBe(true);
    expect(canSeeLead(asha, { owner_id: "ravi" })).toBe(false);
    expect(canSeeLead(boss, { owner_id: "ravi" })).toBe(true);
  });
  test("only the owner (or a superadmin) edits; the pool is claim-only", () => {
    expect(canEditLead(asha, { owner_id: "asha" })).toBe(true);
    expect(canEditLead(asha, { owner_id: null })).toBe(false);
    expect(canEditLead(boss, { owner_id: null })).toBe(true);
  });
  test("assigning", () => {
    expect(canAssign(asha, { owner_id: null }, "asha")).toBe(true);
    expect(canAssign(asha, { owner_id: null }, "ravi")).toBe(false);
    expect(canAssign(asha, { owner_id: "asha" }, null)).toBe(true);
    expect(canAssign(asha, { owner_id: "asha" }, "ravi")).toBe(false);
    expect(canAssign(asha, { owner_id: "ravi" }, "asha")).toBe(false);
    expect(canAssign(boss, { owner_id: "ravi" }, "asha")).toBe(true);
  });
});

describe("phones", () => {
  test("last 10 digits, whatever the formatting", () => {
    expect(phoneKey("+91 98200 12345")).toBe("9820012345");
    expect(phoneKey("09820012345")).toBe("9820012345");
    expect(phoneKey("98200-12345")).toBe("9820012345");
    expect(phoneKey("12345")).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe("follow-ups", () => {
  test("against today's IST key", () => {
    expect(followUpState(null, "2026-11-27")).toBe("none");
    expect(followUpState("2026-11-26", "2026-11-27")).toBe("overdue");
    expect(followUpState("2026-11-27", "2026-11-27")).toBe("today");
    expect(followUpState("2026-12-01", "2026-11-27")).toBe("upcoming");
  });
});

describe("website demo form", () => {
  test("a real request", () => {
    const r = parseWebsiteLead({
      name: " Priya Shah ",
      agency: "Sunrise Recoveries",
      phone: "+919820012345",
      agents: "25–100",
      page: "/",
    });
    expect(r).toEqual({
      ok: true,
      lead: {
        name: "Priya Shah",
        agency: "Sunrise Recoveries",
        phone: "+919820012345",
        agentsBand: "25–100",
        page: "/",
      },
    });
  });
  test("a filled honeypot is spam", () => {
    expect(
      parseWebsiteLead({ name: "Bot", agency: "Bot Co", phone: "9820012345", _honey: "x" }),
    ).toEqual({ ok: false, reason: "spam" });
  });
  test("missing fields or a short number are ignored", () => {
    expect(parseWebsiteLead({ name: "A", agency: "B", phone: "98" }).ok).toBe(false);
    expect(parseWebsiteLead({ agency: "Sunrise", phone: "9820012345" }).ok).toBe(false);
  });
  test("long and control characters are clipped", () => {
    const r = parseWebsiteLead({
      name: "Priya\u0000Shah",
      agency: "x".repeat(500),
      phone: "9820012345",
    });
    expect(r.ok && r.lead.name).toBe("Priya Shah");
    expect(r.ok && r.lead.agency.length).toBe(200);
  });
});

describe("Excel import", () => {
  test("headers are recognised by name; unknown ones go to notes", () => {
    expect(mapImportHeaders(["Timestamp", "Name", "Agency", "Phone", "Agents", "Page"])).toEqual({
      Timestamp: "received_at",
      Name: "contact_name",
      Agency: "company_name",
      Phone: "phone",
      Agents: "agents_band",
      Page: "notes",
    });
  });
  test("the Google Sheet's rows become leads; duplicates and empties are skipped", () => {
    const r = parseImportRows([
      {
        Timestamp: "21/11/2026 14:05:09",
        Name: "Priya",
        Agency: "Sunrise",
        Phone: "9820012345",
        Agents: "Under 25",
        Page: "/",
      },
      { Timestamp: "", Name: "Priya again", Agency: "Sunrise", Phone: "+91 98200 12345" },
      { Name: "", Agency: "", Phone: "9820099999" },
      { Name: "Ravi", Agency: "", Phone: "" },
      { Name: "Meena", Agency: "Kuber Collections", Phone: "", Email: "meena@example.com" },
    ]);
    expect(r.leads.length).toBe(2);
    expect(r.leads[0]).toMatchObject({
      company_name: "Sunrise",
      contact_name: "Priya",
      phone: "9820012345",
      agents_band: "Under 25",
      notes: "Page: /",
      received_at: "2026-11-21T08:35:09.000Z",
    });
    expect(r.leads[1].email).toBe("meena@example.com");
    expect(r.skipped).toEqual([
      { row: 2, reason: "Same phone as an earlier row" },
      { row: 3, reason: "No company or name" },
      { row: 4, reason: "No phone or email" },
    ]);
  });
  test("a person with no company keeps their name as the company", () => {
    const r = parseImportRows([{ Name: "Solo Agent", Phone: "9820012345" }]);
    expect(r.leads[0].company_name).toBe("Solo Agent");
  });
});

describe("pipeline", () => {
  test("counts and values per stage; open excludes won and lost", () => {
    const s = pipelineSummary([
      { stage: "new", deal_monthly: null },
      { stage: "proposal", deal_monthly: 50000 },
      { stage: "won", deal_monthly: 80000 },
      { stage: "lost", deal_monthly: 10000 },
      { stage: "bogus", deal_monthly: 5 },
    ]);
    expect(s.byStage.proposal).toEqual({ count: 1, value: 50000 });
    expect(s.byStage.won).toEqual({ count: 1, value: 80000 });
    expect(s.open).toEqual({ count: 2, value: 50000 });
  });
});
