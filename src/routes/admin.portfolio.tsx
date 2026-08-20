import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FolderOpen, Send, Users, CheckCircle2, Loader2, Eye } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  getPortfolios,
  updatePortfolioMeta,
  refreshPortfolios,
  type UploadedPortfolio,
} from "@/lib/portfolio-store";
import { useRoster, useTeams, getTeamsByManager } from "@/lib/team-store";
import { saveNotification } from "@/lib/notification-store";
import { useAuth } from "@/lib/auth";
import { useStorageSync } from "@/lib/storage-sync";
// Same full-screen portfolio dashboard the manager portal uses — Portfolio Assignment is
// read-only here (no per-agent edit/reassign in admin's remit), so onEdit/onReassign/
// onUploadPaid are simply omitted, which PortfolioDetail renders as a view-only dashboard.
import { PortfolioDetail, toPortfolio } from "@/components/portfolio/portfolio-dashboard";

export const Route = createFileRoute("/admin/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio Assignment · SamvadX" },
      { name: "description", content: "Assign uploaded portfolios to a manager and notify them." },
    ],
  }),
  component: PortfolioAssignmentPage,
});

function formatINR(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

function PortfolioAssignmentPage() {
  const { user } = useAuth();
  const adminName = user?.name ?? "Admin";
  const roster = useRoster();
  const MANAGERS = roster.filter((a) => a.role === "manager");
  useTeams(); // keeps getTeamsByManager's cache fresh for the picker below

  const [portfolios, setPortfolios] = useState<UploadedPortfolio[]>(() => getPortfolios());
  const [pending, setPending] = useState<Record<string, string>>({}); // portfolioId -> selected managerId (uncommitted)
  // portfolioId -> selected teamId (uncommitted) — only needed when the chosen manager owns
  // more than one team, since getTeamsByManager can no longer be collapsed to a single pick.
  const [pendingTeam, setPendingTeam] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<UploadedPortfolio | null>(null);

  const reload = () => setPortfolios(getPortfolios());
  useEffect(() => {
    reload();
    window.addEventListener("portfolios-updated", reload);
    refreshPortfolios();
    return () => window.removeEventListener("portfolios-updated", reload);
  }, []);
  useStorageSync(reload);

  // Keep the open dashboard in sync with the latest data after an assignment
  useEffect(() => {
    setViewing((prev) => (prev ? (portfolios.find((p) => p.id === prev.id) ?? prev) : prev));
  }, [portfolios]);

  const [assigning, setAssigning] = useState<string | null>(null);

  const assignAndNotify = async (portfolio: UploadedPortfolio) => {
    const managerId = pending[portfolio.id];
    if (!managerId) {
      toast.error("Select a manager first");
      return;
    }
    const manager = MANAGERS.find((m) => m.id === managerId);
    if (!manager) return;

    const candidateTeams = getTeamsByManager(managerId);
    if (candidateTeams.length > 1 && !pendingTeam[portfolio.id]) {
      toast.error(
        `${manager.name} manages multiple teams — pick which one this portfolio belongs to`,
      );
      return;
    }
    const team =
      candidateTeams.length > 1
        ? candidateTeams.find((t) => t.id === pendingTeam[portfolio.id])
        : candidateTeams[0];

    setAssigning(portfolio.id);
    try {
      await updatePortfolioMeta(portfolio.id, { managerId, teamId: team?.id });
      await saveNotification({
        toAgentId: managerId,
        fromName: adminName,
        message: `You've been assigned portfolio "${portfolio.name}" (${portfolio.rows.length} accounts).`,
      });
      toast.success(`Assigned "${portfolio.name}" to ${manager.name} and sent a notification.`);
      setPending((p) => {
        const next = { ...p };
        delete next[portfolio.id];
        return next;
      });
      setPendingTeam((p) => {
        const next = { ...p };
        delete next[portfolio.id];
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to assign portfolio");
    } finally {
      setAssigning(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Portfolio Assignment
        </h1>
        <p className="text-sm text-muted-foreground">
          Assign uploaded portfolios to a manager and notify them. Portfolios are uploaded by
          managers via Portfolio Upload.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-primary" />
            All Portfolios
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {portfolios.length} total
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {portfolios.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No portfolios uploaded yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Portfolio</TableHead>
                    <TableHead>Lender</TableHead>
                    <TableHead className="text-right">Accounts</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead>Current Owner</TableHead>
                    <TableHead className="min-w-[260px]">Assign to Manager</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {portfolios.map((p) => {
                    const owner = MANAGERS.find((m) => m.id === p.managerId);
                    const dateStr = new Date(p.uploadedAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    });
                    const rowManagerId = pending[p.id] ?? p.managerId ?? "";
                    const rowTeams = rowManagerId ? getTeamsByManager(rowManagerId) : [];
                    const needsTeamPick = rowTeams.length > 1 && !pendingTeam[p.id];
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => setViewing(p)}
                            className="group flex items-center gap-1.5 text-left"
                          >
                            <div className="font-medium text-sm text-foreground group-hover:underline">
                              {p.name}
                            </div>
                            <Eye className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                          <div className="text-[11px] text-muted-foreground">{p.product}</div>
                        </TableCell>
                        <TableCell className="text-sm">{p.lender}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">
                          {p.rows.length}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{dateStr}</TableCell>
                        <TableCell>
                          {owner ? (
                            <Badge
                              variant="outline"
                              className="gap-1 text-[10px] bg-success/8 text-success/80 border-success/20"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              {owner.name}
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-muted text-muted-foreground border-border"
                            >
                              Unassigned
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Select
                              value={pending[p.id] ?? p.managerId ?? ""}
                              onValueChange={(v) => {
                                setPending((prev) => ({ ...prev, [p.id]: v }));
                                setPendingTeam((prev) => {
                                  const next = { ...prev };
                                  delete next[p.id];
                                  return next;
                                });
                              }}
                            >
                              <SelectTrigger className="h-8 w-44 text-xs">
                                <SelectValue placeholder="Select manager…" />
                              </SelectTrigger>
                              <SelectContent>
                                {MANAGERS.map((m) => (
                                  <SelectItem key={m.id} value={m.id}>
                                    <span className="flex items-center gap-1.5">
                                      <Users className="h-3 w-3" />
                                      {m.name}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {rowTeams.length > 1 && (
                              <Select
                                value={pendingTeam[p.id] ?? p.teamId ?? ""}
                                onValueChange={(v) =>
                                  setPendingTeam((prev) => ({ ...prev, [p.id]: v }))
                                }
                              >
                                <SelectTrigger className="h-8 w-40 text-xs">
                                  <SelectValue placeholder="Which team?" />
                                </SelectTrigger>
                                <SelectContent>
                                  {rowTeams.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                      {t.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            <Button
                              size="sm"
                              className="h-8 gap-1 text-xs flex-shrink-0"
                              disabled={
                                !pending[p.id] ||
                                needsTeamPick ||
                                (pending[p.id] === p.managerId && !needsTeamPick) ||
                                assigning === p.id
                              }
                              title={
                                needsTeamPick
                                  ? "Pick which team this portfolio belongs to"
                                  : undefined
                              }
                              onClick={() => assignAndNotify(p)}
                            >
                              {assigning === p.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Send className="h-3 w-3" />
                              )}
                              Assign &amp; Notify
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {viewing && (
        <PortfolioDetail
          p={toPortfolio(viewing)}
          raw={viewing}
          agents={[]}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
