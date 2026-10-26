// Borrowers who called one of the company's numbers and reached nobody. Shown on the agent and
// manager home pages; hidden entirely when there is nothing to call back (or calling isn't set
// up). An entry clears itself once anyone at the company calls that number back.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PhoneMissed, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccessToken } from "@/lib/access-token";
import {
  dismissMissedCall,
  listMissedCalls,
  type MissedCallEntry,
} from "@/lib/telephony-actions.server";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

export function MissedCallsCard() {
  const [entries, setEntries] = useState<MissedCallEntry[]>([]);
  const [clearing, setClearing] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await listMissedCalls({ data: { accessToken: await getAccessToken(), days: 7 } });
      setEntries(r.entries);
    } catch {
      // Not critical: the card stays hidden.
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    // A call back placed from this tab should clear the entry without waiting a minute.
    const reload = () => void load();
    window.addEventListener("dispositions-updated", reload);
    return () => {
      clearInterval(t);
      window.removeEventListener("dispositions-updated", reload);
    };
  }, []);

  if (!entries.length) return null;

  const clear = async (phone: string) => {
    setClearing(phone);
    try {
      await dismissMissedCall({ data: { accessToken: await getAccessToken(), phone } });
      setEntries((e) => e.filter((x) => x.phone !== phone));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear it");
    } finally {
      setClearing(null);
    }
  };

  return (
    <Card className="border-amber-500/40">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <PhoneMissed className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          Missed calls to call back ({entries.length})
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Borrowers who called your company's number in the last 7 days and reached nobody. Each one
          goes away once someone calls them back.
        </p>
      </CardHeader>
      <CardContent className="pt-3 space-y-2">
        {entries.slice(0, 20).map((e) => (
          <div key={e.phone} className="flex flex-wrap items-center gap-3 text-sm">
            <div className="min-w-0 flex-1">
              {e.debtor ? (
                <Link
                  to="/dashboard/debtors"
                  search={{ debtor: e.debtor.id }}
                  className="font-medium hover:underline"
                >
                  {e.debtor.name}
                </Link>
              ) : (
                <span className="font-medium">Unknown caller</span>
              )}
              <span className="ml-2 font-mono text-xs">{e.phone}</span>
              <div className="text-[11px] text-muted-foreground">
                {e.count > 1 ? `${e.count} calls, last ` : ""}
                {fmtWhen(e.lastAt)}
                {e.debtor?.loanReference ? ` · Loan ${e.debtor.loanReference}` : ""}
                {e.debtor?.assignedAgentName ? ` · ${e.debtor.assignedAgentName}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={clearing === e.phone}
              onClick={() => clear(e.phone)}
              title="Reached them another way"
            >
              {clearing === e.phone ? <Loader2 className="h-3 w-3 animate-spin" /> : "Handled"}
            </Button>
          </div>
        ))}
        {entries.length > 20 && (
          <p className="text-xs text-muted-foreground">+{entries.length - 20} more</p>
        )}
      </CardContent>
    </Card>
  );
}
