import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Phone,
  BotMessageSquare,
  Radio,
  MessageSquare,
  MessageCircle,
  FileDown,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useManagerTeamAgents, type AgentRef } from "@/lib/team-store";
import { getAgentDispositions, refreshDispositions, calcStats } from "@/lib/disposition-store";
import { downloadCsv } from "@/lib/csv-export";
import { useStorageSync } from "@/lib/storage-sync";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/manager/channels")({
  head: () => ({
    meta: [
      { title: "Channel Contribution · Axiora" },
      {
        name: "description",
        content: "How Agent calls, AI, IVR, SMS and WhatsApp each contribute to recovery.",
      },
    ],
  }),
  component: ChannelContributionPage,
});

interface ChannelRow {
  key: string;
  label: string;
  icon: typeof Phone;
  real: boolean; // real = computed from actual disposition data; false = illustrative (no backend yet)
  volume: number;
  engaged: number; // connected / delivered / read, depending on channel
  ptpCount: number;
  ptpAmount: number;
  paidCount: number;
  paidAmount: number;
  color: string;
}

function formatINR(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

function computeAgentCallChannel(agents: AgentRef[]): ChannelRow {
  const disps = agents.flatMap((a) => getAgentDispositions(a.id));
  const stats = calcStats(disps);
  return {
    key: "agent_call",
    label: "Agent Call",
    icon: Phone,
    real: true,
    volume: stats.total,
    engaged: disps.filter((d) => !["no_answer", "voicemail"].includes(d.outcome)).length,
    ptpCount: stats.ptps,
    ptpAmount: stats.ptpAmount,
    paidCount: stats.paid,
    paidAmount: stats.paidAmount,
    color: "oklch(0.58 0.18 258)",
  };
}

function useAgentCallChannel(agents: AgentRef[]): ChannelRow {
  const [channel, setChannel] = useState<ChannelRow>(() => computeAgentCallChannel(agents));
  const reload = () => setChannel(computeAgentCallChannel(agents));
  useEffect(() => {
    reload();
    window.addEventListener("dispositions-updated", reload);
    refreshDispositions();
    return () => window.removeEventListener("dispositions-updated", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  useStorageSync(reload);
  return channel;
}

// Illustrative — no telephony/IVR/SMS/WhatsApp integration exists yet (matches AI_STATS /
// Activity History patterns used elsewhere in the app). Swap these for real queries once
// those channels are wired to a backend; the table/chart below need no other changes.
const ILLUSTRATIVE_CHANNELS: ChannelRow[] = [
  {
    key: "ai_call",
    label: "AI Call",
    icon: BotMessageSquare,
    real: false,
    volume: 96,
    engaged: 62,
    ptpCount: 22,
    ptpAmount: 386000,
    paidCount: 9,
    paidAmount: 148000,
    color: "oklch(0.6 0.2 300)",
  },
  {
    key: "ivr",
    label: "IVR",
    icon: Radio,
    real: false,
    volume: 210,
    engaged: 84,
    ptpCount: 14,
    ptpAmount: 168000,
    paidCount: 3,
    paidAmount: 42000,
    color: "oklch(0.65 0.15 190)",
  },
  {
    key: "sms",
    label: "SMS",
    icon: MessageSquare,
    real: false,
    volume: 340,
    engaged: 118,
    ptpCount: 6,
    paidCount: 2,
    ptpAmount: 54000,
    paidAmount: 18000,
    color: "oklch(0.6 0.18 250)",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    icon: MessageCircle,
    real: false,
    volume: 275,
    engaged: 152,
    ptpCount: 11,
    ptpAmount: 97000,
    paidCount: 4,
    paidAmount: 31000,
    color: "oklch(0.65 0.16 152)",
  },
];

function ChannelContributionPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const agents = useManagerTeamAgents(managerId);
  const agentCall = useAgentCallChannel(agents);
  const rows: ChannelRow[] = [agentCall, ...ILLUSTRATIVE_CHANNELS];
  const totalVolume = rows.reduce((s, r) => s + r.volume, 0);
  const totalPtpAmount = rows.reduce((s, r) => s + r.ptpAmount, 0);
  const totalPaidAmount = rows.reduce((s, r) => s + r.paidAmount, 0);

  const exportCsv = () => {
    downloadCsv(
      "channel-contribution.csv",
      [
        "Channel",
        "Data Source",
        "Volume",
        "Engaged",
        "PTP Count",
        "PTP Amount",
        "Paid Count",
        "Paid Amount",
        "Conversion %",
      ],
      rows.map((r) => [
        r.label,
        r.real ? "Real" : "Illustrative",
        r.volume,
        r.engaged,
        r.ptpCount,
        r.ptpAmount,
        r.paidCount,
        r.paidAmount,
        r.volume ? Math.round(((r.ptpCount + r.paidCount) / r.volume) * 100) : 0,
      ]),
    );
  };

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Channel Contribution
          </h1>
          <p className="text-sm text-muted-foreground">
            How Agent calls, AI, IVR, SMS and WhatsApp each contribute to recovery.
          </p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={exportCsv}>
          <FileDown className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-xs text-muted-foreground">
        <Info className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
        <span>
          <strong className="text-foreground">Agent Call</strong> is computed from real logged
          dispositions.
          <strong className="text-foreground"> AI / IVR / SMS / WhatsApp</strong> are shown
          illustratively — there's no telephony/IVR/SMS/WhatsApp integration wired up yet, so those
          numbers demonstrate the intended reporting shape rather than live data.
        </span>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xl font-bold text-foreground tabular-nums">{totalVolume}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Total contacts across all channels
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xl font-bold text-blue-500 tabular-nums">
              {formatINR(totalPtpAmount)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Total PTP amount secured</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xl font-bold text-success tabular-nums">
              {formatINR(totalPaidAmount)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">Total collected</div>
          </CardContent>
        </Card>
      </div>

      {/* Volume by channel chart */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold">Volume by Channel</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              />
              <YAxis tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} />
              <Tooltip
                contentStyle={{
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  fontSize: 11,
                }}
                formatter={(v: number, _n, entry: { payload?: { real?: boolean } }) => [
                  v,
                  entry?.payload?.real ? "Volume (real)" : "Volume (illustrative)",
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="volume" name="Volume" radius={[4, 4, 0, 0]}>
                {rows.map((r) => (
                  <Cell key={r.key} fill={r.color} fillOpacity={r.real ? 1 : 0.55} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold">Channel Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="py-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Channel
                  </th>
                  <th className="py-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Source
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Volume
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Engaged
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    PTP
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Paid
                  </th>
                  <th className="py-2 pr-4 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Conversion
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const conversion = r.volume
                    ? Math.round(((r.ptpCount + r.paidCount) / r.volume) * 100)
                    : 0;
                  return (
                    <tr key={r.key} className="hover:bg-muted/20 transition-colors">
                      <td className="py-3 pl-4">
                        <div className="flex items-center gap-2">
                          <r.icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium text-foreground">{r.label}</span>
                        </div>
                      </td>
                      <td className="py-3 text-center">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px]",
                            r.real
                              ? "bg-success/8 text-success/80 border-success/20"
                              : "bg-muted text-muted-foreground border-border",
                          )}
                        >
                          {r.real ? "Real" : "Illustrative"}
                        </Badge>
                      </td>
                      <td className="py-3 text-right tabular-nums">{r.volume}</td>
                      <td className="py-3 text-right tabular-nums text-muted-foreground">
                        {r.engaged}
                      </td>
                      <td className="py-3 text-right tabular-nums">
                        <div className="font-medium text-blue-600">{r.ptpCount}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatINR(r.ptpAmount)}
                        </div>
                      </td>
                      <td className="py-3 text-right tabular-nums">
                        <div className="font-medium text-success">{r.paidCount}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatINR(r.paidAmount)}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-right font-semibold text-foreground">
                        {conversion}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
