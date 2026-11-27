// POST /api/sales/lead — the samvadx.com "Request a demo" form (2026-11-27). The website posts
// here as well as to its Google Sheet and email, so nothing it already does changes.
//
// Public and unauthenticated by nature, so it is deliberately small: it accepts only the form's
// own fields, never says anything back about what exists (always 204), drops honeypot bots,
// rate-limits per IP and overall, and caps every field. A request from a phone that is already a
// lead is added to that lead's timeline instead of making a second lead.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin.server";
import { enforceRateLimit } from "./rate-limit.server";
import { parseWebsiteLead, phoneKey } from "./sales/sales-rules";
import { sendEmails } from "./email.server";

export const SALES_LEAD_PATH = "/api/sales/lead";

const MAX_BODY_BYTES = 8 * 1024;

const done = () =>
  new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

async function readFields(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  // The website sends URLSearchParams (a "simple" cross-site request: no CORS preflight).
  return Object.fromEntries(new URLSearchParams(text));
}

export async function handleSalesLead(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return done();
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    enforceRateLimit(`sales-lead:${clientIp(request)}`, 5, 10 * 60 * 1000);
    enforceRateLimit("sales-lead:all", 200, 60 * 60 * 1000);
  } catch {
    return new Response(null, { status: 429 });
  }

  const fields = await readFields(request);
  if (!fields) return done();
  const parsed = parseWebsiteLead(fields);
  if (!parsed.ok) return done();
  const lead = parsed.lead;

  try {
    const db = getSupabaseAdmin() as unknown as SupabaseClient;
    const key = phoneKey(lead.phone);
    const summary = `Demo requested on samvadx.com${lead.page ? ` (${lead.page})` : ""}: ${lead.name}, ${lead.agency}, ${lead.phone}${lead.agentsBand ? `, ${lead.agentsBand} agents` : ""}`;

    const { data: existing } = await db
      .from("sales_leads")
      .select("id, owner_id")
      .eq("phone_key", key)
      .limit(1);
    const hit = (existing ?? [])[0] as { id: string; owner_id: string | null } | undefined;

    let ownerId: string | null = null;
    if (hit) {
      ownerId = hit.owner_id;
      await db.from("sales_activities").insert({ lead_id: hit.id, kind: "website", body: summary });
      await db.from("sales_leads").update({ updated_at: new Date().toISOString() }).eq("id", hit.id);
    } else {
      const { data: row, error } = await db
        .from("sales_leads")
        .insert({
          company_name: lead.agency,
          contact_name: lead.name,
          phone: lead.phone,
          phone_key: key,
          agents_band: lead.agentsBand,
          website_page: lead.page,
          source: "website",
          created_by_name: "samvadx.com",
        })
        .select("id")
        .single();
      if (error) throw error;
      await db
        .from("sales_activities")
        .insert({ lead_id: (row as { id: string }).id, kind: "website", body: summary });
    }

    // Tell the owner, or every active salesperson when nobody owns it yet.
    let q = db.from("sales_users").select("email").eq("is_active", true);
    if (ownerId) q = q.eq("id", ownerId);
    const { data: people } = await q;
    const to = ((people ?? []) as { email: string }[]).map((p) => p.email);
    if (to.length) {
      await sendEmails(
        to.map((email) => ({
          to: email,
          subject: `${hit ? "Repeat demo request" : "New demo request"}: ${lead.agency}`,
          text: `${summary}\n\nOpen the sales portal: https://app.samvadx.com/sales`,
        })),
      );
    }
  } catch (e) {
    console.error("[sales-lead] could not save a website lead:", e);
  }
  return done();
}
