import { describe, expect, test } from "bun:test";
import {
  channelHeadroom,
  heldChannels,
  shareError,
  trunkError,
  type CompanyShare,
  type TrunkSettings,
} from "../src/lib/telephony/channel-plan";
import {
  didHealth,
  isAssignable,
  istDayStart,
  normaliseDid,
  parseDidList,
  pickDid,
  type DidRow,
} from "../src/lib/telephony/did-rules";
import { groupMissedCalls } from "../src/lib/telephony/missed-calls";

const trunk: TrunkSettings = { totalChannels: 60, inboundReserve: 8 };
const co = (
  clientId: string,
  reserved: number,
  max: number,
  activeOutbound: number,
  enabled = true,
): CompanyShare => ({
  clientId,
  reserved,
  max,
  activeOutbound,
  enabled,
});

describe("channel headroom", () => {
  test("an idle platform: a company may use up to its ceiling", () => {
    const companies = [co("a", 10, 20, 0), co("b", 10, 20, 0)];
    expect(channelHeadroom({ trunk, companies, inboundActive: 0, clientId: "a" })).toBe(20);
  });

  test("its guarantee is always there even when others have taken the shared pool", () => {
    // held = 8 inbound + a:max(0,10) + b:max(42,10) = 60 → shared pool empty
    const companies = [co("a", 10, 20, 0), co("b", 10, 50, 42)];
    expect(heldChannels(trunk, companies, 0)).toBe(60);
    expect(channelHeadroom({ trunk, companies, inboundActive: 0, clientId: "a" })).toBe(10);
    expect(channelHeadroom({ trunk, companies, inboundActive: 0, clientId: "b" })).toBe(0);
  });

  test("above its guarantee a company only borrows what is free", () => {
    // held = 8 + a:12 + b:10 = 30 → 30 shared free; a's ceiling leaves 8
    const companies = [co("a", 10, 20, 12), co("b", 10, 20, 3)];
    expect(channelHeadroom({ trunk, companies, inboundActive: 0, clientId: "a" })).toBe(8);
  });

  test("inbound beyond its reserve eats the shared pool, not guarantees", () => {
    const companies = [co("a", 20, 40, 20), co("b", 20, 40, 0)];
    // held = max(15,8)=15 + 20 + 20 = 55 → 5 shared
    expect(channelHeadroom({ trunk, companies, inboundActive: 15, clientId: "a" })).toBe(5);
    expect(channelHeadroom({ trunk, companies, inboundActive: 15, clientId: "b" })).toBe(25);
  });

  test("a full trunk refuses everyone", () => {
    const companies = [co("a", 0, 60, 52)];
    expect(channelHeadroom({ trunk, companies, inboundActive: 8, clientId: "a" })).toBe(0);
  });

  test("a disabled company's guarantee is not held", () => {
    const companies = [co("a", 0, 52, 0), co("b", 30, 30, 0, false)];
    expect(channelHeadroom({ trunk, companies, inboundActive: 0, clientId: "a" })).toBe(52);
  });

  test("no settings row (simulator) falls back to the trunk", () => {
    expect(channelHeadroom({ trunk, companies: [], inboundActive: 0, clientId: "x" })).toBe(52);
  });
});

describe("share validation", () => {
  test("guarantee above ceiling", () => {
    expect(shareError({ trunk, reserved: 10, max: 5, othersReserved: 0 })).toContain("Guaranteed");
  });
  test("ceiling above the outbound part of the trunk", () => {
    expect(shareError({ trunk, reserved: 0, max: 53, othersReserved: 0 })).toContain("52");
  });
  test("guarantees can't add up past the trunk", () => {
    expect(shareError({ trunk, reserved: 10, max: 20, othersReserved: 45 })).toContain("Only 7");
    expect(shareError({ trunk, reserved: 7, max: 20, othersReserved: 45 })).toBeNull();
  });
  test("trunk can't shrink below what is guaranteed", () => {
    expect(trunkError({ totalChannels: 40, inboundReserve: 8 }, 40)).not.toBeNull();
    expect(trunkError({ totalChannels: 60, inboundReserve: 8 }, 52)).toBeNull();
  });
});

describe("numbers", () => {
  test("normalise: 0/91/+91/spaces collapse to the last 10 digits", () => {
    expect(normaliseDid("07971367665")).toBe("7971367665");
    expect(normaliseDid("+91 79713 67665")).toBe("7971367665");
    expect(normaliseDid("917971367665")).toBe("7971367665");
    expect(normaliseDid("1600123456")).toBe("1600123456");
    expect(normaliseDid("12345")).toBe("");
  });

  test("pasted lists: duplicates dropped, junk reported", () => {
    const r = parseDidList("07971367665\n+91 79713 67665, 7971367666; abc\n123");
    expect(r.numbers).toEqual(["7971367665", "7971367666"]);
    expect(r.bad).toEqual(["abc", "123"]);
  });

  test("cooling numbers become assignable once the date passes", () => {
    const now = new Date("2026-10-26T06:00:00Z");
    expect(isAssignable({ status: "available", cooling_until: null }, now)).toBe(true);
    expect(isAssignable({ status: "cooling", cooling_until: "2026-11-01T00:00:00Z" }, now)).toBe(
      false,
    );
    expect(isAssignable({ status: "cooling", cooling_until: "2026-10-01T00:00:00Z" }, now)).toBe(
      true,
    );
    expect(isAssignable({ status: "assigned", cooling_until: null }, now)).toBe(false);
    expect(isAssignable({ status: "blocked", cooling_until: null }, now)).toBe(false);
  });

  test("the daily cap resets at midnight IST", () => {
    // 2026-10-26 00:30 IST = 2026-10-25 19:00 UTC
    expect(istDayStart(new Date("2026-10-25T19:00:00Z")).toISOString()).toBe(
      "2026-10-25T18:30:00.000Z",
    );
    expect(istDayStart(new Date("2026-10-25T18:00:00Z")).toISOString()).toBe(
      "2026-10-24T18:30:00.000Z",
    );
  });
});

describe("picking the caller number", () => {
  const now = new Date("2026-10-26T06:00:00Z");
  const did = (id: string, patch: Partial<DidRow> = {}): DidRow => ({
    id,
    number: `90000000${id.padStart(2, "0")}`.slice(-10),
    status: "assigned",
    use: "both",
    client_id: "a",
    portfolio_id: null,
    vendor_queue: null,
    daily_cap: null,
    resting_until: null,
    cooling_until: null,
    ...patch,
  });
  const base = { clientId: "a", usedToday: new Map<string, number>(), defaultDailyCap: 150, now };

  test("a company without numbers uses the vendor default", () => {
    expect(pickDid({ ...base, dids: [did("1", { client_id: "b" })] })).toEqual({
      ok: true,
      did: null,
      reason: "company_has_no_numbers",
    });
  });

  test("never another company's number, never an inbound-only one", () => {
    const r = pickDid({
      ...base,
      dids: [did("1", { client_id: "b" }), did("2", { use: "inbound" }), did("3")],
    });
    expect(r.ok && r.did?.id).toBe("3");
  });

  test("same number as last time for this borrower", () => {
    const usedToday = new Map([
      ["1", 0],
      ["2", 40],
    ]);
    const r = pickDid({ ...base, usedToday, lastDidId: "2", dids: [did("1"), did("2")] });
    expect(r).toMatchObject({ ok: true, reason: "same_as_last_time" });
    expect(r.ok && r.did?.id).toBe("2");
  });

  test("otherwise the least used today", () => {
    const usedToday = new Map([
      ["1", 30],
      ["2", 10],
      ["3", 20],
    ]);
    const r = pickDid({ ...base, usedToday, dids: [did("1"), did("2"), did("3")] });
    expect(r.ok && r.did?.id).toBe("2");
  });

  test("last number at its cap → another one", () => {
    const usedToday = new Map([
      ["1", 0],
      ["2", 5],
    ]);
    const r = pickDid({
      ...base,
      usedToday,
      lastDidId: "2",
      dids: [did("1"), did("2", { daily_cap: 5 })],
    });
    expect(r.ok && r.did?.id).toBe("1");
  });

  test("all at cap, or all resting, refuses", () => {
    const usedToday = new Map([["1", 150]]);
    expect(pickDid({ ...base, usedToday, dids: [did("1")] })).toEqual({
      ok: false,
      reason: "all_numbers_at_cap",
    });
    expect(
      pickDid({ ...base, dids: [did("1", { resting_until: "2026-10-27T00:00:00Z" })] }),
    ).toEqual({
      ok: false,
      reason: "all_numbers_resting",
    });
    expect(
      pickDid({ ...base, dids: [did("1", { resting_until: "2026-10-25T00:00:00Z" })] }).ok,
    ).toBe(true);
  });

  test("a portfolio with its own numbers uses only those; others use the shared ones", () => {
    const dids = [did("1", { portfolio_id: "p1" }), did("2")];
    const r1 = pickDid({ ...base, dids, portfolioId: "p1" });
    const r2 = pickDid({ ...base, dids, portfolioId: "p2" });
    const r3 = pickDid({ ...base, dids });
    expect(r1.ok && r1.did?.id).toBe("1");
    expect(r2.ok && r2.did?.id).toBe("2");
    expect(r3.ok && r3.did?.id).toBe("2");
  });
});

describe("number health", () => {
  test("too few calls to judge", () => {
    expect(didHealth({ calls7d: 10, answered7d: 0, companyRate: 0.3 })).toBe("too_few_calls");
  });
  test("well below the company's pick-up rate → rest it", () => {
    expect(didHealth({ calls7d: 100, answered7d: 10, companyRate: 0.3 })).toBe("rest");
    expect(didHealth({ calls7d: 100, answered7d: 20, companyRate: 0.3 })).toBe("watch");
    expect(didHealth({ calls7d: 100, answered7d: 30, companyRate: 0.3 })).toBe("ok");
  });
});

describe("missed calls", () => {
  const m = (id: string, phone: string, at: string) => ({
    id,
    phone,
    startedAt: at,
    debtorId: null,
    didNumber: "7971367665",
  });

  test("one entry per caller, counting repeats", () => {
    const r = groupMissedCalls(
      [
        m("1", "+919800000001", "2026-10-26T05:00:00Z"),
        m("2", "09800000001", "2026-10-26T06:00:00Z"),
        m("3", "9800000002", "2026-10-26T05:30:00Z"),
      ],
      [],
    );
    expect(r.map((g) => [g.phone, g.count])).toEqual([
      ["+919800000001", 2],
      ["9800000002", 1],
    ]);
    expect(r[0].lastAt).toBe("2026-10-26T06:00:00Z");
  });

  test("called back → gone; called again after that → back", () => {
    const missed = [m("1", "9800000001", "2026-10-26T05:00:00Z")];
    expect(
      groupMissedCalls(missed, [{ phone: "+919800000001", startedAt: "2026-10-26T05:10:00Z" }]),
    ).toEqual([]);
    expect(
      groupMissedCalls(missed, [{ phone: "9800000001", startedAt: "2026-10-26T04:00:00Z" }]),
    ).toHaveLength(1);
    const again = [...missed, m("2", "9800000001", "2026-10-26T07:00:00Z")];
    expect(
      groupMissedCalls(again, [{ phone: "9800000001", startedAt: "2026-10-26T05:10:00Z" }]),
    ).toHaveLength(1);
  });
});
