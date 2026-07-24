import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import {
  Mic,
  Play,
  Pause,
  Download,
  Search,
  X,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
  Wind,
  Filter,
  ChevronDown,
  ChevronRight,
  Clock,
  User,
  Bot,
  FileText,
  Volume2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";

export const Route = createFileRoute("/manager/audit")({
  head: () => ({ meta: [{ title: "Call Audit · RecoveryAI" }] }),
  component: CallAuditPage,
});

/* ─── types ─────────────────────────────────────────────────────────────── */

type Sentiment = "positive" | "negative" | "rude" | "calm";
type CallerType = "agent" | "ai";

interface TranscriptLine {
  speaker: "agent" | "ai" | "debtor";
  text: string;
  ts: string; // mm:ss
  sentiment?: "neutral" | "positive" | "negative" | "aggressive";
}

interface CallRecord {
  id: string;
  date: string;
  time: string;
  agentName: string;
  callerType: CallerType;
  debtorName: string;
  debtorId: string;
  duration: string; // mm:ss
  durationSecs: number;
  sentiment: Sentiment;
  sentimentScore: number; // 0-100
  outcome: string;
  portfolio: string;
  bucket: DPDBucket;
  flagged: boolean;
  flagReason?: string;
  transcript: TranscriptLine[];
  aiNotes: string;
  recordingUrl: string; // mock
}

/* ─── mock data ─────────────────────────────────────────────────────────── */

const MOCK_CALLS: CallRecord[] = [
  {
    id: "REC-1001",
    date: "28 Jun 2026",
    time: "10:14 AM",
    agentName: "Priya Singh",
    callerType: "agent",
    debtorName: "Rahul Sharma",
    debtorId: "L-10042",
    duration: "4:22",
    durationSecs: 262,
    sentiment: "positive",
    sentimentScore: 84,
    outcome: "PTP",
    portfolio: "Personal Loan Q1",
    bucket: "1",
    flagged: false,
    aiNotes:
      "Debtor was cooperative. Committed to paying ₹45,000 via UPI by 30 Jun. Agent used empathetic tone throughout. Recommended follow-up: payment confirmation SMS.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "agent",
        ts: "0:00",
        text: "Namaste Rahul ji, main Priya bol rahi hoon RecoveryAI se. Aapke HDFC personal loan ke baare mein baat karni thi.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:08",
        text: "Haan ji, bolo. Main sun raha hoon.",
        sentiment: "neutral",
      },
      {
        speaker: "agent",
        ts: "0:12",
        text: "Aapka ₹45,000 outstanding hai. Kya aap is month settle kar sakte hain?",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:20",
        text: "Haan, meri salary 28 ko aayegi. Main 30 tak UPI se kar dunga.",
        sentiment: "positive",
      },
      {
        speaker: "agent",
        ts: "0:31",
        text: "Bahut shukriya Rahul ji! Main aapko payment link bhej deti hoon. Aur ek confirmation SMS bhi aayega.",
        sentiment: "positive",
      },
      { speaker: "debtor", ts: "0:41", text: "Theek hai, send kar do.", sentiment: "neutral" },
      { speaker: "agent", ts: "0:45", text: "Done. Koi aur help chahiye?", sentiment: "neutral" },
      {
        speaker: "debtor",
        ts: "0:50",
        text: "Nahi, sab theek hai. Dhanyawad.",
        sentiment: "positive",
      },
    ],
  },
  {
    id: "REC-1002",
    date: "28 Jun 2026",
    time: "10:42 AM",
    agentName: "AI Bot",
    callerType: "ai",
    debtorName: "Tarun Desai",
    debtorId: "L-10366",
    duration: "2:05",
    durationSecs: 125,
    sentiment: "rude",
    sentimentScore: 18,
    outcome: "Refused",
    portfolio: "MSME Working Cap",
    bucket: "NPA",
    flagged: true,
    flagReason: "Debtor used abusive language. Escalation recommended.",
    aiNotes:
      "Debtor became hostile at 0:45. Used profanity twice. Bot de-escalated and offered callback with a manager. Account flagged for legal track review.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "ai",
        ts: "0:00",
        text: "Namaskar, main RecoveryAI se call kar raha hoon Tarun Desai ji ke liye. Aapka loan account L-10366 ke baare mein baat karni hai.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:12",
        text: "Kaunsi company? Roz roz call kyun karte ho!",
        sentiment: "negative",
      },
      {
        speaker: "ai",
        ts: "0:18",
        text: "Main samajh sakta hoon aap busy hain. Aapka ₹8,05,000 outstanding hai. Kya hum koi settlement discuss kar sakte hain?",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:28",
        text: "Koi settlement nahi. Band karo yeh calls! [profanity]",
        sentiment: "aggressive",
      },
      {
        speaker: "ai",
        ts: "0:38",
        text: "Sir, main aapko disturb nahi karna chahta. Ek senior manager se callback schedule kar deta hoon — aapki convenience ke hisaab se.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:50",
        text: "Koi callback nahi chahiye. Legal action lo jo lena ho.",
        sentiment: "aggressive",
      },
      {
        speaker: "ai",
        ts: "0:58",
        text: "Samjha. Main yeh note kar leta hoon. Aapko likhi mein bhi notice bheja jayega. Dhanyawad.",
        sentiment: "neutral",
      },
    ],
  },
  {
    id: "REC-1003",
    date: "28 Jun 2026",
    time: "11:05 AM",
    agentName: "Ravi Mehta",
    callerType: "agent",
    debtorName: "Sandeep Yadav",
    debtorId: "L-10199",
    duration: "6:10",
    durationSecs: 370,
    sentiment: "calm",
    sentimentScore: 62,
    outcome: "Callback",
    portfolio: "MSME Working Cap",
    bucket: "2",
    flagged: false,
    aiNotes:
      "Long negotiation. Debtor requested a settlement waiver. Agent stayed calm and explained policy. Escalated to manager for waiver approval. Scheduled manager callback at 4 PM.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "agent",
        ts: "0:00",
        text: "Good morning Sandeep ji. Ravi Mehta here from RecoveryAI. Calling regarding your MSME loan L-10199.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:09",
        text: "Yes Ravi ji. I was expecting your call actually.",
        sentiment: "neutral",
      },
      {
        speaker: "agent",
        ts: "0:14",
        text: "We have ₹6,15,000 outstanding. You had asked about a settlement last week — can we discuss?",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:23",
        text: "Yes, my business is still recovering. Can you waive the interest portion? I can pay the principal.",
        sentiment: "neutral",
      },
      {
        speaker: "agent",
        ts: "0:35",
        text: "I understand your situation. Interest waiver requests go to our manager. Let me schedule a call with him for you at 4 PM today.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:46",
        text: "That would be helpful. Thank you for understanding.",
        sentiment: "positive",
      },
    ],
  },
  {
    id: "REC-1004",
    date: "28 Jun 2026",
    time: "11:30 AM",
    agentName: "AI Bot",
    callerType: "ai",
    debtorName: "Divya Krishnan",
    debtorId: "L-10333",
    duration: "1:48",
    durationSecs: 108,
    sentiment: "positive",
    sentimentScore: 91,
    outcome: "Paid",
    portfolio: "Credit Card NPA",
    bucket: "X",
    flagged: false,
    aiNotes:
      "Successful automated collection. Debtor confirmed payment of ₹8,200 via UPI link sent during call. No human escalation required. Model performance: excellent.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "ai",
        ts: "0:00",
        text: "Hello Divya ji. RecoveryAI calling regarding your credit card outstanding of ₹8,200.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:08",
        text: "Haan, main kal se pay karne wali thi. Link bhejo.",
        sentiment: "positive",
      },
      {
        speaker: "ai",
        ts: "0:14",
        text: "Zaroor! Link aapke registered mobile pe bhej diya hai. Payment confirm hone pe SMS aayega.",
        sentiment: "positive",
      },
      {
        speaker: "debtor",
        ts: "0:22",
        text: "Done, paid kar diya. Thanks.",
        sentiment: "positive",
      },
    ],
  },
  {
    id: "REC-1005",
    date: "27 Jun 2026",
    time: "03:15 PM",
    agentName: "Sonal Desai",
    callerType: "agent",
    debtorName: "Nikita Rao",
    debtorId: "L-10588",
    duration: "8:33",
    durationSecs: 513,
    sentiment: "negative",
    sentimentScore: 31,
    outcome: "Dispute",
    portfolio: "Credit Card NPA",
    bucket: "NPA",
    flagged: true,
    flagReason: "Debtor disputes the outstanding amount. Reconciliation required.",
    aiNotes:
      "Debtor claims incorrect billing. Requested full statement. Agent was professional throughout but debtor was frustrated. Dispute ticket D-002 created. Next step: send statement within 48h.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "agent",
        ts: "0:00",
        text: "Nikita ji, main Sonal bol rahi hoon. Aapke credit card NPA ke baare mein — ₹2,30,000 outstanding hai.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:10",
        text: "Yeh amount galat hai. Mujhe pura statement chahiye. Main itna nahi liya tha.",
        sentiment: "negative",
      },
      {
        speaker: "agent",
        ts: "0:20",
        text: "Main samajhti hoon. Main dispute ticket raise karti hoon aur 48 ghante mein pura statement email karti hoon.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:30",
        text: "Pehle statement dekho phir baat karo. Roz roz call mat karo.",
        sentiment: "negative",
      },
      {
        speaker: "agent",
        ts: "0:38",
        text: "Bilkul ji. Tab tak calls pause kar deti hoon. Statement aane ke baad hi contact karenge.",
        sentiment: "neutral",
      },
    ],
  },
  {
    id: "REC-1006",
    date: "27 Jun 2026",
    time: "09:50 AM",
    agentName: "Mohit Rao",
    callerType: "agent",
    debtorName: "Arjun Kapoor",
    debtorId: "L-10068",
    duration: "3:02",
    durationSecs: 182,
    sentiment: "calm",
    sentimentScore: 71,
    outcome: "PTP",
    portfolio: "Two-Wheeler Auto",
    bucket: "1",
    flagged: false,
    aiNotes:
      "First-time defaulter. Very polite and apologetic. Promised EMI payment of ₹4,500 by Friday. Agent correctly identified this as low-risk and kept the call short and friendly.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "agent",
        ts: "0:00",
        text: "Arjun ji, Mohit here from RecoveryAI. Your two-wheeler EMI of ₹4,500 is overdue.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:09",
        text: "Sir, I'm really sorry. I just forgot this month. Will pay by Friday.",
        sentiment: "neutral",
      },
      {
        speaker: "agent",
        ts: "0:16",
        text: "No worries at all. I'll mark it as PTP. I'll send you a reminder on Thursday.",
        sentiment: "positive",
      },
      {
        speaker: "debtor",
        ts: "0:23",
        text: "Thank you sir. Really appreciate the understanding.",
        sentiment: "positive",
      },
    ],
  },
  {
    id: "REC-1007",
    date: "27 Jun 2026",
    time: "02:10 PM",
    agentName: "AI Bot",
    callerType: "ai",
    debtorName: "Rohan Mehta",
    debtorId: "L-10501",
    duration: "0:48",
    durationSecs: 48,
    sentiment: "negative",
    sentimentScore: 22,
    outcome: "No Answer",
    portfolio: "MSME Working Cap",
    bucket: "2",
    flagged: false,
    aiNotes:
      "Call connected but debtor disconnected after 12 seconds without speaking. Possible call avoidance. Queued for rechurn tomorrow at 11 AM.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "ai",
        ts: "0:00",
        text: "Namaskar Rohan ji. RecoveryAI calling regarding your MSME loan outstanding.",
        sentiment: "neutral",
      },
      { speaker: "debtor", ts: "0:08", text: "[call disconnected]", sentiment: "neutral" },
    ],
  },
  {
    id: "REC-1008",
    date: "26 Jun 2026",
    time: "11:22 AM",
    agentName: "Leena Krishnan",
    callerType: "agent",
    debtorName: "Geeta Menon",
    debtorId: "L-10523",
    duration: "5:14",
    durationSecs: 314,
    sentiment: "rude",
    sentimentScore: 12,
    outcome: "Refused",
    portfolio: "Two-Wheeler Auto",
    bucket: "WriteOff",
    flagged: true,
    flagReason:
      "Debtor was verbally hostile. Leena handled professionally — no escalation of tone from agent side.",
    aiNotes:
      "Debtor was aggressively hostile from the first 30 seconds. Agent Leena maintained professional composure throughout — exemplary conduct. Debtor refused to discuss. Account flagged for field visit.",
    recordingUrl: "#",
    transcript: [
      {
        speaker: "agent",
        ts: "0:00",
        text: "Geeta ji, Leena calling from RecoveryAI. I'm calling about your two-wheeler loan.",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:08",
        text: "I don't want to talk. Stop calling me every day.",
        sentiment: "negative",
      },
      {
        speaker: "agent",
        ts: "0:14",
        text: "I understand you're frustrated. I just need 2 minutes — can we find a way to resolve this?",
        sentiment: "neutral",
      },
      {
        speaker: "debtor",
        ts: "0:22",
        text: "There's nothing to resolve. Do what you want.",
        sentiment: "aggressive",
      },
      {
        speaker: "agent",
        ts: "0:28",
        text: "Okay Geeta ji, I'll note that and have a field representative reach out instead. Take care.",
        sentiment: "neutral",
      },
    ],
  },
];

/* ─── sentiment config ──────────────────────────────────────────────────── */

const SENTIMENT_CFG: Record<
  Sentiment,
  {
    label: string;
    icon: typeof ThumbsUp;
    iconCls: string;
    badgeCls: string;
    cardCls: string;
    barCls: string;
  }
> = {
  positive: {
    label: "Positive",
    icon: ThumbsUp,
    iconCls: "text-success",
    badgeCls: "bg-success/15 text-success border-success/30",
    cardCls: "border-success/25 bg-success/5",
    barCls: "bg-success",
  },
  negative: {
    label: "Negative",
    icon: ThumbsDown,
    iconCls: "text-destructive",
    badgeCls: "bg-destructive/15 text-destructive border-destructive/30",
    cardCls: "border-destructive/25 bg-destructive/5",
    barCls: "bg-destructive",
  },
  rude: {
    label: "Rude",
    icon: AlertTriangle,
    iconCls: "text-orange-500",
    badgeCls: "bg-orange-500/15 text-orange-500 border-orange-500/30",
    cardCls: "border-orange-500/25 bg-orange-500/5",
    barCls: "bg-orange-500",
  },
  calm: {
    label: "Calm",
    icon: Wind,
    iconCls: "text-primary",
    badgeCls: "bg-primary/15 text-primary border-primary/30",
    cardCls: "border-primary/25 bg-primary/5",
    barCls: "bg-primary",
  },
};

const SPEAKER_STYLE: Record<
  TranscriptLine["speaker"],
  { label: string; cls: string; align: string }
> = {
  agent: { label: "Agent", cls: "bg-primary text-primary-foreground", align: "justify-end" },
  ai: { label: "AI Bot", cls: "bg-purple-500/80 text-white", align: "justify-end" },
  debtor: {
    label: "Debtor",
    cls: "bg-card border border-border text-foreground",
    align: "justify-start",
  },
};

const LINE_SENTIMENT_CLS: Record<NonNullable<TranscriptLine["sentiment"]>, string> = {
  neutral: "",
  positive: "ring-1 ring-success/40",
  negative: "ring-1 ring-destructive/40",
  aggressive: "ring-1 ring-orange-500/60",
};

/* ─── helpers ────────────────────────────────────────────────────────────── */

function fmtDuration(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ─── sub-components ─────────────────────────────────────────────────────── */

function SummaryCard({
  sentiment,
  count,
  pct,
  selected,
  onClick,
}: {
  sentiment: Sentiment;
  count: number;
  pct: number;
  selected: boolean;
  onClick: () => void;
}) {
  const cfg = SENTIMENT_CFG[sentiment];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-xl border p-4 text-left transition-all hover:shadow-md",
        selected ? cfg.cardCls + " shadow-md" : "border-border bg-card hover:border-primary/30",
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <cfg.icon className={cn("h-5 w-5", cfg.iconCls)} />
        <Badge variant="outline" className={cn("text-[10px]", selected ? cfg.badgeCls : "")}>
          {pct}%
        </Badge>
      </div>
      <div className="text-2xl font-bold text-foreground">{count}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{cfg.label} calls</div>
      <Progress value={pct} className="mt-2 h-1" indicatorClassName={cfg.barCls} />
    </button>
  );
}

function RecordingPlayer({ call }: { call: CallRecord }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
      </button>
      <div className="flex-1 space-y-1">
        <div
          className="relative h-1.5 w-full rounded-full bg-border overflow-hidden cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setProgress(((e.clientX - rect.left) / rect.width) * 100);
          }}
        >
          <div
            className="absolute h-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{fmtDuration(Math.round((progress / 100) * call.durationSecs))}</span>
          <span>{call.duration}</span>
        </div>
      </div>
      <Volume2 className="h-4 w-4 text-muted-foreground" />
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
        title="Download recording"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TranscriptView({ lines }: { lines: TranscriptLine[] }) {
  return (
    <ScrollArea className="h-72 pr-2">
      <div className="space-y-3 py-1">
        {lines.map((line, i) => {
          const style = SPEAKER_STYLE[line.speaker];
          const sentCls = line.sentiment ? LINE_SENTIMENT_CLS[line.sentiment] : "";
          return (
            <div key={i} className={cn("flex gap-2", style.align)}>
              {style.align === "justify-start" && (
                <div className="flex h-6 w-6 shrink-0 mt-1 items-center justify-center rounded-full bg-muted border border-border">
                  <User className="h-3 w-3 text-muted-foreground" />
                </div>
              )}
              <div className="max-w-[75%] space-y-0.5">
                <div
                  className={cn(
                    "rounded-2xl px-3 py-2 text-xs leading-relaxed",
                    style.cls,
                    sentCls,
                    style.align === "justify-end" ? "rounded-tr-sm" : "rounded-tl-sm",
                  )}
                >
                  {line.text}
                </div>
                <div
                  className={cn(
                    "text-[10px] text-muted-foreground px-1",
                    style.align === "justify-end" ? "text-right" : "text-left",
                  )}
                >
                  {style.label} · {line.ts}
                  {line.sentiment && line.sentiment !== "neutral" && (
                    <span
                      className={cn(
                        "ml-1.5",
                        line.sentiment === "positive"
                          ? "text-success"
                          : line.sentiment === "aggressive"
                            ? "text-orange-500"
                            : "text-destructive",
                      )}
                    >
                      [{line.sentiment}]
                    </span>
                  )}
                </div>
              </div>
              {style.align === "justify-end" && (
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 mt-1 items-center justify-center rounded-full",
                    line.speaker === "ai" ? "bg-purple-500/20" : "bg-primary/20",
                  )}
                >
                  {line.speaker === "ai" ? (
                    <Bot className="h-3 w-3 text-purple-500" />
                  ) : (
                    <User className="h-3 w-3 text-primary" />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function CallDetailSheet({ call, onClose }: { call: CallRecord; onClose: () => void }) {
  const [tab, setTab] = useState<"transcript" | "notes">("transcript");
  const cfg = SENTIMENT_CFG[call.sentiment];

  return (
    <div className="flex flex-col h-full">
      <SheetHeader className="px-6 py-4 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div>
            <SheetTitle className="text-base">{call.debtorName}</SheetTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {call.debtorId} · {call.date} {call.time} · {call.portfolio}
            </p>
          </div>
          <Badge variant="outline" className={cn("shrink-0", cfg.badgeCls)}>
            <cfg.icon className="h-3 w-3 mr-1" />
            {cfg.label}
          </Badge>
        </div>

        {/* meta row */}
        <div className="grid grid-cols-3 gap-3 mt-3">
          {[
            {
              icon: call.callerType === "ai" ? Bot : User,
              label: call.callerType === "ai" ? "AI Bot" : call.agentName,
            },
            { icon: Clock, label: call.duration },
            { icon: Mic, label: call.outcome },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-foreground"
            >
              <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {label}
            </div>
          ))}
        </div>

        {/* sentiment score bar */}
        <div className="mt-3 space-y-1">
          <div className="flex justify-between text-[11px]">
            <span className="text-muted-foreground">Sentiment score</span>
            <span className={cn("font-semibold", cfg.iconCls)}>{call.sentimentScore}/100</span>
          </div>
          <Progress value={call.sentimentScore} className="h-1.5" indicatorClassName={cfg.barCls} />
        </div>

        {call.flagged && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-500">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{call.flagReason}</span>
          </div>
        )}
      </SheetHeader>

      {/* Recording player */}
      <div className="px-6 pt-4 pb-2">
        <RecordingPlayer call={call} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        {(["transcript", "notes"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "py-2.5 px-1 mr-4 text-xs font-medium border-b-2 transition-colors capitalize",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "transcript" ? "Transcript" : "AI Notes"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden px-6 py-4">
        {tab === "transcript" ? (
          <TranscriptView lines={call.transcript} />
        ) : (
          <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-foreground leading-relaxed">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="h-4 w-4 text-purple-500" />
              <span className="text-xs font-semibold text-foreground">AI Analysis Summary</span>
            </div>
            {call.aiNotes}
          </div>
        )}
      </div>

      <div className="border-t border-border px-6 py-3 flex gap-2">
        <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs">
          <Download className="h-3.5 w-3.5" />
          Download Recording
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs">
          <FileText className="h-3.5 w-3.5" />
          Export Transcript
        </Button>
      </div>
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function CallAuditPage() {
  const [search, setSearch] = useState("");
  const [filterSentiment, setFilterSentiment] = useState<Sentiment | "all">("all");
  const [filterCaller, setFilterCaller] = useState<CallerType | "all">("all");
  const [filterFlagged, setFilterFlagged] = useState<"all" | "flagged">("all");
  const [filterBucket, setFilterBucket] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [selected, setSelected] = useState<CallRecord | null>(null);
  const [activeSummaryFilter, setActiveSummaryFilter] = useState<Sentiment | null>(null);

  const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

  const sentimentCounts = useMemo(() => {
    const counts: Record<Sentiment, number> = { positive: 0, negative: 0, rude: 0, calm: 0 };
    MOCK_CALLS.forEach((c) => counts[c.sentiment]++);
    return counts;
  }, []);
  const total = MOCK_CALLS.length;

  const filtered = useMemo(() => {
    return MOCK_CALLS.filter((c) => {
      if (activeSummaryFilter && c.sentiment !== activeSummaryFilter) return false;
      if (filterSentiment !== "all" && c.sentiment !== filterSentiment) return false;
      if (filterCaller !== "all" && c.callerType !== filterCaller) return false;
      if (filterFlagged === "flagged" && !c.flagged) return false;
      if (filterBucket !== "all" && c.bucket !== filterBucket) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !c.debtorName.toLowerCase().includes(q) &&
          !c.agentName.toLowerCase().includes(q) &&
          !c.debtorId.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [search, filterSentiment, filterCaller, filterFlagged, filterBucket, activeSummaryFilter]);

  const toggleSummaryFilter = (s: Sentiment) =>
    setActiveSummaryFilter((prev) => (prev === s ? null : s));

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Audit</h1>
            <p className="text-sm text-muted-foreground">
              Every agent and AI call is recorded, transcribed, and auto-tagged by sentiment.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-2 w-2 rounded-full bg-success animate-pulse" />
            <span className="text-xs text-success font-medium">Recording active</span>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["positive", "negative", "rude", "calm"] as Sentiment[]).map((s) => (
            <SummaryCard
              key={s}
              sentiment={s}
              count={sentimentCounts[s]}
              pct={Math.round((sentimentCounts[s] / total) * 100)}
              selected={activeSummaryFilter === s}
              onClick={() => toggleSummaryFilter(s)}
            />
          ))}
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Total Recorded", value: total, sub: "last 3 days" },
            {
              label: "AI Bot Calls",
              value: MOCK_CALLS.filter((c) => c.callerType === "ai").length,
              sub: `${Math.round((MOCK_CALLS.filter((c) => c.callerType === "ai").length / total) * 100)}% of total`,
            },
            {
              label: "Agent Calls",
              value: MOCK_CALLS.filter((c) => c.callerType === "agent").length,
              sub: `${Math.round((MOCK_CALLS.filter((c) => c.callerType === "agent").length / total) * 100)}% of total`,
            },
            {
              label: "Flagged",
              value: MOCK_CALLS.filter((c) => c.flagged).length,
              sub: "need review",
              cls: "text-orange-500",
            },
          ].map(({ label, value, sub, cls }) => (
            <Card key={label} className="p-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
              </div>
              <div className={cn("text-2xl font-bold mt-1", cls ?? "text-foreground")}>{value}</div>
              <div className="text-[10px] text-muted-foreground">{sub}</div>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search debtor, agent, ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Select
            value={filterSentiment}
            onValueChange={(v) => {
              setFilterSentiment(v as any);
              setActiveSummaryFilter(null);
            }}
          >
            <SelectTrigger className="w-36 h-9 text-xs">
              <SelectValue placeholder="Sentiment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sentiments</SelectItem>
              <SelectItem value="positive">Positive</SelectItem>
              <SelectItem value="negative">Negative</SelectItem>
              <SelectItem value="rude">Rude</SelectItem>
              <SelectItem value="calm">Calm</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterCaller} onValueChange={(v) => setFilterCaller(v as any)}>
            <SelectTrigger className="w-32 h-9 text-xs">
              <SelectValue placeholder="Caller" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Agent + AI</SelectItem>
              <SelectItem value="agent">Agent only</SelectItem>
              <SelectItem value="ai">AI Bot only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterFlagged} onValueChange={(v) => setFilterFlagged(v as any)}>
            <SelectTrigger className="w-32 h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All calls</SelectItem>
              <SelectItem value="flagged">Flagged only</SelectItem>
            </SelectContent>
          </Select>

          {/* Bucket dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setBucketDropOpen((p) => !p)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs transition-all",
                filterBucket !== "all"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {filterBucket === "all" ? "Bucket" : BUCKET_META[filterBucket].label}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {bucketDropOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-border bg-card shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setFilterBucket("all");
                    setBucketDropOpen(false);
                  }}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-xs hover:bg-accent/50 transition-colors",
                    filterBucket === "all"
                      ? "text-foreground font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  All buckets
                </button>
                {BUCKET_ORDER.map((b) => {
                  const count = MOCK_CALLS.filter((c) => c.bucket === b).length;
                  if (count === 0) return null;
                  const meta = BUCKET_META[b];
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => {
                        setFilterBucket(b);
                        setBucketDropOpen(false);
                      }}
                      className={cn(
                        "w-full px-3 py-1.5 text-left text-xs hover:bg-accent/50 transition-colors flex items-center justify-between",
                        filterBucket === b
                          ? "text-foreground font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      <span className={meta.color.split(" ").find((c) => c.startsWith("text-"))}>
                        {meta.label}
                      </span>
                      <span className="opacity-50">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {(activeSummaryFilter ||
            filterSentiment !== "all" ||
            filterCaller !== "all" ||
            filterFlagged !== "all" ||
            filterBucket !== "all" ||
            search) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-muted-foreground gap-1"
              onClick={() => {
                setSearch("");
                setFilterSentiment("all");
                setFilterCaller("all");
                setFilterFlagged("all");
                setFilterBucket("all");
                setActiveSummaryFilter(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">{filtered.length} calls</span>
        </div>

        {/* Call table */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="py-2.5 pl-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Call
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Caller
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Debtor
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Outcome
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground min-w-[140px]">
                    Sentiment
                  </th>
                  <th className="py-2.5 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Dur.
                  </th>
                  <th className="py-2.5 pr-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((call) => {
                  const cfg = SENTIMENT_CFG[call.sentiment];
                  return (
                    <tr
                      key={call.id}
                      className="hover:bg-accent/30 transition-colors cursor-pointer"
                      onClick={() => setSelected(call)}
                    >
                      <td className="py-3 pl-4">
                        <div className="flex items-center gap-2">
                          {call.flagged && (
                            <AlertTriangle className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                          )}
                          <div>
                            <div className="text-xs font-mono text-muted-foreground">{call.id}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {call.date} {call.time}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1.5">
                          {call.callerType === "ai" ? (
                            <Bot className="h-3.5 w-3.5 text-purple-500" />
                          ) : (
                            <User className="h-3.5 w-3.5 text-primary" />
                          )}
                          <span className="text-xs text-foreground">
                            {call.callerType === "ai" ? "AI Bot" : call.agentName}
                          </span>
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="text-xs font-medium text-foreground">{call.debtorName}</div>
                        <div className="text-[10px] text-muted-foreground">{call.debtorId}</div>
                      </td>
                      <td className="py-3">
                        <Badge variant="secondary" className="text-[10px]">
                          {call.outcome}
                        </Badge>
                        <span
                          className={cn(
                            "ml-1.5 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-medium",
                            BUCKET_META[call.bucket].color,
                          )}
                        >
                          {BUCKET_META[call.bucket].label}
                        </span>
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] gap-1", cfg.badgeCls)}
                          >
                            <cfg.icon className="h-2.5 w-2.5" />
                            {cfg.label}
                          </Badge>
                          <div className="flex-1 max-w-[60px]">
                            <Progress
                              value={call.sentimentScore}
                              className="h-1"
                              indicatorClassName={cfg.barCls}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground w-6">
                            {call.sentimentScore}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 text-center">
                        <span className="text-xs text-muted-foreground">{call.duration}</span>
                      </td>
                      <td className="py-3 pr-4 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs gap-1 text-primary hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(call);
                          }}
                        >
                          <Play className="h-3 w-3" />
                          Review
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                      No calls match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Detail sheet */}
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full max-w-2xl p-0 overflow-hidden flex flex-col sm:max-w-2xl"
        >
          {selected && <CallDetailSheet call={selected} onClose={() => setSelected(null)} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
