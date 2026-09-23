// Scheduled archive endpoint — POST /api/cron/archive, called once a day by pg_cron + pg_net
// (setup in docs/MONTHLY_ARCHIVE.md). Mounted on the server fetch entry (src/server.ts) for the
// same reason as the telephony webhook: this TanStack Start version has no stable server-route
// convention.
//
// Each run, for every company:
//   1. archive_month(<yesterday's IST month>) — finalises last month on the 1st, and otherwise
//      keeps the current month's snapshot fresh; idempotent, so running daily is safe;
//   2. archiveDeadAccounts() — Excel file + strip for accounts closed 60+ days with nothing open.
// Step 2 needs Node (it writes Excel), which is why the schedule calls the app rather than
// running purely inside Postgres.
//
// Auth: a shared secret (ARCHIVE_CRON_SECRET) in the `x-cron-secret` header. With no secret set
// the endpoint rejects everything (503) — an open endpoint would let anyone trigger the strip.
// Responds 202 immediately and does the work in the background: pg_net gives up waiting after a
// few seconds, and a large first run can take longer than that.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { archiveDeadAccounts } from "./dead-account-archive.server";

export const ARCHIVE_CRON_PATH = "/api/cron/archive";

async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given) return false;
  const { timingSafeEqual, createHash } = await import("node:crypto");
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** 'YYYY-MM' of yesterday, in IST. */
function yesterdayIstMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date(Date.now() - 86_400_000))
    .slice(0, 7);
}

async function runScheduledArchive(): Promise<void> {
  const month = yesterdayIstMonth();
  const admin = getSupabaseAdmin() as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  };
  const { error } = await admin.rpc("archive_month", { p_month: month });
  if (error) console.error(`[archive-cron] archive_month(${month}) failed:`, error.message);
  else console.log(`[archive-cron] archive_month(${month}) done`);

  const results = await archiveDeadAccounts();
  for (const c of results) {
    if (c.error) console.error(`[archive-cron] dead accounts, client ${c.clientId}:`, c.error);
    for (const p of c.portfolios) {
      if (p.error) console.error(`[archive-cron] ${p.portfolioName}:`, p.error);
      else if (p.archived)
        console.log(`[archive-cron] ${p.portfolioName}: archived ${p.archived} -> ${p.filePath}`);
    }
  }
}

export async function handleArchiveCron(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const expected = process.env.ARCHIVE_CRON_SECRET?.trim();
  if (!expected) {
    console.error("[archive-cron] rejected: ARCHIVE_CRON_SECRET is not set");
    return json({ error: "Archive schedule is not configured" }, 503);
  }
  if (!(await secretMatches(request.headers.get("x-cron-secret"), expected))) {
    return json({ error: "Unauthorized" }, 401);
  }
  void runScheduledArchive().catch((e) => console.error("[archive-cron] run failed:", e));
  return json({ accepted: true }, 202);
}
