import { createFileRoute } from "@tanstack/react-router";
import { LiveCallsPageBody } from "@/components/live-calls-page";

export const Route = createFileRoute("/admin/live-calls")({
  head: () => ({
    meta: [
      { title: "Live Calls · SamvadX Admin" },
      {
        name: "description",
        content: "Every call across the whole organisation right now, updating live.",
      },
    ],
  }),
  component: () => <LiveCallsPageBody scopeLabel="across the whole organisation" />,
});
