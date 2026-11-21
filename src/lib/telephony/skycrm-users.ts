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

export function skycrmUsername(agent: {
  id: string;
  name: string | null;
  extension: string | null;
}): string {
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

/** SkyCRM logins that should follow their extension to its new holder (user, 2026-11-21). A login
 *  named after an extension ("8604") belongs with whoever holds that extension now: SkyCRM refuses
 *  a second user with the same name, so the new holder can't get one of their own. Moved only to
 *  someone who has no SkyCRM login yet, and never across companies. */
export function extensionLoginMoves(
  logins: Array<{ agentId: string; username: string; clientId: string }>,
  agents: Array<{ id: string; extension: string | null; clientId: string; isActive: boolean }>,
): Array<{ username: string; fromAgentId: string; toAgentId: string }> {
  const hasLogin = new Set(logins.map((l) => l.agentId));
  const moves: Array<{ username: string; fromAgentId: string; toAgentId: string }> = [];
  for (const l of logins) {
    if (!/^\d{3,6}$/.test(l.username)) continue;
    const holder = agents.find((a) => a.isActive && a.extension?.trim() === l.username);
    if (!holder || holder.id === l.agentId || holder.clientId !== l.clientId) continue;
    if (hasLogin.has(holder.id)) continue;
    moves.push({ username: l.username, fromAgentId: l.agentId, toAgentId: holder.id });
    hasLogin.add(holder.id);
  }
  return moves;
}
