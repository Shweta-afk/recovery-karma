import { createFileRoute } from "@tanstack/react-router";
import { CollectionMisView } from "@/components/reports/collection-mis";
import { ReportSchedulesCard } from "@/components/reports/report-schedules-card";

export const Route = createFileRoute("/admin/mis")({
  head: () => ({ meta: [{ title: "Collection MIS · SamvadX" }] }),
  component: () => (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Collection MIS</h1>
        <p className="text-sm text-muted-foreground">
          Daily collection sheets — download as an image or Excel, or email them to a list.
        </p>
      </div>
      <ReportSchedulesCard />
      <CollectionMisView />
    </div>
  ),
});
