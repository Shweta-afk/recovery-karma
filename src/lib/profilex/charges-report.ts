// The "Charges report" a company admin or manager opens from Reports → Insights: every lookup
// that cost money, what it cost, found or not found, and every correction and wallet movement.
// Pure — the server (insights-charges.server.ts) gathers the rows, this shapes them, and the
// tests in scripts/charges-report.test.ts pin the arithmetic.
import { isHit } from "./billing";
import { getService, RETIRED_SERVICE_LABELS } from "./catalogue";

export type ChargeOutcome = "found" | "not_found";

export interface ChargeLookupInput {
  id: string;
  at: string;
  /** borrower = run from a borrower's Insights tab; typed = Admin → Insights. */
  source: "borrower" | "typed";
  serviceId: string;
  providerStatus: string | null;
  cost: number;
  runBy: string;
  borrower: string;
  loanId: string;
}

export interface ChargeCorrectionInput {
  source: "borrower" | "typed";
  lookupId: string;
  oldCost: number;
  newCost: number;
  refunded: number;
  refundedTo: "manager_wallet" | "company_wallet" | "not_deducted";
  at: string;
}

export interface WalletMoveInput {
  at: string;
  scope: string;
  amount: number;
  note: string | null;
  manager: string;
}

export interface ChargeLookupRow extends ChargeLookupInput {
  service: string;
  outcome: ChargeOutcome;
  /** Set when this lookup was corrected after the fact. */
  correction: {
    was: number;
    refunded: number;
    refundedTo: ChargeCorrectionInput["refundedTo"];
    at: string;
  } | null;
}

export interface ServiceChargeRow {
  serviceId: string;
  service: string;
  found: number;
  foundAmount: number;
  notFound: number;
  notFoundAmount: number;
  total: number;
  totalAmount: number;
}

export interface WalletMoveRow extends WalletMoveInput {
  label: string;
  /** +1 money into the wallet this report is about, -1 out. */
  direction: 1 | -1;
}

export interface ChargesReport {
  totals: {
    lookups: number;
    amount: number;
    found: number;
    foundAmount: number;
    notFound: number;
    notFoundAmount: number;
    corrected: number;
    refunded: number;
  };
  byService: ServiceChargeRow[];
  lookups: ChargeLookupRow[];
  wallet: WalletMoveRow[];
}

export const serviceName = (id: string) =>
  getService(id)?.label ?? RETIRED_SERVICE_LABELS[id] ?? id;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a ledger entry means to the company (admin view) or to one manager. */
export function walletLabel(scope: string, view: "company" | "manager"): WalletMoveRow | null {
  const m: Record<string, [string, 1 | -1]> =
    view === "company"
      ? {
          master_to_company: ["Wallet top-up from SamvadX", 1],
          company_to_manager: ["Given to a manager's wallet", -1],
          admin_charge: ["Admin lookups charged", -1],
          company_refund: ["Refund to company wallet", 1],
          manager_refund: ["Refund to a manager's wallet", 1],
        }
      : {
          company_to_manager: ["Added to your wallet by an admin", 1],
          manager_refund: ["Refund to your wallet", 1],
        };
  const hit = m[scope];
  return hit
    ? { at: "", scope, amount: 0, note: null, manager: "", label: hit[0], direction: hit[1] }
    : null;
}

export function buildChargesReport(
  lookups: ChargeLookupInput[],
  corrections: ChargeCorrectionInput[],
  ledger: WalletMoveInput[],
  view: "company" | "manager",
): ChargesReport {
  const fixes = new Map(corrections.map((c) => [`${c.source}:${c.lookupId}`, c]));
  const rows: ChargeLookupRow[] = lookups
    .map((l) => {
      const c = fixes.get(`${l.source}:${l.id}`);
      return {
        ...l,
        cost: round2(l.cost),
        service: serviceName(l.serviceId),
        outcome: (isHit(l.providerStatus) ? "found" : "not_found") as ChargeOutcome,
        correction: c
          ? { was: c.oldCost, refunded: c.refunded, refundedTo: c.refundedTo, at: c.at }
          : null,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));

  const svc = new Map<string, ServiceChargeRow>();
  for (const r of rows) {
    const s = svc.get(r.serviceId) ?? {
      serviceId: r.serviceId,
      service: r.service,
      found: 0,
      foundAmount: 0,
      notFound: 0,
      notFoundAmount: 0,
      total: 0,
      totalAmount: 0,
    };
    if (r.outcome === "found") {
      s.found += 1;
      s.foundAmount = round2(s.foundAmount + r.cost);
    } else {
      s.notFound += 1;
      s.notFoundAmount = round2(s.notFoundAmount + r.cost);
    }
    s.total += 1;
    s.totalAmount = round2(s.totalAmount + r.cost);
    svc.set(r.serviceId, s);
  }

  const wallet = ledger
    .map((e) => {
      const meta = walletLabel(e.scope, view);
      return meta ? { ...e, label: meta.label, direction: meta.direction } : null;
    })
    .filter((e): e is WalletMoveRow => e !== null)
    .sort((a, b) => b.at.localeCompare(a.at));

  const sum = (xs: ChargeLookupRow[]) => round2(xs.reduce((t, r) => t + r.cost, 0));
  const found = rows.filter((r) => r.outcome === "found");
  const missed = rows.filter((r) => r.outcome === "not_found");
  const corrected = rows.filter((r) => r.correction);
  return {
    totals: {
      lookups: rows.length,
      amount: sum(rows),
      found: found.length,
      foundAmount: sum(found),
      notFound: missed.length,
      notFoundAmount: sum(missed),
      corrected: corrected.length,
      refunded: round2(corrected.reduce((t, r) => t + (r.correction?.refunded ?? 0), 0)),
    },
    byService: [...svc.values()].sort((a, b) => b.totalAmount - a.totalAmount),
    lookups: rows,
    wallet,
  };
}

export const REFUNDED_TO_LABEL: Record<ChargeCorrectionInput["refundedTo"], string> = {
  manager_wallet: "manager's wallet",
  company_wallet: "company wallet",
  not_deducted: "not refunded — the old amount was never taken from a wallet",
};
