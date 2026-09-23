// Per-agent book totals — accounts held and summed loan_amount ("assigned POS") — for the agent
// and manager dashboards (growth plan item #3).
//
// Both dashboards used to call portfolio-store.ts's refreshPortfolios(), downloading every
// debtor the caller can see, only to sum two numbers per agent. Both load on every sign-in.
// Now one grouped query does it in the database: agent_book_totals()
// (migrations/20260923_agent_book_totals.sql), which applies the same rules the browser did —
// assigned, not removed, open portfolio. Checked against production 2026-09-23: 407 accounts /
// ₹2,00,50,193 for one agent, identical to what the full sync produced.
//
// Keyed by agent EMAIL, like the rest of the client stores (assignedAgentId, dispositions).
// Falls back to the old full sync if the function isn't deployed yet, so code and migration can
// ship in either order.
import { supabase } from "./supabase";
import { loadAgentEmails } from "./scoped-debtors";
import { getAgentDebtorIds, getPortfolios, refreshPortfolios } from "./portfolio-store";
import { monthlyCollectionTarget } from "./daily-run-rate";

export interface AgentBook {
  accounts: number;
  assignedPos: number;
  /** Σ portfolio_agent_targets.target_amount over every portfolio the caller can see — the
   * same sum daily-run-rate.ts's monthlyCollectionTarget() takes over the portfolio cache,
   * which (knowingly, for now) includes a CLOSED portfolio's target too. */
  monthlyTarget: number;
}

const EMPTY: AgentBook = { accounts: 0, assignedPos: 0, monthlyTarget: 0 };
const cache = new Map<string, AgentBook>();

/** Zero for an agent with no accounts — and for one not fetched yet, which is what the old
 * cache-based computation also showed before its first sync landed. */
export function getAgentBook(agentKey: string): AgentBook {
  return cache.get(agentKey) ?? EMPTY;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let rpcAvailable = true;

export async function refreshAgentBooks(agentKeys: string[]): Promise<void> {
  const keys = [...new Set(agentKeys.filter(Boolean))];
  if (!keys.length) return;

  if (rpcAvailable) {
    const { idByEmail, emailById } = await loadAgentEmails();
    // A key is normally an email; dashboard.index falls back to the auth user id when there is
    // none, which is already a uuid.
    const ids = keys
      .map((k) => idByEmail.get(k) ?? (UUID_RE.test(k) ? k : undefined))
      .filter((x): x is string => !!x);
    const [{ data, error }, { data: targetRows, error: tErr }] = await Promise.all([
      supabase.rpc("agent_book_totals", { p_agent_ids: ids }),
      supabase
        .from("portfolio_agent_targets")
        .select("agent_id, target_amount")
        .in("agent_id", ids),
    ]);
    if (!error) {
      const targetByKey = new Map<string, number>();
      // A failed targets read keeps each agent's previous target rather than showing 0 — a
      // zeroed target reads as "nothing left to collect" on the DRR tile.
      if (!tErr)
        for (const t of (targetRows ?? []) as {
          agent_id: string;
          target_amount: number | null;
        }[]) {
          const key = emailById.get(t.agent_id) ?? t.agent_id;
          targetByKey.set(key, (targetByKey.get(key) ?? 0) + Number(t.target_amount ?? 0));
        }
      const totals = new Map<string, { accounts: number; assignedPos: number }>();
      for (const r of (data ?? []) as {
        agent_id: string;
        accounts: number | string;
        assigned_pos: number | string;
      }[]) {
        totals.set(emailById.get(r.agent_id) ?? r.agent_id, {
          accounts: Number(r.accounts),
          assignedPos: Number(r.assigned_pos),
        });
      }
      for (const k of keys) {
        const t = totals.get(k) ?? { accounts: 0, assignedPos: 0 };
        const monthlyTarget = tErr ? getAgentBook(k).monthlyTarget : (targetByKey.get(k) ?? 0);
        cache.set(k, { ...t, monthlyTarget });
      }
      window.dispatchEvent(new CustomEvent("agent-books-updated"));
      return;
    }
    // PGRST202 = function not found (migration not applied yet). Anything else is a real
    // failure: keep the previous numbers rather than blanking the dashboard.
    if (error.code !== "PGRST202") return;
    rpcAvailable = false;
    console.warn("[agent-book-store] agent_book_totals missing — falling back to full sync");
  }

  await refreshPortfolios();
  const portfolios = getPortfolios();
  for (const k of keys) {
    let accounts = 0;
    let assignedPos = 0;
    for (const { portfolioId, debtorIds } of getAgentDebtorIds(k)) {
      const p = portfolios.find((x) => x.id === portfolioId);
      if (!p) continue;
      const idSet = new Set(debtorIds);
      for (const row of p.rows)
        if (idSet.has(row.id)) {
          accounts++;
          assignedPos += row.loanAmount;
        }
    }
    cache.set(k, { accounts, assignedPos, monthlyTarget: monthlyCollectionTarget(k) });
  }
  window.dispatchEvent(new CustomEvent("agent-books-updated"));
}
