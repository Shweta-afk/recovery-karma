import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { CibilAdminSection } from "@/components/profilex/cibil-admin-section";
import { getAccessToken } from "@/lib/access-token";
import {
  listManualInsights,
  runManualInsight,
  type ManualLookupRow,
} from "@/lib/profilex-actions.server";
import { PROFILEX_SERVICES, priceLine, type ProfilexService } from "@/lib/profilex/catalogue";
import { flatten } from "@/components/profilex/trace-panel";
import { NewTag } from "@/components/profilex/new-tag";
import { errorText } from "@/lib/app-error";

export const Route = createFileRoute("/admin/insights")({
  head: () => ({ meta: [{ title: "Insights · SamvadX" }] }),
  component: AdminInsightsPage,
});

const serviceLabel = (id: string) => PROFILEX_SERVICES.find((s) => s.id === id)?.label ?? id;

const inr = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** What the admin has to type for a service, and how to label it. */
function valueField(s: ProfilexService): {
  label: string;
  placeholder: string;
  inputMode?: "numeric";
} {
  switch (s.input) {
    case "uan":
      return { label: "UAN", placeholder: "12-digit UAN", inputMode: "numeric" };
    case "gstin":
      return { label: "GSTIN", placeholder: "15-character GSTIN" };
    case "din":
      return { label: "DIN", placeholder: "8-digit DIN", inputMode: "numeric" };
    default:
      return { label: "Mobile number", placeholder: "10-digit mobile", inputMode: "numeric" };
  }
}

const needsName = (s: ProfilexService) =>
  s.input === "mobile+name" || s.input === "mobile+firstName" || s.input === "mobile+fullName";

function ResultView({ row }: { row: ManualLookupRow }) {
  const [raw, setRaw] = useState(false);
  const leaves = useMemo(
    () => flatten((row.response as { data?: unknown } | null)?.data),
    [row.response],
  );

  if (row.state === "failed") {
    return (
      <p className="text-xs text-destructive break-words">
        {row.error ? errorText(row.error, "Lookup failed") : "Lookup failed."}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {leaves.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The provider returned no details for this value.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          {leaves.map((l, i) => (
            <div
              key={i}
              className="flex justify-between gap-3 py-0.5 text-xs border-b border-border/40"
            >
              <span className="text-muted-foreground shrink-0">{l.label}</span>
              <span className="font-medium text-foreground text-right break-all">{l.value}</span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setRaw((r) => !r)}
        className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", raw && "rotate-90")} />
        {raw ? "Hide" : "Show"} raw response
      </button>
      {raw && (
        <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px]">
          {JSON.stringify(row.response, null, 2)}
        </pre>
      )}
    </div>
  );
}

function statusBadge(row: ManualLookupRow) {
  if (row.state === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (row.state === "pending") return <Badge variant="outline">Pending</Badge>;
  return row.provider_status === "1" ? (
    <Badge>Found</Badge>
  ) : (
    <Badge variant="secondary">Not found</Badge>
  );
}

function AdminInsightsPage() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [plan, setPlan] = useState<string[]>([]);
  const [rateCard, setRateCard] = useState<Record<string, Record<string, number>>>({});
  const [history, setHistory] = useState<ManualLookupRow[]>([]);

  const [serviceId, setServiceId] = useState("");
  const [value, setValue] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [shownId, setShownId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { rows, settings } = await listManualInsights({
        data: { accessToken: await getAccessToken() },
      });
      setHistory(rows);
      setEnabled(settings.enabled);
      setPlan(settings.enabled_services);
      setRateCard(settings.rate_card);
    } catch (err) {
      toast.error(errorText(err, "Could not load Insights"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // CIBIL (provider "payprime") has its own section below — it runs against a debtor, not a
  // typed-in value.
  const services = useMemo(
    () =>
      PROFILEX_SERVICES.filter((s) => plan.includes(s.id) && !s.provider && !s.awaitingEndpoint),
    [plan],
  );
  const service = services.find((s) => s.id === serviceId);

  useEffect(() => {
    if (!serviceId && services.length) setServiceId(services[0].id);
  }, [services, serviceId]);

  const field = service ? valueField(service) : null;
  const canRun =
    !!service && value.trim().length > 0 && (!needsName(service) || firstName.trim().length > 0);

  const run = async () => {
    if (!service) return;
    setConfirming(false);
    setRunning(true);
    try {
      const res = await runManualInsight({
        data: {
          accessToken: await getAccessToken(),
          serviceId: service.id,
          value: value.trim(),
          firstName: needsName(service) ? firstName.trim() : undefined,
          lastName:
            service.input === "mobile+name" || service.input === "mobile+fullName"
              ? lastName.trim()
              : undefined,
        },
      });
      toast.success(`${service.label} done — charged ${inr(res.cost)}`);
      setShownId(res.lookup?.id ?? null);
    } catch (err) {
      toast.error(errorText(err, "Lookup failed"));
    } finally {
      setRunning(false);
      await load();
    }
  };

  const shown = history.find((r) => r.id === shownId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Insights…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Insights</h1>
        <p className="text-sm text-muted-foreground">
          Look up any mobile number, UAN, GSTIN or DIN directly. Every lookup is billed to your
          company — a "not found" is usually still charged.
        </p>
      </div>

      <CibilAdminSection />

      {!enabled || services.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {!enabled
              ? "Insights is turned off for your company."
              : "No lookups are on your company's Insights plan yet."}{" "}
            Ask your platform contact to enable it.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New lookup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Lookup</Label>
              <Select value={serviceId} onValueChange={setServiceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a lookup" />
                </SelectTrigger>
                <SelectContent>
                  {services.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                      {s.isNew && <NewTag className="ml-1.5" />}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {service && (
                <p className="text-xs text-muted-foreground">
                  {service.blurb}{" "}
                  <span className="font-medium text-foreground">
                    {priceLine(service, rateCard)}
                  </span>
                </p>
              )}
            </div>

            {service && field && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ins-value">{field.label}</Label>
                  <Input
                    id="ins-value"
                    value={value}
                    inputMode={field.inputMode}
                    placeholder={field.placeholder}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
                {needsName(service) && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ins-first">First name</Label>
                    <Input
                      id="ins-first"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                    />
                  </div>
                )}
                {(service.input === "mobile+name" || service.input === "mobile+fullName") && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ins-last">Last name (optional)</Label>
                    <Input
                      id="ins-last"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <Button disabled={!canRun || running} onClick={() => setConfirming(true)}>
              {running ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Search className="h-4 w-4 mr-2" />
              )}
              Run lookup
            </Button>
          </CardContent>
        </Card>
      )}

      {shown && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              {serviceLabel(shown.service_id)} · {shown.query_key}
            </CardTitle>
            {statusBadge(shown)}
          </CardHeader>
          <CardContent>
            <ResultView row={shown} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent lookups</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing looked up yet.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {history.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setShownId(r.id === shownId ? null : r.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-muted/40",
                    r.id === shownId && "bg-muted/60",
                  )}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{serviceLabel(r.service_id)}</span>{" "}
                    <span className="text-muted-foreground">{r.query_key}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    <span>{inr(Number(r.cost))}</span>
                    {statusBadge(r)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run {service?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This looks up {value.trim()} with the data provider and is billed to your company:{" "}
              {service ? priceLine(service, rateCard) : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={run}>Run lookup</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
