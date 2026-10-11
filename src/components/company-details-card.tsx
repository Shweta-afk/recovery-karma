// Admin → Settings: the company's own details for invoices and agreements. Required — every
// admin page shows a red banner until they are complete (admin.tsx). Rules in company-details.ts,
// server in company-details.server.ts.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/lib/access-token";
import { GST_STATES } from "@/lib/invoice-math";
import {
  EMPTY_COMPANY_DETAILS,
  checkCompanyDetails,
  type CompanyDetails,
} from "@/lib/company-details";
import { getMyCompanyDetails, saveMyCompanyDetails } from "@/lib/company-details.server";

export const COMPANY_DETAILS_UPDATED = "company-details-updated";

function Field({
  label,
  required,
  error,
  hint,
  wide,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block space-y-1", wide && "sm:col-span-2")}>
      <span className="text-xs text-muted-foreground">
        {label}
        {required ? <span className="text-destructive"> *</span> : " (optional)"}
      </span>
      {children}
      {error ? (
        <span className="block text-[11px] text-destructive">{error}</span>
      ) : (
        hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}

export function CompanyDetailsCard() {
  const [details, setDetails] = useState<CompanyDetails>(EMPTY_COMPANY_DETAILS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await getMyCompanyDetails({ data: { accessToken: await getAccessToken() } });
        setDetails(res.details);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load company details");
      } finally {
        setLoading(false);
        // Arriving from the red banner (…/settings#company-details): bring the card into view.
        if (window.location.hash === "#company-details") {
          requestAnimationFrame(() =>
            document.getElementById("company-details")?.scrollIntoView({ behavior: "smooth" }),
          );
        }
      }
    })();
  }, []);

  const check = checkCompanyDetails(details);
  const complete = check.missing.length === 0 && Object.keys(check.invalid).length === 0;
  const set = <K extends keyof CompanyDetails>(k: K, v: CompanyDetails[K]) =>
    setDetails((d) => ({ ...d, [k]: v }));
  // Required-but-empty fields show as errors only after a save attempt; format errors at once.
  const err = (k: keyof CompanyDetails, empty: boolean) =>
    check.invalid[k] ?? (touched && empty ? "Required" : undefined);

  const save = async () => {
    setTouched(true);
    if (Object.keys(check.invalid).length) {
      toast.error("Fix the fields marked in red first");
      return;
    }
    setSaving(true);
    try {
      const res = await saveMyCompanyDetails({
        data: { accessToken: await getAccessToken(), details },
      });
      window.dispatchEvent(new CustomEvent(COMPANY_DETAILS_UPDATED));
      if (res.check.missing.length) {
        toast.warning(`Saved — still needed: ${res.check.missing.join(", ")}`);
      } else {
        toast.success("Company details saved");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save company details");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card id="company-details" className={cn(!loading && !complete && "border-destructive/60")}>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          Company details for invoices & agreements
          {!loading &&
            (complete ? (
              <span className="ml-1 flex items-center gap-1 text-[11px] font-normal text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> Complete
              </span>
            ) : (
              <span className="ml-1 flex items-center gap-1 text-[11px] font-normal text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Required
              </span>
            ))}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Printed on SamvadX's invoices to your company and on your agreement with us. Use the
          details exactly as registered (GST certificate / PAN card). Fields marked * are required.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                label="Registered legal name"
                required
                error={err("legalName", !details.legalName.trim())}
                hint="e.g. Acme Recoveries Private Limited"
                wide
              >
                <Input
                  value={details.legalName}
                  onChange={(e) => set("legalName", e.target.value)}
                  maxLength={200}
                />
              </Field>

              <div className="sm:col-span-2">
                <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                  <Checkbox
                    checked={details.gstUnregistered}
                    onCheckedChange={(v) => set("gstUnregistered", v === true)}
                  />
                  Our company is not registered for GST
                </label>
              </div>
              {!details.gstUnregistered && (
                <Field
                  label="GSTIN"
                  required
                  error={err("gstin", !details.gstin.trim())}
                  hint="15 characters, from your GST certificate"
                >
                  <Input
                    className="uppercase"
                    value={details.gstin}
                    onChange={(e) => set("gstin", e.target.value.toUpperCase())}
                    maxLength={15}
                  />
                </Field>
              )}
              <Field label="Company PAN" required error={err("pan", !details.pan.trim())}>
                <Input
                  className="uppercase"
                  value={details.pan}
                  onChange={(e) => set("pan", e.target.value.toUpperCase())}
                  maxLength={10}
                />
              </Field>
              <Field label="CIN / LLPIN" error={err("cin", false)} hint="Companies and LLPs only">
                <Input
                  className="uppercase"
                  value={details.cin}
                  onChange={(e) => set("cin", e.target.value.toUpperCase())}
                  maxLength={21}
                />
              </Field>

              <Field
                label="Registered address"
                required
                error={err("address", !details.address.trim())}
                wide
              >
                <Input
                  value={details.address}
                  onChange={(e) => set("address", e.target.value)}
                  maxLength={500}
                  placeholder="Building, street, area"
                />
              </Field>
              <Field label="City" required error={err("city", !details.city.trim())}>
                <Input
                  value={details.city}
                  onChange={(e) => set("city", e.target.value)}
                  maxLength={80}
                />
              </Field>
              <Field label="PIN code" required error={err("pinCode", !details.pinCode.trim())}>
                <Input
                  inputMode="numeric"
                  value={details.pinCode}
                  onChange={(e) => set("pinCode", e.target.value.replace(/\D/g, ""))}
                  maxLength={6}
                />
              </Field>
              <Field
                label="State"
                required
                error={err("stateCode", !details.stateCode)}
                hint="Decides CGST + SGST or IGST on invoices"
              >
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={details.stateCode}
                  onChange={(e) => set("stateCode", e.target.value)}
                >
                  <option value="">Choose…</option>
                  {GST_STATES.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Billing email"
                required
                error={err("email", !details.email.trim())}
                hint="Where invoices are sent"
              >
                <Input
                  type="email"
                  value={details.email}
                  onChange={(e) => set("email", e.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field label="Billing phone" required error={err("phone", !details.phone.trim())}>
                <Input
                  inputMode="tel"
                  value={details.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  maxLength={15}
                />
              </Field>

              <Field
                label="Authorised signatory name"
                required
                error={err("signatoryName", !details.signatoryName.trim())}
                hint="Who signs agreements for the company"
              >
                <Input
                  value={details.signatoryName}
                  onChange={(e) => set("signatoryName", e.target.value)}
                  maxLength={120}
                />
              </Field>
              <Field
                label="Signatory designation"
                required
                error={err("signatoryDesignation", !details.signatoryDesignation.trim())}
                hint="e.g. Director, CEO"
              >
                <Input
                  value={details.signatoryDesignation}
                  onChange={(e) => set("signatoryDesignation", e.target.value)}
                  maxLength={120}
                />
              </Field>
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">
                {complete
                  ? "All required details are filled in."
                  : `Still needed: ${check.missing.join(", ") || "fix the fields marked in red"}`}
              </p>
              <Button onClick={() => void save()} disabled={saving} className="gap-1.5">
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save company details
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
