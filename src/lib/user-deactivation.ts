// Pure rules for removing a person from a company (Admin → Users → Delete), user 2026-11-21:
// "erase the person, keep the work". Tested in scripts/user-deactivation.test.ts; the server side
// is deactivateUser / reactivateUser in user-admin-actions.server.ts.
//
// What deactivating does:
//   - account switched off (agents.is_active = false) and login blocked (auth ban), so no session
//     — even one still open — can act (verifyCaller refuses inactive users);
//   - their SkyCRM extension is freed (taken out of the queues, agents.agent_extension = NULL) so a
//     superadmin can give it to someone else; reactivating does NOT give it back;
//   - personal contact details are erased (phone). Name and email stay: every call, disposition,
//     payment and report row is tied to them, and the bank's Feedback File prints the agent name;
//   - a manager hands their open portfolios and teams to another active manager first, so none is
//     left with a manager nobody can sign in as.
// Nothing they did — calls, dispositions, payments, recordings — is deleted.

export interface DeactivationInput {
  targetRole: string;
  targetIsSelf: boolean;
  /** Open (not closed, not deleted) portfolios whose manager_id is the target. */
  openPortfolios: number;
  /** Teams the target manages. */
  teams: number;
  /** The manager chosen to take them over, if any. */
  transferTo: { id: string; role: string; isActive: boolean; sameCompany: boolean } | null;
  targetId: string;
}

export type DeactivationPlan =
  | { ok: true; transfer: boolean }
  | {
      ok: false;
      reason: "self" | "admin" | "needs_transfer" | "bad_transfer";
      message: string;
      openPortfolios?: number;
      teams?: number;
    };

export function planDeactivation(i: DeactivationInput): DeactivationPlan {
  if (i.targetIsSelf)
    return { ok: false, reason: "self", message: "You can't deactivate your own account." };
  if (i.targetRole === "admin")
    return {
      ok: false,
      reason: "admin",
      message: "Admins can't be deactivated here. Ask SamvadX support.",
    };
  const owns = i.openPortfolios + i.teams;
  if (!owns) return { ok: true, transfer: false };
  if (!i.transferTo)
    return {
      ok: false,
      reason: "needs_transfer",
      message: `Choose a manager to take over ${describeHoldings(i.openPortfolios, i.teams)} first.`,
      openPortfolios: i.openPortfolios,
      teams: i.teams,
    };
  const t = i.transferTo;
  if (t.id === i.targetId || t.role !== "manager" || !t.isActive || !t.sameCompany)
    return {
      ok: false,
      reason: "bad_transfer",
      message: "Pick another active manager of your company to take over.",
    };
  return { ok: true, transfer: true };
}

export function describeHoldings(portfolios: number, teams: number): string {
  const parts: string[] = [];
  if (portfolios) parts.push(`${portfolios} open portfolio${portfolios === 1 ? "" : "s"}`);
  if (teams) parts.push(`${teams} team${teams === 1 ? "" : "s"}`);
  return parts.join(" and ");
}
