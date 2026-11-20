// Daily health check — server side (2026-11-20). Superadmin only: runs the SQL counts
// (platform_health_checks, service_role) for one IST day and applies the rules in health-checks.ts.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { getService, providerCost, RETIRED_SERVICE_LABELS } from "./profilex/catalogue";
import { todayIstKey } from "./date-filter";
import { isDayKey, istDayStart, shiftDay } from "./superadmin-range";
import { evaluateHealth, type HealthCheckResult, type HealthRow } from "./health-checks";

export interface HealthReport {
  day: string;
  /** True while `day` is today: the counts cover midnight IST until now. */
  partial: boolean;
  generatedAt: string;
  results: HealthCheckResult[];
}

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

export const getHealthReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, day: z.string().refine(isDayKey).optional() }).parse(d),
  )
  .handler(async ({ data }): Promise<HealthReport> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const today = todayIstKey();
    const day = data.day && data.day <= today ? data.day : today;
    const since = istDayStart(day).toISOString();
    const until = istDayStart(shiftDay(day, 1)).toISOString();

    const admin = getSupabaseAdmin();
    // Not in the generated types until they are regenerated after the migration.
    const { data: rows, error } = await (admin as unknown as { rpc: Rpc }).rpc(
      "platform_health_checks",
      { p_since: since, p_until: until },
    );
    if (error) {
      throw new Error(
        error.code === "PGRST202" || error.code === "42883"
          ? "The health check isn't installed in the database yet (20261120_platform_health_checks.sql)."
          : `Could not run the health check (${error.message})`,
      );
    }
    const { data: clients } = await admin.from("clients").select("id, company_name");
    const names = new Map((clients ?? []).map((c) => [c.id, c.company_name as string]));

    const results = evaluateHealth(
      ((rows ?? []) as HealthRow[]).map((r) => ({
        ...r,
        n: Number(r.n),
        total: r.total === null ? null : Number(r.total),
        amount: r.amount === null ? null : Number(r.amount),
      })),
      {
        company: (id) => (id ? (names.get(id) ?? "Unknown company") : null),
        costFor: (service, status) => {
          const s = getService(service);
          return s ? providerCost(s, status) : null;
        },
        label: (service) =>
          getService(service)?.label ?? RETIRED_SERVICE_LABELS[service] ?? service,
      },
    );
    return { day, partial: day === today, generatedAt: new Date().toISOString(), results };
  });
