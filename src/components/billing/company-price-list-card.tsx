// Superadmin → company → Billing: the company's price list — set once, then every invoice opens
// prefilled from it and its contract schedule is generated from it. Saving a change to an
// existing price list drafts a contract change for review (Superadmin → Contracts).

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, Plus, Save, Tags, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SETUP_LINE_ITEMS, sumLines, type PriceList } from "@/lib/invoice-math";
import { getAccessToken } from "@/lib/access-token";
import { savePriceList } from "@/lib/billing-actions.server";
import { formatRupees } from "./invoice-document";

type DraftLine = { description: string; amount: string };

const toDraft = (lines: { description: string; amount: number }[]): DraftLine[] =>
  lines.map((l) => ({ description: l.description, amount: String(l.amount) }));
const fromDraft = (lines: DraftLine[]) =>
  lines
    .map((l) => ({ description: l.description.trim(), amount: Number(l.amount) || 0 }))
    .filter((l) => l.description);

function LinesEditor({
  lines,
  onChange,
  addLabel,
}: {
  lines: DraftLine[];
  onChange: (l: DraftLine[]) => void;
  addLabel: string;
}) {
  const set = (i: number, patch: Partial<DraftLine>) =>
    onChange(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-1.5">
      {lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={l.description}
            onChange={(e) => set(i, { description: e.target.value })}
            placeholder="What it's for"
            className="h-8 flex-1 text-xs"
          />
          <span className="text-xs text-muted-foreground">₹</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={l.amount}
            onChange={(e) => set(i, { amount: e.target.value })}
            placeholder="0"
            className="h-8 w-28 text-right text-xs"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground"
            aria-label="Remove line"
            onClick={() => onChange(lines.filter((_, n) => n !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-[11px]"
        onClick={() => onChange([...lines, { description: "", amount: "" }])}
      >
        <Plus className="h-3 w-3" /> {addLabel}
      </Button>
    </div>
  );
}

export function CompanyPriceListCard({
  clientId,
  priceList,
  defaultTermsDays,
  onSaved,
}: {
  clientId: string;
  priceList: PriceList;
  /** SamvadX's default payment terms, shown as the placeholder. */
  defaultTermsDays: number | null;
  onSaved: () => Promise<void> | void;
}) {
  const empty =
    !priceList.setupLines.length &&
    !priceList.monthlyLines.length &&
    !priceList.perSeatFee &&
    priceList.paymentTermsDays === null;
  const [setup, setSetup] = useState<DraftLine[]>([]);
  const [monthly, setMonthly] = useState<DraftLine[]>([]);
  const [perSeat, setPerSeat] = useState("");
  const [terms, setTerms] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // A company with no price list yet starts from the standard setup lines.
    setSetup(
      priceList.setupLines.length
        ? toDraft(priceList.setupLines)
        : SETUP_LINE_ITEMS.map((d) => ({ description: d, amount: "" })),
    );
    setMonthly(
      priceList.monthlyLines.length
        ? toDraft(priceList.monthlyLines)
        : [{ description: "Platform fee", amount: "" }],
    );
    setPerSeat(priceList.perSeatFee ? String(priceList.perSeatFee) : "");
    setTerms(priceList.paymentTermsDays === null ? "" : String(priceList.paymentTermsDays));
  }, [priceList]);

  const save = async () => {
    const termsNum = terms.trim() === "" ? null : Number(terms);
    if (termsNum !== null && (!Number.isInteger(termsNum) || termsNum < 0 || termsNum > 365)) {
      toast.error("Payment terms must be a whole number of days (0–365), or blank");
      return;
    }
    setSaving(true);
    try {
      const accessToken = await getAccessToken();
      const res = await savePriceList({
        data: {
          accessToken,
          clientId,
          // Lines left at ₹0 are kept as items (so a ₹0 "Domain Setup" can still print on the
          // schedule); invoices skip ₹0 lines.
          setupLines: fromDraft(setup),
          monthlyLines: fromDraft(monthly),
          perSeatFee: Number(perSeat) || 0,
          paymentTermsDays: termsNum,
        },
      });
      if (!res.changes.length) toast.success("Price list saved (no changes)");
      else if (res.draftId) {
        toast.success("Price list saved — a draft contract update was created under Contracts");
      } else toast.success("Price list saved");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the price list");
    } finally {
      setSaving(false);
    }
  };

  const setupTotal = sumLines(fromDraft(setup).filter((l) => l.amount > 0));
  const monthlyTotal = sumLines(fromDraft(monthly).filter((l) => l.amount > 0));

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Tags className="h-4 w-4 text-primary" />
          Price list
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Set this company's prices once (before GST). Setup and monthly invoices open prefilled
          from here, and its contract schedule is generated from it. Insights prices are on the
          Settings tab. {empty ? "Nothing saved yet." : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold">One-time setup fee</h3>
            <span className="text-[11px] text-muted-foreground">
              Total {formatRupees(setupTotal)}
            </span>
          </div>
          <LinesEditor lines={setup} onChange={setSetup} addLabel="Add setup line" />
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold">Monthly fee</h3>
            <span className="text-[11px] text-muted-foreground">
              Fixed {formatRupees(monthlyTotal)} / month + seats
            </span>
          </div>
          <LinesEditor lines={monthly} onChange={setMonthly} addLabel="Add monthly line" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Price per agent seat per month ₹</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={perSeat}
              onChange={(e) => setPerSeat(e.target.value)}
              placeholder="0 = no seat charge"
              className="h-8 w-36 text-right text-xs"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Payment due (days after invoice)</span>
          <Input
            type="number"
            min={0}
            max={365}
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            placeholder={defaultTermsDays === null ? "Standard" : `Standard (${defaultTermsDays})`}
            className="h-8 w-36 text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" className="gap-1 text-xs" disabled={saving} onClick={save}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save price list
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Changing saved prices creates a draft contract update on{" "}
            <Link to="/superadmin/contracts" className="text-primary hover:underline">
              Contracts
            </Link>{" "}
            for you to review — nothing is sent to the company until you publish it.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
