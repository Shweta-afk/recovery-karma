// "Preview" before issuing: the invoice exactly as it will be issued (createInvoice with
// preview: true — same builder, nothing saved, no number used), shown as the company will see it.
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { InvoiceRecord } from "@/lib/invoice-math";
import { InvoiceDocument } from "./invoice-document";

export function InvoicePreviewDialog({
  invoice,
  issuing,
  onClose,
  onIssue,
}: {
  invoice: InvoiceRecord | null;
  issuing: boolean;
  onClose: () => void;
  /** Issue it from the preview — the number is assigned then. */
  onIssue: () => void;
}) {
  return (
    <Dialog open={!!invoice} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[860px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Preview — this is how the company will see it
          </DialogTitle>
          <DialogDescription className="text-xs">
            Nothing is saved yet. The invoice number is given when you issue it.
          </DialogDescription>
        </DialogHeader>
        {invoice && (
          <div className="rounded-md border border-border">
            <InvoiceDocument invoice={invoice} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Back to edit
          </Button>
          <Button size="sm" disabled={issuing} onClick={onIssue}>
            {issuing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Issue this invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
