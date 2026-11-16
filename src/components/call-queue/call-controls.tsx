// Mute, hold, add a person (conference) and transfer on the agent's live call, through SkyCRM's
// call-control API (see src/lib/telephony/call-control.ts). Replaces the placeholder buttons that
// only changed local state. Shown while the call is connected; unmounts when it ends, which also
// resets the conference steps.
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  GitMerge,
  Loader2,
  Mic,
  MicOff,
  PauseCircle,
  Phone,
  PhoneForwarded,
  Repeat,
  UserMinus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { controlMyCall, listCallTargets } from "@/lib/telephony-actions.server";

type Action =
  | "mute"
  | "unmute"
  | "hold"
  | "resume"
  | "add"
  | "threeway"
  | "swap"
  | "cancel_add"
  | "complete_transfer"
  | "remove_added";

interface Target {
  name: string;
  role: string;
  extension: string;
}

/** idle → adding (the added person is ringing / talking privately with the agent) → conference
 *  (all three). "Transfer & leave" from adding ends the agent's part of the call. */
type Stage =
  { kind: "idle" } | { kind: "adding"; label: string } | { kind: "conference"; label: string };

export function CallControls({
  muted,
  held,
  onMute,
  onHold,
}: {
  muted: boolean;
  held: boolean;
  /** Flip the call's muted / held flags after SkyCRM confirms. */
  onMute: () => void;
  onHold: () => void;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [number, setNumber] = useState("");

  const run = async (
    action: Action,
    extra: { targetExtension?: string; targetNumber?: string } = {},
  ) => {
    setBusy(action);
    try {
      return await controlMyCall({
        data: { accessToken: await getAccessToken(), action, ...extra },
      });
    } catch (e) {
      toast.error(errorText(e, "That didn't work on the call"));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const openPicker = async () => {
    setPickerOpen((o) => !o);
    if (targets) return;
    try {
      setTargets(await listCallTargets({ data: { accessToken: await getAccessToken() } }));
    } catch (e) {
      setTargets([]);
      toast.error(errorText(e, "Could not load your colleagues"));
    }
  };

  const add = async (extra: { targetExtension?: string; targetNumber?: string }, label: string) => {
    const r = await run("add", extra);
    if (!r) return;
    setPickerOpen(false);
    setNumber("");
    setStage({ kind: "adding", label: r.targetLabel || label });
    toast.success(`Calling ${r.targetLabel || label}…`, {
      description:
        "The borrower waits while you speak to them. Then Merge, Swap, Cancel or Transfer.",
    });
  };

  const spin = (a: Action) => busy === a && <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  const anyBusy = busy !== null;

  return (
    <>
      <Button
        size="sm"
        variant={muted ? "default" : "outline"}
        className={cn("gap-1 h-8", muted && "bg-destructive text-destructive-foreground")}
        disabled={anyBusy}
        onClick={async () => {
          if (await run(muted ? "unmute" : "mute")) onMute();
        }}
      >
        {spin(muted ? "unmute" : "mute") ||
          (muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />)}
        {muted ? "Unmute" : "Mute"}
      </Button>
      <Button
        size="sm"
        variant={held ? "default" : "outline"}
        className={cn("gap-1 h-8", held && "bg-amber-500/80 text-white")}
        disabled={anyBusy}
        onClick={async () => {
          if (await run(held ? "resume" : "hold")) onHold();
        }}
      >
        {spin(held ? "resume" : "hold") || <PauseCircle className="h-3.5 w-3.5" />}
        {held ? "Resume" : "Hold"}
      </Button>

      {stage.kind === "idle" && (
        <div className="relative">
          <Button
            size="sm"
            variant="outline"
            className="gap-1 h-8"
            disabled={anyBusy}
            onClick={openPicker}
          >
            {spin("add") || <PhoneForwarded className="h-3.5 w-3.5" />}
            Add person
          </Button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border border-border bg-card shadow-xl p-3 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Add to this call — for a conference or a transfer
                </p>
                <div className="max-h-48 overflow-y-auto space-y-0.5">
                  {targets === null && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>
                  )}
                  {targets?.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      No colleague has an extension yet.
                    </p>
                  )}
                  {targets?.map((t) => (
                    <button
                      key={t.extension}
                      type="button"
                      disabled={anyBusy}
                      onClick={() => add({ targetExtension: t.extension }, t.name)}
                      className="w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent/60 transition-colors flex items-center justify-between gap-2 disabled:opacity-50"
                    >
                      <span className="truncate">{t.name}</span>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {t.role === "agent" ? "" : `${t.role} · `}
                        {t.extension}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-border pt-2 flex gap-1.5">
                  <Input
                    placeholder="Mobile number"
                    inputMode="tel"
                    value={number}
                    onChange={(e) => setNumber(e.target.value)}
                    className="h-7 text-xs flex-1"
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs gap-1"
                    disabled={anyBusy || !number.trim()}
                    onClick={() => add({ targetNumber: number }, number)}
                  >
                    <Phone className="h-3 w-3" />
                    Call
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {stage.kind === "adding" && (
        <div className="flex items-center gap-1.5 flex-wrap rounded-md border border-blue-500/30 bg-blue-500/5 px-1.5 py-1">
          <span className="text-xs text-blue-600 px-1">With {stage.label}</span>
          <Button
            size="sm"
            className="gap-1 h-7 bg-blue-600 text-white hover:bg-blue-600/90"
            disabled={anyBusy}
            onClick={async () => {
              if (await run("threeway")) {
                setStage({ kind: "conference", label: stage.label });
                toast.success("Everyone is on the call");
              }
            }}
          >
            {spin("threeway") || <GitMerge className="h-3.5 w-3.5" />}
            Merge all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 h-7"
            disabled={anyBusy}
            onClick={() => run("swap")}
            title="Talk to the other side"
          >
            {spin("swap") || <Repeat className="h-3.5 w-3.5" />}
            Swap
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 h-7"
            disabled={anyBusy}
            onClick={async () => {
              if (await run("complete_transfer")) {
                setStage({ kind: "idle" });
                toast.success(`Call handed to ${stage.label}`, {
                  description: "You can hang up and save the disposition.",
                });
              }
            }}
          >
            {spin("complete_transfer") || <ArrowRightLeft className="h-3.5 w-3.5" />}
            Transfer &amp; leave
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 h-7"
            disabled={anyBusy}
            onClick={async () => {
              if (await run("cancel_add")) {
                setStage({ kind: "idle" });
                toast(`${stage.label} dropped — back with the borrower`);
              }
            }}
          >
            {spin("cancel_add") || <X className="h-3.5 w-3.5" />}
            Cancel
          </Button>
        </div>
      )}

      {stage.kind === "conference" && (
        <div className="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/5 px-1.5 py-1">
          <span className="inline-flex items-center gap-1 text-xs text-blue-600 px-1">
            <GitMerge className="h-3 w-3" />
            3-way · {stage.label}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 h-7"
            disabled={anyBusy}
            onClick={async () => {
              if (await run("remove_added")) {
                setStage({ kind: "idle" });
                toast(`${stage.label} removed from the call`);
              }
            }}
          >
            {spin("remove_added") || <UserMinus className="h-3.5 w-3.5" />}
            Remove {stage.label.split(" ")[0]}
          </Button>
        </div>
      )}
    </>
  );
}
