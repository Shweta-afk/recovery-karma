// Superadmin → Companies → one company → Billing: the company's price list, billing (recipient)
// details, Insights top-ups not yet invoiced, setup and monthly invoice forms (prefilled from the
// price list), and its invoices with payments and credit notes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, FileText, Loader2, Plus, RotateCcw, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import {
  GST_STATES,
  gstBreakdown,
  normaliseGstin,
  stateFromGstin,
  sumLines,
  monthLabel,
  monthlyInvoiceLines,
  EMPTY_PRICE_LIST,
  SETUP_LINE_ITEMS,
  type PriceList,
} from "@/lib/invoice-math";
import {
  createInvoice,
  getBillingProfile,
  getCompanyBilling,
  saveCompanyBilling,
  type BillingProfile,
  type CompanyBillingDetails,
  type InvoiceWithBalance,
  type UninvoicedTopup,
} from "@/lib/invoice-actions.server";
import { todayIstKey } from "@/lib/date-filter";
import { InvoiceTable } from "./invoice-list";
import { formatRupees } from "./invoice-document";
import { CompanyPriceListCard } from "./company-price-list-card";

/** The current IST month and the three before it — the months a monthly invoice is usually for. */
function recentMonths(): string[] {
  const [y, m] = todayIstKey().split("-").map(Number);
  return [0, 1, 2, 3].map((back) => {
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** Setup lines to start the form with: the price list's, else the standard items blank. */
const setupLinesFrom = (prices: PriceList) =>
  prices.setupLines.length
    ? prices.setupLines.map((l) => ({
        description: l.description,
        amount: l.amount > 0 ? String(l.amount) : "",
      }))
    : SETUP_LINE_ITEMS.map((d) => ({ description: d, amount: "" }));

export function CompanyInvoicesCard({ clientId }: { clientId: string }) {
  const [loading, setLoading] = useState(true);
  const [supplier, setSupplier] = useState<BillingProfile | null>(null);
  const [billing, setBilling] = useState<CompanyBillingDetails | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithBalance[]>([]);
  const [topups, setTopups] = useState<UninvoicedTopup[]>([]);
  const [priceList, setPriceList] = useState<PriceList>(EMPTY_PRICE_LIST);
  const [activeAgents, setActiveAgents] = useState(0);
  const months = useMemo(recentMonths, []);
  // Default to last month: a monthly fee is normally billed once the month is over.
  const [month, setMonth] = useState(() => recentMonths()[1]);
  const [seats, setSeats] = useState("");

  const [draft, setDraft] = useState<CompanyBillingDetails>({
    legalName: "",
    gstin: "",
    address: "",
    stateCode: null,
    email: "",
  });
  const [savingDetails, setSavingDetails] = useState(false);
  const [issuing, setIssuing] = useState<string | null>(null);
  // One row per charge on the setup invoice, prefilled from the price list; amounts as typed.
  // Rows left blank/₹0 are skipped.
  const [setupLines, setSetupLines] = useState(() => setupLinesFrom(EMPTY_PRICE_LIST));
  const setupCharged = setupLines
    .map((l) => ({ description: l.description.trim(), amount: Number(l.amount) }))
    .filter((l) => l.description && l.amount > 0);
  const setupTotal = sumLines(setupCharged);

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const [profile, company] = await Promise.all([
        getBillingProfile({ data: { accessToken } }),
        getCompanyBilling({ data: { accessToken, clientId } }),
      ]);
      setSupplier(profile);
      setBilling(company.billing);
      setDraft({
        ...company.billing,
        gstin: company.billing.gstin ?? "",
        email: company.billing.email ?? "",
      });
      setInvoices(company.invoices);
      setTopups(company.uninvoicedTopups);
      setPriceList(company.priceList);
      setActiveAgents(company.activeAgents);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load invoices");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refill the invoice forms whenever the price list changes (first load, or after saving it).
  useEffect(() => {
    setSetupLines(setupLinesFrom(priceList));
  }, [priceList]);
  useEffect(() => {
    setSeats(String(activeAgents));
  }, [activeAgents]);

  const monthlyLines = useMemo(
    () => monthlyInvoiceLines(priceList, month, Math.max(0, Math.floor(Number(seats) || 0))),
    [priceList, month, seats],
  );
  const monthlyTotal = sumLines(monthlyLines);
  /** Months that already have a live monthly invoice — can't be billed twice. */
  const billedMonths = useMemo(
    () =>
      new Set(
        invoices
          .filter((i) => i.kind === "monthly" && i.status !== "cancelled" && i.periodMonth)
          .map((i) => i.periodMonth as string),
      ),
    [invoices],
  );

  const supplierReady = !!(
    supplier?.legalName &&
    supplier.gstin &&
    supplier.address &&
    supplier.stateCode
  );
  const recipientReady = !!(billing?.legalName && billing.address && billing.stateCode);

  /** What GST an invoice to this company will carry, for the hint under the buttons. */
  const gstHint = useMemo(() => {
    if (!supplier?.stateCode || !billing?.stateCode) return null;
    return gstBreakdown(100, supplier.stateCode, billing.stateCode).intraState
      ? "Same state as SamvadX → 9% CGST + 9% SGST"
      : "Different state from SamvadX → 18% IGST";
  }, [supplier?.stateCode, billing?.stateCode]);

  const onGstinChange = (v: string) => {
    const state = stateFromGstin(v);
    setDraft((d) => ({ ...d, gstin: v, stateCode: state ?? d.stateCode }));
  };

  const saveDetails = async () => {
    if (!draft.stateCode) {
      toast.error("Pick the company's state (place of supply)");
      return;
    }
    setSavingDetails(true);
    try {
      const accessToken = await getAccessToken();
      await saveCompanyBilling({
        data: {
          accessToken,
          clientId,
          legalName: draft.legalName,
          gstin: draft.gstin ? normaliseGstin(draft.gstin) : null,
          address: draft.address,
          stateCode: draft.stateCode,
          email: draft.email || null,
        },
      });
      toast.success("Billing details saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save billing details");
    } finally {
      setSavingDetails(false);
    }
  };

  const issueTopup = async (t: UninvoicedTopup) => {
    if (
      !window.confirm(
        `Issue an Insights top-up invoice for ${formatRupees(t.amount)} + GST? Invoice numbers can't be reused.`,
      )
    ) {
      return;
    }
    setIssuing(t.ledgerId);
    try {
      const accessToken = await getAccessToken();
      const inv = await createInvoice({
        data: { accessToken, clientId, kind: "insights_topup", walletLedgerId: t.ledgerId },
      });
      toast.success(`Invoice ${inv.invoiceNumber} issued`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not issue the invoice");
    } finally {
      setIssuing(null);
    }
  };

  const issueSetup = async () => {
    if (!setupCharged.length) {
      toast.error("Enter an amount (before GST) for at least one setup charge");
      return;
    }
    if (
      !window.confirm(
        `Issue a setup invoice for ${formatRupees(setupTotal)} + GST (${setupCharged.length} line${setupCharged.length === 1 ? "" : "s"})? Invoice numbers can't be reused.`,
      )
    ) {
      return;
    }
    setIssuing("setup");
    try {
      const accessToken = await getAccessToken();
      const inv = await createInvoice({
        data: { accessToken, clientId, kind: "setup", lines: setupCharged },
      });
      toast.success(`Invoice ${inv.invoiceNumber} issued`);
      setSetupLines(setupLinesFrom(priceList));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not issue the invoice");
    } finally {
      setIssuing(null);
    }
  };

  const issueMonthly = async () => {
    if (!monthlyLines.length) {
      toast.error("Set this company's monthly fee or per-seat price in the price list first");
      return;
    }
    if (
      !window.confirm(
        `Issue the ${monthLabel(month)} invoice for ${formatRupees(monthlyTotal)} + GST? Invoice numbers can't be reused.`,
      )
    ) {
      return;
    }
    setIssuing("monthly");
    try {
      const accessToken = await getAccessToken();
      const inv = await createInvoice({
        data: { accessToken, clientId, kind: "monthly", periodMonth: month, lines: monthlyLines },
      });
      toast.success(`Invoice ${inv.invoiceNumber} issued`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not issue the invoice");
    } finally {
      setIssuing(null);
    }
  };

  return (
    <>
      {!loading && (
        <CompanyPriceListCard
          clientId={clientId}
          priceList={priceList}
          defaultTermsDays={supplier?.paymentTermsDays ?? null}
          onSaved={load}
        />
      )}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            Invoices
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            GST tax invoices for Insights wallet top-ups, the setup fee and the monthly fee. Amounts
            are before GST; 18% GST is added. Open an invoice to record payments or issue a credit
            note. Only superadmins can see invoices for now.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 pt-4">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              {!supplierReady && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  SamvadX's own billing details (legal name, GSTIN, address, state) aren't filled in
                  yet. Add them on <span className="font-medium">Superadmin → Invoices</span> before
                  issuing invoices.
                </p>
              )}

              <section className="space-y-3">
                <h3 className="text-xs font-semibold">Bill to (this company)</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Legal name">
                    <Input
                      value={draft.legalName}
                      onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
                      placeholder="As registered"
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="GSTIN (blank if unregistered)">
                    <Input
                      value={draft.gstin ?? ""}
                      onChange={(e) => onGstinChange(e.target.value)}
                      placeholder="27AAPFU0939F1ZV"
                      className="h-8 font-mono text-xs uppercase"
                    />
                  </Field>
                  <Field label="State (place of supply)">
                    <Select
                      value={draft.stateCode ?? ""}
                      onValueChange={(v) => setDraft({ ...draft, stateCode: v })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Pick a state" />
                      </SelectTrigger>
                      <SelectContent>
                        {GST_STATES.map((s) => (
                          <SelectItem key={s.code} value={s.code} className="text-xs">
                            {s.name} ({s.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Billing email">
                    <Input
                      value={draft.email ?? ""}
                      onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                      placeholder="accounts@company.in"
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Billing address" className="sm:col-span-2">
                    <Textarea
                      value={draft.address}
                      onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                      rows={2}
                      className="text-xs"
                    />
                  </Field>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={savingDetails || !draft.legalName.trim() || !draft.address.trim()}
                  onClick={saveDetails}
                >
                  {savingDetails ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save billing details
                </Button>
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold">Insights top-ups not yet invoiced</h3>
                {!topups.length ? (
                  <p className="text-xs text-muted-foreground">
                    Every Insights top-up to this company has an invoice.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60 text-xs">
                    {topups.map((t) => (
                      <li key={t.ledgerId} className="flex items-center justify-between gap-3 py-2">
                        <span>
                          <span className="font-medium tabular-nums">{formatRupees(t.amount)}</span>
                          <span className="ml-2 text-muted-foreground">
                            {new Date(t.createdAt).toLocaleString("en-IN", {
                              timeZone: "Asia/Kolkata",
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                            {t.note ? ` · ${t.note}` : ""}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          disabled={!supplierReady || !recipientReady || issuing !== null}
                          onClick={() => issueTopup(t)}
                        >
                          {issuing === t.ledgerId ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Issue invoice"
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold">Setup invoice</h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-[11px]"
                    onClick={() => setSetupLines(setupLinesFrom(priceList))}
                  >
                    <RotateCcw className="h-3 w-3" /> Reset to price list
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {priceList.setupLines.length
                    ? "Filled in from the price list — change anything for this invoice only."
                    : "No setup prices saved yet — set them once in the price list above to have this filled in."}{" "}
                  Amounts are before GST; leave a line blank to leave it off.
                </p>
                <div className="space-y-1.5">
                  {setupLines.map((line, n) => (
                    <div key={n} className="flex items-center gap-2">
                      <Input
                        value={line.description}
                        onChange={(e) =>
                          setSetupLines((ls) =>
                            ls.map((l, k) => (k === n ? { ...l, description: e.target.value } : l)),
                          )
                        }
                        className="h-8 min-w-0 flex-1 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">₹</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={line.amount}
                        placeholder="0.00"
                        onChange={(e) =>
                          setSetupLines((ls) =>
                            ls.map((l, k) => (k === n ? { ...l, amount: e.target.value } : l)),
                          )
                        }
                        className="h-8 w-32 text-right text-xs"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 text-muted-foreground"
                        aria-label={`Remove ${line.description || "line"}`}
                        disabled={setupLines.length === 1}
                        onClick={() => setSetupLines((ls) => ls.filter((_, k) => k !== n))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs"
                    disabled={setupLines.length >= 20}
                    onClick={() => setSetupLines((ls) => [...ls, { description: "", amount: "" }])}
                  >
                    <Plus className="h-3 w-3" />
                    Add line
                  </Button>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      Before GST:{" "}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatRupees(setupTotal)}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      className="h-8 text-xs"
                      disabled={
                        !supplierReady ||
                        !recipientReady ||
                        issuing !== null ||
                        !setupCharged.length
                      }
                      onClick={issueSetup}
                    >
                      {issuing === "setup" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Issue invoice"
                      )}
                    </Button>
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold">
                  <CalendarDays className="h-3.5 w-3.5" /> Monthly invoice
                </h3>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-2">
                    <span className="text-muted-foreground">Month</span>
                    <Select value={month} onValueChange={setMonth}>
                      <SelectTrigger className="h-8 w-40 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {months.map((m) => (
                          <SelectItem key={m} value={m} className="text-xs">
                            {monthLabel(m)}
                            {billedMonths.has(m) ? " · invoiced" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {priceList.perSeatFee > 0 && (
                    <label className="flex items-center gap-2">
                      <span className="text-muted-foreground">Agent seats</span>
                      <Input
                        type="number"
                        min={0}
                        value={seats}
                        onChange={(e) => setSeats(e.target.value)}
                        className="h-8 w-20 text-right text-xs"
                      />
                      <span className="text-[11px] text-muted-foreground">
                        ({activeAgents} active now)
                      </span>
                    </label>
                  )}
                </div>
                {monthlyLines.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No monthly fee or per-seat price in this company's price list yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60 rounded-md border border-border text-xs">
                    {monthlyLines.map((l, n) => (
                      <li key={n} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <span>{l.description}</span>
                        <span className="tabular-nums">
                          {l.quantity && l.rate ? `${l.quantity} × ${formatRupees(l.rate)} = ` : ""}
                          {formatRupees(l.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center justify-end gap-3">
                  {billedMonths.has(month) && (
                    <span className="text-[11px] text-amber-600">
                      {monthLabel(month)} is already invoiced — cancel that invoice first to
                      reissue.
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Before GST:{" "}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatRupees(monthlyTotal)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    disabled={
                      !supplierReady ||
                      !recipientReady ||
                      issuing !== null ||
                      !monthlyLines.length ||
                      billedMonths.has(month)
                    }
                    onClick={issueMonthly}
                  >
                    {issuing === "monthly" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Issue invoice"
                    )}
                  </Button>
                </div>
              </section>

              {!recipientReady && (
                <p className="text-xs text-muted-foreground">
                  Save this company's billing details to enable issuing.
                </p>
              )}
              {gstHint && <p className="text-xs text-muted-foreground">{gstHint}</p>}

              <section className="space-y-2">
                <h3 className="text-xs font-semibold">Issued</h3>
                <InvoiceTable invoices={invoices} onChanged={load} />
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block space-y-1 ${className ?? ""}`}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
