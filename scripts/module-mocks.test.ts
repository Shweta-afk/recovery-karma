// Bun shares a module mock (mock.module) with every test file that runs after the one that made it,
// in whatever order the runner picks. A fake missing one of the real module's exports therefore
// breaks a later file that imports that export, only in some orders: that failed a Railway deploy
// on 2026-11-16 (a fake supabase-admin.server without verifyCaller). Every fake of one of our own
// modules must offer all of that module's runtime exports.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const scriptsDir = new URL(".", import.meta.url).pathname;
const srcDir = new URL("../src/", import.meta.url).pathname;

function resolveSource(spec: string): string | null {
  const rel = spec.startsWith("@/")
    ? spec.slice(2)
    : spec.startsWith("../src/")
      ? spec.slice(7)
      : null;
  if (rel === null) return null;
  for (const ext of ["", ".ts", ".tsx"]) {
    const path = join(srcDir, rel + ext);
    if (existsSync(path) && !path.endsWith("/")) return path;
  }
  return null;
}

function runtimeExports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const m of code.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)/gm,
  ))
    names.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name && !part.trim().startsWith("type ")) names.add(name);
    }
  return [...names];
}

/** The text from `open` (an opening bracket) to its matching close. */
function balanced(code: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

/** Each mock.module call: the module it fakes and the text of its factory. A factory that only
 *  names a variable (`() => fakeModule`) is followed to that variable's definition. */
function mocks(): { file: string; spec: string; body: string }[] {
  const out: { file: string; spec: string; body: string }[] = [];
  for (const name of readdirSync(scriptsDir)) {
    if (!/\.test\.tsx?$/.test(name)) continue;
    const code = readFileSync(join(scriptsDir, name), "utf8");
    for (const m of code.matchAll(/mock\.module\(\s*"([^"]+)"/g)) {
      let body = balanced(code, m.index! + "mock.module".length);
      const named = /=>\s*(\w+)\s*\)$/.exec(body);
      if (named) {
        const def = new RegExp(`(?:const|let|var)\\s+${named[1]}\\b[^=]*=\\s*`).exec(code);
        if (def) body = balanced(code, def.index + def[0].length);
      }
      // `...realModule` where realModule is the imported module itself: complete by construction.
      const spread = /\.\.\.\s*(\w+)/.exec(body);
      const whole = !!spread && new RegExp(`\\b${spread[1]}\\s*=\\s*await\\s+import\\(`).test(code);
      out.push({ file: name, spec: m[1], body: whole ? "*" : body });
    }
  }
  return out;
}

describe("module mocks", () => {
  test("the scan finds the known fakes", () => {
    expect(mocks().some((m) => m.spec === "@/lib/supabase-admin.server")).toBe(true);
  });

  test("every fake of one of our modules offers all of that module's exports", () => {
    const missing: string[] = [];
    for (const m of mocks()) {
      const real = resolveSource(m.spec);
      if (!real) continue;
      if (m.body === "*") continue;
      for (const name of runtimeExports(real)) {
        if (!new RegExp(`\\b${name}\\b`).test(m.body))
          missing.push(`${m.file}: ${m.spec} lacks ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
