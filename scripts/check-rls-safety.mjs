#!/usr/bin/env node
/**
 * Guard against the RLS recursion that has taken production down twice (2026-08-14, -08-21).
 *
 * Both outages had the same shape: a SQL file re-declared an `auth_*` helper as `LANGUAGE sql`.
 * Postgres INLINES simple single-statement SQL functions, which silently discards SECURITY
 * DEFINER — so the helper's read of `agents` runs as the CALLING role, re-enters agents' RLS,
 * and raises `42P17 infinite recursion detected in policy`. Every table's policy calls these
 * helpers, so the entire app 500s.
 *
 * It kept coming back because migrations apply in FILENAME ORDER and
 * 20260814_scope_remaining_tables sorts AFTER the files that fixed it — so every replay of the
 * directory re-broke production. A fix applied by hand in the SQL Editor survives only until
 * the next deploy.
 *
 * This check fails the build on the two mistakes that cause it. Run: `bun run check:sql`
 *
 * It also enforces table grants (added 2026-09-23). From 2026-10-30 Supabase stops granting
 * Data API access to new public tables automatically: a migration that creates a table without
 * its own GRANT leaves it answering "permission denied" to the whole app. Every table in the
 * live project (checked 2026-09-23) has RLS on, full access for `authenticated` and
 * `service_role`, and NO access for `anon` — new tables must match:
 *   * a migration dated on/after GRANT_RULE_FROM that creates a public table must GRANT it to
 *     `service_role`, and to `authenticated` unless the file marks it
 *     `-- check:sql server-only: <table>` (written only by server code, e.g. like debtor_traces);
 *   * no SQL file may GRANT a table to `anon` or PUBLIC — the Supabase notice's own example
 *     does, and it would let signed-out visitors query the table.
 * Older migrations are exempt from the first rule: their tables already carry grants live.
 * Optional first argument overrides the directory scanned (used to test this script).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "src/supabase";

/** Migrations whose filename sorts on/after this must carry their own table grants. Every file
 * before it was applied while Supabase still granted automatically. */
const GRANT_RULE_FROM = "20260924";

/** Object kinds a GRANT can target that are not tables — never subject to the table rules. */
const NON_TABLE_GRANT =
  /^(FUNCTION|FUNCTIONS|PROCEDURE|ROUTINE|SEQUENCE|SCHEMA|TYPE|DOMAIN|DATABASE|LANGUAGE|LARGE\s+OBJECT|FOREIGN|TABLESPACE|ALL\s+(FUNCTIONS|SEQUENCES|ROUTINES|PROCEDURES))\b/i;

/** `public.foo`, `"foo"`, `foo` -> `foo`; any other schema -> null (not our concern). */
function publicName(raw) {
  const parts = raw
    .trim()
    .split(".")
    .map((x) => x.replace(/"/g, "").toLowerCase());
  if (parts.length === 1) return parts[0];
  return parts[0] === "public" ? parts[1] : null;
}

/** Tables created, and table grants made, by one file's (comment-stripped) SQL. */
function tableStatements(code) {
  const created = new Set();
  const grants = []; // { tables: Set | "ALL", roles: string[] }
  for (const stmt of code.split(";")) {
    const create = stmt.match(
      /^\s*CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i,
    );
    if (create) {
      const name = publicName(create[1]);
      if (name) created.add(name);
    }
    const grant = stmt.match(/^\s*GRANT\s+[\s\S]+?\s+ON\s+([\s\S]+?)\s+TO\s+([\s\S]+)$/i);
    if (!grant) continue;
    const target = grant[1].trim();
    if (NON_TABLE_GRANT.test(target)) continue;
    const roles = grant[2]
      .replace(/WITH\s+GRANT\s+OPTION/i, "")
      .split(",")
      .map((r) => r.trim().replace(/"/g, "").toLowerCase())
      .filter(Boolean);
    if (/^ALL\s+TABLES\s+IN\s+SCHEMA\s+"?public"?$/i.test(target)) {
      grants.push({ tables: "ALL", roles });
      continue;
    }
    const tables = new Set(
      target
        .replace(/^TABLE\s+/i, "")
        .split(",")
        .map(publicName)
        .filter(Boolean),
    );
    grants.push({ tables, roles });
  }
  return { created, grants };
}

/** `auth_*` SECURITY DEFINER helpers MUST be plpgsql — sql-language ones get inlined. */
const SQL_LANG_HELPER = /LANGUAGE\s+sql\s+STABLE\s+SECURITY\s+DEFINER/i;

/** Migrations must not carry their own transaction: runners supply one, and a nested
 *  BEGIN/COMMIT can abort the migration or silently roll its DDL back. */
const NESTED_TX = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im;

/** Debug scaffolding that must never ship inside a migration. */
const DEBUG_CODE = /(SET\s+LOCAL\s+ROLE|_rls_probe|request\.jwt\.claims)/i;

function sqlFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return sqlFiles(p);
    return p.endsWith(".sql") ? [p] : [];
  });
}

/** Strip comments so a rule documented in prose isn't reported as a violation. */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (l.trimStart().startsWith("--") ? "" : l))
    .join("\n");
}

const failures = [];

for (const file of sqlFiles(ROOT)) {
  const raw = readFileSync(file, "utf8");
  const code = stripComments(raw);
  const { created, grants } = tableStatements(code);

  for (const g of grants) {
    const leaked = g.roles.filter((r) => r === "anon" || r === "public");
    if (leaked.length) {
      const what = g.tables === "ALL" ? "ALL TABLES IN SCHEMA public" : [...g.tables].join(", ");
      failures.push(
        `${file}\n    GRANTs ${what} to ${leaked.join(", ")}.\n` +
          `    No table in this project is readable by signed-out visitors; grant to\n` +
          `    authenticated and service_role only (RLS then decides which rows).`,
      );
    }
  }

  if (SQL_LANG_HELPER.test(code)) {
    failures.push(
      `${file}\n    Declares a SECURITY DEFINER helper as LANGUAGE sql.\n` +
        `    Postgres inlines it, discarding SECURITY DEFINER -> 42P17 recursion on agents.\n` +
        `    Fix: LANGUAGE plpgsql (never inlined), with SET search_path and row_security = off.`,
    );
  }

  // Only migrations are executed by a runner; the loose files are pasted by hand.
  const base = file.split("/").pop() ?? "";
  if (file.includes("/migrations/") && base >= GRANT_RULE_FROM) {
    const serverOnly = new Set(
      [...raw.matchAll(/--[ \t]*check:sql[ \t]+server-only:[ \t]*([\w.", \t]+)/gi)].flatMap((m) =>
        m[1].split(",").map(publicName).filter(Boolean),
      ),
    );
    const grantedTo = (table, role) =>
      grants.some((g) => (g.tables === "ALL" || g.tables.has(table)) && g.roles.includes(role));
    for (const table of created) {
      const missing = ["service_role", ...(serverOnly.has(table) ? [] : ["authenticated"])].filter(
        (role) => !grantedTo(table, role),
      );
      if (missing.length) {
        failures.push(
          `${file}\n    Creates public.${table} without GRANTing it to ${missing.join(" and ")}.\n` +
            `    From 2026-10-30 Supabase no longer grants new tables automatically, so the app\n` +
            `    would get "permission denied". Add, in this same file:\n` +
            `      GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO authenticated, service_role;\n` +
            `    (or mark it "-- check:sql server-only: ${table}" and grant service_role only).`,
        );
      }
    }
  }

  if (file.includes("/migrations/")) {
    if (NESTED_TX.test(code)) {
      failures.push(
        `${file}\n    Contains its own BEGIN/COMMIT/ROLLBACK.\n` +
          `    Migration runners supply a transaction; a nested one can abort the migration or\n` +
          `    silently roll back its DDL, so the breaking file applies and this one doesn't.`,
      );
    }
    if (DEBUG_CODE.test(code)) {
      failures.push(
        `${file}\n    Contains debug scaffolding (SET LOCAL ROLE / _rls_probe / jwt.claims).\n` +
          `    Keep verification in scripts/debug/, never in a file a runner will execute.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\n✗ RLS safety check failed (${failures.length} issue(s)):\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  console.error(
    "The helper/transaction rules guard against the 2026-08-14 and 2026-08-21 production\n" +
      "outages (CLAUDE.md -> 'RLS infinite recursion'); the grant rules against Supabase's\n" +
      "2026-10-30 change (CLAUDE.md -> 'Table grants'). Read those before changing this check.\n",
  );
  process.exit(1);
}

console.log(
  "✓ RLS safety check passed — no inlinable auth helpers, no nested transactions, table grants OK.",
);
