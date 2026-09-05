import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Small inline "copy to clipboard" icon button — for a phone number or loan/account ID sitting
 * next to other text, where a full Button would be too heavy. Flashes a checkmark for 1.2s on
 * success as immediate visual feedback, on top of the toast (which a user glancing at a dense
 * table might miss). Silently no-ops if `value` is empty — nothing to copy, no button to show. */
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string | undefined | null;
  /** Screen-reader label and toast description — e.g. "phone number", "loan ID". */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(`Couldn't copy ${label.toLowerCase()}`);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}`}
      className={cn(
        "inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
