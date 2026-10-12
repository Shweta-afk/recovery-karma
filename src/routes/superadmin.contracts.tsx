import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileSignature,
  FileText,
  Loader2,
  Mail,
  Send,
  Upload,
  Undo2,
  EyeOff,
  Megaphone,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import { changeMailto } from "@/lib/contracts";
import {
  createContractUpload,
  getSuperadminContracts,
  publishContractChange,
  saveContractDocument,
  withdrawContractChange,
  type SuperadminContractChange,
  type SuperadminContractsView,
} from "@/lib/contracts.server";
import { downloadXlsx } from "@/lib/xlsx-export";
import {
  ContractDocumentList,
  DownloadContractButton,
  fmtContractDate,
} from "@/components/contracts/contract-documents";
import { ExcelButton } from "@/components/superadmin/usage-shared";
import { InfoTip, PageGuide } from "@/components/superadmin/help";
import { DraftsCard, TemplatesCard } from "@/components/contracts/drafts-and-templates";
import { AgreementsBoard } from "@/components/contracts/agreements-board";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/superadmin/contracts")({
  head: () => ({ meta: [{ title: "Contracts · SamvadX Platform" }] }),
  component: SuperadminContractsPage,
});

const PLATFORM = "platform";

function SuperadminContractsPage() {
  const [view, setView] = useState<SuperadminContractsView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      setView(await getSuperadminContracts({ data: { accessToken } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load contracts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const exportAcceptances = () =>
    downloadXlsx(`samvadx-contract-acceptances-${todayIstKey()}.xlsx`, [
      {
        name: "Acceptances",
        headers: [
          "Change",
          "Effective",
          "Published",
          "Status",
          "Company",
          "Accepted by",
          "Email",
          "Accepted at",
        ],
        rows: (view?.changes ?? []).flatMap((c) =>
          c.companies.map((co) => [
            c.title,
            c.effectiveDate,
            new Date(c.createdAt).toLocaleString("en-IN"),
            c.withdrawnAt
              ? "Withdrawn"
              : !c.requiresAcceptance
                ? "For information"
                : co.acceptance
                  ? "Accepted"
                  : "Waiting",
            co.companyName,
            co.acceptance?.acceptedName ?? "",
            co.acceptance?.acceptedEmail ?? "",
            co.acceptance ? new Date(co.acceptance.acceptedAt).toLocaleString("en-IN") : "",
          ]),
        ),
      },
      {
        name: "Documents",
        headers: ["For", "Title", "Version", "Effective", "File", "Uploaded"],
        rows: (view?.documents ?? []).map((d) => [
          d.companyName ?? "All companies (platform terms)",
          d.title,
          d.versionLabel ?? "",
          d.effectiveDate,
          d.fileName,
          new Date(d.createdAt).toLocaleString("en-IN"),
        ]),
      },
    ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Contracts</h1>
            <Badge variant="secondary">Superadmin</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Make each company's agreement, send it, and see who has viewed and signed it.
          </p>
        </div>
        <ExcelButton disabled={!view} onExport={exportAcceptances} />
      </div>

      <PageGuide page="contracts" />

      {view && !view.companiesCanSee && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/50 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          <EyeOff className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <span className="font-semibold">Only superadmins can see Contracts for now.</span> You
            can upload contracts and publish changes, but company admins can't see them yet, so
            publishing doesn't notify or email anyone and nobody can accept. Everything you add here
            is kept and appears for companies once Contracts is opened to them.
          </div>
        </div>
      )}

      {!view ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : (
        <Tabs defaultValue="agreements" className={loading ? "opacity-60" : undefined}>
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="agreements" className="text-xs">
              <FileSignature className="mr-1.5 h-3.5 w-3.5" />
              Agreements
            </TabsTrigger>
            <TabsTrigger value="terms" className="text-xs">
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Terms &amp; uploads
            </TabsTrigger>
            <TabsTrigger value="changes" className="text-xs">
              <Megaphone className="mr-1.5 h-3.5 w-3.5" />
              Changes &amp; notices
              {view.drafts.length > 0 && (
                <Badge className="ml-1.5 h-4 px-1.5 text-[10px]">{view.drafts.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="template" className="text-xs">
              <PenLine className="mr-1.5 h-3.5 w-3.5" />
              Template
            </TabsTrigger>
          </TabsList>

          {/* 1. Who has which agreement, and whether they've signed — the page's main job. */}
          <TabsContent value="agreements">
            <AgreementsBoard view={view} onChanged={load} />
          </TabsContent>

          {/* 2. SamvadX's terms for everyone, and uploading a signed copy for one company. */}
          <TabsContent value="terms" className="space-y-6">
            <UploadDocumentCard view={view} onUploaded={load} />
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="h-4 w-4 text-primary" />
                  All documents
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Every version, uploaded or made from the template. "Current" is the latest one
                  already in effect for that company (or for the platform terms).
                </p>
              </CardHeader>
              <CardContent className="pt-4">
                <ContractDocumentList
                  documents={view.documents}
                  empty="No documents yet."
                  showCompany
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* 3. Notices when a feature or price changes; drafts are made automatically. */}
          <TabsContent value="changes" className="space-y-6">
            <DraftsCard
              drafts={view.drafts}
              companiesCanSee={view.companiesCanSee}
              onChanged={load}
            />
            <PublishChangeCard view={view} onPublished={load} />
            <ChangesCard changes={view.changes} onChanged={load} canEmail={view.companiesCanSee} />
          </TabsContent>

          {/* 4. The agreement text with {{blanks}} filled per company. */}
          <TabsContent value="template">
            <TemplatesCard view={view} onChanged={load} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ── Publish a change ────────────────────────────────────────────────────────

function PublishChangeCard({
  view,
  onPublished,
}: {
  view: SuperadminContractsView;
  onPublished: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIstKey());
  const [audience, setAudience] = useState<"all" | "some">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [requiresAcceptance, setRequiresAcceptance] = useState(true);
  const [documentId, setDocumentId] = useState<string>("none");
  const [saving, setSaving] = useState(false);
  const [lastPublished, setLastPublished] = useState<{
    title: string;
    message: string;
    /** Manual email fallback — only when companies can see it and Resend isn't set up. */
    mailto: string | null;
  } | null>(null);

  const canPublish =
    title.trim() && body.trim() && effectiveDate && (audience === "all" || selected.size > 0);

  const publish = async () => {
    const targets = audience === "all" ? null : [...selected];
    const who =
      audience === "all"
        ? "every company"
        : `${selected.size} compan${selected.size === 1 ? "y" : "ies"}`;
    const consequence = view.companiesCanSee
      ? "Their admins are notified now."
      : "Companies can't see contracts yet, so nobody is notified.";
    if (!window.confirm(`Publish "${title.trim()}" to ${who}? ${consequence}`)) {
      return;
    }
    setSaving(true);
    try {
      const accessToken = await getAccessToken();
      const res = await publishContractChange({
        data: {
          accessToken,
          title: title.trim(),
          body: body.trim(),
          effectiveDate,
          clientIds: targets,
          requiresAcceptance,
          documentId: documentId === "none" ? undefined : documentId,
        },
      });
      const message = !res.companiesCanSee
        ? "Saved. Companies can't see contracts yet, so nobody was notified."
        : res.emailedAdmins === null
          ? `${res.notifiedAdmins} admin(s) notified in the app. Automatic email isn't set up — use "Email the admins".`
          : `${res.notifiedAdmins} admin(s) notified in the app and ${res.emailedAdmins} emailed.`;
      toast.success("Published");
      setLastPublished({
        title: title.trim(),
        message,
        mailto:
          res.companiesCanSee && res.emailedAdmins === null
            ? changeMailto(res.adminEmails, {
                title: title.trim(),
                body: body.trim(),
                effectiveDate,
                requiresAcceptance,
              })
            : null,
      });
      setTitle("");
      setBody("");
      setSelected(new Set());
      setDocumentId("none");
      await onPublished();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not publish the change");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Send className="h-4 w-4 text-primary" />
          Publish a change
          <InfoTip k="contractChange" />
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          For example when a feature is added, removed, or its price changes.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short title, e.g. Employment lookups added to Insights"
          maxLength={200}
          className="text-xs"
        />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What changes, in plain words — what's new, the price, from when, and anything the company must do."
          rows={5}
          maxLength={5000}
          className="text-xs"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Effective from
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Switch checked={requiresAcceptance} onCheckedChange={setRequiresAcceptance} />
            Admins must accept
            <InfoTip k="requiresAcceptance" />
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Applies to</span>
            <Select value={audience} onValueChange={(v) => setAudience(v as "all" | "some")}>
              <SelectTrigger className="h-8 w-48 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  Every company
                </SelectItem>
                <SelectItem value="some" className="text-xs">
                  Selected companies
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {audience === "some" && (
            <div className="max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
              {view.companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-xs text-foreground">
                  <Checkbox
                    checked={selected.has(c.id)}
                    onCheckedChange={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v === true) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                  {c.name}
                  <span className="text-[10px] text-muted-foreground">
                    {c.adminEmails.length} admin(s)
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Attach a document</span>
          <Select value={documentId} onValueChange={setDocumentId}>
            <SelectTrigger className="h-8 w-72 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" className="text-xs">
                None
              </SelectItem>
              {view.documents.map((d) => (
                <SelectItem key={d.id} value={d.id} className="text-xs">
                  {d.companyName ?? "Platform terms"} — {d.title}
                  {d.versionLabel ? ` (${d.versionLabel})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          size="sm"
          className="gap-1 text-xs"
          disabled={!canPublish || saving}
          onClick={publish}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          {view.companiesCanSee ? "Publish and notify admins" : "Publish"}
        </Button>

        {lastPublished && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            <span>
              "{lastPublished.title}" published. {lastPublished.message}
            </span>
            {lastPublished.mailto && (
              <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-[11px]">
                <a href={lastPublished.mailto}>
                  <Mail className="h-3 w-3" /> Email the admins
                </a>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Upload a document ───────────────────────────────────────────────────────

function UploadDocumentCard({
  view,
  onUploaded,
}: {
  view: SuperadminContractsView;
  onUploaded: () => Promise<void>;
}) {
  const [target, setTarget] = useState<string>(PLATFORM);
  const [title, setTitle] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIstKey());
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async () => {
    if (!file) return;
    setSaving(true);
    try {
      const accessToken = await getAccessToken();
      const clientId = target === PLATFORM ? null : target;
      const slot = await createContractUpload({
        data: { accessToken, clientId, fileName: file.name, fileSize: file.size },
      });
      const { error } = await supabase.storage
        .from(slot.bucket)
        .uploadToSignedUrl(slot.path, slot.token, file, { contentType: slot.contentType });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      await saveContractDocument({
        data: {
          accessToken,
          clientId,
          title: title.trim(),
          versionLabel: versionLabel.trim() || undefined,
          effectiveDate,
          path: slot.path,
          fileName: file.name,
          fileSize: file.size,
          notes: notes.trim() || undefined,
        },
      });
      toast.success("Contract uploaded");
      setTitle("");
      setVersionLabel("");
      setNotes("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await onUploaded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not upload the contract");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Upload className="h-4 w-4 text-primary" />
          Upload a contract
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A PDF or Word file, up to 20 MB. Uploading a new version keeps the earlier ones.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">For</span>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="h-8 w-72 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PLATFORM} className="text-xs">
                All companies — SamvadX platform terms
              </SelectItem>
              {view.companies.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  {c.name} — signed agreement
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InfoTip k={target === PLATFORM ? "platformTerms" : "companyAgreement"} />
        </div>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title, e.g. Master Service Agreement"
          maxLength={200}
          className="text-xs"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={versionLabel}
            onChange={(e) => setVersionLabel(e.target.value)}
            placeholder="Version (optional), e.g. v2"
            maxLength={40}
            className="h-8 w-48 text-xs"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Effective from
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            />
          </label>
        </div>
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Note (optional), e.g. Signed by both parties on 5 Oct"
          maxLength={2000}
          className="text-xs"
        />
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:text-foreground"
        />
        <Button
          size="sm"
          className="gap-1 text-xs"
          disabled={!file || !title.trim() || !effectiveDate || saving}
          onClick={upload}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
          Upload
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Uploading doesn't notify anyone. To tell companies about a new version, publish a change
          and attach this document to it.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Published changes and who accepted ──────────────────────────────────────

function ChangesCard({
  changes,
  onChanged,
  canEmail,
}: {
  changes: SuperadminContractChange[];
  onChanged: () => Promise<void>;
  /** Offer "Email the admins" only once companies can actually see contracts. */
  canEmail: boolean;
}) {
  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileSignature className="h-4 w-4 text-primary" />
          Published changes
          <InfoTip k="acceptanceStatus" />
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Newest first. Open one to see which companies have accepted it and who accepted.
        </p>
      </CardHeader>
      <CardContent className="space-y-2 pt-4">
        {changes.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No changes published yet.
          </p>
        ) : (
          changes.map((c) => (
            <ChangeRow key={c.id} change={c} onChanged={onChanged} canEmail={canEmail} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ChangeRow({
  change,
  onChanged,
  canEmail,
}: {
  change: SuperadminContractChange;
  onChanged: () => Promise<void>;
  canEmail: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const accepted = change.companies.filter((c) => c.acceptance).length;
  const total = change.companies.length;
  const waiting = change.companies.filter((c) => !c.acceptance);
  const mailtoWaiting = useMemo(
    () =>
      changeMailto(
        (change.requiresAcceptance ? waiting : change.companies).flatMap((c) => c.adminEmails),
        change,
      ),
    [change, waiting],
  );

  const status = change.withdrawnAt ? (
    <Badge variant="secondary" className="text-[10px]">
      Withdrawn
    </Badge>
  ) : !change.requiresAcceptance ? (
    <Badge variant="outline" className="text-[10px]">
      For information · {total} compan{total === 1 ? "y" : "ies"}
    </Badge>
  ) : (
    <Badge
      variant={accepted === total ? "default" : "outline"}
      className={`text-[10px] ${accepted < total ? "border-amber-500/50 text-amber-600" : ""}`}
    >
      {accepted} of {total} accepted
    </Badge>
  );

  return (
    <div className={`rounded-lg border border-border ${change.withdrawnAt ? "opacity-60" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="truncate text-xs font-medium text-foreground">{change.title}</span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">
            effective {fmtContractDate(change.effectiveDate)} ·{" "}
            {change.clientIds ? `${change.clientIds.length} selected` : "every company"}
          </span>
        </span>
        {status}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {change.body}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {change.documentId && (
              <DownloadContractButton documentId={change.documentId} label="Attached document" />
            )}
            {canEmail && !change.withdrawnAt && (
              <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-[11px]">
                <a href={mailtoWaiting}>
                  <Mail className="h-3 w-3" />
                  {change.requiresAcceptance
                    ? `Email admins still to accept (${waiting.length} companies)`
                    : "Email the admins"}
                </a>
              </Button>
            )}
            {!change.withdrawnAt && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px] text-destructive hover:text-destructive"
                disabled={withdrawing}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Withdraw "${change.title}"? It stays in the history marked Withdrawn, and admins no longer need to accept it.`,
                    )
                  ) {
                    return;
                  }
                  setWithdrawing(true);
                  try {
                    const accessToken = await getAccessToken();
                    await withdrawContractChange({ data: { accessToken, changeId: change.id } });
                    toast.success("Change withdrawn");
                    await onChanged();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not withdraw the change");
                  } finally {
                    setWithdrawing(false);
                  }
                }}
              >
                <Undo2 className="h-3 w-3" /> Withdraw
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1.5 pr-4 font-medium">Company</th>
                  <th className="py-1.5 pr-4 font-medium">Status</th>
                  <th className="py-1.5 pr-4 font-medium">Accepted by</th>
                  <th className="py-1.5 pr-4 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {change.companies.map((co) => (
                  <tr key={co.clientId} className="border-b border-border last:border-0">
                    <td className="py-1.5 pr-4 text-foreground">{co.companyName}</td>
                    <td className="py-1.5 pr-4">
                      {co.acceptance ? (
                        <span className="text-emerald-600">Accepted</span>
                      ) : change.requiresAcceptance && !change.withdrawnAt ? (
                        <span className="text-amber-600">Waiting</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-4 text-muted-foreground">
                      {co.acceptance
                        ? `${co.acceptance.acceptedName} (${co.acceptance.acceptedEmail})`
                        : "—"}
                    </td>
                    <td className="py-1.5 pr-4 text-muted-foreground">
                      {co.acceptance
                        ? new Date(co.acceptance.acceptedAt).toLocaleString("en-IN")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
