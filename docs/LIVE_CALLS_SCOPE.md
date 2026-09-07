# Live Calls Monitor — scope

Manager and admin see every call happening right now across their agents.

Written 2026-08-30 after a competitor comparison. **Nothing here is built.** This is the
shape of the work and the decisions it needs.

---

## The one-line problem

Call state lives in **per-browser React state**. `useCallSession` is a React context; an
agent's live call exists only in that agent's tab. No other user can see it, and nothing on the
server knows it is happening.

Everything below follows from fixing that.

### What already exists (and what it isn't)

| Thing | What it actually does |
| --- | --- |
| `LiveCallsPanel` (`components/call-queue/dialer-boards.tsx`) | Bottom-right panel showing **the current browser's own** dialer legs. The UI is a good starting point; the data is local. |
| `LiveCallEntry` (`call-queue/types.ts`) | Already the right row shape — agent, debtor, loanId, phone, status, duration, type, providerCallId. Reusable as the wire format. |
| "Agent Live View" (`manager.queue.tsx`) | Misleading name. Renders that agent's **queue** from the database. Nothing live. |
| `call_logs` | Written **after** a call ends, at disposition. Useless for "right now". |

There is no `live_calls` table, and **Supabase Realtime is not used anywhere in this codebase
yet** — this feature would be the first.

---

## Data model

```sql
CREATE TABLE live_calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id),
  agent_id          UUID NOT NULL REFERENCES agents(id),
  debtor_id         UUID REFERENCES debtors(id),      -- null for an unmapped manual dial
  provider_call_id  TEXT,                             -- correlates with webhooks and call_logs
  phase             TEXT NOT NULL,                    -- ringing | connected | wrapup
  dial_mode         TEXT,                             -- reuse call_logs.dial_mode vocabulary
  contact_phone     TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- heartbeat; see ghost calls
  ended_at          TIMESTAMPTZ
);
```

One row per live leg. Deleted or stamped `ended_at` when the call finishes; rows are ephemeral
and **not** a second copy of history — `call_logs` remains the record of what happened.

---

## ⚠️ The hard part: ghost calls

A browser that crashes, a laptop that closes, a tab killed mid-call — none of them write "call
ended". The panel then shows an agent permanently on a call that finished an hour ago, and a
manager loses trust in the whole screen after the first one.

Three defences, in order of how much they cost:

1. **Heartbeat.** The owning tab updates `last_seen_at` every ~15s while the call is live. The
   panel treats anything not seen for 60s as stale and greys it out rather than showing it as
   active. Cheap, and covers the common case.
2. **Provider reconciliation.** Exotel's status webhooks are the only authoritative source for
   "this call is over". ⚠️ The webhook endpoint **does not exist yet** — there is a note in
   `telephony/server.ts` that this version of TanStack Start has no stable server-route
   convention, and `parseStatusWebhook` is written but nothing routes to it. Wiring that up is
   its own piece of work and is what makes this feature *correct* rather than merely useful.
3. **Sweep.** A periodic job closing anything stale. There is no cron in this app (the PTP
   escalation chain runs opportunistically on dashboard load for exactly this reason), so this
   would be opportunistic too, or a Supabase scheduled function.

**Recommendation:** ship 1, design for 2, and be explicit in the UI about which rows are
heartbeat-confirmed vs stale. Do not present a heartbeat as certainty.

---

## RLS

Same shape as every other table here. Reuses existing helpers, no new ones:

```sql
CREATE POLICY live_calls_select ON live_calls FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );
```

Writes restricted to the owning agent (`agent_id = auth_agent_id()`), so nobody can fabricate
or clear someone else's call.

⚠️ Per the standing rule, **no policy may read an RLS-protected table directly** — this one
reads none, which is why it needs no new `SECURITY DEFINER` helper. Keep it that way.

---

## Delivery: Realtime vs polling

Supabase Realtime (`postgres_changes` on `live_calls`) is the right fit and the table has to be
added to the `supabase_realtime` publication. A 5s poll would also work and is less machinery.

Realtime is worth it here: the whole value is immediacy, and a manager watching a 5s-stale
board is a worse product than one watching a live one.

---

## UI

- **Manager:** a Live Calls board — one card per agent on call, showing debtor, loan ID,
  duration, phase and dial mode. Replaces the misnamed "Agent Live View" tab, or sits beside it.
- **Admin:** the same board, unscoped by team.
- Reuse `LiveCallEntry` and the existing panel's visual language rather than inventing a
  second one.

---

## Explicitly OUT of scope

**Whisper, barge and merge.** These are provider-side conference operations. The app cannot do
them: with click-to-call the agent is on their own handset and the two legs are bridged inside
the provider. `TelephonyProvider` has no method for them and cannot get one without provider
support.

The buttons for these existed as local state that did nothing and were disabled on 2026-08-30
(see `PROVIDER_CALL_CONTROL` in `active-call.tsx`).

**Before promising whisper/barge to anyone, get written confirmation from the telephony
provider that the account supports conference/call-control APIs.** This is the same wall as
predictive dialing — the real version needs the WebRTC/SIP onboarding that has not been
started.

### Update 2026-09-07 — Exotel is being replaced; controls are back as placeholders

The org has decided to move off Exotel entirely (voice/click-to-call, not just the WhatsApp path
ruled out earlier — see the WhatsApp decision note in CLAUDE.md) and is evaluating a new
telephony vendor. Listen/Whisper/Merge buttons are back on the Live Calls board
(`live-calls-board.tsx`, `CALL_CONTROL_ACTIONS`) — **disabled, not wired to anything** — as an
intentional placeholder for whichever vendor is chosen next, rather than being built fake or
left off entirely. The reasoning above (why they can't work today) still holds for Exotel; it
does not hold in general, which is the whole point of switching vendors. Do not enable them
until a real provider API exists to call.

---

## Phases

| Phase | Work | Value on its own |
| --- | --- | --- |
| 1 | `live_calls` table + RLS + store; write on phase transitions in `use-single-call.ts`; heartbeat | None user-facing yet |
| 2 | Realtime subscription + manager/admin board | **This is the feature** |
| 3 | Provider webhook endpoint → reconcile `ended_at` | Removes ghost calls properly |
| 4 | Whisper/barge — **blocked on the provider**, not on us | — |

Phases 1+2 are the deliverable. 3 is what makes it trustworthy over time.

---

## Open decisions

1. **Does the board show debtor identity to admins across all teams?** Currently admins see
   everything; confirm that is wanted for live calls specifically.
2. **Retention.** Keep ended rows for a short audit trail, or delete on hangup? Keeping them
   duplicates `call_logs`; deleting loses the "what just happened" view.
3. **Do managers need to see AI/IVR legs too**, or only human agent calls?
4. **Is the misnamed "Agent Live View" tab replaced or kept alongside?** It does something
   genuinely useful (viewing an agent's queue) under a name that promises something else.
