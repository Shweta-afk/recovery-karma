import { cn } from "@/lib/utils";

/** The small "New" pill beside a recently added Insights lookup (`isNew` in the catalogue). */
export function NewTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1 text-[9px] font-semibold uppercase tracking-wide",
        "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex-shrink-0",
        className,
      )}
      title="Recently added"
    >
      New
    </span>
  );
}
