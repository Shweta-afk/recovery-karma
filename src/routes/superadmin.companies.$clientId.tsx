import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Clock,
  FolderOpen,
  Gauge,
  Loader2,
  Lock,
  Phone,
  Save,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getAccessToken } from "@/lib/access-token";
import {
  getCompanyUsers,
  getWalletLedger,
  updateCompanyUserRole,
  approveCompany,
  rejectCompany,
  setCompanySubdomain,
  setCompanyLimits,
  type CompanyUserRow,
  type WalletLedgerRow,
} from "@/lib/superadmin-actions.server";
import { CompanyInsightsSettingsCard } from "@/components/profilex/company-insights-settings-card";
import { CompanyInvoicesCard } from "@/components/billing/company-invoices-card";
import { DailyUsageChart } from "@/components/superadmin/daily-usage-chart";
import { InfoTip, PageGuide } from "@/components/superadmin/help";
import {
  comparisonLabel,
  ExcelButton,
  fmtAgo,
  fmtInt,
  fmtMoney,
  fmtPct,
  fmtTalk,
  HealthBadge,
  Explained,
  Kpi,
  SuperadminDateFilter,
  Trend,
  usePlatformUsage,
} from "@/components/superadmin/usage-shared";
import { contactRate } from "@/lib/platform-usage";
import { rangeInstants, rangeLabel } from "@/lib/superadmin-range";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import { PLATFORM_SUBDOMAIN, addressFor } from "@/lib/company-address";

type EditableRole = "agent" | "manager" | "admin";
type CompanyStatus = "pending" | "approved" | "rejected";

const TABS = ["overview", "users", "billing", "settings"] as const;
type CompanyTab = (typeof TABS)[number];

const STATUS_BADGE: Record<
  CompanyStatus,
  { label: string; variant: "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  rejected: { label: "Rejected", variant: "destructive" },
};

export const Route = createFileRoute("/superadmin/companies/$clientId")({
  head: () => ({ meta: [{ title: "Company · SamvadX Platform" }] }),
  validateSearch: (s: Record<string, unknown>): { tab?: CompanyTab } =>
    TABS.includes(s.tab as CompanyTab) ? { tab: s.tab as CompanyTab } : {},
  component: SuperadminCompanyDetailPage,
});

const SCOPE_LABEL: Record<string, string> = {
  master_topup: "Superadmin top-up",
  master_to_company: "Allocated to company",
  company_to_manager: "Allocated to manager",
  manager_charge: "Insights lookup spend",
};

const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN") : "");

function SuperadminCompanyDetailPage() {
  const { clientId } = useParams({ from: "/superadmin/companies/$clientId" });
  const { tab = "overview" } = Route.useSearch();
  const navigate = useNavigate({ from: "/superadmin/companies/$clientId" });
  const setTab = (t: string) =>
    navigate({ search: { tab: t === "overview" ? undefined : (t as CompanyTab) }, replace: true });

  const { range, setRange, report, loading: usageLoading } = usePlatformUsage(clientId);

  const [loading, setLoading] = useState(true);
  const [companyName, setCompanyName] = useState("");
  const [status, setStatus] = useState<CompanyStatus>("approved");
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [subdomainDraft, setSubdomainDraft] = useState("");
  const [users, setUsers] = useState<CompanyUserRow[]>([]);
  const [ledger, setLedger] = useState<WalletLedgerRow[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [savingSubdomain, setSavingSubdomain] = useState(false);
  const [maxAgents, setMaxAgents] = useState<number | null>(null);
  const [maxManagers, setMaxManagers] = useState<number | null>(null);
  const [maxAgentsDraft, setMaxAgentsDraft] = useState("");
  const [maxManagersDraft, setMaxManagersDraft] = useState("");
  const [agentCount, setAgentCount] = useState(0);
  const [managerCount, setManagerCount] = useState(0);
  const [savingLimits, setSavingLimits] = useState(false);
  const [createdAt, setCreatedAt] = useState("");

  const load = async () => {
    try {
      const accessToken = await getAccessToken();
      const usersRes = await getCompanyUsers({ data: { accessToken, clientId } });
      setCompanyName(usersRes.companyName);
      setStatus(usersRes.status);
      setSubdomain(usersRes.subdomain);
      setSubdomainDraft(usersRes.subdomain ?? "");
      setMaxAgents(usersRes.maxAgents);
      setMaxManagers(usersRes.maxManagers);
      setMaxAgentsDraft(usersRes.maxAgents === null ? "" : String(usersRes.maxAgents));
      setMaxManagersDraft(usersRes.maxManagers === null ? "" : String(usersRes.maxManagers));
      setAgentCount(usersRes.agentCount);
      setManagerCount(usersRes.managerCount);
      setCreatedAt(usersRes.createdAt);
      setUsers(usersRes.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load this company");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // The wallet history follows the page's date filter.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLedgerLoading(true);
      try {
        const accessToken = await getAccessToken();
        const { since, until } = rangeInstants(range);
        const res = await getWalletLedger({
          data: { accessToken, clientId, limit: 1000, since, until },
        });
        if (!cancelled) setLedger(res.rows);
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Could not load wallet activity");
        }
      } finally {
        if (!cancelled) setLedgerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, range]);

  const handleApprove = async () => {
    setVerifying(true);
    try {
      const accessToken = await getAccessToken();
      await approveCompany({ data: { accessToken, clientId, subdomain: subdomainDraft } });
      toast.success(`${companyName} approved`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve this company");
    } finally {
      setVerifying(false);
    }
  };

  const handleReject = async () => {
    setVerifying(true);
    try {
      const accessToken = await getAccessToken();
      await rejectCompany({ data: { accessToken, clientId } });
      toast.success(`${companyName} rejected`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reject this company");
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveSubdomain = async () => {
    setSavingSubdomain(true);
    try {
      const accessToken = await getAccessToken();
      await setCompanySubdomain({ data: { accessToken, clientId, subdomain: subdomainDraft } });
      setSubdomain(subdomainDraft.trim().toLowerCase());
      toast.success("Subdomain updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the subdomain");
    } finally {
      setSavingSubdomain(false);
    }
  };

  const handleSaveLimits = async () => {
    const parsed = (raw: string): number | null => {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
    };
    const nextMaxAgents = parsed(maxAgentsDraft);
    const nextMaxManagers = parsed(maxManagersDraft);
    if (Number.isNaN(nextMaxAgents) || Number.isNaN(nextMaxManagers)) {
      toast.error("Enter a non-negative number, or leave blank for unlimited");
      return;
    }
    setSavingLimits(true);
    try {
      const accessToken = await getAccessToken();
      await setCompanyLimits({
        data: { accessToken, clientId, maxAgents: nextMaxAgents, maxManagers: nextMaxManagers },
      });
      setMaxAgents(nextMaxAgents);
      setMaxManagers(nextMaxManagers);
      toast.success("Seat limits updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update seat limits");
    } finally {
      setSavingLimits(false);
    }
  };

  const handleRoleChange = async (user: CompanyUserRow, role: EditableRole) => {
    if (role === user.role) return;
    setSavingId(user.id);
    const previousRole = user.role;
    // Optimistic — reverted below if the write fails, so the dropdown doesn't silently snap
    // back with no explanation.
    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role } : u)));
    try {
      const accessToken = await getAccessToken();
      await updateCompanyUserRole({ data: { accessToken, clientId, userId: user.id, role } });
      toast.success(`${user.name} is now ${role === "agent" ? "an" : "a"} ${role}`);
    } catch (e) {
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: previousRole } : u)));
      toast.error(e instanceof Error ? e.message : "Could not update role");
    } finally {
      setSavingId(null);
    }
  };

  const company = report?.companies[0];
  const activityById = useMemo(
    () => new Map((report?.users ?? []).map((u) => [u.agentId, u])),
    [report],
  );
  const portfolios = report?.portfolios ?? [];
  const openPortfolios = portfolios.filter((p) => p.open);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    );
  }

  const exportUsers = () =>
    downloadXlsx(reportFilename(`${companyName}-users`, range), [
      {
        name: "Users",
        headers: [
          "Name",
          "Email",
          "Role",
          "Active",
          "Last sign-in",
          "Last call/lookup",
          "Calls",
          "Contacts",
          "Talk minutes",
          "Insights lookups",
        ],
        rows: users.map((u) => {
          const a = activityById.get(u.id);
          return [
            u.name,
            u.email,
            u.role,
            u.isActive ? "Yes" : "No",
            fmtDateTime(a?.lastSignInAt ?? null),
            fmtDateTime(a?.lastActivityAt ?? null),
            a?.calls ?? 0,
            a?.contacts ?? 0,
            Math.round((a?.talkSeconds ?? 0) / 60),
            a?.lookups ?? 0,
          ];
        }),
      },
    ]);

  const exportOverview = () =>
    downloadXlsx(reportFilename(`${companyName}-usage`, range), [
      {
        name: "Daily usage",
        headers: ["Day (IST)", "Calls", "Insights lookups"],
        rows: (report?.daily ?? []).map((d) => [d.day, d.calls, d.lookups]),
      },
      {
        name: "Portfolios",
        headers: ["Portfolio", "Lender", "Accounts", "Uploaded", "End date", "Closed", "Status"],
        rows: portfolios.map((p) => [
          p.name,
          p.lenderName ?? "",
          p.accounts,
          fmtDateTime(p.uploadedAt),
          p.endDate ?? "",
          fmtDateTime(p.closedAt),
          p.open ? "Open" : "Closed",
        ]),
      },
    ]);

  const exportLedger = () =>
    downloadXlsx(reportFilename(`${companyName}-wallet`, range), [
      {
        name: "Wallet activity",
        headers: ["When", "Type", "Manager", "Amount (₹)", "Note"],
        rows: ledger.map((r) => [
          fmtDateTime(r.createdAt),
          SCOPE_LABEL[r.scope] ?? r.scope,
          r.managerName ?? "",
          +r.amount.toFixed(2),
          r.note ?? "",
        ]),
      },
    ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to="/superadmin/companies"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> All companies
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{companyName}</h1>
            <Badge variant={STATUS_BADGE[status].variant}>{STATUS_BADGE[status].label}</Badge>
            {company && <HealthBadge health={company.health} />}
          </div>
          {/* Company names can collide (two rows both "Axiotta Technologies" is what let a
              subdomain get set on the wrong one) — the id + creation date here are the only
              unambiguous confirmation of which row you're actually editing on this page. */}
          <p className="mt-0.5 text-[11px] text-muted-foreground font-mono">
            {clientId.slice(0, 8)} · created {new Date(createdAt).toLocaleString()}
            {subdomain ? ` · ${subdomain}.samvadx.com` : ""}
          </p>
        </div>
        <SuperadminDateFilter value={range} onChange={setRange} />
      </div>

      {status === "pending" && (
        <button
          type="button"
          onClick={() => setTab("settings")}
          className="flex w-full items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-700 dark:text-amber-400"
        >
          <ShieldCheck className="h-4 w-4" />
          Waiting for approval — nobody here can sign in yet. Approve or reject under Settings →
        </button>
      )}

      <PageGuide page="company" />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users ({users.length})</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-6 pt-2">
          {!report || !company ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading usage…
            </div>
          ) : (
            <div className={`space-y-6 ${usageLoading ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{comparisonLabel(report)}</p>
                <ExcelButton onExport={exportOverview} />
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Kpi
                  icon={<Phone className="h-3.5 w-3.5" />}
                  label="Calls"
                  hint="calls"
                  value={fmtInt(company.current.calls)}
                  sub={`${fmtInt(company.previous.calls)} the period before`}
                  trend={
                    <Trend current={company.current.calls} previous={company.previous.calls} />
                  }
                />
                <Kpi
                  icon={<Gauge className="h-3.5 w-3.5" />}
                  label="Contact rate"
                  hint="contactRate"
                  value={fmtPct(contactRate(company.current))}
                  sub={`${fmtInt(company.current.contacts)} calls reached someone`}
                />
                <Kpi
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label="Talk time"
                  hint="talkTime"
                  value={fmtTalk(company.current.talkSeconds)}
                  sub={`${company.current.activeCallers} active caller(s)`}
                  trend={
                    <Trend
                      current={company.current.talkSeconds}
                      previous={company.previous.talkSeconds}
                    />
                  }
                />
                <Kpi
                  icon={<Users className="h-3.5 w-3.5" />}
                  label="Last activity"
                  hint="lastActivity"
                  value={fmtAgo(company.lastActivityAt)}
                  sub={`last sign-in ${fmtAgo(company.lastSignInAt)}`}
                />
                <Kpi
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  label="Insights lookups"
                  hint="insightsLookups"
                  value={fmtInt(company.current.lookups)}
                  sub={`${fmtPct(company.current.lookups ? company.current.lookupsFound / company.current.lookups : null)} found data`}
                  trend={
                    <Trend current={company.current.lookups} previous={company.previous.lookups} />
                  }
                />
                <Kpi
                  icon={<Wallet className="h-3.5 w-3.5" />}
                  label="Insights billed"
                  hint="insightsBilled"
                  value={fmtMoney(company.current.insightsCharged)}
                  sub={`margin ${fmtMoney(company.current.insightsCharged - company.current.insightsActualCost)}`}
                  trend={
                    <Trend
                      current={company.current.insightsCharged}
                      previous={company.previous.insightsCharged}
                    />
                  }
                />
                <Kpi
                  icon={<Wallet className="h-3.5 w-3.5" />}
                  label="Insights wallet"
                  hint="wallet"
                  value={fmtMoney(company.walletBalance)}
                  sub="current balance"
                />
                <Kpi
                  icon={<Lock className="h-3.5 w-3.5" />}
                  label="Seats"
                  hint="seats"
                  value={`${company.agentSeats.used}${company.agentSeats.max ? ` / ${company.agentSeats.max}` : ""}`}
                  sub={`agents · ${company.managerSeats.used}${company.managerSeats.max ? ` / ${company.managerSeats.max}` : ""} managers`}
                />
              </div>

              <DailyUsageChart
                daily={report.daily}
                subtitle={`Calls and Insights lookups per day (IST) at ${companyName}.`}
              />

              <Card>
                <CardHeader className="border-b border-border pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <FolderOpen className="h-4 w-4 text-primary" />
                    Portfolios
                    <InfoTip k="portfolios" />
                    <Badge variant="secondary" className="text-[10px]">
                      {openPortfolios.length} open
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {portfolios.length - openPortfolios.length} closed
                    </Badge>
                  </CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {fmtInt(openPortfolios.reduce((n, p) => n + p.accounts, 0))} accounts in open
                    portfolios. Counts only — no borrower details.
                  </p>
                </CardHeader>
                <CardContent className="pt-4">
                  {portfolios.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                      No portfolios uploaded yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border text-left text-muted-foreground">
                            <th className="py-2 pr-4 font-medium">Portfolio</th>
                            <th className="py-2 pr-4 font-medium">Lender</th>
                            <th className="py-2 pr-4 font-medium text-right">Accounts</th>
                            <th className="py-2 pr-4 font-medium">Uploaded</th>
                            <th className="py-2 pr-4 font-medium">Ends</th>
                            <th className="py-2 pr-4 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {portfolios.map((p) => (
                            <tr key={p.id} className="border-b border-border last:border-0">
                              <td className="py-2 pr-4 font-medium text-foreground">{p.name}</td>
                              <td className="py-2 pr-4 text-muted-foreground">
                                {p.lenderName ?? "—"}
                              </td>
                              <td className="py-2 pr-4 text-right">{fmtInt(p.accounts)}</td>
                              <td className="py-2 pr-4 text-muted-foreground">
                                {p.uploadedAt
                                  ? new Date(p.uploadedAt).toLocaleDateString("en-IN")
                                  : "—"}
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground">
                                {p.endDate ?? "—"}
                              </td>
                              <td className="py-2 pr-4">
                                <Badge
                                  variant={p.open ? "secondary" : "outline"}
                                  className="text-[10px]"
                                >
                                  {p.open ? "Open" : "Closed"}
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ── Users ────────────────────────────────────────────────────────── */}
        <TabsContent value="users" className="pt-2">
          <Card>
            <CardHeader className="border-b border-border pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary" />
                  Users
                </CardTitle>
                <ExcelButton disabled={users.length === 0} onExport={exportUsers} />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Calls, talk time and Insights lookups are for {rangeLabel(range)}. Last sign-in
                comes from the login system and covers any date.
              </p>
            </CardHeader>
            <CardContent className="pt-4">
              {users.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No users yet.</p>
              ) : (
                <div className={`overflow-x-auto ${usageLoading ? "opacity-60" : ""}`}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">Name</th>
                        <th className="py-2 pr-4 font-medium">
                          <Explained k="lastSignIn">Last sign-in</Explained>
                        </th>
                        <th className="py-2 pr-4 font-medium">
                          <Explained k="lastCallLookup">Last call/lookup</Explained>
                        </th>
                        <th className="py-2 pr-4 font-medium text-right">Calls</th>
                        <th className="py-2 pr-4 font-medium text-right">
                          <Explained k="contacts">Contacts</Explained>
                        </th>
                        <th className="py-2 pr-4 font-medium text-right">Talk time</th>
                        <th className="py-2 pr-4 font-medium text-right">
                          <Explained k="insightsLookups">Lookups</Explained>
                        </th>
                        <th className="py-2 pr-4 font-medium">Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => {
                        const a = activityById.get(u.id);
                        return (
                          <tr key={u.id} className="border-b border-border last:border-0">
                            <td className="py-2 pr-4">
                              <div className="flex items-center gap-1.5 font-medium text-foreground">
                                {u.name}
                                {!u.isActive && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Inactive
                                  </Badge>
                                )}
                              </div>
                              <div className="text-[10px] text-muted-foreground">{u.email}</div>
                            </td>
                            <td
                              className="py-2 pr-4 text-muted-foreground"
                              title={fmtDateTime(a?.lastSignInAt ?? null)}
                            >
                              {a?.lastSignInAt ? fmtAgo(a.lastSignInAt) : "Never"}
                            </td>
                            <td
                              className="py-2 pr-4 text-muted-foreground"
                              title={fmtDateTime(a?.lastActivityAt ?? null)}
                            >
                              {fmtAgo(a?.lastActivityAt ?? null)}
                            </td>
                            <td className="py-2 pr-4 text-right">{fmtInt(a?.calls ?? 0)}</td>
                            <td className="py-2 pr-4 text-right">{fmtInt(a?.contacts ?? 0)}</td>
                            <td className="py-2 pr-4 text-right">{fmtTalk(a?.talkSeconds ?? 0)}</td>
                            <td className="py-2 pr-4 text-right">{fmtInt(a?.lookups ?? 0)}</td>
                            <td className="py-2 pr-4">
                              <div className="flex items-center gap-1.5">
                                {savingId === u.id && <Loader2 className="h-3 w-3 animate-spin" />}
                                <Select
                                  value={u.role}
                                  disabled={savingId === u.id}
                                  onValueChange={(v) => handleRoleChange(u, v as EditableRole)}
                                >
                                  <SelectTrigger className="h-7 w-28 text-[11px] capitalize">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="agent">Agent</SelectItem>
                                    <SelectItem value="manager">Manager</SelectItem>
                                    <SelectItem value="admin">Admin</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
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
        </TabsContent>

        {/* ── Billing ──────────────────────────────────────────────────────── */}
        <TabsContent value="billing" className="space-y-6 pt-2">
          <Card>
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Lock className="h-4 w-4 text-primary" />
                Seat limits
                <InfoTip k="seats" />
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                How many managers and agents this company's admin may invite. Leave blank for
                unlimited — that's the default for every company until you set a number here.
              </p>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Managers</span>
                  <Input
                    type="number"
                    min={0}
                    value={maxManagersDraft}
                    onChange={(e) => setMaxManagersDraft(e.target.value)}
                    placeholder="Unlimited"
                    className="h-8 w-24 text-xs"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    ({managerCount} in use{maxManagers !== null ? ` of ${maxManagers}` : ""})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Agents</span>
                  <Input
                    type="number"
                    min={0}
                    value={maxAgentsDraft}
                    onChange={(e) => setMaxAgentsDraft(e.target.value)}
                    placeholder="Unlimited"
                    className="h-8 w-24 text-xs"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    ({agentCount} in use{maxAgents !== null ? ` of ${maxAgents}` : ""})
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={savingLimits}
                  onClick={handleSaveLimits}
                >
                  {savingLimits ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>

          <CompanyInvoicesCard clientId={clientId} />

          <Card>
            <CardHeader className="border-b border-border pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-primary" />
                  Wallet activity
                  <InfoTip k="wallet" />
                  {company && (
                    <Badge variant="secondary" className="text-[10px]">
                      Balance {fmtMoney(company.walletBalance)}
                    </Badge>
                  )}
                </CardTitle>
                <ExcelButton disabled={ledger.length === 0} onExport={exportLedger} />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Every allocation into and spend out of this company's Insights budget,{" "}
                {rangeLabel(range)}.
              </p>
            </CardHeader>
            <CardContent className="pt-4">
              {ledgerLoading ? (
                <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              ) : ledger.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No wallet activity in this period.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">When</th>
                        <th className="py-2 pr-4 font-medium">Type</th>
                        <th className="py-2 pr-4 font-medium">Manager</th>
                        <th className="py-2 pr-4 font-medium text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((row) => (
                        <tr key={row.id} className="border-b border-border last:border-0">
                          <td className="py-2 pr-4 text-muted-foreground">
                            {new Date(row.createdAt).toLocaleString()}
                          </td>
                          <td className="py-2 pr-4">{SCOPE_LABEL[row.scope] ?? row.scope}</td>
                          <td className="py-2 pr-4 text-muted-foreground">
                            {row.managerName ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-right font-medium text-foreground">
                            ₹{row.amount.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {ledger.length >= 1000 && (
                    <p className="pt-2 text-[11px] text-muted-foreground">
                      Showing the latest 1,000 entries — narrow the dates to see older ones.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Settings ─────────────────────────────────────────────────────── */}
        <TabsContent value="settings" className="space-y-6 pt-2">
          <Card>
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Verification &amp; subdomain
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              {status === "pending" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={verifying}
                    onClick={handleApprove}
                  >
                    {verifying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 border-destructive/40 text-destructive hover:text-destructive"
                    disabled={verifying}
                    onClick={handleReject}
                  >
                    <X className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                </div>
              )}
              {status === "rejected" && (
                <Button size="sm" className="gap-1.5" disabled={verifying} onClick={handleApprove}>
                  {verifying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  Approve anyway
                </Button>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Subdomain</span>
                <Input
                  value={subdomainDraft}
                  onChange={(e) => setSubdomainDraft(e.target.value)}
                  placeholder="acme"
                  className="h-8 w-40 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">.samvadx.com</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={
                    savingSubdomain || subdomainDraft.trim().toLowerCase() === (subdomain ?? "")
                  }
                  onClick={handleSaveSubdomain}
                >
                  {savingSubdomain ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                This company's users can sign in only at this address; without one they use{" "}
                {addressFor(PLATFORM_SUBDOMAIN)}. The address must already open SamvadX (Railway
                domain + DNS record) before it can be saved.
              </p>
            </CardContent>
          </Card>

          <CompanyInsightsSettingsCard clientId={clientId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
