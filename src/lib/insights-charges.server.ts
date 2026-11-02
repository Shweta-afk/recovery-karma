// Server side of the Insights "Charges report" (components/profilex/charges-report.tsx): every
// lookup that cost money in a period, with what it cost, found or not found, any later
// correction, and the wallet's top-ups and refunds. Shaped by lib/profilex/charges-report.ts.
//
// Read through the service role with explicit scoping, like the wallet pages: an admin gets the
// whole company (borrower-tab lookups by anyone + Admin → Insights typed-in lookups); a manager
// gets only the lookups THEY ran and their own wallet. insights_charge_corrections is
// server-only (migrations/20261029_insights_charge_corrections.sql) — if it is missing, the
// report still works, without corrections.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { fetchAllRows } from "./fetch-all-rows";
import { appError } from "./app-error";
import { isoDateSchema, tokenSchema } from "./schemas";
import {
  buildChargesReport,
  type ChargeCorrectionInput,
  type ChargeLookupInput,
  type WalletMoveInput,
} from "./profilex/charges-report";

type Row = Record<string, unknown>;
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- same untyped-builder narrowing
   as profilex-actions.server.ts; these tables are read through it there too. */
type QueryBuilder = any;
const db = () => getSupabaseAdmin() as unknown as { from: (t: string) => QueryBuilder };

const loadFailed = (cause: unknown) =>
  appError("SX-1020", "Could not load the charges report.", cause);

export const getInsightsChargesReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, since: isoDateSchema.optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated");
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers or admins can view the charges report");
    }
    const isAdmin = caller.role === "admin";
    if (!isAdmin && !caller.agentId) throw new Error("Not authenticated");
    const since = data.since ?? new Date(0).toISOString();
    const admin = db();

    const traces = await fetchAllRows<Row>((from, to) => {
      let q = admin
        .from("debtor_traces")
        .select(
          "id, created_at, service_id, provider_status, cost, requested_by, debtors(name, loan_reference, portfolios(name))",
        )
        .eq("client_id", caller.clientId)
        .eq("billable", true)
        .eq("state", "done")
        .gte("created_at", since);
      if (!isAdmin) q = q.eq("requested_by", caller.agentId);
      return q.order("created_at", { ascending: false }).range(from, to);
    });
    if (traces.error) throw loadFailed(traces.error);

    const typed = isAdmin
      ? await fetchAllRows<Row>((from, to) =>
          admin
            .from("insights_manual_lookups")
            .select("id, created_at, service_id, provider_status, cost, requested_by")
            .eq("client_id", caller.clientId)
            .eq("state", "done")
            .gt("cost", 0)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .range(from, to),
        )
      : { data: [] as Row[], error: null };
    if (typed.error) throw loadFailed(typed.error);

    const { data: people } = await admin
      .from("agents")
      .select("id, name")
      .eq("client_id", caller.clientId);
    const nameOf = new Map(
      ((people ?? []) as Row[]).map((p) => [String(p.id), String(p.name ?? "")]),
    );
    const who = (id: unknown) => (id ? nameOf.get(String(id)) || "Former user" : "—");

    const lookups: ChargeLookupInput[] = [
      ...traces.data.map((t) => {
        const d = (t.debtors ?? {}) as Row;
        return {
          id: String(t.id),
          at: String(t.created_at),
          source: "borrower" as const,
          serviceId: String(t.service_id),
          providerStatus: (t.provider_status as string | null) ?? null,
          cost: Number(t.cost ?? 0),
          runBy: who(t.requested_by),
          borrower: String(d.name ?? ""),
          loanId: String(d.loan_reference ?? ""),
          portfolio: String(((d.portfolios ?? {}) as Row).name ?? ""),
        };
      }),
      ...typed.data.map((m) => ({
        id: String(m.id),
        at: String(m.created_at),
        source: "typed" as const,
        serviceId: String(m.service_id),
        providerStatus: (m.provider_status as string | null) ?? null,
        cost: Number(m.cost ?? 0),
        runBy: who(m.requested_by),
        // The typed-in number is deliberately not repeated here.
        borrower: "Typed in (Admin → Insights)",
        loanId: "",
        portfolio: "",
      })),
    ];

    let corrections: ChargeCorrectionInput[] = [];
    {
      let q = admin
        .from("insights_charge_corrections")
        .select("source, lookup_id, old_cost, new_cost, refunded, refunded_to, created_at")
        .eq("client_id", caller.clientId)
        .gte("lookup_at", since);
      if (!isAdmin) q = q.eq("manager_id", caller.agentId);
      const { data: rows, error } = await q;
      // A missing table only means no corrections were recorded yet.
      if (error && !/insights_charge_corrections/.test(error.message)) {
        throw loadFailed(error);
      }
      corrections = ((rows ?? []) as Row[]).map((c) => ({
        source: c.source as "borrower" | "typed",
        lookupId: String(c.lookup_id),
        oldCost: Number(c.old_cost),
        newCost: Number(c.new_cost),
        refunded: Number(c.refunded),
        refundedTo: c.refunded_to as ChargeCorrectionInput["refundedTo"],
        at: String(c.created_at),
      }));
    }

    // Money in and out of the wallet. Per-lookup charges are left out — they are the lookups
    // table — except the one-off 2026-10-28 back-charge of earlier admin lookups.
    let lq = admin
      .from("profilex_wallet_ledger")
      .select("created_at, scope, amount, note, manager_id")
      .eq("client_id", caller.clientId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000);
    lq = isAdmin
      ? lq.in("scope", [
          "master_to_company",
          "company_to_manager",
          "admin_charge",
          "company_refund",
          "manager_refund",
        ])
      : lq.eq("manager_id", caller.agentId).in("scope", ["company_to_manager", "manager_refund"]);
    const { data: ledgerRows, error: ledgerErr } = await lq;
    if (ledgerErr) throw loadFailed(ledgerErr);
    const ledger: WalletMoveInput[] = ((ledgerRows ?? []) as Row[])
      .filter(
        (e) => e.scope !== "admin_charge" || String(e.note ?? "").startsWith("Admin lookups ("),
      )
      .map((e) => ({
        at: String(e.created_at),
        scope: String(e.scope),
        amount: Number(e.amount),
        note: (e.note as string | null) ?? null,
        manager: e.manager_id ? who(e.manager_id) : "",
      }));

    return {
      since,
      view: isAdmin ? ("company" as const) : ("manager" as const),
      report: buildChargesReport(lookups, corrections, ledger, isAdmin ? "company" : "manager"),
    };
  });
