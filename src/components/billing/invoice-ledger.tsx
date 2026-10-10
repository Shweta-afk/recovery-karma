// Inside an opened invoice (superadmin): what is still owed, payments as they arrived, GST credit
// notes, and cancelling. Server: billing-actions.server.ts (payments, credit notes) and
// invoice-actions.server.ts setInvoiceStatus (cancel).

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import {
  PAYMENT_METHOD_LABEL,
  type CreditNoteRecord,
  type InvoiceBalance,
  type InvoicePayment,
  type InvoiceRecord,
  type PaymentMethod,
} from "@/lib/invoice-math";
import {
  deletePayment,
  getInvoiceLedger,
  issueCreditNote,
  recordPayment,
} from "@/lib/billing-actions.server";
import { setInvoiceStatus } from "@/lib/invoice-actions.server";
import { InvoiceDocument, PrintButton, formatIsoDate, formatRupees } from "./invoice-document";

interface Ledger {
  invoice: InvoiceRecord;
  payments: InvoicePayment[];
  creditNotes: CreditNoteRecord[];
  balance: InvoiceBalance;
  creditable: number;
}

/** A credit note drawn on the invoice layout: its own number/date, the corrected invoice's parties. */
export function creditNoteAsDocument(cn: CreditNoteRecord, invoice: InvoiceRecord): InvoiceRecord {
  return {
    ...invoice,
    id: cn.id,
    invoiceNumber: cn.creditNoteNumber,
    issueDate: cn.issueDate,
    lines: cn.lines,
    taxable: cn.taxable,
    cgst: cn.cgst,
    sgst: cn.sgst,
    igst: cn.igst,
    total: cn.total,
    supplier: cn.supplier,
    recipient: cn.recipient,
    status: "unpaid",
    notes: null,
    disclaimer: [],
  };
}

export function InvoiceLedger({
  invoiceId,
  onChanged,
}: {
  invoiceId: string;
  /** Refresh the list behind the dialog after any change. */
  onChanged: () => Promise<void> | void;
}) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(todayIstKey());
  const [payMethod, setPayMethod] = useState<PaymentMethod>("bank_transfer");
  const [payRef, setPayRef] = useState("");

  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const l = await getInvoiceLedger({ data: { accessToken, invoiceId } });
      setLedger(l);
      setPayAmount(l.balance.balance > 0 ? String(l.balance.balance) : "");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load payments");
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const after = async (l: Ledger, msg: string) => {
    setLedger(l);
    setPayAmount(l.balance.balance > 0 ? String(l.balance.balance) : "");
    toast.success(msg);
    await onChanged();
  };

  if (!ledger) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading payments…
      </div>
    );
  }
  const { invoice, payments, creditNotes, balance, creditable } = ledger;
  const cancelled = invoice.status === "cancelled";

  const record = async () => {
    const amount = Number(payAmount);
    if (!(amount > 0)) {
      toast.error("Enter the amount received");
      return;
    }
    setBusy("pay");
    try {
      const accessToken = await getAccessToken();
      const l = await recordPayment({
        data: {
          accessToken,
          invoiceId,
          amount,
          receivedOn: payDate,
          method: payMethod,
          reference: payRef.trim() || undefined,
        },
      });
      setPayRef("");
      await after(
        l,
        l.balance.settled ? "Payment recorded — invoice paid in full" : "Payment recorded",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the payment");
    } finally {
      setBusy(null);
    }
  };

  const removePayment = async (p: InvoicePayment) => {
    if (
      !window.confirm(
        `Remove the ${formatRupees(p.amount)} payment of ${formatIsoDate(p.receivedOn)}?`,
      )
    ) {
      return;
    }
    setBusy(p.id);
    try {
      const accessToken = await getAccessToken();
      await after(
        await deletePayment({ data: { accessToken, paymentId: p.id } }),
        "Payment removed",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the payment");
    } finally {
      setBusy(null);
    }
  };

  const credit = async () => {
    const taxable = Number(creditAmount);
    if (!(taxable > 0) || creditReason.trim().length < 3) {
      toast.error("Enter the amount to credit (before GST) and a reason");
      return;
    }
    if (
      !window.confirm(
        `Issue a credit note for ${formatRupees(taxable)} + GST against invoice ${invoice.invoiceNumber}? Credit note numbers can't be reused.`,
      )
    ) {
      return;
    }
    setBusy("credit");
    try {
      const accessToken = await getAccessToken();
      const l = await issueCreditNote({
        data: { accessToken, invoiceId, taxable, reason: creditReason.trim() },
      });
      setCreditAmount("");
      setCreditReason("");
      await after(l, "Credit note issued");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not issue the credit note");
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (
      !window.confirm(
        `Cancel invoice ${invoice.invoiceNumber}? Its number stays used and it can't be reopened.`,
      )
    ) {
      return;
    }
    setBusy("cancel");
    try {
      const accessToken = await getAccessToken();
      await setInvoiceStatus({ data: { accessToken, invoiceId, status: "cancelled" } });
      toast.success(`Invoice ${invoice.invoiceNumber} cancelled`);
      await load();
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not cancel the invoice");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5 text-xs">
      <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 sm:grid-cols-4">
        <Figure label="Invoice total" value={formatRupees(invoice.total)} />
        <Figure label="Credited" value={formatRupees(balance.credited)} />
        <Figure label="Received" value={formatRupees(balance.paid)} />
        <Figure
          label="Still owed"
          value={cancelled ? "Cancelled" : formatRupees(Math.max(0, balance.balance))}
          strong
        />
      </div>

      <section className="space-y-2">
        <h3 className="font-semibold">Payments</h3>
        {payments.length === 0 ? (
          <p className="text-muted-foreground">
            {invoice.status === "paid"
              ? "Marked paid before payments were recorded one by one."
              : "Nothing received yet."}
          </p>
        ) : (
          <table className="w-full">
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(p.receivedOn)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{formatRupees(p.amount)}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">
                    {PAYMENT_METHOD_LABEL[p.method]}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground"
                      aria-label="Remove payment"
                      disabled={busy !== null}
                      onClick={() => removePayment(p)}
                    >
                      {busy === p.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!cancelled && balance.balance > 0 && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-2">
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">Amount received ₹</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                className="h-8 w-32 text-right text-xs"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">Received on</span>
              <input
                type="date"
                value={payDate}
                max={todayIstKey()}
                onChange={(e) => setPayDate(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">How</span>
              <Select value={payMethod} onValueChange={(v) => setPayMethod(v as PaymentMethod)}>
                <SelectTrigger className="h-8 w-52 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">
                      {PAYMENT_METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">
                Reference (UTR / cheque no.)
              </span>
              <Input
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                maxLength={100}
                className="h-8 w-44 text-xs"
              />
            </label>
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={busy !== null}
              onClick={record}
            >
              {busy === "pay" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Record payment
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Credit notes</h3>
        {creditNotes.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-1.5">
            {creditNotes.map((cn) => (
              <li key={cn.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-mono">{cn.creditNoteNumber}</span>
                  <span className="ml-2 text-muted-foreground">
                    {formatIsoDate(cn.issueDate)} · {formatRupees(cn.total)} · {cn.reason}
                  </span>
                </span>
                <PrintButton fileTitle={`Credit note ${cn.creditNoteNumber}`} label="Print / PDF">
                  <InvoiceDocument
                    invoice={creditNoteAsDocument(cn, invoice)}
                    credit={{
                      againstNumber: invoice.invoiceNumber,
                      againstDate: invoice.issueDate,
                      reason: cn.reason,
                    }}
                  />
                </PrintButton>
              </li>
            ))}
          </ul>
        )}
        {!cancelled && creditable > 0 && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-2">
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">
                Credit (before GST, up to {formatRupees(creditable)}) ₹
              </span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value)}
                className="h-8 w-32 text-right text-xs"
              />
            </label>
            <label className="min-w-[220px] flex-1 space-y-1">
              <span className="block text-[11px] text-muted-foreground">Reason</span>
              <Input
                value={creditReason}
                onChange={(e) => setCreditReason(e.target.value)}
                placeholder="e.g. Wrong seat count billed for October"
                maxLength={500}
                className="h-8 text-xs"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={busy !== null}
              onClick={credit}
            >
              {busy === "credit" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Issue credit note"
              )}
            </Button>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          A credit note is the GST-correct way to reduce or reverse an invoice that was already
          issued. GST is split the same way as on the invoice.
        </p>
      </section>

      {!cancelled && balance.paid === 0 && balance.credited === 0 && (
        <div className="border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={busy !== null}
            onClick={cancel}
          >
            {busy === "cancel" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Cancel invoice"}
          </Button>
          <span className="ml-2 text-[11px] text-muted-foreground">
            Only possible before any payment or credit note — after that, issue a credit note.
          </span>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`tabular-nums ${strong ? "text-sm font-semibold" : ""}`}>{value}</div>
    </div>
  );
}
