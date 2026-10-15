import { createFileRoute, Link } from "@tanstack/react-router";
import { PageGuide } from "@/components/superadmin/help";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, FileText, Loader2, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { GST_STATES, normaliseGstin, stateFromGstin } from "@/lib/invoice-math";
import {
  getBillingProfile,
  listAllInvoices,
  saveBillingProfile,
  type BillingProfile,
  type InvoiceListRow,
} from "@/lib/invoice-actions.server";
import { InvoiceTable } from "@/components/billing/invoice-list";
import { CompanyInvoicesCard } from "@/components/billing/company-invoices-card";
import { SendInvoiceDialog } from "@/components/billing/send-invoice-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getCompanies, type CompanyRow } from "@/lib/superadmin-actions.server";
import type { InvoiceRecord } from "@/lib/invoice-math";
import { formatRupees } from "@/components/billing/invoice-document";
import { inDayRange } from "@/lib/date-filter";
import { INVOICE_KIND_LABEL } from "@/lib/invoice-math";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import {
  ExcelButton,
  SuperadminDateFilter,
  useSuperadminRange,
} from "@/components/superadmin/usage-shared";

export const Route = createFileRoute("/superadmin/invoices")({
  head: () => ({ meta: [{ title: "Invoices · SamvadX Platform" }] }),
  component: SuperadminInvoicesPage,
});

const EMPTY_PROFILE: BillingProfile = {
  legalName: "",
  gstin: "",
  pan: "",
  address: "",
  stateCode: null,
  email: "",
  phone: "",
  bankName: "",
  bankAccount: "",
  bankIfsc: "",
  terms: "",
  cin: "",
  shortName: "",
  signatoryName: "",
  signatoryDesignation: "",
  invoicePrefix: "SX",
  sacInsights: "",
  sacSetup: "",
  sacMonthly: "",
  paymentTermsDays: 15,
};

function SuperadminInvoicesPage() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<BillingProfile>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  // The company being invoiced, remembered per browser so coming back lands on it again.
  const [companyId, setCompanyId] = useState<string>(() => {
    try {
      return localStorage.getItem("superadmin-invoice-company") ?? "";
    } catch {
      return "";
    }
  });
  const pickCompany = (id: string) => {
    setCompanyId(id);
    try {
      localStorage.setItem("superadmin-invoice-company", id);
    } catch {
      // private window: just not remembered
    }
  };
  const [sendFor, setSendFor] = useState<InvoiceRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const [p, list, cos] = await Promise.all([
        getBillingProfile({ data: { accessToken } }),
        listAllInvoices({ data: { accessToken } }),
        getCompanies({ data: { accessToken } }),
      ]);
      setCompanies(
        [...cos.rows].sort(
          (a, b) =>
            Number(b.status === "approved") - Number(a.status === "approved") ||
            a.companyName.localeCompare(b.companyName),
        ),
      );
      // Inputs want strings, not nulls.
      setProfile(
        Object.fromEntries(
          Object.entries({ ...EMPTY_PROFILE, ...p }).map(([k, v]) => [
            k,
            v === null && k !== "stateCode" ? "" : v,
          ]),
        ) as unknown as BillingProfile,
      );
      setInvoices(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load invoices");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof BillingProfile>(k: K, v: BillingProfile[K]) =>
    setProfile((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!profile.stateCode) {
      toast.error("Pick SamvadX's state of registration");
      return;
    }
    setSaving(true);
    try {
      const accessToken = await getAccessToken();
      await saveBillingProfile({
        data: {
          accessToken,
          legalName: profile.legalName,
          gstin: profile.gstin ? normaliseGstin(profile.gstin) : null,
          pan: profile.pan || null,
          address: profile.address,
          stateCode: profile.stateCode,
          email: profile.email || null,
          phone: profile.phone || null,
          bankName: profile.bankName || null,
          bankAccount: profile.bankAccount || null,
          bankIfsc: profile.bankIfsc || null,
          terms: profile.terms || null,
          cin: profile.cin || null,
          shortName: profile.shortName || null,
          signatoryName: profile.signatoryName || null,
          signatoryDesignation: profile.signatoryDesignation || null,
          invoicePrefix: profile.invoicePrefix,
          sacInsights: profile.sacInsights || null,
          sacSetup: profile.sacSetup || null,
          sacMonthly: profile.sacMonthly || null,
          paymentTermsDays: Number(profile.paymentTermsDays) || 0,
        },
      });
      toast.success("Billing details saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save billing details");
    } finally {
      setSaving(false);
    }
  };

  // GSTIN is optional: without one, invoices are Bills of Supply with no GST.
  const supplierReady = !!(profile.legalName && profile.address && profile.stateCode);

  const outstanding = useMemo(
    // What is still owed after payments and credit notes, not the face value of unpaid invoices.
    () =>
      invoices
        .filter((i) => i.status !== "cancelled")
        .reduce((s, i) => s + Math.max(0, i.balance.balance), 0),
    [invoices],
  );

  // The shared superadmin date filter, applied to the invoice date. Outstanding above stays
  // "everything unpaid right now" whatever the dates.
  const [range, setRange] = useSuperadminRange();
  const shown = useMemo(
    () => invoices.filter((i) => inDayRange(i.issueDate, range)),
    [invoices, range],
  );
  const exportInvoices = () =>
    downloadXlsx(reportFilename("invoices", range), [
      {
        name: "Invoices",
        headers: [
          "Invoice no.",
          "Invoice date",
          "Due date",
          "Type",
          "Company",
          "Recipient (legal name)",
          "Recipient GSTIN",
          "Place of supply",
          "Taxable value (₹)",
          "CGST (₹)",
          "SGST (₹)",
          "IGST (₹)",
          "Total (₹)",
          "Status",
          "Paid on",
        ],
        rows: shown.map((i) => [
          i.invoiceNumber,
          i.issueDate,
          i.dueDate,
          INVOICE_KIND_LABEL[i.kind] ?? i.kind,
          i.companyName ?? "",
          i.recipient.legalName,
          i.recipient.gstin ?? "",
          i.placeOfSupply,
          i.taxable,
          i.cgst,
          i.sgst,
          i.igst,
          i.total,
          i.status,
          i.paidAt ? new Date(i.paidAt).toLocaleDateString("en-IN") : "",
        ]),
      },
    ]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Invoices</h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Make, preview and send GST invoices to companies, and see which ones they've opened.
        </p>
      </div>

      <PageGuide page="invoices" />

      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <Tabs defaultValue="make">
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="make" className="text-xs">
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Make &amp; send
            </TabsTrigger>
            <TabsTrigger value="all" className="text-xs">
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              All invoices
            </TabsTrigger>
            <TabsTrigger value="supplier" className="text-xs">
              <Building2 className="mr-1.5 h-3.5 w-3.5" />
              SamvadX details
              {!supplierReady && <span className="ml-1.5 h-2 w-2 rounded-full bg-amber-500" />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="make" className="space-y-4">
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 pt-4">
                <span className="text-sm font-medium text-foreground">Invoice for</span>
                <Select value={companyId} onValueChange={pickCompany}>
                  <SelectTrigger className="h-9 w-72 text-sm">
                    <SelectValue placeholder="Choose a company…" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-sm">
                        {c.companyName}
                        {c.status !== "approved" ? ` (${c.status})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {companyId && (
                  <Link
                    to="/superadmin/companies/$clientId"
                    params={{ clientId: companyId }}
                    search={{ tab: "billing" }}
                    className="text-xs text-primary hover:underline"
                  >
                    Edit this company's prices →
                  </Link>
                )}
                <p className="w-full text-xs text-muted-foreground">
                  The company's details (filled in by its admin) and its price list are fetched
                  automatically.
                </p>
              </CardContent>
            </Card>
            {companyId ? (
              <CompanyInvoicesCard key={companyId} clientId={companyId} showPriceList={false} />
            ) : (
              <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                Choose a company above to make an invoice.
              </p>
            )}
          </TabsContent>

          <TabsContent value="supplier">
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Building2 className="h-4 w-4 text-primary" />
                  SamvadX billing details (supplier)
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Changes apply to invoices issued from now on. Issued invoices keep the details
                  they were issued with.
                </p>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Legal name">
                    <Input
                      value={profile.legalName}
                      onChange={(e) => set("legalName", e.target.value)}
                      placeholder="Samvadx AI Technologies"
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="GSTIN (blank = not registered → Bill of Supply, no GST)">
                    <Input
                      value={profile.gstin ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        const st = stateFromGstin(v);
                        setProfile((p) => ({ ...p, gstin: v, stateCode: st ?? p.stateCode }));
                      }}
                      className="h-8 font-mono text-xs uppercase"
                    />
                  </Field>
                  <Field label="State of registration">
                    <Select
                      value={profile.stateCode ?? ""}
                      onValueChange={(v) => set("stateCode", v)}
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
                  <Field label="PAN">
                    <Input
                      value={profile.pan ?? ""}
                      onChange={(e) => set("pan", e.target.value.toUpperCase())}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="CIN (printed on the agreement)">
                    <Input
                      value={profile.cin ?? ""}
                      onChange={(e) => set("cin", e.target.value.toUpperCase())}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Short name used in the agreement">
                    <Input
                      value={profile.shortName ?? ""}
                      onChange={(e) => set("shortName", e.target.value)}
                      placeholder="e.g. Axiotta"
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Authorised signatory (agreement + invoices)">
                    <Input
                      value={profile.signatoryName ?? ""}
                      onChange={(e) => set("signatoryName", e.target.value)}
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Signatory designation">
                    <Input
                      value={profile.signatoryDesignation ?? ""}
                      onChange={(e) => set("signatoryDesignation", e.target.value)}
                      placeholder="e.g. Director"
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Email (printed)">
                    <Input
                      value={profile.email ?? ""}
                      onChange={(e) => set("email", e.target.value)}
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Phone (printed)">
                    <Input
                      value={profile.phone ?? ""}
                      onChange={(e) => set("phone", e.target.value)}
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Registered address" className="sm:col-span-2 lg:col-span-3">
                    <Textarea
                      value={profile.address}
                      onChange={(e) => set("address", e.target.value)}
                      rows={2}
                      className="text-xs"
                    />
                  </Field>
                  <Field label="Bank name">
                    <Input
                      value={profile.bankName ?? ""}
                      onChange={(e) => set("bankName", e.target.value)}
                      className="h-8 text-xs"
                    />
                  </Field>
                  <Field label="Account number">
                    <Input
                      value={profile.bankAccount ?? ""}
                      onChange={(e) => set("bankAccount", e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="IFSC">
                    <Input
                      value={profile.bankIfsc ?? ""}
                      onChange={(e) => set("bankIfsc", e.target.value.toUpperCase())}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Invoice number prefix (up to 5 letters/digits)">
                    <Input
                      value={profile.invoicePrefix}
                      onChange={(e) => set("invoicePrefix", e.target.value.toUpperCase())}
                      maxLength={5}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="SAC — Insights top-up">
                    <Input
                      value={profile.sacInsights ?? ""}
                      onChange={(e) => set("sacInsights", e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="SAC — setup fee">
                    <Input
                      value={profile.sacSetup ?? ""}
                      onChange={(e) => set("sacSetup", e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="SAC — monthly fee (blank = same as setup)">
                    <Input
                      value={profile.sacMonthly ?? ""}
                      onChange={(e) => set("sacMonthly", e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Payment due (days after invoice)">
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      value={profile.paymentTermsDays}
                      onChange={(e) => set("paymentTermsDays", Number(e.target.value))}
                      className="h-8 w-28 text-xs"
                    />
                  </Field>
                  <Field label="Terms printed on every invoice" className="sm:col-span-2">
                    <Textarea
                      value={profile.terms ?? ""}
                      onChange={(e) => set("terms", e.target.value)}
                      rows={2}
                      placeholder="Payable within 15 days. Late payments attract interest at 1.5% per month."
                      className="text-xs"
                    />
                  </Field>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Next number looks like{" "}
                  <span className="font-mono">{profile.invoicePrefix || "SX"}/2627/0001</span> and
                  restarts every April. Confirm the SAC codes with your accountant.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={saving || !profile.legalName.trim() || !profile.address.trim()}
                  onClick={save}
                >
                  {saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save billing details
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="all">
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <FileText className="h-4 w-4 text-primary" />
                    All invoices
                  </CardTitle>
                  <ExcelButton disabled={shown.length === 0} onExport={exportInvoices} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Outstanding (unpaid, incl. GST, all dates):{" "}
                  <span className="font-medium text-foreground">{formatRupees(outstanding)}</span>
                  {" · "}
                  <Link to="/superadmin/revenue" className="text-primary hover:underline">
                    Revenue report
                  </Link>
                </p>
                <SuperadminDateFilter value={range} onChange={setRange} allowAll className="pt-2" />
              </CardHeader>
              <CardContent className="pt-4">
                <InvoiceTable
                  invoices={shown}
                  companyName={(i) => i.companyName}
                  onChanged={load}
                  onSend={setSendFor}
                />
              </CardContent>
            </Card>
            <SendInvoiceDialog
              key={sendFor?.id ?? "none"}
              invoice={sendFor}
              suggestions={[]}
              onClose={() => setSendFor(null)}
              onSent={load}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
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
