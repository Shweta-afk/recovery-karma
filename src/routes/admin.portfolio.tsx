import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FolderOpen, Send, Users, CheckCircle2, Loader2 } from "lucide-react";
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
import { useRoster, getTeamByManager } from "@/lib/team-store";
import { saveNotification } from "@/lib/notification-store";
import { useAuth } from "@/lib/auth";
import { useStorageSync } from "@/lib/storage-sync";

export const Route = createFileRoute("/admin/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio Assignment · RecoveryAI" },
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

  const [portfolios, setPortfolios] = useState<UploadedPortfolio[]>(() => getPortfolios());
  const [pending, setPending] = useState<Record<string, string>>({}); // portfolioId -> selected managerId (uncommitted)

  const reload = () => setPortfolios(getPortfolios());
  useEffect(() => {
    reload();
    window.addEventListener("portfolios-updated", reload);
    refreshPortfolios();
    return () => window.removeEventListener("portfolios-updated", reload);
  }, []);
  useStorageSync(reload);

  const [assigning, setAssigning] = useState<string | null>(null);

  const assignAndNotify = async (portfolio: UploadedPortfolio) => {
    const managerId = pending[portfolio.id];
    if (!managerId) {
      toast.error("Select a manager first");
      return;
    }
    const manager = MANAGERS.find((m) => m.id === managerId);
    if (!manager) return;

    const team = getTeamByManager(managerId);
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
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="font-medium text-sm text-foreground">{p.name}</div>
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
                          <div className="flex items-center gap-2">
                            <Select
                              value={pending[p.id] ?? p.managerId ?? ""}
                              onValueChange={(v) => setPending((prev) => ({ ...prev, [p.id]: v }))}
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
                            <Button
                              size="sm"
                              className="h-8 gap-1 text-xs flex-shrink-0"
                              disabled={
                                !pending[p.id] ||
                                pending[p.id] === p.managerId ||
                                assigning === p.id
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
    </div>
  );
}
