// Column mapping resolver — maps arbitrary bank CSV headers onto our canonical fields.
//
// It never relies on an exhaustive header list. Instead it scores every (field × column)
// pair with three signals — alias dictionary, fuzzy header similarity, and value/content
// inference — then greedily assigns the best non-conflicting matches. A saved per-bank
// template (if supplied) is applied first at full confidence.
//
// NOTE: the field keys here must stay in sync with STD_FIELDS in csv-fields.ts.

export type MappingSource = "template" | "alias" | "fuzzy" | "value" | "none";

export interface FieldSuggestion {
  column: string; // matched source header ("" when unmapped)
  confidence: number; // 0..1
  source: MappingSource;
}

export type MappingResult = Record<string, FieldSuggestion>;

interface FieldSpec {
  key: string;
  aliases: string[]; // known header spellings (normalized on compare)
  /** value-content detector: fraction 0..1 of sampled values that look like this field */
  detect?: (values: string[]) => number;
}

// ─── Normalization + string similarity ────────────────────────────────────────

export function normHeader(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[n];
}

function levRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a),
    sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Similarity 0..1 between a normalized header and a normalized alias. */
function headerSim(colNorm: string, alias: string): number {
  if (colNorm === alias) return 1;
  const jac = jaccard(colNorm.split("_"), alias.split("_"));
  const lr = levRatio(colNorm, alias);
  const contains =
    (colNorm.includes(alias) || alias.includes(colNorm)) && alias.length >= 3 ? 0.85 : 0;
  return Math.max(jac, lr, contains);
}

// ─── Value-content detectors ──────────────────────────────────────────────────

const clean = (v: string) => (v ?? "").trim();
const nonEmpty = (values: string[]) => values.map(clean).filter(Boolean);

function frac(values: string[], test: (v: string) => boolean): number {
  const vals = nonEmpty(values);
  if (!vals.length) return 0;
  return vals.filter(test).length / vals.length;
}

const digitsOnly = (v: string) => v.replace(/\D/g, "");
const toNumber = (v: string) => parseFloat(v.replace(/[,₹\s]/g, ""));
const isNumeric = (v: string) => v !== "" && !isNaN(toNumber(v));

const detectPhone = (values: string[]) =>
  frac(values, (v) => {
    const d = digitsOnly(v);
    return d.length >= 10 && d.length <= 13 && /^[+\d][\d\s\-()]+$/.test(v);
  });

const detectEmail = (values: string[]) => frac(values, (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));

const detectDate = (values: string[]) =>
  frac(
    values,
    (v) => /^\d{4}-\d{1,2}-\d{1,2}/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v),
  );

// DPD: whole numbers in a plausible days-overdue range (small magnitude)
const detectDpd = (values: string[]) => {
  const nums = nonEmpty(values).filter(isNumeric).map(toNumber);
  if (!nums.length) return 0;
  const numericFrac = nums.length / nonEmpty(values).length;
  const inRange =
    nums.filter((n) => Number.isInteger(n) && n >= 0 && n <= 2000).length / nums.length;
  const max = Math.max(...nums);
  const magnitudeOk = max <= 2000 ? 1 : 0.2;
  return numericFrac * inRange * magnitudeOk;
};

// Money: numeric, larger magnitude, often with separators
const detectAmount = (values: string[]) => {
  const vals = nonEmpty(values);
  const nums = vals.filter(isNumeric).map(toNumber);
  if (!nums.length) return 0;
  const numericFrac = nums.length / vals.length;
  const bigEnough = nums.filter((n) => Math.abs(n) >= 500).length / nums.length;
  const median = [...nums].sort((a, b) => a - b)[Math.floor(nums.length / 2)];
  const magnitude = median >= 1000 ? 1 : median >= 500 ? 0.6 : 0.25;
  return numericFrac * bigEnough * magnitude;
};

// Human name: mostly alphabetic + spaces, low digit content
const detectName = (values: string[]) =>
  frac(values, (v) => /^[a-zA-Z][a-zA-Z .'-]{2,}$/.test(v) && /\s/.test(v.trim() + " a"));

// Preferred language: values drawn from a small, closed set of Indian language names
const KNOWN_LANGUAGES = new Set([
  "english",
  "hindi",
  "marathi",
  "gujarati",
  "tamil",
  "telugu",
  "kannada",
  "malayalam",
  "bengali",
  "punjabi",
  "odia",
  "oriya",
  "assamese",
  "urdu",
]);
const detectLanguage = (values: string[]) =>
  frac(values, (v) => KNOWN_LANGUAGES.has(v.trim().toLowerCase()));

// Loan/account id: alphanumeric codes, frequently letter+digit or dashed
const detectId = (values: string[]) =>
  frac(
    values,
    (v) =>
      (/^[A-Za-z0-9][A-Za-z0-9\-_/]{2,}$/.test(v) && /\d/.test(v) && !isNumeric(v)) ||
      /^[A-Za-z]{1,4}[-_]?\d{3,}$/.test(v),
  );

// ─── Canonical field specs ────────────────────────────────────────────────────

export const FIELD_SPECS: FieldSpec[] = [
  {
    key: "loan_id",
    aliases: [
      "loan_id",
      "id",
      "account_id",
      "loanid",
      "acc_id",
      "accountid",
      "account_no",
      "loan_no",
      "lan",
      "agreement_no",
      "case_id",
      "ref_no",
    ],
    detect: detectId,
  },
  {
    key: "name",
    aliases: [
      "name",
      "customer_name",
      "borrower_name",
      "debtor_name",
      "full_name",
      "client_name",
      "cust_name",
      "applicant_name",
      "account_name",
    ],
    detect: detectName,
  },
  {
    key: "phone",
    aliases: [
      "phone",
      "mobile",
      "contact",
      "phone_number",
      "mobile_no",
      "contact_no",
      "cell",
      "mob",
      "primary_phone",
      "contact_number",
      "msisdn",
    ],
    detect: detectPhone,
  },
  {
    key: "loan_amount",
    aliases: [
      "loan_amount",
      "amount",
      "outstanding",
      "outstanding_amount",
      "due_amount",
      "balance",
      "pos",
      "os_amount",
      "total_due",
      "current_balance",
      "emi_outstanding",
    ],
    detect: detectAmount,
  },
  {
    // Distinct from loan_amount ("Outstanding Amount") — the original sanctioned/disbursed sum,
    // which a bank file sometimes carries as its own column separate from the current balance.
    // "principal" used to be a loan_amount alias; moved here 2026-09-05 since a column literally
    // named "Principal" means this field, not outstanding.
    key: "principal_amount",
    aliases: [
      "principal",
      "principal_amount",
      "sanctioned_amount",
      "disbursed_amount",
      "loan_principal",
      "original_amount",
      "principal_outstanding",
    ],
    detect: detectAmount,
  },
  {
    key: "emi_amount",
    aliases: [
      "emi_amount",
      "emi",
      "emi_amt",
      "monthly_emi",
      "installment_amount",
      "installment",
      "monthly_installment",
    ],
    detect: detectAmount,
  },
  {
    // Per-debtor product identifier from the bank's own file — distinct from the portfolio-wide
    // Product Type picker in the upload wizard (PRODUCT_LABEL_TO_ENUM), which applies one label
    // to every row. A file that mixes products (e.g. several card variants in one credit-card
    // book) can carry its own per-row code here instead of losing that distinction.
    key: "product_code",
    aliases: [
      "product_code",
      "product",
      "product_type",
      "loan_type",
      "scheme_code",
      "product_id",
      "card_type",
      "scheme",
    ],
  },
  {
    key: "dpd",
    aliases: [
      "dpd",
      "days_past_due",
      "overdue_days",
      "days_overdue",
      "days_due",
      "past_due",
      "delinquency_days",
      "bucket_days",
    ],
    detect: detectDpd,
  },
  {
    key: "email",
    aliases: ["email", "email_id", "email_address", "mail", "e_mail"],
    detect: detectEmail,
  },
  {
    key: "address",
    aliases: [
      "address",
      "addr",
      "full_address",
      "residential_address",
      "mailing_address",
      "permanent_address",
    ],
  },
  { key: "city", aliases: ["city", "town", "district"] },
  { key: "state", aliases: ["state", "province", "region"] },
  { key: "dob", aliases: ["dob", "date_of_birth", "birth_date", "birthdate"], detect: detectDate },
  {
    key: "employer",
    aliases: ["employer", "company", "employer_name", "organization", "company_name", "workplace"],
  },
  // income shares a value shape with loan_amount, so it maps by header only — a bare money
  // column should always fall to the required loan_amount field, not income.
  {
    key: "income",
    aliases: [
      "income",
      "monthly_income",
      "salary",
      "monthly_salary",
      "net_income",
      "annual_income",
    ],
  },
  {
    key: "language",
    aliases: [
      "language",
      "preferred_language",
      "pref_language",
      "lang",
      "mother_tongue",
      "communication_language",
      "comm_language",
      "regional_language",
    ],
    detect: detectLanguage,
  },
];

// ─── Scoring + greedy assignment ──────────────────────────────────────────────

const ASSIGN_THRESHOLD = 0.42;

function scoreFieldColumn(
  spec: FieldSpec,
  colNorm: string,
  values: string[],
): { score: number; source: MappingSource } {
  const headerScore = Math.max(0, ...spec.aliases.map((a) => headerSim(colNorm, a)));
  const valueScore = spec.detect ? spec.detect(values) : 0;

  // Strong header hit dominates; otherwise blend header + value evidence. The blended score
  // is capped below 0.92 (the "strong header hit" threshold above) so a fuzzy/value-inferred
  // guess can never tie with, let alone beat, a genuine alias match — without this cap, a
  // header like "Company Name" (an exact alias for employer) could blend its way up to the
  // same 1.0 ceiling as "name"'s fuzzy contains-match ("company_name" contains "name") plus
  // its value match (an all-letters column looks like a human name too), and the greedy
  // assigner's tie-break would then hand that column to whichever field is declared first —
  // silently mapping the lender's own company name onto every debtor's "name".
  if (headerScore >= 0.92)
    return { score: Math.min(1, headerScore + valueScore * 0.05), source: "alias" };
  const blended = Math.min(0.9, 0.7 * headerScore + 0.5 * valueScore);
  const source: MappingSource = headerScore >= valueScore ? "fuzzy" : "value";
  return { score: blended, source };
}

/**
 * Resolve a mapping from source headers → canonical fields.
 * @param headers    the CSV header row
 * @param sampleRows a handful of data rows (used for value inference)
 * @param template   optional saved mapping (fieldKey → source header) applied first
 */
export function resolveMapping(
  headers: string[],
  sampleRows: string[][],
  template?: Record<string, string> | null,
): MappingResult {
  const result: MappingResult = {};
  for (const spec of FIELD_SPECS) result[spec.key] = { column: "", confidence: 0, source: "none" };

  const usedCols = new Set<string>();
  const assignedFields = new Set<string>();

  // Per-column value samples (cap the work)
  const sampleCols: Record<string, string[]> = {};
  headers.forEach((h, idx) => {
    sampleCols[h] = sampleRows.slice(0, 30).map((r) => r[idx] ?? "");
  });

  // 1) Apply saved template first — only for columns that still exist in this file
  if (template) {
    for (const spec of FIELD_SPECS) {
      const col = template[spec.key];
      if (col && headers.includes(col) && !usedCols.has(col)) {
        result[spec.key] = { column: col, confidence: 1, source: "template" };
        usedCols.add(col);
        assignedFields.add(spec.key);
      }
    }
  }

  // 2) Score every remaining (field × column) pair
  const pairs: { field: string; col: string; score: number; source: MappingSource }[] = [];
  for (const spec of FIELD_SPECS) {
    if (assignedFields.has(spec.key)) continue;
    for (const col of headers) {
      const { score, source } = scoreFieldColumn(spec, normHeader(col), sampleCols[col]);
      if (score >= ASSIGN_THRESHOLD) pairs.push({ field: spec.key, col, score, source });
    }
  }

  // 3) Greedy: highest score first, one column per field and one field per column.
  //    Ties break toward the earlier canonical field (e.g. loan_amount before income)
  //    so a required field wins a shared value detector over an optional one.
  const fieldRank = new Map(FIELD_SPECS.map((s, i) => [s.key, i]));
  pairs.sort((a, b) => b.score - a.score || fieldRank.get(a.field)! - fieldRank.get(b.field)!);
  for (const p of pairs) {
    if (assignedFields.has(p.field) || usedCols.has(p.col)) continue;
    result[p.field] = {
      column: p.col,
      confidence: Math.round(p.score * 100) / 100,
      source: p.source,
    };
    assignedFields.add(p.field);
    usedCols.add(p.col);
  }

  return result;
}

/** Convenience label for a confidence score. */
export function confidenceLabel(s: FieldSuggestion): {
  label: string;
  tone: "template" | "high" | "medium" | "low" | "none";
} {
  if (!s.column) return { label: "unmapped", tone: "none" };
  if (s.source === "template") return { label: "saved", tone: "template" };
  if (s.confidence >= 0.85) return { label: "high", tone: "high" };
  if (s.confidence >= 0.6) return { label: "likely", tone: "medium" };
  return { label: "guess", tone: "low" };
}
