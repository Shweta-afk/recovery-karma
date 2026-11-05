// Rules for the SkyCRM user each SamvadX person gets (2026-11-05; table skycrm_users, action
// createSkycrmUsers in telephony-actions.server.ts). Pure — tested in scripts/skycrm-users.test.ts.
//
// SkyCRM's users_webhook_api uses the name as the USERNAME and crashes on a duplicate, so the
// username must be unique across the whole SkyCRM account (every company shares it):
//  - someone with an extension → the extension ("8601"), already unique platform-wide;
//  - anyone else → first name + 4 characters of their SamvadX id ("rahul3f2a").

export type SkycrmUserLevel = "admin" | "manager" | "user";

export function skycrmUserLevel(role: string): SkycrmUserLevel {
  if (role === "admin") return "admin";
  if (role === "manager") return "manager";
  return "user";
}

export function skycrmUsername(agent: { id: string; name: string | null; extension: string | null }): string {
  const ext = agent.extension?.trim();
  if (ext && /^\d{3,6}$/.test(ext)) return ext;
  const first =
    (agent.name ?? "")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16) || "user";
  return `${first}${agent.id.replace(/-/g, "").slice(0, 4).toLowerCase()}`;
}

/** 20 random characters (letters + digits, plus "@1" so it passes a typical "needs a digit and a
 *  symbol" rule). Generated server-side; nobody ever types it. */
export function skycrmPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out}@1`;
}
