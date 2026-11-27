// Builds marketing screenshots of SamvadX from hand-made mock pages (no real data).
// Each pages/*.html starts with a JSON comment: <!-- {"role":"agent","active":"Call Queue"} -->
// The app shell (sidebar + header) and the app's real colour tokens (src/styles.css) are added here.
// Usage: node build.mjs            -> writes out/*.html
//        node build.mjs --shoot    -> also renders png/<name>-light.png and png/<name>-dark.png
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
const css = fs.readFileSync(path.join(here, "../src/styles.css"), "utf8");
// The app's own tokens: @custom-variant + @theme + :root + .dark, up to @layer base.
const tokens = css.slice(css.indexOf("@custom-variant"), css.indexOf("@layer base"));

const NAV = {
  agent: {
    label: "Agent Workspace",
    items: [
      ["Dashboard", "layout-dashboard"],
      ["Call Queue", "phone-call"],
      ["Activity History", "history"],
      ["Debtors", "users"],
      ["Messages", "message-square"],
      ["Payments", "credit-card"],
      ["Reports", "file-chart-column"],
      ["My Call Reviews", "star"],
    ],
  },
  manager: {
    label: "Manager",
    items: [
      ["Dashboard", "chart-column"],
      ["Call Queue", "phone-call"],
      ["Live Calls", "radio-tower"],
      ["Call History", "history"],
      ["Team Activity", "timer"],
      ["Portfolio Overview", "folder-open"],
      ["Portfolio Upload", "upload"],
      ["Call Audit", "audio-lines"],
      ["Debtors", "users"],
      ["Payments", "credit-card"],
      ["Reports", "file-chart-column"],
      ["Feedback File", "file-spreadsheet"],
      ["Settings", "settings"],
    ],
  },
  admin: {
    label: "Administration",
    items: [
      ["Overview", "layout-dashboard"],
      ["Live Calls", "radio-tower"],
      ["Users", "user-cog"],
      ["Teams", "users"],
      ["Reports", "chart-column"],
      ["Feedback File", "file-spreadsheet"],
      ["Call Auditor", "headphones"],
      ["Insights", "sparkles"],
      ["Archive History", "database-backup"],
      ["Portfolio Assignment", "layers"],
      ["Billing & Agreements", "file-pen-line"],
      ["System Settings", "settings"],
    ],
  },
  auditor: {
    label: "Call Auditor",
    items: [
      ["Overview", "layout-dashboard"],
      ["Audit Queue", "list-checks"],
      ["All Calls", "headphones"],
      ["Teams & Managers", "users"],
      ["Reports", "file-spreadsheet"],
    ],
  },
};

const USERS = {
  agent: { name: "Priya Sharma", email: "priya.s@democollect.in", role: "agent" },
  manager: { name: "Rohan Mehta", email: "rohan.m@democollect.in", role: "manager" },
  admin: { name: "Anita Desai", email: "anita.d@democollect.in", role: "admin" },
  auditor: { name: "Kavya Iyer", email: "kavya.i@democollect.in", role: "auditor" },
};

function sidebar(role, active) {
  const nav = NAV[role];
  const items = nav.items
    .map(
      ([title, icon]) => `
      <li><a class="flex h-8 items-center gap-2 rounded-md px-2 text-sm ${
        title === active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground"
      }"><i data-lucide="${icon}" class="h-4 w-4 shrink-0"></i><span class="truncate">${title}</span></a></li>`,
    )
    .join("");
  return `
  <aside class="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
    <div class="border-b border-sidebar-border px-4 py-4">
      <div class="inline-flex rounded-md px-3 py-1.5 dark:bg-white"><img src="logo.png" alt="SamvadX" class="h-7 w-auto"></div>
    </div>
    <div class="p-2">
      <div class="flex h-8 items-center px-2 text-xs font-medium text-sidebar-foreground/70">${nav.label}</div>
      <ul class="flex flex-col gap-1">${items}</ul>
    </div>
  </aside>`;
}

function header(role, extra = "") {
  const u = USERS[role];
  const initials = u.name.split(" ").map((p) => p[0]).join("");
  return `
  <header class="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-border bg-card px-4">
    <div class="flex items-center gap-2">
      <button class="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground"><i data-lucide="panel-left" class="h-4 w-4"></i></button>
      <div class="text-sm text-muted-foreground">Recovery operations console</div>
      ${extra}
    </div>
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-3">
        <div class="flex flex-col items-end leading-tight">
          <span class="text-sm font-medium text-foreground">${u.name}</span>
          <span class="text-xs text-muted-foreground">${u.email}</span>
        </div>
        <div class="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">${initials}</div>
        <span class="rounded-md bg-secondary px-2 py-0.5 text-xs font-semibold capitalize text-secondary-foreground">${u.role}</span>
      </div>
      <button class="relative inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-foreground"><i data-lucide="bell" class="h-4 w-4"></i>
        <span class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">3</span></button>
      <button class="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-foreground"><i data-lucide="__THEME_ICON__" class="h-4 w-4"></i></button>
      <button class="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground"><i data-lucide="log-out" class="h-4 w-4"></i>Logout</button>
    </div>
  </header>`;
}

function page({ meta, body, dark }) {
  const shell =
    meta.role === "none"
      ? body
      : `<div class="flex min-h-screen w-full bg-background">
          ${sidebar(meta.role, meta.active)}
          <div class="flex min-w-0 flex-1 flex-col">
            ${header(meta.role, meta.headerExtra ?? "").replace("__THEME_ICON__", dark ? "sun" : "moon")}
            <main class="flex-1 p-6">${body}</main>
          </div>
        </div>`;
  return `<!doctype html>
<html lang="en" class="${dark ? "dark" : ""}">
<head>
<meta charset="utf-8">
<title>${meta.title ?? "SamvadX"}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.11"></script>
<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
<style type="text/tailwindcss">
${tokens}
@layer base {
  * { border-color: var(--color-border); }
  body { background-color: var(--color-background); color: var(--color-foreground); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
}
</style>
<style>::-webkit-scrollbar{display:none} body{margin:0}</style>
</head>
<body>
${shell}
<script>lucide.createIcons();</script>
</body>
</html>`;
}

const pagesDir = path.join(here, "pages");
const outDir = path.join(here, "out");
const pngDir = path.join(here, "png");
const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort();
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const f of files) {
  const name = f.replace(/\.html$/, "");
  if (only && !name.includes(only)) continue;
  const raw = fs.readFileSync(path.join(pagesDir, f), "utf8");
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->/);
  const meta = JSON.parse(m[1]);
  const body = raw.slice(m[0].length);
  for (const dark of [false, true]) {
    const out = path.join(outDir, `${name}-${dark ? "dark" : "light"}.html`);
    fs.writeFileSync(out, page({ meta, body, dark }));
    if (process.argv.includes("--shoot")) {
      const w = meta.width ?? 1440;
      const h = meta.height ?? 900;
      execFileSync(CHROME, [
        "--headless=new",
        "--hide-scrollbars",
        "--disable-gpu",
        `--window-size=${w},${h}`,
        "--force-device-scale-factor=2",
        "--virtual-time-budget=8000",
        `--screenshot=${path.join(pngDir, `${name}-${dark ? "dark" : "light"}.png`)}`,
        `file://${out}`,
      ], { stdio: "ignore" });
    }
  }
  console.log("built", name);
}
