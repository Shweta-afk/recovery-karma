// Admin/manager: the company's do-not-call list (enforced by the server on every dial) and the
// calling hours the server enforces for this company.
import { useEffect, useState } from "react";
import { Ban, Clock, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAccessToken } from "@/lib/access-token";
import {
  addDoNotCall,
  getMyTelephony,
  listDoNotCall,
  removeDoNotCall,
  type DoNotCallEntry,
} from "@/lib/telephony-actions.server";

export function CallingHoursCard() {
  const [hours, setHours] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const { settings } = await getMyTelephony({
          data: { accessToken: await getAccessToken() },
        });
        const s = settings?.call_window_start?.slice(0, 5) ?? "08:00";
        const e = settings?.call_window_end?.slice(0, 5) ?? "19:00";
        setHours(`${s} – ${e} IST`);
      } catch {
        setHours("08:00 – 19:00 IST");
      }
    })();
  }, []);
  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          Calling hours
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="text-sm font-medium">{hours ?? "…"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Enforced on every call and dialer run. Set by your platform admin, and never wider than
          08:00–19:00 (RBI rule for recovery calls).
        </p>
      </CardContent>
    </Card>
  );
}

export function DoNotCallCard({ canRemove }: { canRemove: boolean }) {
  const [rows, setRows] = useState<DoNotCallEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (q = search) => {
    try {
      setRows(
        await listDoNotCall({ data: { accessToken: await getAccessToken(), search: q || undefined } }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the do-not-call list");
      setRows([]);
    }
  };

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAdd = async () => {
    setBusy("add");
    try {
      const res = await addDoNotCall({
        data: {
          accessToken: await getAccessToken(),
          phone,
          reason: reason.trim() || undefined,
        },
      });
      toast.success(`${res.phone} added to the do-not-call list`);
      setPhone("");
      setReason("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the number");
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (id: string) => {
    setBusy(id);
    try {
      await removeDoNotCall({ data: { accessToken: await getAccessToken(), id } });
      toast.success("Number removed — it can be called again");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the number");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Ban className="h-4 w-4 text-primary" />
          Do-not-call list
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Numbers here can't be dialled by anyone in your company, from the queue, the dialer or
          Manual Dial. Agents add a number by ticking "Do not call again" when saving a call.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="10-digit number"
            inputMode="tel"
            className="h-8 w-40 text-xs"
          />
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="h-8 min-w-0 flex-1 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            disabled={busy === "add" || phone.replace(/\D/g, "").length < 10}
            onClick={handleAdd}
          >
            {busy === "add" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Add
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load()}
            placeholder="Search by number, press Enter"
            className="h-8 pl-8 text-xs"
          />
        </div>

        {rows === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No numbers on the list.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">{r.phone}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {[r.debtorName, r.reason, r.addedBy && `added by ${r.addedBy}`,
                      new Date(r.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {canRemove && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label={`Remove ${r.phone}`}
                    disabled={busy === r.id}
                    onClick={() => handleRemove(r.id)}
                  >
                    {busy === r.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
