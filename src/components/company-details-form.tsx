// The company details form — fields only, no loading or saving. Used by the company admin's
// card on Admin → Settings (company-details-card.tsx) and by the superadmin on a company's
// Billing tab, so both edit exactly the same fields with exactly the same rules
// (company-details.ts).
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { GST_STATES } from "@/lib/invoice-math";
import { checkCompanyDetails, type CompanyDetails } from "@/lib/company-details";

function Field({
  label,
  required,
  error,
  hint,
  wide,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block space-y-1", wide && "sm:col-span-2")}>
      <span className="text-xs text-muted-foreground">
        {label}
        {required ? <span className="text-destructive"> *</span> : " (optional)"}
      </span>
      {children}
      {error ? (
        <span className="block text-[11px] text-destructive">{error}</span>
      ) : (
        hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}

export function CompanyDetailsForm({
  details,
  onChange,
  showMissing,
}: {
  details: CompanyDetails;
  onChange: (d: CompanyDetails) => void;
  /** Mark empty required fields — once a save has been tried. Format errors always show. */
  showMissing: boolean;
}) {
  const check = checkCompanyDetails(details);
  const set = <K extends keyof CompanyDetails>(k: K, v: CompanyDetails[K]) =>
    onChange({ ...details, [k]: v });
  const err = (k: keyof CompanyDetails, empty: boolean) =>
    check.invalid[k] ?? (showMissing && empty ? "Required" : undefined);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field
        label="Registered legal name"
        required
        error={err("legalName", !details.legalName.trim())}
        hint="e.g. Acme Recoveries Private Limited"
        wide
      >
        <Input
          value={details.legalName}
          onChange={(e) => set("legalName", e.target.value)}
          maxLength={200}
        />
      </Field>

      <div className="sm:col-span-2">
        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
          <Checkbox
            checked={details.gstUnregistered}
            onCheckedChange={(v) => set("gstUnregistered", v === true)}
          />
          Our company is not registered for GST
        </label>
      </div>
      {!details.gstUnregistered && (
        <Field
          label="GSTIN"
          required
          error={err("gstin", !details.gstin.trim())}
          hint="15 characters, from your GST certificate"
        >
          <Input
            className="uppercase"
            value={details.gstin}
            onChange={(e) => set("gstin", e.target.value.toUpperCase())}
            maxLength={15}
          />
        </Field>
      )}
      <Field label="Company PAN" required error={err("pan", !details.pan.trim())}>
        <Input
          className="uppercase"
          value={details.pan}
          onChange={(e) => set("pan", e.target.value.toUpperCase())}
          maxLength={10}
        />
      </Field>
      <Field label="CIN / LLPIN" error={err("cin", false)} hint="Companies and LLPs only">
        <Input
          className="uppercase"
          value={details.cin}
          onChange={(e) => set("cin", e.target.value.toUpperCase())}
          maxLength={21}
        />
      </Field>

      <Field
        label="Registered address"
        required
        error={err("address", !details.address.trim())}
        wide
      >
        <Input
          value={details.address}
          onChange={(e) => set("address", e.target.value)}
          maxLength={500}
          placeholder="Building, street, area"
        />
      </Field>
      <Field label="City" required error={err("city", !details.city.trim())}>
        <Input value={details.city} onChange={(e) => set("city", e.target.value)} maxLength={80} />
      </Field>
      <Field label="PIN code" required error={err("pinCode", !details.pinCode.trim())}>
        <Input
          inputMode="numeric"
          value={details.pinCode}
          onChange={(e) => set("pinCode", e.target.value.replace(/\D/g, ""))}
          maxLength={6}
        />
      </Field>
      <Field
        label="State"
        required
        error={err("stateCode", !details.stateCode)}
        hint="Decides CGST + SGST or IGST on invoices"
      >
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={details.stateCode}
          onChange={(e) => set("stateCode", e.target.value)}
        >
          <option value="">Choose…</option>
          {GST_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Billing email"
        required
        error={err("email", !details.email.trim())}
        hint="Where invoices are sent"
      >
        <Input
          type="email"
          value={details.email}
          onChange={(e) => set("email", e.target.value)}
          maxLength={200}
        />
      </Field>
      <Field label="Billing phone" required error={err("phone", !details.phone.trim())}>
        <Input
          inputMode="tel"
          value={details.phone}
          onChange={(e) => set("phone", e.target.value)}
          maxLength={15}
        />
      </Field>

      <Field
        label="Authorised signatory name"
        required
        error={err("signatoryName", !details.signatoryName.trim())}
        hint="Who signs agreements for the company"
      >
        <Input
          value={details.signatoryName}
          onChange={(e) => set("signatoryName", e.target.value)}
          maxLength={120}
        />
      </Field>
      <Field
        label="Signatory designation"
        required
        error={err("signatoryDesignation", !details.signatoryDesignation.trim())}
        hint="e.g. Director, CEO"
      >
        <Input
          value={details.signatoryDesignation}
          onChange={(e) => set("signatoryDesignation", e.target.value)}
          maxLength={120}
        />
      </Field>
    </div>
  );
}
