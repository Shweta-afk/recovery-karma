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
  stateName,
  type InvoiceParty,
  type InvoiceRecord,
} from "@/lib/invoice-math";

export function formatRupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

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
      <p className="whitespace-pre-line">{p.address}</p>
      <p>State: {stateLine(p.stateCode)}</p>
      <p>GSTIN: {p.gstin ?? noGstin}</p>
      {(p.pan || showPan) && <p>PAN: {p.pan || "—"}</p>}
      {p.email && <p>{p.email}</p>}
      {p.phone && <p>{p.phone}</p>}
    </div>
  );
}

export function InvoiceDocument({ invoice }: { invoice: InvoiceRecord }) {
  const s = invoice.supplier;
  const intra = invoice.cgst > 0 || invoice.sgst > 0;
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
          <h1 className="text-xl font-bold tracking-tight">TAX INVOICE</h1>
          <p className="text-neutral-500">Original for recipient</p>
        </div>
        <div className="text-right">
          <p>
            <span className="text-neutral-500">Invoice no.</span>{" "}
            <span className="font-semibold">{invoice.invoiceNumber}</span>
          </p>
          <p>
            <span className="text-neutral-500">Invoice date</span>{" "}
            {formatIsoDate(invoice.issueDate)}
          </p>
          <p>
            <span className="text-neutral-500">Due date</span> {formatIsoDate(invoice.dueDate)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 border-b border-neutral-300 py-4">
        <Party title="Supplier" p={s} noGstin="—" showPan />
        <Party title="Bill to" p={invoice.recipient} noGstin="Unregistered" />
      </div>

      <p className="py-3">
        <span className="text-neutral-500">Place of supply:</span>{" "}
        {stateLine(invoice.placeOfSupply)}
        <span className="mx-3 text-neutral-300">|</span>
        <span className="text-neutral-500">Tax payable on reverse charge:</span> No
      </p>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-y border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
            <th className="py-2 pr-2 font-semibold">#</th>
            <th className="py-2 pr-2 font-semibold">Description</th>
            <th className="py-2 pr-2 font-semibold">SAC</th>
            <th className="py-2 pr-2 text-right font-semibold">Qty</th>
            <th className="py-2 text-right font-semibold">Taxable value</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, n) => (
            <tr key={n} className="border-b border-neutral-200 align-top">
              <td className="py-1.5 pr-2">{n + 1}</td>
              <td className="py-1.5 pr-2">{line.description}</td>
              <td className="py-1.5 pr-2">{invoice.sac ?? "—"}</td>
              <td className="py-1.5 pr-2 text-right">1</td>
              <td className="py-1.5 text-right tabular-nums">{formatRupees(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="ml-auto mt-3 w-full max-w-[320px] space-y-1 tabular-nums">
        <Row label="Taxable value" value={formatRupees(invoice.taxable)} />
        {intra ? (
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
          <p className="mt-10 text-neutral-500">Authorised signatory</p>
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
        This is a computer-generated invoice.
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

/** "Print / Save PDF" — the browser's print dialog offers Save as PDF; the PDF file name comes
 * from the document title, so it is set to the invoice number for the duration. */
export function InvoicePrintButton({ invoice }: { invoice: InvoiceRecord }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const print = () => {
    const prevTitle = document.title;
    document.title = `Invoice ${invoice.invoiceNumber.replace(/\//g, "-")}`;
    document.body.classList.add("printing-invoice");
    const done = () => {
      document.body.classList.remove("printing-invoice");
      document.title = prevTitle;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={print}>
        <Printer className="mr-1.5 h-3.5 w-3.5" />
        Print / Save PDF
      </Button>
      {mounted &&
        createPortal(
          <div className="invoice-print-root">
            <InvoiceDocument invoice={invoice} />
          </div>,
          document.body,
        )}
    </>
  );
}
