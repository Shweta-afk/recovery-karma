// Contracts — shared types and the pure rules behind Admin → Contracts and Superadmin → Contracts
// (tables: migrations/20261009_contracts.sql; server: contracts.server.ts).

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

/**
 * A mailto: link that opens the superadmin's own email app with the admins in BCC and the change
 * prefilled — how "email the admins" works without an email-sending service in the app. Admins
 * are BCC'd so companies never see each other's addresses.
 */
export function changeMailto(
  emails: string[],
  change: Pick<ContractChange, "title" | "body" | "effectiveDate" | "requiresAcceptance">,
): string {
  const unique = [...new Set(emails.map((e) => e.trim()).filter(Boolean))];
  const subject = `SamvadX contract update: ${change.title}`;
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
  const params = new URLSearchParams({ bcc: unique.join(","), subject, body: lines.join("\n") });
  // URLSearchParams encodes spaces as "+", which mail apps show literally — use %20.
  return `mailto:?${params.toString().replace(/\+/g, "%20")}`;
}

/** "1.2 MB" */
export function fileSizeLabel(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
