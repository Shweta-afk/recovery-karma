// Little shared hook for the sales portal: pulls the one list the Pipeline and Leads pages need
// from the server, and refreshes it on demand after a write.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@/lib/access-token";
import { listLeads, type SalesLeadRow, type SalesPerson, type SalesTaskRow } from "@/lib/sales.server";

export interface SalesListState {
  leads: SalesLeadRow[];
  tasks: SalesTaskRow[];
  people: SalesPerson[];
  me: { kind: "sales" | "superadmin"; salesUserId: string | null; name: string } | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useSalesList(): SalesListState {
  const [state, setState] = useState<Omit<SalesListState, "reload">>({
    leads: [],
    tasks: [],
    people: [],
    me: null,
    loading: true,
    error: null,
  });

  const reload = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const r = await listLeads({ data: { accessToken: token } });
      setState({
        leads: r.leads,
        tasks: r.tasks,
        people: r.people,
        me: r.me,
        loading: false,
        error: null,
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

export function personName(people: SalesPerson[], id: string | null): string {
  if (!id) return "Unassigned";
  return people.find((p) => p.id === id)?.name ?? "Someone who left";
}

export function fmtMoney(n: number | null): string {
  if (n == null || n === 0) return "—";
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)} K`;
  return `₹${n.toFixed(0)}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
