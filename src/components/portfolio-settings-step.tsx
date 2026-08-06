import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { PortfolioSettings, CallMode } from "@/lib/portfolio-store";

// Shared by the upload wizard (step 4) and the Edit Portfolio dialog — same settings,
// same shape, edited before or after the portfolio exists.

export const CALL_MODE_META: Record<CallMode, { label: string; desc: string }> = {
  hybrid: {
    label: "Hybrid (AI + Agent)",
    desc: "AI bot dials first; live agents handle escalations and complex cases.",
  },
  ai_only: {
    label: "AI Only",
    desc: "The AI bot handles the entire portfolio, no live agent involvement.",
  },
  agent_only: {
    label: "Agent Only",
    desc: "Only human agents call this portfolio — no AI or IVR.",
  },
  ivr_agent: {
    label: "IVR + Agent",
    desc: "IVR reminders run first; agents handle anyone who needs a live call.",
  },
};

export function PortfolioSettingsStep({
  settings,
  onChange,
}: {
  settings: PortfolioSettings;
  onChange: (s: PortfolioSettings) => void;
}) {
  const set = <K extends keyof PortfolioSettings>(k: K, v: PortfolioSettings[K]) =>
    onChange({ ...settings, [k]: v });

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs">
          Call Mode <span className="text-destructive">*</span>
        </Label>
        <Select value={settings.callMode} onValueChange={(v) => set("callMode", v as CallMode)}>
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CALL_MODE_META) as CallMode[]).map((m) => (
              <SelectItem key={m} value={m}>
                {CALL_MODE_META[m].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {CALL_MODE_META[settings.callMode].desc}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Dialer Mode</Label>
          <Select
            value={settings.dialerMode}
            onValueChange={(v) => set("dialerMode", v as PortfolioSettings["dialerMode"])}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="predictive">Predictive</SelectItem>
              <SelectItem value="preview">Preview</SelectItem>
              <SelectItem value="power">Power (1:1)</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Calls per cycle: {settings.callsPerCycle}</Label>
          <Input
            type="range"
            min={1}
            max={10}
            value={settings.callsPerCycle}
            onChange={(e) => set("callsPerCycle", +e.target.value)}
            className="h-9"
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
        <div>
          <Label className="text-xs font-medium">Auto Rechurn</Label>
          <p className="text-[11px] text-muted-foreground">
            Automatically re-queue unreached debtors for the next cycle.
          </p>
        </div>
        <Switch checked={settings.autoRechurn} onCheckedChange={(v) => set("autoRechurn", v)} />
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-4 sm:grid-cols-2 transition-opacity",
          !settings.autoRechurn && "opacity-40 pointer-events-none",
        )}
      >
        <div className="space-y-1.5">
          <Label className="text-xs">Rechurn after (days)</Label>
          <Input
            type="number"
            min={0}
            max={30}
            value={settings.rechurnAfterDays}
            onChange={(e) => set("rechurnAfterDays", +e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Max rechurn cycles</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={settings.rechurnMaxCycles}
            onChange={(e) => set("rechurnMaxCycles", +e.target.value)}
            className="h-9"
          />
        </div>
        <div className="flex items-center justify-between sm:col-span-2">
          <Label className="text-xs">Rechurn on No Answer</Label>
          <Switch
            checked={settings.rechurnOnNoAnswer}
            onCheckedChange={(v) => set("rechurnOnNoAnswer", v)}
          />
        </div>
        <div className="flex items-center justify-between sm:col-span-2">
          <Label className="text-xs">Rechurn on Busy</Label>
          <Switch
            checked={settings.rechurnOnBusy}
            onCheckedChange={(v) => set("rechurnOnBusy", v)}
          />
        </div>
        <div className="flex items-center justify-between sm:col-span-2">
          <Label className="text-xs">Rechurn on Voicemail</Label>
          <Switch
            checked={settings.rechurnOnVoicemail}
            onCheckedChange={(v) => set("rechurnOnVoicemail", v)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Calling window</Label>
          <Select
            value={settings.rechurnTimeWindow}
            onValueChange={(v) => set("rechurnTimeWindow", v)}
          >
            <SelectTrigger className="h-9 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="08:00-20:00">08:00 – 20:00</SelectItem>
              <SelectItem value="09:00-19:00">09:00 – 19:00</SelectItem>
              <SelectItem value="09:00-18:00">09:00 – 18:00</SelectItem>
              <SelectItem value="10:00-18:00">10:00 – 18:00</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">PTP follow-up (hours)</Label>
          <Input
            type="number"
            min={1}
            max={72}
            value={settings.ptpFollowupHours}
            onChange={(e) => set("ptpFollowupHours", +e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Callback buffer (min)</Label>
          <Input
            type="number"
            min={0}
            max={30}
            value={settings.callbackBufferMins}
            onChange={(e) => set("callbackBufferMins", +e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Abandon rate target: {settings.abandonRateTarget}%</Label>
          <Input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={settings.abandonRateTarget}
            onChange={(e) => set("abandonRateTarget", +e.target.value)}
            className="h-9"
          />
        </div>
      </div>
    </div>
  );
}
