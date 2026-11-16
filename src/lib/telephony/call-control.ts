// What the agent can do to the call they are on, through SkyCRM's call-control API (spec §15–20,
// API_SKY.docx): mute, hold, add a third person (conference), transfer. Pure, so the requests can
// be tested and shared by the server action; skycrm-provider.ts sends them.
//
// Conference = call_transfer to the third person (an extension or a mobile number), which rings
// them while the borrower stays on the line, then call_swaping "threeway" to join all three.
// "swap" talks to one side at a time, "abort" drops the person being added, "complete" hands the
// call over and takes the agent out (a transfer). conf_hangup removes the added person from a
// three-way call.
//
// ⚠️ Unconfirmed against a live call (2026-11-16): the spec's examples use "8006" for both the
// agent's and the target's extension, so which extension swaping / conf_hangup expect is a
// reading — the agent's here. The vendor's message is shown to the agent and logged, so a wrong
// guess is visible on the first test.

export type CallDirection = "inbound" | "outbound";

export type CallControlAction =
  | "mute"
  | "unmute"
  | "hold"
  | "resume"
  | "add" // ring a third person (conference or transfer starts here)
  | "threeway" // join everyone
  | "swap" // talk to the other side
  | "cancel_add" // drop the person being added, back to the borrower
  | "complete_transfer" // hand the borrower over and leave
  | "remove_added"; // remove the added person from a three-way call

/** Who to add: another extension in the company, or a mobile number (10 digits). */
export type CallTarget = { extension: string } | { number: string };

export interface CallControlRequest {
  path: string;
  body: Record<string, string>;
}

const longDirection = (d: CallDirection) => (d === "inbound" ? "Inbound" : "Outbound");
const shortDirection = (d: CallDirection) => (d === "inbound" ? "in" : "out");

export function callControlRequest(
  action: CallControlAction,
  ctx: { agentExtension: string; direction: CallDirection; target?: CallTarget },
): CallControlRequest {
  const ext = ctx.agentExtension;
  switch (action) {
    case "mute":
    case "unmute":
      return {
        path: "mute_calls",
        body: {
          extension: ext,
          direction: shortDirection(ctx.direction),
          state: action === "mute" ? "yes" : "no",
        },
      };
    case "hold":
    case "resume":
      return {
        path: "hold_calls",
        body: {
          extension: ext,
          direction: shortDirection(ctx.direction),
          state: action === "hold" ? "yes" : "no",
        },
      };
    case "add": {
      if (!ctx.target) throw new Error("Choose who to add to the call");
      const body: Record<string, string> = {
        user_extension: ext,
        direction: longDirection(ctx.direction),
      };
      if ("extension" in ctx.target) body.extension = ctx.target.extension;
      else body.to_number = ctx.target.number;
      return { path: "call_transfer", body };
    }
    case "threeway":
    case "swap":
    case "cancel_add":
    case "complete_transfer":
      return {
        path: "call_swaping",
        body: {
          operate:
            action === "cancel_add"
              ? "Abort"
              : action === "complete_transfer"
                ? "complete"
                : action,
          direction: longDirection(ctx.direction),
          extension: ext,
        },
      };
    case "remove_added":
      return {
        path: "conf_hangup",
        body: { direction: longDirection(ctx.direction), extension: ext },
      };
  }
}

/** SkyCRM's answers vary per endpoint ({"status":200,"message":"success"}, {"status":"Success"},
 *  {"message":"remove conference member"}, {"message":"Call Not Transferred"}, …). */
export function callControlSucceeded(res: Record<string, unknown>): boolean {
  const message = String(res.message ?? res.Message ?? res.error ?? "").toLowerCase();
  if (/\bnot\b|unsucc|fail|error|invalid/.test(message)) return false;
  const status = String(res.status ?? "").toLowerCase();
  if (status === "200" || status === "success") return true;
  return /success|queued|remove conference member/.test(message);
}

/** A typed mobile number as SkyCRM dials it (10 digits), or null. */
export function mobileTarget(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}
