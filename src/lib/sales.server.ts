// Sales portal server actions (2026-11-27, phase 1): leads, contacts, timeline, tasks, Excel
// import, the sales team. Every table here is server-only (20261127_sales_portal.sql), so this
// file is the only way in. Every handler calls verifySalesCaller first: a salesperson
// (sales_users, active, signed in with the emailed code) or a superadmin. Who may see or change
// what is decided by the pure rules in src/lib/sales/sales-rules.ts.
//
// The new tables are not in database.types.ts yet, so they are read through an untyped client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, shortText, emailSchema } from "./schemas";
import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { tokenHasEmailOtp } from "./login-otp";
import {
  canAssign,
  canEditLead,
  canSeeLead,
  isSalesSource,
  isSalesStage,
  parseImportRows,
  phoneKey,
  stageLabel,
  type SalesCaller,
} from "./sales/sales-rules";

const db = () => getSupabaseAdmin() as unknown as SupabaseClient;

export interface VerifiedSalesCaller {
  rule: SalesCaller;
  name: string;
  email: string;
  /** sales_users.id for a salesperson, null for a superadmin. */
  salesUserId: string | null;
  superadminId: string | null;
}

/** A superadmin (full access) or an active salesperson who confirmed the emailed code. */
export async function verifySalesCaller(accessToken: string): Promise<VerifiedSalesCaller | null> {
  const sa = await verifySuperadminCaller(accessToken);
  if (sa) {
    return {
      rule: { kind: "superadmin" },
      name: sa.name,
      email: sa.email,
      salesUserId: null,
      superadminId: sa.superadminId,
    };
  }
  return verifySalespersonOnly(accessToken);
}

/** The salesperson half of verifySalesCaller (no superadmin check) — resolveSuperadmin uses it
 *  so a login resolves both in one round trip. */
export async function verifySalespersonOnly(
  accessToken: string,
): Promise<VerifiedSalesCaller | null> {
  const admin = db();
  const {
    data: { user },
    error,
  } = await admin.auth.getUser(accessToken);
  if (error || !user) return null;
  const { data } = await admin
    .from("sales_users")
    .select("id, name, email, is_active")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const row = data as { id: string; name: string; email: string; is_active: boolean } | null;
  if (!row || !row.is_active) return null;
  if (!tokenHasEmailOtp(accessToken)) return null;
  return {
    rule: { kind: "sales", salesUserId: row.id },
    name: row.name,
    email: row.email,
    salesUserId: row.id,
    superadminId: null,
  };
}

async function requireCaller(accessToken: string): Promise<VerifiedSalesCaller> {
  const caller = await verifySalesCaller(accessToken);
  if (!caller) throw new Error("Not allowed — sign in with a sales account.");
  return caller;
}

async function requireSuperadmin(accessToken: string) {
  const sa = await verifySuperadminCaller(accessToken);
  if (!sa) throw new Error("Only a superadmin can do this.");
  return sa;
}

// ─── Types sent to the browser ───────────────────────────────────────────────

export interface SalesLeadRow {
  id: string;
  company_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  source: string;
  stage: string;
  qualified: boolean;
  owner_id: string | null;
  agents_count: number | null;
  agents_band: string | null;
  accounts_count: number | null;
  lenders: string | null;
  deal_seats: number | null;
  deal_monthly: number | null;
  next_follow_up: string | null;
  lost_reason: string | null;
  notes: string | null;
  website_page: string | null;
  client_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  stage_changed_at: string;
}

const LEAD_COLUMNS =
  "id, company_name, contact_name, phone, email, city, state, source, stage, qualified, owner_id, agents_count, agents_band, accounts_count, lenders, deal_seats, deal_monthly, next_follow_up, lost_reason, notes, website_page, client_id, created_by_name, created_at, updated_at, stage_changed_at";

export interface SalesPerson {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
}

export interface SalesTaskRow {
  id: string;
  lead_id: string;
  title: string;
  due_date: string;
  assigned_to: string | null;
  done_at: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface SalesActivityRow {
  id: string;
  kind: string;
  body: string | null;
  actor_name: string | null;
  occurred_at: string;
}

export interface SalesContactRow {
  id: string;
  name: string;
  designation: string | null;
  phone: string | null;
  email: string | null;
}

function normaliseLead(r: Record<string, unknown>): SalesLeadRow {
  return {
    ...(r as unknown as SalesLeadRow),
    deal_monthly: r.deal_monthly == null ? null : Number(r.deal_monthly),
  };
}

async function loadLead(id: string): Promise<SalesLeadRow | null> {
  const { data, error } = await db().from("sales_leads").select(LEAD_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normaliseLead(data as Record<string, unknown>) : null;
}

async function logActivity(
  leadId: string,
  kind: string,
  body: string | null,
  actorName: string | null,
  occurredAt?: string,
) {
  const { error } = await db()
    .from("sales_activities")
    .insert({
      lead_id: leadId,
      kind,
      body,
      actor_name: actorName,
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
    });
  if (error) console.error("[sales] could not log activity:", error.message);
}

async function salesPeople(): Promise<SalesPerson[]> {
  const { data, error } = await db()
    .from("sales_users")
    .select("id, name, email, phone, is_active")
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as SalesPerson[];
}

// ─── Activity log helper ────────────────────────────────────────────────────

export async function logSalesActivity(entry: {
  actorName: string | null;
  salesUserId?: string | null;
  superadminId?: string | null;
  action: string;
  leadId?: string | null;
  summary: string;
  detail?: Record<string, unknown> | null;
}) {
  const { error } = await db().from("sales_activity_log").insert({
    sales_user_id: entry.salesUserId ?? null,
    superadmin_id: entry.superadminId ?? null,
    actor_name: entry.actorName,
    action: entry.action,
    lead_id: entry.leadId ?? null,
    summary: entry.summary,
    detail: entry.detail ?? null,
  });
  if (error) console.error(`[sales] activity log "${entry.action}" failed:`, error.message);
}

function actorIds(caller: VerifiedSalesCaller) {
  return { salesUserId: caller.salesUserId, superadminId: caller.superadminId };
}

// ─── Who am I ────────────────────────────────────────────────────────────────

/** Called by auth.tsx for any signed-in user: returns the salesperson, or null. */
export const resolveSalesUser = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await verifySalesCaller(data.accessToken);
    if (!caller || caller.rule.kind !== "sales") return { sales: null };
    return { sales: { id: caller.salesUserId!, name: caller.name, email: caller.email } };
  });

// ─── Leads ───────────────────────────────────────────────────────────────────

export const listLeads = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    let q = db().from("sales_leads").select(LEAD_COLUMNS).order("updated_at", { ascending: false }).limit(5000);
    if (caller.rule.kind === "sales") {
      q = q.or(`owner_id.is.null,owner_id.eq.${caller.salesUserId}`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const leads = (rows ?? []).map((r) => normaliseLead(r as Record<string, unknown>));

    const ids = leads.map((l) => l.id);
    let tasks: SalesTaskRow[] = [];
    if (ids.length) {
      const { data: t, error: tErr } = await db()
        .from("sales_tasks")
        .select("id, lead_id, title, due_date, assigned_to, done_at, created_by_name, created_at")
        .is("done_at", null)
        .order("due_date");
      if (tErr) throw new Error(tErr.message);
      const visible = new Set(ids);
      tasks = ((t ?? []) as SalesTaskRow[]).filter((x) => visible.has(x.lead_id));
    }
    return {
      leads,
      tasks,
      people: await salesPeople(),
      me: { kind: caller.rule.kind, salesUserId: caller.salesUserId, name: caller.name },
    };
  });

export const getLead = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const lead = await loadLead(data.id);
    if (!lead || !canSeeLead(caller.rule, lead)) throw new Error("Lead not found.");
    const [contacts, activities, tasks] = await Promise.all([
      db().from("sales_contacts").select("id, name, designation, phone, email").eq("lead_id", lead.id).order("created_at"),
      db()
        .from("sales_activities")
        .select("id, kind, body, actor_name, occurred_at")
        .eq("lead_id", lead.id)
        .order("occurred_at", { ascending: false })
        .limit(500),
      db()
        .from("sales_tasks")
        .select("id, lead_id, title, due_date, assigned_to, done_at, created_by_name, created_at")
        .eq("lead_id", lead.id)
        .order("due_date"),
    ]);
    for (const r of [contacts, activities, tasks]) if (r.error) throw new Error(r.error.message);
    return {
      lead,
      contacts: (contacts.data ?? []) as SalesContactRow[],
      activities: (activities.data ?? []) as SalesActivityRow[],
      tasks: (tasks.data ?? []) as SalesTaskRow[],
      people: await salesPeople(),
      canEdit: canEditLead(caller.rule, lead),
      me: { kind: caller.rule.kind, salesUserId: caller.salesUserId, name: caller.name },
    };
  });

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const optInt = z.number().int().min(0).max(10_000_000).nullish().transform((v) => v ?? null);
const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .transform((v) => v ?? null);

const leadFields = z.object({
  company_name: shortText(200),
  contact_name: optText(120),
  phone: optText(20),
  email: optText(254),
  city: optText(80),
  state: optText(80),
  source: z.string().refine(isSalesSource).optional(),
  qualified: z.boolean().optional(),
  agents_count: optInt,
  agents_band: optText(40),
  accounts_count: optInt,
  lenders: optText(300),
  deal_seats: optInt,
  deal_monthly: z.number().min(0).max(1e10).nullish().transform((v) => v ?? null),
  next_follow_up: dateKey,
  notes: optText(4000),
});

export const createLead = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        lead: leadFields,
        /** Create even though a lead with this phone exists. */
        allowDuplicate: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const key = phoneKey(data.lead.phone);
    if (key && !data.allowDuplicate) {
      const { data: dup } = await db()
        .from("sales_leads")
        .select("id, company_name, owner_id")
        .eq("phone_key", key)
        .limit(1);
      const hit = (dup ?? [])[0] as { id: string; company_name: string; owner_id: string | null } | undefined;
      if (hit) {
        return {
          ok: false as const,
          duplicate: {
            id: canSeeLead(caller.rule, hit) ? hit.id : null,
            company: hit.company_name,
          },
        };
      }
    }
    const { data: row, error } = await db()
      .from("sales_leads")
      .insert({
        ...data.lead,
        source: data.lead.source ?? "manual",
        phone_key: key,
        owner_id: caller.salesUserId,
        created_by_name: caller.name,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await logActivity(id, "created", "Lead added", caller.name);
    return { ok: true as const, id };
  });

export const updateLead = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        id: idSchema,
        patch: leadFields.partial().extend({
          stage: z.string().refine(isSalesStage).optional(),
          lost_reason: optText(500),
        }),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const lead = await loadLead(data.id);
    if (!lead || !canSeeLead(caller.rule, lead)) throw new Error("Lead not found.");
    if (!canEditLead(caller.rule, lead)) {
      throw new Error("Take this lead first — only its owner can change it.");
    }
    const patch: Record<string, unknown> = { ...data.patch, updated_at: new Date().toISOString() };
    if ("phone" in data.patch) patch.phone_key = phoneKey(data.patch.phone);
    const stage = data.patch.stage;
    const stageChanged = stage && stage !== lead.stage;
    if (stageChanged) {
      if (stage === "lost" && !(data.patch.lost_reason ?? lead.lost_reason)) {
        throw new Error("Say why the lead was lost.");
      }
      patch.stage_changed_at = new Date().toISOString();
      if (stage !== "lost") patch.lost_reason = null;
    }
    const { error } = await db().from("sales_leads").update(patch).eq("id", lead.id);
    if (error) throw new Error(error.message);
    if (stageChanged) {
      const why = stage === "lost" ? ` — ${data.patch.lost_reason ?? lead.lost_reason}` : "";
      await logActivity(
        lead.id,
        "stage",
        `${stageLabel(lead.stage)} → ${stageLabel(stage!)}${why}`,
        caller.name,
      );
    }
    return { ok: true as const };
  });

export const assignLead = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, id: idSchema, ownerId: idSchema.nullable() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const lead = await loadLead(data.id);
    if (!lead || !canSeeLead(caller.rule, lead)) throw new Error("Lead not found.");
    if (!canAssign(caller.rule, lead, data.ownerId)) throw new Error("You can't assign this lead.");
    const people = await salesPeople();
    const newOwner = data.ownerId ? people.find((p) => p.id === data.ownerId) : null;
    if (data.ownerId && (!newOwner || !newOwner.is_active)) {
      throw new Error("Pick an active salesperson.");
    }
    const { error } = await db()
      .from("sales_leads")
      .update({ owner_id: data.ownerId, updated_at: new Date().toISOString() })
      .eq("id", lead.id);
    if (error) throw new Error(error.message);
    await logActivity(
      lead.id,
      "assigned",
      newOwner ? `Assigned to ${newOwner.name}` : "Put back in the unassigned pool",
      caller.name,
    );
    return { ok: true as const };
  });

export const deleteLead = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, id: idSchema }).parse(d))
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const { error } = await db().from("sales_leads").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ─── Timeline, contacts, tasks ──────────────────────────────────────────────

async function editableLead(accessToken: string, leadId: string) {
  const caller = await requireCaller(accessToken);
  const lead = await loadLead(leadId);
  if (!lead || !canSeeLead(caller.rule, lead)) throw new Error("Lead not found.");
  if (!canEditLead(caller.rule, lead)) throw new Error("Take this lead first — only its owner can change it.");
  return { caller, lead };
}

async function touch(leadId: string) {
  await db().from("sales_leads").update({ updated_at: new Date().toISOString() }).eq("id", leadId);
}

export const addLeadActivity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        leadId: idSchema,
        kind: z.enum(["note", "call", "email", "meeting"]),
        body: shortText(4000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { caller, lead } = await editableLead(data.accessToken, data.leadId);
    await logActivity(lead.id, data.kind, data.body, caller.name);
    await touch(lead.id);
    return { ok: true as const };
  });

export const addContact = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        leadId: idSchema,
        name: shortText(120),
        designation: optText(120),
        phone: optText(20),
        email: optText(254),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { caller, lead } = await editableLead(data.accessToken, data.leadId);
    const { error } = await db().from("sales_contacts").insert({
      lead_id: lead.id,
      name: data.name,
      designation: data.designation,
      phone: data.phone,
      email: data.email,
    });
    if (error) throw new Error(error.message);
    await logActivity(lead.id, "updated", `Contact added: ${data.name}`, caller.name);
    return { ok: true as const };
  });

export const removeContact = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, leadId: idSchema, contactId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const { lead } = await editableLead(data.accessToken, data.leadId);
    const { error } = await db()
      .from("sales_contacts")
      .delete()
      .eq("id", data.contactId)
      .eq("lead_id", lead.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const addTask = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        leadId: idSchema,
        title: shortText(300),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { caller, lead } = await editableLead(data.accessToken, data.leadId);
    const { error } = await db().from("sales_tasks").insert({
      lead_id: lead.id,
      title: data.title,
      due_date: data.dueDate,
      assigned_to: lead.owner_id ?? caller.salesUserId,
      created_by_name: caller.name,
    });
    if (error) throw new Error(error.message);
    // The earliest open task is the lead's next follow-up.
    if (!lead.next_follow_up || data.dueDate < lead.next_follow_up) {
      await db().from("sales_leads").update({ next_follow_up: data.dueDate }).eq("id", lead.id);
    }
    await touch(lead.id);
    return { ok: true as const };
  });

export const completeTask = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({ accessToken: tokenSchema, leadId: idSchema, taskId: idSchema, done: z.boolean() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { caller, lead } = await editableLead(data.accessToken, data.leadId);
    const { data: row, error } = await db()
      .from("sales_tasks")
      .update({ done_at: data.done ? new Date().toISOString() : null })
      .eq("id", data.taskId)
      .eq("lead_id", lead.id)
      .select("title")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data.done && row) {
      await logActivity(lead.id, "task_done", `Done: ${(row as { title: string }).title}`, caller.name);
    }
    // Next follow-up = the earliest task still open.
    const { data: open } = await db()
      .from("sales_tasks")
      .select("due_date")
      .eq("lead_id", lead.id)
      .is("done_at", null)
      .order("due_date")
      .limit(1);
    const next = ((open ?? [])[0] as { due_date: string } | undefined)?.due_date ?? null;
    await db()
      .from("sales_leads")
      .update({ next_follow_up: next, updated_at: new Date().toISOString() })
      .eq("id", lead.id);
    return { ok: true as const };
  });

// ─── Excel import ────────────────────────────────────────────────────────────

export const importLeads = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        rows: z.array(z.record(z.string().max(200), z.unknown())).max(5000),
        source: z.string().refine(isSalesSource).optional(),
        /** Leave the imported leads unassigned instead of giving them to the importer. */
        unassigned: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const parsed = parseImportRows(data.rows);

    // Skip phones that are already leads.
    const keys = parsed.leads.map((l) => phoneKey(l.phone)).filter((k): k is string => !!k);
    const existing = new Set<string>();
    for (let i = 0; i < keys.length; i += 500) {
      const { data: hits, error } = await db()
        .from("sales_leads")
        .select("phone_key")
        .in("phone_key", keys.slice(i, i + 500));
      if (error) throw new Error(error.message);
      for (const h of (hits ?? []) as { phone_key: string }[]) existing.add(h.phone_key);
    }

    const skipped = [...parsed.skipped];
    const toInsert = parsed.leads.filter((l, i) => {
      const k = phoneKey(l.phone);
      if (k && existing.has(k)) {
        skipped.push({ row: i + 1, reason: "Already a lead" });
        return false;
      }
      return true;
    });

    const source = data.source ?? "import";
    const owner = data.unassigned ? null : caller.salesUserId;
    let created = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200);
      const { data: rows, error } = await db()
        .from("sales_leads")
        .insert(
          chunk.map((l) => ({
            company_name: l.company_name,
            contact_name: l.contact_name,
            phone: l.phone,
            phone_key: phoneKey(l.phone),
            email: l.email,
            city: l.city,
            agents_band: l.agents_band,
            notes: l.notes,
            source,
            owner_id: owner,
            created_by_name: caller.name,
            ...(l.received_at ? { created_at: l.received_at } : {}),
          })),
        )
        .select("id, created_at");
      if (error) throw new Error(error.message);
      const inserted = (rows ?? []) as { id: string; created_at: string }[];
      created += inserted.length;
      await db()
        .from("sales_activities")
        .insert(
          inserted.map((r) => ({
            lead_id: r.id,
            kind: "import",
            body: "Imported from a spreadsheet",
            actor_name: caller.name,
            occurred_at: r.created_at,
          })),
        );
    }
    skipped.sort((a, b) => a.row - b.row);
    return { created, skipped };
  });

// ─── Sales team (superadmin only) ───────────────────────────────────────────

export const listSalesTeam = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    return { people: await salesPeople() };
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createSalesUser = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema.optional(),
        name: shortText(120),
        email: emailSchema,
        phone: optText(20),
        password: z.string().min(8).max(256),
        bootstrapSecret: z.string().max(256).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Bootstrap: when nobody is in sales_users yet, allow setup with SALES_BOOTSTRAP_SECRET
    // (same discipline as createSuperadmin). Once there is one, a superadmin must sign in to
    // create another, like /sales/team already does.
    const admin = db();
    const { count: existingCount, error: countErr } = await admin
      .from("sales_users")
      .select("id", { count: "exact", head: true });
    if (countErr) return { ok: false as const, error: `Could not verify setup state (${countErr.message})` };

    let superadminId: string | null = null;
    if ((existingCount ?? 0) > 0) {
      const sa = data.accessToken ? await verifySuperadminCaller(data.accessToken) : null;
      if (!sa) {
        return {
          ok: false as const,
          error: "A sales account already exists — sign in as a superadmin to create another.",
        };
      }
      superadminId = sa.superadminId;
    } else {
      const expected = process.env.SALES_BOOTSTRAP_SECRET?.trim();
      const given = data.bootstrapSecret?.trim() ?? "";
      const a = Buffer.from(given);
      const b = Buffer.from(expected ?? "");
      if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
        return {
          ok: false as const,
          error:
            "Creating the first salesperson needs the setup key from the server's SALES_BOOTSTRAP_SECRET.",
        };
      }
    }
    const email = data.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return { ok: false as const, error: "Enter a valid email address." };
    // A separate login on purpose: a company user or superadmin must not quietly become sales.
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: true,
    });
    if (authErr || !authData.user) {
      const msg = authErr?.message ?? "";
      return {
        ok: false as const,
        error: /already.*registered|already exists/i.test(msg)
          ? "That email already has a SamvadX login. Use a different email for the sales account."
          : msg || "Could not create the login.",
      };
    }
    const { error } = await admin.from("sales_users").insert({
      auth_user_id: authData.user.id,
      name: data.name,
      email,
      phone: data.phone,
      created_by: superadminId,
    });
    if (error) {
      await admin.auth.admin.deleteUser(authData.user.id).catch(() => {});
      return { ok: false as const, error: error.message };
    }
    await logSalesActivity({
      actorName: superadminId ? "A superadmin" : "Bootstrap setup",
      superadminId,
      action: "sales_user_created",
      summary: `Added salesperson ${data.name} (${email})`,
    });
    return { ok: true as const };
  });

export const setSalesUserActive = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, id: idSchema, active: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const sa = await requireSuperadmin(data.accessToken);
    const admin = db();
    const { data: row, error } = await admin
      .from("sales_users")
      .update({ is_active: data.active })
      .eq("id", data.id)
      .select("auth_user_id, name")
      .single();
    if (error) throw new Error(error.message);
    const authId = (row as { auth_user_id: string; name: string }).auth_user_id;
    // Same as deactivating a company user: the login is banned, not just hidden.
    await admin.auth.admin.updateUserById(authId, {
      ban_duration: data.active ? "none" : "876000h",
    });
    if (!data.active) {
      // Their open leads go back to the pool so nothing is stranded.
      // (verifySalesCaller already refuses an inactive account on its next request.)
      await admin.from("sales_leads").update({ owner_id: null }).eq("owner_id", data.id);
    }
    await logSalesActivity({
      actorName: sa.name,
      superadminId: sa.superadminId,
      action: data.active ? "sales_user_active" : "sales_user_inactive",
      summary: `${data.active ? "Reactivated" : "Deactivated"} ${(row as { name: string }).name}`,
    });
    return { ok: true as const };
  });

// ─── Activity log view + email the lead ────────────────────────────────────

export interface SalesActivityLogRow {
  id: string;
  created_at: string;
  action: string;
  summary: string;
  actor_name: string | null;
  sales_user_id: string | null;
  lead_id: string | null;
}

export const listSalesActivity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        actorId: idSchema.nullable().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    let q = db()
      .from("sales_activity_log")
      .select("id, created_at, action, summary, actor_name, sales_user_id, lead_id")
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 200);
    if (data.actorId) q = q.eq("sales_user_id", data.actorId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as SalesActivityLogRow[] };
  });

export const sendLeadEmail = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        leadId: idSchema,
        to: emailSchema,
        subject: shortText(200),
        body: shortText(10000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { caller, lead } = await editableLead(data.accessToken, data.leadId);
    const { sendEmails, emailConfigured } = await import("./email.server");
    if (!emailConfigured()) {
      return {
        ok: false as const,
        error: "Email is not set up yet (RESEND_API_KEY / EMAIL_FROM).",
      };
    }
    const sent = await sendEmails([
      {
        to: data.to,
        subject: data.subject,
        text: `${data.body}\n\n— ${caller.name}, SamvadX Sales\nsales@samvadx.com`,
      },
    ]);
    const summary = `Emailed ${data.to}: ${data.subject}`;
    await logActivity(lead.id, "email", summary, caller.name);
    await db()
      .from("sales_leads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", lead.id);
    await logSalesActivity({
      actorName: caller.name,
      ...actorIds(caller),
      action: "lead_email",
      leadId: lead.id,
      summary: `${lead.company_name}: ${summary}`,
    });
    const okFlag = (sent ?? 0) > 0;
    return okFlag
      ? { ok: true as const, sentCount: sent ?? 0 }
      : { ok: false as const, error: "Email provider did not accept the message." };
  });
