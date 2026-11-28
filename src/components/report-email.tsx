import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getAccessToken } from "@/lib/access-token";
import { errorText } from "@/lib/app-error";
import { captureNextDownload } from "@/lib/download-capture";
import { useCompanyFeatures } from "@/lib/use-company-features";
import {
  deleteReportEmailList,
  listReportEmailLists,
  listReportEmailLog,
  saveReportEmailList,
  sendReportEmail,
  type ReportEmailList,
  type ReportEmailLogRow,
} from "@/lib/report-email.server";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_LIST_SIZE,
  parseEmailList,
  reportNameFromFile,
} from "@/lib/report-email";

const ARM_MS = 90_000;

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Reports page header button. Click → the page's next Download builds its file as usual, but
 * the file opens a "send to list" dialog instead of being saved.
 */
function EmailReportButtonInner() {
  const [armed, setArmed] = useState(false);
  const [file, setFile] = useState<{ filename: string; blob: Blob } | null>(null);

  const disarm = useCallback(() => {
    captureNextDownload(null);
    setArmed(false);
  }, []);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(disarm, ARM_MS);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && disarm();
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [armed, disarm]);

  useEffect(() => () => captureNextDownload(null), []);

  const arm = () => {
    captureNextDownload((f) => {
      setArmed(false);
      setFile(f);
    });
    setArmed(true);
  };

  return (
    <>
      {armed ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-foreground">
          <Mail className="h-3.5 w-3.5 text-primary" />
          Now click any Download / Export button on this page to email that file.
          <button
            type="button"
            onClick={disarm}
            className="ml-1 text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="gap-2" onClick={arm}>
          <Mail className="h-4 w-4" /> Email a report
        </Button>
      )}
      {file && <SendDialog file={file} onClose={() => setFile(null)} />}
    </>
  );
}

function SendDialog({
  file,
  onClose,
}: {
  file: { filename: string; blob: Blob };
  onClose: () => void;
}) {
  const [lists, setLists] = useState<ReportEmailList[] | null>(null);
  const [ready, setReady] = useState(true);
  const [listId, setListId] = useState("");
  const [reportName, setReportName] = useState(() => reportNameFromFile(file.filename));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const tooBig = file.blob.size > MAX_ATTACHMENT_BYTES;

  useEffect(() => {
    (async () => {
      try {
        const r = await listReportEmailLists({ data: { accessToken: await getAccessToken() } });
        setLists(r.lists);
        setReady(r.emailReady);
        if (r.lists.length) setListId(r.lists[0].id);
      } catch (e) {
        toast.error(errorText(e, "Could not load email lists"));
        setLists([]);
      }
    })();
  }, []);

  const send = async () => {
    setBusy(true);
    try {
      const r = await sendReportEmail({
        data: {
          accessToken: await getAccessToken(),
          listId,
          reportName: reportName.trim() || "Report",
          filename: file.filename,
          contentBase64: await blobToBase64(file.blob),
          note: note.trim() || undefined,
        },
      });
      toast.success(`Emailed to ${r.sent} of ${r.total} people`);
      onClose();
    } catch (e) {
      toast.error(errorText(e, "Could not send the email"));
    } finally {
      setBusy(false);
    }
  };

  const chosen = lists?.find((l) => l.id === listId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email this report</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            File: <span className="font-medium text-foreground">{file.filename}</span> (
            {(file.blob.size / 1024).toFixed(0)} KB)
          </p>
          {tooBig && (
            <p className="text-destructive">
              This file is over 15 MB and can't be emailed. Narrow the date range.
            </p>
          )}
          {!ready && (
            <p className="text-destructive">
              Email isn't set up on the server yet, so sending will fail.
            </p>
          )}
          {lists === null ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : lists.length === 0 ? (
            <p className="text-muted-foreground">
              No email lists yet. An admin can create them in Admin → Settings → Report email lists.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <Label>Send to</Label>
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                >
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.emails.length})
                    </option>
                  ))}
                </select>
                {chosen && (
                  <p className="text-xs text-muted-foreground break-all">
                    {chosen.emails.join(", ")}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Subject</Label>
                <Input
                  value={reportName}
                  onChange={(e) => setReportName(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="space-y-1">
                <Label>Note (optional)</Label>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  rows={2}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !listId || tooBig} onClick={send} className="gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Admin → Settings: manage recipient lists + see what was sent recently. */
function ReportEmailListsCardInner() {
  const [lists, setLists] = useState<ReportEmailList[]>([]);
  const [log, setLog] = useState<ReportEmailLogRow[]>([]);
  const [ready, setReady] = useState(true);
  const [editing, setEditing] = useState<{ id?: string; name: string; emails: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const [r, l] = await Promise.all([
        listReportEmailLists({ data: { accessToken } }),
        listReportEmailLog({ data: { accessToken } }),
      ]);
      setLists(r.lists);
      setReady(r.emailReady);
      setLog(l);
    } catch (e) {
      toast.error(errorText(e, "Could not load email lists"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    const { invalid, valid } = parseEmailList(editing.emails);
    if (invalid.length)
      return toast.error(`Not an email address: ${invalid.slice(0, 3).join(", ")}`);
    if (valid.length > MAX_LIST_SIZE)
      return toast.error(`At most ${MAX_LIST_SIZE} addresses per list`);
    setBusy(true);
    try {
      await saveReportEmailList({ data: { accessToken: await getAccessToken(), ...editing } });
      setEditing(null);
      await load();
      toast.success("List saved");
    } catch (e) {
      toast.error(errorText(e, "Could not save the list"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (l: ReportEmailList) => {
    if (!confirm(`Delete the list "${l.name}"?`)) return;
    try {
      await deleteReportEmailList({ data: { accessToken: await getAccessToken(), id: l.id } });
      await load();
    } catch (e) {
      toast.error(errorText(e, "Could not delete the list"));
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Mail className="h-4 w-4 text-primary" /> Report email lists
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Groups of your own staff or the bank's team that reports can be emailed to from the
          Reports pages ("Email a report"). Internal recipients only — never borrowers.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-4 text-sm">
        {!ready && (
          <p className="text-xs text-amber-600">
            Email sending isn't switched on for SamvadX yet; lists can be prepared now.
          </p>
        )}
        {lists.map((l) => (
          <div
            key={l.id}
            className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {l.name}{" "}
                <span className="text-muted-foreground font-normal">({l.emails.length})</span>
              </p>
              <p className="text-xs text-muted-foreground break-all">{l.emails.join(", ")}</p>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setEditing({ id: l.id, name: l.name, emails: l.emails.join("\n") })}
                aria-label="Edit"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => remove(l)} aria-label="Delete">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        {editing ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <Input
              placeholder="List name, e.g. RBL Ops"
              value={editing.name}
              maxLength={80}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <Textarea
              placeholder="Email addresses — one per line, or separated by commas"
              rows={4}
              value={editing.emails}
              onChange={(e) => setEditing({ ...editing, emails: e.target.value })}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !editing.name.trim()} onClick={save}>
                {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Save list
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => setEditing({ name: "", emails: "" })}
          >
            <Plus className="h-4 w-4" /> New list
          </Button>
        )}
        {log.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Recently sent</p>
            <div className="space-y-1">
              {log.slice(0, 10).map((r) => (
                <p key={r.id} className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} ·{" "}
                  <span className="text-foreground">{r.reportName}</span> → {r.listName} (
                  {r.sentCount}/{r.recipients}) by {r.sentByName ?? "—"}
                </p>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Shown only to companies with "Report emails" switched on. */
export function EmailReportButton() {
  const f = useCompanyFeatures();
  return f.reportEmails ? <EmailReportButtonInner /> : null;
}

export function ReportEmailListsCard() {
  const f = useCompanyFeatures();
  return f.reportEmails ? <ReportEmailListsCardInner /> : null;
}
