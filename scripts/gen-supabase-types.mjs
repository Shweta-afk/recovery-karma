/**
 * Generates src/lib/database.types.ts from the live database's PostgREST schema.
 *
 * Why not `supabase gen types typescript`: that needs either a personal access token or the
 * database password. PostgREST already publishes an OpenAPI document describing every table,
 * column, type, default and foreign key, and the service-role key we already hold can read it.
 * Same information, no extra credential.
 *
 *   bun run gen:types
 *
 * Re-run after any migration that changes a table. The generated file is committed so CI and
 * a fresh clone typecheck without needing database access.
 *
 * Nullability comes from OpenAPI `required`, which PostgREST populates with exactly the NOT
 * NULL columns. A column with a DEFAULT is still optional on Insert, which is why Insert and
 * Row differ.
 */
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      ];
    }),
);

const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) {
  console.error(`Schema fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const spec = await res.json();

/** PostgREST `format` -> TypeScript. Unknown formats fall back to string rather than any, so a
 *  new column type shows up as a compile error to fix rather than silently disabling checks. */
function tsType(prop) {
  const f = (prop.format || "").toLowerCase();
  if (f === "boolean") return "boolean";
  if (/^(int|smallint|bigint|numeric|double|real|money)/.test(f)) return "number";
  if (f === "json" || f === "jsonb") return "Json";
  if (prop.type === "array") return `${tsType(prop.items ?? {})}[]`;
  if (prop.type === "integer" || prop.type === "number") return "number";
  return "string";
}

const tables = Object.entries(spec.definitions ?? {}).sort(([a], [b]) => a.localeCompare(b));

const body = tables
  .map(([table, def]) => {
    const required = new Set(def.required ?? []);
    const props = Object.entries(def.properties ?? {});

    const row = props
      .map(([col, p]) => `          ${col}: ${tsType(p)}${required.has(col) ? "" : " | null"};`)
      .join("\n");
    const insert = props
      .map(([col, p]) => {
        // PostgREST does not report DEFAULTs for array columns, so a NOT NULL array with a
        // default (debtors.alt_phones is `TEXT[] NOT NULL DEFAULT '{}'`) looks mandatory here
        // when it is not. Treating arrays as optional avoids forcing every insert in the app
        // to pass a value the database already fills in.
        const optional = !required.has(col) || p.default !== undefined || p.type === "array";
        return `          ${col}${optional ? "?" : ""}: ${tsType(p)}${required.has(col) ? "" : " | null"};`;
      })
      .join("\n");
    const update = props
      .map(([col, p]) => `          ${col}?: ${tsType(p)}${required.has(col) ? "" : " | null"};`)
      .join("\n");

    return `      ${table}: {
        Row: {
${row}
        };
        Insert: {
${insert}
        };
        Update: {
${update}
        };
        Relationships: [];
      };`;
  })
  .join("\n");

const out = `// GENERATED FILE — do not edit by hand.
//
// Produced by \`bun run gen:types\` from the live database's PostgREST schema.
// Re-run it after any migration that adds or changes a column, and commit the result.
//
// Generated from ${tables.length} tables.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
${body}
    };
    Views: { [view: string]: { Row: Record<string, unknown>; Relationships: [] } };
    Functions: { [fn: string]: { Args: Record<string, unknown>; Returns: unknown } };
    Enums: { [name: string]: string };
    CompositeTypes: { [name: string]: Record<string, unknown> };
  };
}
`;

writeFileSync("src/lib/database.types.ts", out);
console.log(`Wrote src/lib/database.types.ts — ${tables.length} tables`);
