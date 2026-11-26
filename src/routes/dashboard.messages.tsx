import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { Phone, Radio, FileDown, Clock } from "lucide-react";

function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const sanitize = (v: string | number) => {
    const s = String(v);
    return /^[=+\-@]/.test(s) ? `\t${s}` : s;
  };
  const escape = (v: string | number) => `"${sanitize(v).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "@/components/date-range-filter";
import { EMPTY_RANGE, inDateRange, type DateRange } from "@/lib/date-filter";
import { getMessages, refreshMessages, type MessageRecord } from "@/lib/messages-store";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";

export const Route = createFileRoute("/dashboard/messages")({
  head: () => ({ meta: [{ title: "Messages · SamvadX" }] }),
  component: MessagesPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "ivr" | "sms";

const IVR_OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP Captured",
  refused: "Refused",
  no_answer: "No Answer",
  voicemail: "Voicemail",
  dispute: "Dispute",
  callback: "Callback Requested",
  settlement: "Settlement",
};

const MSG_STATUS_META: Record<MessageRecord["status"], { label: string; cls: string }> = {
  sent: { label: "Sent", cls: "bg-muted text-muted-foreground border-border" },
  delivered: { label: "Delivered", cls: "bg-success/8 text-success/70 border-success/15" },
  read: { label: "Read", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
  failed: { label: "Failed", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  replied: { label: "Replied", cls: "bg-success/8 text-success/70 border-success/15" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function MessagesPage() {
  const [activeTab, setActiveTab] = useState<Tab>("ivr");
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_RANGE);

  const [messages, setMessages] = useState<MessageRecord[]>(() => getMessages());
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());

  useEffect(() => {
    const loadMessages = () => setMessages(getMessages());
    const loadDisps = () => setDisps(getDispositions());

    window.addEventListener("messages-updated", loadMessages);
    window.addEventListener("dispositions-updated", loadDisps);

    refreshMessages()
      .then(loadMessages)
      .catch((e) => console.warn("[messages] refresh failed:", e));
    refreshDispositions()
      .then(loadDisps)
      .catch((e) => console.warn("[messages] disposition refresh failed:", e));

    return () => {
      window.removeEventListener("messages-updated", loadMessages);
      window.removeEventListener("dispositions-updated", loadDisps);
    };
  }, []);

  const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "ivr", label: "IVR Calls", icon: Radio },
    { key: "sms", label: "SMS", icon: Phone },
  ];

  // ── IVR: real call_logs where call_type = 'ivr' ──
  const ivrRecords = useMemo(
    () =>
      disps
        .filter((d) => d.callType === "ivr")
        .filter((d) => inDateRange(d.time, dateRange))
        .sort((a, b) => b.time.localeCompare(a.time)),
    [disps, dateRange],
  );

  // ── SMS: real messages where channel = 'sms' ──
  const smsRecords = useMemo(
    () =>
      messages
        .filter((m) => m.channel === "sms")
        .filter((m) => inDateRange(m.sentAt, dateRange))
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt)),
    [messages, dateRange],
  );

  return (
    <div className="animate-in fade-in duration-500 space-y-4 h-[calc(100vh-6rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Messages</h1>
          <p className="text-sm text-muted-foreground">IVR call logs and SMS delivery status.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              activeTab === "ivr"
                ? exportCSV(
                    "ivr-calls.csv",
                    ["Time", "Debtor", "Phone", "Duration", "Outcome", "Notes"],
                    ivrRecords.map((r) => [
                      formatDateTime(r.time),
                      r.debtorName || "",
                      r.phone || "",
                      formatDuration(r.durationSeconds),
                      IVR_OUTCOME_LABEL[r.outcome] ?? r.outcome,
                      r.notes || "",
                    ]),
                  )
                : exportCSV(
                    "sms.csv",
                    ["Time", "Debtor", "Phone", "Template", "Message", "Status"],
                    smsRecords.map((r) => [
                      formatDateTime(r.sentAt),
                      r.debtorName || "",
                      r.phone || "",
                      r.templateName ?? "",
                      r.content,
                      MSG_STATUS_META[r.status].label,
                    ]),
                  )
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <FileDown className="h-3.5 w-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1 w-fit flex-shrink-0">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                "flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-all duration-150",
                activeTab === t.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* IVR */}
      {activeTab === "ivr" && (
        <div className="flex-1 overflow-auto">
          <div className="mb-3 flex justify-end">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-4">
            {[
              { label: "Total IVR Calls", value: ivrRecords.length },
              {
                label: "PTP Captured",
                value: ivrRecords.filter((r) => r.outcome === "promised").length,
              },
              {
                label: "No Answer",
                value: ivrRecords.filter((r) => r.outcome === "no_answer").length,
              },
              {
                label: "Callback Requested",
                value: ivrRecords.filter((r) => r.outcome === "callback").length,
              },
              {
                label: "Disputes",
                value: ivrRecords.filter((r) => r.outcome === "dispute").length,
              },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-foreground">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Debtor</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="min-w-[200px]">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ivrRecords.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No IVR calls logged yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {ivrRecords.map((r) => (
                      <TableRow key={r.id} className="hover:bg-primary/5 align-top">
                        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                          <Clock className="inline h-3 w-3 mr-1 opacity-60" />
                          {formatDateTime(r.time)}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium text-foreground">
                            {r.debtorName || "—"}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {r.phone || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-sm tabular-nums">
                          {formatDuration(r.durationSeconds)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            {IVR_OUTCOME_LABEL[r.outcome] ?? r.outcome}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-foreground/80">
                          {r.notes || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* SMS */}
      {activeTab === "sms" && (
        <div className="flex-1 overflow-auto">
          <div className="mb-3 flex justify-end">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
            {[
              { label: "Total Sent", value: smsRecords.length },
              {
                label: "Delivered",
                value: smsRecords.filter((r) => r.status === "delivered" || r.status === "read")
                  .length,
              },
              { label: "Read", value: smsRecords.filter((r) => r.status === "read").length },
              { label: "Failed", value: smsRecords.filter((r) => r.status === "failed").length },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-foreground">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Debtor</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Template</TableHead>
                      <TableHead className="min-w-[300px]">Message</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {smsRecords.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No SMS sent yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {smsRecords.map((r) => {
                      const meta = MSG_STATUS_META[r.status];
                      return (
                        <TableRow key={r.id} className="hover:bg-primary/5 align-top">
                          <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                            {formatDateTime(r.sentAt)}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm font-medium text-foreground">
                              {r.debtorName || "—"}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.phone || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              {r.templateName ?? "—"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground/80 leading-relaxed">
                              {r.content}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("text-xs", meta.cls)}>
                              {meta.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
