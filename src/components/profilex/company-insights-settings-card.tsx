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
  getCompanyProfilexSettings,
  saveCompanyProfilexSettings,
} from "@/lib/superadmin-actions.server";
import {
  ALL_SERVICE_IDS,
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
                    onClick={() => setEnabledServices([...ALL_SERVICE_IDS])}
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
