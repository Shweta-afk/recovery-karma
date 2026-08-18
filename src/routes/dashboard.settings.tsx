import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Phone, Clock, Zap, Bell, Shield, Volume2, Save, Mic } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/dashboard/settings")({
  head: () => ({ meta: [{ title: "Settings · SamvadX" }] }),
  component: AgentSettingsPage,
});

/* ─── defaults ───────────────────────────────────────────────────────────── */

const DEFAULTS = {
  // Dialer — pacing/attempt-cap preferences that apply regardless of which portfolio is
  // being worked. Dialer mode, calls-per-cycle, rechurn rules and abandon-rate target moved
  // to per-portfolio settings (set at upload time — see Portfolio Upload → Portfolio Settings).
  ringTimeout: 30,
  interCallDelay: 10,
  maxAttemptsPerDay: 3,
  maxAttemptsTotal: 9,

  // Wrapup & breaks
  wrapupTime: 30,
  breakReminderMins: 90,
  maxBreakMins: 15,
  feedbackRequired: true,
  feedbackTimeoutSecs: 120,

  // PTP & callback
  autoScheduleCallback: true,

  // Compliance
  dnc: true,
  dndHonouring: true,
  callStartTime: "09:00",
  callEndTime: "18:00",
  consentRecording: true,
  maxContactsPerWeek: 7,

  // Recording
  recordAgentCalls: true,
  recordAiCalls: true,
  recordingStorage: "s3",
  recordingRetentionDays: 180,
  autoTranscribe: true,
  aiSentimentAnalysis: true,
  recordingConsentBeep: true,
  recordingFormat: "mp3",
  recordingQuality: "16khz",

  // Notifications
  ptpAlerts: true,
  paymentAlerts: true,
  escalationAlerts: true,
  soundEnabled: true,
};

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
  badge,
}: {
  icon: typeof Phone;
  title: string;
  description: string;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          {title}
          {badge && (
            <Badge variant="secondary" className="text-[10px] ml-1">
              {badge}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </CardHeader>
      <CardContent className="pt-4 space-y-5">{children}</CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function AgentSettingsPage() {
  const [cfg, setCfg] = useState({ ...DEFAULTS });
  const set = <K extends keyof typeof DEFAULTS>(k: K, v: (typeof DEFAULTS)[K]) =>
    setCfg((p) => ({ ...p, [k]: v }));

  const handleSave = () =>
    toast.success("Settings saved", {
      description: "Changes will apply from your next login session.",
    });

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Settings</h1>
          <p className="text-sm text-muted-foreground">
            Personal pacing, compliance, recording and notification preferences. Portfolio-specific
            behaviour (call mode, rechurn, PTP follow-up) is set per portfolio in Portfolio Upload.
          </p>
        </div>
        <Button onClick={handleSave} className="gap-1.5">
          <Save className="h-4 w-4" />
          Save Settings
        </Button>
      </div>

      {/* ── Productive Dialer ───────────────────────────────────────────── */}
      <SectionCard
        icon={Zap}
        title="Productive Dialer"
        description="Personal pacing preferences. Dialer mode, calls-per-cycle, rechurn rules and abandon-rate target are set per portfolio during upload."
      >
        <SettingRow
          label="Ring timeout (seconds)"
          hint="Drop call if unanswered after this many seconds."
        >
          <Input
            type="number"
            min={10}
            max={90}
            value={cfg.ringTimeout}
            onChange={(e) => set("ringTimeout", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>

        <SettingRow
          label="Inter-call delay (seconds)"
          hint="Pause between the end of one call and the start of the next dial."
        >
          <Input
            type="number"
            min={0}
            max={120}
            value={cfg.interCallDelay}
            onChange={(e) => set("interCallDelay", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>

        <Separator />

        <SettingRow
          label="Max attempts per day"
          hint="Maximum times a debtor can be called within a single day."
        >
          <Input
            type="number"
            min={1}
            max={10}
            value={cfg.maxAttemptsPerDay}
            onChange={(e) => set("maxAttemptsPerDay", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>

        <SettingRow
          label="Max lifetime attempts"
          hint="After this many total attempts, account is marked unreachable."
        >
          <Input
            type="number"
            min={1}
            max={30}
            value={cfg.maxAttemptsTotal}
            onChange={(e) => set("maxAttemptsTotal", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>
      </SectionCard>

      {/* ── Wrapup & Breaks ─────────────────────────────────────────────── */}
      <SectionCard
        icon={Clock}
        title="Wrapup & Breaks"
        description="Time limits for post-call feedback and scheduled agent breaks."
      >
        <SettingRow
          label={`Wrapup time: ${cfg.wrapupTime}s`}
          hint="How long the agent has to complete call disposition after hanging up."
        >
          <div className="w-40">
            <Slider
              min={10}
              max={180}
              step={10}
              value={[cfg.wrapupTime]}
              onValueChange={([v]) => set("wrapupTime", v)}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>10s</span>
              <span>3m</span>
            </div>
          </div>
        </SettingRow>

        <SettingRow label="Feedback required before next call">
          <Switch
            checked={cfg.feedbackRequired}
            onCheckedChange={(v) => set("feedbackRequired", v)}
          />
        </SettingRow>

        <SettingRow
          label="Feedback timeout (seconds)"
          hint="Auto-submit feedback with last selected outcome after this period."
        >
          <Input
            type="number"
            min={30}
            max={300}
            value={cfg.feedbackTimeoutSecs}
            onChange={(e) => set("feedbackTimeoutSecs", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>

        <Separator />

        <SettingRow
          label="Break reminder (minutes)"
          hint="Agent receives a reminder notification after this many minutes online."
        >
          <Input
            type="number"
            min={30}
            max={240}
            value={cfg.breakReminderMins}
            onChange={(e) => set("breakReminderMins", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>

        <SettingRow
          label="Max break duration (minutes)"
          hint="Dialer pauses during break; auto-resumes after this period."
        >
          <Input
            type="number"
            min={5}
            max={60}
            value={cfg.maxBreakMins}
            onChange={(e) => set("maxBreakMins", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>
      </SectionCard>

      {/* ── PTP & Callbacks ─────────────────────────────────────────────── */}
      <SectionCard
        icon={Phone}
        title="PTP & Callback"
        description="PTP follow-up window and callback buffer are set per portfolio during upload."
      >
        <SettingRow label="Auto-schedule callbacks from AI notes">
          <Switch
            checked={cfg.autoScheduleCallback}
            onCheckedChange={(v) => set("autoScheduleCallback", v)}
          />
        </SettingRow>
      </SectionCard>

      {/* ── Compliance ──────────────────────────────────────────────────── */}
      <SectionCard
        icon={Shield}
        title="Compliance"
        description="DNC, DND, calling hours and TRAI/RBI regulatory guardrails."
        badge="TRAI / RBI"
      >
        <SettingRow
          label="Honour DNC registry"
          hint="Accounts on the national Do-Not-Call list are automatically skipped."
        >
          <Switch checked={cfg.dnc} onCheckedChange={(v) => set("dnc", v)} />
        </SettingRow>

        <SettingRow label="Honour DND mobile numbers">
          <Switch checked={cfg.dndHonouring} onCheckedChange={(v) => set("dndHonouring", v)} />
        </SettingRow>

        <SettingRow label="Calling hours">
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={cfg.callStartTime}
              onChange={(e) => set("callStartTime", e.target.value)}
              className="w-28 h-8 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="time"
              value={cfg.callEndTime}
              onChange={(e) => set("callEndTime", e.target.value)}
              className="w-28 h-8 text-xs"
            />
          </div>
        </SettingRow>

        <SettingRow
          label="Consent-based call recording"
          hint="Plays a recorded consent message at the start of every call."
        >
          <Switch
            checked={cfg.consentRecording}
            onCheckedChange={(v) => set("consentRecording", v)}
          />
        </SettingRow>

        <SettingRow label="Max contacts per week per debtor">
          <Input
            type="number"
            min={1}
            max={14}
            value={cfg.maxContactsPerWeek}
            onChange={(e) => set("maxContactsPerWeek", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>
      </SectionCard>

      {/* ── Call Recording ──────────────────────────────────────────────── */}
      <SectionCard
        icon={Mic}
        title="Call Recording"
        description="All agent and AI bot calls are recorded, transcribed, and analysed for quality audit."
        badge="Always On"
      >
        <SettingRow label="Record agent calls" hint="Every live agent call is captured in full.">
          <Switch
            checked={cfg.recordAgentCalls}
            onCheckedChange={(v) => set("recordAgentCalls", v)}
          />
        </SettingRow>
        <SettingRow
          label="Record AI bot calls"
          hint="AI-handled predictive dialler calls are also recorded."
        >
          <Switch checked={cfg.recordAiCalls} onCheckedChange={(v) => set("recordAiCalls", v)} />
        </SettingRow>
        <SettingRow
          label="Play consent beep"
          hint="A beep + announcement plays at call start to inform the debtor of recording."
        >
          <Switch
            checked={cfg.recordingConsentBeep}
            onCheckedChange={(v) => set("recordingConsentBeep", v)}
          />
        </SettingRow>

        <Separator />

        <SettingRow
          label="Auto-transcribe recordings"
          hint="Whisper AI converts every recording to text within 2 minutes of call end."
        >
          <Switch checked={cfg.autoTranscribe} onCheckedChange={(v) => set("autoTranscribe", v)} />
        </SettingRow>
        <SettingRow
          label="AI sentiment analysis"
          hint="Automatically tags calls as Positive / Negative / Rude / Calm for audit."
        >
          <Switch
            checked={cfg.aiSentimentAnalysis}
            onCheckedChange={(v) => set("aiSentimentAnalysis", v)}
          />
        </SettingRow>

        <Separator />

        <SettingRow label="Recording format">
          <Select value={cfg.recordingFormat} onValueChange={(v) => set("recordingFormat", v)}>
            <SelectTrigger className="w-28 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mp3">MP3</SelectItem>
              <SelectItem value="wav">WAV</SelectItem>
              <SelectItem value="ogg">OGG</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="Audio quality">
          <Select value={cfg.recordingQuality} onValueChange={(v) => set("recordingQuality", v)}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="8khz">8 kHz (narrow)</SelectItem>
              <SelectItem value="16khz">16 kHz (standard)</SelectItem>
              <SelectItem value="32khz">32 kHz (high)</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="Storage backend">
          <Select value={cfg.recordingStorage} onValueChange={(v) => set("recordingStorage", v)}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="s3">AWS S3</SelectItem>
              <SelectItem value="gcs">Google Cloud</SelectItem>
              <SelectItem value="r2">Cloudflare R2</SelectItem>
              <SelectItem value="local">Local server</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Retention period (days)"
          hint="Recordings older than this are permanently deleted."
        >
          <Input
            type="number"
            min={30}
            max={1825}
            value={cfg.recordingRetentionDays}
            onChange={(e) => set("recordingRetentionDays", +e.target.value)}
            className="w-20 h-8 text-xs text-center"
          />
        </SettingRow>
      </SectionCard>

      {/* ── Notifications ───────────────────────────────────────────────── */}
      <SectionCard
        icon={Bell}
        title="Notifications"
        description="In-app alerts for key collection events."
      >
        <SettingRow label="PTP set / PTP missed alerts">
          <Switch checked={cfg.ptpAlerts} onCheckedChange={(v) => set("ptpAlerts", v)} />
        </SettingRow>
        <SettingRow label="Payment received alerts">
          <Switch checked={cfg.paymentAlerts} onCheckedChange={(v) => set("paymentAlerts", v)} />
        </SettingRow>
        <SettingRow label="Escalation & dispute alerts">
          <Switch
            checked={cfg.escalationAlerts}
            onCheckedChange={(v) => set("escalationAlerts", v)}
          />
        </SettingRow>
        <SettingRow label="Sound notifications">
          <Switch checked={cfg.soundEnabled} onCheckedChange={(v) => set("soundEnabled", v)} />
        </SettingRow>
      </SectionCard>

      <div className="flex justify-end pb-6">
        <Button onClick={handleSave} className="gap-1.5">
          <Save className="h-4 w-4" />
          Save All Settings
        </Button>
      </div>
    </div>
  );
}
