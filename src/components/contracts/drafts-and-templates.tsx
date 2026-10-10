// Superadmin → Contracts: draft changes (made automatically when a company's prices change) and
// contract templates (write once, preview for a company, generate that company's document).

import { useEffect, useState } from "react";
import { FilePen, FileStack, Loader2, Plus, Save, Send, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import { changeMailto, type ContractChange } from "@/lib/contracts";
import { PLACEHOLDERS } from "@/lib/contract-template";
import {
  discardDraftChange,
  generateCompanyContract,
  getDefaultContractTemplate,
  previewContractTemplate,
  publishDraftChange,
  saveContractTemplate,
  updateDraftChange,
  type ContractTemplate,
  type SuperadminContractsView,
} from "@/lib/contracts.server";
import { ContractBody } from "./contract-body";

// ── Drafts ───────────────────────────────────────────────────────────────────

type Draft = ContractChange & { companyNames: string[] };

export function DraftsCard({
  drafts,
  companiesCanSee,
  onChanged,
}: {
  drafts: Draft[];
  companiesCanSee: boolean;
  onChanged: () => Promise<void>;
}) {
  if (!drafts.length) return null;
  return (
    <Card className="border-primary/30">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FilePen className="h-4 w-4 text-primary" />
          Drafts to review ({drafts.length})
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Made automatically when you changed a company's prices. Companies can't see a draft — edit
          the wording if you like, then publish it or discard it.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {drafts.map((d) => (
          <DraftRow key={d.id} draft={d} companiesCanSee={companiesCanSee} onChanged={onChanged} />
        ))}
      </CardContent>
    </Card>
  );
}

function DraftRow({
  draft,
  companiesCanSee,
  onChanged,
}: {
  draft: Draft;
  companiesCanSee: boolean;
  onChanged: () => Promise<void>;
}) {
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [effectiveDate, setEffectiveDate] = useState(draft.effectiveDate);
  const [requiresAcceptance, setRequiresAcceptance] = useState(draft.requiresAcceptance);
  const [busy, setBusy] = useState<string | null>(null);
  const dirty =
    title !== draft.title ||
    body !== draft.body ||
    effectiveDate !== draft.effectiveDate ||
    requiresAcceptance !== draft.requiresAcceptance;

  const save = async () => {
    const accessToken = await getAccessToken();
    await updateDraftChange({
      data: {
        accessToken,
        changeId: draft.id,
        title: title.trim(),
        body: body.trim(),
        effectiveDate,
        requiresAcceptance,
      },
    });
  };

  const run = async (what: "save" | "publish" | "discard") => {
    if (what === "discard" && !window.confirm(`Discard the draft "${draft.title}"?`)) return;
    if (
      what === "publish" &&
      !window.confirm(
        companiesCanSee
          ? `Publish "${title.trim()}"? The company's admins are notified now.`
          : `Publish "${title.trim()}"? Companies can't see contracts yet, so nobody is notified.`,
      )
    ) {
      return;
    }
    setBusy(what);
    try {
      if (what === "discard") {
        const accessToken = await getAccessToken();
        await discardDraftChange({ data: { accessToken, changeId: draft.id } });
        toast.success("Draft discarded");
      } else {
        if (dirty) await save();
        if (what === "publish") {
          const accessToken = await getAccessToken();
          const res = await publishDraftChange({ data: { accessToken, changeId: draft.id } });
          if (res.companiesCanSee && res.emailedAdmins === null && res.adminEmails.length) {
            toast.success("Published — opening your email app to tell the admins");
            window.location.href = changeMailto(res.adminEmails, {
              title,
              body,
              effectiveDate,
              requiresAcceptance,
            });
          } else toast.success("Published");
        } else toast.success("Draft saved");
      }
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the draft");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" className="text-[10px]">
          Draft
        </Badge>
        For {draft.companyNames.length ? draft.companyNames.join(", ") : "every company"} · made{" "}
        {new Date(draft.createdAt).toLocaleString("en-IN")}
      </div>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        className="h-8 text-xs"
      />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.min(10, Math.max(4, body.split("\n").length + 1))}
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
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={requiresAcceptance} onCheckedChange={setRequiresAcceptance} />
          Admins must accept
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 text-xs text-destructive hover:text-destructive"
            disabled={busy !== null}
            onClick={() => run("discard")}
          >
            <Trash2 className="h-3 w-3" /> Discard
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            disabled={busy !== null || !dirty || !title.trim() || !body.trim()}
            onClick={() => run("save")}
          >
            {busy === "save" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={busy !== null || !title.trim() || !body.trim()}
            onClick={() => run("publish")}
          >
            {busy === "publish" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Publish
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

const NEW = "new";

export function TemplatesCard({
  view,
  onChanged,
}: {
  view: SuperadminContractsView;
  onChanged: () => Promise<void>;
}) {
  const templates: ContractTemplate[] = view.templates;
  const [selected, setSelected] = useState<string>(templates[0]?.id ?? NEW);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const [companyId, setCompanyId] = useState<string>(view.companies[0]?.id ?? "");
  const [effectiveDate, setEffectiveDate] = useState(todayIstKey());
  const [versionLabel, setVersionLabel] = useState("");
  const [preview, setPreview] = useState<{ text: string; unknown: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Load the chosen template (or the starter text for a new one) into the editor.
  useEffect(() => {
    setPreview(null);
    const t = templates.find((x) => x.id === selected);
    if (t) {
      setTitle(t.title);
      setBody(t.body);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const accessToken = await getAccessToken();
        const d = await getDefaultContractTemplate({ data: { accessToken } });
        if (!cancelled) {
          setTitle(d.title);
          setBody(d.body);
        }
      } catch {
        // The editor just starts empty.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const saved = templates.find((t) => t.id === selected);
  const dirty = !saved || saved.title !== title || saved.body !== body;
  const companyName = view.companies.find((c) => c.id === companyId)?.name ?? "";

  const save = async (): Promise<string | null> => {
    if (!title.trim() || !body.trim()) {
      toast.error("Give the template a title and some text");
      return null;
    }
    setSaving(true);
    try {
      const accessToken = await getAccessToken();
      const res = await saveContractTemplate({
        data: {
          accessToken,
          templateId: saved?.id,
          title: title.trim(),
          body: body.trim(),
        },
      });
      toast.success("Template saved");
      await onChanged();
      setSelected(res.id);
      return res.id;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the template");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    if (!companyId) return;
    setBusy("preview");
    try {
      const accessToken = await getAccessToken();
      setPreview(
        await previewContractTemplate({
          data: { accessToken, clientId: companyId, body, effectiveDate },
        }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not preview");
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!companyId) return;
    // Generating always uses the SAVED template, so save edits first.
    const templateId = dirty ? await save() : (saved?.id ?? null);
    if (!templateId) return;
    if (
      !window.confirm(
        `Generate "${title.trim()}" for ${companyName} with its current prices, effective ${effectiveDate}? It's saved as a new version of their documents.`,
      )
    ) {
      return;
    }
    setBusy("generate");
    try {
      const accessToken = await getAccessToken();
      await generateCompanyContract({
        data: {
          accessToken,
          clientId: companyId,
          templateId,
          title: title.trim(),
          versionLabel: versionLabel.trim() || undefined,
          effectiveDate,
        },
      });
      toast.success(`Generated for ${companyName} — it's in Documents below`);
      setVersionLabel("");
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate the document");
    } finally {
      setBusy(null);
    }
  };

  const insert = (key: string) =>
    setBody((b) => `${b}${b.endsWith("\n") || !b ? "" : " "}{{${key}}}`);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileStack className="h-4 w-4 text-primary" />
          Contract templates
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Write the part of the contract that changes per company (usually the commercial schedule)
          once, with blanks like <code>{"{{setup_fee_table}}"}</code>. Then generate each company's
          version from its price list and Insights prices — no uploading the same file again with
          new numbers.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Template</span>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="h-8 w-64 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-xs">
                  {t.title}
                </SelectItem>
              ))}
              <SelectItem value={NEW} className="text-xs">
                + New template
              </SelectItem>
            </SelectContent>
          </Select>
          {selected === NEW && (
            <span className="text-[11px] text-muted-foreground">
              Starts from a ready-made commercial schedule — edit freely.
            </span>
          )}
        </div>

        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Template title, e.g. Commercial Schedule"
          maxLength={200}
          className="h-8 text-xs"
        />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={16}
          maxLength={50000}
          className="font-mono text-[11px]"
        />
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            Blanks you can use (click to add at the end). Formatting: <code># Heading</code>,{" "}
            <code>## Subheading</code>, <code>- bullet</code>, <code>**bold**</code>.
          </p>
          <div className="flex flex-wrap gap-1">
            {PLACEHOLDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.meaning}
                onClick={() => insert(p.key)}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {`{{${p.key}}}`}
              </button>
            ))}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {saved ? (
            "Save template"
          ) : (
            <>
              <Plus className="h-3 w-3" /> Create template
            </>
          )}
        </Button>

        <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Generate for a company
          </h3>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="h-8 w-60 text-xs">
                <SelectValue placeholder="Pick a company" />
              </SelectTrigger>
              <SelectContent>
                {view.companies.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-muted-foreground">
              Effective from
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              />
            </label>
            <Input
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              placeholder="Version (optional), e.g. v2"
              maxLength={40}
              className="h-8 w-44 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!companyId || !body.trim() || busy !== null}
              onClick={runPreview}
            >
              {busy === "preview" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Preview"}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!companyId || !body.trim() || busy !== null || saving}
              onClick={generate}
            >
              {busy === "generate" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Generate and save"
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Uses the company's billing details, price list (Billing tab), seat limits and Insights
            prices (Settings tab) as they are right now. The generated text is frozen — later price
            changes don't rewrite it; generate a new version instead.
          </p>
          {preview && (
            <div className="space-y-2">
              {preview.unknown.length > 0 && (
                <p className="text-[11px] text-destructive">
                  Unknown blanks (check the spelling):{" "}
                  {preview.unknown.map((u) => `{{${u}}}`).join(", ")}
                </p>
              )}
              <div className="max-h-[480px] overflow-auto rounded-md border border-border">
                <ContractBody text={preview.text} />
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
