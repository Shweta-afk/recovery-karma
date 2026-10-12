// Superadmin → Contracts → Agreements: one row per company — its current agreement and SamvadX's
// terms, each with where it stands (Not sent → Sent → Viewed → Signed), and the next step right
// there: Create from the template (with a preview), Preview, Send. Statuses come from
// contract_document_status (contracts.server.ts); the company signs on Admin → Billing.
import { useMemo, useState } from "react";
import { CheckCircle2, Eye, Loader2, Mail, PenLine, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { todayIstKey } from "@/lib/date-filter";
import {
  currentDocument,
  documentStage,
  type ContractDocument,
  type DocumentStatus,
} from "@/lib/contracts";
import {
  generateCompanyContract,
  previewContractTemplate,
  sendContractDocument,
  type SuperadminContractsView,
} from "@/lib/contracts.server";
import { whenLabel } from "@/lib/billing-delivery";
import { ContractBody, ViewContractButton } from "./contract-body";
import { DownloadContractButton, fmtContractDate } from "./contract-documents";

type Company = SuperadminContractsView["companies"][number];

function StageChip({ status }: { status: DocumentStatus | null }) {
  const stage = documentStage(status);
  if (stage === "signed") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
        title={`${status?.signedName} · ${status?.signedEmail}`}
      >
        <CheckCircle2 className="h-3 w-3" /> Signed {whenLabel(status!.signedAt!)} ·{" "}
        {status?.signedName}
      </span>
    );
  }
  if (stage === "viewed") {
    return (
      <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-400">
        Viewed {whenLabel(status!.viewedAt!)} · not signed
      </span>
    );
  }
  if (stage === "sent") {
    return (
      <span
        className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
        title={status?.sentTo ?? undefined}
      >
        {status?.sentVia === "mail_app" ? "Mail app opened" : "Sent"} {whenLabel(status!.sentAt!)} ·
        not opened
      </span>
    );
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
      Not sent
    </span>
  );
}

function OpenDoc({ doc }: { doc: ContractDocument }) {
  return doc.generated ? (
    <ViewContractButton documentId={doc.id} title={doc.title} />
  ) : (
    <DownloadContractButton documentId={doc.id} label="Open" />
  );
}

export function AgreementsBoard({
  view,
  onChanged,
}: {
  view: SuperadminContractsView;
  onChanged: () => Promise<void>;
}) {
  const today = todayIstKey();
  const terms = useMemo(
    () =>
      currentDocument(
        view.documents.filter((d) => d.clientId === null),
        today,
      ),
    [view.documents, today],
  );
  const [sendFor, setSendFor] = useState<{ company: Company; doc: ContractDocument } | null>(null);
  const [createFor, setCreateFor] = useState<Company | null>(null);

  const statusOf = (docId: string | undefined, clientId: string) =>
    view.statuses.find((s) => s.documentId === docId && s.clientId === clientId) ?? null;

  const signedCount = view.companies.filter((c) => {
    const agreement = currentDocument(
      view.documents.filter((d) => d.clientId === c.id),
      today,
    );
    return agreement && statusOf(agreement.id, c.id)?.signedAt;
  }).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {signedCount} of {view.companies.length} companies have signed their agreement. Each company
        signs on their Billing &amp; Agreements page; the email you send links straight to it.
        {!view.emailConfigured &&
          " Email isn't set up yet, so Send opens your own mail app with the email written."}
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Their agreement</th>
              <th className="px-3 py-2 font-medium">SamvadX terms</th>
            </tr>
          </thead>
          <tbody>
            {view.companies.map((c) => {
              const agreement = currentDocument(
                view.documents.filter((d) => d.clientId === c.id),
                today,
              );
              const aStatus = statusOf(agreement?.id, c.id);
              const tStatus = statusOf(terms?.id, c.id);
              return (
                <tr key={c.id} className="border-b border-border/60 align-top last:border-0">
                  <td className="px-3 py-3 font-medium text-foreground">{c.name}</td>
                  <td className="px-3 py-3">
                    {agreement ? (
                      <div className="space-y-1.5">
                        <div>
                          {agreement.title}
                          <span className="text-muted-foreground">
                            {" "}
                            · effective {fmtContractDate(agreement.effectiveDate)}
                          </span>
                        </div>
                        <StageChip status={aStatus} />
                        <div className="flex flex-wrap gap-1.5">
                          <OpenDoc doc={agreement} />
                          {!aStatus?.signedAt && (
                            <Button
                              size="sm"
                              className="h-7 gap-1 text-[11px]"
                              onClick={() => setSendFor({ company: c, doc: agreement })}
                            >
                              <Mail className="h-3 w-3" />
                              {aStatus?.sentAt ? "Send again" : "Send"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 text-[11px]"
                            onClick={() => setCreateFor(c)}
                          >
                            <Plus className="h-3 w-3" /> New version
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <span className="text-muted-foreground">No agreement yet</span>
                        <div>
                          <Button
                            size="sm"
                            className="h-7 gap-1 text-[11px]"
                            onClick={() => setCreateFor(c)}
                          >
                            <PenLine className="h-3 w-3" /> Create from template
                          </Button>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {terms ? (
                      <div className="space-y-1.5">
                        <StageChip status={tStatus} />
                        {!tStatus?.signedAt && (
                          <div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 text-[11px]"
                              onClick={() => setSendFor({ company: c, doc: terms })}
                            >
                              <Mail className="h-3 w-3" />
                              {tStatus?.sentAt ? "Send again" : "Send"}
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No terms uploaded yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SendDocumentDialog
        key={sendFor ? `${sendFor.doc.id}|${sendFor.company.id}` : "none"}
        target={sendFor}
        onClose={() => setSendFor(null)}
        onSent={onChanged}
      />
      <CreateAgreementDialog
        key={createFor?.id ?? "none"}
        company={createFor}
        view={view}
        onClose={() => setCreateFor(null)}
        onCreated={onChanged}
      />
    </div>
  );
}

function SendDocumentDialog({
  target,
  onClose,
  onSent,
}: {
  target: { company: Company; doc: ContractDocument } | null;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const options = [
    ...new Set([target?.company.billingEmail, ...(target?.company.adminEmails ?? [])]),
  ].filter(Boolean) as string[];
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const value = to || options[0] || "";

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Send "{target?.doc.title}"</DialogTitle>
          <DialogDescription className="text-xs">
            To {target?.company.name}. The email links to it in their SamvadX account, where an
            admin reads and signs it. You'll see Viewed and Signed here.
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Send to</span>
          <Input
            type="email"
            value={value}
            onChange={(e) => setTo(e.target.value)}
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
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={sending || !value.includes("@")}
            onClick={async () => {
              if (!target) return;
              setSending(true);
              try {
                const res = await sendContractDocument({
                  data: {
                    accessToken: await getAccessToken(),
                    documentId: target.doc.id,
                    clientId: target.company.id,
                    to: value.trim(),
                  },
                });
                if (res.mailto) {
                  window.location.href = res.mailto;
                  toast.success(
                    "Your mail app is opening with the email written — press Send there",
                  );
                } else {
                  toast.success(`Sent to ${value}`);
                }
                await onSent();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not send it");
              } finally {
                setSending(false);
              }
            }}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Mail className="h-3.5 w-3.5" />
            )}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Make a company's agreement from the saved template: pick the date, Preview (filled with the
 *  company's details and prices, nothing saved), then Create. Send it from the board after. */
function CreateAgreementDialog({
  company,
  view,
  onClose,
  onCreated,
}: {
  company: Company | null;
  view: SuperadminContractsView;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const template = view.templates[0] ?? null;
  const [title, setTitle] = useState(company ? `SamvadX agreement — ${company.name}` : "");
  const [effectiveDate, setEffectiveDate] = useState(todayIstKey());
  const [preview, setPreview] = useState<{ text: string; unknown: string[] } | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);

  const runPreview = async () => {
    if (!company || !template) return;
    setBusy("preview");
    try {
      setPreview(
        await previewContractTemplate({
          data: {
            accessToken: await getAccessToken(),
            clientId: company.id,
            body: template.body,
            effectiveDate,
          },
        }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the preview");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={!!company} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-[860px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Agreement for {company?.name}</DialogTitle>
          <DialogDescription className="text-xs">
            Made from your template and filled in with this company's details and prices. Preview
            it, then create it — you can send it from the Agreements list.
          </DialogDescription>
        </DialogHeader>
        {!template ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            Set up the agreement template first (Template tab), then come back.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Title</span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-9 text-sm"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Takes effect on</span>
                <Input
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => {
                    setEffectiveDate(e.target.value);
                    setPreview(null);
                  }}
                  className="h-9 text-sm"
                />
              </label>
            </div>
            {preview ? (
              <div className="space-y-2">
                {preview.unknown.length > 0 && (
                  <p className="text-xs text-destructive">
                    The template has blanks SamvadX doesn't know:{" "}
                    {preview.unknown.map((u) => `{{${u}}}`).join(", ")} — fix it in the Template
                    tab.
                  </p>
                )}
                <div className="rounded-md border border-border">
                  <ContractBody text={preview.text} />
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Preview it to check before creating.</p>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {template && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={busy !== null}
                onClick={runPreview}
              >
                {busy === "preview" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                Preview
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || !preview || preview.unknown.length > 0 || !title.trim()}
                onClick={async () => {
                  if (!company || !template) return;
                  setBusy("create");
                  try {
                    await generateCompanyContract({
                      data: {
                        accessToken: await getAccessToken(),
                        clientId: company.id,
                        templateId: template.id,
                        title: title.trim(),
                        effectiveDate,
                      },
                    });
                    toast.success("Agreement created — send it from the list");
                    await onCreated();
                    onClose();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not create the agreement");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "create" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Create agreement"
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
