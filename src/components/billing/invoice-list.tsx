// Invoice table + viewer, shared by the superadmin screens (with status actions) and the
// company admin's read-only Invoices page.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { INVOICE_KIND_LABEL, type InvoiceRecord, type InvoiceStatus } from "@/lib/invoice-math";
import { todayIstKey } from "@/lib/date-filter";
import {
  InvoiceDocument,
  InvoicePrintButton,
  formatIsoDate,
  formatRupees,
} from "./invoice-document";

export function InvoiceStatusBadge({ invoice }: { invoice: InvoiceRecord }) {
  if (invoice.status === "paid") return <Badge variant="secondary">Paid</Badge>;
  if (invoice.status === "cancelled") return <Badge variant="outline">Cancelled</Badge>;
  if (invoice.dueDate < todayIstKey()) return <Badge variant="destructive">Overdue</Badge>;
  return <Badge variant="outline">Unpaid</Badge>;
}

export function InvoiceTable<T extends InvoiceRecord>({
  invoices,
  companyName,
  onSetStatus,
  empty = "No invoices yet.",
}: {
  invoices: T[];
  /** Adds a Company column (superadmin's all-companies list). */
  companyName?: (inv: T) => string | null;
  /** Superadmin only — omit for a read-only table. */
  onSetStatus?: (inv: T, status: InvoiceStatus) => Promise<void>;
  empty?: string;
}) {
  const [open, setOpen] = useState<T | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (inv: T, status: InvoiceStatus) => {
    if (!onSetStatus) return;
    if (
      status === "cancelled" &&
      !window.confirm(
        `Cancel invoice ${inv.invoiceNumber}? Its number stays used and it can't be reopened.`,
      )
    ) {
      return;
    }
    setBusy(inv.id);
    try {
      await onSetStatus(inv, status);
    } finally {
      setBusy(null);
    }
  };

  if (!invoices.length) return <p className="text-xs text-muted-foreground">{empty}</p>;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Invoice</th>
              {companyName && <th className="py-2 pr-3 font-medium">Company</th>}
              <th className="py-2 pr-3 font-medium">Type</th>
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 text-right font-medium">Total (incl. GST)</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-3 font-mono">{inv.invoiceNumber}</td>
                {companyName && <td className="py-2 pr-3">{companyName(inv) ?? "—"}</td>}
                <td className="py-2 pr-3">{INVOICE_KIND_LABEL[inv.kind]}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{formatIsoDate(inv.issueDate)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatRupees(inv.total)}</td>
                <td className="py-2 pr-3">
                  <InvoiceStatusBadge invoice={inv} />
                </td>
                <td className="py-2">
                  <div className="flex justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setOpen(inv)}
                    >
                      View
                    </Button>
                    {onSetStatus && inv.status === "unpaid" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={busy === inv.id}
                        onClick={() => act(inv, "paid")}
                      >
                        Mark paid
                      </Button>
                    )}
                    {onSetStatus && inv.status === "paid" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={busy === inv.id}
                        onClick={() => act(inv, "unpaid")}
                      >
                        Mark unpaid
                      </Button>
                    )}
                    {onSetStatus && inv.status !== "cancelled" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-destructive hover:text-destructive"
                        disabled={busy === inv.id}
                        onClick={() => act(inv, "cancelled")}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-h-[90vh] max-w-[860px] overflow-y-auto">
          <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pr-8">
            <DialogTitle className="text-sm">Invoice {open?.invoiceNumber}</DialogTitle>
            {open && <InvoicePrintButton invoice={open} />}
          </DialogHeader>
          {open && (
            <div className="rounded-md border border-border">
              <InvoiceDocument invoice={open} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
