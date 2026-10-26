// Pure rules for missed inbound calls: one entry per caller, and it drops off once someone at the
// company has called them back. No I/O; tested in scripts/telephony-numbers.test.ts.
import { normalisePhone } from "./guard-rules";

export interface MissedCallRow {
  id: string;
  phone: string;
  startedAt: string;
  debtorId: string | null;
  didNumber: string | null;
}

export interface MissedCaller {
  phone: string;
  debtorId: string | null;
  /** How many times they called without anyone answering. */
  count: number;
  firstAt: string;
  lastAt: string;
  /** The number they dialled most recently. */
  didNumber: string | null;
  ledgerIds: string[];
}

/**
 * Group unanswered inbound calls by caller (last 10 digits). A caller is dropped when an outbound
 * call to them started at or after their latest missed call — they've been called back. If they
 * called again after that call back, they're pending again.
 */
export function groupMissedCalls(
  missed: MissedCallRow[],
  outbound: Array<{ phone: string; startedAt: string }>,
): MissedCaller[] {
  const lastOut = new Map<string, number>();
  for (const o of outbound) {
    const key = normalisePhone(o.phone);
    lastOut.set(key, Math.max(lastOut.get(key) ?? 0, Date.parse(o.startedAt)));
  }
  const byPhone = new Map<string, MissedCaller>();
  for (const m of [...missed].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const key = normalisePhone(m.phone);
    if (key.length !== 10) continue;
    const g = byPhone.get(key);
    if (!g) {
      byPhone.set(key, {
        phone: m.phone,
        debtorId: m.debtorId,
        count: 1,
        firstAt: m.startedAt,
        lastAt: m.startedAt,
        didNumber: m.didNumber,
        ledgerIds: [m.id],
      });
    } else {
      g.count++;
      g.lastAt = m.startedAt;
      g.didNumber = m.didNumber ?? g.didNumber;
      g.debtorId ??= m.debtorId;
      g.ledgerIds.push(m.id);
    }
  }
  return [...byPhone.entries()]
    .filter(([key, g]) => (lastOut.get(key) ?? 0) < Date.parse(g.lastAt))
    .map(([, g]) => g)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
