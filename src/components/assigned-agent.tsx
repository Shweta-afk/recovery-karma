// "Assigned to <agent>" for a debtor profile. Its own component because the profile is opened
// from three places — the Debtors page, the manager queue, and the call queue's own sheet — and
// each renders a different header.
//
// Resolved from the debtor row rather than a cached roster so a reassignment shows immediately.
import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { fetchAssignedAgent, type AssignedAgent as Agent } from "@/lib/fetch-debtors";

export function AssignedAgentLine({ debtorId }: { debtorId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    fetchAssignedAgent(debtorId)
      .then((a) => live && setAgent(a))
      // Silent: this is one supporting line on a profile, and a failed lookup is not worth a
      // toast over the actual content the user opened the profile for.
      .catch(() => live && setAgent(null))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [debtorId]);

  // Render nothing until known, rather than flashing "Unassigned" at someone whose account is
  // in fact assigned — that reads as a data error.
  if (!loaded) return null;

  return (
    <p className="text-xs mt-1 flex items-center gap-1.5">
      <UserRound className="h-3 w-3 text-muted-foreground shrink-0" />
      {agent ? (
        <>
          <span className="text-muted-foreground">Assigned to</span>
          <span className="font-medium text-foreground">{agent.name}</span>
          {agent.agentCode && <span className="text-muted-foreground">· {agent.agentCode}</span>}
        </>
      ) : (
        <span className="text-muted-foreground italic">Unassigned</span>
      )}
    </p>
  );
}
