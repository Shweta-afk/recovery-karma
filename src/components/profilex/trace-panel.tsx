// The Trace tab on a debtor profile. One component for both roles — DebtorProfile is shared
// between the agent view (dashboard.debtors.tsx) and the manager view (manager.queue.tsx), so
// the role gate lives here: managers and admins get the Run buttons, agents get the same
// results read-only. That is the whole shape of the feature — the manager spends, the agent
// working the account sees what came back.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Loader2, Search, IndianRupee } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { getProfilexSettings, runProfilexTrace } from "@/lib/profilex-actions.server";
import {
  PROFILEX_SERVICES,
  UAN_SOURCE_SERVICE,
  type ProfilexService,
} from "@/lib/profilex/catalogue";
import {
  TRACES_UPDATED,
  latestByService,
  mergeTrace,
  readEmployment,
  readPrefill,
  readUan,
  refreshTraces,
  type TraceRecord,
} from "@/lib/profilex-store";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-foreground text-right">{value ?? "—"}</span>
    </div>
  );
}

function priceLine(s: ProfilexService): string {
  const hit = s.defaultPrices["1"] ?? 0;
  const misses = Object.entries(s.defaultPrices).filter(([k]) => k !== "1");
  const miss = misses.length ? Math.min(...misses.map(([, v]) => v)) : 0;
  return miss === 0 ? `₹${hit} if found, free if not` : `₹${hit} if found, ₹${miss} if not`;
}

function ResultBody({ trace }: { trace: TraceRecord }) {
  if (trace.providerStatus && trace.providerStatus !== "1") {
    return (
      <p className="text-xs text-muted-foreground italic">
        No record found. This lookup was still billed.
      </p>
    );
  }

  if (trace.serviceId === UAN_SOURCE_SERVICE) {
    return <Row label="UAN" value={readUan(trace.response) ?? "—"} />;
  }

  if (trace.serviceId === "mobile-to-prefill-ext") {
    const prefill = readPrefill(trace.response);
    return (
      <>
        <Row label="Age" value={prefill.age ?? "—"} />
        <Row label="State" value={prefill.state ?? "—"} />
      </>
    );
  }

  const emp = readEmployment(trace.response);
  if (!emp) return <p className="text-xs text-muted-foreground italic">No details returned.</p>;
  return (
    <>
      <Row
        label="Currently employed"
        value={
          emp.isEmployed === null ? (
            "Unknown"
          ) : (
            <Badge variant={emp.isEmployed ? "default" : "secondary"}>
              {emp.isEmployed ? "Yes" : "No"}
            </Badge>
          )
        }
      />
      <Row label="Employer" value={emp.employer} />
      <Row label="Joined" value={emp.dateOfJoining} />
      <Row label="Exit marked" value={emp.dateOfExit || "—"} />
      {emp.history.length > 1 && (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1.5">
            Employment history
          </p>
          {emp.history.map((h, i) => (
            <div key={i} className="text-xs py-1.5 border-b border-border/50 last:border-0">
              <div className="font-medium text-foreground">{h.employer}</div>
              <div className="text-muted-foreground">
                {h.dateOfJoining || "?"} → {h.dateOfExit || "present"}
                {h.months != null && ` · ${h.months} months`}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TracePanel({ debtorId, debtorName }: { debtorId: string; debtorName: string }) {
  const { user } = useAuth();
  const canRun = user?.role === "manager" || user?.role === "admin";
  // Cost is an admin concern, not a manager's. A manager deciding whether this debtor is worth
  // looking up should weigh that on the merits of the account, not haggle with a price tag
  // mid-shift — and the budget that actually constrains spend is admin-set and server-enforced
  // anyway. Admins keep the figures, since they own the budget and the rate card.
  const showCost = user?.role === "admin";

  const [, bump] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ProfilexService | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Whether the org has ProfileX switched on at all. Until this is known the Run buttons stay
  // hidden: showing a manager a button that can only throw "lookups are turned off" reads as a
  // broken feature rather than an unconfigured one.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    if (!canRun) return;
    supabase.auth
      .getSession()
      .then(({ data: { session } }) =>
        session
          ? getProfilexSettings({ data: { accessToken: session.access_token } })
          : { enabled: false },
      )
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, [canRun]);

  useEffect(() => {
    refreshTraces(debtorId).catch((e) => setLoadError(e.message));
    window.addEventListener(TRACES_UPDATED, rerender);
    return () => window.removeEventListener(TRACES_UPDATED, rerender);
  }, [debtorId, rerender]);

  // Recomputed every render rather than memoised: the store is a module-level cache, so its
  // contents change without any prop or state this component could key a useMemo on — the
  // TRACES_UPDATED listener above is what triggers the re-render. It is a handful of rows.
  const latest = latestByService(debtorId);
  const hasUan = !!readUan(latest.get(UAN_SOURCE_SERVICE)?.response ?? null);

  async function run(service: ProfilexService) {
    setConfirming(null);
    setRunning(service.id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");

      const result = await runProfilexTrace({
        data: { accessToken: session.access_token, debtorId, serviceId: service.id },
      });
      if (result.trace) mergeTrace(result.trace);
      toast.success(
        result.cached
          ? `${service.label}: served from an earlier lookup`
          : showCost
            ? `${service.label} complete · ₹${result.cost.toFixed(2)}`
            : `${service.label} complete`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${service.label} failed`);
    } finally {
      setRunning(null);
    }
  }

  if (loadError) {
    return <p className="text-xs text-destructive">{loadError}</p>;
  }

  if (canRun && enabled === false && latest.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Search className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">Insights is not switched on</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          An admin can enable Insights and set a monthly budget under Settings.
        </p>
      </div>
    );
  }

  if (!canRun && latest.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Search className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">Nothing looked up yet</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          Ask your manager to look up {debtorName}. Anything they find shows up here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {PROFILEX_SERVICES.map((service) => {
        const trace = latest.get(service.id);
        const needsUan = service.input === "uan" && !hasUan;
        // Agents only ever see what has already been paid for.
        if (!(canRun && enabled === true) && !trace) return null;

        return (
          <div key={service.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">{service.label}</p>
                <p className="text-[11px] text-muted-foreground">{service.blurb}</p>
              </div>
              {canRun && enabled === true && (
                <Button
                  size="sm"
                  variant={trace ? "outline" : "default"}
                  disabled={running !== null || needsUan}
                  onClick={() => setConfirming(service)}
                  className="flex-shrink-0 h-7 text-xs"
                  title={needsUan ? "Run Mobile to UAN first" : service.blurb}
                >
                  {running === service.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : trace ? (
                    "Re-run"
                  ) : (
                    "Run"
                  )}
                </Button>
              )}
            </div>

            {canRun && enabled === true && (needsUan || showCost) && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-2">
                {!needsUan && <IndianRupee className="h-3 w-3" />}
                {needsUan ? "Needs a UAN — run Mobile to UAN first" : priceLine(service)}
              </p>
            )}

            {trace ? (
              <div>
                <ResultBody trace={trace} />
                <p className="text-[10px] text-muted-foreground mt-2">
                  {new Date(trace.createdAt).toLocaleString("en-IN")}
                  {showCost && trace.billable && ` · ₹${trace.cost.toFixed(2)}`}
                </p>
              </div>
            ) : (
              canRun &&
              enabled === true && (
                <p className="text-xs text-muted-foreground italic">Not looked up yet.</p>
              )
            )}
          </div>
        );
      })}

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run {confirming?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This looks up {debtorName}'s number with the data provider.
              {showCost &&
                confirming &&
                ` Costs ${priceLine(confirming)}, charged even when nothing is found.`}
              {latest.has(confirming?.id ?? "") &&
                " A recent result is already stored — if it is still within the cache window this will be served free."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && run(confirming)}>
              Run lookup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
