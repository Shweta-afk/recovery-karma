// Which Insights recharge a superadmin take-back came out of (pure; tested in
// scripts/topup-takebacks.test.ts).
//
// A take-back (ledger scope company_to_master) isn't tied to one recharge (master_to_company),
// so it is matched to the most recent recharges made before it, newest first, each up to what is
// left of it. The recharge invoice then defaults to the recharge minus what was taken back from
// it (user, 2026-11-21) — the superadmin can still change the amount before issuing.

export interface LedgerMove {
  id: string;
  amount: number;
  createdAt: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rupees taken back from each recharge, keyed by the recharge's ledger id (0 when none). */
export function takenBackByTopup(
  topups: LedgerMove[],
  takeBacks: LedgerMove[],
): Map<string, number> {
  const left = new Map(topups.map((t) => [t.id, t.amount]));
  const taken = new Map(topups.map((t) => [t.id, 0]));
  const newestFirst = [...topups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const tb of [...takeBacks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    let rest = tb.amount;
    for (const t of newestFirst) {
      if (rest <= 0) break;
      if (t.createdAt > tb.createdAt) continue;
      const take = Math.min(rest, left.get(t.id) ?? 0);
      if (take <= 0) continue;
      left.set(t.id, round2((left.get(t.id) ?? 0) - take));
      taken.set(t.id, round2((taken.get(t.id) ?? 0) + take));
      rest = round2(rest - take);
    }
  }
  return taken;
}
