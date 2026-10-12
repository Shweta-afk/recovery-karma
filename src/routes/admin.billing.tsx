import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { FileSignature, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getAccessToken } from "@/lib/access-token";
import { listMyInvoices, openMyInvoice, type MyInvoice } from "@/lib/company-billing.server";
import { INVOICE_KIND_LABEL, monthLabel } from "@/lib/invoice-math";
import {
  InvoiceDocument,
  InvoicePrintButton,
  formatIsoDate,
  formatRupees,
} from "@/components/billing/invoice-document";
import { InvoiceStatusBadge } from "@/components/billing/invoice-list";
import { AdminAgreements } from "@/components/contracts/admin-agreements";
import { CONTRACTS_VISIBLE_TO_COMPANIES } from "@/lib/contracts";

type BillingTab = "invoices" | "agreements";

// Links in SamvadX's emails land here: ?invoice=<id> opens that invoice (and marks it Viewed),
// ?tab=agreements&doc=<id> opens Terms & agreements with that document highlighted.
export const Route = createFileRoute("/admin/billing")({
  head: () => ({ meta: [{ title: "Billing & agreements · SamvadX" }] }),
  validateSearch: (
    s: Record<string, unknown>,
  ): { tab?: BillingTab; invoice?: string; doc?: string } => ({
    ...(s.tab === "invoices" || s.tab === "agreements" ? { tab: s.tab } : {}),
    ...(typeof s.invoice === "string" ? { invoice: s.invoice } : {}),
    ...(typeof s.doc === "string" ? { doc: s.doc } : {}),
  }),
  component: AdminBillingPage,
});

function AdminBillingPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/billing" });
  const tab: BillingTab = search.tab ?? (search.doc ? "agreements" : "invoices");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Billing &amp; agreements
        </h1>
        <p className="text-sm text-muted-foreground">
          Invoices from SamvadX, and your agreement and SamvadX's terms — open them any time.
        </p>
      </div>
      <Tabs value={tab} onValueChange={(v) => navigate({ search: { tab: v as BillingTab } })}>
        <TabsList>
          <TabsTrigger value="invoices" className="text-xs">
            <FileText className="mr-1.5 h-3.5 w-3.5" />
            Invoices
          </TabsTrigger>
          {CONTRACTS_VISIBLE_TO_COMPANIES && (
            <TabsTrigger value="agreements" className="text-xs">
              <FileSignature className="mr-1.5 h-3.5 w-3.5" />
              Terms &amp; agreements
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="invoices" className="pt-4">
          <MyInvoices openId={search.invoice} />
        </TabsContent>
        {CONTRACTS_VISIBLE_TO_COMPANIES && (
          <TabsContent value="agreements" className="pt-4">
            <AdminAgreements focusDocId={search.doc} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function MyInvoices({ openId }: { openId?: string }) {
  const [invoices, setInvoices] = useState<MyInvoice[] | null>(null);
  const [open, setOpen] = useState<MyInvoice | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInvoices(await listMyInvoices({ data: { accessToken: await getAccessToken() } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load invoices");
      setInvoices([]);
    }
  }, []);

  const view = useCallback(async (id: string) => {
    setOpening(id);
    try {
      setOpen(
        await openMyInvoice({ data: { accessToken: await getAccessToken(), invoiceId: id } }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the invoice");
    } finally {
      setOpening(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Arrived from the invoice email: open it straight away.
  useEffect(() => {
    if (openId) void view(openId);
  }, [openId, view]);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold">Invoices</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every invoice SamvadX has issued to your company. Open one to view, print or save it as a
          PDF.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {invoices === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : invoices.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Invoice</th>
                  <th className="py-2 pr-3 font-medium">For</th>
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Due</th>
                  <th className="py-2 pr-3 text-right font-medium">Total (incl. GST)</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3 font-mono">{inv.invoiceNumber}</td>
                    <td className="py-2 pr-3">
                      {INVOICE_KIND_LABEL[inv.kind]}
                      {inv.periodMonth && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {monthLabel(inv.periodMonth)}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-3">{formatIsoDate(inv.issueDate)}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{formatIsoDate(inv.dueDate)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatRupees(inv.total)}</td>
                    <td className="py-2 pr-3">
                      <InvoiceStatusBadge invoice={inv} />
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={opening !== null}
                        onClick={() => view(inv.id)}
                      >
                        {opening === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Open"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-h-[90vh] max-w-[860px] overflow-y-auto">
          <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0 pr-8">
            <DialogTitle className="text-sm">Invoice {open?.invoiceNumber}</DialogTitle>
            {open && <InvoicePrintButton invoice={open} />}
          </DialogHeader>
          {open && (
            <div className="rounded-md border border-border">
              <InvoiceDocument invoice={open} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
