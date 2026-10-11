// A company admin's own company details for invoices and agreements (Admin → Settings), and
// whether they are complete — which drives the red banner on every admin page (admin.tsx).
//
// client_billing is server-only (no RLS policies), so reads and writes go through the service
// role here, after verifyCaller confirms an admin of THAT company. Rules are pure in
// company-details.ts. Superadmins edit the same row from the company's Billing tab
// (saveCompanyBilling in invoice-actions.server.ts).
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import {
  EMPTY_COMPANY_DETAILS,
  checkCompanyDetails,
  companyDetailsFromRow,
  companyDetailsToRow,
  type CompanyDetails,
} from "./company-details";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- new columns aren't in the
   generated types until they're regenerated after migrations/20261011_company_details.sql. */
const db = () => getSupabaseAdmin() as unknown as { from: (t: string) => any };

async function requireAdmin(accessToken: string) {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  if (caller.role !== "admin") throw new Error("Only admins can manage company details");
  return caller;
}

async function loadDetails(clientId: string): Promise<CompanyDetails> {
  const { data, error } = await db()
    .from("client_billing")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`Could not load company details (${error.message})`);
  return data
    ? companyDetailsFromRow(data as Record<string, unknown>)
    : { ...EMPTY_COMPANY_DETAILS };
}

/** For the banner: is anything still needed? Cheap, and never throws for an admin — a failed
 *  check shows the banner rather than hiding it. */
export const getMyCompanyDetailsStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller || caller.role !== "admin") return { complete: true, missing: [] as string[] };
    try {
      const check = checkCompanyDetails(await loadDetails(caller.clientId));
      const invalid = Object.keys(check.invalid).length;
      return {
        complete: check.missing.length === 0 && invalid === 0,
        missing: invalid ? [...check.missing, "fix the fields marked in red"] : check.missing,
      };
    } catch {
      return { complete: false, missing: ["company details"] };
    }
  });

export const getMyCompanyDetails = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireAdmin(data.accessToken);
    const details = await loadDetails(caller.clientId);
    // Prefill the legal name from the company name the first time.
    if (!details.legalName) {
      const { data: client } = await db()
        .from("clients")
        .select("company_name")
        .eq("id", caller.clientId)
        .maybeSingle();
      details.legalName = (client as { company_name?: string } | null)?.company_name ?? "";
    }
    return { details, check: checkCompanyDetails(details) };
  });

const text = (max: number) => z.string().max(max);
const detailsSchema = z.object({
  legalName: text(200),
  gstUnregistered: z.boolean(),
  gstin: text(20),
  pan: text(12),
  cin: text(25),
  address: text(500),
  city: text(80),
  pinCode: text(10),
  stateCode: text(2),
  email: text(200),
  phone: text(20),
  signatoryName: text(120),
  signatoryDesignation: text(120),
});

export const saveMyCompanyDetails = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, details: detailsSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin(data.accessToken);
    const details = data.details as CompanyDetails;
    const check = checkCompanyDetails(details);
    const firstInvalid = Object.entries(check.invalid)[0];
    if (firstInvalid) throw new Error(`Check ${firstInvalid[0]}: ${firstInvalid[1]}`);

    const { error } = await db()
      .from("client_billing")
      .upsert(
        {
          client_id: caller.clientId,
          ...companyDetailsToRow(details),
          updated_at: new Date().toISOString(),
          updated_by_agent: caller.agentId ?? null,
        },
        { onConflict: "client_id" },
      );
    if (error) throw new Error(`Could not save company details (${error.message})`);
    return { check };
  });
