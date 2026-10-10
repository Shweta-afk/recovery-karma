// Invoice table + viewer for the superadmin screens. With `onChanged` (superadmin), opening an
// invoice also shows its payments and credit notes (InvoiceLedger); without it the table is
// read-only.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  INVOICE_KIND_LABEL,
  monthLabel,
  type InvoiceBalance,
  type InvoiceRecord,
} from "@/lib/invoice-math";
import { todayIstKey } from "@/lib/date-filter";
import {
  InvoiceDocument,
  InvoicePrintButton,
  formatIsoDate,
  formatRupees,
} from "./invoice-document";
import { InvoiceLedger } from "./invoice-ledger";

type Row = InvoiceRecord & { balance?: InvoiceBalance };

export function InvoiceStatusBadge({ invoice }: { invoice: Row }) {
  const b = invoice.balance;
  if (invoice.status === "cancelled") return <Badge variant="outline">Cancelled</Badge>;
  if (b && b.net === 0 && b.credited > 0) return <Badge variant="secondary">Credited</Badge>;
  if (invoice.status === "paid" || (b && b.settled)) return <Badge variant="secondary">Paid</Badge>;
  const overdue = invoice.dueDate < todayIstKey();
  if (b && b.paid > 0) {
    return (
      <Badge variant={overdue ? "destructive" : "outline"} className="whitespace-nowrap">
        Part paid{overdue ? " · overdue" : ""}
      </Badge>
    );
  }
  if (overdue) return <Badge variant="destructive">Overdue</Badge>;
  return <Badge variant="outline">Unpaid</Badge>;
}

/** What is still owed on a row; falls back to the total for rows loaded without balances. */
const owed = (inv: Row) =>
  inv.status === "cancelled"
    ? 0
    : inv.balance
      ? Math.max(0, inv.balance.balance)
      : inv.status === "paid"
        ? 0
        : inv.total;

export function InvoiceTable<T extends Row>({
  invoices,
  companyName,
  onChanged,
  empty = "No invoices yet.",
}: {
  invoices: T[];
  /** Adds a Company column (superadmin's all-companies list). */
  companyName?: (inv: T) => string | null;
  /** Superadmin: enables payments, credit notes and cancelling in the viewer, and is called after
   *  any of them so the list refreshes. Omit for a read-only table. */
  onChanged?: () => Promise<void> | void;
  empty?: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = invoices.find((i) => i.id === openId) ?? null;

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
              <th className="py-2 pr-3 text-right font-medium">Still owed</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-3 font-mono">{inv.invoiceNumber}</td>
                {companyName && <td className="py-2 pr-3">{companyName(inv) ?? "—"}</td>}
                <td className="py-2 pr-3">
                  {INVOICE_KIND_LABEL[inv.kind]}
                  {inv.periodMonth && (
                    <span className="text-muted-foreground"> · {monthLabel(inv.periodMonth)}</span>
                  )}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">{formatIsoDate(inv.issueDate)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatRupees(inv.total)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {owed(inv) > 0 ? formatRupees(owed(inv)) : "—"}
                </td>
                <td className="py-2 pr-3">
                  <InvoiceStatusBadge invoice={inv} />
                </td>
                <td className="py-2 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setOpenId(inv.id)}
                  >
                    {onChanged && inv.status !== "cancelled" && owed(inv) > 0
                      ? "Open · record payment"
                      : "View"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpenId(null)}>
        <DialogContent className="max-h-[90vh] max-w-[860px] overflow-y-auto">
          <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pr-8">
            <DialogTitle className="text-sm">Invoice {open?.invoiceNumber}</DialogTitle>
            {open && <InvoicePrintButton invoice={open} />}
          </DialogHeader>
          {open && onChanged && <InvoiceLedger invoiceId={open.id} onChanged={onChanged} />}
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
