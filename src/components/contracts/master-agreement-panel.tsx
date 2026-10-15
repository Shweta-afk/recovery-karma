// Superadmin → Contracts → Agreement: ONE master agreement for every company (user, 2026-10-12).
// Top: every company and where it stands with the current version (Not sent → Sent → Viewed →
// Signed by whom, when), with "View their copy" and Send. Below: edit the text and publish a new
// version, previewed as any company. Both parties' details are {{blanks}} filled per company
// (contracts.server.ts), so renaming either company never needs a new upload.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  Mail,
  Send,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import { documentStage, type DocumentStatus } from "@/lib/contracts";
import { PLACEHOLDERS } from "@/lib/contract-template";
import {
  getContractDocumentBody,
  getMasterAgreement,
  previewContractTemplate,
  publishMasterAgreement,
  sendContractDocument,
  type SuperadminContractsView,
} from "@/lib/contracts.server";
import { whenLabel } from "@/lib/billing-delivery";
import { ContractViewerDialog } from "./contract-body";
import { fmtContractDate } from "./contract-documents";

type Company = SuperadminContractsView["companies"][number];
type Master = Awaited<ReturnType<typeof getMasterAgreement>>;

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
        {status?.signedEmail && <span className="font-normal">({status.signedEmail})</span>}
      </span>
    );
  }
  if (stage === "viewed") {
    return (
      <span
        className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-400"
        title={status?.viewedByEmail ?? undefined}
      >
        Viewed {whenLabel(status!.viewedAt!)}
        {status?.viewedByName ? ` by ${status.viewedByName}` : ""} · not signed
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

export function MasterAgreementPanel({
  view,
  onChanged,
}: {
  view: SuperadminContractsView;
  onChanged: () => Promise<void>;
}) {
  const [master, setMaster] = useState<Master | null>(null);
  const [sendFor, setSendFor] = useState<Company | null>(null);
  const [viewer, setViewer] = useState<{ title: string; body: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setMaster(await getMasterAgreement({ data: { accessToken: await getAccessToken() } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the agreement");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!master) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    );
  }

  const published = master.published;
  const statusOf = (clientId: string): DocumentStatus | null =>
    (published &&
      view.statuses.find((s) => s.documentId === published.id && s.clientId === clientId)) ||
    null;
  const signed = view.companies.filter((c) => statusOf(c.id)?.signedAt).length;
  const viewed = view.companies.filter((c) => statusOf(c.id)?.viewedAt).length;

  const openCopy = async (c: Company) => {
    if (!published) return;
    setOpening(c.id);
    try {
      const doc = await getContractDocumentBody({
        data: { accessToken: await getAccessToken(), documentId: published.id, asClientId: c.id },
      });
      setViewer({ title: `${doc.title} — ${c.name}`, body: doc.body });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open it");
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="space-y-4">
      {master.supplierMissing.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/50 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            Your company's details printed in the agreement are incomplete:{" "}
            {master.supplierMissing.join(", ")}. Fill them in on{" "}
            <Link to="/superadmin/invoices" className="font-medium underline">
              Invoices → SamvadX details
            </Link>
            . Every agreement picks them up automatically.
          </span>
        </div>
      )}

      {/* Status for every company */}
      <div className="rounded-lg border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {published ? published.title : "Master Service Agreement — not published yet"}
              {published?.versionLabel && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {published.versionLabel}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {published
                ? `Published ${fmtContractDate(published.createdAt.slice(0, 10))} · signed by ${signed} of ${view.companies.length} companies · opened by ${viewed}`
                : "Check the text below, then publish it once — every company gets it with its own details filled in."}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {published ? "Edit text / publish a new version" : "Review text & publish"}
          </Button>
        </div>
        {published && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Where they are</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {view.companies.map((c) => {
                  const st = statusOf(c.id);
                  return (
                    <tr key={c.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 font-medium text-foreground">{c.name}</td>
                      <td className="px-3 py-2">
                        <StageChip status={st} />
                      </td>
                      <td className="space-x-1.5 whitespace-nowrap px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-[11px]"
                          disabled={opening !== null}
                          onClick={() => openCopy(c)}
                        >
                          {opening === c.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Eye className="h-3 w-3" />
                          )}
                          {st?.signedAt ? "Signed copy" : "Their copy"}
                        </Button>
                        {!st?.signedAt && (
                          <Button
                            size="sm"
                            className="h-7 gap-1 text-[11px]"
                            onClick={() => setSendFor(c)}
                          >
                            <Mail className="h-3 w-3" />
                            {st?.sentAt ? "Send again" : "Send"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <EditAndPublish
          master={master}
          companies={view.companies}
          onPublished={async () => {
            setEditing(false);
            await load();
            await onChanged();
          }}
        />
      )}

      <SendDocumentDialog
        key={sendFor?.id ?? "none"}
        target={
          sendFor && published
            ? { company: sendFor, doc: { id: published.id, title: published.title } }
            : null
        }
        onClose={() => setSendFor(null)}
        onSent={onChanged}
      />
      <ContractViewerDialog
        title={viewer?.title ?? ""}
        body={viewer?.body ?? null}
        onClose={() => setViewer(null)}
      />
    </div>
  );
}

function EditAndPublish({
  master,
  companies,
  onPublished,
}: {
  master: Master;
  companies: Company[];
  onPublished: () => Promise<void>;
}) {
  const [title, setTitle] = useState(master.title);
  const [versionLabel, setVersionLabel] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIstKey());
  const [body, setBody] = useState(master.body);
  const [previewAs, setPreviewAs] = useState(companies[0]?.id ?? "");
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState<"preview" | "publish" | null>(null);

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">
        Write {"{{blanks}}"} where a company's or your own details go — they're filled in for each
        company automatically. Publishing a new version asks every company to sign again; signed
        copies of the earlier version are kept.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Title</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-xs" />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Version (optional)</span>
          <Input
            value={versionLabel}
            onChange={(e) => setVersionLabel(e.target.value)}
            placeholder="e.g. v2 — Oct 2026"
            className="h-8 text-xs"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Published on</span>
          <Input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="h-8 text-xs"
          />
        </label>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={18}
        className="font-mono text-[11px] leading-relaxed"
      />
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">Blanks you can use</summary>
        <ul className="mt-1 grid gap-x-4 sm:grid-cols-2">
          {PLACEHOLDERS.map((p) => (
            <li key={p.key}>
              <code className="text-foreground">{`{{${p.key}}}`}</code> — {p.meaning}
            </li>
          ))}
        </ul>
      </details>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-muted-foreground">Preview as</span>
        <Select value={previewAs} onValueChange={setPreviewAs}>
          <SelectTrigger className="h-8 w-56 text-xs">
            <SelectValue placeholder="Pick a company" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={!previewAs || busy !== null}
          onClick={async () => {
            setBusy("preview");
            try {
              const res = await previewContractTemplate({
                data: {
                  accessToken: await getAccessToken(),
                  clientId: previewAs,
                  body,
                  effectiveDate,
                },
              });
              if (res.unknown.length) {
                toast.error(`Unknown blanks: ${res.unknown.map((u) => `{{${u}}}`).join(", ")}`);
              }
              setPreview({
                title: `${title} — as ${companies.find((c) => c.id === previewAs)?.name ?? ""} sees it`,
                body: res.text,
              });
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not build the preview");
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "preview" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Eye className="h-3 w-3" />
          )}
          Preview
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1 text-xs"
          disabled={busy !== null || !title.trim() || body.trim().length < 50}
          onClick={async () => {
            if (
              !window.confirm(
                master.published
                  ? "Publish this as a new version? Every company will be asked to sign it again."
                  : "Publish this agreement to every company?",
              )
            ) {
              return;
            }
            setBusy("publish");
            try {
              await publishMasterAgreement({
                data: {
                  accessToken: await getAccessToken(),
                  title: title.trim(),
                  versionLabel: versionLabel.trim() || undefined,
                  effectiveDate,
                  body,
                },
              });
              toast.success("Published — send it to each company from the list");
              await onPublished();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not publish");
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "publish" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          {master.published ? "Publish new version" : "Publish to every company"}
        </Button>
      </div>
      <ContractViewerDialog
        title={preview?.title ?? ""}
        body={preview?.body ?? null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function SendDocumentDialog({
  target,
  onClose,
  onSent,
}: {
  target: { company: Company; doc: { id: string; title: string } } | null;
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
