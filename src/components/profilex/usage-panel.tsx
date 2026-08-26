// Who is spending the Insights budget. Every lookup is charged — including the ones that come
// back empty — so "how many did each manager run, and what did it cost" is the question that
// actually matters when the monthly invoice arrives. A manager running speculative lookups
// across a whole portfolio is the failure mode this exists to catch early.
//
// Rows come back per user PER SERVICE; aggregated here for the top line and reused for the
// drill-down, so the mix (cheap Mobile-to-UAN vs the pricier employment calls) needs no
// second query.
import { Fragment, useEffect, useState } from "react";
import { ChevronRight, Users, TriangleAlert, IndianRupee, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/reports/stat-card";
import { ReportSection } from "@/components/reports/data-table";
import { supabase } from "@/lib/supabase";
import { getProfilexUsage, type UsageRow } from "@/lib/profilex-actions.server";
import { serviceLabel } from "@/lib/profilex-store";

interface UserUsage {
  agentId: string;
  name: string;
  email: string;
  role: string;
  lookups: number;
  hits: number;
  misses: number;
  failures: number;
  cachedReuses: number;
  debtors: number;
  spend: number;
  lastUsed: string | null;
  services: UsageRow[];
}

function aggregate(rows: UsageRow[]): UserUsage[] {
  const byUser = new Map<string, UserUsage>();
  for (const r of rows) {
    const key = r.agent_id ?? "unknown";
    let u = byUser.get(key);
    if (!u) {
      u = {
        agentId: key,
        name: r.agent_name || "Unknown",
        email: r.agent_email,
        role: r.agent_role,
        lookups: 0,
        hits: 0,
        misses: 0,
        failures: 0,
        cachedReuses: 0,
        debtors: 0,
        spend: 0,
        lastUsed: null,
        services: [],
      };
      byUser.set(key, u);
    }
    u.lookups += Number(r.lookups);
    u.hits += Number(r.hits);
    u.misses += Number(r.misses);
    u.failures += Number(r.failures);
    u.cachedReuses += Number(r.cached_reuses);
    // Distinct debtors is per service in SQL, so summing would double-count anyone looked up
    // with more than one service. The max across services is the honest lower bound, and it is
    // labelled "at least" in the UI rather than presented as exact.
    u.debtors = Math.max(u.debtors, Number(r.debtors_touched));
    u.spend += Number(r.spend);
    if (r.last_used && (!u.lastUsed || r.last_used > u.lastUsed)) u.lastUsed = r.last_used;
    u.services.push(r);
  }
  return [...byUser.values()].sort((a, b) => b.spend - a.spend || b.lookups - a.lookups);
}

const money = (n: number) => `₹${n.toFixed(2)}`;

export function InsightsUsagePanel() {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired — sign in again");
        const res = await getProfilexUsage({ data: { accessToken: session.access_token } });
        setRows(res.rows);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load usage");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground py-6">Loading usage…</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;

  const users = aggregate(rows);
  const totals = users.reduce(
    (a, u) => ({
      lookups: a.lookups + u.lookups,
      misses: a.misses + u.misses,
      spend: a.spend + u.spend,
      cached: a.cached + u.cachedReuses,
    }),
    { lookups: 0, misses: 0, spend: 0, cached: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Users} label="People using it" value={String(users.length)} />
        <Stat icon={Search} label="Lookups run" value={String(totals.lookups)} />
        <Stat
          icon={TriangleAlert}
          label="Paid, no data"
          value={String(totals.misses)}
          sub={
            totals.lookups
              ? `${Math.round((totals.misses / totals.lookups) * 100)}% of lookups`
              : "—"
          }
        />
        <Stat icon={IndianRupee} label="Total spend" value={money(totals.spend)} />
      </div>

      <ReportSection
        title="Usage by person"
        description="This month. Click a row to see which lookups they ran."
        icon={Users}
      >
        {users.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/40 py-10 text-center">
            <p className="text-sm text-muted-foreground">No lookups run this month.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto bg-card">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  {[
                    "Person",
                    "Role",
                    "Lookups",
                    "Found",
                    "Paid, no data",
                    "Free reuse",
                    "Debtors",
                    "Spend",
                    "Last used",
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "border-b border-border px-3 py-2 font-semibold text-muted-foreground",
                        i >= 2 && i <= 7 && "text-right",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => {
                  const isOpen = open === u.agentId;
                  return (
                    <Fragment key={u.agentId}>
                      <tr
                        className={cn(
                          "cursor-pointer transition-colors hover:bg-primary/5",
                          i % 2 === 1 && "bg-muted/20",
                          isOpen && "bg-primary/10",
                        )}
                        onClick={() => setOpen(isOpen ? null : u.agentId)}
                      >
                        <td className="border-b border-border/60 px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <ChevronRight
                              className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")}
                            />
                            <span className="font-medium text-foreground">{u.name}</span>
                            {u.email && (
                              <span className="text-muted-foreground hidden sm:inline">
                                {u.email}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="border-b border-border/60 px-3 py-1.5">
                          <Badge variant="secondary" className="text-[10px] capitalize">
                            {u.role || "—"}
                          </Badge>
                        </td>
                        <td className="border-b border-border/60 px-3 py-1.5 text-right tabular-nums">
                          {u.lookups}
                        </td>
                        <td className="border-b border-border/60 px-3 py-1.5 text-right tabular-nums">
                          {u.hits}
                        </td>
                        <td
                          className={cn(
                            "border-b border-border/60 px-3 py-1.5 text-right tabular-nums",
                            u.misses > u.hits && "text-destructive font-semibold",
                          )}
                        >
                          {u.misses}
                        </td>
                        <td className="border-b border-border/60 px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {u.cachedReuses}
                        </td>
                        <td
                          className="border-b border-border/60 px-3 py-1.5 text-right tabular-nums"
                          title="At least this many — a debtor looked up with two services counts once"
                        >
                          ≥{u.debtors}
                        </td>
                        <td className="border-b border-border/60 px-3 py-1.5 text-right tabular-nums font-semibold">
                          {money(u.spend)}
                        </td>
                        <td className="border-b border-border/60 px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                          {u.lastUsed ? new Date(u.lastUsed).toLocaleDateString("en-IN") : "—"}
                        </td>
                      </tr>

                      {isOpen &&
                        u.services
                          .slice()
                          .sort((a, b) => Number(b.spend) - Number(a.spend))
                          .map((sv) => (
                            <tr key={u.agentId + sv.service_id} className="bg-muted/30">
                              <td className="border-b border-border/60 px-3 py-1 pl-10 text-muted-foreground">
                                {serviceLabel(sv.service_id)}
                              </td>
                              <td className="border-b border-border/60" />
                              <td className="border-b border-border/60 px-3 py-1 text-right tabular-nums">
                                {sv.lookups}
                              </td>
                              <td className="border-b border-border/60 px-3 py-1 text-right tabular-nums">
                                {sv.hits}
                              </td>
                              <td className="border-b border-border/60 px-3 py-1 text-right tabular-nums">
                                {sv.misses}
                              </td>
                              <td className="border-b border-border/60 px-3 py-1 text-right tabular-nums">
                                {sv.cached_reuses}
                              </td>
                              <td className="border-b border-border/60 px-3 py-1 text-right tabular-nums">
                                ≥{sv.debtors_touched}
                              </td>
                              <td className="border-b border-border/60 px-3 py-1 text-right tabular-nums">
                                {money(Number(sv.spend))}
                              </td>
                              <td className="border-b border-border/60 px-3 py-1 text-muted-foreground whitespace-nowrap">
                                {sv.failures > 0 && `${sv.failures} failed (free)`}
                              </td>
                            </tr>
                          ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ReportSection>
    </div>
  );
}
