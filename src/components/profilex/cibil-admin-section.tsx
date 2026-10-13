// Manual CIBIL on Admin → Insights: an admin types in any person's details and gets their credit
// report. Admins only, and hidden entirely while the company's CIBIL switch is off (the server
// returns nothing and refuses to run — cibil-actions.server.ts). Borrower reports are pulled by
// managers on the borrower's own Insights tab instead (cibil-panel.tsx).
import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getAccessToken } from "@/lib/access-token";
import {
  listCibilManual,
  runCibilManual,
  type CibilReportSummary,
} from "@/lib/cibil-actions.server";
import { validateCibilForm, type CibilForm } from "@/lib/cibil/payprime";
import {
  CibilFormFields,
  CibilReportView,
  DownloadReportButton,
  EMPTY_CIBIL_FORM,
  rupees,
  saveCibilReportFile,
} from "@/components/profilex/cibil-panel";

const MOBILE_RE = /^[6-9]\d{9}$/;

export function CibilAdminSection() {
  const [loaded, setLoaded] = useState(false);
  const [on, setOn] = useState(false);
  const [price, setPrice] = useState(0);
  const [rows, setRows] = useState<CibilReportSummary[]>([]);
  const [form, setForm] = useState<CibilForm>(EMPTY_CIBIL_FORM);
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [shownId, setShownId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listCibilManual({ data: { accessToken: await getAccessToken() } });
      setOn(res.on);
      setPrice(res.price);
      setRows(res.rows);
    } catch {
      setOn(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded || !on) return null;

  const phoneOk = MOBILE_RE.test(phone.replace(/\D/g, "").slice(-10));
  const valid = phoneOk && Object.keys(validateCibilForm(form)).length === 0;
  const shown = rows.find((r) => r.id === shownId) ?? null;

  const pull = async () => {
    setConfirming(false);
    setRunning(true);
    try {
      const res = await runCibilManual({
        data: { accessToken: await getAccessToken(), form, phone },
      });
      toast.success(`CIBIL report ready · ${rupees(res.cost)} — downloading`);
      setForm(EMPTY_CIBIL_FORM);
      setPhone("");
      setTouched(false);
      setShownId(res.report.id);
      await load();
      // The point of a manual pull is the file: save it straight to their computer.
      await saveCibilReportFile(res.report.id).catch((e) =>
        toast.error(e instanceof Error ? e.message : "Could not download the report"),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "CIBIL report failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          CIBIL Report — manual
          <Badge variant="secondary" className="text-[10px] ml-1">
            Admins only
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Enter anyone's details to download their credit report. Fields marked * are needed (the
          state fills itself from the PIN code); the rest are optional. {rupees(price)} per report.
          Only admins see these. (Managers pull reports on their own borrowers from the borrower's
          Insights tab.)
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="space-y-2">
          <label className="block space-y-1 sm:w-1/2 sm:pr-1">
            <span className="text-[11px] text-muted-foreground">Mobile number *</span>
            <Input
              className="h-8 text-xs"
              inputMode="numeric"
              maxLength={13}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            {touched && !phoneOk && (
              <span className="block text-[10px] text-destructive">10-digit mobile number</span>
            )}
          </label>
          <CibilFormFields form={form} onChange={setForm} showErrors={touched} />
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={running}
              onClick={() => {
                setTouched(true);
                if (valid) setConfirming(true);
              }}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                `Download report · ${rupees(price)}`
              )}
            </Button>
          </div>
        </div>

        {shown && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-foreground mb-2">{shown.subject}</p>
            <CibilReportView report={shown} />
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-foreground mb-2">Manual reports</p>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">None yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Pulled</th>
                    <th className="py-2 pr-3 font-medium">Person</th>
                    <th className="py-2 pr-3 font-medium text-right">Score</th>
                    <th className="py-2 pr-3 font-medium">By</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString("en-IN")}
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="text-primary hover:underline text-left"
                          onClick={() => setShownId(r.id)}
                        >
                          {r.subject || "—"}
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold">{r.score ?? "—"}</td>
                      <td className="py-2 pr-3">{r.requestedByName ?? "—"}</td>
                      <td className="py-2 text-right">
                        <DownloadReportButton reportId={r.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Get this person's CIBIL report?</AlertDialogTitle>
            <AlertDialogDescription>
              Costs {rupees(price)}. The request tells the bureau the person has consented, under
              your company's agreement with SamvadX.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void pull()}>Download report</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
