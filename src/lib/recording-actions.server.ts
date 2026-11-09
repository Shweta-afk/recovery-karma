// Playing a call recording that SamvadX stored itself (2026-11-05; importer in
// telephony/recordings.server.ts). call_logs.recording_url holds a marker
// "samvadx-recording:<telephony_calls.id>"; this turns it into a link valid for one hour.
//
// Who may play it: someone who can SEE that call log under their own RLS (the same rule as the
// Calls tab / Activity History / Call Audit), and only for a recording of their own company.
// recording_url is writable by agents, so the marker alone proves nothing — both checks matter.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { CALL_RECORDINGS_BUCKET, parseRecordingMarker } from "./telephony/recording-marker";

const SIGNED_URL_SECONDS = 3600;

/* eslint-disable @typescript-eslint/no-explicit-any -- new ledger columns aren't in the generated types yet */

/** Storage path of a stored recording the caller may play, or an Error. Not exported: this file
 *  is imported by browser code, and an exported plain function ships in the client bundle. */
async function authorisedRecording(
  accessToken: string,
  marker: string,
): Promise<{ object: string; contentType: string | null; clientId: string }> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  const ledgerId = parseRecordingMarker(marker);
  if (!ledgerId) throw new Error("Not a stored recording");

  const { data: row } = await (getSupabaseAdmin() as any)
    .from("telephony_calls")
    .select("client_id, recording_object, recording_content_type")
    .eq("id", ledgerId)
    .maybeSingle();
  if (!row?.recording_object || row.client_id !== caller.clientId) {
    throw new Error("Recording not found");
  }

  // A call auditor reviews every call of their company, and RLS shows them none. The company
  // check above is the whole rule for them.
  if (caller.role === "auditor") {
    return {
      object: row.recording_object as string,
      contentType: (row.recording_content_type as string | null) ?? null,
      clientId: caller.clientId,
    };
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Recordings are not available right now");
  const asCaller = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  }) as any;
  const { data: visible } = await asCaller
    .from("call_logs")
    .select("id")
    .eq("recording_url", marker)
    .limit(1);
  if (!visible?.length) throw new Error("Recording not found");

  return {
    object: row.recording_object as string,
    contentType: (row.recording_content_type as string | null) ?? null,
    clientId: caller.clientId,
  };
}

export const getRecordingPlayUrl = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, recording: z.string().max(200) }).parse(d),
  )
  .handler(async ({ data }) => {
    const rec = await authorisedRecording(data.accessToken, data.recording);
    const { data: signed, error } = await getSupabaseAdmin()
      .storage.from(CALL_RECORDINGS_BUCKET)
      .createSignedUrl(rec.object, SIGNED_URL_SECONDS);
    if (error || !signed?.signedUrl) throw new Error("Recording not available right now");
    return { url: signed.signedUrl };
  });
