// Terms & agreements for a company admin — Admin → Billing → "Terms & agreements". Their current
// agreement and SamvadX's terms with a Sign step (tick + type your name; recorded with the time,
// and shown to the superadmin), contract changes waiting for acceptance, and every earlier
// version. Opening a document records that the company has viewed it (contracts.server.ts).
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileSignature, History, Loader2, PenLine, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import { currentDocument, type ContractDocument, type DocumentStatus } from "@/lib/contracts";
import {
  acceptContractChange,
  getMyContracts,
  signContractDocument,
  type AdminContractChange,
  type AdminContractsView,
} from "@/lib/contracts.server";
import {
  ContractDocumentList,
  DownloadContractButton,
  fmtContractDate,
} from "@/components/contracts/contract-documents";
import { ViewContractButton } from "@/components/contracts/contract-body";
import { errorText } from "@/lib/app-error";

/** Tells the admin-wide banner (admin.tsx) to recount after an acceptance. */
export const CONTRACTS_UPDATED_EVENT = "contracts-updated";

export function AdminAgreements({ focusDocId }: { focusDocId?: string }) {
  const [view, setView] = useState<AdminContractsView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      setView(await getMyContracts({ data: { accessToken } }));
    } catch (e) {
      toast.error(errorText(e, "Could not load your contracts"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reload = async () => {
    await load();
    window.dispatchEvent(new CustomEvent(CONTRACTS_UPDATED_EVENT));
  };
  const today = todayIstKey();
  // The master agreement = the latest platform document with text (published on Superadmin →
  // Contracts → Agreement); uploaded platform files are listed under "All versions" below.
  const master = view
    ? currentDocument(
        view.platformDocuments.filter((d) => d.generated),
        today,
      )
    : null;
  const companyDoc = view ? currentDocument(view.companyDocuments, today) : null;
  const statusFor = (docId: string | undefined) =>
    view?.statuses.find((s) => s.documentId === docId) ?? null;

  const pending = view?.changes.filter((c) => c.pending) ?? [];
  const history = view?.changes.filter((c) => !c.pending) ?? [];

  return (
    <div className="space-y-6">
      {loading && !view ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : view ? (
        <>
          {/* The master agreement (one text for every company, filled with this company's details)
              comes first; a company-specific document only shows if SamvadX shared one. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <SignableDocument
              heading={`${view.companyName}'s agreement with SamvadX`}
              empty="SamvadX hasn't published the agreement yet."
              doc={master}
              status={statusFor(master?.id)}
              companyName={view.companyName}
              highlight={!!focusDocId}
              onSigned={reload}
            />
            {companyDoc && (
              <SignableDocument
                heading="Additional document for your company"
                empty=""
                doc={companyDoc}
                status={statusFor(companyDoc.id)}
                companyName={view.companyName}
                onSigned={reload}
              />
            )}
          </div>

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
                  All versions of your agreement
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Every version SamvadX has shared with your company.
                </p>
              </CardHeader>
              <CardContent className="pt-4">
                <ContractDocumentList
                  documents={view.companyDocuments}
                  empty="Nothing shared yet."
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <ScrollText className="h-4 w-4 text-primary" />
                  All versions of SamvadX terms
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
                toast.error(errorText(e, "Could not record your acceptance"));
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

/** The document in force, with its signed / not-signed state and the Sign step. */
function SignableDocument({
  heading,
  empty,
  doc,
  status,
  companyName,
  highlight,
  onSigned,
}: {
  heading: string;
  empty: string;
  doc: ContractDocument | null;
  status: DocumentStatus | null;
  companyName: string;
  highlight?: boolean;
  onSigned: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [fullName, setFullName] = useState(user?.name ?? "");
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const signed = !!status?.signedAt;

  return (
    <Card
      className={
        signed
          ? "border-emerald-500/40"
          : doc
            ? `border-amber-400/60 ${highlight ? "ring-2 ring-amber-400/60" : ""}`
            : undefined
      }
    >
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileSignature className="h-4 w-4 text-primary" />
          {heading}
          {doc &&
            (signed ? (
              <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">Signed</Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500 text-[10px] text-amber-600">
                Needs your signature
              </Badge>
            ))}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {!doc ? (
          <p className="py-2 text-xs text-muted-foreground">{empty}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs">
                <div className="font-medium text-foreground">
                  {doc.title}
                  {doc.versionLabel && (
                    <span className="font-normal text-muted-foreground"> · {doc.versionLabel}</span>
                  )}
                </div>
                <div className="text-muted-foreground">
                  Effective {fmtContractDate(doc.effectiveDate)}
                </div>
              </div>
              {doc.generated ? (
                <ViewContractButton documentId={doc.id} title={doc.title} />
              ) : (
                <DownloadContractButton documentId={doc.id} label="Open" />
              )}
            </div>
            {signed ? (
              <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Signed by {status?.signedName} on{" "}
                {new Date(status!.signedAt!).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
              </p>
            ) : (
              <div className="space-y-2 border-t border-border pt-3">
                <label className="flex items-start gap-2 text-xs text-foreground">
                  <Checkbox
                    checked={agreed}
                    onCheckedChange={(v) => setAgreed(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I have read this document and agree to it on behalf of{" "}
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
                    disabled={!agreed || fullName.trim().length < 2 || saving}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        await signContractDocument({
                          data: {
                            accessToken: await getAccessToken(),
                            documentId: doc.id,
                            fullName: fullName.trim(),
                            confirm: true,
                          },
                        });
                        toast.success("Signed — thank you");
                      } catch (e) {
                        toast.error(errorText(e, "Could not record your signature"));
                      } finally {
                        setSaving(false);
                        await onSigned();
                      }
                    }}
                  >
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <PenLine className="h-3 w-3" />
                    )}
                    Sign
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Your name, email and the time are recorded as your company's signature.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
