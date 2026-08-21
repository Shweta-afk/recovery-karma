import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/** Shared KPI tile used across the report pages (admin, manager, agent). */
export function Stat({
  icon: Icon,
  label,
  value,
  sub,
  green,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  green?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 pt-4 pb-4">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
            green ? "bg-success/10" : "bg-primary/8",
          )}
        >
          <Icon className={cn("h-4 w-4", green ? "text-success" : "text-primary/70")} />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold text-foreground leading-tight">{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
