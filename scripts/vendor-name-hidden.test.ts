// Companies never see the calling vendor's name (user, 2026-11-21: "remove SkyCRM from the client
// side"), like Insights never names ProfileX. Superadmin screens may — that's SamvadX itself.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const VENDOR = /SkyCRM|Skycrm|Intellect Info/;
/** Screens only a superadmin opens. */
const SUPERADMIN_ONLY = [
  /^src\/routes\/superadmin[.\-]/,
  /^src\/components\/superadmin\//,
  /^src\/components\/telephony\/company-telephony-card\.tsx$/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** The file without comments, so code comments may keep naming the vendor. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the calling vendor's name stays off company screens", () => {
  test("no route or component a company user can open names it", () => {
    const leaks = [...files("src/routes"), ...files("src/components")]
      .filter((f) => !SUPERADMIN_ONLY.some((re) => re.test(f)))
      .flatMap((f) =>
        code(readFileSync(f, "utf8"))
          .split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => VENDOR.test(line)),
      )
      .map(({ f, i, line }) => `${f}:${i}: ${line.trim()}`);
    expect(leaks).toEqual([]);
  });

  test("the error shown when mute/hold/transfer fails doesn't name it", () => {
    const src = code(readFileSync("src/lib/telephony-actions.server.ts", "utf8"));
    expect(src).not.toMatch(/new Error\(`SkyCRM/);
  });
});
