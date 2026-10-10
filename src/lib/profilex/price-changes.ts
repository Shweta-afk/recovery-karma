// What changed in a company's Insights plan between two saves of its settings — services added
// or removed, and per-service price changes — in plain language. Used to draft a contract change
// when a superadmin edits a company's Insights prices (superadmin-actions saveCompanyProfilexSettings).

import { PROFILEX_SERVICES, priceLine } from "./catalogue";

type RateCard = Record<string, Record<string, number>>;
interface PlanSnapshot {
  enabled_services: string[];
  rate_card: RateCard;
}

export function insightsPriceChanges(before: PlanSnapshot, after: PlanSnapshot): string[] {
  const was = new Set(before.enabled_services);
  const now = new Set(after.enabled_services);
  const out: string[] = [];
  for (const s of PROFILEX_SERVICES) {
    const inBefore = was.has(s.id);
    const inAfter = now.has(s.id);
    if (!inBefore && inAfter) {
      out.push(`Insights: added "${s.label}" at ${priceLine(s, after.rate_card)}`);
    } else if (inBefore && !inAfter) {
      out.push(`Insights: removed "${s.label}"`);
    } else if (inBefore && inAfter) {
      const a = priceLine(s, before.rate_card);
      const b = priceLine(s, after.rate_card);
      if (a !== b) out.push(`Insights "${s.label}": ${a} → ${b}`);
    }
  }
  return out;
}
