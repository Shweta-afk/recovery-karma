import { createFileRoute } from "@tanstack/react-router";
import { LiveCallsPageBody } from "@/components/live-calls-page";

export const Route = createFileRoute("/manager/live-calls")({
  head: () => ({
    meta: [
      { title: "Live Calls · SamvadX Manager" },
      {
        name: "description",
        content: "Every call your team is on right now, updating live.",
      },
    ],
  }),
  component: () => <LiveCallsPageBody scopeLabel="across your team" />,
});
