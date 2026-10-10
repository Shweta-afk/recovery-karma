// Superadmin-only editable Insights (ProfileX) configuration for one company — the counterpart
// to profilex-settings-card.tsx's now-read-only admin view. Rate card changes here are really
// editing SamvadX's own cost basis with the provider, which is why this moved off the company
// admin entirely (see the comment on saveCompanyProfilexSettings in superadmin-actions.server.ts).
import { useEffect, useState } from "react";
import { Search, Save, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/lib/supabase";
import {
  getCompanyCibilConsent,
  getCompanyDirectExport,
  getCompanyProfilexSettings,
  saveCompanyProfilexSettings,
  setCompanyCibilConsent,
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
  // When the company's CIBIL consent agreement was recorded; CIBIL can't be ticked without it.
  const [cibilConsentAt, setCibilConsentAt] = useState<string | null>(null);

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

            <CibilConsent
              clientId={clientId}
              onChange={(at) => {
                setCibilConsentAt(at);
                // Withdrawing also takes CIBIL off the plan server-side; mirror it here.
                if (!at) setEnabledServices((prev) => prev.filter((x) => x !== CIBIL_SERVICE));
              }}
            />

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
                      setEnabledServices(
                        ALL_SERVICE_IDS.filter((id) => id !== CIBIL_SERVICE || !!cibilConsentAt),
                      )
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
                        checked={enabledServices.includes(s.id)}
                        disabled={
                          s.id === CIBIL_SERVICE &&
                          !cibilConsentAt &&
                          !enabledServices.includes(s.id)
                        }
                        onCheckedChange={(v) => toggleService(s.id, v === true)}
                      />
                      <span
                        className={`text-xs truncate ${
                          enabledServices.includes(s.id)
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {s.label}
                      </span>
                      {s.adminOnly && (
                        <span
                          className="text-[9px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 flex-shrink-0"
                          title={
                            s.id === CIBIL_SERVICE && !cibilConsentAt
                              ? "Record the CIBIL consent agreement above to enable this"
                              : "Only the company's admins can run it or see its results"
                          }
                        >
                          Admins only
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

/** The company's CIBIL consent agreement. Saved on its own, immediately, like the direct-export
 *  switch: it is a compliance record with its own activity-log entry, not pricing. */
function CibilConsent({
  clientId,
  onChange,
}: {
  clientId: string;
  onChange: (at: string | null) => void;
}) {
  const [state, setState] = useState<{
    available: boolean;
    at: string | null;
    note: string | null;
    byName: string | null;
  } | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await getCompanyCibilConsent({
          data: { accessToken: await getAccessToken(), clientId },
        });
        setState(res);
        onChange(res.at);
      } catch {
        setState({ available: false, at: null, note: null, byName: null });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per company
  }, [clientId]);

  const save = async (agreed: boolean) => {
    setSaving(true);
    try {
      await setCompanyCibilConsent({
        data: {
          accessToken: await getAccessToken(),
          clientId,
          agreed,
          note: agreed ? note.trim() : undefined,
        },
      });
      const res = await getCompanyCibilConsent({
        data: { accessToken: await getAccessToken(), clientId },
      });
      setState(res);
      onChange(res.at);
      setNote("");
      toast.success(
        agreed ? "CIBIL consent agreement recorded" : "Withdrawn — CIBIL taken off the plan",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="text-xs font-medium text-foreground">CIBIL consent agreement</p>
      <p className="text-[11px] text-muted-foreground mb-2">
        Every CIBIL pull tells the bureau the borrower has consented. Record this only once the
        company has confirmed in writing that it holds that consent. Needed before CIBIL Report can
        go on the plan; withdrawing it takes CIBIL off. Saves immediately.
      </p>
      {state === null ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : !state.available ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Not available until migrations/20261010_cibil_reports.sql is applied.
        </p>
      ) : state.at ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border px-2.5 py-2">
          <p className="text-[11px] text-foreground">
            Recorded {new Date(state.at).toLocaleString("en-IN")}
            {state.byName && ` by ${state.byName}`}
            {state.note && <span className="block text-muted-foreground">{state.note}</span>}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs flex-shrink-0"
            disabled={saving}
            onClick={() => void save(false)}
          >
            Withdraw
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Where it is recorded, e.g. MSA clause 7.2 signed 01-10-2026"
            className="h-8 text-xs"
            maxLength={500}
          />
          <Button
            size="sm"
            className="h-8 text-xs flex-shrink-0"
            disabled={saving || note.trim().length < 3}
            onClick={() => void save(true)}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Record agreement"}
          </Button>
        </div>
      )}
    </div>
  );
}
