import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangeFilter } from "@/components/date-range-filter";
import { FeedbackFileForm } from "@/components/audit/feedback-file-form";
import type { DateRange } from "@/lib/date-filter";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { downloadXlsx, reportFilename, type XlsxSheet } from "@/lib/xlsx-export";
import { istDayKeyDaysAgo, type AuditCallRow, type TeamReviewRow } from "@/lib/call-audit";
import {
  agentScorecardSheet,
  aiVsAuditorSheet,
  auditFeedbackSheet,
  auditorProductivitySheet,
  callLogSheet,
  fatalLogSheet,
  performanceSheet,
  portfolioScorecardSheet,
  teamReviewsSheet,
  teamScorecardSheet,
  type PresenceRow,
} from "@/lib/call-audit-reports";
import {
  getAuditExportPage,
  getAuditOrg,
  getAuditPresence,
  listTeamReviews,
} from "@/lib/call-audit.server";

export const Route = createFileRoute("/auditor/reports")({
  head: () => ({ meta: [{ title: "Audit Reports · SamvadX" }] }),
  component: AuditorReports,
});

interface Loaded {
  calls: AuditCallRow[];
  presence: PresenceRow[];
  reviews: TeamReviewRow[];
  origin: string;
}

const PAGE = 1000;

const REPORTS: { id: string; title: string; about: string; build: (d: Loaded) => XlsxSheet }[] = [
  {
    id: "audit-feedback",
    title: "Audit + Feedback",
    about:
      "Every review with the call, each scorecard answer, the agent's feedback, the AI's view and replies.",
    build: (d) => auditFeedbackSheet(d.calls, d.origin),
  },
  {
    id: "call-log",
    title: "Call Log",
    about:
      "One row per call, in your export's column order, then everything else we hold including every bank-file column.",
    build: (d) => callLogSheet(d.calls, d.origin),
  },
  {
    id: "performance",
    title: "Performance",
    about:
      "One row per agent per day: calls, login, idle, wrap-up, breaks, utilisation, PTP, collected, audit score.",
    build: (d) => performanceSheet(d.calls, d.presence),
  },
  {
    id: "agent-scorecard",
    title: "Agent Scorecard",
    about: "Each agent's scores, grades and result on every scorecard parameter.",
    build: (d) => agentScorecardSheet(d.calls),
  },
  {
    id: "team-scorecard",
    title: "Team & Manager Scorecard",
    about: "The same, team by team.",
    build: (d) => teamScorecardSheet(d.calls),
  },
  {
    id: "portfolio-scorecard",
    title: "Portfolio Scorecard",
    about: "The same, portfolio by portfolio.",
    build: (d) => portfolioScorecardSheet(d.calls),
  },
  {
    id: "team-reviews",
    title: "Team Reviews",
    about: "Reviews written for each team and manager, with their replies.",
    build: (d) => teamReviewsSheet(d.reviews),
  },
  {
    id: "fatal",
    title: "Fatal Errors",
    about: "Every call failed for a fatal error.",
    build: (d) => fatalLogSheet(d.calls, d.origin),
  },
  {
    id: "ai-vs-auditor",
    title: "AI vs Auditor",
    about: "Where the AI agreed or disagreed with the auditor, and what is still waiting.",
    build: (d) => aiVsAuditorSheet(d.calls, d.origin),
  },
  {
    id: "auditor-productivity",
    title: "Auditor Productivity",
    about: "How many calls each auditor reviewed, per day.",
    build: (d) => auditorProductivitySheet(d.calls),
  },
];

function AuditorReports() {
  const [range, setRange] = useState<DateRange>({
    from: istDayKeyDaysAgo(29),
    to: istDayKeyDaysAgo(0),
  });
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [team, setTeam] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    getAccessToken()
      .then((accessToken) => getAuditOrg({ data: { accessToken } }))
      .then((o) => setTeams(o.teams))
      .catch(() => {});
  }, []);

  const from = range.from || istDayKeyDaysAgo(29);
  const to = range.to || istDayKeyDaysAgo(0);

  const load = async (): Promise<Loaded> => {
    const accessToken = await getAccessToken();
    const filters = { from, to, teamId: team === "all" ? undefined : team };
    const calls: AuditCallRow[] = [];
    let total = 0;
    for (let offset = 0; ; offset += PAGE) {
      const res = await getAuditExportPage({ data: { accessToken, filters, limit: PAGE, offset } });
      if (res.total !== null) total = res.total;
      calls.push(...res.rows);
      setProgress(
        `${calls.length.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} calls`,
      );
      if (res.rows.length < PAGE) break;
    }
    const presence: PresenceRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await getAuditPresence({ data: { accessToken, from, to, limit: PAGE, offset } });
      presence.push(...rows);
      if (rows.length < PAGE) break;
    }
    const allReviews = await listTeamReviews({ data: { accessToken, from, to } });
    return {
      calls,
      presence,
      reviews: team === "all" ? allReviews : allReviews.filter((r) => r.team_id === team),
      origin: window.location.origin,
    };
  };

  const run = async (id: string) => {
    setBusy(id);
    setProgress("");
    try {
      const data = await load();
      const picked = id === "everything" ? REPORTS : REPORTS.filter((r) => r.id === id);
      await downloadXlsx(
        reportFilename(id === "everything" ? "audit-all-reports" : id, { from, to }),
        picked.map((r) => r.build(data)),
      );
      toast.success("Report downloaded");
    } catch (e) {
      toast.error(errorText(e, "Could not build this report"));
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Everything downloads as Excel, in full detail.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <DateRangeFilter value={range} onChange={setRange} />
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="h-9 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="gap-2" disabled={!!busy} onClick={() => run("everything")}>
          {busy === "everything" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Download all reports
        </Button>
        {progress && <span className="text-xs text-muted-foreground">{progress}</span>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {REPORTS.map((r) => (
          <Card key={r.id} className="flex items-start justify-between gap-3 p-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{r.title}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{r.about}</p>
            </div>
            <Button
              aria-label={`Download ${r.title}`}
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              disabled={!!busy}
              onClick={() => run(r.id)}
            >
              {busy === r.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
          </Card>
        ))}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Allocation report by portfolio</h2>
        <FeedbackFileForm />
      </section>
    </div>
  );
}
