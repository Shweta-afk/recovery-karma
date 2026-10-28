// Who pays for an Insights lookup, and holding/settling that money around the provider call.
// A manager pays from their own wallet (profilex_wallets); an admin from the company's wallet
// (profilex_company_wallets — admin lookups were never deducted until 2026-10-28,
// migrations/20261028_company_wallet_admin_charges.sql). Shared by runProfilexTrace,
// runManualInsight and both CIBIL pulls so every path charges the same way.
import { getSupabaseAdmin, type VerifiedCaller } from "./supabase-admin.server";

type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc: Rpc = (fn, args) => (getSupabaseAdmin() as unknown as { rpc: Rpc }).rpc(fn, args);

export interface InsightsHold {
  /** Give back whatever part of the hold was not actually spent; records the spend. Never throws. */
  settle: (cost: number) => Promise<void>;
}

/** Hold `amount` from whichever wallet pays for this caller's lookups. Throws a message the
 *  user can act on when the wallet doesn't cover it; `onRefused` runs first (mark the claimed
 *  ledger row failed). */
export async function holdInsightsSpend(
  caller: VerifiedCaller,
  amount: number,
  opts: { note: string; onRefused: (reason: string) => Promise<void> },
): Promise<InsightsHold> {
  const none: InsightsHold = { settle: async () => {} };
  const isManager = caller.role === "manager" && !!caller.agentId;
  const isAdmin = caller.role === "admin";
  if ((!isManager && !isAdmin) || !(amount > 0)) return none;

  const { data: ok, error } = isManager
    ? await rpc("profilex_wallet_hold", { p_manager_id: caller.agentId, p_amount: amount })
    : await rpc("profilex_company_hold", { p_client_id: caller.clientId, p_amount: amount });
  if (error || !ok) {
    await opts.onRefused(
      error ? `Wallet hold failed: ${error.message}` : "Insufficient wallet balance",
    );
    if (error) throw new Error("This lookup could not be started. Please try again.");
    throw new Error(
      isManager
        ? `Your Insights wallet needs at least ₹${amount.toFixed(2)} for this lookup. Ask an admin to top it up in Settings.`
        : `Your company's Insights wallet needs at least ₹${amount.toFixed(2)} for this lookup. Contact SamvadX to top it up.`,
    );
  }

  return {
    settle: async (cost: number) => {
      const p_cost = Math.max(0, Math.min(cost, amount));
      const { error: settleErr } = isManager
        ? await rpc("profilex_wallet_settle", {
            p_manager_id: caller.agentId,
            p_hold: amount,
            p_cost,
          })
        : await rpc("profilex_company_settle", {
            p_client_id: caller.clientId,
            p_hold: amount,
            p_cost,
            p_admin_id: caller.agentId,
            p_note: opts.note,
          });
      if (settleErr) console.error("[insights] wallet settle failed:", settleErr.message);
    },
  };
}
