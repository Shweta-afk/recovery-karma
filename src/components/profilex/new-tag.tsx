import { cn } from "@/lib/utils";

const PILL =
  "inline-flex items-center rounded px-1 text-[9px] font-semibold uppercase tracking-wide flex-shrink-0";

/** The small "New" pill beside a recently added Insights lookup (`isNew` in the catalogue). */
export function NewTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(PILL, "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", className)}
      title="Recently added"
    >
      New
    </span>
  );
}

/** The "Recommended" pill (`isRecommended` in the catalogue). */
export function RecommendedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(PILL, "bg-amber-500/15 text-amber-700 dark:text-amber-400", className)}
      title="Recommended by SamvadX"
    >
      Recommended
    </span>
  );
}
