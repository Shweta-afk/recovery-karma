// Miss-escalation chain for any DATED COMMITMENT an agent logged — a PTP, or a callback they
// agreed to make. An overdue-and-still-open commitment notifies the agent's manager; if it is
// STILL unresolved the next calendar day, every admin is notified too.
//
// There's no server-side cron in this app, so both steps run client-side, opportunistically,
// whenever the relevant dashboard loads — see the call sites in dashboard.call-queue.tsx
// (agent -> manager) and manager.activity.tsx (manager -> admin). "Missed" means daysLeft < 0
// on a CaseFollowup: the due date has passed, the debtor hasn't resolved it, and no later
// disposition superseded it (computed by getCaseFollowups/getTeamCaseFollowups).
//
// Requires migrations/20260811_ptp_escalations.sql and 20260827_case_escalations.sql — the
// ptp_escalations table is the dedupe key (one row per debtor + due date + level + CASE TYPE)
// so a check that reruns every time someone loads a dashboard never re-sends the same
// notification. The case_type in that key is load-bearing: without it a PTP and a callback due
// on the same date for the same debtor collapse into one row and one of them silently never
// escalates.
//
// The table is still named ptp_escalations and its date column is still ptp_date; read those
// as "commitment" and "due date". Renaming would touch every policy for cosmetic gain.
import { supabase } from "./supabase";
import { saveNotification } from "./notification-store";
import { getTeamByAgent, getAdminEmails } from "./team-store";
import { isUuid, type CaseFollowup } from "./disposition-store";
import { formatINR } from "./mock-debtors";
import { todayIstKey } from "./date-filter";
import { istDayKey } from "./monthly-trend";

type EscalationLevel = "manager" | "admin";
type CaseType = CaseFollowup["kind"];

function escalationKey(
  debtorId: string,
  dueDateIso: string,
  level: EscalationLevel,
  caseType: CaseType,
): string {
  return `${debtorId}|${dueDateIso}|${level}|${caseType}`;
}

async function getExistingEscalationKeys(debtorIds: string[]): Promise<Set<string>> {
  if (!debtorIds.length) return new Set();
  const { data, error } = await supabase
    .from("ptp_escalations")
    .select("debtor_id, ptp_date, level, case_type")
    .in("debtor_id", debtorIds);
  if (error || !data) return new Set();
  return new Set(
    data.map((r) =>
      escalationKey(
        r.debtor_id as string,
        r.ptp_date as string,
        r.level as EscalationLevel,
        // Rows written before 20260827_case_escalations.sql have no case_type; they were all
        // PTPs by definition, which is also what the column's DEFAULT backfills them to.
        ((r as { case_type?: string }).case_type as CaseType) ?? "ptp",
      ),
    ),
  );
}

/** What the recipient actually reads. Phrased per case type — telling a manager a callback
 * "promised ₹0" would be nonsense. */
function describe(f: CaseFollowup): string {
  const overdue = `${Math.abs(f.daysLeft)}d overdue`;
  if (f.kind === "ptp") {
    return `Missed PTP: ${f.debtorName} promised ${formatINR(f.amount ?? 0)} by ${f.dueDateIso}, ${overdue} and still unresolved.`;
  }
  const at = f.dueTime ? ` at ${f.dueTime}` : "";
  return `Missed callback: ${f.debtorName} was due a call back on ${f.dueDateIso}${at}, ${overdue} and still not done.`;
}

function describeForAdmin(f: CaseFollowup): string {
  if (f.kind === "ptp") {
    return `Unresolved PTP escalation: ${f.debtorName} promised ${formatINR(f.amount ?? 0)} by ${f.dueDateIso} — manager was notified and it's still open.`;
  }
  return `Unresolved callback escalation: ${f.debtorName} was due a call back on ${f.dueDateIso} — manager was notified and it's still not done.`;
}

/** "PTP Alert" is kept for promises so existing notifications stay recognisable. */
function alertName(kind: CaseType): string {
  return kind === "ptp" ? "PTP Alert" : "Callback Alert";
}

/**
 * Step 1: escalate this agent's own missed commitments to their manager, once each.
 *
 * Safe to call on every Call Queue load — already-escalated cases are skipped via
 * ptp_escalations, and the table's UNIQUE(debtor_id, ptp_date, level, case_type) constraint is
 * the final race guard if two tabs run this at the same moment.
 */
export async function escalateMissedCasesToManager(
  agentId: string,
  followups: CaseFollowup[],
): Promise<void> {
  const overdue = followups.filter((f) => f.daysLeft < 0 && isUuid(f.debtorId));
  if (!overdue.length) return;

  const team = getTeamByAgent(agentId);
  if (!team) return; // no manager on file to notify

  const existing = await getExistingEscalationKeys(overdue.map((f) => f.debtorId));
  const toEscalate = overdue.filter(
    (f) => !existing.has(escalationKey(f.debtorId, f.dueDateIso, "manager", f.kind)),
  );
  if (!toEscalate.length) return;

  const { error } = await supabase.from("ptp_escalations").insert(
    toEscalate.map((f) => ({
      debtor_id: f.debtorId,
      ptp_date: f.dueDateIso,
      level: "manager" as const,
      case_type: f.kind,
    })),
  );
  // A unique-constraint conflict here just means someone else (another tab, another agent
  // session) already recorded this exact escalation a moment ago — nothing left to notify.
  if (error) return;

  await Promise.all(
    toEscalate.map((f) =>
      saveNotification({
        toAgentId: team.managerId,
        fromName: alertName(f.kind),
        message: describe(f),
      }).catch(() => {}),
    ),
  );
}

/**
 * Step 2: any commitment escalated to a manager on a PREVIOUS calendar day and still open
 * today (no admin-level row yet) goes to every admin.
 *
 * The one-day grace period is deliberate — a manager who's online ten minutes after the
 * agent-level escalation shouldn't immediately also page every admin; they get the rest of
 * that day to act. Call from a manager-facing dashboard with that manager's whole team's
 * followups (getTeamCaseFollowups), not just their own calls.
 */
export async function escalateMissedCasesToAdmin(followups: CaseFollowup[]): Promise<void> {
  const overdue = followups.filter((f) => f.daysLeft < 0 && isUuid(f.debtorId));
  if (!overdue.length) return;

  // Both sides of the "was this escalated before today" comparison are bucketed in IST. They
  // used to be UTC on both sides — self-consistent, but it put the one-day grace boundary 5.5
  // hours out of step with every other date in the app, so admins could be paged early.
  const todayIso = todayIstKey();
  const { data: managerRows, error } = await supabase
    .from("ptp_escalations")
    .select("debtor_id, ptp_date, escalated_at, case_type")
    .eq("level", "manager")
    .in(
      "debtor_id",
      overdue.map((f) => f.debtorId),
    );
  if (error || !managerRows) return;

  const escalatedBeforeToday = new Set(
    managerRows
      .filter((r) => istDayKey(r.escalated_at as string) < todayIso)
      .map(
        (r) =>
          `${r.debtor_id}|${r.ptp_date}|${((r as { case_type?: string }).case_type as CaseType) ?? "ptp"}`,
      ),
  );
  const dueForAdmin = overdue.filter((f) =>
    escalatedBeforeToday.has(`${f.debtorId}|${f.dueDateIso}|${f.kind}`),
  );
  if (!dueForAdmin.length) return;

  const existingAdmin = await getExistingEscalationKeys(dueForAdmin.map((f) => f.debtorId));
  const toEscalate = dueForAdmin.filter(
    (f) => !existingAdmin.has(escalationKey(f.debtorId, f.dueDateIso, "admin", f.kind)),
  );
  if (!toEscalate.length) return;

  const { error: insertErr } = await supabase.from("ptp_escalations").insert(
    toEscalate.map((f) => ({
      debtor_id: f.debtorId,
      ptp_date: f.dueDateIso,
      level: "admin" as const,
      case_type: f.kind,
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
          fromName: alertName(f.kind),
          message: describeForAdmin(f),
        }).catch(() => {}),
      ),
    ),
  );
}
