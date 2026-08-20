import { useEffect, useState } from "react";
import { Users, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { getPortfolios, refreshPortfolios, type UploadedPortfolio } from "@/lib/portfolio-store";
import type { Team } from "@/lib/team-store";

// Shown by ManagerLayout (manager.tsx) whenever a manager owns 2+ teams and hasn't picked one
// yet for this session (or cleared their pick via "Change Team") — blocks every manager route
// until a team is chosen, since Dashboard/Call Queue/Portfolio Overview/Call Audit/Portfolio
// Upload/Team Activity all scope to exactly one team now (see active-team-store.ts).

export function TeamPickerScreen({
  teams,
  onPick,
  managerName,
}: {
  teams: Team[];
  onPick: (teamId: string) => void;
  managerName: string;
}) {
  const [portfolios, setPortfolios] = useState<UploadedPortfolio[]>(() => getPortfolios());
  useEffect(() => {
    refreshPortfolios().then(() => setPortfolios(getPortfolios()));
  }, []);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-foreground">Choose a team, {managerName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You manage {teams.length} teams — pick which one to work in. Switch anytime from "Change
          Team" in the header.
        </p>
      </div>
      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
        {teams.map((t) => {
          const openPortfolios = portfolios.filter((p) => p.teamId === t.id && !p.closedAt);
          const totalAccounts = openPortfolios.reduce((s, p) => s + p.rows.length, 0);
          return (
            <button key={t.id} type="button" onClick={() => onPick(t.id)} className="text-left">
              <Card className="h-full transition-all hover:border-primary/50 hover:shadow-sm">
                <CardContent className="flex flex-col gap-3 pt-5 pb-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold text-foreground">{t.name}</h2>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {t.agentIds.length} agent{t.agentIds.length === 1 ? "" : "s"}
                    </span>
                    <span>
                      {openPortfolios.length} portfolio{openPortfolios.length === 1 ? "" : "s"} ·{" "}
                      {totalAccounts.toLocaleString("en-IN")} accounts
                    </span>
                  </div>
                </CardContent>
              </Card>
            </button>
          );
        })}
      </div>
    </div>
  );
}
