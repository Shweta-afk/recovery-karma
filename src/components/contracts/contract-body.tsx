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

export function ContractBody({ text }: { text: string }) {
  const blocks = parseTemplateBlocks(text);
  return (
    <div className="mx-auto w-full max-w-[800px] space-y-3 bg-white p-8 text-[12px] leading-relaxed text-neutral-900 print:max-w-none print:p-0">
      <img src="/logo.png" alt="SamvadX" className="mb-2 h-8 w-auto" />
      {blocks.map((b, i) => {
        if (b.type === "h1")
          return (
            <h1 key={i} className="text-lg font-bold">
              <Inline text={b.text} />
            </h1>
          );
        if (b.type === "h2")
          return (
            <h2 key={i} className="border-b border-neutral-300 pt-2 text-sm font-semibold">
              <Inline text={b.text} />
            </h2>
          );
        if (b.type === "p")
          return (
            <p key={i}>
              <Inline text={b.text} />
            </p>
          );
        if (b.type === "ul")
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {b.items.map((it, n) => (
                <li key={n}>
                  <Inline text={it} />
                </li>
              ))}
            </ul>
          );
        if (b.type !== "table") return null;
        const [head, ...rows] = b.rows;
        return (
          <table key={i} className="w-full border-collapse">
            <thead>
              <tr className="border-y border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
                {head.map((c, n) => (
                  <th key={n} className={`py-1.5 pr-2 font-semibold ${n > 0 ? "text-right" : ""}`}>
                    <Inline text={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n} className="border-b border-neutral-200">
                  {r.map((c, k) => (
                    <td key={k} className={`py-1.5 pr-2 ${k > 0 ? "text-right tabular-nums" : ""}`}>
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
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
