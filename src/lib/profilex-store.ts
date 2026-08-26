// ProfileX trace results, in the app's usual store shape: getTraces() for an immediate render,
// refreshTraces() to pull from Supabase and broadcast, everything else listening on the event.
//
// Reads go through the normal anon client so RLS does the scoping — debtor_traces_select limits
// rows to debtors the viewer can already see, which is what makes a manager's lookup visible to
// the agent working that account without any role logic here. Writes are not in this file at
// all: only the service-role server action may create a trace (it is the thing that pays for
// it), so there is deliberately no saveTrace().
//
// Not cached to localStorage, unlike the older stores: trace responses are large, and
// portfolio-store already blew the ~5 MB origin quota once (see report_count_rpcs migration).
import { supabase } from "./supabase";
import { getService } from "./profilex/catalogue";

/** A ProfileX response body. Untyped on purpose — the provider's shape differs per service and
 *  is not under our control, so readers narrow what they need rather than pretending to a schema. */
export type TraceResponse = Record<string, unknown>;

export interface TraceRecord {
  id: string;
  debtorId: string;
  serviceId: string;
  state: "pending" | "done" | "failed";
  providerStatus: string | null;
  billable: boolean;
  cost: number;
  response: TraceResponse | null;
  error: string | null;
  createdAt: string;
}

const byDebtor = new Map<string, TraceRecord[]>();

export const TRACES_UPDATED = "profilex-traces-updated";

export function getTraces(debtorId: string): TraceRecord[] {
  return byDebtor.get(debtorId) ?? [];
}

/** The newest completed trace per service — what the Trace tab actually renders. */
export function latestByService(debtorId: string): Map<string, TraceRecord> {
  const out = new Map<string, TraceRecord>();
  for (const t of getTraces(debtorId)) {
    if (t.state !== "done") continue;
    if (!out.has(t.serviceId)) out.set(t.serviceId, t); // rows arrive newest-first
  }
  return out;
}

function toRecord(row: Record<string, unknown>): TraceRecord {
  return {
    id: String(row.id),
    debtorId: String(row.debtor_id),
    serviceId: String(row.service_id),
    state: row.state as TraceRecord["state"],
    providerStatus: (row.provider_status as string | null) ?? null,
    billable: !!row.billable,
    cost: Number(row.cost ?? 0),
    response: (row.response as TraceResponse | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function refreshTraces(debtorId: string): Promise<void> {
  const { data, error } = await supabase
    .from("debtor_traces")
    .select("*")
    .eq("debtor_id", debtorId)
    .order("created_at", { ascending: false });
  // An empty result and a blocked result look the same to the UI, so surface the error rather
  // than caching [] and rendering a confident "no traces" over what is really an RLS problem.
  if (error) throw new Error(`Could not load trace history (${error.message})`);
  byDebtor.set(debtorId, ((data ?? []) as Record<string, unknown>[]).map(toRecord));
  window.dispatchEvent(new CustomEvent(TRACES_UPDATED, { detail: { debtorId } }));
}

/** Merge a single trace returned by the server action, so the panel updates without a refetch. */
export function mergeTrace(row: Record<string, unknown>): void {
  const rec = toRecord(row);
  const list = byDebtor.get(rec.debtorId) ?? [];
  byDebtor.set(rec.debtorId, [rec, ...list.filter((t) => t.id !== rec.id)]);
  window.dispatchEvent(new CustomEvent(TRACES_UPDATED, { detail: { debtorId: rec.debtorId } }));
}

/** `data.<field>` off a provider payload, as a display string. The response shape differs per
 *  service and is not ours to define, so reads are narrowed here rather than at each call site. */
function readDataField(response: TraceResponse | null, field: string): string | null {
  const data = response?.data as Record<string, unknown> | undefined;
  const value = data?.[field];
  return value === undefined || value === null || value === "" ? null : String(value);
}

export function readUan(response: TraceResponse | null): string | null {
  return readDataField(response, "uan");
}

export function readPrefill(response: TraceResponse | null): {
  age: string | null;
  state: string | null;
} {
  return { age: readDataField(response, "age"), state: readDataField(response, "state") };
}

export function serviceLabel(serviceId: string): string {
  return getService(serviceId)?.label ?? serviceId;
}

/** Employment payload flattened for display — both employment services share this shape. */
export interface EmploymentView {
  isEmployed: boolean | null;
  employer: string | null;
  dateOfJoining: string | null;
  dateOfExit: string | null;
  history: {
    employer: string;
    dateOfJoining: string;
    dateOfExit: string;
    months: number | null;
  }[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the provider's payload is deeply nested
   and differs per service; narrowing each level would be more fiction than type safety. */
export function readEmployment(response: TraceResponse | null): EmploymentView | null {
  const d = (response as any)?.data;
  if (!d) return null;
  const summary = d.summary ?? {};
  const recent = summary.recent_employer_data ?? {};
  const details = Object.values(d.uan_details ?? {})[0] as any | undefined;
  const rawHistory: any[] = details?.employment_history ?? d.result ?? [];
  return {
    isEmployed: summary.is_employed ?? null,
    employer: recent.establishment_name ?? details?.employment_details?.establishment_name ?? null,
    dateOfJoining: recent.date_of_joining || details?.employment_details?.date_of_joining || null,
    dateOfExit: recent.date_of_exit || details?.employment_details?.date_of_exit || null,
    history: rawHistory
      .filter((h) => h?.establishment_name)
      .map((h) => ({
        employer: h.establishment_name,
        dateOfJoining: h.date_of_joining ?? "",
        dateOfExit: h.date_of_exit ?? "",
        months: h.employment_period_in_months ?? null,
      })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
