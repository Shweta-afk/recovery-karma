// Sending invoices and agreements to a company, and the links in those emails. Pure, shared by
// invoice-actions.server.ts, contracts.server.ts and the tests (scripts/billing-delivery.test.ts).
//
// Every link points at the company's OWN address (<subdomain>.samvadx.com, or the platform
// address for a company without one) — a company user signs in only there (company-address.ts).
// Opening the link and signing in is what marks an invoice "Viewed" / an agreement "Viewed";
// nothing in the email itself is tracked.
import { addressFor, expectedLoginSubdomain } from "./company-address";

/** https://acme.samvadx.com/admin/billing?invoice=… */
export function companyAppLink(
  subdomain: string | null | undefined,
  path: string,
  params: Record<string, string> = {},
): string {
  const qs = new URLSearchParams(params).toString();
  return `https://${addressFor(expectedLoginSubdomain(subdomain))}${path}${qs ? `?${qs}` : ""}`;
}

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function invoiceEmail(
  inv: { invoiceNumber: string; total: number; dueDate: string; description: string },
  companyName: string,
  link: string,
  supplierName: string,
): { subject: string; text: string } {
  return {
    subject: `Invoice ${inv.invoiceNumber} from ${supplierName || "SamvadX"} — ${inr(inv.total)}`,
    text: [
      `Dear ${companyName} team,`,
      "",
      `Please find your invoice ${inv.invoiceNumber} for ${inv.description}.`,
      "",
      `Amount due (incl. GST): ${inr(inv.total)}`,
      `Due date: ${inv.dueDate}`,
      "",
      "View, print or download it here (sign in as an admin):",
      link,
      "",
      "Thank you,",
      supplierName || "Team SamvadX",
    ].join("\n"),
  };
}

export function agreementEmail(
  doc: { title: string; effectiveDate: string },
  companyName: string,
  link: string,
): { subject: string; text: string } {
  return {
    subject: `Please review and sign: ${doc.title} (SamvadX)`,
    text: [
      `Dear ${companyName} team,`,
      "",
      `Your SamvadX agreement "${doc.title}" (effective ${doc.effectiveDate}) is ready for you.`,
      "",
      "Please read it and sign it in SamvadX (sign in as an admin):",
      link,
      "",
      "You can come back to it any time under Billing → Terms & agreements.",
      "",
      "Thank you,",
      "Team SamvadX",
    ].join("\n"),
  };
}

/** Opens the sender's own mail app with the email written — the fallback when Resend isn't set
 *  up. One recipient, so no other company's address is ever exposed. */
export function mailtoLink(to: string, email: { subject: string; text: string }): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.text)}`;
}

export type DeliveryVia = "resend" | "mail_app";

/** "Emailed 12 Oct, 3:04 pm" / "Opened in your mail app 12 Oct…" — for status chips. */
export function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
