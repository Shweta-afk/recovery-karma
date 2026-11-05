// SkyCRM user rules (src/lib/telephony/skycrm-users.ts).
import { describe, expect, test } from "bun:test";
import { skycrmPassword, skycrmUserLevel, skycrmUsername } from "../src/lib/telephony/skycrm-users";

describe("skycrm users", () => {
  test("username: the extension when there is one, else first name + 4 id chars", () => {
    expect(skycrmUsername({ id: "3f2a9c00-0000-0000-0000-000000000000", name: "Rahul Sharma", extension: "8601" })).toBe("8601");
    expect(skycrmUsername({ id: "3F2A9c00-0000-0000-0000-000000000000", name: "Rahul Sharma", extension: null })).toBe("rahul3f2a");
    expect(skycrmUsername({ id: "ab12cd34-0000-0000-0000-000000000000", name: "  ", extension: "" })).toBe("userab12");
    expect(skycrmUsername({ id: "ab12cd34-0000-0000-0000-000000000000", name: "Ç@t", extension: "x1" })).toBe("tab12");
  });
  test("roles map to SkyCRM's levels", () => {
    expect(skycrmUserLevel("admin")).toBe("admin");
    expect(skycrmUserLevel("manager")).toBe("manager");
    expect(skycrmUserLevel("agent")).toBe("user");
  });
  test("passwords are random, 20 chars, with a digit and a symbol", () => {
    const a = skycrmPassword();
    expect(a).toHaveLength(20);
    expect(a).toMatch(/\d/);
    expect(a).toMatch(/@/);
    expect(skycrmPassword()).not.toBe(a);
  });
});
