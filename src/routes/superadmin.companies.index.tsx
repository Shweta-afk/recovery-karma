import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  Loader2,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import {
  getCompanies,
  approveCompany,
  rejectCompany,
  type CompanyRow,
} from "@/lib/superadmin-actions.server";
import { contactRate, type CompanyHealth, type CompanyUsage } from "@/lib/platform-usage";
import {
  fmtAgo,
  fmtInt,
  fmtMoney,
  fmtPct,
  fmtTalk,
  HEALTH_META,
  HealthBadge,
  Trend,
  usePlatformUsage,
  comparisonLabel,
  ExcelButton,
  SuperadminDateFilter,
} from "@/components/superadmin/usage-shared";
import { InfoTip, PageGuide } from "@/components/superadmin/help";
import type { GlossaryKey } from "@/lib/superadmin-glossary";

export const Route = createFileRoute("/superadmin/companies/")({
  head: () => ({
    meta: [
      { title: "Companies · SamvadX Platform" },
      {
        name: "description",
        content: "Every company on SamvadX and how much it uses calling and Insights.",
      },
    ],
  }),
  component: SuperadminCompaniesPage,
});

type SortKey =
  | "name"
  | "health"
  | "lastActivity"
  | "calls"
  | "contactRate"
  | "talk"
  | "callers"
  | "seats"
  | "lookups"
  | "billed"
  | "wallet";

const HEALTH_ORDER: Record<CompanyHealth, number> = {
  dormant: 0,
  slowing: 1,
  new: 2,
  active: 3,
  not_live: 4,
};

const seatShare = (c: CompanyUsage) =>
  c.agentSeats.max ? c.agentSeats.used / c.agentSeats.max : -1;

const SORT_VALUE: Record<SortKey, (c: CompanyUsage) => number | string> = {
  name: (c) => c.companyName.toLowerCase(),
  health: (c) => HEALTH_ORDER[c.health],
  lastActivity: (c) => c.lastActivityAt ?? "",
  calls: (c) => c.current.calls,
  contactRate: (c) => contactRate(c.current) ?? -1,
  talk: (c) => c.current.talkSeconds,
  callers: (c) => c.current.activeCallers,
  seats: seatShare,
  lookups: (c) => c.current.lookups,
  billed: (c) => c.current.insightsCharged,
  wallet: (c) => c.walletBalance,
};

const seatsLabel = (s: { used: number; max: number | null }) =>
  s.max ? `${s.used}/${s.max}` : `${s.used}`;

function SuperadminCompaniesPage() {
  const navigate = useNavigate();
  const { range, setRange, report, loading: usageLoading, reload } = usePlatformUsage();

  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  // Deliberately never auto-suggested (e.g. slugified from the company name) — the subdomain
  // is decided by calling the company and asking what they want, not guessed by the app.
  // Left blank means "approve without a subdomain yet"; approveCompany already treats an
  // empty/omitted subdomain as "leave it unset for now".
  const [subdomainDrafts, setSubdomainDrafts] = useState<Record<string, string>>({});
  const [actingId, setActingId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<CompanyHealth | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "calls",
    desc: true,
  });

  const loadRows = async () => {
    setRowsLoading(true);
    try {
      const accessToken = await getAccessToken();
      const res = await getCompanies({ data: { accessToken } });
      setRows(res.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load companies");
    } finally {
      setRowsLoading(false);
    }
  };

  useEffect(() => {
    loadRows();
  }, []);

  const handleApprove = async (row: CompanyRow) => {
    setActingId(row.id);
    try {
      const accessToken = await getAccessToken();
      await approveCompany({
        data: { accessToken, clientId: row.id, subdomain: subdomainDrafts[row.id] },
      });
      toast.success(`${row.companyName} approved`);
      await Promise.all([loadRows(), reload()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve this company");
    } finally {
      setActingId(null);
    }
  };

  const handleReject = async (row: CompanyRow) => {
    setActingId(row.id);
    try {
      const accessToken = await getAccessToken();
      await rejectCompany({ data: { accessToken, clientId: row.id } });
      toast.success(`${row.companyName} rejected`);
      await Promise.all([loadRows(), reload()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reject this company");
    } finally {
      setActingId(null);
    }
  };

  const pending = rows.filter((r) => r.status === "pending");

  // Which company names appear more than once. Two rows can legitimately share a name (nothing
  // in the schema stops it), and picking the wrong one by name alone is exactly how a subdomain
  // once ended up on an empty duplicate "Axiotta Technologies" instead of the real company.
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of report?.companies ?? [])
      counts.set(c.companyName, (counts.get(c.companyName) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [report]);

  const companies = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (report?.companies ?? []).filter(
      (c) =>
        (healthFilter === "all" || c.health === healthFilter) &&
        (!q ||
          c.companyName.toLowerCase().includes(q) ||
          (c.subdomain ?? "").toLowerCase().includes(q)),
    );
    const val = SORT_VALUE[sort.key];
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
  }, [report, search, healthFilter, sort]);

  const healthCounts = useMemo(() => {
    const counts: Partial<Record<CompanyHealth, number>> = {};
    for (const c of report?.companies ?? []) counts[c.health] = (counts[c.health] ?? 0) + 1;
    return counts;
  }, [report]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));

  const exportExcel = async () => {
    if (!report) return;
    await downloadXlsx(reportFilename("company-usage", report.range), [
      {
        name: "Company usage",
        headers: [
          "Company",
          "Company ID",
          "Status",
          "Health",
          "Subdomain",
          "Plan",
          "Last activity",
          "Last sign-in",
          "Calls",
          "Calls (previous period)",
          "Contacts",
          "Contact rate %",
          "Talk minutes",
          "Active callers",
          "Agent seats used",
          "Agent seat cap",
          "Manager seats used",
          "Manager seat cap",
          "Insights lookups",
          "Insights lookups (previous period)",
          "Lookups found",
          "Insights billed (₹)",
          "ProfileX cost (₹)",
          "Insights wallet (₹)",
        ],
        rows: companies.map((c) => [
          c.companyName,
          c.clientId,
          c.status,
          HEALTH_META[c.health].label,
          c.subdomain ?? "",
          c.plan ?? "",
          c.lastActivityAt ?? "",
          c.lastSignInAt ?? "",
          c.current.calls,
          c.previous.calls,
          c.current.contacts,
          c.current.calls ? Math.round((c.current.contacts / c.current.calls) * 100) : "",
          Math.round(c.current.talkSeconds / 60),
          c.current.activeCallers,
          c.agentSeats.used,
          c.agentSeats.max ?? "",
          c.managerSeats.used,
          c.managerSeats.max ?? "",
          c.current.lookups,
          c.previous.lookups,
          c.current.lookupsFound,
          +c.current.insightsCharged.toFixed(2),
          +c.current.insightsActualCost.toFixed(2),
          +c.walletBalance.toFixed(2),
        ]),
      },
    ]);
  };

  const Th = ({
    k,
    children,
    right,
    hint,
  }: {
    k: SortKey;
    children: React.ReactNode;
    right?: boolean;
    /** Explained by an ⓘ beside the heading (outside the sort button — no nested buttons). */
    hint?: GlossaryKey;
  }) => (
    <th className={`py-2 pr-4 font-medium ${right ? "text-right" : ""}`}>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => toggleSort(k)}
          className={`inline-flex items-center gap-0.5 hover:text-foreground ${sort.key === k ? "text-foreground" : ""}`}
        >
          {children}
          {sort.key === k &&
            (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
        </button>
        {hint && <InfoTip k={hint} />}
      </span>
    </th>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Companies</h1>
            <Badge variant="secondary">Superadmin</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Every company on the platform and how much it uses calling and Insights
            {report ? ` — ${comparisonLabel(report)}.` : "."}
          </p>
        </div>
        <SuperadminDateFilter value={range} onChange={setRange} />
      </div>

      <PageGuide page="companies" />

      {!rowsLoading && pending.length > 0 && (
        <Card className="border-amber-400/40">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-amber-500" />
              Pending verification ({pending.length})
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Nobody at these companies can sign in until you approve or reject them. Optionally
              assign a subdomain slug while approving.
            </p>
          </CardHeader>
          <CardContent className="pt-4 space-y-2">
            {pending.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground truncate">
                    {row.companyName}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {row.adminEmails.length > 0 ? row.adminEmails.join(", ") : "No admin yet"}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    GSTIN: {row.gstin ?? "not given"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Created {new Date(row.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-muted-foreground">Subdomain</span>
                  <Input
                    value={subdomainDrafts[row.id] ?? ""}
                    onChange={(e) =>
                      setSubdomainDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))
                    }
                    placeholder="acme"
                    className="h-8 w-32 text-xs"
                  />
                  <span className="text-[10px] text-muted-foreground">.samvadx.com</span>
                  <Button
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    disabled={actingId === row.id}
                    onClick={() => handleApprove(row)}
                  >
                    {actingId === row.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 text-xs border-destructive/40 text-destructive hover:text-destructive"
                    disabled={actingId === row.id}
                    onClick={() => handleReject(row)}
                  >
                    <X className="h-3 w-3" />
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Company usage
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search company or subdomain"
                  className="h-8 w-56 pl-7 text-xs"
                />
              </div>
              <Select
                value={healthFilter}
                onValueChange={(v) => setHealthFilter(v as CompanyHealth | "all")}
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    All health ({report?.companies.length ?? 0})
                  </SelectItem>
                  {(Object.keys(HEALTH_META) as CompanyHealth[]).map((h) => (
                    <SelectItem key={h} value={h} className="text-xs">
                      {HEALTH_META[h].label} ({healthCounts[h] ?? 0})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ExcelButton disabled={!report || companies.length === 0} onExport={exportExcel} />
            </div>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Health: <b>Active</b> used calling or Insights this period · <b>Slowing</b> calls +
            lookups under 60% of the previous period · <b>Dormant</b> nothing this period ·{" "}
            <b>New</b> joined within 14 days. Click a column to sort, a row to open the company.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {!report ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : companies.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {report.companies.length === 0
                ? "No companies on the platform yet."
                : "No companies match these filters."}
            </p>
          ) : (
            <div className={`overflow-x-auto ${usageLoading ? "opacity-60" : ""}`}>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <Th k="name">Company</Th>
                    <Th k="health" hint="health">
                      Health
                    </Th>
                    <Th k="lastActivity" hint="lastActivity">
                      Last activity
                    </Th>
                    <Th k="calls" right hint="calls">
                      Calls
                    </Th>
                    <Th k="contactRate" right hint="contactRate">
                      Contact rate
                    </Th>
                    <Th k="talk" right hint="talkTime">
                      Talk time
                    </Th>
                    <Th k="callers" right hint="activeCallers">
                      Active callers
                    </Th>
                    <Th k="seats" right hint="seats">
                      Seats
                    </Th>
                    <Th k="lookups" right hint="insightsLookups">
                      Insights lookups
                    </Th>
                    <Th k="billed" right hint="insightsBilled">
                      Insights billed
                    </Th>
                    <Th k="wallet" right hint="wallet">
                      Wallet
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => {
                    const seatsFull = seatShare(c) >= 0.9;
                    return (
                      <tr
                        key={c.clientId}
                        className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
                        onClick={() =>
                          navigate({
                            to: "/superadmin/companies/$clientId",
                            params: { clientId: c.clientId },
                          })
                        }
                      >
                        <td className="py-2.5 pr-4">
                          <div className="font-medium text-foreground">{c.companyName}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {c.subdomain ? `${c.subdomain}.samvadx.com` : "No subdomain"}
                            {c.plan ? ` · ${c.plan}` : ""}
                          </div>
                          {/* Two companies can share a name — surface the id + creation date
                              whenever a name collides so the wrong row can't be picked
                              silently. */}
                          {duplicateNames.has(c.companyName) && (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-amber-600">
                              <AlertTriangle className="h-3 w-3" />
                              <span className="font-mono">{c.clientId.slice(0, 8)}</span>
                              {c.createdAt && (
                                <span className="text-muted-foreground">
                                  · created {new Date(c.createdAt).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-4">
                          <HealthBadge health={c.health} />
                        </td>
                        <td
                          className="py-2.5 pr-4 text-muted-foreground"
                          title={
                            c.lastSignInAt
                              ? `Last sign-in ${new Date(c.lastSignInAt).toLocaleString()}`
                              : undefined
                          }
                        >
                          {fmtAgo(c.lastActivityAt)}
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          <div className="font-medium text-foreground">
                            {fmtInt(c.current.calls)}
                          </div>
                          <Trend current={c.current.calls} previous={c.previous.calls} />
                        </td>
                        <td className="py-2.5 pr-4 text-right">{fmtPct(contactRate(c.current))}</td>
                        <td className="py-2.5 pr-4 text-right">{fmtTalk(c.current.talkSeconds)}</td>
                        <td className="py-2.5 pr-4 text-right">{c.current.activeCallers}</td>
                        <td className="py-2.5 pr-4 text-right">
                          <div className={seatsFull ? "font-medium text-amber-600" : ""}>
                            {seatsLabel(c.agentSeats)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {seatsLabel(c.managerSeats)} mgr
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          <div className="font-medium text-foreground">
                            {fmtInt(c.current.lookups)}
                          </div>
                          <Trend current={c.current.lookups} previous={c.previous.lookups} />
                        </td>
                        <td className="py-2.5 pr-4 text-right">
                          {fmtMoney(c.current.insightsCharged)}
                        </td>
                        <td
                          className={`py-2.5 pr-4 text-right font-medium ${c.walletBalance <= 0 && c.current.lookups > 0 ? "text-destructive" : "text-foreground"}`}
                        >
                          {fmtMoney(c.walletBalance)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
