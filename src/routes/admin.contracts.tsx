import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileSignature, History, Loader2, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { getAccessToken } from "@/lib/access-token";
import {
  acceptContractChange,
  getMyContracts,
  type AdminContractChange,
  type AdminContractsView,
} from "@/lib/contracts.server";
import {
  ContractDocumentList,
  DownloadContractButton,
  fmtContractDate,
} from "@/components/contracts/contract-documents";

export const Route = createFileRoute("/admin/contracts")({
  head: () => ({ meta: [{ title: "Contracts · SamvadX" }] }),
  component: AdminContractsPage,
});

/** Tells the admin-wide banner (admin.tsx) to recount after an acceptance. */
export const CONTRACTS_UPDATED_EVENT = "contracts-updated";

function AdminContractsPage() {
  const [view, setView] = useState<AdminContractsView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      setView(await getMyContracts({ data: { accessToken } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load your contracts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pending = view?.changes.filter((c) => c.pending) ?? [];
  const history = view?.changes.filter((c) => !c.pending) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Contracts</h1>
        <p className="text-sm text-muted-foreground">
          Your agreement with SamvadX, SamvadX's terms, and every change to them — for example when
          a feature is added or its price changes. Changes marked "needs acceptance" must be
          accepted by one of your company's admins.
        </p>
      </div>

      {loading && !view ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : view ? (
        <>
          {pending.length > 0 && (
            <Card className="border-amber-400/50">
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileSignature className="h-4 w-4 text-amber-500" />
                  Waiting for your acceptance ({pending.length})
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Read each change, then accept it on behalf of {view.companyName}. Only one admin
                  needs to accept; your name and the time are recorded.
                </p>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                {pending.map((c) => (
                  <PendingChange
                    key={c.id}
                    change={c}
                    companyName={view.companyName}
                    onAccepted={async () => {
                      await load();
                      window.dispatchEvent(new CustomEvent(CONTRACTS_UPDATED_EVENT));
                    }}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {pending.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              You're up to date — no contract changes are waiting for acceptance.
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileSignature className="h-4 w-4 text-primary" />
                  {view.companyName}'s agreement
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The agreement your company signed with SamvadX, and any later versions.
                </p>
              </CardHeader>
              <CardContent className="pt-4">
                <ContractDocumentList
                  documents={view.companyDocuments}
                  empty="No signed agreement has been uploaded for your company yet."
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <ScrollText className="h-4 w-4 text-primary" />
                  SamvadX terms
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The terms that apply to every company using SamvadX.
                </p>
              </CardHeader>
              <CardContent className="pt-4">
                <ContractDocumentList
                  documents={view.platformDocuments}
                  empty="No platform terms have been published yet."
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <History className="h-4 w-4 text-primary" />
                All changes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              {history.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No earlier changes.
                </p>
              ) : (
                history.map((c) => <ChangeHistoryRow key={c.id} change={c} />)
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function ChangeBody({ change }: { change: AdminContractChange }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{change.title}</span>
        <Badge variant="outline" className="text-[10px]">
          Effective {fmtContractDate(change.effectiveDate)}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
        {change.body}
      </p>
      {change.documentId && (
        <DownloadContractButton documentId={change.documentId} label="Download the document" />
      )}
    </>
  );
}

function PendingChange({
  change,
  companyName,
  onAccepted,
}: {
  change: AdminContractChange;
  companyName: string;
  onAccepted: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [fullName, setFullName] = useState(user?.name ?? "");
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const canAccept = agreed && fullName.trim().length >= 2 && !saving;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <ChangeBody change={change} />
      <div className="space-y-2 border-t border-border pt-3">
        <label className="flex items-start gap-2 text-xs text-foreground">
          <Checkbox
            checked={agreed}
            onCheckedChange={(v) => setAgreed(v === true)}
            className="mt-0.5"
          />
          <span>
            I have read this change and accept it on behalf of{" "}
            <span className="font-medium">{companyName}</span>.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Your full name"
            aria-label="Your full name"
            className="h-8 w-56 text-xs"
          />
          <Button
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={!canAccept}
            onClick={async () => {
              setSaving(true);
              try {
                const accessToken = await getAccessToken();
                await acceptContractChange({
                  data: {
                    accessToken,
                    changeId: change.id,
                    fullName: fullName.trim(),
                    confirm: true,
                  },
                });
                toast.success("Accepted — thank you");
                await onAccepted();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not record your acceptance");
                // Someone else may have accepted first — refresh either way.
                await onAccepted();
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3 w-3" />
            )}
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChangeHistoryRow({ change }: { change: AdminContractChange }) {
  const status = change.withdrawnAt ? (
    <Badge variant="secondary" className="text-[10px]">
      Withdrawn
    </Badge>
  ) : change.acceptance ? (
    <Badge className="text-[10px]">
      Accepted by {change.acceptance.acceptedName} on{" "}
      {new Date(change.acceptance.acceptedAt).toLocaleDateString("en-IN")}
    </Badge>
  ) : (
    <Badge variant="outline" className="text-[10px]">
      For your information
    </Badge>
  );
  return (
    <div
      className={`space-y-1.5 rounded-lg border border-border p-3 ${change.withdrawnAt ? "opacity-60" : ""}`}
    >
      <ChangeBody change={change} />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {status}
        <span>Published {new Date(change.createdAt).toLocaleDateString("en-IN")}</span>
      </div>
    </div>
  );
}
