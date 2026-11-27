import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, Loader2, MoveRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { assignLead, updateLead } from "@/lib/sales.server";
import {
  OPEN_STAGES,
  SALES_STAGES,
  pipelineSummary,
  type SalesStage,
} from "@/lib/sales/sales-rules";
import { fmtMoney, personName, useSalesList } from "@/lib/sales/sales-store";

export const Route = createFileRoute("/sales/")({
  head: () => ({ meta: [{ title: "Pipeline · SamvadX Sales" }] }),
  component: SalesPipelinePage,
});

const BOARD_STAGES = OPEN_STAGES;

function SalesPipelinePage() {
  const list = useSalesList();
  const [moving, setMoving] = useState<{
    leadId: string;
    company: string;
    from: SalesStage;
    to: SalesStage;
    reason: string;
  } | null>(null);

  const summary = useMemo(
    () => pipelineSummary(list.leads.map((l) => ({ stage: l.stage, deal_monthly: l.deal_monthly }))),
    [list.leads],
  );

  const byStage = useMemo(() => {
    const m = new Map<string, typeof list.leads>();
    for (const s of BOARD_STAGES) m.set(s, []);
    for (const l of list.leads) {
      if (!m.has(l.stage)) continue;
      m.get(l.stage)!.push(l);
    }
    return m;
  }, [list.leads]);

  async function move(leadId: string, to: SalesStage, reason?: string) {
    try {
      const token = await getAccessToken();
      await updateLead({ data: { accessToken: token, id: leadId, patch: { stage: to, lost_reason: reason ?? null } } });
      toast.success("Moved");
      await list.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function claim(leadId: string) {
    if (!list.me || list.me.kind !== "sales") return;
    try {
      const token = await getAccessToken();
      await assignLead({ data: { accessToken: token, id: leadId, ownerId: list.me.salesUserId } });
      await list.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pipeline</h1>
          <p className="text-xs text-muted-foreground">
            {list.me?.kind === "sales"
              ? "Your leads plus the unassigned pool"
              : "Every lead across the sales team"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/sales/leads">
            <Button size="sm" variant="outline" className="gap-1.5">
              All leads <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
          <Link to="/sales/leads" search={{ new: "1" }}>
            <Button size="sm" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> New lead
            </Button>
          </Link>
        </div>
      </header>

      {list.error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {list.error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KPI label="Open leads" value={String(summary.open.count)} />
        <KPI label="Pipeline value / month" value={fmtMoney(summary.open.value)} />
        <KPI label="Won this list" value={String(summary.byStage.won.count)} />
        <KPI label="Salespeople" value={String(list.people.filter((p) => p.is_active).length)} />
      </div>

      {list.loading ? (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {BOARD_STAGES.map((stage) => {
            const rows = byStage.get(stage) ?? [];
            const meta = SALES_STAGES.find((s) => s.key === stage)!;
            const value = rows.reduce((t, r) => t + (Number(r.deal_monthly) || 0), 0);
            return (
              <div key={stage} className="flex min-w-[280px] flex-1 flex-col rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <div>
                    <div className="text-sm font-semibold">{meta.label}</div>
                    <div className="text-[11px] text-muted-foreground">{meta.hint}</div>
                  </div>
                  <Badge variant="outline" className="text-[11px]">{rows.length}</Badge>
                </div>
                <div className="px-3 py-1 text-[11px] text-muted-foreground">
                  {fmtMoney(value)} / month
                </div>
                <div className="flex-1 space-y-2 p-2">
                  {rows.length === 0 && (
                    <p className="px-2 py-8 text-center text-[11px] text-muted-foreground">
                      Nothing here yet.
                    </p>
                  )}
                  {rows.map((lead) => {
                    const isMine =
                      list.me?.kind === "sales" ? lead.owner_id === list.me.salesUserId : true;
                    const nextIdx = BOARD_STAGES.indexOf(stage) + 1;
                    const nextStage = nextIdx < BOARD_STAGES.length ? BOARD_STAGES[nextIdx] : null;
                    return (
                      <Link
                        key={lead.id}
                        to="/sales/leads/$id"
                        params={{ id: lead.id }}
                        className="block rounded-lg border border-border bg-background p-2 hover:border-foreground/30 hover:bg-accent/30"
                      >
                        <div className="text-sm font-medium leading-tight">{lead.company_name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {lead.contact_name ?? "—"} · {lead.phone ?? "no phone"}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{fmtMoney(lead.deal_monthly)} /mo</span>
                          <span>{personName(list.people, lead.owner_id)}</span>
                        </div>
                        <div className="mt-2 flex gap-1" onClick={(e) => e.preventDefault()}>
                          {!lead.owner_id && list.me?.kind === "sales" && (
                            <button
                              type="button"
                              className="rounded-md border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-accent"
                              onClick={() => claim(lead.id)}
                            >
                              Take
                            </button>
                          )}
                          {nextStage && isMine && (
                            <button
                              type="button"
                              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-accent"
                              onClick={() =>
                                nextStage === "won" || nextStage === "lost"
                                  ? setMoving({
                                      leadId: lead.id,
                                      company: lead.company_name,
                                      from: stage,
                                      to: nextStage,
                                      reason: "",
                                    })
                                  : move(lead.id, nextStage)
                              }
                              title={`Move to ${SALES_STAGES.find((s) => s.key === nextStage)!.label}`}
                            >
                              <MoveRight className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!moving} onOpenChange={(open) => !open && setMoving(null)}>
        <DialogContent>
          {moving && (
            <>
              <DialogHeader>
                <DialogTitle>Move {moving.company}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Moving from {SALES_STAGES.find((s) => s.key === moving.from)!.label} to{" "}
                  <strong>{SALES_STAGES.find((s) => s.key === moving.to)!.label}</strong>.
                </p>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs text-muted-foreground">Move to</span>
                  <Select
                    value={moving.to}
                    onValueChange={(v) => setMoving({ ...moving, to: v as SalesStage })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SALES_STAGES.map((s) => (
                        <SelectItem key={s.key} value={s.key} className="text-xs">
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                {moving.to === "lost" && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs text-muted-foreground">Why was it lost?</span>
                    <textarea
                      value={moving.reason}
                      onChange={(e) => setMoving({ ...moving, reason: e.target.value })}
                      rows={2}
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                      placeholder="Price, timing, competitor…"
                    />
                  </label>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setMoving(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    if (moving.to === "lost" && !moving.reason.trim()) {
                      toast.error("Say why it was lost.");
                      return;
                    }
                    await move(moving.leadId, moving.to, moving.reason.trim() || undefined);
                    setMoving(null);
                  }}
                >
                  Move
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KPI({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="p-3 pb-0">
        <CardTitle className="text-[11px] font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-1 text-xl font-bold">{value}</CardContent>
    </Card>
  );
}
