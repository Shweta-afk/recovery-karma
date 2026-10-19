// Superadmin-only editable Insights (ProfileX) configuration for one company — the counterpart
// to profilex-settings-card.tsx's now-read-only admin view. Rate card changes here are really
// editing SamvadX's own cost basis with the provider, which is why this moved off the company
// admin entirely (see the comment on saveCompanyProfilexSettings in superadmin-actions.server.ts).
import { useEffect, useState } from "react";
import { Search, Save, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { NewTag, RecommendedTag } from "@/components/profilex/new-tag";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/lib/supabase";
import {
  getCompanyCibil,
  getCompanyDirectExport,
  getCompanyProfilexSettings,
  saveCompanyProfilexSettings,
  setCompanyCibil,
  setCompanyDirectExport,
} from "@/lib/superadmin-actions.server";
import { getAccessToken } from "@/lib/access-token";
import {
  ALL_SERVICE_IDS,
  CIBIL_SERVICE,
  PROFILEX_SERVICES,
  getService,
  priceFor,
  priceStatuses,
  statusLabel,
} from "@/lib/profilex/catalogue";

type RateCard = Record<string, Record<string, number>>;

export function CompanyInsightsSettingsCard({ clientId }: { clientId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hitTtlHours, setHitTtlHours] = useState(720);
  const [missTtlHours, setMissTtlHours] = useState(168);
  const [rateCard, setRateCard] = useState<RateCard>({});
  // The company's plan: which services it may use. Enforced server-side in runProfilexTrace.
  const [enabledServices, setEnabledServices] = useState<string[]>([]);
  // CIBIL has its own switch (CibilSwitch below); the list only shows it and its price.
  const [cibilOn, setCibilOn] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired — sign in again");
        const s = await getCompanyProfilexSettings({
          data: { accessToken: session.access_token, clientId },
        });
        setEnabled(s.enabled);
        setHitTtlHours(s.hit_ttl_hours);
        setMissTtlHours(s.miss_ttl_hours);
        setRateCard((s.rate_card as RateCard) ?? {});
        setEnabledServices(s.enabled_services ?? []);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load Insights settings");
      } finally {
        setLoading(false);
      }
    })();
  }, [clientId]);

  const toggleService = (id: string, on: boolean) =>
    setEnabledServices((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  // A chained service (Employment, GST to Contact) can only ever run if something on the plan
  // can supply its input. Flag the combination rather than silently selling a dead button.
  const unreachable = PROFILEX_SERVICES.filter((s) => {
    if (!enabledServices.includes(s.id) || !s.derivedFrom) return false;
    return !s.derivedFrom.sources.some((src) => enabledServices.includes(src.service));
  });

  const priceOf = (serviceId: string, status: string, fallback: number) =>
    rateCard[serviceId]?.[status] ?? fallback;

  const setPrice = (serviceId: string, status: string, value: number) =>
    setRateCard((prev) => ({
      ...prev,
      [serviceId]: { ...(prev[serviceId] ?? {}), [status]: value },
    }));

  async function handleSave() {
    setSaving(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await saveCompanyProfilexSettings({
        data: {
          accessToken: session.access_token,
          clientId,
          enabled,
          hitTtlHours,
          missTtlHours,
          rateCard,
          enabledServices,
        },
      });
      toast.success("Insights settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save Insights settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" />
          Insights
          <Badge variant="secondary" className="text-[10px] ml-1">
            Billed per lookup
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          This company's admin sees these read-only — only a superadmin can change pricing or
          configuration here, since it's really SamvadX's own cost basis with the provider.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-foreground">Enable Insights</p>
                <p className="text-[11px] text-muted-foreground">
                  Off by default. Nothing can be spent while this is off.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <Separator />

            <DirectExportSwitch clientId={clientId} />

            <Separator />

            <CibilSwitch clientId={clientId} onChange={setCibilOn} />

            <Separator />

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-foreground">Re-use a result for (hours)</p>
                <p className="text-[11px] text-muted-foreground">
                  Within this window a repeat lookup is served from the stored result, free. Misses
                  are re-usable for a shorter window so data appearing later is still reachable.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Input
                  type="number"
                  min={0}
                  value={hitTtlHours}
                  onChange={(e) => setHitTtlHours(+e.target.value)}
                  className="w-20 h-8 text-xs text-right"
                  title="Found"
                />
                <span className="text-[11px] text-muted-foreground">found /</span>
                <Input
                  type="number"
                  min={0}
                  value={missTtlHours}
                  onChange={(e) => setMissTtlHours(+e.target.value)}
                  className="w-20 h-8 text-xs text-right"
                  title="Not found"
                />
                <span className="text-[11px] text-muted-foreground">not</span>
              </div>
            </div>

            <Separator />

            <div>
              <div className="flex items-center justify-between gap-3 mb-1">
                <p className="text-xs font-medium text-foreground">
                  Lookups on this company's plan
                </p>
                <div className="flex gap-2 text-[11px]">
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() =>
                      setEnabledServices(ALL_SERVICE_IDS.filter((id) => id !== CIBIL_SERVICE))
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:underline"
                    onClick={() => setEnabledServices([])}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mb-3">
                Ticked lookups are the only ones this company's managers can see and run — the
                server refuses anything else. Prices are what the company is charged per lookup;
                keep them matching the provider's contract, since this company's Reports are
                calculated from them.
              </p>

              {enabled && enabledServices.length === 0 && (
                <p className="mb-3 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                  Insights is on but no lookups are ticked — this company will see an empty plan.
                </p>
              )}
              {unreachable.length > 0 && (
                <p className="mb-3 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
                  <span>
                    {unreachable.map((s) => s.label).join(", ")}{" "}
                    {unreachable.length === 1 ? "needs" : "need"} an input nothing else on this plan
                    provides. Also tick{" "}
                    {[
                      ...new Set(
                        unreachable.flatMap((s) =>
                          s.derivedFrom!.sources.map(
                            (src) => getService(src.service)?.label ?? src.service,
                          ),
                        ),
                      ),
                    ].join(" or ")}
                    , or {unreachable.length === 1 ? "it" : "they"} can never run.
                  </span>
                </p>
              )}

              <div className="space-y-2">
                {PROFILEX_SERVICES.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                      <Checkbox
                        checked={s.id === CIBIL_SERVICE ? cibilOn : enabledServices.includes(s.id)}
                        // CIBIL is turned on and off with its own switch above, not from here.
                        disabled={s.id === CIBIL_SERVICE}
                        onCheckedChange={(v) => toggleService(s.id, v === true)}
                      />
                      <span
                        className={`text-xs truncate ${
                          (s.id === CIBIL_SERVICE ? cibilOn : enabledServices.includes(s.id))
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {s.label}
                      </span>
                      {s.isNew && <NewTag />}
                      {s.isRecommended && <RecommendedTag />}
                      {s.awaitingEndpoint && (
                        <span
                          className="text-[9px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 flex-shrink-0"
                          title="Listed with its price, but its API details aren't connected yet — nobody can run it until they are"
                        >
                          Not live yet
                        </span>
                      )}
                      {s.id === CIBIL_SERVICE && (
                        <span
                          className="text-[9px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 flex-shrink-0"
                          title="Turned on and off with the CIBIL reports switch above"
                        >
                          Switch above
                        </span>
                      )}
                      {s.manualOnly && (
                        <span
                          className="text-[9px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 flex-shrink-0"
                          title="Run from Admin > Insights by typing the value in — not offered on a debtor's own Insights tab"
                        >
                          Manual only
                        </span>
                      )}
                    </label>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {priceStatuses(s, rateCard).map((status, _i, all) => (
                        <div key={status} className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">
                            {statusLabel(status, all)}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            step="0.5"
                            // Defaults to what a lookup with this status costs today, so leaving
                            // it alone changes nothing and typing over it records the real price.
                            value={priceOf(s.id, status, priceFor(s, status))}
                            onChange={(e) => setPrice(s.id, status, +e.target.value)}
                            className="w-16 h-7 text-xs text-right"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save settings
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Saved on its own, immediately, rather than with the card's Save button: it governs a data
 *  export, not pricing, and has its own activity-log entry (setCompanyDirectExport). */
function DirectExportSwitch({ clientId }: { clientId: string }) {
  const [direct, setDirect] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await getCompanyDirectExport({
          data: { accessToken: await getAccessToken(), clientId },
        });
        setDirect(res.direct);
      } catch {
        setDirect(false);
      }
    })();
  }, [clientId]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    try {
      await setCompanyDirectExport({
        data: { accessToken: await getAccessToken(), clientId, direct: next },
      });
      setDirect(next);
      toast.success(next ? "Direct Excel download allowed" : "Excel now needs a request");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-xs font-medium text-foreground">Direct Excel download</p>
        <p className="text-[11px] text-muted-foreground">
          Off: this company must request each portfolio's "Lookup data by Loan ID" Excel and a
          superadmin approves it (Insights Activity page). On: it downloads straight away. Saves
          immediately.
        </p>
      </div>
      <Switch
        checked={!!direct}
        disabled={direct === null || saving}
        onCheckedChange={(v) => void toggle(v)}
      />
    </div>
  );
}

/** The company's one CIBIL switch. Off: nobody in the company — admin, manager or agent — sees
 *  anything CIBIL. On: managers pull reports on their borrowers (shown to the borrower's agent
 *  too) and admins run manual reports. Turning it on records where the company's consent
 *  agreement is, since every pull tells the bureau the borrower consented. Saves immediately. */
function CibilSwitch({
  clientId,
  onChange,
}: {
  clientId: string;
  onChange: (on: boolean) => void;
}) {
  const [state, setState] = useState<{
    available: boolean;
    on: boolean;
    at: string | null;
    note: string | null;
    byName: string | null;
  } | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await getCompanyCibil({
        data: { accessToken: await getAccessToken(), clientId },
      });
      setState(res);
      onChange(res.on);
    } catch {
      setState({ available: false, on: false, at: null, note: null, byName: null });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per company
  }, [clientId]);

  const save = async (on: boolean) => {
    setSaving(true);
    try {
      await setCompanyCibil({
        data: {
          accessToken: await getAccessToken(),
          clientId,
          on,
          note: on ? note.trim() : undefined,
        },
      });
      await load();
      setAsking(false);
      setNote("");
      toast.success(on ? "CIBIL reports turned on" : "CIBIL reports turned off");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-foreground">CIBIL reports</p>
          <p className="text-[11px] text-muted-foreground">
            Off: nobody in this company sees anything CIBIL. On: managers pull reports on their
            borrowers (their agents see them too) and admins can run manual reports. Saves
            immediately.
          </p>
        </div>
        <Switch
          checked={!!state?.on || asking}
          disabled={!state?.available || saving}
          onCheckedChange={(v) => {
            if (v) setAsking(true);
            else if (asking) setAsking(false);
            else void save(false);
          }}
        />
      </div>
      {state && !state.available && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          Not available until the CIBIL migrations are applied.
        </p>
      )}
      {asking && !state?.on && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Every pull tells the bureau the borrower has consented. Where is this company's consent
            agreement recorded?
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. MSA clause 7.2, signed 01-10-2026"
              className="h-8 text-xs"
              maxLength={500}
            />
            <Button
              size="sm"
              className="h-8 text-xs flex-shrink-0"
              disabled={saving || note.trim().length < 3}
              onClick={() => void save(true)}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Turn on"}
            </Button>
          </div>
        </div>
      )}
      {state?.on && state.at && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          On since {new Date(state.at).toLocaleString("en-IN")}
          {state.byName && ` by ${state.byName}`}
          {state.note && ` · Consent: ${state.note}`}
        </p>
      )}
    </div>
  );
}
