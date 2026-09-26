// Superadmin: companies' requests for a portfolio's "Lookup data by Loan ID" Excel. Approve opens
// that portfolio's download for 7 days; decline sends the requester the reason. Both notify the
// requester and land in the superadmin activity log (decideLookupExportRequest).
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, FileSpreadsheet, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccessToken } from "@/lib/access-token";
import {
  decideLookupExportRequest,
  listLookupExportRequests,
  type LookupExportRequestRow,
} from "@/lib/superadmin-actions.server";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

const STATUS_CLS: Record<LookupExportRequestRow["status"], string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  approved: "border-success/30 bg-success/10 text-success",
  rejected: "border-destructive/30 bg-destructive/10 text-destructive",
};

export function ExportRequestsCard() {
  const [showAll, setShowAll] = useState(false);
  const [rows, setRows] = useState<LookupExportRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listLookupExportRequests({
        data: { accessToken: await getAccessToken(), status: showAll ? "all" : "pending" },
      });
      setRows(res.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load requests");
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (r: LookupExportRequestRow, approve: boolean) => {
    setBusy(r.id);
    try {
      await decideLookupExportRequest({
        data: {
          accessToken: await getAccessToken(),
          requestId: r.id,
          approve,
          note: notes[r.id]?.trim() || undefined,
        },
      });
      toast.success(
        approve
          ? `Approved — ${r.companyName} can download ${r.portfolioName} for 7 days`
          : `Declined ${r.companyName}'s request`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setBusy(null);
    }
  };

  const pending = rows.filter((r) => r.status === "pending").length;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 border-b border-border pb-3 gap-3">
        <div>
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            Excel requests
            {pending > 0 && <Badge variant="destructive">{pending} waiting</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Companies asking for a portfolio's "Lookup data by Loan ID" Excel — every field of every
            lookup (PAN, DOB, addresses…). Approving opens that portfolio's download for 7 days.
            Companies with direct download (set on the company page) don't need to ask.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5 shrink-0">
          {[
            { v: false, l: "Waiting" },
            { v: true, l: "All" },
          ].map((o) => (
            <button
              key={o.l}
              type="button"
              onClick={() => setShowAll(o.v)}
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                showAll === o.v
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.l}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {showAll ? "No requests yet." : "Nothing waiting for approval."}
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-border p-3 flex flex-wrap items-start gap-3"
              >
                <div className="flex-1 min-w-[220px] space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{r.companyName}</span>
                    <Badge variant="outline" className={cn("text-[10px]", STATUS_CLS[r.status])}>
                      {r.status === "pending"
                        ? "Waiting"
                        : r.status === "approved"
                          ? "Approved"
                          : "Declined"}
                    </Badge>
                  </div>
                  <div className="text-xs text-foreground">
                    {r.portfolioName}
                    {r.lenderName && (
                      <span className="text-muted-foreground"> · {r.lenderName}</span>
                    )}
                    <span className="text-muted-foreground"> · {r.lookups} lookups</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Asked by {r.requestedByName}
                    {r.requestedByRole && ` (${r.requestedByRole})`}
                    {r.requestedByEmail && ` · ${r.requestedByEmail}`} · {when(r.createdAt)}
                  </div>
                  {r.note && <div className="text-[11px] text-foreground">"{r.note}"</div>}
                  {r.status !== "pending" && (
                    <div className="text-[11px] text-muted-foreground">
                      {r.status === "approved" ? "Approved" : "Declined"}
                      {r.decidedByName && ` by ${r.decidedByName}`} {when(r.decidedAt)}
                      {r.decisionNote && ` — "${r.decisionNote}"`}
                      {r.status === "approved" &&
                        ` · until ${when(r.expiresAt)} · downloaded ${r.downloadCount}×`}
                    </div>
                  )}
                </div>
                {r.status === "pending" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Input
                      value={notes[r.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                      maxLength={500}
                      placeholder="Note to requester (optional)"
                      className="h-7 text-xs w-52"
                    />
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => decide(r, true)}
                      className="inline-flex items-center gap-1 h-7 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {busy === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => decide(r, false)}
                      className="inline-flex items-center gap-1 h-7 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      Decline
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
