import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Building2, Clock, Shield, Plug, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { getOrgSettings, saveOrgSettings, type OrgSettings } from "@/lib/org-settings-store";
import { getMyClient, updateCompanyName } from "@/lib/client-store";
import { ProfilexSettingsCard } from "@/components/profilex/profilex-settings-card";
import { CompanyWalletCard, ManagerWalletsCard } from "@/components/profilex/wallets-card";
import { CompanyDetailsCard } from "@/components/company-details-card";

export const Route = createFileRoute("/admin/settings")({
  head: () => ({ meta: [{ title: "Settings · SamvadX Admin" }] }),
  component: AdminSettingsPage,
});

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
  badge,
}: {
  icon: typeof Building2;
  title: string;
  description: string;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          {title}
          {badge && (
            <Badge variant="secondary" className="text-[10px] ml-1">
              {badge}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </CardHeader>
      <CardContent className="pt-4 space-y-5">{children}</CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function AdminSettingsPage() {
  const [cfg, setCfg] = useState<OrgSettings>(() => getOrgSettings());
  const [companyNameLoading, setCompanyNameLoading] = useState(true);
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) =>
    setCfg((p) => ({ ...p, [k]: v }));

  // Company name is real, tenant-scoped data (clients.company_name) — everything else in
  // OrgSettings stays in localStorage (org-settings-store.ts), unrelated to RLS/tenant identity.
  useEffect(() => {
    getMyClient()
      .then((client) => {
        if (client) set("companyName", client.company_name);
      })
      .finally(() => setCompanyNameLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    try {
      await updateCompanyName(cfg.companyName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save company name");
      return;
    }
    saveOrgSettings(cfg);
    // Company name IS saved org-wide (clients.company_name). Everything else goes to
    // localStorage and is read by nothing — saying "org-wide defaults updated" told an admin
    // their compliance guardrails were live when they were not.
    toast.success("Company name saved", {
      description: "Other preferences are stored in this browser only and are not yet enforced.",
    });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">System Settings</h1>
          <p className="text-sm text-muted-foreground">
            Branding, default calling hours and org-wide compliance guardrails.
          </p>
        </div>
        <Button onClick={handleSave} className="gap-1.5">
          <Save className="h-4 w-4" />
          Save Settings
        </Button>
      </div>

      {/* Required: every admin page shows a red banner until this is complete (admin.tsx). */}
      <CompanyDetailsCard />

      <SectionCard
        icon={Building2}
        title="Branding"
        description="Company details shown across the app and in debtor communications."
      >
        <SettingRow label="Company name">
          <Input
            value={cfg.companyName}
            onChange={(e) => set("companyName", e.target.value)}
            disabled={companyNameLoading}
            className="w-64 h-8 text-xs"
          />
        </SettingRow>
        <SettingRow label="Support email">
          <Input
            type="email"
            value={cfg.supportEmail}
            onChange={(e) => set("supportEmail", e.target.value)}
            className="w-64 h-8 text-xs"
          />
        </SettingRow>
        <SettingRow label="Support phone">
          <Input
            value={cfg.supportPhone}
            onChange={(e) => set("supportPhone", e.target.value)}
            className="w-64 h-8 text-xs"
          />
        </SettingRow>
      </SectionCard>

      {/* Said plainly and near the top, because the previous copy on this page made specific
          regulatory claims ("RBI/TRAI guardrails enforced across every team", "DNC-listed
          accounts are automatically skipped org-wide") that nothing in the app implements. An
          admin reasonably concluded DNC screening was active. In a collections product that is
          a compliance exposure, not a cosmetic bug. */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
        <Shield className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <p className="text-[12px] text-muted-foreground">
          <span className="font-semibold text-foreground">
            Only Company Name is saved for your organisation.
          </span>{" "}
          Calling hours, DNC/DND enforcement and contact limits below are stored in{" "}
          <span className="font-medium text-foreground">this browser only</span>, are not shared
          with your team, and are <span className="font-medium text-foreground">not enforced</span>{" "}
          by the dialer or the call queue. Treat them as notes until enforcement is built.
        </p>
      </div>

      <SectionCard
        icon={Clock}
        title="Working Hours"
        description="Saved preference. NOT yet applied to portfolios or the dialer."
      >
        <SettingRow label="Calling hours">
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={cfg.callStartTime}
              onChange={(e) => set("callStartTime", e.target.value)}
              className="w-28 h-8 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="time"
              value={cfg.callEndTime}
              onChange={(e) => set("callEndTime", e.target.value)}
              className="w-28 h-8 text-xs"
            />
          </div>
        </SettingRow>
      </SectionCard>

      <SectionCard
        icon={Shield}
        title="Compliance"
        description="Saved preferences. NOT yet enforced anywhere in the app — see the notice below."
        badge="Not enforced"
      >
        <SettingRow
          label="Enforce DNC registry"
          hint="Records the intent to skip DNC-listed accounts. There is no DNC list connected, so nothing is skipped today."
        >
          <Switch checked={cfg.enforceDnc} onCheckedChange={(v) => set("enforceDnc", v)} />
        </SettingRow>
        <SettingRow label="Enforce DND mobile numbers">
          <Switch checked={cfg.enforceDnd} onCheckedChange={(v) => set("enforceDnd", v)} />
        </SettingRow>
        <Separator />
        <SettingRow label="Max contacts per week per debtor">
          <Input
            type="number"
            min={1}
            max={14}
            value={cfg.maxContactsPerWeek}
            onChange={(e) => set("maxContactsPerWeek", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>
      </SectionCard>

      <ProfilexSettingsCard />
      <CompanyWalletCard />
      <ManagerWalletsCard />

      <SectionCard
        icon={Plug}
        title="Integrations"
        description="LMS, telephony and payment gateway connections."
      >
        <div className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
          Integrations are configured via environment credentials by your platform team. Contact
          support to connect an LMS, telephony provider, or UPI gateway.
        </div>
      </SectionCard>

      <div className="flex justify-end pb-6">
        <Button onClick={handleSave} className="gap-1.5">
          <Save className="h-4 w-4" />
          Save All Settings
        </Button>
      </div>
    </div>
  );
}
