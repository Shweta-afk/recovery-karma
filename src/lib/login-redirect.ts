// Sending a signed-out visitor back to the page they opened (e.g. an invoice link from
// SamvadX's email) once they sign in. Pure, so it is tested in scripts/login-redirect.test.ts.

/** Query parameter on /login holding the page the visitor was trying to open. */
export const NEXT_PARAM = "next";

/** Where to go after signing in: `next` only when it is a same-site path inside the signed-in
 *  role's own section (`home`, e.g. "/admin") — a crafted link can't send an admin to
 *  /superadmin or off the site — else `home`. */
export function afterLoginPath(next: string | null, home: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return home;
  return next === home || next.startsWith(`${home}/`) || next.startsWith(`${home}?`) ? next : home;
}
