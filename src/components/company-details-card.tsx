// Admin → Settings: the company's own details for invoices and agreements. Required — every
// admin page shows a red banner until they are complete (admin.tsx). Rules in company-details.ts,
// server in company-details.server.ts.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/lib/access-token";
import {
  EMPTY_COMPANY_DETAILS,
  checkCompanyDetails,
  type CompanyDetails,
} from "@/lib/company-details";
import { getMyCompanyDetails, saveMyCompanyDetails } from "@/lib/company-details.server";
import { CompanyDetailsForm } from "@/components/company-details-form";
import { errorText } from "@/lib/app-error";

export const COMPANY_DETAILS_UPDATED = "company-details-updated";

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
        toast.error(errorText(e, "Could not load company details"));
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
      toast.error(errorText(e, "Could not save company details"));
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
            <CompanyDetailsForm details={details} onChange={setDetails} showMissing={touched} />

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
