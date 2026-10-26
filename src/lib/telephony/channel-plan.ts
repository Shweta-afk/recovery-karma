// Pure rules for sharing the trunk's channels between companies. No I/O; tested in
// scripts/telephony-numbers.test.ts. telephony_reserve_channel_v2
// (migrations/20261026_telephony_dids_channels.sql) enforces the same rule atomically — change
// them together.
//
// Each company has a guaranteed share (`reserved`) and a ceiling (`max`). Between the two it
// borrows from the shared pool: whatever is left of the trunk after the inbound reserve and every
// company's guaranteed share (or its actual use, if higher).

export interface TrunkSettings {
  /** Concurrent channels on the vendor trunk (inbound + outbound, every company). */
  totalChannels: number;
  /** Channels outbound dialling may never take. */
  inboundReserve: number;
}

export const DEFAULT_TRUNK: TrunkSettings = { totalChannels: 60, inboundReserve: 8 };

export interface CompanyShare {
  clientId: string;
  reserved: number;
  max: number;
  /** Open outbound calls right now. */
  activeOutbound: number;
  /** Disabled companies hold no reservation. */
  enabled: boolean;
}

/** Channels counted as held: inbound (at least its reserve) + each company's max(use, guarantee). */
export function heldChannels(
  trunk: TrunkSettings,
  companies: CompanyShare[],
  inboundActive: number,
): number {
  return (
    Math.max(inboundActive, trunk.inboundReserve) +
    companies.reduce((sum, c) => sum + Math.max(c.activeOutbound, c.enabled ? c.reserved : 0), 0)
  );
}

/** How many more outbound calls `clientId` may open right now (0 = none). */
export function channelHeadroom(args: {
  trunk: TrunkSettings;
  companies: CompanyShare[];
  inboundActive: number;
  clientId: string;
  /** When the company has no settings row (simulator only): no guarantee, ceiling = trunk. */
  fallbackMax?: number;
}): number {
  const { trunk, companies, inboundActive, clientId } = args;
  const me = companies.find((c) => c.clientId === clientId);
  const mine = me?.activeOutbound ?? 0;
  const max = me ? me.max : (args.fallbackMax ?? trunk.totalChannels);
  const reserved = me?.enabled ? me.reserved : 0;
  const allActive = inboundActive + companies.reduce((s, c) => s + c.activeOutbound, 0);

  const ownSlack = Math.max(0, reserved - mine);
  const sharedFree = Math.max(
    0,
    trunk.totalChannels - heldChannels(trunk, companies, inboundActive),
  );
  return Math.max(0, Math.min(max - mine, trunk.totalChannels - allActive, ownSlack + sharedFree));
}

/** Why a company's share can't be saved, or null. `others` = every OTHER company's settings. */
export function shareError(args: {
  trunk: TrunkSettings;
  reserved: number;
  max: number;
  othersReserved: number;
}): string | null {
  const { trunk, reserved, max, othersReserved } = args;
  if (reserved > max)
    return "Guaranteed lines can't be more than the most lines this company may use.";
  if (max > trunk.totalChannels - trunk.inboundReserve) {
    return `At most ${trunk.totalChannels - trunk.inboundReserve} lines can be used for outbound calls (${trunk.totalChannels} on the trunk, ${trunk.inboundReserve} kept for inbound).`;
  }
  const free = trunk.totalChannels - trunk.inboundReserve - othersReserved;
  if (reserved > free) {
    return `Only ${Math.max(0, free)} lines are left to guarantee — other companies are guaranteed ${othersReserved}, and ${trunk.inboundReserve} are kept for inbound.`;
  }
  return null;
}

/** Why trunk settings can't be saved, or null. */
export function trunkError(trunk: TrunkSettings, allReserved: number): string | null {
  if (trunk.inboundReserve > trunk.totalChannels)
    return "The inbound reserve can't be more than the trunk.";
  if (allReserved + trunk.inboundReserve > trunk.totalChannels) {
    return `Companies are guaranteed ${allReserved} lines; with ${trunk.inboundReserve} kept for inbound that is more than ${trunk.totalChannels}. Lower some companies' guaranteed lines first.`;
  }
  return null;
}
