// "Reopen" on a closed portfolio's header (PortfolioDetail). Closing — by hand, or by uploading a
// new file that "continues" it — only sets closed_at; this clears it, putting the accounts back
// in the call queue and every working list. Admins only (user, 2026-10-22). Shown only for a
// portfolio that was actually closed, not one whose end date merely passed.
import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/auth";
import { reopenPortfolio } from "@/lib/portfolio-store";
import { errorText } from "@/lib/app-error";

export function ReopenPortfolioButton({
  portfolioId,
  portfolioName,
  closedAt,
  replacedByName,
}: {
  portfolioId: string;
  portfolioName: string;
  closedAt?: string;
  /** The portfolio that continues this one, if any — it stays open alongside. */
  replacedByName?: string;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (user?.role !== "admin" || !closedAt) return null;

  const reopen = async () => {
    setBusy(true);
    try {
      await reopenPortfolio(portfolioId);
      toast.success(`"${portfolioName}" reopened`, {
        description: "Its accounts are back in the call queue and every list.",
      });
      setOpen(false);
    } catch (e) {
      toast.error(errorText(e, "Could not reopen the portfolio"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 text-xs"
        onClick={() => setOpen(true)}
        title="Undo the close: put this portfolio's accounts back in the call queue"
      >
        <RotateCcw className="h-3 w-3" />
        Reopen
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen &ldquo;{portfolioName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its accounts go back into the call queue, the Debtors page and every list, with their
              agents, call history and Insights lookups exactly as they were — closing changed none
              of that.
              {replacedByName &&
                ` "${replacedByName}" continues this portfolio and stays open too, so if it holds the same borrowers they will be listed twice until you close one of them.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void reopen();
              }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Reopen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
