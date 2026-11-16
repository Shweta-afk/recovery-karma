// What each call-control button sends to SkyCRM (spec §15–20, API_SKY.docx), and how its answer
// is read. Fields and words are SkyCRM's own spelling (call_swaping, user_extension).
import { describe, expect, test } from "bun:test";
import {
  callControlRequest,
  callControlSucceeded,
  mobileTarget,
} from "../src/lib/telephony/call-control";

const out = { agentExtension: "8601", direction: "outbound" as const };
const inb = { agentExtension: "8601", direction: "inbound" as const };

describe("call-control requests", () => {
  test("mute and hold use the short direction and yes/no", () => {
    expect(callControlRequest("mute", out)).toEqual({
      path: "mute_calls",
      body: { extension: "8601", direction: "out", state: "yes" },
    });
    expect(callControlRequest("unmute", inb).body).toEqual({
      extension: "8601",
      direction: "in",
      state: "no",
    });
    expect(callControlRequest("hold", out)).toEqual({
      path: "hold_calls",
      body: { extension: "8601", direction: "out", state: "yes" },
    });
    expect(callControlRequest("resume", out).body.state).toBe("no");
  });

  test("adding a colleague rings their extension; a mobile number goes in to_number", () => {
    expect(callControlRequest("add", { ...out, target: { extension: "8605" } })).toEqual({
      path: "call_transfer",
      body: { user_extension: "8601", extension: "8605", direction: "Outbound" },
    });
    expect(callControlRequest("add", { ...inb, target: { number: "9876543210" } })).toEqual({
      path: "call_transfer",
      body: { user_extension: "8601", to_number: "9876543210", direction: "Inbound" },
    });
    expect(() => callControlRequest("add", out)).toThrow();
  });

  test("merge, swap, cancel and transfer are call_swaping operations", () => {
    const op = (a: Parameters<typeof callControlRequest>[0]) => callControlRequest(a, out);
    expect(op("threeway")).toEqual({
      path: "call_swaping",
      body: { operate: "threeway", direction: "Outbound", extension: "8601" },
    });
    expect(op("swap").body.operate).toBe("swap");
    expect(op("cancel_add").body.operate).toBe("Abort");
    expect(op("complete_transfer").body.operate).toBe("complete");
  });

  test("removing the added person is conf_hangup", () => {
    expect(callControlRequest("remove_added", out)).toEqual({
      path: "conf_hangup",
      body: { direction: "Outbound", extension: "8601" },
    });
  });
});

describe("reading SkyCRM's answer", () => {
  test("its success answers", () => {
    expect(callControlSucceeded({ status: 200, message: "success" })).toBe(true);
    expect(
      callControlSucceeded({ message: "Operate successfully queued", status: "Success" }),
    ).toBe(true);
    expect(callControlSucceeded({ message: "remove conference member" })).toBe(true);
    expect(
      callControlSucceeded({ message: "Call transfer hangup succesuffly", status: "Success" }),
    ).toBe(true);
  });

  test("its failure answers, even with a 200-looking status", () => {
    expect(callControlSucceeded({ message: "Call Not Transferred" })).toBe(false);
    expect(callControlSucceeded({ message: "Operate unsuccessful" })).toBe(false);
    expect(callControlSucceeded({ status: 300, message: "remove unsucceful" })).toBe(false);
    expect(callControlSucceeded({ status: 200, message: "Call Not Transferred" })).toBe(false);
    expect(callControlSucceeded({})).toBe(false);
  });
});

describe("a typed mobile number", () => {
  test("10 digits, with or without +91 / 0 / spaces", () => {
    expect(mobileTarget("98765 43210")).toBe("9876543210");
    expect(mobileTarget("+91-9876543210")).toBe("9876543210");
    expect(mobileTarget("09876543210")).toBe("9876543210");
  });
  test("not a mobile: landlines, short numbers, extensions", () => {
    expect(mobileTarget("02225551234")).toBeNull();
    expect(mobileTarget("12345")).toBeNull();
    expect(mobileTarget("8601")).toBeNull();
  });
});
