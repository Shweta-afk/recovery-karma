// Saved column-mapping templates, keyed per bank/lender. Backed by Supabase's
// `mapping_templates` table — client-scoped (org-wide), not per-browser, so once one
// manager teaches the app a bank's CSV layout, every manager in the org benefits.
//
// The first time a manager maps a bank's file, we persist the mapping. Subsequent uploads
// from the same bank auto-apply it — so each bank is mapped once, not once per file.
// A "fingerprint" of the header set lets us prefer an exact format match when a bank sends
// more than one file layout.

import { normHeader } from "./column-mapper";
import { supabase, getMyAgentRow } from "./supabase";

export interface MappingTemplate {
  id: string;
  lender: string; // normalized lender key
  lenderLabel: string; // original display name
  fingerprint: string; // hash of the sorted normalized header set
  mapping: Record<string, string>; // canonical field key → source header
  updatedAt: string; // ISO
  useCount: number;
}

const KEY = "recoveryai_mapping_templates_cache";

function normLender(lender: string): string {
  return lender.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Stable fingerprint from a header set (order-independent). */
export function headerFingerprint(headers: string[]): string {
  const joined = headers.map(normHeader).filter(Boolean).sort().join("|");
  // djb2 hash → short hex string
  let h = 5381;
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function getTemplates(): MappingTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as MappingTemplate[]) : [];
  } catch {
    return [];
  }
}

export async function refreshMappingTemplates(): Promise<void> {
  const { data, error } = await supabase
    .from("mapping_templates")
    .select("id, lender, lender_label, fingerprint, mapping, use_count, updated_at");
  if (error || !data) return;

  const templates: MappingTemplate[] = data.map((t) => ({
    id: t.id,
    lender: t.lender,
    lenderLabel: t.lender_label ?? t.lender,
    fingerprint: t.fingerprint,
    mapping: (t.mapping as Record<string, string>) ?? {},
    updatedAt: t.updated_at,
    useCount: t.use_count,
  }));

  localStorage.setItem(KEY, JSON.stringify(templates));
  window.dispatchEvent(new CustomEvent("mapping-templates-updated"));
}

/**
 * Best template for a lender + header set:
 *   1. exact fingerprint match (same bank, same layout)
 *   2. otherwise the most-recently-updated template for that lender
 */
export function findTemplate(lender: string, headers: string[]): MappingTemplate | null {
  const key = normLender(lender);
  if (!key) return null;
  const fp = headerFingerprint(headers);
  const forLender = getTemplates().filter((t) => t.lender === key);
  if (!forLender.length) return null;
  return (
    forLender.find((t) => t.fingerprint === fp) ??
    [...forLender].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ??
    null
  );
}

/** Create or update the template for this lender + layout. */
export async function saveTemplate(
  lender: string,
  headers: string[],
  mapping: Record<string, string>,
): Promise<void> {
  const key = normLender(lender);
  if (!key) return;
  const fp = headerFingerprint(headers);
  const cleanMapping = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v));
  const existing = getTemplates().find((t) => t.lender === key && t.fingerprint === fp);

  if (existing) {
    const { error } = await supabase
      .from("mapping_templates")
      .update({
        mapping: cleanMapping,
        updated_at: new Date().toISOString(),
        use_count: existing.useCount + 1,
      })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const me = await getMyAgentRow();
    const { error } = await supabase.from("mapping_templates").insert({
      client_id: me?.client_id,
      lender: key,
      lender_label: lender.trim(),
      fingerprint: fp,
      mapping: cleanMapping,
      use_count: 1,
    });
    if (error) throw error;
  }

  await refreshMappingTemplates();
}
