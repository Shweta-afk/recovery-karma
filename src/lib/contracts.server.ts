// Contracts server actions — superadmin side (upload documents, publish/withdraw changes, see who
// accepted) and company-admin side (read own company's contracts, accept changes). Tables are
// server-only (migrations/20261009_contracts.sql), so everything goes through the service role
// after verifySuperadminCaller / verifyCaller. Pure rules live in contracts.ts.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { isDayKey } from "./superadmin-range";
import { emailConfigured, sendEmails } from "./email.server";
import {
  CONTRACTS_VISIBLE_TO_COMPANIES,
  changeAppliesTo,
  changeEmail,
  isPendingFor,
  type ContractAcceptance,
  type ContractChange,
  type ContractDocument,
} from "./contracts";

export const CONTRACTS_BUCKET = "contracts";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const DOWNLOAD_LINK_SECONDS = 300;

const db = () => getSupabaseAdmin();
/** The contract_* tables aren't in the generated Database types until they are regenerated after
 *  migrations/20261009_contracts.sql — read and write them through an untyped client meanwhile. */
const contractsDb = () => getSupabaseAdmin() as unknown as SupabaseClient;
const daySchema = z.string().refine(isDayKey, "Expected a date (YYYY-MM-DD)");

// ── Row mapping ─────────────────────────────────────────────────────────────

interface DocumentRow {
  id: string;
  client_id: string | null;
  title: string;
  version_label: string | null;
  effective_date: string;
  file_path: string;
  file_name: string;
  file_size: number | null;
  notes: string | null;
  created_at: string;
}
interface ChangeRow {
  id: string;
  title: string;
  body: string;
  effective_date: string;
  client_ids: string[] | null;
  requires_acceptance: boolean;
  document_id: string | null;
  created_at: string;
  withdrawn_at: string | null;
}
interface AcceptanceRow {
  change_id: string;
  client_id: string;
  accepted_name: string;
  accepted_email: string;
  accepted_at: string;
}

const DOC_COLUMNS =
  "id, client_id, title, version_label, effective_date, file_path, file_name, file_size, notes, created_at";
const CHANGE_COLUMNS =
  "id, title, body, effective_date, client_ids, requires_acceptance, document_id, created_at, withdrawn_at";

const toDocument = (r: DocumentRow, companyName: string | null): ContractDocument => ({
  id: r.id,
  clientId: r.client_id,
  companyName,
  title: r.title,
  versionLabel: r.version_label,
  effectiveDate: r.effective_date,
  fileName: r.file_name,
  fileSize: r.file_size === null ? null : Number(r.file_size),
  notes: r.notes,
  createdAt: r.created_at,
});
const toChange = (r: ChangeRow): ContractChange => ({
  id: r.id,
  title: r.title,
  body: r.body,
  effectiveDate: r.effective_date,
  clientIds: r.client_ids,
  requiresAcceptance: r.requires_acceptance,
  documentId: r.document_id,
  createdAt: r.created_at,
  withdrawnAt: r.withdrawn_at,
});
const toAcceptance = (r: AcceptanceRow): ContractAcceptance => ({
  clientId: r.client_id,
  acceptedName: r.accepted_name,
  acceptedEmail: r.accepted_email,
  acceptedAt: r.accepted_at,
});

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

/** Company admins only (verifyCaller already requires the emailed sign-in code for admins). */
async function requireCompanyAdmin(accessToken: string) {
  // Superadmin-only for now — see CONTRACTS_VISIBLE_TO_COMPANIES.
  if (!CONTRACTS_VISIBLE_TO_COMPANIES) throw new Error("Contracts aren't available yet");
  const caller = await verifyCaller(accessToken);
  if (!caller || caller.role !== "admin") throw new Error("Only company admins can do this");
  return caller;
}

async function ensureBucket(): Promise<void> {
  const storage = db().storage;
  const { data } = await storage.getBucket(CONTRACTS_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(CONTRACTS_BUCKET, {
    public: false,
    allowedMimeTypes: Object.values(FILE_TYPES),
    fileSizeLimit: "20MB",
  });
  // A concurrent upload may have just created it — only a genuine failure matters.
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`Could not create the contracts storage bucket: ${error.message}`);
  }
}

/** Active admins of these companies — who gets notified about a change. */
async function adminsOf(clientIds: string[] | null) {
  let q = db().from("agents").select("id, client_id, name, email, is_active").eq("role", "admin");
  if (clientIds) q = q.in("client_id", clientIds);
  const { data, error } = await q;
  if (error) throw new Error(`Could not load company admins (${error.message})`);
  return (
    (data ?? []) as {
      id: string;
      client_id: string | null;
      name: string;
      email: string;
      is_active: boolean | null;
    }[]
  ).filter((a) => a.client_id && a.is_active !== false);
}

// ── Superadmin ──────────────────────────────────────────────────────────────

export interface SuperadminContractChange extends ContractChange {
  /** One row per company the change applies to (approved companies only). */
  companies: {
    clientId: string;
    companyName: string;
    acceptance: ContractAcceptance | null;
    adminEmails: string[];
  }[];
}

export interface SuperadminContractsView {
  /** CONTRACTS_VISIBLE_TO_COMPANIES — the page explains what that means. */
  companiesCanSee: boolean;
  /** Whether Resend is configured (RESEND_API_KEY + EMAIL_FROM on the server). */
  emailConfigured: boolean;
  companies: { id: string; name: string; adminEmails: string[] }[];
  documents: ContractDocument[];
  changes: SuperadminContractChange[];
}

export const getSuperadminContracts = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<SuperadminContractsView> => {
    await requireSuperadmin(data.accessToken);
    const admin = db();
    const [clientsRes, docsRes, changesRes, accRes, admins] = await Promise.all([
      admin.from("clients").select("id, company_name, status").order("company_name"),
      contractsDb()
        .from("contract_documents")
        .select(DOC_COLUMNS)
        .order("effective_date", { ascending: false })
        .order("created_at", { ascending: false }),
      contractsDb()
        .from("contract_changes")
        .select(CHANGE_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(500),
      contractsDb()
        .from("contract_acceptances")
        .select("change_id, client_id, accepted_name, accepted_email, accepted_at"),
      adminsOf(null),
    ]);
    for (const r of [clientsRes, docsRes, changesRes, accRes]) {
      if (r.error) throw new Error(`Could not load contracts (${r.error.message})`);
    }
    const clients = (clientsRes.data ?? []) as {
      id: string;
      company_name: string;
      status: string;
    }[];
    const live = clients.filter((c) => c.status === "approved");
    const nameById = new Map(clients.map((c) => [c.id, c.company_name]));
    const emailsByClient = new Map<string, string[]>();
    for (const a of admins) {
      const list = emailsByClient.get(a.client_id!) ?? [];
      list.push(a.email);
      emailsByClient.set(a.client_id!, list);
    }
    const accByKey = new Map(
      ((accRes.data ?? []) as AcceptanceRow[]).map((r) => [
        `${r.change_id}|${r.client_id}`,
        toAcceptance(r),
      ]),
    );

    return {
      companiesCanSee: CONTRACTS_VISIBLE_TO_COMPANIES,
      emailConfigured: emailConfigured(),
      companies: live.map((c) => ({
        id: c.id,
        name: c.company_name,
        adminEmails: emailsByClient.get(c.id) ?? [],
      })),
      documents: ((docsRes.data ?? []) as DocumentRow[]).map((r) =>
        toDocument(r, r.client_id ? (nameById.get(r.client_id) ?? null) : null),
      ),
      changes: ((changesRes.data ?? []) as ChangeRow[]).map((r) => {
        const change = toChange(r);
        return {
          ...change,
          companies: live
            .filter((c) => changeAppliesTo(change, c.id))
            .map((c) => ({
              clientId: c.id,
              companyName: c.company_name,
              acceptance: accByKey.get(`${change.id}|${c.id}`) ?? null,
              adminEmails: emailsByClient.get(c.id) ?? [],
            })),
        };
      }),
    };
  });

/** Step 1 of an upload: a one-time signed URL the browser uploads the file to directly, so the
 *  file never passes through this server. Step 2 is saveContractDocument. */
export const createContractUpload = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.nullable(),
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const ext = data.fileName.split(".").pop()?.toLowerCase() ?? "";
    if (!FILE_TYPES[ext]) throw new Error("Upload a PDF or Word (.docx) file");
    if (data.fileSize > MAX_FILE_BYTES) throw new Error("The file is larger than 20 MB");
    await ensureBucket();
    const path = `${data.clientId ?? "platform"}/${randomUUID()}.${ext}`;
    const { data: signed, error } = await db()
      .storage.from(CONTRACTS_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !signed) throw new Error(`Could not start the upload (${error?.message})`);
    return { bucket: CONTRACTS_BUCKET, path, token: signed.token, contentType: FILE_TYPES[ext] };
  });

export const saveContractDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.nullable(),
        title: z.string().trim().min(1).max(200),
        versionLabel: z.string().trim().max(40).optional(),
        effectiveDate: daySchema,
        path: z.string().max(300),
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive(),
        notes: z.string().trim().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    // The path must be one createContractUpload could have issued for this company.
    const folder = data.clientId ?? "platform";
    const [prefix, objectName] = data.path.split("/");
    if (prefix !== folder || !objectName || data.path.split("/").length !== 2) {
      throw new Error("That upload doesn't belong to this contract");
    }
    const { data: listed, error: listErr } = await db()
      .storage.from(CONTRACTS_BUCKET)
      .list(folder, { search: objectName, limit: 1 });
    if (listErr || !listed?.some((o) => o.name === objectName)) {
      throw new Error("The file didn't finish uploading — try again");
    }
    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .insert({
        client_id: data.clientId,
        title: data.title,
        version_label: data.versionLabel || null,
        effective_date: data.effectiveDate,
        file_path: data.path,
        file_name: data.fileName,
        file_size: data.fileSize,
        notes: data.notes || null,
        created_by: caller.superadminId,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(`Could not save the contract (${error?.message})`);

    let companyName: string | null = null;
    if (data.clientId) {
      const { data: c } = await db()
        .from("clients")
        .select("company_name")
        .eq("id", data.clientId)
        .maybeSingle();
      companyName = (c as { company_name: string } | null)?.company_name ?? null;
    }
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_uploaded",
      clientId: data.clientId,
      summary: data.clientId
        ? `Uploaded "${data.title}" for ${companyName ?? "a company"}`
        : `Uploaded SamvadX platform terms "${data.title}"`,
      detail: { documentId: (row as { id: string }).id, effectiveDate: data.effectiveDate },
    });
    return { id: (row as { id: string }).id };
  });

export const publishContractChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5000),
        effectiveDate: daySchema,
        /** null = every company. */
        clientIds: z.array(idSchema).min(1).max(500).nullable(),
        requiresAcceptance: z.boolean(),
        documentId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const admin = db();
    const clientIds = data.clientIds ? [...new Set(data.clientIds)] : null;

    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .insert({
        title: data.title,
        body: data.body,
        effective_date: data.effectiveDate,
        client_ids: clientIds,
        requires_acceptance: data.requiresAcceptance,
        document_id: data.documentId ?? null,
        created_by: caller.superadminId,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(`Could not publish the change (${error?.message})`);

    // Tell every active admin of the companies it applies to — in the app (the bell) and by
    // email when Resend is set up. Nobody is told while contracts are superadmin-only.
    const admins = CONTRACTS_VISIBLE_TO_COMPANIES ? await adminsOf(clientIds) : [];
    let emailed: number | null = null;
    if (admins.length) {
      const message = data.requiresAcceptance
        ? `Contract update: "${data.title}" (effective ${data.effectiveDate}). Please review and accept it under Contracts.`
        : `Contract update: "${data.title}" (effective ${data.effectiveDate}). See Contracts for details.`;
      const { error: nErr } = await admin.from("notifications").insert(
        admins.map((a) => ({
          client_id: a.client_id,
          to_agent_id: a.id,
          from_name: "SamvadX",
          message,
        })),
      );
      // The change itself is published; a failed notification or email must not undo it.
      if (nErr) console.error("[publishContractChange] notifications failed:", nErr);
      const { subject, text } = changeEmail(data);
      emailed = await sendEmails(admins.map((a) => ({ to: a.email, subject, text })));
    }

    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_change_published",
      clientId: clientIds?.length === 1 ? clientIds[0] : null,
      summary: `Published contract change "${data.title}" to ${clientIds ? `${clientIds.length} compan${clientIds.length === 1 ? "y" : "ies"}` : "every company"}`,
      detail: {
        changeId: (row as { id: string }).id,
        requiresAcceptance: data.requiresAcceptance,
        notifiedAdmins: admins.length,
        emailedAdmins: emailed ?? 0,
      },
    });
    return {
      id: (row as { id: string }).id,
      /** False while contracts are superadmin-only: nobody was notified or emailed. */
      companiesCanSee: CONTRACTS_VISIBLE_TO_COMPANIES,
      notifiedAdmins: admins.length,
      /** Emails Resend accepted; null when email isn't set up (use the mailto fallback). */
      emailedAdmins: emailed,
      adminEmails: admins.map((a) => a.email),
    };
  });

export const withdrawContractChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, changeId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .update({ withdrawn_at: new Date().toISOString(), withdrawn_by: caller.superadminId })
      .eq("id", data.changeId)
      .is("withdrawn_at", null)
      .select("title")
      .maybeSingle();
    if (error) throw new Error(`Could not withdraw the change (${error.message})`);
    if (!row) throw new Error("That change was already withdrawn");
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_change_withdrawn",
      summary: `Withdrew contract change "${(row as { title: string }).title}"`,
      detail: { changeId: data.changeId },
    });
    return { ok: true };
  });

// ── Company admin ───────────────────────────────────────────────────────────

export interface AdminContractChange extends ContractChange {
  acceptance: ContractAcceptance | null;
  pending: boolean;
}

export interface AdminContractsView {
  companyName: string;
  platformDocuments: ContractDocument[];
  companyDocuments: ContractDocument[];
  changes: AdminContractChange[];
  pendingCount: number;
}

async function loadAdminView(clientId: string): Promise<AdminContractsView> {
  const admin = db();
  const [clientRes, docsRes, changesRes, accRes] = await Promise.all([
    admin.from("clients").select("company_name").eq("id", clientId).maybeSingle(),
    contractsDb()
      .from("contract_documents")
      .select(DOC_COLUMNS)
      .or(`client_id.is.null,client_id.eq.${clientId}`)
      .order("effective_date", { ascending: false })
      .order("created_at", { ascending: false }),
    contractsDb()
      .from("contract_changes")
      .select(CHANGE_COLUMNS)
      .or(`client_ids.is.null,client_ids.cs.{${clientId}}`)
      .order("created_at", { ascending: false })
      .limit(500),
    contractsDb()
      .from("contract_acceptances")
      .select("change_id, client_id, accepted_name, accepted_email, accepted_at")
      .eq("client_id", clientId),
  ]);
  for (const r of [docsRes, changesRes, accRes]) {
    if (r.error) throw new Error(`Could not load contracts (${r.error.message})`);
  }
  const companyName =
    (clientRes.data as { company_name: string } | null)?.company_name ?? "Your company";
  const docs = ((docsRes.data ?? []) as DocumentRow[]).map((r) =>
    toDocument(r, r.client_id ? companyName : null),
  );
  const accByChange = new Map(
    ((accRes.data ?? []) as AcceptanceRow[]).map((r) => [r.change_id, toAcceptance(r)]),
  );
  const changes = ((changesRes.data ?? []) as ChangeRow[])
    .map(toChange)
    // Belt and braces over the SQL filter: never show another company's change.
    .filter((c) => changeAppliesTo(c, clientId))
    .map((c) => {
      const acceptance = accByChange.get(c.id) ?? null;
      return { ...c, acceptance, pending: isPendingFor(c, clientId, acceptance ?? undefined) };
    });
  return {
    companyName,
    platformDocuments: docs.filter((d) => d.clientId === null),
    companyDocuments: docs.filter((d) => d.clientId === clientId),
    changes,
    pendingCount: changes.filter((c) => c.pending).length,
  };
}

export const getMyContracts = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<AdminContractsView> => {
    const caller = await requireCompanyAdmin(data.accessToken);
    return loadAdminView(caller.clientId);
  });

/** Just the number of changes waiting for acceptance — the admin-wide banner. */
export const getMyPendingContractCount = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const view = await loadAdminView(caller.clientId);
    return { pending: view.pendingCount };
  });

export const acceptContractChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        changeId: idSchema,
        /** The admin types their name as their acceptance. */
        fullName: z.string().trim().min(2).max(200),
        confirm: z.literal(true),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const admin = db();
    const [{ data: changeRow, error }, { data: me }] = await Promise.all([
      contractsDb()
        .from("contract_changes")
        .select(CHANGE_COLUMNS)
        .eq("id", data.changeId)
        .maybeSingle(),
      admin.from("agents").select("email").eq("id", caller.agentId!).maybeSingle(),
    ]);
    if (error || !changeRow) throw new Error("That contract change wasn't found");
    const change = toChange(changeRow as ChangeRow);
    if (!changeAppliesTo(change, caller.clientId)) {
      throw new Error("That contract change wasn't found");
    }
    if (change.withdrawnAt) throw new Error("That change was withdrawn — nothing to accept");
    if (!change.requiresAcceptance) throw new Error("That change doesn't need acceptance");

    const { error: insErr } = await contractsDb()
      .from("contract_acceptances")
      .insert({
        change_id: change.id,
        client_id: caller.clientId,
        agent_id: caller.agentId,
        accepted_name: data.fullName,
        accepted_email: (me as { email: string } | null)?.email ?? "",
      });
    if (insErr) {
      // 23505 = unique violation: another admin of the same company accepted first.
      if ((insErr as { code?: string }).code === "23505") {
        throw new Error("Someone at your company has already accepted this change");
      }
      throw new Error(`Could not record your acceptance (${insErr.message})`);
    }
    return { ok: true };
  });

// ── Both sides ──────────────────────────────────────────────────────────────

/** A short-lived download link. Superadmins may open any document; a company admin only the
 *  platform terms and their own company's documents. */
export const getContractFileUrl = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, documentId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const admin = db();
    // Who is asking comes first — nothing is looked up for an unknown caller.
    const superadmin = await verifySuperadminCaller(data.accessToken);
    const companyClientId = superadmin
      ? null
      : (await requireCompanyAdmin(data.accessToken)).clientId;

    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .select("client_id, file_path, file_name")
      .eq("id", data.documentId)
      .maybeSingle();
    if (error || !row) throw new Error("That document wasn't found");
    const doc = row as { client_id: string | null; file_path: string; file_name: string };
    // A company admin may open the platform terms and their own company's documents only.
    if (companyClientId && doc.client_id !== null && doc.client_id !== companyClientId) {
      throw new Error("That document wasn't found");
    }
    const { data: signed, error: sErr } = await admin.storage
      .from(CONTRACTS_BUCKET)
      .createSignedUrl(doc.file_path, DOWNLOAD_LINK_SECONDS, { download: doc.file_name });
    if (sErr || !signed) throw new Error(`Could not open the file (${sErr?.message})`);
    return { url: signed.signedUrl };
  });
