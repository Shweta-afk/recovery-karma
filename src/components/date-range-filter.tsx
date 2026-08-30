/**
 * The one date filter used by every list page — Activity History, Manager Activity, Call
 * Audit, Payments, Messages and Debtors — so the control is learned once and a date means the
 * same thing everywhere. Pair it with `inDateRange` from lib/date-filter.ts, which does the
 * IST (midnight-rollover) day comparison.
 *
 * Native <input type="date"> rather than a popover calendar: it is what the rest of the app
 * already uses (agent dashboard, debtor modal), it is keyboard- and mobile-friendly for free,
 * and it emits exactly the "YYYY-MM-DD" string the range comparison wants.
 */
import { CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EMPTY_RANGE, isRangeActive, todayIstKey, type DateRange } from "@/lib/date-filter";

interface DateRangeFilterProps {
  value: DateRange;
  onChange: (next: DateRange) => void;
  /** Hides the leading calendar icon where the surrounding bar is already busy. */
  showIcon?: boolean;
  className?: string;
}

export function DateRangeFilter({
  value,
  onChange,
  showIcon = true,
  className,
}: DateRangeFilterProps) {
  // No filtering into the future — there is no activity there, and an accidental 2027 makes
  // the table go blank with no obvious cause.
  const max = todayIstKey();
  const active = isRangeActive(value);

  const field = (key: keyof DateRange, label: string) => (
    <input
      type="date"
      aria-label={label}
      title={label}
      max={max}
      value={value[key]}
      onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      className={cn(
        "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground",
        "focus:outline-none focus:ring-1 focus:ring-primary",
        // An unset date input renders as dd/mm/yyyy; dim it so it reads as a placeholder
        // rather than as a real value the user has chosen.
        !value[key] && "text-muted-foreground",
      )}
    />
  );

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {showIcon && <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />}
      {field("from", "From date")}
      <span className="text-xs text-muted-foreground">to</span>
      {field("to", "To date")}
      {active && (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Clear date filter"
          className="h-9 w-9 p-0 text-muted-foreground"
          onClick={() => onChange(EMPTY_RANGE)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
