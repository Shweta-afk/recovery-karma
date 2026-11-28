// Per-company switches for features SamvadX sells (client_features, 20261128 migration).
// Off unless a row says on. Superadmins set them on the company page; every server action of a
// gated feature checks them, so hiding a button is never the only lock.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { NO_FEATURES, type CompanyFeatures, type FeatureKey } from "./company-features";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- table newer than generated types
const db = () => getSupabaseAdmin() as any;

export async function loadFeatures(clientId: string): Promise<CompanyFeatures> {
  const { data, error } = await db()
    .from("client_features")
    .select("mis_reports, report_emails")
    .eq("client_id", clientId)
    .maybeSingle();
  // Table missing (migration not applied) → everything off, never on.
  if (error || !data) return NO_FEATURES;
  return { misReports: !!data.mis_reports, reportEmails: !!data.report_emails };
}

export async function requireFeature(clientId: string, key: FeatureKey): Promise<void> {
  const f = await loadFeatures(clientId);
  if (!f[key]) throw new Error("This feature isn't on your plan. Contact SamvadX to add it.");
}

export const getMyFeatures = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<CompanyFeatures> => {
    const c = await verifyCaller(data.accessToken);
    if (!c) return NO_FEATURES;
    return loadFeatures(c.clientId);
  });

export const getCompanyFeatures = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<CompanyFeatures> => {
    const s = await verifySuperadminCaller(data.accessToken);
    if (!s) throw new Error("Not allowed");
    return loadFeatures(data.clientId);
  });

export const setCompanyFeature = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        key: z.enum(["misReports", "reportEmails"]),
        on: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<CompanyFeatures> => {
    const s = await verifySuperadminCaller(data.accessToken);
    if (!s) throw new Error("Not allowed");
    const column = data.key === "misReports" ? "mis_reports" : "report_emails";
    const { error } = await db()
      .from("client_features")
      .upsert(
        {
          client_id: data.clientId,
          [column]: data.on,
          updated_by: s.superadminId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_id" },
      );
    if (error) throw new Error(error.message);
    void logSuperadminActivity({
      superadminId: s.superadminId,
      action: "feature_set",
      clientId: data.clientId,
      summary: `${data.on ? "Turned on" : "Turned off"} ${data.key === "misReports" ? "Collection MIS" : "Report emails"}`,
      detail: { feature: column, on: data.on },
    });
    return loadFeatures(data.clientId);
  });
