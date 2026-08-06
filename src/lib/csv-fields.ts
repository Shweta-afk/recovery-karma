// Canonical debtor CSV fields — shared by the upload wizard (manager.upload.tsx) and the
// Edit Portfolio re-upload flow (manager.portfolio.tsx) so both map onto the exact same set.
// Keep in sync with column-mapper.ts's alias/detector specs, which key off these same names.
import type { MappingResult } from "./column-mapper";

export const STD_FIELDS = [
  { key: "loan_id", label: "Loan / Account ID", required: true },
  { key: "name", label: "Borrower Name", required: true },
  { key: "phone", label: "Phone Number", required: true },
  { key: "loan_amount", label: "Outstanding Amount", required: true },
  { key: "dpd", label: "Days Past Due", required: true },
  { key: "email", label: "Email Address", required: false },
  { key: "address", label: "Address", required: false },
  { key: "city", label: "City", required: false },
  { key: "state", label: "State", required: false },
  { key: "dob", label: "Date of Birth", required: false },
  { key: "employer", label: "Employer", required: false },
  { key: "income", label: "Monthly Income", required: false },
] as const;

export type StdFieldKey = (typeof STD_FIELDS)[number]["key"];

export const REQUIRED_STD_FIELDS = STD_FIELDS.filter((f) => f.required);

// Extract the chosen source header per field from a resolver result
export function mappingFromResult(result: MappingResult): Record<StdFieldKey, string> {
  const m = {} as Record<StdFieldKey, string>;
  for (const { key } of STD_FIELDS) m[key] = result[key]?.column ?? "";
  return m;
}
