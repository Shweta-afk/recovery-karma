// What goes into an Insights PDF — read-only. Nothing here runs or re-charges a lookup: it only
// reads what earlier lookups stored. The browser draws the file (insights-pdf-render.ts) from
// the model this returns, which is also where the downloader stamp comes from: the name, company
// and time are the SERVER's, not whatever the browser says.
//
// Three ways in, each checked here:
//   - borrower  — every lookup on one debtor (optionally just one, `traceId`). Managers and
//                 admins, and only on a debtor the caller can see: the debtor and its traces are
//                 read AS THE CALLER, so debtors_select / debtor_traces_select decide, exactly as
//                 on the Insights tab. CIBIL reports only while the company's CIBIL switch is on.
//   - manual    — one typed-in lookup from Admin → Insights. Admins, own company.
//   - cibil     — one CIBIL report: a borrower's (whoever may see the borrower, managers/admins)
//                 or a typed-in one (admins).
// Typed-in identifiers (the mobile / UAN / GSTIN / PAN an admin typed) are left out of the PDF,
// as in every other Insights export (user to confirm, 2026-11-25).
import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import { appError } from "./app-error";
import { CIBIL_SERVICE, RETIRED_SERVICE_LABELS, getService } from "./profilex/catalogue";
import { buildReportLayout } from "./profilex/report-layout";
import { resultOf, type InsightsPdfDoc, type PdfLookup } from "./profilex/insights-pdf";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST's fluent builder;
   the chain is `any` by necessity, as in profilex-actions.server.ts. */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
}
type Row = Record<string, unknown>;
type Caller = NonNullable<Awaited<ReturnType<typeof verifyCaller>>>;

const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;

function asCaller(accessToken: string): LooseDb {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw appError(
      "SX-1907",
      "This download is not available right now. Contact SamvadX support.",
      {
        missing: "SUPABASE_URL/SUPABASE_ANON_KEY (caller-scoped read)",
      },
    );
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  }) as unknown as LooseDb;
}

const label = (id: string) => getService(id)?.label ?? RETIRED_SERVICE_LABELS[id] ?? id;
const ROLE_LABEL: Record<string, string> = { admin: "Admin", manager: "Manager" };

/** Same rule as cibil-actions.server.ts: on the plan AND consent recorded; unknown = off. */
async function cibilOn(clientId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("profilex_settings")
    .select("enabled_services, cibil_consent_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return false;
  const services = (data.enabled_services as string[] | null) ?? [];
  return services.includes(CIBIL_SERVICE) && !!data.cibil_consent_at;
}

/** The structured part of a stored CIBIL response (data.data.cibilData). */
function cibilDataOf(response: unknown): unknown {
  const r = response as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const inner = r?.data?.data ?? r?.data ?? r;
  return inner?.cibilData ?? inner;
}

async function agentNames(clientId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const { data } = await db()
    .from("agents")
    .select("id, name")
    .eq("client_id", clientId)
    .in("id", want);
  return new Map(((data ?? []) as Row[]).map((a) => [String(a.id), String(a.name ?? "")]));
}

/** Who is downloading, and for which company — stamped on every page. */
async function stampFor(caller: Caller) {
  const [agent, client] = await Promise.all([
    caller.agentId
      ? db().from("agents").select("name").eq("id", caller.agentId).maybeSingle()
      : Promise.resolve({ data: null }),
    db().from("clients").select("company_name").eq("id", caller.clientId).maybeSingle(),
  ]);
  const name = String((agent.data as Row | null)?.name ?? "").trim() || "Unknown user";
  return {
    downloadedBy: `${name} (${ROLE_LABEL[caller.role] ?? caller.role})`,
    downloadedAt: new Date().toISOString(),
    companyName: String((client.data as Row | null)?.company_name ?? "").trim() || "Your company",
  };
}

async function requireCaller(accessToken: string, roles: string[]): Promise<Caller> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  if (!roles.includes(caller.role)) throw new Error("You can't download Insights reports.");
  enforceRateLimit(`insights-pdf:${caller.authUserId}`, 30, 60_000);
  return caller;
}

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("borrower"), debtorId: idSchema, traceId: idSchema.optional() }),
  z.object({ kind: z.literal("manual"), lookupId: idSchema }),
  z.object({ kind: z.literal("cibil"), reportId: idSchema }),
]);

export const getInsightsPdf = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, scope: scopeSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<{ doc: InsightsPdfDoc; subject: string }> => {
    const s = data.scope;
    if (s.kind === "borrower") return borrowerPdf(data.accessToken, s.debtorId, s.traceId);
    if (s.kind === "manual") return manualPdf(data.accessToken, s.lookupId);
    return cibilPdf(data.accessToken, s.reportId);
  });

/** The borrower as the caller sees it — null when RLS hides it. */
async function visibleDebtor(accessToken: string, debtorId: string): Promise<Row | null> {
  const { data } = await asCaller(accessToken)
    .from("debtors")
    .select("id, name, loan_reference, portfolios(name, lender_name)")
    .eq("id", debtorId)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

function borrowerAbout(d: Row): InsightsPdfDoc["about"] {
  const p = (d.portfolios ?? null) as Row | null;
  return [
    { label: "Borrower", value: String(d.name ?? "") },
    { label: "Loan ID", value: String(d.loan_reference ?? "") },
    {
      label: "Portfolio",
      value: [p?.name, p?.lender_name].filter(Boolean).map(String).join(" - "),
    },
  ].filter((a) => a.value);
}

async function borrowerPdf(accessToken: string, debtorId: string, traceId?: string) {
  const caller = await requireCaller(accessToken, ["manager", "admin"]);
  const debtor = await visibleDebtor(accessToken, debtorId);
  if (!debtor) throw new Error("Borrower not found");

  let q = asCaller(accessToken)
    .from("debtor_traces")
    .select("id, service_id, state, provider_status, response, created_at, requested_by")
    .eq("debtor_id", debtorId)
    .eq("state", "done")
    .order("created_at", { ascending: true });
  if (traceId) q = q.eq("id", traceId);
  const { data: rows, error } = await q;
  if (error) throw appError("SX-1023", "Could not load the lookups.", error);
  let traces = (rows ?? []) as Row[];
  if (traceId && traces.length === 0) throw new Error("Lookup not found");

  // CIBIL: the ledger row holds billing only; the report is in cibil_reports (server-only).
  const showCibil = await cibilOn(caller.clientId);
  if (!showCibil) traces = traces.filter((t) => t.service_id !== CIBIL_SERVICE);
  const cibilIds = traces.filter((t) => t.service_id === CIBIL_SERVICE).map((t) => String(t.id));
  const reports = new Map<string, Row>();
  if (cibilIds.length) {
    const { data: rs } = await db()
      .from("cibil_reports")
      .select("trace_id, score, response")
      .eq("client_id", caller.clientId)
      .eq("debtor_id", debtorId)
      .in("trace_id", cibilIds);
    for (const r of (rs ?? []) as Row[]) reports.set(String(r.trace_id), r);
  }

  const names = await agentNames(
    caller.clientId,
    traces.map((t) => (t.requested_by as string | null) ?? null),
  );
  const lookups: PdfLookup[] = traces.map((t) => {
    const service = label(String(t.service_id));
    const base = {
      serviceLabel: service,
      ranAt: String(t.created_at),
      ranBy: names.get(String(t.requested_by)) ?? null,
      result: resultOf((t.provider_status as string | null) ?? null),
    };
    if (t.service_id === CIBIL_SERVICE) {
      const r = reports.get(String(t.id));
      return {
        ...base,
        extra: r?.score != null ? [{ label: "CIBIL score", value: String(r.score) }] : [],
        layout: r ? buildReportLayout(cibilDataOf(r.response), service) : null,
      };
    }
    return { ...base, layout: buildReportLayout(t.response, service) };
  });

  const stamp = await stampFor(caller);
  const name = String(debtor.name ?? "Borrower");
  return {
    subject: traceId && lookups[0] ? `${name} ${lookups[0].serviceLabel}` : name,
    doc: {
      ...stamp,
      title:
        traceId && lookups[0]
          ? `${lookups[0].serviceLabel} - ${name}`
          : `Insights report - ${name}`,
      about: borrowerAbout(debtor),
      lookups,
    },
  };
}

async function manualPdf(accessToken: string, lookupId: string) {
  const caller = await requireCaller(accessToken, ["admin"]);
  const { data: row, error } = await db()
    .from("insights_manual_lookups")
    .select("id, service_id, state, provider_status, response, created_at, requested_by")
    .eq("id", lookupId)
    .eq("client_id", caller.clientId)
    .maybeSingle();
  if (error) throw appError("SX-1024", "Could not load the lookup.", error);
  if (!row || row.state !== "done" || row.service_id === CIBIL_SERVICE) {
    throw new Error("Lookup not found");
  }
  const service = label(String(row.service_id));
  const names = await agentNames(caller.clientId, [(row.requested_by as string | null) ?? null]);
  const stamp = await stampFor(caller);
  return {
    subject: service,
    doc: {
      ...stamp,
      title: `${service} - typed-in lookup`,
      about: [{ label: "Lookup", value: `${service} (typed in on Admin - Insights)` }],
      lookups: [
        {
          serviceLabel: service,
          ranAt: String(row.created_at),
          ranBy: names.get(String(row.requested_by)) ?? null,
          result: resultOf((row.provider_status as string | null) ?? null),
          layout: buildReportLayout(row.response, service),
        },
      ],
    },
  };
}

async function cibilPdf(accessToken: string, reportId: string) {
  const caller = await requireCaller(accessToken, ["manager", "admin"]);
  const { data: row, error } = await db()
    .from("cibil_reports")
    .select("id, client_id, debtor_id, created_at, requested_by, score, request, response")
    .eq("id", reportId)
    .eq("client_id", caller.clientId)
    .maybeSingle();
  if (error) throw appError("SX-1025", "Could not load the report.", error);
  if (!row || !(await cibilOn(caller.clientId))) throw new Error("Report not found");

  let about: InsightsPdfDoc["about"];
  let subject: string;
  if (row.debtor_id) {
    const debtor = await visibleDebtor(accessToken, String(row.debtor_id));
    if (!debtor) throw new Error("Report not found");
    about = borrowerAbout(debtor);
    subject = String(debtor.name ?? "borrower");
  } else {
    if (caller.role !== "admin") throw new Error("Report not found");
    // A typed-in pull: the person's name as typed (shown on screen), never the PAN or mobile.
    const req = (row.request as Row | null) ?? {};
    subject = `${String(req.first_name ?? "")} ${String(req.last_name ?? "")}`.trim() || "person";
    about = [{ label: "Person", value: subject }];
  }
  const service = label(CIBIL_SERVICE);
  const names = await agentNames(caller.clientId, [(row.requested_by as string | null) ?? null]);
  const stamp = await stampFor(caller);
  return {
    subject: `${subject} cibil`,
    doc: {
      ...stamp,
      title: `${service} - ${subject}`,
      about,
      lookups: [
        {
          serviceLabel: service,
          ranAt: String(row.created_at),
          ranBy: names.get(String(row.requested_by)) ?? null,
          result: "found" as const,
          extra: row.score != null ? [{ label: "CIBIL score", value: String(row.score) }] : [],
          layout: buildReportLayout(cibilDataOf(row.response), service),
        },
      ],
    },
  };
}
