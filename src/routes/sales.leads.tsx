import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  FileDown,
  FileUp,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { createLead, importLeads } from "@/lib/sales.server";
import { downloadXlsx } from "@/lib/xlsx-export";
import { parseCsvText } from "@/lib/utils";
import {
  AGENT_BANDS,
  followUpState,
  SALES_SOURCES,
  SALES_STAGES,
  sourceLabel,
  stageLabel,
} from "@/lib/sales/sales-rules";
import { fmtDate, fmtMoney, personName, useSalesList } from "@/lib/sales/sales-store";
import { todayIstKey } from "@/lib/date-filter";

type Search = { new?: string };

export const Route = createFileRoute("/sales/leads")({
  head: () => ({ meta: [{ title: "Leads · SamvadX Sales" }] }),
  validateSearch: (s: Record<string, unknown>): Search => ({
    new: typeof s.new === "string" ? s.new : undefined,
  }),
  component: SalesLeadsPage,
});

function SalesLeadsPage() {
  const list = useSalesList();
  const initial = useSearch({ from: "/sales/leads" });
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<string>("open");
  const [source, setSource] = useState<string>("all");
  const [owner, setOwner] = useState<string>("all");
  const [newOpen, setNewOpen] = useState(initial.new === "1");
  const [importOpen, setImportOpen] = useState(false);

  const today = todayIstKey();
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.leads.filter((l) => {
      if (stage === "open") {
        if (l.stage === "won" || l.stage === "lost") return false;
      } else if (stage !== "all" && l.stage !== stage) return false;
      if (source !== "all" && l.source !== source) return false;
      if (owner === "mine") {
        if (list.me?.kind === "sales" ? l.owner_id !== list.me.salesUserId : false) return false;
      } else if (owner === "unassigned") {
        if (l.owner_id !== null) return false;
      } else if (owner !== "all" && l.owner_id !== owner) return false;
      if (needle) {
        const hay = `${l.company_name} ${l.contact_name ?? ""} ${l.phone ?? ""} ${l.email ?? ""} ${l.city ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [list.leads, q, stage, source, owner, list.me]);

  function exportExcel() {
    downloadXlsx(`samvadx-sales-leads-${todayIstKey()}.xlsx`, [
      {
        name: "Leads",
        headers: [
          "Company",
          "Contact",
          "Phone",
          "Email",
          "City",
          "Stage",
          "Source",
          "Owner",
          "Deal / month",
          "Next follow-up",
          "Added",
        ],
        rows: filtered.map((l) => [
          l.company_name,
          l.contact_name ?? "",
          l.phone ?? "",
          l.email ?? "",
          l.city ?? "",
          stageLabel(l.stage),
          sourceLabel(l.source),
          personName(list.people, l.owner_id),
          l.deal_monthly ?? "",
          l.next_follow_up ?? "",
          fmtDate(l.created_at),
        ]),
      },
    ]);
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leads & Prospects</h1>
          <p className="text-xs text-muted-foreground">
            {filtered.length} of {list.leads.length} leads
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={exportExcel}>
            <FileDown className="h-3.5 w-3.5" /> Excel
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setImportOpen(true)}>
            <FileUp className="h-3.5 w-3.5" /> Import
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New lead
          </Button>
        </div>
      </header>

      {list.error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {list.error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, contact, phone…"
            className="h-8 w-64 pl-7 text-xs"
          />
          {q && (
            <button className="absolute right-2 top-2 text-muted-foreground" onClick={() => setQ("")}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <TinySelect value={stage} onChange={setStage} options={[
          ["open", "Open"],
          ["all", "All stages"],
          ...SALES_STAGES.map((s) => [s.key, s.label] as [string, string]),
        ]} />
        <TinySelect value={source} onChange={setSource} options={[
          ["all", "Any source"],
          ...SALES_SOURCES.map((s) => [s.key, s.label] as [string, string]),
        ]} />
        <TinySelect value={owner} onChange={setOwner} options={[
          ["all", "Any owner"],
          ...(list.me?.kind === "sales" ? [["mine", "Mine"] as [string, string]] : []),
          ["unassigned", "Unassigned"],
          ...list.people.filter((p) => p.is_active).map((p) => [p.id, p.name] as [string, string]),
        ]} />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Contact</th>
              <th className="px-3 py-2 font-medium">Phone</th>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Follow-up</th>
              <th className="px-3 py-2 font-medium text-right">Deal / mo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No leads match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((l) => {
                const fu = followUpState(l.next_follow_up, today);
                return (
                  <tr key={l.id} className="hover:bg-accent/30">
                    <td className="px-3 py-2">
                      <Link to="/sales/leads/$id" params={{ id: l.id }} className="font-medium text-foreground hover:underline">
                        {l.company_name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.contact_name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{l.phone ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="text-[11px]">{stageLabel(l.stage)}</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{personName(list.people, l.owner_id)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{sourceLabel(l.source)}</td>
                    <td className="px-3 py-2">
                      {l.next_follow_up ? (
                        <span
                          className={
                            fu === "overdue"
                              ? "text-destructive"
                              : fu === "today"
                                ? "font-medium text-foreground"
                                : "text-muted-foreground"
                          }
                        >
                          {fmtDate(l.next_follow_up)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.deal_monthly)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <NewLeadDialog open={newOpen} onClose={() => setNewOpen(false)} onSaved={list.reload} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={list.reload} />
    </div>
  );
}

function TinySelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[140px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v} className="text-xs">
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewLeadDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const empty = {
    company_name: "",
    contact_name: "",
    phone: "",
    email: "",
    city: "",
    agents_band: "",
    deal_monthly: "",
    notes: "",
  };
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!form.company_name.trim()) {
      toast.error("Company name is required.");
      return;
    }
    setSaving(true);
    try {
      const token = await getAccessToken();
      const r = await createLead({
        data: {
          accessToken: token,
          lead: {
            company_name: form.company_name.trim(),
            contact_name: form.contact_name.trim() || null,
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            city: form.city.trim() || null,
            agents_band: form.agents_band || null,
            deal_monthly: form.deal_monthly ? Number(form.deal_monthly) : null,
            notes: form.notes.trim() || null,
            source: "manual",
          },
        },
      });
      if (!r.ok) {
        toast.error(`A lead with that phone already exists: ${r.duplicate.company}`);
      } else {
        toast.success("Lead added");
        setForm(empty);
        await onSaved();
        onClose();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Field label="Company *" value={form.company_name} onChange={(v) => setForm({ ...form, company_name: v })} />
          <Field label="Contact" value={form.contact_name} onChange={(v) => setForm({ ...form, contact_name: v })} />
          <Field label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
          <Field label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Team size</span>
            <Select value={form.agents_band} onValueChange={(v) => setForm({ ...form, agents_band: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {AGENT_BANDS.map((b) => (
                  <SelectItem key={b} value={b} className="text-xs">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Field label="Deal value / month (₹)" value={form.deal_monthly} onChange={(v) => setForm({ ...form, deal_monthly: v.replace(/[^0-9]/g, "") })} />
          <label className="col-span-2 block">
            <span className="mb-1 block text-xs text-muted-foreground">Notes</span>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs" />
    </label>
  );
}

function ImportDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [source, setSource] = useState("import");
  const [unassigned, setUnassigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: { row: number; reason: string }[] } | null>(null);

  async function read(file: File) {
    setFileName(file.name);
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith(".csv") || name.endsWith(".tsv") || file.type === "text/csv") {
        const text = await file.text();
        const parsed = parseCsvText(text);
        if (parsed.length === 0) {
          setRows([]);
          return;
        }
        const [headers, ...body] = parsed;
        setRows(body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))));
      } else if (name.endsWith(".xlsx")) {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const ws = wb.worksheets[0];
        if (!ws) {
          setRows([]);
          return;
        }
        const headers: string[] = [];
        ws.getRow(1).eachCell((c, i) => (headers[i - 1] = String(c.value ?? "")));
        const body: Record<string, string>[] = [];
        for (let i = 2; i <= ws.rowCount; i++) {
          const row: Record<string, string> = {};
          ws.getRow(i).eachCell((c, j) => {
            const h = headers[j - 1] ?? `col${j}`;
            row[h] = c.value == null ? "" : typeof c.value === "object" && "text" in c.value ? String((c.value as { text: string }).text) : String(c.value);
          });
          if (Object.values(row).some((v) => v)) body.push(row);
        }
        setRows(body);
      } else {
        toast.error("Pick a .csv or .xlsx file.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function doImport() {
    if (!rows) return;
    setBusy(true);
    try {
      const token = await getAccessToken();
      const r = await importLeads({ data: { accessToken: token, rows, source: source as "import" | "website" | "manual" | "signup" | "referral" | "event" | "other", unassigned } });
      setResult(r);
      await onDone();
      toast.success(`Added ${r.created} lead${r.created === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setRows(null);
    setFileName(null);
    setResult(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import leads</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            CSV or Excel (.xlsx). Headers we understand: Timestamp / Date, Name, Agency / Company, Phone / Mobile, Email, Agents, City. Other columns are kept as notes. Phones already in the list are skipped.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.xlsx,text/csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && read(e.target.files[0])}
            />
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              Pick file
            </Button>
            {fileName && (
              <span className="text-xs text-muted-foreground">{fileName}{rows ? ` — ${rows.length} rows` : ""}</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Mark source as</span>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SALES_SOURCES.map((s) => (
                    <SelectItem key={s.key} value={s.key} className="text-xs">
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 pt-5 text-xs">
              <input
                type="checkbox"
                checked={unassigned}
                onChange={(e) => setUnassigned(e.target.checked)}
              />
              Leave unassigned (otherwise they're assigned to you)
            </label>
          </div>
          {result && (
            <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
              <div className="font-medium">Added: {result.created}</div>
              {result.skipped.length > 0 && (
                <>
                  <div className="mt-1">Skipped {result.skipped.length}:</div>
                  <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5">
                    {result.skipped.slice(0, 50).map((s, i) => (
                      <li key={i}>
                        Row {s.row}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button onClick={doImport} disabled={!rows || busy}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Import {rows?.length ?? 0} rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

