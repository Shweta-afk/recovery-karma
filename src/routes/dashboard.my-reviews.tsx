import { createFileRoute } from "@tanstack/react-router";
import { ReceivedReviews } from "@/components/audit/received-reviews";

export const Route = createFileRoute("/dashboard/my-reviews")({
  head: () => ({ meta: [{ title: "My Call Reviews · SamvadX" }] }),
  component: () => (
    <ReceivedReviews
      title="My Call Reviews"
      subtitle="Your calls the auditor has reviewed, and what to work on."
    />
  ),
});
