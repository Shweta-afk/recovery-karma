// The GST tax invoice itself, shared by Superadmin → company → Invoices and Admin → Invoices.
// Drawn as a white "paper" in both themes because it is also what prints. Printing goes through
// InvoicePrintButton: it portals a copy straight under <body> (see the .invoice-print-root rules
// in styles.css) and calls window.print(), where "Save as PDF" gives the PDF.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  amountInWords,
  formatIsoDate,
  isBillOfSupply,
  stateName,
  type InvoiceParty,
  type InvoiceRecord,
} from "@/lib/invoice-math";

export function formatRupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export { formatIsoDate };

function stateLine(code: string | null) {
  return code ? `${stateName(code) ?? "—"} (${code})` : "—";
}

function Party({
  title,
  p,
  noGstin,
  showPan = false,
}: {
  title: string;
  p: InvoiceParty;
  /** What to print when there is no GSTIN — a recipient may be unregistered; the supplier never is. */
  noGstin: string;
  /** Always print a PAN line (supplier), even before one is filled in. */
  showPan?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{title}</p>
      <p className="font-semibold">{p.legalName}</p>
      {/* Line breaks typed into the address are joined, so it wraps evenly in the column. */}
      <p>{p.address.replace(/\s*\n\s*/g, " ")}</p>
      <p>State: {stateLine(p.stateCode)}</p>
      <p>GSTIN: {p.gstin ?? noGstin}</p>
      {(p.pan || showPan) && <p>PAN: {p.pan || "—"}</p>}
      {p.email && <p>Email: {p.email}</p>}
      {p.phone && <p>Phone: {p.phone}</p>}
    </div>
  );
}

/** Set when the document is a GST credit note rather than an invoice: same layout, different
 *  title and numbering, plus the invoice it corrects and why. */
export interface CreditNoteInfo {
  againstNumber: string;
  againstDate: string;
  reason: string;
}

export function InvoiceDocument({
  invoice,
  credit,
}: {
  invoice: InvoiceRecord;
  credit?: CreditNoteInfo;
}) {
  const s = invoice.supplier;
  const intra = invoice.cgst > 0 || invoice.sgst > 0;
  // No supplier GSTIN → a Bill of Supply: no GST is charged, so no tax rows or reverse charge.
  const billOfSupply = isBillOfSupply(invoice);
  const chargedOn = invoice.lines.find((l) => l.chargedOn)?.chargedOn;
  const cancelled = invoice.status === "cancelled";
  return (
    <div className="relative mx-auto w-full max-w-[800px] bg-white p-8 print:max-w-none print:p-0 text-[12px] leading-relaxed text-neutral-900">
      {cancelled && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-20deg] rounded border-4 border-red-500/60 px-6 py-2 text-5xl font-bold text-red-500/60">
            CANCELLED
          </span>
        </div>
      )}

      <div className="flex items-start justify-between gap-6 border-b border-neutral-300 pb-4">
        <div>
          {/* Same file as the login screen's logo (public/logo.png, 500×125). */}
          <img src="/logo.png" alt="SamvadX" className="mb-3 h-9 w-auto" />
          <h1 className="text-xl font-bold tracking-tight">
            {credit ? "CREDIT NOTE" : billOfSupply ? "BILL OF SUPPLY" : "TAX INVOICE"}
          </h1>
          <p className="text-neutral-500">Original for recipient</p>
        </div>
        <div className="text-right">
          <p>
            <span className="text-neutral-500">{credit ? "Credit note no." : "Invoice no."}</span>{" "}
            <span className="font-semibold">{invoice.invoiceNumber}</span>
          </p>
          <p>
            <span className="text-neutral-500">{credit ? "Date" : "Invoice date"}</span>{" "}
            {formatIsoDate(invoice.issueDate)}
          </p>
          {/* The second date: when the charge itself was taken (setup fee / wallet recharge). */}
          {!credit && chargedOn && (
            <p>
              <span className="text-neutral-500">
                {invoice.kind === "insights_topup" ? "Wallet recharged on" : "Setup fee charged on"}
              </span>{" "}
              {formatIsoDate(chargedOn)}
            </p>
          )}
          {credit ? (
            <p>
              <span className="text-neutral-500">Against invoice</span> {credit.againstNumber}{" "}
              <span className="text-neutral-500">dated</span> {formatIsoDate(credit.againstDate)}
            </p>
          ) : (
            <p>
              <span className="text-neutral-500">Due date</span> {formatIsoDate(invoice.dueDate)}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 border-b border-neutral-300 py-4">
        <Party title="Supplier" p={s} noGstin="Not registered under GST" showPan />
        <Party title="Bill to" p={invoice.recipient} noGstin="Unregistered" />
      </div>

      {credit && (
        <p className="border-b border-neutral-300 py-3">
          <span className="text-neutral-500">Reason for credit:</span> {credit.reason}
        </p>
      )}

      <p className="py-3">
        <span className="text-neutral-500">Place of supply:</span>{" "}
        {stateLine(invoice.placeOfSupply)}
        {!billOfSupply && (
          <>
            <span className="mx-3 text-neutral-300">|</span>
            <span className="text-neutral-500">Tax payable on reverse charge:</span> No
          </>
        )}
      </p>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
            <th className="py-2 pr-2 font-semibold">#</th>
            <th className="py-2 pr-2 font-semibold">Description</th>
            {invoice.sac && <th className="py-2 pr-2 font-semibold">SAC</th>}
            <th className="py-2 pr-2 text-right font-semibold">Qty</th>
            <th className="py-2 text-right font-semibold">
              {billOfSupply ? "Amount" : "Taxable value"}
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, n) => (
            <tr key={n} className="border-b border-neutral-200 align-top">
              <td className="py-1.5 pr-2">{n + 1}</td>
              <td className="py-1.5 pr-2">
                {line.description}
                {line.includes && line.includes.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11px] text-neutral-600">
                    {line.includes.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </td>
              {invoice.sac && <td className="py-1.5 pr-2">{invoice.sac}</td>}
              <td className="py-1.5 pr-2 text-right">
                {line.quantity && line.rate ? `${line.quantity} × ${formatRupees(line.rate)}` : 1}
              </td>
              <td className="py-1.5 text-right tabular-nums">{formatRupees(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="ml-auto mt-3 w-full max-w-[320px] space-y-1 tabular-nums">
        <Row
          label={billOfSupply ? "Amount" : "Taxable value"}
          value={formatRupees(invoice.taxable)}
        />
        {billOfSupply ? null : intra ? (
          <>
            <Row label="CGST @ 9%" value={formatRupees(invoice.cgst)} />
            <Row label="SGST @ 9%" value={formatRupees(invoice.sgst)} />
          </>
        ) : (
          <Row label="IGST @ 18%" value={formatRupees(invoice.igst)} />
        )}
        <div className="flex justify-between border-t border-neutral-400 pt-1 text-sm font-bold">
          <span>Total</span>
          <span>{formatRupees(invoice.total)}</span>
        </div>
      </div>

      <p className="mt-3 border-b border-neutral-300 pb-4">
        <span className="text-neutral-500">Amount in words:</span> {amountInWords(invoice.total)}
        {billOfSupply && (
          <span className="mt-1 block text-neutral-500">
            GST not charged — the supplier is not registered under GST.
          </span>
        )}
      </p>

      <div className="grid grid-cols-2 gap-6 pt-4">
        <div className="space-y-0.5">
          {(s.bankName || s.bankAccount) && (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Bank details
              </p>
              {s.bankName && <p>{s.bankName}</p>}
              {s.bankAccount && <p>A/c no. {s.bankAccount}</p>}
              {s.bankIfsc && <p>IFSC {s.bankIfsc}</p>}
            </>
          )}
          {invoice.notes && <p className="pt-2 whitespace-pre-line">{invoice.notes}</p>}
          {s.terms && <p className="pt-2 whitespace-pre-line text-neutral-500">{s.terms}</p>}
        </div>
        <div className="flex flex-col items-end justify-end text-right">
          <p>For {s.legalName}</p>
          <div className="mt-10">
            {s.signatoryName && <p className="font-semibold">{s.signatoryName}</p>}
            <p className="text-neutral-500">
              {s.signatoryDesignation
                ? `${s.signatoryDesignation} · Authorised signatory`
                : "Authorised signatory"}
            </p>
          </div>
        </div>
      </div>

      {invoice.disclaimer.length > 0 && (
        <div className="mt-6 border-t border-neutral-300 pt-3 text-[10px] leading-snug text-neutral-500">
          <p className="mb-1 font-semibold uppercase tracking-wide">Terms &amp; disclaimer</p>
          <ol className="list-decimal space-y-0.5 pl-4">
            {invoice.disclaimer.map((d, n) => (
              <li key={n}>{d}</li>
            ))}
          </ol>
        </div>
      )}

      <p className="mt-4 text-center text-[10px] text-neutral-400">
        This is a computer-generated {credit ? "credit note" : "invoice"}.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-neutral-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * "Print / Save PDF" for any paper-style document (invoice, credit note, contract). The browser's
 * print dialog offers Save as PDF; the PDF's file name comes from the document title, so it is
 * set to `fileTitle` while printing.
 *
 * The copy that prints is portalled under <body> (see .invoice-print-root in styles.css) ONLY
 * while this button is printing — several print buttons can be on screen at once (an invoice and
 * its credit notes), and print CSS shows every print root, so a permanently mounted copy would
 * print all of them together.
 */
export function PrintButton({
  fileTitle,
  children,
  label = "Print / Save PDF",
}: {
  fileTitle: string;
  children: React.ReactNode;
  label?: string;
}) {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!printing) return;
    const prevTitle = document.title;
    document.title = fileTitle.replace(/\//g, "-");
    document.body.classList.add("printing-invoice");
    const done = () => {
      document.body.classList.remove("printing-invoice");
      document.title = prevTitle;
      window.removeEventListener("afterprint", done);
      setPrinting(false);
    };
    window.addEventListener("afterprint", done);
    // Next frame: the portal has rendered, so the dialog captures this document.
    const raf = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("afterprint", done);
    };
  }, [printing, fileTitle]);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setPrinting(true)} disabled={printing}>
        <Printer className="mr-1.5 h-3.5 w-3.5" />
        {label}
      </Button>
      {printing &&
        createPortal(<div className="invoice-print-root">{children}</div>, document.body)}
    </>
  );
}

export function InvoicePrintButton({ invoice }: { invoice: InvoiceRecord }) {
  return (
    <PrintButton fileTitle={`Invoice ${invoice.invoiceNumber}`}>
      <InvoiceDocument invoice={invoice} />
    </PrintButton>
  );
}
