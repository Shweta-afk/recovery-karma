import { createFileRoute, redirect } from "@tanstack/react-router";

// Contracts now live on Admin → Billing → "Terms & agreements"; old links land there.
export const Route = createFileRoute("/admin/contracts")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/billing", search: { tab: "agreements" } });
  },
});
