// Company-side calling numbers (user, 2026-11-20):
//  - CompanyCallingNumbersCard — admin marks which of the company's numbers are for Manual Dial.
//  - PortfolioNumbersPicker — manager picks which numbers a portfolio calls from (upload page).
//  - PortfolioNumbersButton — the same, for an existing portfolio (portfolio header).
// Server: src/lib/calling-numbers.server.ts. Rules: telephony/did-rules.ts pickCallerNumber.
import { useEffect, useState } from "react";
import { Loader2, PhoneOutgoing, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { getAccessToken } from "@/lib/access-token";
import {
  getCompanyCallingNumbers,
  getPortfolioNumbers,
  setManualNumbers,
  setPortfolioNumbers,
  type CallingNumber,
  type CompanyCallingNumbers,
  type PortfolioNumbers,
} from "@/lib/calling-numbers.server";

function errText(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback;
}

/** "079 6926 3701" for a 10-digit number. */
export function formatNumber(n: string): string {
  return n.length === 10 ? `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}` : n;
}

function NumberMeta({ n }: { n: CallingNumber }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      {n.callsToday} call{n.callsToday === 1 ? "" : "s"} today
      {n.dailyCap ? ` of ${n.dailyCap}` : ""}
      {n.resting && " · resting"}
      {!n.hasPrefix && " · not set up yet"}
    </span>
  );
}

// ─── Admin ──────────────────────────────────────────────────────────────────────

export function CompanyCallingNumbersCard() {
  const [data, setData] = useState<CompanyCallingNumbers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      setData(await getCompanyCallingNumbers({ data: { accessToken: await getAccessToken() } }));
      setError(null);
    } catch (e) {
      setError(errText(e, "Could not load calling numbers"));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (n: CompanyCallingNumbers["numbers"][number], manual: boolean) => {
    if (manual && n.portfolios.length) {
      const names = n.portfolios.map((p) => p.name).join(", ");
      if (
        !window.confirm(
          `${formatNumber(n.number)} is used by ${names}. Keeping it for Manual Dial takes it off ${n.portfolios.length === 1 ? "that portfolio" : "those portfolios"}. Continue?`,
        )
      )
        return;
    }
    setBusy(n.id);
    try {
      const r = await setManualNumbers({
        data: { accessToken: await getAccessToken(), ids: [n.id], manual },
      });
      toast.success(
        manual
          ? `Kept for Manual Dial${r.removedFromPortfolios ? ` · removed from ${r.removedFromPortfolios} portfolio${r.removedFromPortfolios === 1 ? "" : "s"}` : ""}`
          : "Available to portfolios again",
      );
      await load();
    } catch (e) {
      toast.error(errText(e, "Could not save"));
    } finally {
      setBusy(null);
    }
  };

  const manualCount = data?.numbers.filter((n) => n.manual).length ?? 0;

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <PhoneOutgoing className="h-4 w-4 text-primary" />
          Calling numbers
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          The numbers borrowers see when your team calls. Numbers kept for <b>Manual Dial</b> are
          the only ones Manual Dial uses, and are never used for Call Queue calls. Managers choose
          which of the other numbers each portfolio calls from, on the portfolio page. Calls rotate
          across the allowed numbers.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!data && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {data && data.numbers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Your company has no numbers of its own yet — calls go out on the calling service's
            default number. Ask SamvadX support for numbers.
          </p>
        )}
        {data && data.numbers.length > 0 && (
          <>
            {manualCount === 0 && (
              <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                No numbers are kept for Manual Dial, so Manual Dial calls can't go out. Switch on at
                least one below.
              </p>
            )}
            <div className="divide-y divide-border">
              {data.numbers.map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-sm">
                      {formatNumber(n.number)}
                      {n.label && (
                        <span className="ml-2 font-sans text-xs text-muted-foreground">
                          {n.label}
                        </span>
                      )}
                    </div>
                    <NumberMeta n={n} />
                    {!n.manual && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        {n.portfolios.length
                          ? `Portfolios: ${n.portfolios.map((p) => p.name).join(", ")}`
                          : "Not on any portfolio yet"}
                      </div>
                    )}
                  </div>
                  <label className="flex flex-shrink-0 items-center gap-2 text-xs">
                    {busy === n.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    Manual Dial
                    <Switch
                      checked={n.manual}
                      disabled={busy !== null}
                      onCheckedChange={(v) => void toggle(n, v)}
                    />
                  </label>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Manager ────────────────────────────────────────────────────────────────────

/** Loads what a portfolio may choose from (and, for an existing one, what it has). */
export function usePortfolioNumbers(portfolioId: string | null, enabled = true) {
  const [data, setData] = useState<PortfolioNumbers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    try {
      setData(
        await getPortfolioNumbers({ data: { accessToken: await getAccessToken(), portfolioId } }),
      );
      setError(null);
    } catch (e) {
      setError(errText(e, "Could not load calling numbers"));
    }
  };
  useEffect(() => {
    if (enabled) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolioId, enabled]);
  return { data, error, reload };
}

/** Checkbox list of the numbers a portfolio may call from. Controlled. */
export function PortfolioNumbersPicker({
  data,
  error,
  value,
  onChange,
  disabled,
}: {
  data: PortfolioNumbers | null;
  error: string | null;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!data) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (!data.companyHasNumbers)
    return (
      <p className="text-xs text-muted-foreground">
        Your company has no calling numbers of its own yet, so calls go out on the calling service's
        default number. Nothing to choose.
      </p>
    );
  if (!data.choices.length)
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">
        Every one of your company's numbers is kept for Manual Dial. Ask your admin to free some
        (Settings → Calling numbers) — this portfolio can't call until it has numbers.
      </p>
    );
  const chosen = new Set(value);
  const set = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    onChange(data.choices.map((c) => c.id).filter((x) => next.has(x)));
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {value.length} of {data.choices.length} chosen · calls rotate across them
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            className="text-primary hover:underline disabled:opacity-50"
            disabled={disabled}
            onClick={() => onChange(data.choices.map((c) => c.id))}
          >
            All
          </button>
          <button
            type="button"
            className="text-primary hover:underline disabled:opacity-50"
            disabled={disabled}
            onClick={() => onChange([])}
          >
            None
          </button>
        </span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {data.choices.map((n) => (
          <label
            key={n.id}
            className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5"
          >
            <Checkbox
              checked={chosen.has(n.id)}
              disabled={disabled}
              onCheckedChange={(v) => set(n.id, v === true)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block font-mono text-xs">
                {formatNumber(n.number)}
                {n.label && (
                  <span className="ml-1.5 font-sans text-muted-foreground">{n.label}</span>
                )}
              </span>
              <NumberMeta n={n} />
            </span>
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          No numbers chosen — this portfolio's Call Queue calls won't go out until you choose at
          least one.
        </p>
      )}
    </div>
  );
}

/** Save a portfolio's numbers (after upload, or from the portfolio page). */
export async function savePortfolioNumbers(portfolioId: string, ids: string[]): Promise<void> {
  await setPortfolioNumbers({ data: { accessToken: await getAccessToken(), portfolioId, ids } });
}

/** Portfolio header button → dialog to change which numbers it calls from. Managers/admins only;
 *  the server re-checks ownership. */
export function PortfolioNumbersButton({
  portfolioId,
  portfolioName,
}: {
  portfolioId: string;
  portfolioName: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, error, reload } = usePortfolioNumbers(portfolioId, open);
  const [value, setValue] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setValue(data.chosen);
  }, [data]);

  const save = async () => {
    setSaving(true);
    try {
      await savePortfolioNumbers(portfolioId, value);
      toast.success(
        value.length
          ? `${portfolioName} calls from ${value.length} number${value.length === 1 ? "" : "s"}`
          : `${portfolioName} has no calling numbers — its calls won't go out`,
      );
      await reload();
      setOpen(false);
    } catch (e) {
      toast.error(errText(e, "Could not save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs"
        onClick={() => setOpen(true)}
        title="Which numbers borrowers see when this portfolio is called"
      >
        <PhoneOutgoing className="h-3 w-3" />
        Calling numbers
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Calling numbers · {portfolioName}</DialogTitle>
            <DialogDescription>
              Every Call Queue call on this portfolio — click-to-call, Progressive and Productive
              Dial — goes out on one of these, rotating. Manual Dial uses its own numbers.
            </DialogDescription>
          </DialogHeader>
          <PortfolioNumbersPicker
            data={data}
            error={error}
            value={value}
            onChange={setValue}
            disabled={saving}
          />
          {data?.companyHasNumbers && data.choices.length > 0 && (
            <Button size="sm" className="gap-1" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
