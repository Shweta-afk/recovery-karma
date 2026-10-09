// In-page help for the superadmin portal: the ⓘ hint beside a number or column heading, and
// the "How to read this page" box at the top of a page. Text lives in lib/superadmin-glossary.ts.

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { HelpCircle, Info, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  GLOSSARY,
  PAGE_GUIDES,
  type GlossaryKey,
  type PageGuideKey,
} from "@/lib/superadmin-glossary";

/**
 * A small ⓘ that explains a term. A Popover rather than a Tooltip because phones have no hover:
 *  - hovering shows it, and it goes again when the pointer leaves;
 *  - clicking/tapping always OPENS it and pins it (a toggle would undo itself — touch browsers
 *    fire mouseenter just before the click, so the tap would open then immediately close it);
 *  - clicking anywhere else or pressing Escape closes a pinned one.
 */
export function InfoTip({ k, className }: { k: GlossaryKey; className?: string }) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const scheduleClose = () => {
    if (pinned.current) return;
    cancelClose();
    // Small delay so moving the pointer from the icon onto the popover doesn't close it.
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => cancelClose, []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Radix calls this with false on an outside click or Escape.
        if (!next) pinned.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${entry.term}?`}
          onClick={(e) => {
            // preventDefault also stops Radix's own toggle; stopPropagation keeps a clickable
            // table row or link around the hint from firing too.
            e.preventDefault();
            e.stopPropagation();
            cancelClose();
            pinned.current = true;
            setOpen(true);
          }}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          className={cn(
            "inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground/70 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary",
            className,
          )}
        >
          <Info className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-64 p-3 text-xs font-normal normal-case"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 font-semibold text-foreground">{entry.term}</div>
        <p className="leading-relaxed text-muted-foreground">{entry.text}</p>
      </PopoverContent>
    </Popover>
  );
}

const GUIDE_KEY = (page: string) => `superadmin-guide-hidden:${page}`;

/** "How to read this page" — a few plain bullets, closable; stays closed per browser. */
export function PageGuide({ page }: { page: PageGuideKey }) {
  const guide = PAGE_GUIDES[page];
  // Start hidden and decide after mount (localStorage isn't available during SSR), so a
  // dismissed guide never flashes in.
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(GUIDE_KEY(page)) === "1");
    } catch {
      setHidden(false);
    }
  }, [page]);
  const setAndRemember = (h: boolean) => {
    setHidden(h);
    try {
      if (h) localStorage.setItem(GUIDE_KEY(page), "1");
      else localStorage.removeItem(GUIDE_KEY(page));
    } catch {
      // Remembering is a convenience only.
    }
  };

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setAndRemember(false)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5" /> How to read this page
      </button>
    );
  }
  return (
    <div className="relative rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 pr-9 text-xs">
      <button
        type="button"
        aria-label="Hide this guide"
        onClick={() => setAndRemember(true)}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
        <HelpCircle className="h-3.5 w-3.5 text-primary" /> How to read this page
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {guide.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <Link
        to="/superadmin/help"
        className="mt-1.5 inline-block text-[11px] font-medium text-primary hover:underline"
      >
        Full guide to every number →
      </Link>
    </div>
  );
}
