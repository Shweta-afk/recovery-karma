// A list of contract documents (versions) with "Current" marked and a download button — used on
// Admin → Contracts and Superadmin → Contracts.

import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import { currentDocument, fileSizeLabel, type ContractDocument } from "@/lib/contracts";
import { getContractFileUrl } from "@/lib/contracts.server";

export async function openContractFile(documentId: string) {
  const accessToken = await getAccessToken();
  const { url } = await getContractFileUrl({ data: { accessToken, documentId } });
  // A navigation, not window.open: the link is fetched after an await, which popup blockers
  // treat as unrequested. The signed URL is a download, so the page stays where it is.
  window.location.assign(url);
}

export function DownloadContractButton({
  documentId,
  label = "Download",
}: {
  documentId: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 text-[11px]"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await openContractFile(documentId);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not open the file");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      {label}
    </Button>
  );
}

const fmtDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export function ContractDocumentList({
  documents,
  empty,
  showCompany = false,
}: {
  documents: ContractDocument[];
  empty: string;
  /** Superadmin view: say which company (or "All companies") each document is for. */
  showCompany?: boolean;
}) {
  if (documents.length === 0) {
    return <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>;
  }
  // "Current" is worked out per company (or for the platform terms), not across the whole list.
  const today = todayIstKey();
  const groups = new Map<string, ContractDocument[]>();
  for (const d of documents) {
    const k = d.clientId ?? "platform";
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const currentIds = new Set(
    [...groups.values()].map((g) => currentDocument(g, today)?.id).filter(Boolean),
  );

  return (
    <div className="space-y-2">
      {documents.map((d) => {
        const isCurrent = currentIds.has(d.id);
        const upcoming = d.effectiveDate > today;
        return (
          <div
            key={d.id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 ${isCurrent ? "border-primary/40 bg-primary/5" : "border-border"}`}
          >
            <div className="flex min-w-0 items-start gap-2">
              <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
                  {d.title}
                  {d.versionLabel && (
                    <span className="font-normal text-muted-foreground">· {d.versionLabel}</span>
                  )}
                  {isCurrent && !upcoming && <Badge className="text-[10px]">Current</Badge>}
                  {upcoming && (
                    <Badge variant="outline" className="text-[10px]">
                      Starts {fmtDate(d.effectiveDate)}
                    </Badge>
                  )}
                  {!isCurrent && !upcoming && (
                    <Badge variant="secondary" className="text-[10px]">
                      Earlier version
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {showCompany && (
                    <span className="font-medium text-foreground">
                      {d.companyName ?? "All companies (platform terms)"} ·{" "}
                    </span>
                  )}
                  Effective {fmtDate(d.effectiveDate)} · {d.fileName}
                  {d.fileSize ? ` · ${fileSizeLabel(d.fileSize)}` : ""}
                </div>
                {d.notes && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{d.notes}</div>
                )}
              </div>
            </div>
            <DownloadContractButton documentId={d.id} />
          </div>
        );
      })}
    </div>
  );
}

export { fmtDate as fmtContractDate };
