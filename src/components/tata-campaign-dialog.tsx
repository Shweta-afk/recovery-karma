import { useEffect, useState } from "react";
import { Loader2, PhoneOutgoing } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getTataCampaignSetupOptions,
  createTataDialerCampaign,
  type TataAgentOption,
  type TataDispositionListOption,
  type TataLeadRow,
} from "@/lib/tata-dialer-actions.server";

interface TataCampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: TataLeadRow[];
  /** DIDs assigned to the Tata SmartFlo account — same list the manual dialer uses. */
  callerIdOptions: readonly string[];
}

export function TataCampaignDialog({
  open,
  onOpenChange,
  leads,
  callerIdOptions,
}: TataCampaignDialogProps) {
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<TataAgentOption[]>([]);
  const [dispositionLists, setDispositionLists] = useState<TataDispositionListOption[]>([]);

  const [campaignName, setCampaignName] = useState("");
  const [dialMethod, setDialMethod] = useState<"1" | "2">("1");
  const [autoDialDuration, setAutoDialDuration] = useState("15");
  const [dialRatio, setDialRatio] = useState("2");
  const [numberOfRetry, setNumberOfRetry] = useState("3");
  const [retryAfterMinutes, setRetryAfterMinutes] = useState("60");
  const [ringTimeout, setRingTimeout] = useState("30");
  const [connectAgentThrough, setConnectAgentThrough] = useState<"1" | "2" | "3">("1");
  const [selectedCallerIds, setSelectedCallerIds] = useState<string[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);
  const [dispositionChoice, setDispositionChoice] = useState<string>("__new__");
  const [newDispositionName, setNewDispositionName] = useState("SamvadX Collections");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCampaignName(`SamvadX Queue — ${new Date().toLocaleDateString("en-IN")}`);
    setSelectedCallerIds(callerIdOptions.length ? [callerIdOptions[0]] : []);
    setLoadingOptions(true);
    setOptionsError(null);
    getTataCampaignSetupOptions()
      .then(({ agents, dispositionLists }) => {
        setAgents(agents);
        setDispositionLists(dispositionLists);
      })
      .catch((e) => setOptionsError(e instanceof Error ? e.message : "Failed to load Tata account data"))
      .finally(() => setLoadingOptions(false));
  }, [open, callerIdOptions]);

  const toggleCallerId = (did: string) => {
    setSelectedCallerIds((prev) =>
      prev.includes(did) ? prev.filter((d) => d !== did) : [...prev, did],
    );
  };

  const toggleAgent = (id: number) => {
    setSelectedAgentIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  };

  const handleSubmit = async () => {
    if (!campaignName.trim()) return toast.error("Campaign name is required");
    if (!selectedCallerIds.length) return toast.error("Select at least one caller ID");
    if (!selectedAgentIds.length) return toast.error("Select at least one agent");

    setSubmitting(true);
    try {
      const result = await createTataDialerCampaign({
        data: {
          campaignName: campaignName.trim(),
          dialMethod,
          autoDialDuration: dialMethod === "1" ? autoDialDuration : undefined,
          dialRatio: dialMethod === "2" ? dialRatio : undefined,
          numberOfRetry,
          retryAfterMinutes,
          ringTimeout,
          connectAgentThrough,
          callerIds: selectedCallerIds,
          agentIds: selectedAgentIds,
          dispositionListId: dispositionChoice === "__new__" ? undefined : dispositionChoice,
          newDispositionListName: dispositionChoice === "__new__" ? newDispositionName : undefined,
          leads,
        },
      });

      if (result.leadsFailed > 0) {
        toast.warning(
          `Campaign created — ${result.leadsUploaded} leads uploaded, ${result.leadsFailed} failed. Check the Smartflo dashboard.`,
        );
      } else {
        toast.success(`"${campaignName}" created on Tata with ${result.leadsUploaded} leads`);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create dialer campaign");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneOutgoing className="h-4 w-4" />
            Create Tata Dialer Campaign
          </DialogTitle>
          <DialogDescription>
            Creates a lead list from the {leads.length} debtor{leads.length === 1 ? "" : "s"}{" "}
            currently in view, uploads them, and starts a Dialer Campaign on Tata SmartFlo —
            no manual CSV upload needed.
          </DialogDescription>
        </DialogHeader>

        {optionsError && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {optionsError}
          </p>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="campaignName">Campaign name</Label>
            <Input
              id="campaignName"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Dial method</Label>
              <Select value={dialMethod} onValueChange={(v) => setDialMethod(v as "1" | "2")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Preview</SelectItem>
                  <SelectItem value="2">Ratio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {dialMethod === "1" ? (
              <div className="space-y-1.5">
                <Label htmlFor="autoDialDuration">Preview window (sec)</Label>
                <Input
                  id="autoDialDuration"
                  type="number"
                  value={autoDialDuration}
                  onChange={(e) => setAutoDialDuration(e.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="dialRatio">Dial ratio (calls/agent)</Label>
                <Input
                  id="dialRatio"
                  type="number"
                  value={dialRatio}
                  onChange={(e) => setDialRatio(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="numberOfRetry">Retries</Label>
              <Input
                id="numberOfRetry"
                type="number"
                value={numberOfRetry}
                onChange={(e) => setNumberOfRetry(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retryAfterMinutes">Retry after (min)</Label>
              <Input
                id="retryAfterMinutes"
                type="number"
                value={retryAfterMinutes}
                onChange={(e) => setRetryAfterMinutes(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ringTimeout">Ring timeout (sec)</Label>
              <Input
                id="ringTimeout"
                type="number"
                value={ringTimeout}
                onChange={(e) => setRingTimeout(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Connect agent through</Label>
            <Select
              value={connectAgentThrough}
              onValueChange={(v) => setConnectAgentThrough(v as "1" | "2" | "3")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Mobile (follow-me number)</SelectItem>
                <SelectItem value="2">Extension</SelectItem>
                <SelectItem value="3">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Caller ID(s)</Label>
            <div className="flex flex-wrap gap-3 rounded-md border border-input px-3 py-2">
              {callerIdOptions.map((did) => (
                <label key={did} className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={selectedCallerIds.includes(did)}
                    onCheckedChange={() => toggleCallerId(did)}
                  />
                  {did}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Agents</Label>
            {loadingOptions ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading agents from Tata…
              </p>
            ) : agents.length ? (
              <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-input px-3 py-2">
                {agents.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={selectedAgentIds.includes(a.id)}
                      onCheckedChange={() => toggleAgent(a.id)}
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No agents found on the Tata account.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Disposition list</Label>
            <Select value={dispositionChoice} onValueChange={setDispositionChoice}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__new__">Create new…</SelectItem>
                {dispositionLists.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {dispositionChoice === "__new__" && (
              <Input
                value={newDispositionName}
                onChange={(e) => setNewDispositionName(e.target.value)}
                placeholder="Disposition list name"
                className="mt-1.5"
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !leads.length}>
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Create campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
