// CIBIL report for one borrower, on the borrower's Insights tab (trace-panel.tsx). Shows nothing
// at all while the company's CIBIL switch is off. Managers pull (the form opens prefilled from
// the bank file and earlier lookups — Skip Tracing supplies the PAN); the assigned agent and the
// manager both see the result. The server decides all of it (cibil-actions.server.ts).
//
// Also exports the form fields and the report view that Admin → Insights' manual CIBIL uses.
import { useCallback, useEffect, useState } from "react";
import { Download, FileText, IndianRupee, Loader2, ChevronRight } from "lucide-react";
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
  downloadCibilReport,
  getCibilBorrower,
  getCibilReportData,
  runCibilBorrower,
  type CibilBorrowerState,
  type CibilReportSummary,
} from "@/lib/cibil-actions.server";
import {
  CIBIL_ADDRESS_TYPES,
  CIBIL_REQUIRED,
  CIBIL_STATES,
  validateCibilForm,
  type CibilForm,
} from "@/lib/cibil/payprime";

export const rupees = (n: number) => `₹${n.toFixed(2)}`;

/** Save a report on the user's computer as an .html file (opens in any browser; print → PDF). */
export async function saveCibilReportFile(reportId: string): Promise<void> {
  const { fileName, html } = await downloadCibilReport({
    data: { accessToken: await getAccessToken(), reportId },
  });
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function DownloadReportButton({ reportId }: { reportId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs gap-1"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await saveCibilReportFile(reportId);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not download the report");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      Download
    </Button>
  );
}

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

export const EMPTY_CIBIL_FORM: CibilForm = {
  firstName: "",
  lastName: "",
  pan: "",
  dob: "",
  gender: "",
  email: "",
  streetAddress: "",
  city: "",
  postalCode: "",
  region: "",
  addressType: "1",
};

/** The details PayPrime needs. `showErrors` once the user has tried to submit. */
export function CibilFormFields({
  form,
  onChange,
  showErrors,
  panHint,
}: {
  form: CibilForm;
  onChange: (f: CibilForm) => void;
  showErrors: boolean;
  panHint?: string;
}) {
  const errors = showErrors ? validateCibilForm(form) : {};
  // "PAN *" for what PayPrime needs, "(optional)" for the rest.
  const L = (key: keyof CibilForm, text: string) =>
    CIBIL_REQUIRED.includes(key) ? `${text} *` : `${text} (optional)`;
  const set = <K extends keyof CibilForm>(k: K, v: CibilForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <Field label={L("firstName", "First name")} error={errors.firstName}>
        <Input
          className="h-8 text-xs"
          value={form.firstName}
          onChange={(e) => set("firstName", e.target.value)}
        />
      </Field>
      <Field label={L("lastName", "Last name")} error={errors.lastName}>
        <Input
          className="h-8 text-xs"
          value={form.lastName}
          onChange={(e) => set("lastName", e.target.value)}
        />
      </Field>
      <Field label={L("pan", "PAN")} error={errors.pan ?? (!form.pan ? panHint : undefined)}>
        <Input
          className="h-8 text-xs uppercase"
          maxLength={10}
          value={form.pan}
          onChange={(e) => set("pan", e.target.value.toUpperCase())}
        />
      </Field>
      <Field label={L("dob", "Date of birth")} error={errors.dob}>
        <Input
          type="date"
          className="h-8 text-xs"
          value={form.dob}
          onChange={(e) => set("dob", e.target.value)}
        />
      </Field>
      <Field label={L("gender", "Gender")} error={errors.gender}>
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
      <Field label={L("email", "Email")} error={errors.email}>
        <Input
          type="email"
          className="h-8 text-xs"
          value={form.email}
          onChange={(e) => set("email", e.target.value)}
        />
      </Field>
      <Field label={L("streetAddress", "Residential address")} error={errors.streetAddress} wide>
        <Input
          className="h-8 text-xs"
          value={form.streetAddress}
          onChange={(e) => set("streetAddress", e.target.value)}
        />
      </Field>
      <Field label={L("city", "City")} error={errors.city}>
        <Input
          className="h-8 text-xs"
          value={form.city}
          onChange={(e) => set("city", e.target.value)}
        />
      </Field>
      <Field label={L("postalCode", "PIN code")} error={errors.postalCode}>
        <Input
          className="h-8 text-xs"
          inputMode="numeric"
          maxLength={6}
          value={form.postalCode}
          onChange={(e) => set("postalCode", e.target.value.replace(/\D/g, ""))}
        />
      </Field>
      <Field label={L("region", "State")} error={errors.region}>
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
      <Field label={L("addressType", "Address type")} error={errors.addressType}>
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

/** Score, link to the full report and every field returned. */
export function CibilReportView({
  report,
  earlier = 0,
}: {
  report: CibilReportSummary;
  earlier?: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] text-muted-foreground">CIBIL score</p>
          <p className="text-2xl font-semibold text-foreground">{report.score ?? "—"}</p>
        </div>
        <DownloadReportButton reportId={report.id} />
      </div>
      <ReportFields report={report} />
      <p className="text-[10px] text-muted-foreground mt-2">
        {new Date(report.createdAt).toLocaleString("en-IN")}
        {report.requestedByName && ` · ${report.requestedByName}`}
        {report.txnId && ` · ${report.txnId}`}
        {earlier > 0 && ` · ${earlier} earlier`}
      </p>
    </div>
  );
}

export function CibilPanel({
  debtorId,
  debtorName,
  showCost,
}: {
  debtorId: string;
  debtorName: string;
  /** Prices are shown to admins only, like every other lookup on this tab (trace-panel.tsx). */
  showCost: boolean;
}) {
  const [state, setState] = useState<CibilBorrowerState | null>(null);
  const [form, setForm] = useState<CibilForm | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getCibilBorrower({
        data: { accessToken: await getAccessToken(), debtorId },
      });
      setState(res);
      setForm(res.prefill);
    } catch {
      setState(null);
    }
  }, [debtorId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The company's CIBIL switch is off (or this borrower isn't visible): show nothing at all.
  if (!state?.on) return null;
  // An agent with nothing pulled yet has nothing to see.
  if (!state.canRun && state.reports.length === 0) return null;

  const latest = state.reports[0];
  const valid = !!form && Object.keys(validateCibilForm(form)).length === 0;

  const pull = async () => {
    if (!form) return;
    setConfirming(false);
    setRunning(true);
    try {
      const res = await runCibilBorrower({
        data: { accessToken: await getAccessToken(), debtorId, form },
      });
      toast.success(showCost ? `CIBIL report pulled · ${rupees(res.cost)}` : "CIBIL report pulled");
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
          </p>
          <p className="text-[11px] text-muted-foreground">
            Credit score, loans and cards, repayment history and recent enquiries.
          </p>
        </div>
        {state.canRun && !showForm && (
          <Button
            size="sm"
            variant={latest ? "outline" : "default"}
            className="flex-shrink-0 h-7 text-xs"
            onClick={() => {
              setTouched(false);
              setShowForm(true);
            }}
          >
            {latest ? "Pull again" : "Pull report"}
          </Button>
        )}
      </div>

      {state.canRun && showCost && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-2">
          <IndianRupee className="h-3 w-3" />
          {rupees(state.price)} per report
        </p>
      )}

      {showForm && form && (
        <div className="mb-3 rounded-md border border-border/60 bg-muted/20 p-3">
          <p className="text-[11px] text-muted-foreground mb-2">
            Filled in from the bank file and earlier lookups — check it and add what is missing. The
            mobile number on file is used.
          </p>
          <CibilFormFields
            form={form}
            onChange={setForm}
            showErrors={touched}
            panHint="Not on file — run Skip Tracing first (it returns the PAN), or type it in."
          />
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
              ) : showCost ? (
                `Pull report · ${rupees(state.price)}`
              ) : (
                "Pull report"
              )}
            </Button>
          </div>
        </div>
      )}

      {latest ? (
        <CibilReportView report={latest} earlier={state.reports.length - 1} />
      ) : (
        !showForm && <p className="text-xs text-muted-foreground italic">Not pulled yet.</p>
      )}

      <AlertDialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pull {debtorName}'s CIBIL report?</AlertDialogTitle>
            <AlertDialogDescription>
              {showCost && `Costs ${rupees(state.price)}. `}
              The request tells the bureau the borrower has consented, under your company's
              agreement with SamvadX. The report will be visible to this borrower's agent and
              manager.
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
