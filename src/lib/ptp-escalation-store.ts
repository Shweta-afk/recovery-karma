// PTP miss-escalation chain: an agent's overdue-and-still-open PTP notifies their manager;
// if it's still unresolved the NEXT calendar day, every admin gets notified too. There's no
// server-side cron in this app, so both steps run client-side, opportunistically, whenever the
// relevant dashboard loads — see the call sites in dashboard.call-queue.tsx (agent -> manager)
// and manager.activity.tsx (manager -> admin). "Missed" means daysLeft < 0 on a PtpFollowup —
// i.e. the debtor hasn't paid AND no later disposition superseded the promise (computed by
// getPtpFollowups/getTeamPtpFollowups in disposition-store.ts).
//
// Requires migrations/20260811_ptp_escalations.sql — the ptp_escalations table is the dedupe
// key (one row per debtor+ptp_date+level) so a check that reruns every time someone loads a
// dashboard never re-sends the same notification.
import { supabase } from "./supabase";
import { saveNotification } from "./notification-store";
import { getTeamByAgent, getAdminEmails } from "./team-store";
import { isUuid, type PtpFollowup } from "./disposition-store";
import { formatINR } from "./mock-debtors";

type EscalationLevel = "manager" | "admin";

function escalationKey(debtorId: string, ptpDateIso: string, level: EscalationLevel): string {
  return `${debtorId}|${ptpDateIso}|${level}`;
}

async function getExistingEscalationKeys(debtorIds: string[]): Promise<Set<string>> {
  if (!debtorIds.length) return new Set();
  const { data, error } = await supabase
    .from("ptp_escalations")
    .select("debtor_id, ptp_date, level")
    .in("debtor_id", debtorIds);
  if (error || !data) return new Set();
  return new Set(
    data.map((r) =>
      escalationKey(r.debtor_id as string, r.ptp_date as string, r.level as EscalationLevel),
    ),
  );
}

/** Step 1: escalate this agent's own missed PTPs to their manager, once each. Safe to call on
 * every Call Queue load — already-escalated debtors are skipped via ptp_escalations, and the
 * table's UNIQUE(debtor_id, ptp_date, level) constraint is the final race guard if two tabs (or
 * two agents somehow sharing a debtor) run this at the same moment. */
export async function escalateMissedPtpsToManager(
  agentId: string,
  followups: PtpFollowup[],
): Promise<void> {
  const overdue = followups.filter((f) => f.daysLeft < 0 && isUuid(f.debtorId));
  if (!overdue.length) return;

  const team = getTeamByAgent(agentId);
  if (!team) return; // no manager on file to notify

  const existing = await getExistingEscalationKeys(overdue.map((f) => f.debtorId));
  const toEscalate = overdue.filter(
    (f) => !existing.has(escalationKey(f.debtorId, f.ptpDateIso, "manager")),
  );
  if (!toEscalate.length) return;

  const { error } = await supabase.from("ptp_escalations").insert(
    toEscalate.map((f) => ({
      debtor_id: f.debtorId,
      ptp_date: f.ptpDateIso,
      level: "manager" as const,
    })),
  );
  // A unique-constraint conflict here just means someone else (another tab, another agent
  // session) already recorded this exact escalation a moment ago — nothing left to notify.
  if (error) return;

  await Promise.all(
    toEscalate.map((f) =>
      saveNotification({
        toAgentId: team.managerId,
        fromName: "PTP Alert",
        message: `Missed PTP: ${f.debtorName} promised ${formatINR(f.ptpAmount)} by ${f.ptpDateIso}, ${Math.abs(f.daysLeft)}d overdue and still unresolved.`,
      }).catch(() => {}),
    ),
  );
}

/** Step 2: any PTP escalated to a manager on a PREVIOUS calendar day and still open today (no
 * admin-level row yet) goes to every admin. The one-day grace period is deliberate — a manager
 * who's online ten minutes after the agent-level escalation shouldn't immediately also page
 * every admin; they get the rest of that day to act. Call from a manager-facing dashboard with
 * that manager's whole team's followups (getTeamPtpFollowups), not just their own calls. */
export async function escalateMissedPtpsToAdmin(followups: PtpFollowup[]): Promise<void> {
  const overdue = followups.filter((f) => f.daysLeft < 0 && isUuid(f.debtorId));
  if (!overdue.length) return;

  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: managerRows, error } = await supabase
    .from("ptp_escalations")
    .select("debtor_id, ptp_date, escalated_at")
    .eq("level", "manager")
    .in(
      "debtor_id",
      overdue.map((f) => f.debtorId),
    );
  if (error || !managerRows) return;

  const escalatedBeforeToday = new Set(
    managerRows
      .filter((r) => (r.escalated_at as string).slice(0, 10) < todayIso)
      .map((r) => `${r.debtor_id}|${r.ptp_date}`),
  );
  const dueForAdmin = overdue.filter((f) =>
    escalatedBeforeToday.has(`${f.debtorId}|${f.ptpDateIso}`),
  );
  if (!dueForAdmin.length) return;

  const existingAdmin = await getExistingEscalationKeys(dueForAdmin.map((f) => f.debtorId));
  const toEscalate = dueForAdmin.filter(
    (f) => !existingAdmin.has(escalationKey(f.debtorId, f.ptpDateIso, "admin")),
  );
  if (!toEscalate.length) return;

  const { error: insertErr } = await supabase.from("ptp_escalations").insert(
    toEscalate.map((f) => ({
      debtor_id: f.debtorId,
      ptp_date: f.ptpDateIso,
      level: "admin" as const,
    })),
  );
  if (insertErr) return;

  const admins = await getAdminEmails();
  if (!admins.length) return;

  await Promise.all(
    toEscalate.flatMap((f) =>
      admins.map((adminEmail) =>
        saveNotification({
          toAgentId: adminEmail,
          fromName: "PTP Alert",
          message: `Unresolved PTP escalation: ${f.debtorName} promised ${formatINR(f.ptpAmount)} by ${f.ptpDateIso} — manager was notified and it's still open.`,
        }).catch(() => {}),
      ),
    ),
  );
}
