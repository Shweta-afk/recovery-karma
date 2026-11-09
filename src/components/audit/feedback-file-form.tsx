// Pick a portfolio and a period, get the banker's feedback file. Used by managers and auditors.
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangeFilter } from "@/components/date-range-filter";
import type { DateRange } from "@/lib/date-filter";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { downloadXlsx } from "@/lib/xlsx-export";
import { istDayKeyDaysAgo } from "@/lib/call-audit";
import { buildFeedbackSheets } from "@/lib/portfolio-feedback";
import { getPortfolioFeedbackData, listFeedbackPortfolios } from "@/lib/portfolio-feedback.server";

type PortfolioOption = Awaited<ReturnType<typeof listFeedbackPortfolios>>[number];

const PRESETS = [
  { label: "Today", days: 0 },
  { label: "Last 5 days", days: 4 },
  { label: "Last 7 days", days: 6 },
  { label: "Last 30 days", days: 29 },
];

const safeName = (s: string) => s.replace(/[^\w-]+/g, "_").slice(0, 60);

export function FeedbackFileForm() {
  const [portfolios, setPortfolios] = useState<PortfolioOption[] | null>(null);
  const [portfolioId, setPortfolioId] = useState("");
  const [range, setRange] = useState<DateRange>({
    from: istDayKeyDaysAgo(4),
    to: istDayKeyDaysAgo(0),
  });
  const [includeNoActivity, setIncludeNoActivity] = useState(true);
  const [includeLinks, setIncludeLinks] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAccessToken()
      .then((accessToken) => listFeedbackPortfolios({ data: { accessToken } }))
      .then(setPortfolios)
      .catch((e) => {
        setPortfolios([]);
        toast.error(errorText(e, "Could not load portfolios"));
      });
  }, []);

  const today = istDayKeyDaysAgo(0);
  const from = range.from || range.to || today;
  const to = range.to || today;

  const download = async () => {
    if (!portfolioId) return;
    setBusy(true);
    try {
      const data = await getPortfolioFeedbackData({
        data: {
          accessToken: await getAccessToken(),
          portfolioId,
          from: from <= to ? from : to,
          to: from <= to ? to : from,
          includeRecordingLinks: includeLinks,
        },
      });
      const sheets = buildFeedbackSheets(
        {
          portfolioName: data.portfolioName,
          lenderName: data.lenderName,
          debtors: data.debtors,
          calls: data.calls,
          payments: data.payments,
          settlements: data.settlements,
          disputes: data.disputes,
          agentNames: new Map(data.agentNames.map((a) => [a.id, a.name])),
          from: from <= to ? from : to,
          to: from <= to ? to : from,
          recordingLinks: new Map(Object.entries(data.recordingLinks)),
          includeNoActivity,
        },
        today,
      );
      await downloadXlsx(`feedback-${safeName(data.portfolioName)}-${from}_to_${to}.xlsx`, sheets);
      toast.success(`Feedback file ready: ${sheets[0].rows.length} loans`);
    } catch (e) {
      toast.error(errorText(e, "Could not build the feedback file"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Portfolio</label>
        <Select value={portfolioId} onValueChange={setPortfolioId}>
          <SelectTrigger className="h-9 max-w-md text-sm">
            <SelectValue placeholder={portfolios ? "Choose a portfolio" : "Loading…"} />
          </SelectTrigger>
          <SelectContent>
            {(portfolios ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
                {p.closed_at ? " (closed)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {portfolios?.length === 0 && (
          <p className="text-xs text-muted-foreground">You have no portfolios yet.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Period</label>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => setRange({ from: istDayKeyDaysAgo(p.days), to: today })}
            >
              {p.label}
            </Button>
          ))}
          <DateRangeFilter value={range} onChange={setRange} />
        </div>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Checkbox
            checked={includeNoActivity}
            onCheckedChange={(on) => setIncludeNoActivity(!!on)}
          />
          Include loans with no calls in this period
        </label>
        <label className="flex items-start gap-2 text-xs text-foreground">
          <Checkbox
            checked={includeLinks}
            onCheckedChange={(on) => setIncludeLinks(!!on)}
            className="mt-0.5"
          />
          <span>
            Include call recording links
            <span className="block text-muted-foreground">
              Anyone holding the file can play these calls for 7 days, without signing in.
            </span>
          </span>
        </label>
      </div>

      <Button disabled={!portfolioId || busy} onClick={download} className="gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {busy ? "Building file…" : "Download feedback file"}
      </Button>
    </Card>
  );
}
