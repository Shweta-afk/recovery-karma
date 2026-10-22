// Company side of data purging certificates (src/lib/data-purge.server.ts), on a portfolio's
// header for managers and admins: Request → "Requested" while SamvadX prepares it → open and
// print the issued certificate. A declined request can be asked again.

import { useCallback, useEffect, useState } from "react";
import { FileCheck2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { getAccessToken } from "@/lib/access-token";
import { errorText } from "@/lib/app-error";
import {
  getPurgeCertificateStatus,
  openPurgeCertificate,
  requestPurgeCertificate,
  type PurgeCertificateStatus,
} from "@/lib/data-purge.server";
import type { PurgeCertificate } from "@/lib/data-purge";
import { PrintButton } from "@/components/billing/invoice-document";
import { PurgeCertificateDocument } from "./purge-certificate-document";

export function PurgeRequestButton({
  portfolioId,
  portfolioName,
}: {
  portfolioId: string;
  portfolioName: string;
}) {
  const [status, setStatus] = useState<PurgeCertificateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [certificate, setCertificate] = useState<PurgeCertificate | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(
        await getPurgeCertificateStatus({
          data: { accessToken: await getAccessToken(), portfolioId },
        }),
      );
    } catch {
      // Not set up yet / not allowed: the button just doesn't show.
      setStatus(null);
    }
  }, [portfolioId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;
  const req = status.request;

  const send = async () => {
    setBusy(true);
    try {
      setStatus(
        await requestPurgeCertificate({
          data: {
            accessToken: await getAccessToken(),
            portfolioId,
            note: note.trim() || undefined,
          },
        }),
      );
      setAsking(false);
      setNote("");
      toast.success("Requested — SamvadX will prepare the certificate and notify you");
    } catch (err) {
      toast.error(errorText(err, "Could not send the request"));
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    setBusy(true);
    try {
      setCertificate(
        await openPurgeCertificate({ data: { accessToken: await getAccessToken(), portfolioId } }),
      );
    } catch (err) {
      toast.error(errorText(err, "Could not open the certificate"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {req?.status === "issued" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={open}
          disabled={busy}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileCheck2 className="h-3 w-3" />}
          Data purging certificate
        </Button>
      ) : req?.status === "pending" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          disabled
          title={`Requested ${new Date(req.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} — SamvadX is preparing it`}
        >
          <FileCheck2 className="h-3 w-3" />
          Purging certificate requested
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={() => setAsking(true)}
          title={
            req?.status === "declined"
              ? `Your last request was declined${req.decisionNote ? `: ${req.decisionNote}` : ""}`
              : "Ask SamvadX for a data purging certificate for this portfolio"
          }
        >
          <FileCheck2 className="h-3 w-3" />
          Request purging certificate
        </Button>
      )}

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Request a data purging certificate</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            SamvadX will issue a letter confirming that the borrower data of{" "}
            <span className="font-medium text-foreground">{portfolioName}</span> has been purged,
            with the allocation by DPD bucket. You'll be notified when it's ready to open here.
          </p>
          {req?.status === "declined" && (
            <p className="text-xs text-amber-600">
              Your last request was declined{req.decisionNote ? `: ${req.decisionNote}` : "."}
            </p>
          )}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything SamvadX should know (optional) — e.g. the month or addressee"
            maxLength={500}
            className="text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={send} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Send request
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!certificate} onOpenChange={(o) => !o && setCertificate(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 pr-6 text-sm">
              Data purging certificate — {portfolioName}
              {certificate && (
                <PrintButton
                  fileTitle={`Data Purging ${certificate.letter.period} - ${portfolioName}`}
                >
                  <PurgeCertificateDocument certificate={certificate} />
                </PrintButton>
              )}
            </DialogTitle>
          </DialogHeader>
          {certificate && (
            <div className="rounded border border-border">
              <PurgeCertificateDocument certificate={certificate} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
