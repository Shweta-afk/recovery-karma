// The list of what the setup fee includes — text only, no amount per item (the setup fee is one
// total). Used by the price list and the setup invoice form.
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function IncludedItemsEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-4 text-center text-xs text-muted-foreground">•</span>
          <Input
            value={item}
            onChange={(e) => onChange(items.map((x, n) => (n === i ? e.target.value : x)))}
            placeholder="e.g. Domain setup"
            className="h-8 flex-1 text-xs"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground"
            aria-label={`Remove ${item || "item"}`}
            onClick={() => onChange(items.filter((_, n) => n !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-[11px]"
        disabled={items.length >= 30}
        onClick={() => onChange([...items, ""])}
      >
        <Plus className="h-3 w-3" /> Add item
      </Button>
    </div>
  );
}
