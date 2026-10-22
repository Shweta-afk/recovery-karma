// Superadmin → Contracts → Data purging. Companies request a data purging certificate per
// portfolio (purge-request-button.tsx); here a superadmin checks the filled-in letter, edits the
// date / month / addressee / lender if needed, and issues it — or declines with a reason. Server:
// src/lib/data-purge.server.ts. Issuing deletes no data (user's decision, 2026-10-20).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileCheck2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getAccessToken } from "@/lib/access-token";
import { todayIstKey } from "@/lib/date-filter";
import {
  declinePurgeRequest,
  issuePurgeCertificate,
  listPurgeRequests,
  previewPurgeCertificate,
  type PurgeRequestRow,
} from "@/lib/data-purge.server";
import type { PurgeCertificate, PurgeLetterFields } from "@/lib/data-purge";
import { PrintButton } from "@/components/billing/invoice-document";
import { PurgeCertificateDocument } from "./purge-certificate-document";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const STATUS_BADGE: Record<PurgeRequestRow["status"], string> = {
  pending: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  issued: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  declined: "bg-muted text-muted-foreground border-border",
};

export function PurgeRequestsPanel() {
  const [scope, setScope] = useState<"pending" | "all">("pending");
  const [rows, setRows] = useState<PurgeRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<PurgeRequestRow | null>(null);
  const [viewing, setViewing] = useState<PurgeRequestRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listPurgeRequests({
        data: { accessToken: await getAccessToken(), status: scope },
      });
      setRows(res.rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the requests");
    } finally {
      setLoading(false);
    }
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <FileCheck2 className="h-4 w-4 text-primary" />
              Data purging certificates
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A company asks for one on a portfolio. Check the letter, edit the date, month or
              addressee if needed, and issue it — the requester is notified and opens it from the
              portfolio. Issuing deletes no data.
            </p>
          </div>
          <div className="flex gap-1">
            {(["pending", "all"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={scope === s ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setScope(s)}
              >
                {s === "pending" ? "Waiting" : "All"}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="py-6 text-xs text-amber-600">{error}</p>
        ) : !rows.length ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {scope === "pending" ? "No requests waiting." : "No requests yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border text-xs">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.companyName}</span>
                    <span className="text-muted-foreground">·</span>
                    <span>{r.portfolioName}</span>
                    {r.lenderName && (
                      <span className="text-muted-foreground">({r.lenderName})</span>
                    )}
                    <Badge variant="outline" className={`text-[10px] ${STATUS_BADGE[r.status]}`}>
                      {r.status === "pending"
                        ? "Waiting"
                        : r.status === "issued"
                          ? "Issued"
                          : "Declined"}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Requested {fmtDate(r.createdAt)} by {r.requestedByName}
                    {r.requestedByRole ? ` (${r.requestedByRole})` : ""}
                    {r.decidedAt &&
                      ` · ${r.status === "issued" ? "Issued" : "Declined"} ${fmtDate(r.decidedAt)}${r.decidedByName ? ` by ${r.decidedByName}` : ""}`}
                    {r.status === "issued" &&
                      (r.viewCount > 0
                        ? ` · Opened ${r.viewCount}× (last ${fmtDate(r.lastViewedAt ?? r.decidedAt ?? r.createdAt)})`
                        : " · Not opened yet")}
                  </p>
                  {r.note && <p className="text-[11px]">Note: “{r.note}”</p>}
                  {r.status === "declined" && r.decisionNote && (
                    <p className="text-[11px] text-muted-foreground">Reason: {r.decisionNote}</p>
                  )}
                </div>
                {r.status === "pending" ? (
                  <Button size="sm" className="h-7 text-xs" onClick={() => setPreparing(r)}>
                    Prepare certificate
                  </Button>
                ) : r.status === "issued" && r.certificate ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setViewing(r)}
                  >
                    <Eye className="h-3 w-3" /> View
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {preparing && (
        <PrepareDialog
          request={preparing}
          onClose={() => setPreparing(null)}
          onDone={async () => {
            setPreparing(null);
            await load();
          }}
        />
      )}

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 pr-6 text-sm">
              {viewing?.companyName} — {viewing?.portfolioName}
              {viewing?.certificate && (
                <PrintButton
                  fileTitle={`Data Purging ${viewing.certificate.letter.period} - ${viewing.portfolioName}`}
                >
                  <PurgeCertificateDocument certificate={viewing.certificate} />
                </PrintButton>
              )}
            </DialogTitle>
          </DialogHeader>
          {viewing?.certificate && (
            <div className="rounded border border-border">
              <PurgeCertificateDocument certificate={viewing.certificate} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PrepareDialog({
  request,
  onClose,
  onDone,
}: {
  request: PurgeRequestRow;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [base, setBase] = useState<PurgeCertificate | null>(null);
  const [letter, setLetter] = useState<PurgeLetterFields | null>(null);
  const [toText, setToText] = useState("");
  const [busy, setBusy] = useState<"issue" | "decline" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  // onClose is a new function each render — keep it out of the fetch effect's dependencies.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const c = await previewPurgeCertificate({
          data: { accessToken: await getAccessToken(), requestId: request.id },
        });
        if (!live) return;
        setBase(c);
        setLetter(c.letter);
        setToText(c.letter.toLines.join("\n"));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not prepare the certificate");
        closeRef.current();
      }
    })();
    return () => {
      live = false;
    };
  }, [request.id]);

  // The preview re-renders from the edited fields; the allocation is the server's.
  const edited = useMemo<PurgeLetterFields | null>(
    () =>
      letter && {
        ...letter,
        toLines: toText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      },
    [letter, toText],
  );
  const shown = base && edited ? { ...base, letter: edited } : null;
  const today = todayIstKey();
  const problem = !edited
    ? null
    : !edited.letterDate
      ? "Enter the letter date"
      : edited.letterDate > today
        ? "The letter date can't be in the future"
        : !edited.period.trim()
          ? "Enter the month"
          : !edited.toLines.length
            ? "Enter who it is addressed to"
            : null;

  const issue = async () => {
    if (!edited) return;
    if (!window.confirm(`Issue this certificate to ${request.companyName}?`)) return;
    setBusy("issue");
    try {
      await issuePurgeCertificate({
        data: { accessToken: await getAccessToken(), requestId: request.id, letter: edited },
      });
      toast.success("Certificate issued — the requester has been notified");
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not issue the certificate");
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    setBusy("decline");
    try {
      await declinePurgeRequest({
        data: {
          accessToken: await getAccessToken(),
          requestId: request.id,
          note: reason.trim() || undefined,
        },
      });
      toast.success("Request declined");
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not decline the request");
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<PurgeLetterFields>) => setLetter((l) => (l ? { ...l, ...patch } : l));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Data purging certificate — {request.companyName} · {request.portfolioName}
          </DialogTitle>
        </DialogHeader>
        {!shown || !letter ? (
          <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Filling in the letter…
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[260px_1fr]">
            <div className="space-y-3 text-xs">
              {request.note && (
                <p className="rounded border border-border bg-muted/40 p-2">
                  Their note: “{request.note}”
                </p>
              )}
              <label className="block space-y-1">
                <span className="font-medium">Letter date</span>
                <Input
                  type="date"
                  max={today}
                  value={letter.letterDate}
                  onChange={(e) => set({ letterDate: e.target.value })}
                  className="h-8 text-xs"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Month (subject line)</span>
                <Input
                  value={letter.period}
                  onChange={(e) => set({ period: e.target.value })}
                  placeholder="April-2026"
                  className="h-8 text-xs"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Lender</span>
                <Input
                  value={letter.lenderName}
                  onChange={(e) => set({ lenderName: e.target.value })}
                  className="h-8 text-xs"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">To (one line each)</span>
                <Textarea
                  value={toText}
                  onChange={(e) => setToText(e.target.value)}
                  rows={4}
                  className="text-xs"
                />
              </label>
              <p className="text-[11px] text-muted-foreground">
                The allocation table is counted from the portfolio's accounts (
                {shown.allocation.totalAccounts.toLocaleString("en-IN")}) and frozen when you issue.
              </p>
              {problem && <p className="text-[11px] text-amber-600">{problem}</p>}
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <Button size="sm" onClick={issue} disabled={!!problem || busy !== null}>
                  {busy === "issue" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Issue certificate
                </Button>
                {declining ? (
                  <div className="space-y-2">
                    <Textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason (shown to the requester)"
                      maxLength={500}
                      className="text-xs"
                    />
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={decline}
                      disabled={busy !== null}
                      className="w-full"
                    >
                      {busy === "decline" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Decline request
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setDeclining(true)}>
                    Decline…
                  </Button>
                )}
              </div>
            </div>
            <div className="rounded border border-border">
              <PurgeCertificateDocument certificate={shown} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
