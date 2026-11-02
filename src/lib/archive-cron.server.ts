// Scheduled archive endpoint — POST /api/cron/archive, called once a day by pg_cron + pg_net
// (setup in docs/MONTHLY_ARCHIVE.md). Mounted on the server fetch entry (src/server.ts) for the
// same reason as the telephony webhook: this TanStack Start version has no stable server-route
// convention.
//
// Each run, for every company:
//   1. archive_month(<yesterday's IST month>) — finalises last month on the 1st, and otherwise
//      keeps the current month's snapshot fresh; idempotent, so running daily is safe. On the 1st
//      it also saves every account's month-end version, in batches (archive-snapshot.server.ts);
//   2. SamvadX's own copies (saved-archives.server.ts): on the 1st, the month that just ended as
//      the company downloads it from Archive History; every day, a full copy of each portfolio
//      that ended recently. Before step 3, so a portfolio's copy still has the whole bank file;
//   3. archiveDeadAccounts() — Excel file + strip for accounts closed 60+ days with nothing open.
// Steps 2 and 3 need Node (it writes Excel), which is why the schedule calls the app rather than
// running purely inside Postgres.
//
// Auth: a shared secret (ARCHIVE_CRON_SECRET) in the `x-cron-secret` header. With no secret set
// the endpoint rejects everything (503) — an open endpoint would let anyone trigger the strip.
// Responds 202 immediately and does the work in the background: pg_net gives up waiting after a
// few seconds, and a large first run can take longer than that.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { archiveDeadAccounts } from "./dead-account-archive.server";
import { archiveMonth, istMonthOf, snapshotDebtorVersions } from "./archive-snapshot.server";
import { saveMonthArchive, saveRecentlyEndedPortfolios } from "./saved-archives.server";

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

async function runScheduledArchive(): Promise<void> {
  const now = new Date();
  const month = istMonthOf(new Date(now.getTime() - 86_400_000)); // yesterday's IST month
  const monthRolledOver = month !== istMonthOf(now); // i.e. today is the 1st (IST)

  // One company per call — each is well inside the 8s statement timeout on its own.
  const admin = getSupabaseAdmin() as unknown as {
    from: (t: string) => { select: (c: string) => PromiseLike<{ data: { id: string }[] | null }> };
  };
  const { data: clients } = await admin.from("clients").select("id");
  for (const { id } of clients ?? []) {
    try {
      await archiveMonth(id, month);
      if (monthRolledOver) {
        const saved = await snapshotDebtorVersions(id, month);
        console.log(`[archive-cron] ${month} client ${id}: ${saved} account versions saved`);
        const copy = await saveMonthArchive(id, month, { by: "schedule" });
        if (copy.filePath) console.log(`[archive-cron] ${month} client ${id}: copy saved`);
      }
    } catch (e) {
      console.error(`[archive-cron] client ${id}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[archive-cron] ${month} monthly archive done for ${clients?.length ?? 0} companies`);

  // Each step is caught on its own: a failed copy must never stop the dead-account job.
  try {
    for (const r of await saveRecentlyEndedPortfolios()) {
      if (r.error) console.error(`[archive-cron] copy of ${r.label}:`, r.error);
      else console.log(`[archive-cron] copy of ${r.label} -> ${r.filePath}`);
    }
  } catch (e) {
    console.error("[archive-cron] portfolio copies:", e instanceof Error ? e.message : e);
  }

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
