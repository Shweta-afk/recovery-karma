import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, parseCsvLine } from "@/lib/utils";
import { dpd2bucket, type UploadedDebtor } from "@/lib/portfolio-store";
import { resolveMapping, confidenceLabel, type MappingResult } from "@/lib/column-mapper";
import { findTemplate, refreshMappingTemplates } from "@/lib/mapping-template-store";
import {
  STD_FIELDS,
  REQUIRED_STD_FIELDS,
  mappingFromResult,
  type StdFieldKey,
} from "@/lib/csv-fields";

// The upload-wizard's file-drop + column-mapping steps, as a standalone unit — also used by
// the Edit Portfolio "Add / Re-upload Accounts" flow, which needs the same CSV → mapped-rows
// pipeline but outside the wizard's step machinery. Owns file/mapping state internally and
// reports the derived rows + validity up via callbacks; the parent decides what to do with them.

const CONF_TONE: Record<string, string> = {
  template: "bg-violet-500/10 text-violet-600 border-violet-400/30",
  high: "bg-success/10 text-success border-success/30",
  medium: "bg-amber-500/10 text-amber-600 border-amber-400/30",
  low: "bg-orange-500/10 text-orange-600 border-orange-400/30",
  none: "bg-muted text-muted-foreground border-border",
};

function ConfidenceBadge({ suggestion }: { suggestion?: MappingResult[string] }) {
  if (!suggestion || !suggestion.column) return null;
  const { label, tone } = confidenceLabel(suggestion);
  return (
    <Badge
      variant="outline"
      className={cn("text-[9px] h-4 px-1.5 font-medium capitalize", CONF_TONE[tone])}
    >
      {label}
    </Badge>
  );
}

export interface CsvImportRowIssue {
  row: number; // 1-indexed CSV row number (header row + 1)
  fields: string[];
}

export interface CsvImportResult {
  rows: UploadedDebtor[];
  valid: boolean; // file loaded, every required field mapped, no per-row blanks
  rawHeaders: string[];
  mapping: Record<StdFieldKey, string>;
}

export function CsvImportStep({
  lenderName,
  onChange,
}: {
  lenderName: string;
  /** Fires whenever the derived rows or validity change — includes rawHeaders/mapping so the
   * caller can saveTemplate() itself once its own import/merge action actually succeeds. */
  onChange: (result: CsvImportResult) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const [fileName, setFileName] = useState("");
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<StdFieldKey, string>>(
    {} as Record<StdFieldKey, string>,
  );
  const [suggestions, setSuggestions] = useState<MappingResult>({});
  const [templateApplied, setTemplateApplied] = useState(false);

  useEffect(() => {
    refreshMappingTemplates();
  }, []);

  const mappedRows: UploadedDebtor[] = useMemo(
    () =>
      rawRows.map((vals, i) => {
        const get = (key: StdFieldKey) => {
          const col = mapping[key];
          if (!col) return "";
          const idx = rawHeaders.indexOf(col);
          return idx !== -1 ? (vals[idx] ?? "").trim() : "";
        };
        const dpd = parseInt(get("dpd") || "0", 10);
        const mappedCols = new Set(Object.values(mapping).filter(Boolean));
        const extra: Record<string, string> = {};
        rawHeaders.forEach((h, idx) => {
          if (!mappedCols.has(h)) extra[h] = vals[idx] ?? "";
        });
        return {
          id: crypto.randomUUID(),
          loanReference: get("loan_id"),
          name: get("name"),
          phone: get("phone"),
          loanAmount: parseFloat(get("loan_amount").replace(/[,₹\s]/g, "")) || 0,
          dpd,
          bucket: dpd2bucket(dpd),
          email: get("email"),
          extra: {
            address: get("address"),
            city: get("city"),
            state: get("state"),
            dob: get("dob"),
            employer: get("employer"),
            income: get("income"),
            ...extra,
          },
        };
      }),
    [rawRows, rawHeaders, mapping],
  );

  const rowIssues: CsvImportRowIssue[] = useMemo(
    () =>
      rawRows.reduce<CsvImportRowIssue[]>((acc, vals, i) => {
        const missing: string[] = [];
        for (const f of REQUIRED_STD_FIELDS) {
          const col = mapping[f.key];
          if (!col) continue;
          const idx = rawHeaders.indexOf(col);
          const val = idx !== -1 ? (vals[idx] ?? "").trim() : "";
          if (!val) missing.push(f.label);
        }
        if (missing.length) acc.push({ row: i + 2, fields: missing });
        return acc;
      }, []),
    [rawRows, rawHeaders, mapping],
  );

  const unmappedRequired = REQUIRED_STD_FIELDS.filter((f) => !mapping[f.key]);
  const hasFile = rawHeaders.length > 0;
  const valid = hasFile && unmappedRequired.length === 0 && rowIssues.length === 0;

  useEffect(() => {
    onChange({ rows: mappedRows, valid, rawHeaders, mapping });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappedRows, valid, rawHeaders, mapping]);

  const processFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith(".csv")) {
        toast.error("Only CSV files are accepted");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) {
          toast.error("CSV must have a header row and at least one data row");
          return;
        }
        const headers = parseCsvLine(lines[0]);
        const rows = lines.slice(1, 5001).map((l) => parseCsvLine(l));

        const template = findTemplate(lenderName, headers);
        const result = resolveMapping(headers, rows, template?.mapping ?? null);

        setRawHeaders(headers);
        setRawRows(rows);
        setSuggestions(result);
        setMapping(mappingFromResult(result));
        setTemplateApplied(!!template);
        setFileName(file.name);

        if (template) {
          toast.success(`Applied saved mapping for ${template.lenderLabel}`, {
            description: `${rows.length} rows · review & confirm`,
          });
        } else {
          const autoCount = Object.values(result).filter((s) => s.column).length;
          toast.success(
            `Parsed ${rows.length} rows — auto-mapped ${autoCount} of ${STD_FIELDS.length} fields`,
            { description: file.name },
          );
        }
      };
      reader.readAsText(file);
    },
    [lenderName],
  );

  const resetFile = () => {
    setFileName("");
    setRawHeaders([]);
    setRawRows([]);
    setMapping({} as Record<StdFieldKey, string>);
    setSuggestions({});
    setTemplateApplied(false);
  };

  return (
    <div className="space-y-4">
      {!hasFile ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) processFile(f);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors",
            dragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-primary/40 hover:bg-accent/30",
          )}
        >
          <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-sm font-medium text-foreground">Drop CSV here or click to browse</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Any column names — you'll map them below
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) processFile(f);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
            <FileSpreadsheet className="h-5 w-5 text-success flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{fileName}</p>
              <p className="text-xs text-muted-foreground">
                {rawRows.length} rows · {rawHeaders.length} columns detected
              </p>
            </div>
            <button
              type="button"
              onClick={resetFile}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {templateApplied && (
            <div className="flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-500/5 px-3 py-2 text-xs text-violet-600">
              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
              <span>Applied this bank's saved mapping. Only confirm what changed.</span>
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
            <span>Confidence:</span>
            {[
              ["saved", "template"],
              ["high", "high"],
              ["likely", "medium"],
              ["guess", "low"],
            ].map(([lbl, tone]) => (
              <Badge
                key={tone}
                variant="outline"
                className={cn("text-[9px] h-4 px-1.5 capitalize", CONF_TONE[tone])}
              >
                {lbl}
              </Badge>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {STD_FIELDS.map(({ key, label, required }) => {
              const sug = suggestions[key];
              const lowConf = !!sug?.column && sug.source !== "template" && sug.confidence < 0.6;
              return (
                <div key={key} className="space-y-1">
                  <label className="text-xs font-medium text-foreground flex items-center gap-1">
                    {label}
                    {required ? (
                      <span className="text-destructive ml-0.5">*</span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground font-normal">
                        (optional)
                      </span>
                    )}
                    <span className="ml-auto">
                      <ConfidenceBadge suggestion={sug} />
                    </span>
                  </label>
                  <Select
                    value={mapping[key] || "__none__"}
                    onValueChange={(val) =>
                      setMapping((m) => ({ ...m, [key]: val === "__none__" ? "" : val }))
                    }
                  >
                    <SelectTrigger
                      className={cn(
                        "h-8 text-xs",
                        required &&
                          !mapping[key] &&
                          "border-destructive/50 focus:ring-destructive/30",
                        lowConf && "border-amber-400/50 focus:ring-amber-400/30",
                      )}
                    >
                      <SelectValue placeholder="— not mapped —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        <span className="text-muted-foreground">— not mapped —</span>
                      </SelectItem>
                      {rawHeaders.map((h) => (
                        <SelectItem key={h} value={h}>
                          <span className="font-mono">{h}</span>
                          {rawRows[0]?.[rawHeaders.indexOf(h)] && (
                            <span className="text-muted-foreground ml-2 text-[10px]">
                              e.g. {rawRows[0][rawHeaders.indexOf(h)]}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>

          {unmappedRequired.length > 0 && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <span className="font-semibold">Missing required:</span>{" "}
              {unmappedRequired.map((f) => f.label).join(", ")}
            </p>
          )}

          {rowIssues.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive space-y-1.5">
              <p>
                {rowIssues.length} row{rowIssues.length === 1 ? "" : "s"} missing required data.
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                {rowIssues.slice(0, 10).map((r) => (
                  <li key={r.row}>
                    CSV row {r.row}: missing {r.fields.join(", ")}
                  </li>
                ))}
                {rowIssues.length > 10 && <li>…and {rowIssues.length - 10} more</li>}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
