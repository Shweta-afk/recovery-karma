import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getAccessToken } from "@/lib/access-token";
import { errorText } from "@/lib/app-error";
import { useCompanyFeatures } from "@/lib/use-company-features";
import { listReportEmailLists, type ReportEmailList } from "@/lib/report-email.server";
import {
  deleteReportSchedule,
  listReportSchedules,
  saveReportSchedule,
  sendReportScheduleNow,
} from "@/lib/report-schedule.server";
import { WEEKDAY_SHORT, type ReportSchedule } from "@/lib/report-schedule";
import {
  MIS_SHEETS,
  MIS_SHEET_LABEL,
  SCHEDULE_SHEET_EVENT,
  SHEET_SCHEDULE_DEFAULT,
  type MisSheetKey,
} from "@/lib/collection-mis-email";

type Draft = Omit<ReportSchedule, "id" | "clientId" | "lastSentOn" | "lastResult"> & {
  id?: string;
};

const blank = (listId: string): Draft => ({
  name: "Daily Collection MIS",
  listId,
  sheets: ["daily"],
  sendTime: "09:00",
  weekdays: [1, 2, 3, 4, 5, 6],
  reportDay: "yesterday",
  enabled: true,
});

/** Admin → Collection MIS: MIS emails sent automatically at a set time. Only for companies with
 *  both "Collection MIS" and "Report emails" switched on. */
export function ReportSchedulesCard() {
  const f = useCompanyFeatures();
  if (!f.misReports || !f.reportEmails) return null;
  return <Inner />;
}

function Inner() {
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [lists, setLists] = useState<ReportEmailList[]>([]);
  const [ready, setReady] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const [s, l] = await Promise.all([
        listReportSchedules({ data: { accessToken } }),
        listReportEmailLists({ data: { accessToken } }),
      ]);
      setSchedules(s.schedules);
      setReady(s.emailReady);
      setLists(l.lists);
    } catch (e) {
      toast.error(errorText(e, "Could not load scheduled emails"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A sheet's "Schedule" button on the MIS page opens a new schedule for that sheet alone.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const key = (e as CustomEvent<MisSheetKey>).detail;
      if (!(MIS_SHEETS as readonly string[]).includes(key)) return;
      if (!lists.length) {
        toast.error("Create a report email list first (Admin → Settings → Report email lists).");
        return;
      }
      setDraft({
        ...blank(lists[0].id),
        name: MIS_SHEET_LABEL[key],
        sheets: [key],
        ...SHEET_SCHEDULE_DEFAULT[key],
      });
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener(SCHEDULE_SHEET_EVENT, open);
    return () => window.removeEventListener(SCHEDULE_SHEET_EVENT, open);
  }, [lists]);

  const listName = (id: string) => lists.find((l) => l.id === id)?.name ?? "—";

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      await saveReportSchedule({ data: { accessToken: await getAccessToken(), ...draft } });
      setDraft(null);
      await load();
      toast.success("Schedule saved");
    } catch (e) {
      toast.error(errorText(e, "Could not save the schedule"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: ReportSchedule) => {
    if (!confirm(`Delete the schedule "${s.name}"?`)) return;
    try {
      await deleteReportSchedule({ data: { accessToken: await getAccessToken(), id: s.id } });
      await load();
    } catch (e) {
      toast.error(errorText(e, "Could not delete the schedule"));
    }
  };

  const sendNow = async (s: ReportSchedule) => {
    setBusy(s.id);
    try {
      const r = await sendReportScheduleNow({
        data: { accessToken: await getAccessToken(), id: s.id },
      });
      toast.success(`Sent: ${r.result}`);
      await load();
    } catch (e) {
      toast.error(errorText(e, "Could not send"));
    } finally {
      setBusy(null);
    }
  };

  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <Card ref={cardRef}>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" /> Scheduled emails
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          The MIS emailed automatically at a set time (IST) to one of your report email lists — the
          sheets in the email body and attached as Excel. Every team in the company is included.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-3 text-sm">
        {!ready && (
          <p className="text-xs text-amber-600">
            Email sending isn't switched on for SamvadX yet, so nothing will go out until it is.
          </p>
        )}
        {!lists.length && (
          <p className="text-xs text-muted-foreground">
            Create a report email list first (Admin → Settings → Report email lists).
          </p>
        )}
        {schedules.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {s.name}{" "}
                {!s.enabled && (
                  <span className="text-xs font-normal text-muted-foreground">(paused)</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.sendTime} IST · {s.weekdays.map((d) => WEEKDAY_SHORT[d]).join(", ")} · to{" "}
                {listName(s.listId)} · MIS for{" "}
                {s.reportDay === "yesterday" ? "the day before" : "that day so far"}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.sheets.map((k) => MIS_SHEET_LABEL[k]).join(" · ")}
              </p>
              {s.lastResult && (
                <p className="text-xs text-muted-foreground">
                  Last: {s.lastSentOn} — {s.lastResult}
                </p>
              )}
            </div>
            <div className="flex gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={busy === s.id}
                onClick={() => sendNow(s)}
              >
                {busy === s.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}{" "}
                Send now
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Edit"
                onClick={() => setDraft({ ...s })}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => remove(s)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}

        {draft ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <Input
              value={draft.name}
              maxLength={80}
              placeholder="Name, e.g. Morning MIS"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-muted-foreground">
                Send to{" "}
                <select
                  className="ml-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={draft.listId}
                  onChange={(e) => setDraft({ ...draft, listId: e.target.value })}
                >
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.emails.length})
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                At{" "}
                <Input
                  type="time"
                  className="ml-1 inline-block h-8 w-28"
                  value={draft.sendTime}
                  onChange={(e) =>
                    e.target.value && setDraft({ ...draft, sendTime: e.target.value })
                  }
                />{" "}
                IST
              </label>
              <label className="text-xs text-muted-foreground">
                MIS for{" "}
                <select
                  className="ml-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={draft.reportDay}
                  onChange={(e) =>
                    setDraft({ ...draft, reportDay: e.target.value as Draft["reportDay"] })
                  }
                >
                  <option value="yesterday">the day before (morning send)</option>
                  <option value="today">that day so far (evening send)</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_SHORT.map((d, i) => (
                <Button
                  key={d}
                  size="sm"
                  variant={draft.weekdays.includes(i) ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setDraft({ ...draft, weekdays: toggle(draft.weekdays, i) })}
                >
                  {d}
                </Button>
              ))}
            </div>
            <div className="space-y-1">
              {MIS_SHEETS.map((k: MisSheetKey) => (
                <label key={k} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.sheets.includes(k)}
                    onChange={() => setDraft({ ...draft, sheets: toggle(draft.sheets, k) })}
                  />
                  {MIS_SHEET_LABEL[k]}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
              />
              Active
            </label>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={
                  busy === "save" ||
                  !draft.name.trim() ||
                  !draft.listId ||
                  !draft.sheets.length ||
                  !draft.weekdays.length
                }
                onClick={save}
              >
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Save schedule
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            disabled={!lists.length}
            onClick={() => setDraft(blank(lists[0]?.id ?? ""))}
          >
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
