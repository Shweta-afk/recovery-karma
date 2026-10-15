// Contracts — shared types and the pure rules behind Admin → Contracts and Superadmin → Contracts
// (tables: migrations/20261009_contracts.sql; server: contracts.server.ts).

/**
 * Company side switch. ON since 2026-10-12 (user: company admins must be able to read their terms
 * and agreement whenever they want, sign them, and the superadmin must see who has signed). It
 * was off from 2026-10-09 ("visible to superadmin for now"). While on:
 *  - company admins see Admin → Billing → Terms & agreements, and the pending-acceptance banner;
 *  - the company-admin server actions work;
 *  - publishing a change notifies (and, with Resend set up, emails) the companies' admins.
 * Setting it back to false hides all of that again — nothing else needs to change.
 */
export const CONTRACTS_VISIBLE_TO_COMPANIES = true;

export interface ContractDocument {
  id: string;
  /** null = SamvadX platform terms, the same for every company. */
  clientId: string | null;
  companyName: string | null;
  title: string;
  versionLabel: string | null;
  effectiveDate: string; // YYYY-MM-DD
  /** null for a document generated from a template (it has text, not a file). */
  fileName: string | null;
  fileSize: number | null;
  /** Generated from a contract template (open it to view/print) rather than uploaded. */
  generated: boolean;
  notes: string | null;
  createdAt: string;
}

/** One company's progress with one document (contract_document_status): their own agreement,
 *  or the platform terms. Null fields = hasn't happened yet. */
export interface DocumentStatus {
  documentId: string;
  clientId: string;
  sentAt: string | null;
  sentTo: string | null;
  sentVia: "resend" | "mail_app" | null;
  viewedAt: string | null;
  /** The company admin who first opened it (null for views recorded before 2026-10-16). */
  viewedByName: string | null;
  viewedByEmail: string | null;
  signedAt: string | null;
  signedName: string | null;
  signedEmail: string | null;
}

/** Where a company stands with a document, in one word, for a status chip. */
export function documentStage(
  s: DocumentStatus | null | undefined,
): "signed" | "viewed" | "sent" | "not_sent" {
  if (s?.signedAt) return "signed";
  if (s?.viewedAt) return "viewed";
  if (s?.sentAt) return "sent";
  return "not_sent";
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
  /** Drafts (e.g. made automatically when prices change) are never shown to companies. */
  status: "draft" | "published";
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
