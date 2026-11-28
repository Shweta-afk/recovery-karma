import { useEffect, useState } from "react";
import { PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { getAccessToken } from "@/lib/access-token";
import { errorText } from "@/lib/app-error";
import { getCompanyFeatures, setCompanyFeature } from "@/lib/company-features.server";
import type { CompanyFeatures, FeatureKey } from "@/lib/company-features";

const ROWS: { key: FeatureKey; label: string; help: string }[] = [
  {
    key: "misReports",
    label: "Collection MIS",
    help: "The Collection MIS page for admins and managers: Daily Collection, Ranking, Zero Numbers, Client and Differences sheets, as image or Excel.",
  },
  {
    key: "reportEmails",
    label: "Report emails",
    help: '"Email a report" on the Reports pages, report email lists in Settings, and scheduled MIS emails (needs Collection MIS too).',
  },
];

/** Superadmin → company → Settings: sellable report features, off by default. */
export function CompanyFeaturesCard({ clientId }: { clientId: string }) {
  const [f, setF] = useState<CompanyFeatures | null>(null);
  const [busy, setBusy] = useState<FeatureKey | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setF(await getCompanyFeatures({ data: { accessToken: await getAccessToken(), clientId } }));
      } catch (e) {
        toast.error(errorText(e, "Could not load features"));
      }
    })();
  }, [clientId]);

  const set = async (key: FeatureKey, on: boolean) => {
    setBusy(key);
    try {
      setF(
        await setCompanyFeature({
          data: { accessToken: await getAccessToken(), clientId, key, on },
        }),
      );
      toast.success(`${ROWS.find((r) => r.key === key)?.label} ${on ? "on" : "off"}`);
    } catch (e) {
      toast.error(errorText(e, "Could not change the feature"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <PackagePlus className="h-4 w-4 text-primary" /> Report features
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Paid add-ons. Off unless switched on here; the company sees nothing of a feature that is
          off.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {ROWS.map((r) => (
          <div key={r.key} className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{r.label}</p>
              <p className="text-xs text-muted-foreground">{r.help}</p>
            </div>
            <Switch
              checked={!!f?.[r.key]}
              disabled={!f || busy !== null}
              onCheckedChange={(v) => void set(r.key, v)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
