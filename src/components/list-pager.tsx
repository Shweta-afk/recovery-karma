// Client-side paging for the lists that grow with a book of accounts (growth plan item #2).
//
// A scoped fetch already brings only the caller's rows, but an agent's book is thousands of
// accounts (2,877 for the largest one on 2026-09-23) and rendering every one of them as a table
// row or card is the browser's cost, not the network's: ~21k DOM nodes on Call Queue for 409
// rows. Pages, not virtualization, on purpose: Call Queue has a sticky header plus sticky
// left/right columns and a documented Chromium paint bug around them (see the spacer row in
// dashboard.call-queue.tsx) — absolutely-positioned virtual rows would be a new way to trip it.
//
// Only what is RENDERED is paged. Filters, sort, search, counts, CSV export, "dial all" and
// select-all keep working on the whole filtered list, exactly as before.
import { useMemo, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const DEFAULT_PAGE_SIZE = 100;

export interface Paged<T> {
  pageItems: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
}

/**
 * `resetKey` should change when the USER changes what the list means (filter, search, sort) —
 * that jumps back to page 1. It deliberately does not reset when `items` is merely a new array
 * with fresh data (a disposition saved, a background refresh), so an agent working through page
 * 3 is not thrown back to the top every time the queue refreshes. A page that no longer exists
 * after the list shrinks is clamped to the last one.
 */
export function usePaged<T>(
  items: T[],
  resetKey: string,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Paged<T> {
  const [page, setPage] = useState(0);
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    // Reset during render (React's "adjust state when a prop changes" pattern) rather than in
    // an effect, so the first render after a filter change already shows page 1.
    setPrevKey(resetKey);
    setPage(0);
  }
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => items.slice(current * pageSize, (current + 1) * pageSize),
    [items, current, pageSize],
  );
  return { pageItems, page: current, pageCount, pageSize, total: items.length, setPage };
}

/** "Showing 101–200 of 2,877" plus Previous/Next. Renders nothing for a single page, so short
 * lists look exactly as they did. Pass `scrollTo` to bring the list's top back into view when
 * Previous/Next is clicked — otherwise Next at the bottom leaves you at the bottom of the new
 * page. */
export function ListPager<T>({
  paged,
  scrollTo,
  noun = "rows",
  className,
}: {
  paged: Paged<T>;
  scrollTo?: RefObject<HTMLElement | null>;
  noun?: string;
  /** Applied to the pager's own root, so a border/padding around it disappears with it. */
  className?: string;
}) {
  const { page, pageCount, pageSize, total, setPage } = paged;
  // Scrolls only from these buttons — never from a filter change resetting to page 1, which
  // would yank a search box someone is typing into off screen.
  const goTo = (next: number) => {
    setPage(next);
    const el = scrollTo?.current;
    if (!el) return;
    if (el.scrollHeight > el.clientHeight) {
      // A list inside its own scroll box (Call Queue, Accounts): back to its first row, and the
      // box brought into view in case the page has scrolled past it.
      el.scrollTop = 0;
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      // A list that scrolls with the page (Debtors card grid): "nearest" would not move at all
      // for an element taller than the viewport, so align its top explicitly.
      el.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-1 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="tabular-nums">
        Showing {from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of{" "}
        {total.toLocaleString("en-IN")} {noun}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={page === 0}
          onClick={() => goTo(page - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Previous
        </Button>
        <span className="tabular-nums px-1">
          Page {page + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={page >= pageCount - 1}
          onClick={() => goTo(page + 1)}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
