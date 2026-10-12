// "Send" on an issued invoice: pick who gets it (prefilled with the company's billing email and
// its admins), then either Resend emails it, or — until Resend is set up — the superadmin's own
// mail app opens with the email written. sendInvoiceEmail records it either way.
import { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getAccessToken } from "@/lib/access-token";
import { sendInvoiceEmail } from "@/lib/invoice-actions.server";
import type { InvoiceRecord } from "@/lib/invoice-math";
import { formatRupees } from "./invoice-document";

export function SendInvoiceDialog({
  invoice,
  suggestions,
  onClose,
  onSent,
}: {
  invoice: InvoiceRecord | null;
  /** Addresses to offer — the billing email first, then the company's admins. */
  suggestions: string[];
  onClose: () => void;
  onSent: () => Promise<void> | void;
}) {
  const options = [
    ...new Set([invoice?.recipient.email, ...suggestions].filter(Boolean)),
  ] as string[];
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const value = to || options[0] || "";

  const send = async () => {
    if (!invoice) return;
    setSending(true);
    try {
      const res = await sendInvoiceEmail({
        data: { accessToken: await getAccessToken(), invoiceId: invoice.id, to: value.trim() },
      });
      if (res.mailto) {
        window.location.href = res.mailto;
        toast.success("Your mail app is opening with the invoice email written — press Send there");
      } else {
        toast.success(`Invoice emailed to ${value}`);
      }
      await onSent();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the invoice");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={!!invoice} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Send invoice {invoice?.invoiceNumber}</DialogTitle>
          <DialogDescription className="text-xs">
            {invoice &&
              `${formatRupees(invoice.total)} incl. GST · ${invoice.recipient.legalName}. `}
            The email links to the invoice in their SamvadX account — when an admin opens it, it
            shows here as Viewed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Send to</span>
            <Input
              type="email"
              value={value}
              onChange={(e) => setTo(e.target.value)}
              placeholder="accounts@company.in"
              className="h-9 text-sm"
            />
          </label>
          {options.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setTo(o)}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={sending || !value.includes("@")}
            onClick={send}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Mail className="h-3.5 w-3.5" />
            )}
            Send invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
