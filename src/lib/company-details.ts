// A company's own details for invoices and agreements — what each company ADMIN must fill in on
// Admin → Settings. Stored in client_billing (migrations/20261011_company_details.sql), the same
// row invoices and contract templates already read. Pure: the server action, the settings form,
// the admin-wide banner and the tests share these rules (scripts/company-details.test.ts).
import { GSTIN_RE, normaliseGstin, stateFromGstin, stateName } from "./invoice-math";

export interface CompanyDetails {
  legalName: string;
  /** Not registered for GST — then no GSTIN is needed (and the invoice says "Unregistered"). */
  gstUnregistered: boolean;
  gstin: string;
  pan: string;
  /** Only companies and LLPs have one — optional. */
  cin: string;
  address: string;
  city: string;
  pinCode: string;
  /** GST state code, two digits (invoice-math.ts GST_STATES) — decides CGST+SGST vs IGST. */
  stateCode: string;
  /** Where invoices are sent. */
  email: string;
  phone: string;
  /** Who signs agreements for the company. */
  signatoryName: string;
  signatoryDesignation: string;
}

export const EMPTY_COMPANY_DETAILS: CompanyDetails = {
  legalName: "",
  gstUnregistered: false,
  gstin: "",
  pan: "",
  cin: "",
  address: "",
  city: "",
  pinCode: "",
  stateCode: "",
  email: "",
  phone: "",
  signatoryName: "",
  signatoryDesignation: "",
};

export const COMPANY_FIELD_LABEL: Record<keyof CompanyDetails, string> = {
  legalName: "Registered legal name",
  gstUnregistered: "Not registered for GST",
  gstin: "GSTIN",
  pan: "Company PAN",
  cin: "CIN / LLPIN",
  address: "Registered address",
  city: "City",
  pinCode: "PIN code",
  stateCode: "State",
  email: "Billing email",
  phone: "Billing phone",
  signatoryName: "Authorised signatory name",
  signatoryDesignation: "Authorised signatory designation",
};

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const PIN_RE = /^[1-9]\d{5}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(\+?91)?[6-9]\d{9}$|^0\d{9,11}$/;
// Company CIN (21 chars, e.g. U72900KA2020PTC123456) or LLPIN (AAA-1234).
const CIN_RE = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$|^[A-Z]{3}-\d{4}$/;

/** Cleans what was typed: trims, upper-cases identifiers, strips spaces from numbers. */
export function normaliseCompanyDetails(d: CompanyDetails): CompanyDetails {
  return {
    ...d,
    legalName: d.legalName.trim(),
    gstin: d.gstUnregistered ? "" : normaliseGstin(d.gstin),
    pan: d.pan.trim().toUpperCase().replace(/\s/g, ""),
    cin: d.cin.trim().toUpperCase().replace(/\s/g, ""),
    address: d.address.trim(),
    city: d.city.trim(),
    pinCode: d.pinCode.replace(/\D/g, ""),
    stateCode: d.stateCode.trim(),
    email: d.email.trim(),
    phone: d.phone.replace(/[\s-]/g, ""),
    signatoryName: d.signatoryName.trim(),
    signatoryDesignation: d.signatoryDesignation.trim(),
  };
}

export interface CompanyDetailsCheck {
  /** Labels of required details still empty. Empty list = complete. */
  missing: string[];
  /** Field → what is wrong with what was typed (format, mismatch). */
  invalid: Partial<Record<keyof CompanyDetails, string>>;
}

/** What is missing and what is wrong. Saving is allowed while things are missing (the banner
 *  stays up); it is refused while anything typed is invalid. */
export function checkCompanyDetails(raw: CompanyDetails): CompanyDetailsCheck {
  const d = normaliseCompanyDetails(raw);
  const required: (keyof CompanyDetails)[] = [
    "legalName",
    ...(d.gstUnregistered ? [] : (["gstin"] as const)),
    "pan",
    "address",
    "city",
    "pinCode",
    "stateCode",
    "email",
    "phone",
    "signatoryName",
    "signatoryDesignation",
  ];
  const missing = required.filter((k) => !String(d[k]).trim()).map((k) => COMPANY_FIELD_LABEL[k]);

  const invalid: CompanyDetailsCheck["invalid"] = {};
  if (d.gstin && !GSTIN_RE.test(d.gstin)) invalid.gstin = "15 characters, e.g. 27AAPFU0939F1ZV";
  if (d.pan && !PAN_RE.test(d.pan)) invalid.pan = "10 characters, e.g. AAPFU0939F";
  if (d.cin && !CIN_RE.test(d.cin)) invalid.cin = "21-character CIN or an LLPIN like AAB-1234";
  if (d.pinCode && !PIN_RE.test(d.pinCode)) invalid.pinCode = "6 digits";
  if (d.stateCode && !stateName(d.stateCode)) invalid.stateCode = "Pick a state";
  if (d.email && !EMAIL_RE.test(d.email)) invalid.email = "A valid email address";
  if (d.phone && !PHONE_RE.test(d.phone))
    invalid.phone = "A 10-digit mobile or a landline with STD code";
  // A GSTIN carries the state (first 2 digits) and the PAN (next 10) — catch the common slips.
  if (d.gstin && GSTIN_RE.test(d.gstin)) {
    const gstState = stateFromGstin(d.gstin);
    if (d.stateCode && gstState && gstState !== d.stateCode) {
      invalid.stateCode = `Your GSTIN is registered in ${stateName(gstState)}`;
    }
    if (d.pan && PAN_RE.test(d.pan) && d.gstin.slice(2, 12) !== d.pan) {
      invalid.pan = "Doesn't match the PAN inside your GSTIN";
    }
  }
  return { missing, invalid };
}

export const isCompanyDetailsComplete = (d: CompanyDetails): boolean => {
  const c = checkCompanyDetails(d);
  return c.missing.length === 0 && Object.keys(c.invalid).length === 0;
};

/** client_billing row → form shape. Columns missing on an older database read as empty. */
export function companyDetailsFromRow(
  r: Record<string, unknown> | null | undefined,
): CompanyDetails {
  const s = (k: string) => (r?.[k] == null ? "" : String(r[k]));
  return {
    legalName: s("legal_name"),
    gstUnregistered: !!r?.gst_unregistered,
    gstin: s("gstin"),
    pan: s("pan"),
    cin: s("cin"),
    address: s("address"),
    city: s("city"),
    pinCode: s("pin_code"),
    stateCode: s("state_code"),
    email: s("email"),
    phone: s("phone"),
    signatoryName: s("signatory_name"),
    signatoryDesignation: s("signatory_designation"),
  };
}

/** Form shape → client_billing columns. */
export function companyDetailsToRow(d: CompanyDetails): Record<string, unknown> {
  const n = normaliseCompanyDetails(d);
  const orNull = (v: string) => (v === "" ? null : v);
  return {
    legal_name: n.legalName,
    gst_unregistered: n.gstUnregistered,
    gstin: orNull(n.gstin),
    pan: orNull(n.pan),
    cin: orNull(n.cin),
    address: n.address,
    city: orNull(n.city),
    pin_code: orNull(n.pinCode),
    state_code: orNull(n.stateCode),
    email: orNull(n.email),
    phone: orNull(n.phone),
    signatory_name: orNull(n.signatoryName),
    signatory_designation: orNull(n.signatoryDesignation),
  };
}

/** One line for invoices and agreements: "12 MG Road, Bengaluru, Karnataka – 560001". The city
 *  and PIN are left out when the address line already contains them. */
export function fullAddress(
  d: Pick<CompanyDetails, "address" | "city" | "stateCode" | "pinCode">,
): string {
  const address = d.address.trim();
  const city = d.city.trim();
  const parts = [
    address,
    city && !address.toLowerCase().includes(city.toLowerCase()) ? city : "",
    stateName(d.stateCode) ?? "",
  ].filter(Boolean);
  const pin = d.pinCode.trim();
  return pin && !address.includes(pin) ? `${parts.join(", ")} – ${pin}` : parts.join(", ");
}
