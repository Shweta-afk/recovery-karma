// Portfolio header control: how many borrowers Productive Dial rings at once per agent
// (PortfolioSettings.linesPerAgent). Managers and admins — RLS portfolios_update allows both.
import { useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { updatePortfolioMeta, type PortfolioSettings } from "@/lib/portfolio-store";
import { MAX_LINES_PER_AGENT, linesPerAgent } from "@/lib/telephony/predictive-rules";
import { errorText } from "@/lib/app-error";

export function DialLinesButton({
  portfolioId,
  settings,
}: {
  portfolioId: string;
  settings: PortfolioSettings | undefined;
}) {
  const current = linesPerAgent(settings);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  if (!settings) return null;

  const save = async () => {
    setSaving(true);
    try {
      await updatePortfolioMeta(portfolioId, { settings: { ...settings, linesPerAgent: value } });
      toast.success(`Productive Dial rings ${value} borrower${value === 1 ? "" : "s"} per agent`);
      setOpen(false);
    } catch (e) {
      toast.error(errorText(e, "Could not save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(current);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          title="How many borrowers Productive Dial rings at once for each agent"
        >
          <Zap className="h-3 w-3" />
          {current} lines / agent
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3 text-xs">
        <p className="font-medium">Productive Dial — borrowers rung at once per agent</p>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: MAX_LINES_PER_AGENT }, (_, i) => i + 1).map((n) => (
            <Button
              key={n}
              size="sm"
              variant={n === value ? "default" : "outline"}
              className="h-7 w-8 px-0 text-xs"
              onClick={() => setValue(n)}
            >
              {n}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground">
          Whoever answers first goes to a free agent. More lines keep agents busier, but more
          borrowers pick up to find nobody free.
        </p>
        <Button
          size="sm"
          className="w-full gap-1"
          disabled={saving || value === current}
          onClick={save}
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          Save
        </Button>
      </PopoverContent>
    </Popover>
  );
}
