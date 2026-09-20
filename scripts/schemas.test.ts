import { test, expect } from "bun:test";
import {
  tokenSchema,
  idSchema,
  grantableRoleSchema,
  amountSchema,
  limitSchema,
  isoDateSchema,
  shortText,
} from "../src/lib/schemas";

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

test("schemas: an admin can never grant superadmin through a server function", () => {
  expect(ok(grantableRoleSchema, "agent")).toBe(true);
  expect(ok(grantableRoleSchema, "manager")).toBe(true);
  expect(ok(grantableRoleSchema, "admin")).toBe(true);
  expect(ok(grantableRoleSchema, "superadmin")).toBe(false);
  expect(ok(grantableRoleSchema, "ADMIN")).toBe(false);
});

test("schemas: money must be a real positive number", () => {
  expect(ok(amountSchema, 500)).toBe(true);
  for (const bad of [0, -1, NaN, Infinity, "500", null, undefined, 1e12]) {
    expect([bad, ok(amountSchema, bad)]).toEqual([bad, false]);
  }
});

test("schemas: ids must be uuids, tokens must look like JWTs, text is bounded", () => {
  expect(ok(idSchema, "3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  for (const bad of ["", "1; drop table agents", "../../etc/passwd", 42, {}]) {
    expect([bad, ok(idSchema, bad)]).toEqual([bad, false]);
  }
  expect(ok(tokenSchema, "x".repeat(20))).toBe(true);
  expect(ok(tokenSchema, "short")).toBe(false);
  expect(ok(tokenSchema, "x".repeat(100_000))).toBe(false);
  expect(ok(shortText(10), "")).toBe(false);
  expect(ok(shortText(10), "x".repeat(11))).toBe(false);
});

test("schemas: paging and dates are bounded", () => {
  expect(ok(limitSchema, 100)).toBe(true);
  for (const bad of [0, -5, 1.5, 100_000, "10"]) {
    expect([bad, ok(limitSchema, bad)]).toEqual([bad, false]);
  }
  expect(ok(isoDateSchema, "2026-09-19T00:00:00Z")).toBe(true);
  expect(ok(isoDateSchema, "not a date")).toBe(false);
});
