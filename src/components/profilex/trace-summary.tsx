// Condensed, read-only view of whatever a manager's trace turned up — employer, employment
// status, UAN, demographics, discovered numbers.
//
// Separate from TracePanel because the two answer different questions. TracePanel is the
// manager's console: per-service cards, prices, Run buttons. This is what an agent needs while
// the debtor is on the phone — everything at a glance, nothing to click, no mention of cost.
// Rendered in the live call, the call-queue profile sheet, and the debtor profile.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Search } from "lucide-react";
import {
  TRACES_UPDATED,
  latestByService,
  readEmployment,
  readPrefill,
  readUan,
  refreshTraces,
} from "@/lib/profilex-store";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-medium text-foreground mt-0.5">{value}</div>
    </div>
  );
}

/**
 * @param variant "panel" draws its own heading and border (call queue / live call);
 *                "bare" renders just the fields, for somewhere that already has a heading.
 */
export function TraceSummary({
  debtorId,
  variant = "panel",
}: {
  debtorId: string;
  variant?: "panel" | "bare";
}) {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    // A failure here is silent by design: this is a supplementary panel beside a live call, and
    // an error toast mid-call over missing trace data would be noise the agent can't act on.
    refreshTraces(debtorId).catch(() => {});
    window.addEventListener(TRACES_UPDATED, rerender);
    return () => window.removeEventListener(TRACES_UPDATED, rerender);
  }, [debtorId, rerender]);

  const latest = latestByService(debtorId);
  const employment =
    readEmployment(latest.get("employment-latest")?.response ?? null) ??
    readEmployment(latest.get("employment-history")?.response ?? null);
  const uan = readUan(latest.get("mobile-to-uan")?.response ?? null);
  const prefill = readPrefill(latest.get("mobile-to-prefill-ext")?.response ?? null);
  const traced =
    latest.get("employment-latest")?.createdAt ?? latest.get("mobile-to-uan")?.createdAt;

  const hasAnything = employment?.employer || uan || prefill.age || prefill.state;

  if (!hasAnything) {
    if (variant === "bare") {
      return (
        <p className="text-xs text-muted-foreground italic">
          No trace on file. A manager can run one from the debtor's Trace tab.
        </p>
      );
    }
    return null; // Don't take up space beside a live call when there is nothing to show.
  }

  const body = (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {employment?.employer && <Field label="Employer" value={employment.employer} />}
        {employment?.isEmployed !== null && employment?.isEmployed !== undefined && (
          <Field
            label="Employed"
            value={
              <Badge variant={employment.isEmployed ? "default" : "secondary"}>
                {employment.isEmployed ? "Yes" : "No"}
              </Badge>
            }
          />
        )}
        {employment?.dateOfJoining && <Field label="Joined" value={employment.dateOfJoining} />}
        {employment?.dateOfExit && <Field label="Exit marked" value={employment.dateOfExit} />}
        {uan && <Field label="UAN" value={uan} />}
        {prefill.age && <Field label="Age" value={prefill.age} />}
        {prefill.state && <Field label="State" value={prefill.state} />}
      </div>

      {employment && employment.history.length > 1 && (
        <div className="mt-3 pt-3 border-t border-border/60">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            Previous employers
          </div>
          {employment.history.slice(1, 4).map((h, i) => (
            <div key={i} className="text-xs text-muted-foreground">
              {h.employer}
              {h.dateOfExit && ` · left ${h.dateOfExit}`}
            </div>
          ))}
        </div>
      )}

      {traced && (
        <p className="text-[10px] text-muted-foreground mt-2">
          Traced {new Date(traced).toLocaleDateString("en-IN")}
        </p>
      )}
    </>
  );

  if (variant === "bare") return <div>{body}</div>;

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        {employment?.employer ? (
          <Briefcase className="h-3.5 w-3.5 text-primary" />
        ) : (
          <Search className="h-3.5 w-3.5 text-primary" />
        )}
        <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
          Trace
        </span>
      </div>
      {body}
    </div>
  );
}
