import { createFileRoute } from "@tanstack/react-router";
import { FeedbackFileForm } from "@/components/audit/feedback-file-form";

export const Route = createFileRoute("/admin/feedback-file")({
  head: () => ({ meta: [{ title: "Feedback File · SamvadX" }] }),
  component: AdminFeedbackFilePage,
});

function AdminFeedbackFilePage() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Feedback File</h1>
        <p className="text-sm text-muted-foreground">
          Every team's portfolios, loan by loan, ready to send to the bank.
        </p>
      </div>
      <FeedbackFileForm />
    </div>
  );
}
