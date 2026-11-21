// SkyCRM user rules (src/lib/telephony/skycrm-users.ts).
import { describe, expect, test } from "bun:test";
import { skycrmPassword, skycrmUserLevel, skycrmUsername } from "../src/lib/telephony/skycrm-users";

describe("skycrm users", () => {
  test("username: the extension when there is one, else first name + 4 id chars", () => {
    expect(
      skycrmUsername({
        id: "3f2a9c00-0000-0000-0000-000000000000",
        name: "Rahul Sharma",
        extension: "8601",
      }),
    ).toBe("8601");
    expect(
      skycrmUsername({
        id: "3F2A9c00-0000-0000-0000-000000000000",
        name: "Rahul Sharma",
        extension: null,
      }),
    ).toBe("rahul3f2a");
    expect(
      skycrmUsername({ id: "ab12cd34-0000-0000-0000-000000000000", name: "  ", extension: "" }),
    ).toBe("userab12");
    expect(
      skycrmUsername({ id: "ab12cd34-0000-0000-0000-000000000000", name: "Ç@t", extension: "x1" }),
    ).toBe("tab12");
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

describe("a SkyCRM login follows its extension (2026-11-21)", () => {
  test("moves to the new holder, only within the company and only if they have none", async () => {
    const { extensionLoginMoves } = await import("../src/lib/telephony/skycrm-users");
    const logins = [
      { agentId: "gaurav", username: "8604", clientId: "ax" },
      { agentId: "manish", username: "8608", clientId: "ax" },
      { agentId: "rahul", username: "rahul3f2a", clientId: "ax" },
      { agentId: "old", username: "8700", clientId: "ax" },
    ];
    const agents = [
      { id: "gaurav", extension: null, clientId: "ax", isActive: false },
      { id: "richa", extension: "8604", clientId: "ax", isActive: true },
      { id: "nazjri", extension: "8608", clientId: "ax", isActive: true },
      { id: "rahul", extension: "8700", clientId: "ax", isActive: true }, // already has a login
      { id: "x", extension: "8601", clientId: "other", isActive: true },
    ];
    expect(extensionLoginMoves(logins, agents)).toEqual([
      { username: "8604", fromAgentId: "gaurav", toAgentId: "richa" },
      { username: "8608", fromAgentId: "manish", toAgentId: "nazjri" },
    ]);
    // Nothing to move once they're in place.
    const after = [
      { agentId: "richa", username: "8604", clientId: "ax" },
      { agentId: "nazjri", username: "8608", clientId: "ax" },
    ];
    expect(extensionLoginMoves(after, agents)).toEqual([]);
    // Never to another company's agent.
    expect(
      extensionLoginMoves([{ agentId: "a", username: "8601", clientId: "ax" }], agents),
    ).toEqual([]);
  });
});
