// Sales portal rules (2026-11-27) — pure: no imports, safe in the browser and on the server.
// Stages, sources, who may see/edit a lead, duplicate detection by phone, follow-up state,
// the website demo form's payload, and the Excel import of the old Google Sheet.
// Tested in scripts/sales-rules.test.ts.

export const SALES_STAGES = [
  { key: "new", label: "New", hint: "Just came in; nobody has spoken to them yet" },
  { key: "contacted", label: "Contacted", hint: "We have spoken or written to them" },
  { key: "demo_booked", label: "Demo booked", hint: "A demo date is fixed" },
  { key: "demo_done", label: "Demo done", hint: "They have seen SamvadX" },
  { key: "proposal", label: "Proposal sent", hint: "Prices / agreement sent" },
  { key: "negotiation", label: "Negotiation", hint: "Discussing terms" },
  { key: "won", label: "Won", hint: "Signed — becomes a client" },
  { key: "lost", label: "Lost", hint: "Not going ahead (give a reason)" },
] as const;

export type SalesStage = (typeof SALES_STAGES)[number]["key"];

export const OPEN_STAGES: SalesStage[] = [
  "new",
  "contacted",
  "demo_booked",
  "demo_done",
  "proposal",
  "negotiation",
];

export function isSalesStage(v: unknown): v is SalesStage {
  return SALES_STAGES.some((s) => s.key === v);
}

export function stageLabel(stage: string): string {
  return SALES_STAGES.find((s) => s.key === stage)?.label ?? stage;
}

export const SALES_SOURCES = [
  { key: "website", label: "Website form" },
  { key: "import", label: "Imported" },
  { key: "manual", label: "Added by hand" },
  { key: "signup", label: "Signed up on SamvadX" },
  { key: "referral", label: "Referral" },
  { key: "event", label: "Event" },
  { key: "other", label: "Other" },
] as const;

export type SalesSource = (typeof SALES_SOURCES)[number]["key"];

export function isSalesSource(v: unknown): v is SalesSource {
  return SALES_SOURCES.some((s) => s.key === v);
}

export function sourceLabel(source: string): string {
  return SALES_SOURCES.find((s) => s.key === source)?.label ?? source;
}

/** The website form's size bands, in order. */
export const AGENT_BANDS = ["Under 25", "25–100", "100–500", "500+"] as const;

// ─── Who may see / change a lead ─────────────────────────────────────────────

export type SalesCaller = { kind: "superadmin" } | { kind: "sales"; salesUserId: string };

/** A salesperson sees their own leads and the unassigned pool; a superadmin sees all. */
export function canSeeLead(caller: SalesCaller, lead: { owner_id: string | null }): boolean {
  if (caller.kind === "superadmin") return true;
  return lead.owner_id === null || lead.owner_id === caller.salesUserId;
}

/** Changing a lead needs ownership. An unassigned lead can only be claimed (see canAssign). */
export function canEditLead(caller: SalesCaller, lead: { owner_id: string | null }): boolean {
  if (caller.kind === "superadmin") return true;
  return lead.owner_id === caller.salesUserId;
}

/** Superadmins assign anyone to anything. A salesperson may only take an unassigned lead for
 *  themselves, or hand their own lead back to the pool. */
export function canAssign(
  caller: SalesCaller,
  lead: { owner_id: string | null },
  newOwner: string | null,
): boolean {
  if (caller.kind === "superadmin") return true;
  if (lead.owner_id === null) return newOwner === caller.salesUserId;
  if (lead.owner_id === caller.salesUserId) return newOwner === null;
  return false;
}

// ─── Phones and duplicates ───────────────────────────────────────────────────

/** Last 10 digits of an Indian number ("+91 98200 12345" → "9820012345"); null if too short. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// ─── Follow-ups ──────────────────────────────────────────────────────────────

export type FollowUpState = "none" | "overdue" | "today" | "upcoming";

/** `date` and `todayKey` are IST "YYYY-MM-DD" keys. */
export function followUpState(date: string | null | undefined, todayKey: string): FollowUpState {
  if (!date) return "none";
  if (date < todayKey) return "overdue";
  if (date === todayKey) return "today";
  return "upcoming";
}

// ─── The samvadx.com demo form ───────────────────────────────────────────────

export interface WebsiteLead {
  name: string;
  agency: string;
  phone: string;
  agentsBand: string | null;
  page: string | null;
}

export type WebsiteLeadResult =
  | { ok: true; lead: WebsiteLead }
  | { ok: false; reason: "spam" | "invalid" };

const clip = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);

/** Reads the form's fields (name, agency, phone, agents, page, _honey). A filled honeypot is a
 *  bot; anything without a name, agency and a 10-digit number is ignored. */
export function parseWebsiteLead(fields: Record<string, unknown>): WebsiteLeadResult {
  if (clip(fields._honey, 200)) return { ok: false, reason: "spam" };
  const name = clip(fields.name, 120);
  const agency = clip(fields.agency, 200);
  const phone = clip(fields.phone, 20);
  if (name.length < 2 || agency.length < 2 || !phoneKey(phone)) {
    return { ok: false, reason: "invalid" };
  }
  const band = clip(fields.agents, 40);
  const page = clip(fields.page, 200);
  return {
    ok: true,
    lead: {
      name,
      agency,
      phone,
      agentsBand: band || null,
      page: page || null,
    },
  };
}

// ─── Excel import (the old Google Sheet, or any list) ────────────────────────

export interface ImportedLead {
  company_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  agents_band: string | null;
  notes: string | null;
  /** When the request came in, if the sheet has a date/time column (ISO). */
  received_at: string | null;
}

export interface ImportResult {
  leads: ImportedLead[];
  /** 1-based row numbers (after the header) that were skipped, with why. */
  skipped: { row: number; reason: string }[];
}

const HEADER_ALIASES: Record<keyof Omit<ImportedLead, "notes">, string[]> = {
  company_name: ["agency", "company", "company name", "organisation", "organization", "firm"],
  contact_name: ["name", "contact", "contact name", "full name", "person"],
  phone: ["phone", "mobile", "phone number", "mobile number", "contact number", "number"],
  email: ["email", "e-mail", "email address", "mail"],
  city: ["city", "location", "town"],
  agents_band: ["agents", "agent count", "team size", "size", "no of agents", "number of agents"],
  received_at: ["timestamp", "date", "time", "submitted", "submitted at", "created", "created at"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Which import field each sheet column feeds, by header name. Unknown columns go into notes. */
export function mapImportHeaders(headers: string[]): Record<string, keyof ImportedLead | "notes"> {
  const out: Record<string, keyof ImportedLead | "notes"> = {};
  const taken = new Set<string>();
  for (const h of headers) {
    const n = norm(h);
    const field = (Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]).find(
      (f) => !taken.has(f) && HEADER_ALIASES[f].includes(n),
    );
    if (field) {
      out[h] = field;
      taken.add(field);
    } else if (n) {
      out[h] = "notes";
    }
  }
  return out;
}

function toIso(v: string): string | null {
  if (!v) return null;
  // dd/mm/yyyy [hh:mm[:ss]] — how Google Sheets in India writes Timestamp.
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, hh = "0", mm = "0", ss = "0"] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss.padStart(2, "0")}+05:30`;
    return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Turns sheet rows (header → cell text) into leads. A row needs a company or a person, and a
 *  phone or an email. Rows repeating a phone already seen earlier in the same file are skipped. */
export function parseImportRows(rows: Record<string, unknown>[]): ImportResult {
  const leads: ImportedLead[] = [];
  const skipped: ImportResult["skipped"] = [];
  if (rows.length === 0) return { leads, skipped };
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const map = mapImportHeaders(headers);
  const seen = new Set<string>();

  rows.forEach((row, i) => {
    const lead: ImportedLead = {
      company_name: "",
      contact_name: null,
      phone: null,
      email: null,
      city: null,
      agents_band: null,
      notes: null,
      received_at: null,
    };
    const notes: string[] = [];
    for (const [h, field] of Object.entries(map)) {
      const cell = clip(row[h], 500);
      if (!cell) continue;
      if (field === "notes") notes.push(`${h}: ${cell}`);
      else if (field === "received_at") lead.received_at = toIso(cell);
      else if (field === "company_name") lead.company_name = cell.slice(0, 200);
      else lead[field] = cell.slice(0, 200);
    }
    lead.notes = notes.length ? notes.join("\n") : null;
    if (!lead.company_name && lead.contact_name) lead.company_name = lead.contact_name;
    const key = phoneKey(lead.phone);
    if (!lead.company_name) {
      skipped.push({ row: i + 1, reason: "No company or name" });
    } else if (!key && !lead.email) {
      skipped.push({ row: i + 1, reason: "No phone or email" });
    } else if (key && seen.has(key)) {
      skipped.push({ row: i + 1, reason: "Same phone as an earlier row" });
    } else {
      if (key) seen.add(key);
      leads.push(lead);
    }
  });
  return { leads, skipped };
}

// ─── Pipeline numbers ────────────────────────────────────────────────────────

export interface PipelineLead {
  stage: string;
  deal_monthly: number | null;
}

/** Count and monthly value per stage; `open` totals the stages still in play. */
export function pipelineSummary(leads: PipelineLead[]): {
  byStage: Record<string, { count: number; value: number }>;
  open: { count: number; value: number };
} {
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const s of SALES_STAGES) byStage[s.key] = { count: 0, value: 0 };
  const open = { count: 0, value: 0 };
  for (const l of leads) {
    const b = byStage[l.stage];
    if (!b) continue;
    const v = Number(l.deal_monthly) || 0;
    b.count += 1;
    b.value += v;
    if ((OPEN_STAGES as string[]).includes(l.stage)) {
      open.count += 1;
      open.value += v;
    }
  }
  return { byStage, open };
}
