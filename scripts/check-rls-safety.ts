#!/usr/bin/env bun
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
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/supabase";

/** `auth_*` SECURITY DEFINER helpers MUST be plpgsql — sql-language ones get inlined. */
const SQL_LANG_HELPER = /LANGUAGE\s+sql\s+STABLE\s+SECURITY\s+DEFINER/i;

/** Migrations must not carry their own transaction: runners supply one, and a nested
 *  BEGIN/COMMIT can abort the migration or silently roll its DDL back. */
const NESTED_TX = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im;

/** Debug scaffolding that must never ship inside a migration. */
const DEBUG_CODE = /(SET\s+LOCAL\s+ROLE|_rls_probe|request\.jwt\.claims)/i;

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return sqlFiles(p);
    return p.endsWith(".sql") ? [p] : [];
  });
}

/** Strip comments so a rule documented in prose isn't reported as a violation. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (l.trimStart().startsWith("--") ? "" : l))
    .join("\n");
}

const failures: string[] = [];

for (const file of sqlFiles(ROOT)) {
  const code = stripComments(readFileSync(file, "utf8"));

  if (SQL_LANG_HELPER.test(code)) {
    failures.push(
      `${file}\n    Declares a SECURITY DEFINER helper as LANGUAGE sql.\n` +
        `    Postgres inlines it, discarding SECURITY DEFINER -> 42P17 recursion on agents.\n` +
        `    Fix: LANGUAGE plpgsql (never inlined), with SET search_path and row_security = off.`,
    );
  }

  // Only migrations are executed by a runner; the loose files are pasted by hand.
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
    "These exact mistakes caused the 2026-08-14 and 2026-08-21 production outages.\n" +
      "See CLAUDE.md -> 'RLS infinite recursion' before changing anything here.\n",
  );
  process.exit(1);
}

console.log("✓ RLS safety check passed — no inlinable auth helpers, no nested transactions.");
