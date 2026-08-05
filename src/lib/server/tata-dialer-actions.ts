// Automates what src/routes/dashboard.call-queue.tsx's "Export for Tata Dialer" button used
// to leave as a manual step: instead of downloading a CSV for someone to upload by hand in the
// Smartflo dashboard, this creates the lead list, uploads the leads, and creates the Dialer
// Campaign itself, all via Tata's Dialer Campaign API.
// Docs: https://docs.smartflo.tatatelebusiness.com/docs/dialer-campaigns
//
// Server-side only — never import from client code (needs TATA_ACCESS_TOKEN).
//
// IMPORTANT — untested against a live account: Tata's reference docs for these endpoints
// return empty `{}` response schemas for every create call (list, disposition list, campaign),
// so none of them are documented to hand back the id of what they just created. This module
// works around that by re-listing and matching on the name it just sent (see findByName) —
// the same "docs are incomplete, verify against the real API" situation recorded for
// click_to_call in tata-provider.ts. If a live run shows these endpoints actually do return an
// id, prefer that over the name-matching workaround.

import { createServerFn } from "@tanstack/react-start";

const TATA_ACCESS_TOKEN =
  typeof process !== "undefined" ? process.env?.TATA_ACCESS_TOKEN : undefined;
const TATA_BASE_URL =
  typeof process !== "undefined"
    ? (process.env?.TATA_BASE_URL ?? "https://api-smartflo.tatateleservices.com/v1")
    : "https://api-smartflo.tatateleservices.com/v1";

function requireApiKey() {
  if (!TATA_ACCESS_TOKEN) {
    throw new Error(
      "TATA_ACCESS_TOKEN is not set — get a Permanent Access Token from your Tata Tele account manager and add it to .env.local or your environment",
    );
  }
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TATA_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function tataFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${TATA_BASE_URL}${path}`;
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "message" in (body as Record<string, unknown>)
        ? String((body as Record<string, unknown>).message)
        : text || res.statusText;
    throw new Error(`Tata API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${msg}`);
  }
  return body as T;
}

function findByName<T extends { name?: string; id?: unknown }>(items: T[], name: string): T {
  const match = items.find((i) => i.name === name);
  if (!match) {
    throw new Error(
      `Created "${name}" on Tata but couldn't find it again to read its id back — check the Smartflo dashboard directly.`,
    );
  }
  return match;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── Lead rows ──────────────────────────────────────────────────────────────
// Column order matches the existing "Export for Tata Dialer" CSV (dashboard.call-queue.tsx) —
// field_0 is always phone by Tata convention, the rest are the same 10 custom columns already
// used there.

export const TATA_LEAD_FIELDS = [
  "Mobile Number",
  "Name",
  "Email ID",
  "Address",
  "Company Name",
  "Alternate Phone Number",
  "Loan Reference",
  "Outstanding Balance (INR)",
  "DPD",
  "AI Score",
  "SamvadX Debtor ID",
] as const;

export interface TataLeadRow {
  phone: string;
  name: string;
  email: string;
  address: string;
  company: string;
  altPhone: string;
  loanReference: string;
  outstanding: number;
  dpd: number;
  aiScore: number;
  debtorId: string;
}

function toLeadFields(row: TataLeadRow): Record<string, string> {
  const values = [
    row.phone,
    row.name,
    row.email,
    row.address,
    row.company,
    row.altPhone,
    row.loanReference,
    String(row.outstanding),
    String(row.dpd),
    String(row.aiScore),
    row.debtorId,
  ];
  return Object.fromEntries(values.map((v, i) => [`field_${i}`, v ?? ""]));
}

// ─── Setup options (for populating the campaign dialog) ──────────────────────

export interface TataAgentOption {
  id: number;
  name: string;
}

export interface TataDispositionListOption {
  id: string;
  name: string;
}

/** Everything the campaign-creation form needs to populate its pickers. */
async function fetchTataCampaignSetupOptions(): Promise<{
  agents: TataAgentOption[];
  dispositionLists: TataDispositionListOption[];
}> {
  requireApiKey();

  const [usersRes, dispositionRes] = await Promise.all([
    tataFetch<{ data: Array<{ id: number; agent?: { id: string; name: string } | null }> }>(
      "/users?limit=200",
    ),
    tataFetch<Array<{ id: string; name: string }> | { data: Array<{ id: string; name: string }> }>(
      "/dialer/disposition_list",
    ),
  ]);

  const agents = (usersRes.data ?? [])
    .filter((u) => u.agent)
    .map((u) => ({ id: u.id, name: u.agent!.name }));

  const dispositionLists = Array.isArray(dispositionRes)
    ? dispositionRes
    : (dispositionRes.data ?? []);

  return { agents, dispositionLists };
}

export const getTataCampaignSetupOptions = createServerFn({ method: "GET" }).handler(() =>
  fetchTataCampaignSetupOptions(),
);

// ─── Campaign creation ────────────────────────────────────────────────────

/** Default outcome codes seeded into a freshly-created disposition list, mirroring the
 * call-outcome model already used in call_logs (see CallOutcome in call-queue/types.ts). */
const DEFAULT_DISPOSITION_STATUSES = [
  { name: "Paid", code: "PAID" },
  { name: "Promised to Pay", code: "PROMISED" },
  { name: "Refused", code: "REFUSED" },
  { name: "No Answer", code: "NO_ANSWER" },
  { name: "Callback Requested", code: "CALLBACK" },
  { name: "Escalated", code: "ESCALATED" },
];

export interface CreateTataDialerCampaignInput {
  campaignName: string;
  description?: string;
  dialMethod: "1" | "2"; // 1 = Preview, 2 = Ratio
  autoDialDuration?: string; // seconds, used when dialMethod = "1"
  dialRatio?: string; // used when dialMethod = "2"
  numberOfRetry: string;
  retryAfterMinutes: string;
  ringTimeout: string;
  connectAgentThrough: "1" | "2" | "3"; // Mobile / Extension / Both
  callerIds: string[];
  agentIds: number[];
  dispositionListId?: string; // reuse an existing list
  newDispositionListName?: string; // or create one
  leads: TataLeadRow[];
}

export interface CreateTataDialerCampaignResult {
  ok: true;
  leadListId: string;
  leadsUploaded: number;
  leadsFailed: number;
  dispositionListId: string;
}

async function createLeadList(campaignName: string, leadCount: number): Promise<string> {
  // Timestamped so re-running the same campaign name doesn't collide when we re-list to find
  // the id back (findByName matches on exact name).
  const listName = `${campaignName} — ${new Date().toISOString()}`;
  await tataFetch("/broadcast/list", {
    method: "POST",
    body: JSON.stringify({
      name: listName,
      description: `SamvadX-generated lead list for campaign "${campaignName}" (${leadCount} leads).`,
      field: TATA_LEAD_FIELDS,
      enable_outbound_based_skill: "0",
    }),
  });

  const lists = await tataFetch<Array<{ id: number | string; name: string }>>(
    "/broadcast/lists",
  );
  return String(findByName(lists, listName).id);
}

async function uploadLeads(
  listId: string,
  leads: TataLeadRow[],
): Promise<{ uploaded: number; failed: number }> {
  let uploaded = 0;
  let failed = 0;
  // Batch size is a conservative guess — Tata's docs don't state a bulk-add limit.
  for (const batch of chunk(leads, 200)) {
    try {
      await tataFetch(`/broadcast/leads/${listId}`, {
        method: "POST",
        body: JSON.stringify({
          data: batch.map(toLeadFields),
          duplicate_option: "skip",
        }),
      });
      uploaded += batch.length;
    } catch (err) {
      failed += batch.length;
      console.error(
        `[tata-dialer] lead batch upload failed (${batch.length} leads):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { uploaded, failed };
}

async function resolveDispositionList(
  input: Pick<CreateTataDialerCampaignInput, "dispositionListId" | "newDispositionListName">,
): Promise<string> {
  if (input.dispositionListId) return input.dispositionListId;

  const name = input.newDispositionListName?.trim() || "SamvadX Collections";
  await tataFetch("/dialer/disposition_list", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: "Collections call outcomes, created from SamvadX.",
      status: true,
    }),
  });

  const raw = await tataFetch<
    Array<{ id: string; name: string }> | { data: Array<{ id: string; name: string }> }
  >("/dialer/disposition_list");
  const lists = Array.isArray(raw) ? raw : (raw.data ?? []);
  const id = findByName(lists, name).id;

  try {
    await tataFetch("/dialer/disposition_status/bulk", {
      method: "POST",
      body: JSON.stringify({ data: DEFAULT_DISPOSITION_STATUSES, dispositionList: id }),
    });
  } catch (err) {
    // Non-fatal — the disposition list still works without preset codes; agents can add
    // codes manually in the Smartflo dashboard.
    console.warn(
      "[tata-dialer] seeding default disposition statuses failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return id;
}

async function runCreateTataDialerCampaign(
  input: CreateTataDialerCampaignInput,
): Promise<CreateTataDialerCampaignResult> {
  requireApiKey();
  if (!input.leads.length) throw new Error("No leads to upload — the queue filter is empty.");
  if (!input.callerIds.length) throw new Error("Select at least one caller ID.");
  if (!input.agentIds.length) throw new Error("Select at least one agent.");

  console.log(
    `[tata-dialer] creating campaign "${input.campaignName}" with ${input.leads.length} leads`,
  );

  const leadListId = await createLeadList(input.campaignName, input.leads.length);
  const { uploaded, failed } = await uploadLeads(leadListId, input.leads);
  const dispositionListId = await resolveDispositionList(input);

  await tataFetch("/dialer/campaign", {
    method: "POST",
    body: JSON.stringify({
      name: input.campaignName,
      description: input.description ?? "",
      dial_method: input.dialMethod,
      auto_dial_duration: input.dialMethod === "1" ? input.autoDialDuration : undefined,
      dial_ratio: input.dialMethod === "2" ? input.dialRatio : undefined,
      outbound_caller_id: input.callerIds,
      lead_list_map: [{ list_id: leadListId, list_status: "1" }],
      list_traversal_order: "1",
      disposition_list: dispositionListId,
      number_of_retry: input.numberOfRetry,
      retry_after_minutes: input.retryAfterMinutes,
      auto_disposition_cancel_duration: "60",
      dial_status: ["0"],
      ring_timeout: input.ringTimeout,
      hide_lead_details: 0,
      update_lead_details: 1,
      dial_in_type: "2", // Dial Out Each Call — closest match to this app's per-call flow
      agent_only_callback: 0,
      agent: input.agentIds,
      enable_web_form: 0,
      connect_agent_through: input.connectAgentThrough,
    }),
  });

  return { ok: true, leadListId, leadsUploaded: uploaded, leadsFailed: failed, dispositionListId };
}

export const createTataDialerCampaign = createServerFn({ method: "POST" })
  .inputValidator((d: CreateTataDialerCampaignInput) => d)
  .handler(({ data }) => runCreateTataDialerCampaign(data));
