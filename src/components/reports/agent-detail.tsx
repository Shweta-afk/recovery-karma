/**
 * One agent's full report — what a manager or admin sees after clicking a name.
 *
 * The per-agent row in Reports used to expand into a bare call log. Everything else about that
 * agent was only ever available as one column in a wide table, so comparing a person against
 * themselves (this month vs last, promises vs delivery, effort vs outcome) meant reading across
 * a row and doing the arithmetic by eye.
 *
 * Every figure here is scoped to the ONE agent, and every figure is real:
 *   - money and counts from their own call_logs and payments
 *   - POS from the portfolio cache (principal behind the accounts they worked / that promised)
 *   - time from call_logs.ring_seconds/wrap_seconds and agent_status_log
 *
 * Time fields render "—" when a day was never tracked. That is not the same as zero and the
 * component must not smooth over it — see agent-time-stats.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { PhoneCall, HandCoins, IndianRupee, Users, Clock3, Target } from "lucide-react";
import { formatINR } from "@/lib/mock-debtors";
import { OutcomeBreakdown } from "@/components/reports/outcome-breakdown";
import { MonthlyTrendPanel } from "@/components/reports/monthly-trend";
import { calcStats, type DispositionRecord } from "@/lib/disposition-store";
import type { PaymentRecord } from "@/lib/payments-store";
import {
  getAgentTimeStats,
  formatDuration,
  formatDurationOrDash,
  formatClockTime,
} from "@/lib/agent-time-stats";
import {
  fetchStatusIntervalsRange,
  todayPresenceKey,
  type StatusInterval,
} from "@/lib/agent-presence-store";
import { istDayKey } from "@/lib/monthly-trend";

function Tile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof PhoneCall;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 text-base font-bold tabular-nums leading-tight text-foreground">
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function AgentReportDetail({
  agentId,
  agentName,
  disps,
  payments,
  posByDebtor,
  /** IST day keys bounding the period the parent report is showing. */
  fromDay,
  toDay,
}: {
  agentId: string;
  agentName: string;
  disps: DispositionRecord[];
  payments: PaymentRecord[];
  posByDebtor: Map<string, number>;
  fromDay?: string;
  toDay?: string;
}) {
  const stats = useMemo(() => calcStats(disps), [disps]);

  // Distinct accounts, and the principal behind them. Set-based for the same reason the trend
  // metrics are: an account worked repeatedly counts its principal once.
  const { accounts, posWorked, posPromised } = useMemo(() => {
    const worked = new Set<string>();
    const promised = new Set<string>();
    for (const d of disps) {
      if (!d.debtorId) continue;
      worked.add(d.debtorId);
      if (d.outcome === "promised") promised.add(d.debtorId);
    }
    const price = (ids: Set<string>) => {
      let t = 0;
      for (const id of ids) t += posByDebtor.get(id) ?? 0;
      return t;
    };
    return { accounts: worked.size, posWorked: price(worked), posPromised: price(promised) };
  }, [disps, posByDebtor]);

  // Real time data for this agent over the report's period.
  const day = toDay ?? todayPresenceKey();
  const [intervals, setIntervals] = useState<StatusInterval[]>([]);
  useEffect(() => {
    fetchStatusIntervalsRange([agentId], fromDay ?? day, day)
      .then(setIntervals)
      .catch(() => setIntervals([]));
  }, [agentId, fromDay, day]);

  const time = useMemo(
    () => getAgentTimeStats(agentId, disps, day, intervals),
    [agentId, disps, day, intervals],
  );

  const talkPerCall = stats.total > 0 ? Math.round(time.callingSeconds / stats.total) : 0;
  // Delivery against promises — the single most useful ratio for one person, and impossible to
  // read off the wide table this replaces.
  const conversion = stats.ptpAmount > 0 ? (stats.paidAmount / stats.ptpAmount) * 100 : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Tile
          icon={PhoneCall}
          label="Calls"
          value={String(stats.total)}
          sub={`${stats.contactRate}% contact`}
        />
        <Tile icon={Users} label="Accounts" value={String(accounts)} sub="distinct, worked" />
        <Tile
          icon={Target}
          label="POS Worked"
          value={formatINR(posWorked)}
          sub="principal covered"
        />
        <Tile
          icon={Target}
          label="POS Promised"
          value={formatINR(posPromised)}
          sub="behind a PTP"
        />
        <Tile
          icon={HandCoins}
          label="PTP Value"
          value={formatINR(stats.ptpAmount)}
          sub={`${stats.ptps} promises`}
        />
        <Tile
          icon={IndianRupee}
          label="Collected"
          value={formatINR(stats.paidAmount)}
          sub={`${stats.paid} payments`}
        />
        <Tile
          icon={IndianRupee}
          label="Kept"
          value={conversion === null ? "—" : `${conversion.toFixed(0)}%`}
          sub={conversion === null ? "no promises yet" : "of PTP value"}
        />
      </div>

      {/* Time. Real as of the time-tracking migration; "—" where a day was never recorded. */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Clock3 className="h-3 w-3" />
          Time &amp; effort
          {!time.presenceRecorded && (
            <span className="ml-1 normal-case tracking-normal text-amber-500">
              · presence not recorded for this period
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Tile
            icon={Clock3}
            label="Talk"
            value={formatDuration(time.callingSeconds)}
            sub="measured"
          />
          <Tile icon={Clock3} label="Avg call" value={formatDuration(talkPerCall)} sub="per call" />
          <Tile icon={Clock3} label="Ringing" value={formatDurationOrDash(time.ringingSeconds)} />
          <Tile icon={Clock3} label="Wrap" value={formatDurationOrDash(time.dispositionSeconds)} />
          <Tile icon={Clock3} label="Break" value={formatDurationOrDash(time.breakSeconds)} />
          <Tile
            icon={Clock3}
            label="Idle"
            value={formatDurationOrDash(time.idleSeconds)}
            sub={
              time.loginTime
                ? `from ${formatClockTime(time.loginTime)}${time.logoutTime ? ` to ${formatClockTime(time.logoutTime)}` : ""}`
                : undefined
            }
          />
        </div>
      </div>

      <div>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          How {agentName.split(" ")[0]}&apos;s calls resolve
        </div>
        <OutcomeBreakdown disps={disps} />
      </div>

      {/* Their own month-over-month, with the same picker the team panel has — this is what
          makes "is this person improving" answerable for one individual. */}
      <MonthlyTrendPanel
        disps={disps}
        payments={payments}
        posByDebtor={posByDebtor}
        note={`${agentName} only. Bank-reported collections credit no agent, so they appear in team totals but never here.`}
      />
    </div>
  );
}

/** IST day key for a Date — the bounds AgentReportDetail expects. */
export function dayKeyOf(d: Date): string {
  return istDayKey(d.toISOString());
}
