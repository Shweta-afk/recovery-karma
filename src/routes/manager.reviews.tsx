import { createFileRoute } from "@tanstack/react-router";
import { ReceivedReviews } from "@/components/audit/received-reviews";

export const Route = createFileRoute("/manager/reviews")({
  head: () => ({ meta: [{ title: "Call Reviews · SamvadX" }] }),
  component: () => (
    <ReceivedReviews
      title="Call Reviews"
      subtitle="What the call auditor said about your team and its calls."
    />
  ),
});
