// "Download PDF" for Insights lookups. The server decides what may go in (getInsightsPdf checks
// role and visibility, and stamps who/when); the browser only draws the file. Reading stored
// results only — a download never runs or re-charges a lookup.
import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAccessToken } from "@/lib/access-token";
import { getInsightsPdf } from "@/lib/insights-pdf.server";
import { errorText } from "@/lib/app-error";

export type InsightsPdfScope =
  | { kind: "borrower"; debtorId: string; traceId?: string }
  | { kind: "manual"; lookupId: string }
  | { kind: "cibil"; reportId: string };

export function InsightsPdfButton({
  scope,
  label = "PDF",
  variant = "outline",
  title = "Download as PDF",
}: {
  scope: InsightsPdfScope;
  label?: string;
  variant?: "outline" | "default" | "ghost";
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      className="h-7 text-xs gap-1 flex-shrink-0"
      disabled={busy}
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          const { doc, subject } = await getInsightsPdf({
            data: { accessToken: await getAccessToken(), scope },
          });
          const { downloadInsightsPdf } = await import("@/lib/insights-pdf-render");
          await downloadInsightsPdf(doc, subject);
        } catch (err) {
          toast.error(errorText(err, "Could not make the PDF"));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3" />}
      {label}
    </Button>
  );
}
