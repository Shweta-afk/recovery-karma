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
import { Loader2, Search, IndianRupee, ChevronRight, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { normalisePhone } from "@/lib/profilex/billing";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { getProfilexSettings, getMyWallet, runProfilexTrace } from "@/lib/profilex-actions.server";
import {
  PROFILEX_SERVICES,
  UAN_SOURCE_SERVICE,
  SKIP_TRACING_SERVICE,
  type ProfilexService,
} from "@/lib/profilex/catalogue";
import {
  TRACES_UPDATED,
  latestByService,
  mergeTrace,
  readEmployment,
  readPrefill,
  readUan,
  refreshTracesWhenAuthed,
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

// Envelope/plumbing keys that carry no information for an agent looking at a debtor.
const NOISE = new Set([
  "status",
  "statusCode",
  "message",
  "success",
  "timestamp",
  "transactionId",
  "packageVersion",
  "partial_output",
]);

/** snake_case / camelCase -> "Sentence case", with the acronyms this data is full of kept upper. */
function humanise(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter(Boolean);
  return words
    .map((w) =>
      /^(uan|pan|ifsc|dob|epfo|id|no|acc)$/i.test(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

interface Leaf {
  label: string;
  value: string;
}

/**
 * Every non-empty scalar in the response, flattened for display.
 *
 * The panel used to show only a hand-picked summary, which meant a manager paid for ~94 fields
 * and saw five — including things that matter for recovery like the debtor's father's name,
 * date of birth and bank branch. Anything paid for should be visible; the curated block above
 * stays as the scannable part, and this is everything else.
 */
function flatten(node: unknown, prefix = "", out: Leaf[] = [], depth = 0): Leaf[] {
  if (node === null || node === undefined || depth > 6) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) =>
      flatten(v, prefix ? `${prefix} ${i + 1}` : String(i + 1), out, depth + 1),
    );
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (NOISE.has(k)) continue;
      // A UAN-keyed map (uan_details) adds nothing but a long number to every label.
      const isIdKey = /^\d{8,}$/.test(k);
      flatten(v, isIdKey ? prefix : humanise(k), out, depth + 1);
    }
    return out;
  }
  const value = String(node).trim();
  if (!value || value === "null" || value === "undefined") return out;
  out.push({ label: prefix || "Value", value });
  return out;
}

function AllFields({ trace }: { trace: TraceRecord }) {
  const [open, setOpen] = useState(false);
  const leaves = flatten((trace.response as Record<string, unknown> | null)?.data);
  if (leaves.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        {open ? "Hide" : "Show"} all {leaves.length} fields returned
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {leaves.map((l, i) => (
            <div key={i} className="flex justify-between gap-3 py-0.5 text-[11px]">
              <span className="text-muted-foreground shrink-0">{l.label}</span>
              <span className="font-medium text-foreground text-right break-all">{l.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Alternate numbers / emails / addresses, from a Phone to Prefill payload (standalone, or the
 *  vrePhoneToPrefill block of the skip-tracing bundle — same shape either way). */
function ContactRows({ block }: { block: unknown }) {
  const b = block as
    | {
        alternatePhone?: { phoneNumber?: string }[];
        email?: { email?: string }[];
        address?: unknown[];
      }
    | null
    | undefined;
  if (!b || typeof b !== "object") return null;
  const phones = (b.alternatePhone ?? []).map((p) => p.phoneNumber).filter(Boolean) as string[];
  const emails = (b.email ?? []).map((e) => e.email).filter(Boolean) as string[];
  const addresses = (b.address ?? []).length;
  return (
    <>
      <Row label="Alternate numbers" value={phones.length ? phones.join(", ") : "—"} />
      <Row label="Emails" value={emails.length ? emails.join(", ") : "—"} />
      <Row label="Addresses on file" value={addresses || "—"} />
    </>
  );
}

/** GST registrations, from a Mobile to GST payload (or the bundle's vreMobileToGst block). */
function GstRows({ block }: { block: unknown }) {
  const result = (block as { result?: { gstin?: string; legal_name?: string }[] } | null)?.result;
  if (!Array.isArray(result) || result.length === 0) return null;
  return (
    <Row
      label={result.length === 1 ? "GST registration" : `GST registrations (${result.length})`}
      value={result
        .slice(0, 3)
        .map((r) => [r.legal_name, r.gstin].filter(Boolean).join(" · "))
        .join("; ")}
    />
  );
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

  const data = (trace.response as Record<string, unknown> | null)?.data as
    Record<string, unknown> | undefined;

  if (trace.serviceId === SKIP_TRACING_SERVICE) {
    // The bundle nests each source's payload under its own key. The headline facts are pulled
    // from those blocks here; everything else it returned is under "Show all fields" below.
    const block = (key: string) => data?.[key] as Record<string, unknown> | undefined;
    const empBlock = block("vreEmploymentLatest");
    const emp = empBlock ? readEmployment({ data: empBlock }) : null;
    const pan = block("vrePanAdvance");
    const father = block("vrePanToFathersName");
    const upi = block("vreMultipleUpiCheck")?.upi_id;

    // Alternate numbers come from two sources in this bundle — its own alternate-phone lookup
    // and the prefill block — so merge and de-duplicate rather than show one and hide the other.
    const prefill = block("vrePhoneToPrefill") as
      { alternatePhone?: { phoneNumber?: string }[]; email?: { email?: string }[] } | undefined;
    const phones = [
      ...((block("getAlternatePhoneNumber")?.alternate_phones as string[] | undefined) ?? []),
      ...(prefill?.alternatePhone ?? []).map((p) => p.phoneNumber ?? ""),
    ]
      // Same normalisation as the writeback, so the panel lists exactly the numbers it adds.
      .map((p) => normalisePhone(p))
      .filter((p) => /^[6-9]\d{9}$/.test(p));
    const emails = (prefill?.email ?? []).map((e) => e.email).filter(Boolean) as string[];
    const addresses = ((block("getAlternateAddress")?.addresses as unknown[] | undefined) ?? [])
      .length;

    return (
      <>
        {emp?.employer && <Row label="Employer" value={emp.employer} />}
        {block("vreMobileToUan")?.uan ? (
          <Row label="UAN" value={String(block("vreMobileToUan")!.uan)} />
        ) : null}
        {pan?.pan ? <Row label="PAN" value={String(pan.pan)} /> : null}
        {father?.father_name ? (
          <Row label="Father's name" value={String(father.father_name)} />
        ) : null}
        <Row
          label="Alternate numbers"
          value={phones.length ? [...new Set(phones)].join(", ") : "—"}
        />
        <Row label="Emails" value={emails.length ? emails.join(", ") : "—"} />
        <Row label="Addresses on file" value={addresses || "—"} />
        {Array.isArray(upi) && upi.length > 0 ? (
          <Row label="UPI IDs" value={(upi as string[]).join(", ")} />
        ) : null}
      </>
    );
  }
  if (trace.serviceId === "phone-to-prefill") return <ContactRows block={data} />;
  if (trace.serviceId === "get-alternate-phone") {
    const phones = ((data?.alternate_phones as string[] | undefined) ?? [])
      .map((p) => normalisePhone(p))
      .filter((p) => /^[6-9]\d{9}$/.test(p));
    return (
      <Row
        label="Alternate numbers"
        value={phones.length ? [...new Set(phones)].join(", ") : "—"}
      />
    );
  }
  if (trace.serviceId === "mobile-to-multiple-upi") {
    const ids = (data?.upi_id as string[] | undefined) ?? [];
    return (
      <>
        <Row label="Name on UPI" value={(data?.full_name as string) || "—"} />
        <Row label="UPI IDs" value={ids.length ? ids.join(", ") : "—"} />
      </>
    );
  }
  if (trace.serviceId === "mobile-to-lpg-advance") {
    const lpg = data?.vreConsumerIdToLpg as Record<string, unknown> | undefined;
    if (!lpg) return <p className="text-xs text-muted-foreground italic">No connection found.</p>;
    const addr = lpg.customer_address as Record<string, string | null> | undefined;
    const line = addr
      ? [
          addr.address_line1,
          addr.address_line2,
          addr.address_line3,
          addr.city,
          addr.state,
          addr.pincode,
        ]
          .filter(Boolean)
          .join(", ")
      : null;
    return (
      <>
        <Row label="Name on connection" value={(lpg.customer_name as string) || "—"} />
        <Row label="Address" value={line || "—"} />
        <Row label="Consumer no." value={(lpg.consumer_id as string) || "—"} />
      </>
    );
  }
  if (trace.serviceId === "get-alternate-address") {
    const addresses =
      (data?.addresses as
        { address_text?: string; confidence_score?: number; last_seen?: string }[] | undefined) ??
      [];
    if (addresses.length === 0)
      return <p className="text-xs text-muted-foreground italic">No addresses returned.</p>;
    return (
      <div className="space-y-1.5">
        {addresses.map((a, i) => (
          <div key={i} className="text-xs border-b border-border/50 pb-1.5 last:border-0">
            <div className="text-foreground">{a.address_text ?? "—"}</div>
            <div className="text-[10px] text-muted-foreground">
              {a.confidence_score != null && `confidence ${a.confidence_score}`}
              {a.last_seen && ` · last seen ${String(a.last_seen).slice(0, 10)}`}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (trace.serviceId === "mobile-to-gst") return <GstRows block={data} />;
  if (trace.serviceId === "gst-to-contact") {
    const result = data?.result as { mobile?: string; email?: string } | undefined;
    return (
      <>
        <Row label="Business phone" value={result?.mobile || "—"} />
        <Row label="Business email" value={result?.email || "—"} />
      </>
    );
  }
  // Only the employment services have an employment shape. Anything else used to fall through
  // to here and render "Currently employed: Unknown" over data that was never about employment.
  if (trace.serviceId !== "employment-latest" && trace.serviceId !== "employment-history") {
    return null;
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
  // Which services this company's plan includes — chosen per company by a superadmin, and
  // enforced again server-side in runProfilexTrace. Only these get a Run button.
  const [allowed, setAllowed] = useState<string[]>([]);
  // A manager's own prepaid balance — the thing that actually gates their lookups now (see
  // runProfilexTrace's wallet check). Null for anyone but a manager (admins aren't wallet-gated).
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const isManager = user?.role === "manager";

  const rerender = useCallback(() => bump((n) => n + 1), []);

  const loadWallet = useCallback(async () => {
    if (!isManager) return;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;
      const w = await getMyWallet({ data: { accessToken: session.access_token } });
      setWalletBalance(w.balance);
    } catch {
      // Non-fatal — the Run button's own error message is the real signal if the wallet is
      // actually empty; this banner is a convenience, not the enforcement.
    }
  }, [isManager]);

  useEffect(() => {
    if (!canRun) return;
    supabase.auth
      .getSession()
      .then(({ data: { session } }) =>
        session
          ? getProfilexSettings({ data: { accessToken: session.access_token } })
          : { enabled: false, enabled_services: [] as string[] },
      )
      .then((s) => {
        setEnabled(s.enabled);
        setAllowed(s.enabled_services ?? []);
      })
      .catch(() => setEnabled(false));
    loadWallet();
  }, [canRun, loadWallet]);

  useEffect(() => {
    const stop = refreshTracesWhenAuthed(debtorId, setLoadError);
    window.addEventListener(TRACES_UPDATED, rerender);
    return () => {
      stop();
      window.removeEventListener(TRACES_UPDATED, rerender);
    };
  }, [debtorId, rerender]);

  // Recomputed every render rather than memoised: the store is a module-level cache, so its
  // contents change without any prop or state this component could key a useMemo on — the
  // TRACES_UPDATED listener above is what triggers the re-render. It is a handful of rows.
  const latest = latestByService(debtorId);
  // A service with a derived input (UAN, GSTIN) can only run once its source service has been
  // run on this debtor. Driven off the catalogue so a new chained service needs no change here.
  const missingSource = (service: ProfilexService): string | null => {
    const from = service.derivedFrom;
    if (!from) return null;
    const satisfied = from.sources.some((src) => {
      const data = (latest.get(src.service)?.response as Record<string, unknown> | null)?.data as
        Record<string, unknown> | undefined;
      return !!(data && src.extract(data));
    });
    return satisfied ? null : from.label;
  };

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
      // A cached hit cost nothing — no wallet change, no need to re-fetch.
      if (!result.cached && result.cost > 0) loadWallet();
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

  if (canRun && enabled === true && allowed.length === 0 && latest.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Search className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">No lookups on your plan yet</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          Insights is on for your company, but no lookups have been enabled. Contact SamvadX support
          to choose which ones your company can use.
        </p>
      </div>
    );
  }

  if (canRun && enabled === false && latest.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <Search className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">Insights is not switched on</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          An admin can enable Insights and fund your wallet under Settings.
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
      {isManager && enabled === true && walletBalance !== null && (
        <div
          className={cn(
            "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs",
            walletBalance <= 0
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-border bg-muted/20 text-foreground",
          )}
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Wallet className="h-3.5 w-3.5" />
            Insights wallet
          </span>
          <span className="font-semibold">
            ₹{walletBalance.toFixed(2)}
            {walletBalance <= 0 && (
              <span className="ml-1.5 font-normal">— ask an admin to top up</span>
            )}
          </span>
        </div>
      )}

      {PROFILEX_SERVICES.map((service) => {
        const trace = latest.get(service.id);
        const needsSource = missingSource(service);
        // Runnable only if Insights is on AND the company's plan includes this service. A result
        // already on file still shows after a service is removed from the plan — it was paid for.
        const runnable = canRun && enabled === true && allowed.includes(service.id);
        // Agents only ever see what has already been paid for.
        if (!runnable && !trace) return null;

        return (
          <div key={service.id} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">{service.label}</p>
                <p className="text-[11px] text-muted-foreground">{service.blurb}</p>
              </div>
              {runnable && (
                <Button
                  size="sm"
                  variant={trace ? "outline" : "default"}
                  disabled={running !== null || !!needsSource}
                  onClick={() => setConfirming(service)}
                  className="flex-shrink-0 h-7 text-xs"
                  title={needsSource ? `Run ${needsSource} first` : service.blurb}
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

            {runnable && (needsSource || showCost) && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1 mb-2">
                {!needsSource && <IndianRupee className="h-3 w-3" />}
                {needsSource ? `Run ${needsSource} first` : priceLine(service)}
              </p>
            )}

            {trace ? (
              <div>
                <ResultBody trace={trace} />
                <AllFields trace={trace} />
                <p className="text-[10px] text-muted-foreground mt-2">
                  {new Date(trace.createdAt).toLocaleString("en-IN")}
                  {showCost && trace.billable && ` · ₹${trace.cost.toFixed(2)}`}
                </p>
              </div>
            ) : (
              runnable && <p className="text-xs text-muted-foreground italic">Not looked up yet.</p>
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
