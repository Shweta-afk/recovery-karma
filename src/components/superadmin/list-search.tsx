// One small search box for superadmin tables (user, 2026-11-27: "add filters everywhere in the
// superadmin portal"). `useListSearch` filters any list by the text you give it for each row, so
// every table behaves the same: case-insensitive, any word order, nothing sent to the server.
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

export function useListSearch<T>(items: T[], textOf: (item: T) => string) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter((it) => {
      const text = textOf(it).toLowerCase();
      return words.every((w) => text.includes(w));
    });
    // textOf is a stable per-call lambda over the item; items + query are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query]);
  return { query, setQuery, shown, filtered: query.trim() !== "" };
}

export function ListSearch({
  query,
  setQuery,
  placeholder = "Search…",
  shown,
  total,
}: {
  query: string;
  setQuery: (q: string) => void;
  placeholder?: string;
  /** With `total`, shows "N of M" while a search is active. */
  shown?: number;
  total?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-full max-w-[16rem]">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-border bg-card pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            title="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {query.trim() && shown != null && total != null && (
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
          {shown} of {total}
        </span>
      )}
    </div>
  );
}
