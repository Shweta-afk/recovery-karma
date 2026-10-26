import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  History,
  Loader2,
  Phone,
  PhoneIncoming,
  Plus,
  RadioTower,
  Save,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoTip, PageGuide } from "@/components/superadmin/help";
import { ExcelButton, Explained, Kpi } from "@/components/superadmin/usage-shared";
import { getAccessToken } from "@/lib/access-token";
import { downloadXlsx } from "@/lib/xlsx-export";
import { todayIstKey } from "@/lib/date-filter";
import {
  addNumbers,
  getCompanyPortfoliosForNumbers,
  getNumberHistory,
  getNumbersOverview,
  saveTrunkSettings,
  updateNumbers,
  type NumberChange,
  type NumberRow,
  type NumbersOverview,
} from "@/lib/telephony-numbers.server";
import type { DidHealth, DidStatus } from "@/lib/telephony/did-rules";

export const Route = createFileRoute("/superadmin/numbers")({
  head: () => ({ meta: [{ title: "Numbers & Lines · SamvadX Platform" }] }),
  component: NumbersPage,
});

const STATUS_META: Record<
  DidStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  available: { label: "Free", variant: "outline" },
  assigned: { label: "In use", variant: "secondary" },
  cooling: { label: "Resting after release", variant: "outline" },
  blocked: { label: "Blocked", variant: "destructive" },
  retired: { label: "Retired", variant: "outline" },
};

const HEALTH_META: Record<DidHealth, { label: string; className: string }> = {
  ok: { label: "OK", className: "text-emerald-600 dark:text-emerald-400" },
  watch: { label: "Watch", className: "text-amber-600 dark:text-amber-400" },
  rest: { label: "Rest it", className: "text-destructive font-medium" },
  too_few_calls: { label: "—", className: "text-muted-foreground" },
};

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        timeZone: "Asia/Kolkata",
      })
    : "";

const pickUp = (n: Pick<NumberRow, "calls7d" | "answered7d">) =>
  n.calls7d ? `${Math.round((n.answered7d / n.calls7d) * 100)}%` : "—";

function statusText(n: NumberRow): string {
  if (n.status === "cooling")
    return n.assignable ? "Free (rest over)" : `Resting until ${fmtDate(n.coolingUntil)}`;
  if (n.status === "assigned" && n.restingUntil && new Date(n.restingUntil) > new Date()) {
    return `Resting until ${fmtDate(n.restingUntil)}`;
  }
  return STATUS_META[n.status].label;
}

function NumbersPage() {
  const [data, setData] = useState<NumbersOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setData(await getNumbersOverview({ data: { accessToken: await getAccessToken() } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load numbers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Live board: lines in use change by the second while companies dial.
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Numbers &amp; Lines
          </h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          The phone numbers borrowers see and call back on, which company holds each, and how the
          calling lines are shared. Calling provider:{" "}
          <span className="font-medium text-foreground">{data?.provider ?? "…"}</span>
          {data?.provider === "sim" && " (simulator — no real calls)"}.
        </p>
      </div>

      <PageGuide page="numbers" />

      {loading && !data && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {data && !data.ready && (
        <Card className="border-amber-500/50">
          <CardContent className="pt-4 text-sm">
            Phone numbers aren't set up in the database yet. Apply{" "}
            <span className="font-mono text-xs">
              migrations/20261026_telephony_dids_channels.sql
            </span>{" "}
            and reload. Until then calls keep working exactly as before.
          </CardContent>
        </Card>
      )}
      {data && (
        <>
          <LinesCard data={data} onSaved={load} />
          <CompaniesCard data={data} />
          {data.ready && <NumbersCard data={data} onChanged={load} />}
        </>
      )}
    </div>
  );
}

// ─── Lines ──────────────────────────────────────────────────────────────────────

function LinesCard({ data, onSaved }: { data: NumbersOverview; onSaved: () => Promise<void> }) {
  const t = data.trunk;
  const [draft, setDraft] = useState({
    total: String(t.totalChannels),
    inbound: String(t.inboundReserve),
    cooling: String(t.didCoolingDays),
    cap: String(t.defaultDidDailyCap),
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft({
      total: String(t.totalChannels),
      inbound: String(t.inboundReserve),
      cooling: String(t.didCoolingDays),
      cap: String(t.defaultDidDailyCap),
    });
  }, [t.totalChannels, t.inboundReserve, t.didCoolingDays, t.defaultDidDailyCap]);

  const shared = Math.max(0, t.totalChannels - t.inboundReserve - data.guaranteed);
  const inUse = data.outboundActive + data.inboundActive;

  const save = async () => {
    setSaving(true);
    try {
      await saveTrunkSettings({
        data: {
          accessToken: await getAccessToken(),
          totalChannels: Number(draft.total),
          inboundReserve: Number(draft.inbound),
          didCoolingDays: Number(draft.cooling),
          defaultDidDailyCap: Number(draft.cap),
        },
      });
      toast.success("Saved");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <RadioTower className="h-4 w-4 text-primary" />
          Calling lines
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-5">
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          <Kpi
            icon={<RadioTower className="h-4 w-4" />}
            label="Lines on the trunk"
            hint="trunkLines"
            value={String(t.totalChannels)}
          />
          <Kpi
            icon={<Phone className="h-4 w-4" />}
            label="In use now"
            hint="linesInUse"
            value={`${inUse}`}
            sub={`${data.outboundActive} outgoing · ${data.inboundActive} incoming`}
          />
          <Kpi
            icon={<PhoneIncoming className="h-4 w-4" />}
            label="Kept for incoming"
            hint="inboundReserve"
            value={String(t.inboundReserve)}
          />
          <Kpi
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Guaranteed to companies"
            hint="guaranteedLines"
            value={String(data.guaranteed)}
          />
          <Kpi
            icon={<Users className="h-4 w-4" />}
            label="Shared pool"
            hint="sharedLines"
            value={String(shared)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumField
            label="Lines on the trunk"
            hint="What the vendor's contract gives you"
            value={draft.total}
            onChange={(v) => setDraft({ ...draft, total: v })}
          />
          <NumField
            label="Kept for incoming calls"
            hint="Outgoing calls never take these"
            value={draft.inbound}
            onChange={(v) => setDraft({ ...draft, inbound: v })}
          />
          <NumField
            label="Rest after release (days)"
            hint="Before another company may get the number"
            value={draft.cooling}
            onChange={(v) => setDraft({ ...draft, cooling: v })}
          />
          <NumField
            label="Calls per number per day"
            hint="When a number has no limit of its own"
            value={draft.cap}
            onChange={(v) => setDraft({ ...draft, cap: v })}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={saving || !data.ready}
          onClick={save}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function NumField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

// ─── Companies ──────────────────────────────────────────────────────────────────

function CompaniesCard({ data }: { data: NumbersOverview }) {
  const rows = data.companies;
  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Phone className="h-4 w-4 text-primary" />
            Lines by company
          </CardTitle>
          <ExcelButton
            disabled={!rows.length}
            onExport={() =>
              downloadXlsx(`samvadx-lines-by-company-${todayIstKey()}.xlsx`, [
                {
                  name: "Lines by company",
                  headers: [
                    "Company",
                    "Calling on",
                    "In use now",
                    "Guaranteed",
                    "Most at once",
                    "Can open now",
                    "Numbers",
                    "Minutes waiting (own limit)",
                    "Minutes waiting (platform busy)",
                    "Refused: no number free",
                  ],
                  rows: rows.map((c) => [
                    c.name,
                    c.enabled ? "Yes" : "No",
                    c.activeOutbound,
                    c.reserved,
                    c.max,
                    c.headroom,
                    c.numbers,
                    c.waitedCompanyLimit,
                    c.waitedPlatformBusy,
                    c.noNumber,
                  ]),
                },
              ])
            }
          />
        </div>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        {rows.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No company has calling set up yet. Open a company → Calling tab.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Company</th>
                <th className="py-2 pr-3 font-medium text-right">In use</th>
                <th className="py-2 pr-3 font-medium text-right">
                  <Explained k="guaranteedLines">Guaranteed</Explained>
                </th>
                <th className="py-2 pr-3 font-medium text-right">
                  <Explained k="mostLines">Most</Explained>
                </th>
                <th className="py-2 pr-3 font-medium text-right">
                  <Explained k="canOpenNow">Can open now</Explained>
                </th>
                <th className="py-2 pr-3 font-medium text-right">Numbers</th>
                <th className="py-2 pr-3 font-medium text-right">
                  <Explained k="waitedForLine">Waited today</Explained>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.clientId} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3">
                    <Link
                      to="/superadmin/companies/$clientId"
                      params={{ clientId: c.clientId }}
                      search={{ tab: "calling" }}
                      className="hover:underline"
                    >
                      {c.name}
                    </Link>
                    {!c.enabled && (
                      <span className="ml-2 text-xs text-muted-foreground">(calling off)</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.activeOutbound}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.reserved}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.max}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.headroom}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{c.numbers}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.waitedCompanyLimit + c.waitedPlatformBusy + c.noNumber === 0 ? (
                      "—"
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        {[
                          c.waitedCompanyLimit && `${c.waitedCompanyLimit} min at own limit`,
                          c.waitedPlatformBusy && `${c.waitedPlatformBusy} min all busy`,
                          c.noNumber && `${c.noNumber}× no number free`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Numbers ────────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "free" | DidStatus | "attention";

function NumbersCard({
  data,
  onChanged,
}: {
  data: NumbersOverview;
  onChanged: () => Promise<void>;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [historyOf, setHistoryOf] = useState<NumberRow | null>(null);

  const rows = useMemo(() => {
    const q = search.replace(/\D/g, "");
    return data.numbers.filter((n) => {
      if (
        companyFilter !== "all" &&
        (companyFilter === "none" ? n.clientId : n.clientId !== companyFilter)
      )
        return false;
      if (q && !n.number.includes(q)) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "free") return n.assignable;
      if (statusFilter === "attention") return n.health === "rest" || n.health === "watch";
      return n.status === statusFilter;
    });
  }, [data.numbers, statusFilter, companyFilter, search]);

  // Drop selections that a refresh or filter has hidden.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id))));
  }, [rows]);

  const chosen = rows.filter((r) => selected.has(r.id));
  const counts = {
    total: data.numbers.length,
    free: data.numbers.filter((n) => n.assignable).length,
    inUse: data.numbers.filter((n) => n.status === "assigned").length,
    cooling: data.numbers.filter((n) => n.status === "cooling" && !n.assignable).length,
    attention: data.numbers.filter((n) => n.health === "rest").length,
  };

  const act = async (change: NumberChange, verb: string) => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const r = await updateNumbers({
        data: { accessToken: await getAccessToken(), ids: chosen.map((c) => c.id), change },
      });
      toast.success(
        `${verb} ${r.changed} number${r.changed === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} skipped (not in a state that allows it)` : ""}`,
      );
      setSelected(new Set());
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update numbers");
    } finally {
      setBusy(false);
    }
  };

  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Phone className="h-4 w-4 text-primary" />
            Phone numbers
            <span className="text-xs font-normal text-muted-foreground">
              {counts.total} total · {counts.free} free · {counts.inUse} with companies ·{" "}
              {counts.cooling} resting
              {counts.attention ? ` · ${counts.attention} need a rest` : ""}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3 w-3" />
              Add numbers
            </Button>
            <ExcelButton
              disabled={!rows.length}
              onExport={() =>
                downloadXlsx(`samvadx-numbers-${todayIstKey()}.xlsx`, [
                  {
                    name: "Phone numbers",
                    headers: [
                      "Number",
                      "Label",
                      "Status",
                      "Company",
                      "Portfolio",
                      "Used for",
                      "Vendor queue",
                      "Calls per day limit",
                      "Calls today",
                      "Calls (7 days)",
                      "Picked up (7 days)",
                      "Health",
                      "With this company since",
                    ],
                    rows: rows.map((n) => [
                      n.number,
                      n.label ?? "",
                      statusText(n),
                      n.clientName ?? "",
                      n.portfolioName ?? "",
                      n.use,
                      n.vendorQueue ?? "",
                      n.dailyCap ?? data.trunk.defaultDidDailyCap,
                      n.callsToday,
                      n.calls7d,
                      n.answered7d,
                      HEALTH_META[n.health].label,
                      fmtDate(n.assignedAt),
                    ]),
                  },
                ])
              }
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every status</SelectItem>
              <SelectItem value="free">Free to give out</SelectItem>
              <SelectItem value="assigned">With a company</SelectItem>
              <SelectItem value="cooling">Resting after release</SelectItem>
              <SelectItem value="attention">Pick-ups dropping</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
              <SelectItem value="retired">Retired</SelectItem>
            </SelectContent>
          </Select>
          <Select value={companyFilter} onValueChange={setCompanyFilter}>
            <SelectTrigger className="h-8 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every company</SelectItem>
              <SelectItem value="none">No company</SelectItem>
              {data.allCompanies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a number"
            className="h-8 w-40 text-xs"
            inputMode="numeric"
          />
        </div>
        {chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 p-2 text-xs">
            <span className="font-medium">{chosen.length} selected</span>
            <Select value={assignTo} onValueChange={setAssignTo}>
              <SelectTrigger className="h-7 w-48 text-xs">
                <SelectValue placeholder="Give to company…" />
              </SelectTrigger>
              <SelectContent>
                {data.allCompanies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy || !assignTo}
              onClick={() => act({ action: "assign", clientId: assignTo }, "Gave")}
            >
              Give
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              Edit…
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => act({ action: "rest", days: 7 }, "Rested")}
            >
              Rest 7 days
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => act({ action: "wake" }, "Back in use:")}
            >
              Back in use
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    `Take back ${chosen.length} number(s)? They rest ${data.trunk.didCoolingDays} days before anyone else can have them.`,
                  )
                ) {
                  void act({ action: "release" }, "Took back");
                }
              }}
            >
              Take back
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => act({ action: "block" }, "Blocked")}
            >
              Block
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => act({ action: "unblock" }, "Unblocked")}
            >
              Unblock
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs text-destructive"
              disabled={busy}
              onClick={() => {
                if (confirm(`Retire ${chosen.length} number(s) for good?`))
                  void act({ action: "retire" }, "Retired");
              }}
            >
              Retire
            </Button>
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        {data.numbers.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No numbers yet. Click <span className="font-medium">Add numbers</span> and paste the
            list the vendor sent.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 w-8">
                  <Checkbox
                    checked={allShown}
                    onCheckedChange={(v) =>
                      setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                    aria-label="Select all shown"
                  />
                </th>
                <th className="py-2 pr-3 font-medium">Number</th>
                <th className="py-2 pr-3 font-medium">
                  <Explained k="didStatus">Status</Explained>
                </th>
                <th className="py-2 pr-3 font-medium">Company</th>
                <th className="py-2 pr-3 font-medium">Used for</th>
                <th className="py-2 pr-3 font-medium text-right">
                  <Explained k="didCallsToday">Today</Explained>
                </th>
                <th className="py-2 pr-3 font-medium text-right">
                  <Explained k="didPickUp">Picked up (7d)</Explained>
                </th>
                <th className="py-2 pr-3 font-medium">
                  <Explained k="didHealth">Health</Explained>
                </th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-2">
                    <Checkbox
                      checked={selected.has(n.id)}
                      onCheckedChange={(v) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (v) next.add(n.id);
                          else next.delete(n.id);
                          return next;
                        })
                      }
                      aria-label={`Select ${n.number}`}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <span className="font-mono">{n.number}</span>
                    {n.label && (
                      <span className="ml-2 text-xs text-muted-foreground">{n.label}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge
                      variant={STATUS_META[n.status].variant}
                      className="text-[11px] font-normal"
                    >
                      {statusText(n)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3">
                    {n.clientName ?? <span className="text-muted-foreground">—</span>}
                    {n.portfolioName && (
                      <div className="text-[11px] text-muted-foreground">
                        only {n.portfolioName}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {n.use === "both"
                      ? "Out + in"
                      : n.use === "outbound"
                        ? "Outgoing only"
                        : "Incoming only"}
                    {n.vendorQueue && (
                      <div className="text-[11px] text-muted-foreground">queue {n.vendorQueue}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {n.callsToday}
                    <span className="text-muted-foreground">
                      /{n.dailyCap ?? data.trunk.defaultDidDailyCap}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pickUp(n)}
                    {n.calls7d > 0 && (
                      <div className="text-[11px] text-muted-foreground">of {n.calls7d}</div>
                    )}
                  </td>
                  <td className={`py-2 pr-3 text-xs ${HEALTH_META[n.health].className}`}>
                    {HEALTH_META[n.health].label}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setHistoryOf(n)}
                      aria-label="Who held this number"
                    >
                      <History className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      <AddNumbersDialog open={adding} onClose={() => setAdding(false)} onAdded={onChanged} />
      <EditNumbersDialog
        open={editing}
        rows={chosen}
        onClose={() => setEditing(false)}
        onSave={async (change) => {
          setEditing(false);
          await act(change, "Changed");
        }}
      />
      <HistoryDialog row={historyOf} onClose={() => setHistoryOf(null)} />
    </Card>
  );
}

function AddNumbersDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await addNumbers({
        data: { accessToken: await getAccessToken(), text, label: label.trim() || null },
      });
      toast.success(
        `Added ${r.added}${r.alreadyThere ? ` · ${r.alreadyThere} already in the list` : ""}${r.unreadable.length ? ` · couldn't read ${r.unreadable.length}` : ""}`,
      );
      if (r.unreadable.length) toast.warning(`Not numbers: ${r.unreadable.slice(0, 8).join(", ")}`);
      setText("");
      setLabel("");
      onClose();
      await onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add numbers");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add phone numbers</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Paste the numbers from the vendor — one per line, or separated by commas. 0, 91 and +91
            in front are fine. New numbers start as free; give them to companies afterwards.
          </p>
          <Textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"07971367665\n07971367666"}
            className="font-mono text-xs"
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional), e.g. Mumbai batch Oct"
            className="h-8 text-xs"
          />
          <Button size="sm" disabled={saving || !text.trim()} onClick={save} className="gap-1">
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditNumbersDialog({
  open,
  rows,
  onClose,
  onSave,
}: {
  open: boolean;
  rows: NumberRow[];
  onClose: () => void;
  onSave: (change: {
    action: "edit";
    use?: "outbound" | "inbound" | "both";
    vendorQueue?: string | null;
    dailyCap?: number | null;
    label?: string | null;
    portfolioId?: string | null;
  }) => Promise<void>;
}) {
  const one = rows.length === 1 ? rows[0] : null;
  const owners = [...new Set(rows.map((r) => r.clientId))];
  const owner = owners.length === 1 ? owners[0] : null;
  const [use, setUse] = useState<string>("keep");
  const [queue, setQueue] = useState("");
  const [cap, setCap] = useState("");
  const [label, setLabel] = useState("");
  const [portfolio, setPortfolio] = useState("keep");
  const [portfolios, setPortfolios] = useState<Array<{ id: string; lender_name: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setUse("keep");
    setQueue(one?.vendorQueue ?? "");
    setCap(one?.dailyCap ? String(one.dailyCap) : "");
    setLabel(one?.label ?? "");
    setPortfolio("keep");
    setPortfolios([]);
    if (owner) {
      void (async () => {
        try {
          setPortfolios(
            await getCompanyPortfoliosForNumbers({
              data: { accessToken: await getAccessToken(), clientId: owner },
            }),
          );
        } catch {
          // The portfolio picker just stays empty.
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    const change: Parameters<typeof onSave>[0] = { action: "edit" };
    if (use !== "keep") change.use = use as "outbound" | "inbound" | "both";
    if (one || queue.trim()) change.vendorQueue = queue.trim() || null;
    if (one || cap.trim()) change.dailyCap = cap.trim() ? Number(cap) : null;
    if (one || label.trim()) change.label = label.trim() || null;
    if (portfolio !== "keep") change.portfolioId = portfolio === "none" ? null : portfolio;
    void onSave(change);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{one ? `Edit ${one.number}` : `Edit ${rows.length} numbers`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          {!one && (
            <p className="text-muted-foreground">Only the fields you fill in are changed.</p>
          )}
          <div className="space-y-1">
            <p className="text-muted-foreground">Used for</p>
            <Select value={use} onValueChange={setUse}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">Keep as is</SelectItem>
                <SelectItem value="both">Outgoing and incoming</SelectItem>
                <SelectItem value="outbound">Outgoing only</SelectItem>
                <SelectItem value="inbound">Incoming only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">Vendor queue (incoming calls ring this queue)</p>
            <Input
              value={queue}
              onChange={(e) => setQueue(e.target.value)}
              placeholder="e.g. 3011"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">Calls per day limit (blank = platform default)</p>
            <Input
              type="number"
              min={1}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">Label</p>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">
              Only for one portfolio (a lender wanting its own numbers)
            </p>
            <Select value={portfolio} onValueChange={setPortfolio} disabled={!owner}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={owner ? "Keep as is" : "Pick numbers of one company"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">Keep as is</SelectItem>
                <SelectItem value="none">Any of the company's portfolios</SelectItem>
                {portfolios.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.lender_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={submit}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ row, onClose }: { row: NumberRow | null; onClose: () => void }) {
  const [items, setItems] = useState<Array<{
    clientName: string;
    assignedAt: string;
    releasedAt: string | null;
  }> | null>(null);
  useEffect(() => {
    if (!row) return;
    setItems(null);
    void (async () => {
      try {
        setItems(
          await getNumberHistory({ data: { accessToken: await getAccessToken(), didId: row.id } }),
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load history");
        setItems([]);
      }
    })();
  }, [row]);
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1">
            Who held {row?.number}
            <InfoTip k="coolingOff" />
          </DialogTitle>
        </DialogHeader>
        {!items ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Never given to a company.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {items.map((h, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{h.clientName}</span>
                <span className="text-xs text-muted-foreground">
                  {fmtDate(h.assignedAt)} – {h.releasedAt ? fmtDate(h.releasedAt) : "now"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
