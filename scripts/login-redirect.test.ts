import { describe, expect, test } from "bun:test";
import { afterLoginPath } from "../src/lib/login-redirect";

describe("afterLoginPath", () => {
  test("returns to a page in the role's own section", () => {
    expect(afterLoginPath("/admin/billing?invoice=45a0b315", "/admin")).toBe(
      "/admin/billing?invoice=45a0b315",
    );
    expect(afterLoginPath("/admin", "/admin")).toBe("/admin");
  });
  test("anything else goes to the role's home", () => {
    expect(afterLoginPath(null, "/admin")).toBe("/admin");
    expect(afterLoginPath("/superadmin/invoices", "/admin")).toBe("/admin");
    expect(afterLoginPath("/administrator", "/admin")).toBe("/admin");
    expect(afterLoginPath("//evil.example/admin", "/admin")).toBe("/admin");
    expect(afterLoginPath("https://evil.example/admin", "/admin")).toBe("/admin");
    expect(afterLoginPath("/\\evil.example", "/admin")).toBe("/admin");
  });
});
