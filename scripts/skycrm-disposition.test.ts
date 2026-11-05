import { describe, expect, test } from "bun:test";
import {
  skycrmCallbackDatetime,
  skycrmSubDisposition,
} from "../src/lib/telephony/skycrm-disposition";

describe("SkyCRM disposition_api fields", () => {
  test("callback_datetime uses the spec's format", () => {
    expect(skycrmCallbackDatetime("2026-11-06", "15:30")).toBe("2026-11-06 15:30:00.000000");
    expect(skycrmCallbackDatetime("2026-11-06", "9:05:07")).toBe("2026-11-06 09:05:07.000000");
    expect(skycrmCallbackDatetime("2026-11-06", "")).toBe("2026-11-06 00:00:00.000000");
    expect(skycrmCallbackDatetime("", "15:30")).toBeUndefined();
    expect(skycrmCallbackDatetime("06/11/2026")).toBeUndefined();
  });
  test("sub_disposition is the readable outcome plus the reason", () => {
    expect(skycrmSubDisposition("no_answer", "Switched off")).toBe("No Answer — Switched off");
    expect(skycrmSubDisposition("promised")).toBe("Promise to Pay");
    expect(skycrmSubDisposition("callback", "Callback")).toBe("Callback");
  });
});
