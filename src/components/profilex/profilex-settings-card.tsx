// Read-only ProfileX display for a company admin. Separate from the rest of System Settings
// because these are tenant-scoped rows in `profilex_settings`, not localStorage like
// org-settings-store. Editing moved to superadmin-only (see CompanyInsightsSettingsCard in
// src/components/profilex/company-insights-settings-card.tsx): the rate card is what SamvadX
// itself gets billed against by ProfileX/Neokred, so a company admin changing it was really
// editing SamvadX's own cost basis. An admin now only manages their own managers' wallets
// (ManagerWalletsCard below this one), not the pricing those wallets spend against.
import { useEffect, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/lib/supabase";
import { getProfilexSettings } from "@/lib/profilex-actions.server";
import { PROFILEX_SERVICES, priceFor, priceStatuses, statusLabel } from "@/lib/profilex/catalogue";
import { errorText } from "@/lib/app-error";
import { NewTag } from "@/components/profilex/new-tag";

type RateCard = Record<string, Record<string, number>>;

export function ProfilexSettingsCard() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [hitTtlHours, setHitTtlHours] = useState(720);
  const [missTtlHours, setMissTtlHours] = useState(168);
  const [rateCard, setRateCard] = useState<RateCard>({});
  const [enabledServices, setEnabledServices] = useState<string[]>([]);

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
        setEnabledServices(s.enabled_services ?? []);
      } catch (e) {
        toast.error(errorText(e, "Could not load Insights settings"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const priceOf = (serviceId: string, status: string, fallback: number) =>
    rateCard[serviceId]?.[status] ?? fallback;

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
        <p className="text-[11px] text-muted-foreground mt-1">
          View only — pricing and configuration are set by SamvadX. Contact support to change these;
          you manage your own managers' wallets below.
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
              <Switch checked={enabled} disabled />
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
              <div className="flex items-center gap-2 flex-shrink-0 text-xs text-foreground">
                <span>{hitTtlHours}</span>
                <span className="text-[11px] text-muted-foreground">found /</span>
                <span>{missTtlHours}</span>
                <span className="text-[11px] text-muted-foreground">not</span>
              </div>
            </div>

            <Separator />

            <div>
              <p className="text-xs font-medium text-foreground mb-1">Your plan (₹ per lookup)</p>
              <p className="text-[11px] text-muted-foreground mb-3">
                The lookups your company can use and what SamvadX charges for each. Contact SamvadX
                support to add lookups to your plan.
              </p>
              {enabledServices.length === 0 && (
                <p className="text-[11px] text-muted-foreground italic">
                  No lookups are on your plan yet.
                </p>
              )}
              <div className="space-y-2">
                {PROFILEX_SERVICES.filter((s) => enabledServices.includes(s.id)).map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3">
                    <span className="text-xs text-foreground truncate flex items-center gap-1.5">
                      {s.label}
                      {s.isNew && <NewTag />}
                    </span>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {priceStatuses(s, rateCard).map((status, _i, all) => (
                        <div key={status} className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground">
                            {statusLabel(status, all)}
                          </span>
                          <span className="text-xs text-foreground">
                            ₹{priceOf(s.id, status, priceFor(s, status)).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
