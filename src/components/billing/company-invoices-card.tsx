// Making and sending one company's invoices — used on Superadmin → Invoices (after picking the
// company) and on a company's Billing tab. Laid out so nothing needs a long scroll:
//
//   Bill to       — everything the company filled in (Admin → Settings), editable here too
//   New invoice   — one tab per kind: Setup · Insights · Monthly · Calls (coming soon). Each has
//                   Preview (the real invoice, nothing saved) and Issue. Issuing opens Send.
//   Issued        — the company's invoices with Sent / Viewed, Send, payments and credit notes
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Phone,
  RotateCcw,
  Save,
  Search,
  Settings2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getAccessToken } from "@/lib/access-token";
import {
  gstBreakdown,
  stateName,
  monthLabel,
  monthlyInvoiceLines,
  EMPTY_PRICE_LIST,
  SETUP_LINE_ITEMS,
  setupLine,
  setupPackage,
  type InvoiceRecord,
  type PriceList,
} from "@/lib/invoice-math";
import {
  createInvoice,
  getBillingProfile,
  getCompanyBilling,
  saveCompanyBilling,
  type BillingProfile,
  type InvoiceWithBalance,
  type UninvoicedTopup,
} from "@/lib/invoice-actions.server";
import {
  EMPTY_COMPANY_DETAILS,
  checkCompanyDetails,
  fullAddress,
  type CompanyDetails,
} from "@/lib/company-details";
import { todayIstKey } from "@/lib/date-filter";
import { CompanyDetailsForm } from "@/components/company-details-form";
import { InvoiceTable } from "./invoice-list";
import { formatRupees } from "./invoice-document";
import { CompanyPriceListCard } from "./company-price-list-card";
import { InvoicePreviewDialog } from "./invoice-preview-dialog";
import { SendInvoiceDialog } from "./send-invoice-dialog";
import { IncludedItemsEditor } from "./included-items-editor";

/** The current IST month and the three before it — the months a monthly invoice is usually for. */
function recentMonths(): string[] {
  const [y, m] = todayIstKey().split("-").map(Number);
  return [0, 1, 2, 3].map((back) => {
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** The setup form starts from the price list: its total and what it includes (or the standard
 *  list of items when nothing is saved yet). */
const setupFrom = (prices: PriceList) => {
  const pkg = setupPackage(prices.setupLines);
  return {
    amount: pkg.amount > 0 ? String(pkg.amount) : "",
    items: pkg.includes.length ? pkg.includes : [...SETUP_LINE_ITEMS],
  };
};

/** What "Issue" sends to createInvoice for each kind (and "Preview" with preview: true). */
type Draft =
  | { kind: "insights_topup"; walletLedgerId: string }
  | { kind: "setup"; lines: { description: string; amount: number }[] }
  | {
      kind: "monthly";
      periodMonth: string;
      lines: { description: string; amount: number; quantity?: number; rate?: number }[];
    };

export function CompanyInvoicesCard({
  clientId,
  showPriceList = true,
}: {
  clientId: string;
  /** The company's Billing tab shows its price list above; the Invoices page links to it. */
  showPriceList?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [supplier, setSupplier] = useState<BillingProfile | null>(null);
  const [details, setDetails] = useState<CompanyDetails>(EMPTY_COMPANY_DETAILS);
  const [companyName, setCompanyName] = useState("");
  const [adminEmails, setAdminEmails] = useState<string[]>([]);
  const [invoices, setInvoices] = useState<InvoiceWithBalance[]>([]);
  const [topups, setTopups] = useState<UninvoicedTopup[]>([]);
  const [priceList, setPriceList] = useState<PriceList>(EMPTY_PRICE_LIST);
  const [activeAgents, setActiveAgents] = useState(0);

  const [editing, setEditing] = useState(false);
  const [draftDetails, setDraftDetails] = useState<CompanyDetails>(EMPTY_COMPANY_DETAILS);
  const [triedSave, setTriedSave] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);

  const months = useMemo(recentMonths, []);
  // Default to last month: a monthly fee is normally billed once the month is over.
  const [month, setMonth] = useState(() => recentMonths()[1]);
  const [seats, setSeats] = useState("");
  const [setupAmount, setSetupAmount] = useState("");
  const [setupItems, setSetupItems] = useState<string[]>([...SETUP_LINE_ITEMS]);
  const resetSetup = (prices: PriceList) => {
    const s = setupFrom(prices);
    setSetupAmount(s.amount);
    setSetupItems(s.items);
  };

  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ draft: Draft; invoice: InvoiceRecord } | null>(null);
  const [sendFor, setSendFor] = useState<InvoiceRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const [profile, company] = await Promise.all([
        getBillingProfile({ data: { accessToken } }),
        getCompanyBilling({ data: { accessToken, clientId } }),
      ]);
      setSupplier(profile);
      setDetails(company.details);
      setDraftDetails(company.details);
      setCompanyName(company.companyName);
      setAdminEmails(company.adminEmails);
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
    setLoading(true);
    setEditing(false);
    void load();
  }, [load]);
  useEffect(() => resetSetup(priceList), [priceList]);
  useEffect(() => setSeats(String(activeAgents)), [activeAgents]);

  // ONE charged line — the total — with what it includes listed under it (no per-item prices).
  const setupTotal = Number(setupAmount) || 0;
  const setupCharged = setupTotal > 0 ? [setupLine(setupTotal, setupItems)] : [];
  const monthlyLines = useMemo(
    () => monthlyInvoiceLines(priceList, month, Math.max(0, Math.floor(Number(seats) || 0))),
    [priceList, month, seats],
  );
  const billedMonths = useMemo(
    () =>
      new Set(
        invoices
          .filter((i) => i.kind === "monthly" && i.status !== "cancelled" && i.periodMonth)
          .map((i) => i.periodMonth as string),
      ),
    [invoices],
  );

  const check = checkCompanyDetails(details);
  const detailsComplete = check.missing.length === 0 && !Object.keys(check.invalid).length;
  const supplierReady = !!(
    supplier?.legalName &&
    supplier.gstin &&
    supplier.address &&
    supplier.stateCode
  );
  // What issuing actually needs (createInvoice); the rest is wanted, and flagged, but not blocking.
  const recipientReady = !!(details.legalName && details.address && details.stateCode);
  const canIssue = supplierReady && recipientReady;

  const gstHint =
    supplier?.stateCode && details.stateCode
      ? gstBreakdown(100, supplier.stateCode, details.stateCode).intraState
        ? "Same state as SamvadX → 9% CGST + 9% SGST"
        : "Different state from SamvadX → 18% IGST"
      : null;

  const saveDetails = async () => {
    setTriedSave(true);
    setSavingDetails(true);
    try {
      await saveCompanyBilling({
        data: { accessToken: await getAccessToken(), clientId, details: draftDetails },
      });
      toast.success("Company details saved");
      setEditing(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save company details");
    } finally {
      setSavingDetails(false);
    }
  };

  /** Preview first: the real invoice from the server, nothing saved. */
  const openPreview = async (draft: Draft) => {
    setBusy(`preview:${draft.kind}`);
    try {
      const invoice = await createInvoice({
        data: { accessToken: await getAccessToken(), clientId, ...draft, preview: true },
      });
      setPreview({ draft, invoice });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build the preview");
    } finally {
      setBusy(null);
    }
  };

  const issue = async (draft: Draft) => {
    setBusy(`issue:${draft.kind}`);
    try {
      const inv = await createInvoice({
        data: { accessToken: await getAccessToken(), clientId, ...draft },
      });
      toast.success(`Invoice ${inv.invoiceNumber} issued — now send it`);
      setPreview(null);
      if (draft.kind === "setup") resetSetup(priceList);
      await load();
      setSendFor(inv);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not issue the invoice");
    } finally {
      setBusy(null);
    }
  };

  const actions = (draft: Draft | null, disabledReason: string | null) => (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
      {disabledReason && (
        <span className="mr-auto text-[11px] text-amber-600">{disabledReason}</span>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 text-xs"
        disabled={!draft || !!disabledReason || busy !== null}
        onClick={() => draft && openPreview(draft)}
      >
        {busy === `preview:${draft?.kind}` ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
        Preview
      </Button>
      <Button
        size="sm"
        className="h-8 text-xs"
        disabled={!draft || !!disabledReason || busy !== null}
        onClick={() => {
          if (
            draft &&
            window.confirm("Issue this invoice? Invoice numbers can't be reused once given.")
          ) {
            void issue(draft);
          }
        }}
      >
        {busy === `issue:${draft?.kind}` ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          "Issue invoice"
        )}
      </Button>
    </div>
  );

  const blocked = !supplierReady
    ? "Fill in SamvadX's own details first (Invoices → SamvadX details)"
    : !recipientReady
      ? "This company's legal name, address and state are needed first"
      : null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showPriceList && (
        <CompanyPriceListCard
          clientId={clientId}
          priceList={priceList}
          defaultTermsDays={supplier?.paymentTermsDays ?? null}
          onSaved={load}
        />
      )}

      {/* ── Bill to ─────────────────────────────────────────────────────────────── */}
      <Card className={detailsComplete ? undefined : "border-amber-500/50"}>
        <CardHeader className="border-b border-border pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <FileText className="h-4 w-4 text-primary" />
              Bill to — {details.legalName || companyName}
              {detailsComplete ? (
                <span className="flex items-center gap-1 text-[11px] font-normal text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Details complete
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] font-normal text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5" /> Company hasn't finished its details
                </span>
              )}
            </CardTitle>
            {!editing && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={() => {
                  setDraftDetails(details);
                  setTriedSave(false);
                  setEditing(true);
                }}
              >
                <Pencil className="h-3 w-3" /> Edit
              </Button>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Filled in by the company's admin on their Settings page — fetched here automatically.
            {!detailsComplete &&
              check.missing.length > 0 &&
              ` Still missing: ${check.missing.join(", ")}.`}
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {editing ? (
            <div className="space-y-3">
              <CompanyDetailsForm
                details={draftDetails}
                onChange={setDraftDetails}
                showMissing={triedSave}
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 gap-1 text-xs"
                  disabled={savingDetails}
                  onClick={saveDetails}
                >
                  {savingDetails ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save details
                </Button>
              </div>
            </div>
          ) : (
            <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <Detail label="Legal name" value={details.legalName} />
              <Detail
                label="GSTIN"
                value={details.gstUnregistered ? "Not registered for GST" : details.gstin}
                mono
              />
              <Detail label="PAN" value={details.pan} mono />
              <Detail label="CIN / LLPIN" value={details.cin || "—"} mono optional />
              <Detail label="Address" value={details.address ? fullAddress(details) : ""} wide />
              <Detail label="State (place of supply)" value={stateName(details.stateCode) ?? ""} />
              <Detail label="Billing email" value={details.email} />
              <Detail label="Billing phone" value={details.phone} />
              <Detail
                label="Authorised signatory"
                value={
                  details.signatoryName
                    ? `${details.signatoryName}${details.signatoryDesignation ? `, ${details.signatoryDesignation}` : ""}`
                    : ""
                }
              />
            </dl>
          )}
          {gstHint && !editing && (
            <p className="mt-3 text-[11px] text-muted-foreground">{gstHint}</p>
          )}
        </CardContent>
      </Card>

      {/* ── New invoice ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold">New invoice</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Pick what it's for. Amounts are before GST; 18% GST is added. Preview it first — it
            shows exactly what the company will receive.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          <Tabs defaultValue="setup">
            <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="setup" className="text-xs">
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                Setup
              </TabsTrigger>
              <TabsTrigger value="insights" className="text-xs">
                <Search className="mr-1.5 h-3.5 w-3.5" />
                Insights
                {topups.length > 0 && (
                  <Badge className="ml-1.5 h-4 px-1.5 text-[10px]">{topups.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="monthly" className="text-xs">
                <CalendarDays className="mr-1.5 h-3.5 w-3.5" />
                Monthly
              </TabsTrigger>
              <TabsTrigger value="calls" className="text-xs">
                <Phone className="mr-1.5 h-3.5 w-3.5" />
                Calls
                <span className="ml-1.5 rounded border border-border px-1 text-[9px] uppercase text-muted-foreground">
                  Soon
                </span>
              </TabsTrigger>
            </TabsList>

            {/* Setup — one total, plus what it includes (no price per item). */}
            <TabsContent value="setup" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">
                  {priceList.setupLines.length
                    ? "Filled in from this company's price list — change anything for this invoice only."
                    : "No setup fee saved for this company yet — type it in, or set it once in its price list."}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => resetSetup(priceList)}
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              </div>
              <label className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-foreground">Setup fee (before GST) ₹</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={setupAmount}
                  placeholder="0.00"
                  onChange={(e) => setSetupAmount(e.target.value)}
                  className="h-8 w-40 text-right text-xs"
                />
              </label>
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  What it includes — printed as a list under the fee, without separate prices:
                </p>
                <IncludedItemsEditor items={setupItems} onChange={setSetupItems} />
              </div>
              {actions(
                setupCharged.length ? { kind: "setup", lines: setupCharged } : null,
                blocked ?? (setupCharged.length ? null : "Enter the setup fee"),
              )}
            </TabsContent>

            {/* Insights */}
            <TabsContent value="insights" className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                One invoice per Insights wallet top-up given to this company. Top-ups already
                invoiced aren't listed.
              </p>
              {!topups.length ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  Every Insights top-up to this company has an invoice.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border text-xs">
                  {topups.map((t) => {
                    const draft: Draft = { kind: "insights_topup", walletLedgerId: t.ledgerId };
                    return (
                      <li
                        key={t.ledgerId}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                      >
                        <span>
                          <span className="font-medium tabular-nums">{formatRupees(t.amount)}</span>
                          <span className="ml-2 text-muted-foreground">
                            top-up of{" "}
                            {new Date(t.createdAt).toLocaleDateString("en-IN", {
                              timeZone: "Asia/Kolkata",
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                            {t.note ? ` · ${t.note}` : ""}
                          </span>
                        </span>
                        <span className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            disabled={!!blocked || busy !== null}
                            onClick={() => openPreview(draft)}
                          >
                            <Eye className="h-3 w-3" /> Preview
                          </Button>
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            disabled={!!blocked || busy !== null}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Issue the Insights invoice for ${formatRupees(t.amount)} + GST?`,
                                )
                              ) {
                                void issue(draft);
                              }
                            }}
                          >
                            Issue invoice
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {blocked && <p className="text-[11px] text-amber-600">{blocked}</p>}
            </TabsContent>

            {/* Monthly */}
            <TabsContent value="monthly" className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">Month</span>
                  <Select value={month} onValueChange={setMonth}>
                    <SelectTrigger className="h-8 w-44 text-xs">
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
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                  No monthly fee or per-seat price in this company's price list yet.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border text-xs">
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
              {actions(
                monthlyLines.length
                  ? { kind: "monthly", periodMonth: month, lines: monthlyLines }
                  : null,
                blocked ??
                  (billedMonths.has(month)
                    ? `${monthLabel(month)} is already invoiced — cancel that invoice first to reissue`
                    : monthlyLines.length
                      ? null
                      : "Set a monthly fee or per-seat price in the price list first"),
              )}
            </TabsContent>

            {/* Calls */}
            <TabsContent value="calls">
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
                <Phone className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
                <p className="text-sm font-medium text-foreground">Call invoices — coming soon</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                  When calling is billed by usage, invoices for calls will be made here, the same
                  way as Insights.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* ── Issued ──────────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold">Issued invoices</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Send each one to the company; "Viewed" shows once one of their admins opens it. Open an
            invoice to record payments or issue a credit note.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          <InvoiceTable invoices={invoices} onChanged={load} onSend={setSendFor} />
        </CardContent>
      </Card>

      <InvoicePreviewDialog
        invoice={preview?.invoice ?? null}
        issuing={busy?.startsWith("issue:") ?? false}
        onClose={() => setPreview(null)}
        onIssue={() => preview && void issue(preview.draft)}
      />
      <SendInvoiceDialog
        key={sendFor?.id ?? "none"}
        invoice={sendFor}
        suggestions={[details.email, ...adminEmails].filter(Boolean)}
        onClose={() => setSendFor(null)}
        onSent={load}
      />
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
  wide,
  optional,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  optional?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={`${mono ? "font-mono" : ""} ${value ? "text-foreground" : optional ? "text-muted-foreground" : "text-amber-600"}`}
      >
        {value || "Not filled in"}
      </dd>
    </div>
  );
}
