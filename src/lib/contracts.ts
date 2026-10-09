// Contracts — shared types and the pure rules behind Admin → Contracts and Superadmin → Contracts
// (tables: migrations/20261009_contracts.sql; server: contracts.server.ts).

/**
 * Company side switch. While false (user's decision, 2026-10-09: "visible to superadmin for now,
 * not on client side"), contracts are superadmin-only:
 *  - no Contracts link or pending-acceptance banner for company admins, and /admin/contracts says
 *    it isn't available;
 *  - the company-admin server actions refuse;
 *  - publishing a change records it but notifies and emails nobody.
 * Flip to true to open it to company admins — nothing else needs to change.
 */
export const CONTRACTS_VISIBLE_TO_COMPANIES = false;

export interface ContractDocument {
  id: string;
  /** null = SamvadX platform terms, the same for every company. */
  clientId: string | null;
  companyName: string | null;
  title: string;
  versionLabel: string | null;
  effectiveDate: string; // YYYY-MM-DD
  fileName: string;
  fileSize: number | null;
  notes: string | null;
  createdAt: string;
}

export interface ContractAcceptance {
  clientId: string;
  acceptedName: string;
  acceptedEmail: string;
  acceptedAt: string;
}

export interface ContractChange {
  id: string;
  title: string;
  body: string;
  effectiveDate: string;
  /** null = every company. */
  clientIds: string[] | null;
  requiresAcceptance: boolean;
  documentId: string | null;
  createdAt: string;
  withdrawnAt: string | null;
}

/** Does this change apply to this company? */
export function changeAppliesTo(change: Pick<ContractChange, "clientIds">, clientId: string) {
  return change.clientIds === null || change.clientIds.includes(clientId);
}

/** Still waiting for this company's acceptance? Withdrawn changes never are. */
export function isPendingFor(
  change: Pick<ContractChange, "clientIds" | "requiresAcceptance" | "withdrawnAt">,
  clientId: string,
  acceptance: ContractAcceptance | undefined,
): boolean {
  return (
    change.requiresAcceptance &&
    !change.withdrawnAt &&
    !acceptance &&
    changeAppliesTo(change, clientId)
  );
}

/** The version in force: latest effective date not in the future, newest upload breaking ties.
 *  Falls back to the earliest upcoming one when every version is still in the future. */
export function currentDocument<T extends Pick<ContractDocument, "effectiveDate" | "createdAt">>(
  docs: T[],
  today: string,
): T | null {
  const sorted = [...docs].sort(
    (a, b) =>
      b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt),
  );
  return (
    sorted.find((d) => d.effectiveDate <= today) ??
    [...sorted].reverse().find((d) => d.effectiveDate > today) ??
    null
  );
}

/** The email a company admin gets about a change — used for the automatic email (Resend) and the
 *  manual mailto fallback alike, so both say the same thing. */
export function changeEmail(
  change: Pick<ContractChange, "title" | "body" | "effectiveDate" | "requiresAcceptance">,
): { subject: string; text: string } {
  const lines = [
    "Hello,",
    "",
    `We have published an update to your SamvadX contract, effective ${change.effectiveDate}:`,
    "",
    change.title,
    "",
    change.body,
    "",
    change.requiresAcceptance
      ? "Please sign in to SamvadX and accept it under Contracts."
      : "You can read it any time under Contracts in SamvadX.",
    "",
    "Thank you,",
    "Team SamvadX",
  ];
  return { subject: `SamvadX contract update: ${change.title}`, text: lines.join("\n") };
}

/**
 * A mailto: link that opens the superadmin's own email app with the admins in BCC and the change
 * prefilled — the fallback when automatic email (Resend) isn't set up. Admins are BCC'd so
 * companies never see each other's addresses.
 */
export function changeMailto(
  emails: string[],
  change: Pick<ContractChange, "title" | "body" | "effectiveDate" | "requiresAcceptance">,
): string {
  const unique = [...new Set(emails.map((e) => e.trim()).filter(Boolean))];
  const { subject, text } = changeEmail(change);
  const params = new URLSearchParams({ bcc: unique.join(","), subject, body: text });
  // URLSearchParams encodes spaces as "+", which mail apps show literally — use %20.
  return `mailto:?${params.toString().replace(/\+/g, "%20")}`;
}

/** "1.2 MB" */
export function fileSizeLabel(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
