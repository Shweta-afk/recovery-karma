// Admin-only ProfileX controls. Separate from the rest of System Settings because these are
// tenant-scoped rows in `profilex_settings`, not localStorage like org-settings-store — the
// budget cap has to be readable by the server to be enforceable at all, so it has its own save.
import { useEffect, useState } from "react";
import { Search, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/lib/supabase";
import { getProfilexSettings, saveProfilexSettings } from "@/lib/profilex-actions.server";
import { PROFILEX_SERVICES } from "@/lib/profilex/catalogue";

type RateCard = Record<string, Record<string, number>>;

export function ProfilexSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hitTtlHours, setHitTtlHours] = useState(720);
  const [missTtlHours, setMissTtlHours] = useState(168);
  const [rateCard, setRateCard] = useState<RateCard>({});

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) return;
        const s = await getProfilexSettings({ data: { accessToken: session.access_token } });
        setEnabled(s.enabled);
        setHitTtlHours(s.hit_ttl_hours);
        setMissTtlHours(s.miss_ttl_hours);
        setRateCard((s.rate_card as RateCard) ?? {});
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load Insights settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
      await saveProfilexSettings({
        data: {
          accessToken: session.access_token,
          enabled,
          hitTtlHours,
          missTtlHours,
          rateCard,
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
          Managers can look up a debtor's employer and UAN from the number already on their account.
          The provider charges per lookup — including when it finds nothing.
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
              <p className="text-xs font-medium text-foreground mb-1">Rate card (₹ per lookup)</p>
              <p className="text-[11px] text-muted-foreground mb-3">
                The provider prices per service and per outcome. Keep these matching your contract —
                every spend figure in Reports is calculated from them.
              </p>
              <div className="space-y-2">
                {PROFILEX_SERVICES.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3">
                    <span className="text-xs text-foreground truncate">{s.label}</span>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {Object.keys(s.defaultPrices).map((status) => (
                        <div key={status} className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">
                            {status === "1" ? "found" : "not found"}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            step="0.5"
                            value={priceOf(s.id, status, s.defaultPrices[status])}
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
