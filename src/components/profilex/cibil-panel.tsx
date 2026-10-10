// CIBIL report on a debtor's Insights tab — company admins only (trace-panel.tsx renders it for
// role "admin"; the server refuses everyone else regardless). The form opens prefilled from the
// bank file and earlier lookups; the admin fills whatever is missing (usually PAN) and pulls.
// Reports are read from cibil_reports through the server, never from debtor_traces.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, IndianRupee, Loader2, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/lib/access-token";
import { flatten } from "@/lib/profilex/flatten";
import {
  getCibilPanel,
  getCibilReportData,
  runCibilReport,
  type CibilPanelState,
  type CibilReportSummary,
} from "@/lib/cibil-actions.server";
import {
  CIBIL_ADDRESS_TYPES,
  CIBIL_STATES,
  validateCibilForm,
  type CibilForm,
} from "@/lib/cibil/payprime";

const rupees = (n: number) => `₹${n.toFixed(2)}`;

const selectClass =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground";

function Field({
  label,
  error,
  children,
  wide,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={cn("block space-y-1", wide && "sm:col-span-2")}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
      {error && <span className="block text-[10px] text-destructive">{error}</span>}
    </label>
  );
}

function ReportFields({ report }: { report: CibilReportSummary }) {
  const [open, setOpen] = useState(false);
  const [leaves, setLeaves] = useState<{ label: string; value: string }[] | null>(null);

  const toggle = async () => {
    if (!open && leaves === null) {
      try {
        const res = await getCibilReportData({
          data: { accessToken: await getAccessToken(), reportId: report.id },
        });
        // Start at cibilData: the envelope (status, txn id, htmlUrl) is shown above, and
        // flatten() stops at depth 6, which CIBIL's nesting reaches quickly.
        const r = res.response as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
        const inner = r?.data?.data ?? r?.data ?? r;
        setLeaves(flatten(inner?.cibilData ?? inner));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load the report");
        return;
      }
    }
    setOpen((o) => !o);
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        {open ? "Hide" : "Show"} all fields returned
      </button>
      {open && leaves && (
        <div className="mt-2 max-h-80 overflow-y-auto rounded border border-border/60">
          {leaves.length === 0 ? (
            <p className="p-2 text-[11px] text-muted-foreground">No structured fields.</p>
          ) : (
            leaves.map((l, i) => (
              <div
                key={i}
                className="flex justify-between gap-4 px-2 py-1 border-b border-border/40 last:border-0"
              >
                <span className="text-[11px] text-muted-foreground">{l.label}</span>
                <span className="text-[11px] text-foreground text-right break-all">{l.value}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function CibilPanel({ debtorId, debtorName }: { debtorId: string; debtorName: string }) {
  const [panel, setPanel] = useState<CibilPanelState | null>(null);
  const [form, setForm] = useState<CibilForm | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getCibilPanel({
        data: { accessToken: await getAccessToken(), debtorId },
      });
      setPanel(res);
      setForm(res.prefill);
    } catch {
      setPanel(null); // not an admin, or the server refused — show nothing
    }
  }, [debtorId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!panel || !form) return null;
  // Not on the plan and never pulled: nothing to show this company.
  if (panel.blockedReason && panel.reports.length === 0) return null;

  const errors = validateCibilForm(form);
  const valid = Object.keys(errors).length === 0;
  const latest = panel.reports[0];
  const set = <K extends keyof CibilForm>(k: K, v: CibilForm[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const pull = async () => {
    setConfirming(false);
    setRunning(true);
    try {
      const res = await runCibilReport({
        data: {
          accessToken: await getAccessToken(),
          debtorId,
          form,
          // The admin opened the form and confirmed a charge: always a fresh pull.
          force: true,
        },
      });
      toast.success(
        res.cached
          ? "CIBIL report: served from an earlier pull"
          : `CIBIL report pulled · ${rupees(res.cost)}`,
      );
      setShowForm(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "CIBIL report failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-primary" />
            CIBIL Report
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 font-normal">
              Admins only
            </span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Credit score, loans and cards, repayment history and recent enquiries. Only admins can
            see it.
          </p>
        </div>
        {!panel.blockedReason && !showForm && (
          <Button
            size="sm"
            variant={latest ? "outline" : "default"}
            className="flex-shrink-0 h-7 text-xs"
            onClick={() => setShowForm(true)}
          >
            {latest ? "Pull again" : "Pull report"}
          </Button>
        )}
      </div>

      {panel.blockedReason && (
        <p className="text-[11px] text-muted-foreground mb-2">{panel.blockedReason}</p>
      )}

      {!panel.blockedReason && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-2">
          <IndianRupee className="h-3 w-3" />
          {rupees(panel.price)} per report
        </p>
      )}

      {showForm && (
        <div className="mb-3 rounded-md border border-border/60 bg-muted/20 p-3">
          <p className="text-[11px] text-muted-foreground mb-2">
            Filled in from the bank file and earlier lookups where available — check it and add what
            is missing. The mobile number on file is used.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="First name" error={touched ? errors.firstName : undefined}>
              <Input
                className="h-8 text-xs"
                value={form.firstName}
                onChange={(e) => set("firstName", e.target.value)}
              />
            </Field>
            <Field label="Last name" error={touched ? errors.lastName : undefined}>
              <Input
                className="h-8 text-xs"
                value={form.lastName}
                onChange={(e) => set("lastName", e.target.value)}
              />
            </Field>
            <Field label="PAN" error={touched ? errors.pan : undefined}>
              <Input
                className="h-8 text-xs uppercase"
                maxLength={10}
                value={form.pan}
                onChange={(e) => set("pan", e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Date of birth" error={touched ? errors.dob : undefined}>
              <Input
                type="date"
                className="h-8 text-xs"
                value={form.dob}
                onChange={(e) => set("dob", e.target.value)}
              />
            </Field>
            <Field label="Gender" error={touched ? errors.gender : undefined}>
              <select
                className={selectClass}
                value={form.gender}
                onChange={(e) => set("gender", e.target.value as CibilForm["gender"])}
              >
                <option value="">Choose…</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </select>
            </Field>
            <Field label="Email" error={touched ? errors.email : undefined}>
              <Input
                type="email"
                className="h-8 text-xs"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </Field>
            <Field
              label="Residential address"
              error={touched ? errors.streetAddress : undefined}
              wide
            >
              <Input
                className="h-8 text-xs"
                value={form.streetAddress}
                onChange={(e) => set("streetAddress", e.target.value)}
              />
            </Field>
            <Field label="City" error={touched ? errors.city : undefined}>
              <Input
                className="h-8 text-xs"
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
              />
            </Field>
            <Field label="PIN code" error={touched ? errors.postalCode : undefined}>
              <Input
                className="h-8 text-xs"
                inputMode="numeric"
                maxLength={6}
                value={form.postalCode}
                onChange={(e) => set("postalCode", e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label="State" error={touched ? errors.region : undefined}>
              <select
                className={selectClass}
                value={form.region}
                onChange={(e) => set("region", e.target.value)}
              >
                <option value="">Choose…</option>
                {CIBIL_STATES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Address type" error={touched ? errors.addressType : undefined}>
              <select
                className={selectClass}
                value={form.addressType}
                onChange={(e) => set("addressType", e.target.value)}
              >
                {CIBIL_ADDRESS_TYPES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={running}
              onClick={() => {
                setTouched(true);
                if (valid) setConfirming(true);
              }}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                `Pull report · ${rupees(panel.price)}`
              )}
            </Button>
          </div>
        </div>
      )}

      {latest ? (
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] text-muted-foreground">CIBIL score</p>
              <p className="text-2xl font-semibold text-foreground">{latest.score ?? "—"}</p>
            </div>
            {latest.htmlUrl && (
              <a
                href={latest.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                Open full report <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <ReportFields report={latest} />
          <p className="text-[10px] text-muted-foreground mt-2">
            {new Date(latest.createdAt).toLocaleString("en-IN")}
            {latest.requestedByName && ` · ${latest.requestedByName}`}
            {latest.txnId && ` · ${latest.txnId}`}
            {panel.reports.length > 1 && ` · ${panel.reports.length - 1} earlier`}
          </p>
        </div>
      ) : (
        !showForm &&
        !panel.blockedReason && (
          <p className="text-xs text-muted-foreground italic">Not pulled yet.</p>
        )
      )}

      <AlertDialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pull {debtorName}'s CIBIL report?</AlertDialogTitle>
            <AlertDialogDescription>
              Costs {rupees(panel.price)}. The request tells the bureau the borrower has consented,
              under your company's agreement with SamvadX. Only admins will see the report.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void pull()}>Pull report</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
