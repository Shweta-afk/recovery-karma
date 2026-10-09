// Sending email from the server through Resend (https://resend.com) — the app's only general
// email path. (Sign-in codes are separate: Supabase Auth sends those itself, and Supabase can't
// send any other kind of email, Pro plan included.)
//
// Off until BOTH env vars are set on Railway:
//   RESEND_API_KEY      — from Resend → API Keys
//   EMAIL_FROM          — e.g. "SamvadX <contracts@samvadx.com>"; its domain must be verified in
//                         Resend (DNS records on samvadx.com) or Resend rejects the send.
// Without them, emailConfigured() is false and callers fall back to the manual "Email the
// admins" mailto link. Uses Resend's REST API directly — no SDK dependency.

const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
/** Resend's batch endpoint takes at most 100 emails per request. */
const BATCH_SIZE = 100;

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/**
 * Sends each email separately (one recipient each, so no one sees anyone else's address).
 * Never throws: returns how many Resend accepted, so a failed email can't undo the action that
 * triggered it. Returns null when email isn't configured.
 */
export async function sendEmails(emails: OutgoingEmail[]): Promise<number | null> {
  if (!emailConfigured()) return null;
  const from = process.env.EMAIL_FROM!;
  let sent = 0;
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(RESEND_BATCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          batch.map((e) => ({ from, to: [e.to], subject: e.subject, text: e.text })),
        ),
      });
      if (!res.ok) {
        console.error(`[email] Resend rejected a batch (${res.status}):`, await res.text());
        continue;
      }
      sent += batch.length;
    } catch (e) {
      console.error("[email] could not reach Resend:", e);
    }
  }
  return sent;
}
