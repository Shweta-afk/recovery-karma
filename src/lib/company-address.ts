// Which web address each company signs in at. Pure — imported by the browser (auth.tsx,
// login.tsx, setup.tsx) and the server (session-actions, superadmin-actions) alike, so the two
// can never disagree about where someone belongs.
//
// The rule: a company with a subdomain (clients.subdomain, set by a superadmin) signs in ONLY at
// <subdomain>.samvadx.com; a company without one (new, still pending) signs in at the platform
// address, PLATFORM_SUBDOMAIN, which is also where new companies sign up. Anyone on the wrong address is sent to
// the right one. Superadmins may sign in anywhere.
//
// ⚠️ This is about sending people to the right address, NOT data security. The check runs
// through the app's own login screen, so someone calling Supabase directly skips it. What keeps
// one company's data away from another is RLS in the database, on every address.
//
// Hosts that are not a one-label samvadx.com subdomain (localhost, Lovable previews, the
// *.up.railway.app domains) are never checked, so local dev and previews keep working.

export const PLATFORM_DOMAIN = "samvadx.com";

/** The neutral address (user's decision, 2026-10-10): company signup, superadmins, and companies
 *  without a subdomain yet. Never assigned to a company — a pending company's admin has to be
 *  able to sign in somewhere before a superadmin has given them a subdomain. (Axiotta's own team
 *  is a company like any other and has `axiotta`.) */
export const PLATFORM_SUBDOMAIN = "app";

/** Names a company may not be given. Either the platform needs them (the neutral address, the
 *  API / webhook address for vendors, mail) or they would look official to a borrower or a
 *  client. Only enforced when a subdomain is assigned. */
export const RESERVED_SUBDOMAINS: readonly string[] = [
  PLATFORM_SUBDOMAIN,
  "samvadx",
  "www",
  "api",
  "admin",
  "superadmin",
  "portal",
  "login",
  "signin",
  "signup",
  "setup",
  "auth",
  "account",
  "accounts",
  "billing",
  "pay",
  "payment",
  "payments",
  "invoice",
  "invoices",
  "help",
  "support",
  "docs",
  "status",
  "blog",
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "ftp",
  "ns1",
  "ns2",
  "dns",
  "cdn",
  "static",
  "assets",
  "media",
  "files",
  "webhook",
  "webhooks",
  "dev",
  "staging",
  "test",
  "sandbox",
];

const SUBDOMAIN_FORMAT_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_RE = /^([a-z0-9-]+)\.samvadx\.com$/;

/** "rrdebt.samvadx.com" -> "rrdebt". Null for anything that is not exactly one label under
 *  samvadx.com: the bare domain, deeper names, localhost, previews. */
export function subdomainFromHostname(hostname: string): string | null {
  const match = HOSTNAME_RE.exec(hostname.trim().toLowerCase().replace(/\.$/, ""));
  return match ? match[1] : null;
}

/** Where a company's users sign in. `companySubdomain` empty/null = the platform address. */
export function expectedLoginSubdomain(companySubdomain: string | null | undefined): string {
  const s = companySubdomain?.trim().toLowerCase();
  return s ? s : PLATFORM_SUBDOMAIN;
}

/** Whether a signed-in company user is on the wrong address, and if so where they belong.
 *  Returns null when nothing should happen: not a samvadx.com company host, or already right. */
export function wrongAddressRedirect(
  hostname: string,
  companySubdomain: string | null | undefined,
): string | null {
  const here = subdomainFromHostname(hostname);
  if (!here) return null;
  const expected = expectedLoginSubdomain(companySubdomain);
  return here === expected ? null : expected;
}

export function addressFor(subdomain: string): string {
  return `${subdomain}.${PLATFORM_DOMAIN}`;
}

/** Query flag the login page reads to explain why it was just opened from another address.
 *  Carries no personal data — the email is never put in the URL. */
export const MOVED_PARAM = "moved";

export function loginUrlFor(subdomain: string): string {
  return `https://${addressFor(subdomain)}/login?${MOVED_PARAM}=1`;
}

/** Why `slug` cannot be assigned to a company, or null if it can. `current` is the company's
 *  existing subdomain: re-saving a reserved name it already holds is allowed, so a company
 *  grandfathered on one is not stuck — except the platform address, which no company may keep. */
export function subdomainProblem(slug: string, current?: string | null): string | null {
  if (!SUBDOMAIN_FORMAT_RE.test(slug)) {
    return "Subdomain must be lowercase letters, numbers and hyphens only";
  }
  if (current && slug === current.trim().toLowerCase() && slug !== PLATFORM_SUBDOMAIN) return null;
  if (RESERVED_SUBDOMAINS.includes(slug)) {
    return slug === PLATFORM_SUBDOMAIN
      ? `${addressFor(slug)} is the platform's own sign-in address and can't belong to one company`
      : `"${slug}" is reserved for the platform — pick another name`;
  }
  return null;
}

/** A tiny endpoint the server answers on every address it serves. Before a subdomain is
 *  assigned, the superadmin action fetches it on the new address — if DNS or Railway is not set
 *  up yet, assigning would send that company's users to an address that doesn't load. */
export const APP_PING_PATH = "/api/samvadx-ping";
export const APP_PING_BODY = "samvadx-ok";
