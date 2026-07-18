// Org-wide settings set by admin — branding, default calling hours and compliance
// guardrails. Distinct from dashboard.settings.tsx, which is per-agent pacing preferences.

export interface OrgSettings {
  companyName: string;
  supportEmail: string;
  supportPhone: string;
  callStartTime: string;
  callEndTime: string;
  enforceDnc: boolean;
  enforceDnd: boolean;
  maxContactsPerWeek: number;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  companyName: "Axiotta Risk Management Pvt Ltd",
  supportEmail: "support@axiotta.in",
  supportPhone: "+91 22 4000 1234",
  callStartTime: "09:00",
  callEndTime: "18:00",
  enforceDnc: true,
  enforceDnd: true,
  maxContactsPerWeek: 7,
};

const KEY = "recoveryai_org_settings";

export function getOrgSettings(): OrgSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_ORG_SETTINGS, ...(JSON.parse(raw) as Partial<OrgSettings>) } : { ...DEFAULT_ORG_SETTINGS };
  } catch {
    return { ...DEFAULT_ORG_SETTINGS };
  }
}

export function saveOrgSettings(settings: OrgSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent("org-settings-updated"));
}
