import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Send, CheckCheck, Check, Plus, Paperclip, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/messages")({
  head: () => ({ meta: [{ title: "Messages · RecoveryAI" }] }),
  component: MessagesPage,
});

interface Conversation {
  id: string;
  name: string;
  phone: string;
  lastMessage: string;
  time: string;
  unread: number;
  messages: { id: string; out: boolean; text: string; time: string; status: "sent" | "delivered" | "read" }[];
}

const CONVERSATIONS: Conversation[] = [
  {
    id: "L-10042", name: "Rahul Sharma", phone: "+91 98XXX XX789",
    lastMessage: "Haan sir, kal tak kar dunga UPI se.", time: "10:18 AM", unread: 0,
    messages: [
      { id: "1", out: true, text: "Namaste Rahul ji, aapka EMI ₹8,200 abhi due hai. Kripya aaj payment karein.", time: "10:15 AM", status: "read" },
      { id: "2", out: false, text: "Haan sir, kal tak kar dunga UPI se.", time: "10:18 AM", status: "read" },
      { id: "3", out: true, text: "Bilkul, payment link bhej raha hoon. pay.recoveryai.in/L10042", time: "10:19 AM", status: "delivered" },
    ],
  },
  {
    id: "L-10018", name: "Priya Iyer", phone: "+91 90XXX XX221",
    lastMessage: "Sure, I will transfer by EOD today.", time: "9:55 AM", unread: 2,
    messages: [
      { id: "1", out: true, text: "Hi Priya, your credit card outstanding of ₹87,500 is overdue. Can we resolve this today?", time: "9:50 AM", status: "read" },
      { id: "2", out: false, text: "My salary got credited yesterday. Sure, I will transfer by EOD today.", time: "9:55 AM", status: "read" },
      { id: "3", out: false, text: "Please send me the payment link.", time: "9:56 AM", status: "read" },
    ],
  },
  {
    id: "L-10211", name: "Amit Verma", phone: "+91 99XXX XX104",
    lastMessage: "Partial payment done. Rest by Friday.", time: "Yesterday", unread: 0,
    messages: [
      { id: "1", out: true, text: "Amit ji, ₹1,25,000 outstanding hai. PTP confirm karna chahenge?", time: "Yesterday 3:00 PM", status: "read" },
      { id: "2", out: false, text: "Partial payment done. Rest by Friday.", time: "Yesterday 3:20 PM", status: "read" },
    ],
  },
  {
    id: "L-10455", name: "Ananya Bose", phone: "+91 91XXX XX334",
    lastMessage: "Can you send the payment link again?", time: "Yesterday", unread: 1,
    messages: [
      { id: "1", out: true, text: "Dear Ananya, your EMI is overdue. Please clear at earliest.", time: "Yesterday 11:00 AM", status: "read" },
      { id: "2", out: false, text: "Can you send the payment link again?", time: "Yesterday 11:45 AM", status: "read" },
    ],
  },
  {
    id: "L-10087", name: "Sneha Reddy", phone: "+91 97XXX XX556",
    lastMessage: "Ok will check and revert.", time: "Mon", unread: 0,
    messages: [
      { id: "1", out: true, text: "Hi Sneha, gentle reminder for your EMI of ₹64,000.", time: "Mon 2:00 PM", status: "read" },
      { id: "2", out: false, text: "Ok will check and revert.", time: "Mon 2:30 PM", status: "read" },
    ],
  },
];

const TEMPLATES = [
  { value: "ptp", label: "PTP Confirmation", text: "We've noted your commitment to pay by {date}. We will follow up accordingly. Thank you." },
  { value: "reminder", label: "EMI Reminder", text: "Dear {name}, your EMI of {amount} is due today. Kindly clear at the earliest to avoid penalties." },
  { value: "paylink", label: "Payment Link", text: "Hi {name}, here's your secure payment link: pay.recoveryai.in/{id}. Valid for 48 hours." },
  { value: "settlement", label: "Settlement Offer", text: "Special offer: Settle your outstanding at a 20% waiver. Valid till {date}. Contact us to confirm." },
];

function MessagesPage() {
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id);
  const [template, setTemplate] = useState("");
  const [includeLink, setIncludeLink] = useState(false);
  const [input, setInput] = useState("");

  const active = CONVERSATIONS.find((c) => c.id === activeId)!;

  const handleTemplateChange = (val: string) => {
    setTemplate(val);
    const t = TEMPLATES.find((t) => t.value === val);
    if (t) setInput(t.text.replace("{name}", active.name).replace("{id}", activeId));
  };

  const handleSend = () => {
    if (!input.trim()) return;
    toast.success("Message sent to " + active.name);
    setInput("");
    setTemplate("");
  };

  return (
    <div className="animate-in fade-in duration-500 h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Messages</h1>
          <p className="text-sm text-muted-foreground">WhatsApp conversations with your debtors.</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => toast.info("Campaign builder coming soon")}>
          <Plus className="h-4 w-4" />New Campaign
        </Button>
      </div>

      <div className="flex flex-1 rounded-xl border border-border overflow-hidden min-h-0">
        {/* Sidebar */}
        <div className="w-72 border-r border-border flex flex-col flex-shrink-0 bg-card">
          <div className="p-3 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Conversations
          </div>
          <ScrollArea className="flex-1">
            {CONVERSATIONS.map((c) => {
              const initials = c.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase();
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent",
                    activeId === c.id && "bg-primary/10 border-l-2 border-primary",
                  )}
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-1">{c.time}</span>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs text-muted-foreground truncate">{c.lastMessage}</span>
                      {c.unread > 0 && (
                        <Badge className="h-4 w-4 p-0 text-[9px] flex items-center justify-center rounded-full bg-primary text-primary-foreground flex-shrink-0">
                          {c.unread}
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </ScrollArea>
        </div>

        {/* Chat panel */}
        <div className="flex flex-1 flex-col min-w-0 bg-background">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                {active.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <div className="text-sm font-semibold text-foreground">{active.name}</div>
              <div className="text-xs text-muted-foreground">{active.phone}</div>
            </div>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 px-4 py-4">
            <div className="space-y-3">
              {active.messages.map((m) => (
                <div key={m.id} className={cn("flex", m.out ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "max-w-[70%] rounded-2xl px-3 py-2 text-sm",
                    m.out
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-card border border-border text-foreground rounded-bl-sm",
                  )}>
                    <p className="leading-relaxed">{m.text}</p>
                    <div className={cn(
                      "flex items-center gap-1 mt-1 text-[10px]",
                      m.out ? "justify-end text-primary-foreground/60" : "text-muted-foreground",
                    )}>
                      {m.time}
                      {m.out && m.status === "read" && <CheckCheck className="h-3 w-3 text-blue-400" />}
                      {m.out && m.status === "delivered" && <CheckCheck className="h-3 w-3 opacity-70" />}
                      {m.out && m.status === "sent" && <Check className="h-3 w-3 opacity-70" />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Compose */}
          <div className="border-t border-border bg-card p-3 space-y-2">
            <div className="flex items-center gap-3">
              <Select value={template} onValueChange={handleTemplateChange}>
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue placeholder="Select template…" />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATES.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2 ml-auto">
                <Switch id="paylink" checked={includeLink} onCheckedChange={setIncludeLink} className="scale-75" />
                <Label htmlFor="paylink" className="text-xs text-muted-foreground flex items-center gap-1 cursor-pointer">
                  <Link2 className="h-3 w-3" />Include Payment Link
                </Label>
              </div>
            </div>
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                rows={2}
                className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend(); }}
              />
              <Button onClick={handleSend} className="h-full bg-success text-success-foreground hover:bg-success/90 px-4 self-stretch transition-all active:scale-95">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
