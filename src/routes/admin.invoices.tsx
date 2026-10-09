import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getInvoices, refreshInvoices } from "@/lib/invoice-store";
import { InvoiceTable } from "@/components/billing/invoice-list";
import { formatRupees } from "@/components/billing/invoice-document";

export const Route = createFileRoute("/admin/invoices")({
  head: () => ({ meta: [{ title: "Invoices · SamvadX" }] }),
  component: AdminInvoicesPage,
});

function AdminInvoicesPage() {
  const [invoices, setInvoices] = useState(() => getInvoices());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onUpdate = () => setInvoices(getInvoices());
    window.addEventListener("invoices-updated", onUpdate);
    void refreshInvoices().finally(() => setLoaded(true));
    return () => window.removeEventListener("invoices-updated", onUpdate);
  }, []);

  const due = useMemo(
    () => invoices.filter((i) => i.status === "unpaid").reduce((s, i) => s + i.total, 0),
    [invoices],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          GST tax invoices from SamvadX for your Insights wallet top-ups and setup fee. Open one to
          print it or save it as a PDF.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            Your invoices
          </CardTitle>
          {due > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Amount due (incl. GST):{" "}
              <span className="font-medium text-foreground">{formatRupees(due)}</span>
            </p>
          )}
        </CardHeader>
        <CardContent className="pt-4">
          <InvoiceTable invoices={invoices} empty={loaded ? "No invoices yet." : "Loading…"} />
        </CardContent>
      </Card>
    </div>
  );
}
