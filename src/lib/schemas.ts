// Runtime validation for server functions. Server functions are public HTTP endpoints, so a
// TypeScript annotation on the input is not a check — `(d: { amount: number }) => d` accepts a
// string, NaN, a negative number or a 10MB object just as happily. These primitives are the shared
// vocabulary; each server function builds its input schema from them.

import { z } from "zod";

/** A Supabase session JWT. Only the shape is checked here — verifyCaller() checks the signature. */
export const tokenSchema = z.string().min(20).max(8192);

/** Every primary key we accept from the browser is a uuid. */
export const idSchema = z.string().uuid();

/** Roles an admin may hand out. "superadmin" is deliberately absent: it lives in its own table. */
export const grantableRoleSchema = z.enum(["agent", "manager", "admin"]);

/** A positive rupee amount for a top-up / allocation. */
export const amountSchema = z.number().finite().positive().max(100_000_000);

export const noteSchema = z.string().max(500);

export const isoDateSchema = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "not a valid date");

export const limitSchema = z.number().int().min(1).max(1000);
export const offsetSchema = z.number().int().min(0).max(1_000_000);

export const shortText = (max = 200) => z.string().trim().min(1).max(max);
export const emailSchema = z.string().trim().min(3).max(254);
export const passwordSchema = z.string().min(1).max(256);

export { z };
