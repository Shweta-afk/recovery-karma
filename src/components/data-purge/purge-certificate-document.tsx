// The printed data purging certificate — SamvadX → the company, one per portfolio. Wording and
// numbers come from src/lib/data-purge.ts; layout follows the lender's sample letter (2026-10-20):
// "To," block with the date on the right, subject, two paragraphs, the allocation table by DPD
// bucket, the assurance, and SamvadX's signature block.

import { formatRupees } from "@/components/billing/invoice-document";
import { formatLetterDate, purgeLetterText, type PurgeCertificate } from "@/lib/data-purge";

export function PurgeCertificateDocument({ certificate: c }: { certificate: PurgeCertificate }) {
  const text = purgeLetterText(c);
  return (
    <div className="mx-auto w-full max-w-[800px] bg-white p-10 text-[13px] leading-relaxed text-neutral-900 print:max-w-none print:p-0">
      <img src="/logo.png" alt="SamvadX" className="mb-6 h-9 w-auto" />

      <div className="flex items-start justify-between gap-6">
        <div>
          <p>To,</p>
          {c.letter.toLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <p className="shrink-0">Date: - {formatLetterDate(c.letter.letterDate)}</p>
      </div>

      <p className="mt-5">Sir/Madam,</p>
      <p className="mt-3 font-semibold">Subject: - {text.subject}</p>

      {text.beforeTable.map((para, i) => (
        <p key={i} className="mt-3 text-justify">
          {para}
        </p>
      ))}

      <table className="mt-3 w-full border-collapse text-[12px]">
        <caption className="caption-top pb-1 text-left font-semibold">{text.tableCaption}</caption>
        <thead>
          <tr className="bg-neutral-100">
            <th className="border border-neutral-400 px-2 py-1 text-left">Sl No</th>
            <th className="border border-neutral-400 px-2 py-1 text-left">Bucket / Risk CAT</th>
            <th className="border border-neutral-400 px-2 py-1 text-right">No of Accounts</th>
            <th className="border border-neutral-400 px-2 py-1 text-right">
              Total Outstanding (Value)
            </th>
          </tr>
        </thead>
        <tbody>
          {c.allocation.rows.map((r, i) => (
            <tr key={r.bucket}>
              <td className="border border-neutral-400 px-2 py-1">{i + 1}</td>
              <td className="border border-neutral-400 px-2 py-1">{r.bucket}</td>
              <td className="border border-neutral-400 px-2 py-1 text-right tabular-nums">
                {r.accounts.toLocaleString("en-IN")}
              </td>
              <td className="border border-neutral-400 px-2 py-1 text-right tabular-nums">
                {formatRupees(r.outstanding)}
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="border border-neutral-400 px-2 py-1" colSpan={2}>
              TOTAL
            </td>
            <td className="border border-neutral-400 px-2 py-1 text-right tabular-nums">
              {c.allocation.totalAccounts.toLocaleString("en-IN")}
            </td>
            <td className="border border-neutral-400 px-2 py-1 text-right tabular-nums">
              {formatRupees(c.allocation.totalOutstanding)}
            </td>
          </tr>
        </tbody>
      </table>

      {text.afterTable.map((para, i) => (
        <p key={i} className="mt-3 text-justify">
          {para}
        </p>
      ))}

      <div className="mt-6">
        <p>Yours Sincerely</p>
        <p className="font-semibold">For {c.supplier.legalName}</p>
        <div className="h-14" />
        {c.supplier.signatoryName && <p>Name: {c.supplier.signatoryName}</p>}
        <p>{c.supplier.signatoryDesignation || "Authorised Signatory"}</p>
      </div>
    </div>
  );
}
