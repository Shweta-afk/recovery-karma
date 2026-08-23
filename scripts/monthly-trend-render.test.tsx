/**
 * Render smoke test for the month-over-month trend panel.
 *
 * The arithmetic is covered by scripts/monthly-trend-check.ts. This covers the other half:
 * that the panel actually renders. The three report pages mount it inside a Radix
 * <TabsContent>, which does not render until its tab is selected, so route-smoke.test.tsx
 * walks straight past it — a composition error in here would ship looking green.
 *
 * renderToString runs the render phase only, which is where that class of bug throws.
 */
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MonthlyTrendPanel } from "@/components/reports/monthly-trend";
import type { DispositionRecord } from "@/lib/disposition-store";
import type { PaymentRecord } from "@/lib/payments-store";

function disp(time: string, outcome: string, extra: Partial<DispositionRecord> = {}) {
  return {
    id: `d-${time}-${outcome}`,
    debtorId: "x",
    debtorName: "Debtor",
    phone: "",
    agentId: "a@x.com",
    agentName: "Agent A",
    outcome,
    notes: "",
    time,
    ...extra,
  } as DispositionRecord;
}

function pay(when: string, amount: number, extra: Partial<PaymentRecord> = {}) {
  return {
    id: `p-${when}-${amount}`,
    debtorId: "x",
    debtorName: "Debtor",
    loanId: "L1",
    phone: "",
    agentName: "Agent A",
    agentId: "a@x.com",
    collectorRole: "agent",
    amount,
    method: null,
    status: "completed",
    paymentType: "full",
    source: "agent",
    notes: "",
    receivedAt: when,
    createdAt: when,
    ...extra,
  } as PaymentRecord;
}

// Dated relative to now so the fixture always straddles the live current/previous month
// boundary — a hardcoded 2026 date would fall out of both windows and render an empty panel
// that proves nothing.
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const DISPS = [
  disp(daysAgo(1), "paid"),
  disp(daysAgo(2), "promised", { ptpAmount: 5000 }),
  disp(daysAgo(3), "no_answer"),
  disp(daysAgo(35), "paid", { agentId: "b@x.com", agentName: "Agent B" }),
  disp(daysAgo(40), "promised", { ptpAmount: 2000, agentId: "b@x.com", agentName: "Agent B" }),
];

const PAYMENTS = [
  pay(daysAgo(1), 12_000),
  pay(daysAgo(38), 9_000, { agentId: "b@x.com", agentName: "Agent B" }),
  pay(daysAgo(4), 4_500, { agentId: null, source: "bank_reported", collectorRole: "bank" }),
];

function render(node: React.ReactElement): string {
  const html = renderToString(node);
  // React swallows a render-phase throw into a fallback marker rather than rejecting, so
  // "it did not throw" proves nothing — the marker has to be read out explicitly. Same
  // reasoning as route-smoke.test.tsx.
  const failure = html.match(
    /data-msg="Switched to client rendering because the server rendering errored:([\s\S]*?)"/,
  );
  if (failure) throw new Error(`panel failed to render: ${failure[1].slice(0, 300)}`);
  return html;
}

describe("MonthlyTrendPanel renders", () => {
  test("agent view — no breakdowns", () => {
    const html = render(<MonthlyTrendPanel disps={DISPS} payments={PAYMENTS} />);
    // Every metric tile is present and the default selection drove the chart heading.
    expect(html).toContain("Collected");
    expect(html).toContain("PTP Value");
    expect(html).toContain("day by day");
    expect(html).toContain("Running total");
  });

  test("manager/admin view — breakdown tables render with their rows", () => {
    const html = render(
      <MonthlyTrendPanel
        disps={DISPS}
        payments={PAYMENTS}
        note="bank-reported collections credit no agent"
        breakdowns={[
          {
            title: "Agent",
            description: "per agent",
            icon: () => null as never,
            exportName: "agents",
            groups: [
              { id: "a@x.com", name: "Agent A", sub: "Team One", disps: DISPS, payments: PAYMENTS },
              { id: "b@x.com", name: "Agent B", sub: "Team One", disps: [], payments: [] },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Agent A");
    expect(html).toContain("Agent B");
    expect(html).toContain("bank-reported collections credit no agent");
    expect(html).toContain("Total");
  });

  test("empty data renders the panel rather than blowing up on a zero baseline", () => {
    const html = render(<MonthlyTrendPanel disps={[]} payments={[]} />);
    expect(html).toContain("day by day");
    // deltaPct(0, 0) is 0, not null — the tiles must show a flat chip, never "new".
    expect(html).not.toContain(">new<");
  });
});
