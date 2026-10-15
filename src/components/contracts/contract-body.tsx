// A contract document generated from a template, drawn as a white "paper" (it is also what
// prints), plus the button that opens one from a document list.

import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAccessToken } from "@/lib/access-token";
import { parseTemplateBlocks } from "@/lib/contract-template";
import { getContractDocumentBody } from "@/lib/contracts.server";
import { PrintButton } from "@/components/billing/invoice-document";
import { errorText } from "@/lib/app-error";

/** **bold** → <strong>; everything else is plain text (no HTML from the template is trusted). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Laid out like the Word agreement it comes from (Samvadx Aggrement (1).docx): A4 with Word's
 *  margins (1" top, 0.9" sides), Calibri 12pt (Carlito — same metrics — where Calibri isn't
 *  installed), justified, and Word's own spacing in px at 96dpi: body 5pt after at 1.1 lines
 *  (= 1.34 for Calibri), headings 14pt/8pt before, recitals at 1.5 lines, the title 380pt down
 *  page 1 (left blank for stamp paper), gridded tables, page breaks and "<footer> — Page N". */
export function ContractBody({ text }: { text: string }) {
  const blocks = parseTemplateBlocks(text);
  const footer = blocks.find((b) => b.type === "footer");
  return (
    <div
      className="contract-paper mx-auto w-full max-w-[794px] bg-white px-[87px] pb-[87px] pt-[96px] text-justify text-[16px] leading-[1.34] text-black print:max-w-none print:p-0"
      style={{ fontFamily: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif' }}
    >
      {footer?.type === "footer" && (
        // Page margin boxes can't read the document, so the footer text goes in as a rule.
        <style>{`@media print { @page contract { @bottom-center { content: ${JSON.stringify(
          `${footer.text} — Page `,
        )} counter(page); font: 10pt Calibri, Carlito, Arial, sans-serif; } } }`}</style>
      )}
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h1":
            return (
              <h1 key={i} className={`mb-4 text-center font-bold ${i === 0 ? "pt-[507px]" : ""}`}>
                <Inline text={b.text} />
              </h1>
            );
          case "center":
            return (
              <p key={i} className="mb-[11px] text-center">
                <Inline text={b.text} />
              </p>
            );
          case "h2":
            return (
              <h2 key={i} className="mb-2 mt-[19px] font-bold break-after-avoid">
                <Inline text={b.text} />
              </h2>
            );
          case "h3":
            return (
              <h3 key={i} className="mb-[7px] mt-[11px] font-bold break-after-avoid">
                <Inline text={b.text} />
              </h3>
            );
          case "p":
            return (
              <p key={i} className="mb-[7px]">
                <Inline text={b.text} />
              </p>
            );
          case "ul":
            return (
              <ul key={i} className="mb-[7px] space-y-[7px] pl-6">
                {b.items.map((it, n) => (
                  <li key={n} className="relative">
                    <span className="absolute -left-4">•</span>
                    <Inline text={it} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="my-[7px] list-[upper-alpha] pl-12 leading-[1.83]">
                {b.items.map((it, n) => (
                  <li key={n} className="pl-1">
                    <Inline text={it} />
                  </li>
                ))}
              </ol>
            );
          case "table":
            return (
              <table key={i} className="mb-3 w-full border-collapse text-left break-inside-avoid">
                <tbody>
                  {b.rows.map((r, n) => (
                    <tr key={n}>
                      {r.map((c, k) => (
                        <td key={k} className="h-9 border border-black px-[7px] py-1 align-top">
                          <Inline text={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          case "pagebreak":
            return (
              <div key={i} className="break-after-page">
                <hr className="my-6 border-dashed border-neutral-300 print:hidden" />
              </div>
            );
          default:
            return null;
        }
      })}
      {footer?.type === "footer" && (
        <p className="mt-10 text-center text-[13px] text-neutral-500 print:hidden">{footer.text}</p>
      )}
    </div>
  );
}

/** "View / Print" for a generated document: loads its text, shows it, offers print/PDF. */
export function ViewContractButton({ documentId, title }: { documentId: string; title: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-[11px]"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const accessToken = await getAccessToken();
            const doc = await getContractDocumentBody({ data: { accessToken, documentId } });
            setBody(doc.body);
          } catch (e) {
            toast.error(errorText(e, "Could not open the document"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
        View / Print
      </Button>
      <ContractViewerDialog title={title} body={body} onClose={() => setBody(null)} />
    </>
  );
}

/** The open-document dialog: the paper view plus Print / Save PDF. Hidden while `body` is null. */
export function ContractViewerDialog({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={body !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[860px] overflow-y-auto">
        <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pr-8">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          {body !== null && (
            <PrintButton fileTitle={title}>
              <ContractBody text={body} />
            </PrintButton>
          )}
        </DialogHeader>
        {body !== null && (
          <div className="rounded-md border border-border">
            <ContractBody text={body} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
