/**
 * Manual Dial — the always-available dock in the bottom-left corner.
 *
 * Mounted at the dashboard/manager LAYOUT level (next to GlobalCallBar), not inside the Call
 * Queue page, so an agent can dial a number from anywhere without navigating first. It
 * replaces the panel that used to live inside Call Queue, which was only reachable from that
 * one page.
 *
 * ── Loan ID ────────────────────────────────────────────────────────────────────────────────
 * Optional to dial, but it is what BINDS the call to an account. Agents routinely ring an
 * alternate number — a relative, a workplace, a second phone — and without a loan ID that call
 * is written with `debtor_id: null` and never appears on the debtor's own history. Typing the
 * ID resolves the account (shown inline before dialling, so the agent can see it matched) and
 * the call is logged against it like any queue call. Leave it blank and the old ad-hoc
 * behaviour is unchanged; nothing is blocked.
 *
 * ── Positioning ────────────────────────────────────────────────────────────────────────────
 * z-30, below the dialer boards' z-40, and hidden entirely while a call is active — the
 * Productive/Progressive boards occupy this same corner during a run, and an agent mid-call is
 * not starting another manual dial.
 */
import { useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Phone, PhoneOutgoing, X, History, Link2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCanCall } from "@/lib/calling-access";
import { useAuth } from "@/lib/auth";
import { useCallSession } from "@/lib/call-session";
import { useSingleCall } from "@/lib/dialer/use-single-call";
import { useStorageSync } from "@/lib/storage-sync";
import { TELEPHONY_CALLER_IDS } from "@/lib/telephony/caller-ids";
import {
  phoneKey,
  resolvePhone,
  useLoanReferenceMatch,
  usePhoneMatches,
  type PhoneMatch,
} from "@/lib/loan-ref-lookup";
import { getDispositions, type DispositionRecord } from "@/lib/disposition-store";
import { OUTCOME_META } from "@/lib/call-queue/types";
import type { QueueDebtor } from "@/lib/call-queue/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

/** Agents and managers see their own recent manual calls; an admin sees everyone's. */
const RECENT_LIMIT = 5;

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ManualDialDock() {
  const { user } = useAuth();
  const canCall = useCanCall();
  const { activeCall, setActiveCall } = useCallSession();
  const singleCall = useSingleCall(setActiveCall, { mode: "server" });

  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(true);
  const [loanId, setLoanId] = useState("");
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [callerId, setCallerId] = useState<string>(TELEPHONY_CALLER_IDS[0] ?? "");

  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const navigate = useNavigate();
  /** The agent tree, whose Call Queue draws the full call screen from the shared call session. */
  const onAgentSide = pathname.startsWith("/dashboard");
  const myId = user?.email ?? user?.id ?? "";
  const isAdmin = user?.role === "admin";

  // Re-read on any disposition write so a call just logged shows up in the panel immediately.
  const [tick, setTick] = useState(0);
  useStorageSync(() => setTick((t) => t + 1));

  /** The account the typed loan ID resolves to, or null. Instant from the portfolio cache when
   * it has the account; otherwise one debounced database lookup (loan-ref-lookup.ts). */
  const { match, looking: lookingUp } = useLoanReferenceMatch(loanId);

  /** No Loan ID typed (or it matched nothing): find the account by the number itself — its
   * primary or an alternate number. Several accounts can share a number (one borrower, several
   * loans); the first is used unless the agent picks another. */
  const { matches: phoneMatches, looking: phoneLooking } = usePhoneMatches(match ? "" : number);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const phoneMatch: PhoneMatch | null =
    phoneMatches.find((m) => m.row.id === pickedId) ?? phoneMatches[0] ?? null;
  const target = match ?? phoneMatch;

  const recentManual = useMemo(() => {
    void tick;
    return getDispositions()
      .filter((d) => d.dialMode === "manual")
      .filter((d) => (isAdmin ? true : d.agentId === myId))
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, isAdmin ? 50 : RECENT_LIMIT);
  }, [tick, isAdmin, myId]);

  // The boards own this corner during a dial run, and there is nothing to dial while a call is
  // already up.
  if (activeCall) return null;

  // manager/queue is the one route that keeps its OWN activeCall state instead of using
  // useCallSession, so a call started there is invisible to the check above — the dock would
  // stay live during it and a second click would open a concurrent call with two separate
  // state holders driving it. Hidden there entirely; that page has its own dialer.
  if (pathname.startsWith("/manager/queue")) return null;
  // Managers dial only where the company has "Managers can call" switched on.
  if (user?.role === "manager" && canCall !== true) return null;

  const dial = async () => {
    const dialled = number.trim();
    if (!dialled) return;
    // Clicked before the number lookup came back: wait for it, so the call still lands on the
    // borrower's account instead of being logged as a stranger.
    let account = target;
    if (!account && phoneKey(dialled)) {
      account = (await resolvePhone(dialled).catch(() => []))[0] ?? null;
    }

    // A matched loan ID dials the REAL debtor row, so the disposition carries a genuine
    // debtor_id and lands on that account's history. Unmatched falls back to the synthetic
    // ad-hoc debtor, which saveDisposition writes with debtor_id: null (see its isAdHoc path).
    const debtor: QueueDebtor = account
      ? {
          ...(account.debtor as QueueDebtor),
          // Dial the number the agent actually typed — the whole point is that it is often an
          // alternate number, not the one on the account.
          phone: dialled,
          queueStatus: "fresh",
          scheduledAt: new Date().toISOString(),
          portfolioId: account.portfolio.id,
          loanReference: account.row.loanReference,
        }
      : ({
          id: `manual-${Date.now()}`,
          name: name.trim() || dialled,
          phone: dialled,
          loanReference: "Manual Dial",
          loanAmount: 0,
          dpd: 0,
          aiScore: 0,
          portfolio: "Manual",
          queueStatus: "fresh",
          scheduledAt: new Date().toISOString(),
          retained: false,
        } as unknown as QueueDebtor);

    setActiveCall({
      debtor,
      dialMode: "manual",
      // Start of the ring — measures ring time, and tells this call apart from an earlier one
      // to the same account (the floating bar opens each call's disposition once).
      dialStartedAt: new Date().toISOString(),
      phase: "ringing",
      // Minimized so the floating call bar appears wherever the agent happens to be; they
      // maximize into Call Queue to disposition. A "panel" view would render nothing at all
      // on any page other than Call Queue.
      //
      // A call matched to an account opens the full call screen straight away on the agent
      // side, so the agent sees the borrower's loan details while it rings — the same screen a
      // Call Queue call gets.
      view: account && onAgentSide ? "panel" : "minimized",
      muted: false,
      held: false,
      elapsed: 0,
    });
    singleCall.dial(debtor, { callerId: callerId || undefined });
    if (account && onAgentSide && !pathname.startsWith("/dashboard/call-queue")) {
      void navigate({ to: "/dashboard/call-queue" });
    }

    toast.success(
      account
        ? `Calling ${account.debtor.name} · ${account.row.loanReference}`
        : `Calling ${dialled}…`,
    );
    setOpen(false);
    setLoanId("");
    setNumber("");
    setName("");
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-4 z-30 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-semibold shadow-lg shadow-black/10 transition-all hover:border-foreground/30 hover:shadow-xl focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <PhoneOutgoing className="h-4 w-4 text-primary" />
        Manual Dial
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-30 flex items-stretch gap-2 animate-in slide-in-from-bottom-4 duration-300">
      {/* ── Dialer ── */}
      <div className="w-72 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <PhoneOutgoing className="h-3.5 w-3.5" />
            Manual Dial
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={showHistory ? "Hide recent calls" : "Show recent calls"}
              title={showHistory ? "Hide recent calls" : "Show recent calls"}
              onClick={() => setShowHistory((h) => !h)}
              className={cn(
                "rounded p-1 transition-colors",
                showHistory ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <History className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Close manual dial"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-2 p-3">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground">
              Loan / Account ID <span className="opacity-70">(optional)</span>
            </label>
            <Input
              value={loanId}
              onChange={(e) => setLoanId(e.target.value)}
              placeholder="e.g. LN-40021"
              className="h-8 text-sm"
            />
            {/* Confirmation BEFORE dialling — an agent should never have to guess whether the
                call is going to land on the right account. */}
            {loanId.trim() &&
              (match ? (
                <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-success">
                  <Link2 className="h-3 w-3 shrink-0" />
                  {match.debtor.name} · {match.portfolio.name}
                </p>
              ) : lookingUp ? (
                <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Search className="h-3 w-3 shrink-0" />
                  Looking up account…
                </p>
              ) : (
                <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-500">
                  <Search className="h-3 w-3 shrink-0" />
                  No account matches — the call will be logged unmapped
                </p>
              ))}
          </div>

          <div>
            <label className="text-[10px] font-medium text-muted-foreground">Number to call</label>
            <Input
              value={number}
              onChange={(e) => {
                setNumber(e.target.value);
                setPickedId(null);
              }}
              placeholder="+91…"
              inputMode="tel"
              className="h-8 text-sm"
            />
            {!match &&
              phoneKey(number) &&
              (phoneLooking ? (
                <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Search className="h-3 w-3 shrink-0" />
                  Looking for this number in your portfolios…
                </p>
              ) : phoneMatches.length === 0 ? (
                <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-500">
                  <Search className="h-3 w-3 shrink-0" />
                  Not in any of your portfolios — the call will be logged unmapped
                </p>
              ) : (
                <div className="mt-1 space-y-0.5">
                  {phoneMatches.length > 1 && (
                    <p className="text-[10px] text-muted-foreground">
                      {phoneMatches.length} accounts have this number — pick one:
                    </p>
                  )}
                  {phoneMatches.slice(0, 6).map((m) => {
                    const on = m.row.id === phoneMatch?.row.id;
                    return (
                      <button
                        key={m.row.id}
                        type="button"
                        onClick={() => setPickedId(m.row.id)}
                        className={cn(
                          "flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px]",
                          on ? "font-medium text-success" : "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        <Link2 className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {m.debtor.name} · {m.row.loanReference} · {m.portfolio.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
          </div>

          {/* Only meaningful for an unmapped call — a matched account already has a name. */}
          {!target && (
            <div>
              <label className="text-[10px] font-medium text-muted-foreground">
                Name <span className="opacity-70">(optional)</span>
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Who are you calling?"
                className="h-8 text-sm"
              />
            </div>
          )}

          <div>
            <label className="text-[10px] font-medium text-muted-foreground">Caller ID</label>
            <Select value={callerId} onValueChange={setCallerId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Caller ID" />
              </SelectTrigger>
              <SelectContent>
                {TELEPHONY_CALLER_IDS.map((did) => (
                  <SelectItem key={did} value={did}>
                    {did}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            className="h-8 w-full gap-1.5 text-sm"
            disabled={!number.trim()}
            onClick={() => void dial()}
          >
            <Phone className="h-3.5 w-3.5" />
            Call Now
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">
            Logged and recorded automatically.
          </p>
        </div>
      </div>

      {/* ── Recent manual calls, side by side ── */}
      {showHistory && (
        <div className="w-64 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 overflow-hidden flex flex-col">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {isAdmin ? "All manual calls" : "Your recent calls"}
            </span>
          </div>
          <div className="flex-1 overflow-auto max-h-[320px] divide-y divide-border">
            {recentManual.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                No manual calls yet.
              </p>
            ) : (
              recentManual.map((d) => <ManualRow key={d.id} d={d} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ManualRow({ d }: { d: DispositionRecord }) {
  const meta = OUTCOME_META[d.outcome as keyof typeof OUTCOME_META];
  // An unmapped call has no debtor behind it — say so plainly rather than showing a blank.
  const mapped = d.debtorId && !d.debtorId.startsWith("manual-");
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">
          {d.debtorName || d.phone}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel(d.time)}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
          {d.phone}
          <CopyButton value={d.phone} label="Phone number" />
        </span>
        {meta && (
          <span className={cn("shrink-0 text-[10px] font-semibold", meta.cls)}>{meta.label}</span>
        )}
      </div>
      {!mapped && <span className="mt-0.5 inline-block text-[10px] text-amber-500">Unmapped</span>}
    </div>
  );
}
