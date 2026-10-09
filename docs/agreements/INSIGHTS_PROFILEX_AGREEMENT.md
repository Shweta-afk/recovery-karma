# Insights (ProfileX Skip-Tracing) Service Agreement — SamvadX Platform

**Effective Date:** [DATE]  
**Between:** Axiotta Technologies Private Limited ("**Platform**")  
**And:** [PARTNER FIRM NAME] ("**Partner**" / "**Client**")

---

## 1. Service Overview

**"Insights"** is an optional, pay-per-lookup service integrated into SamvadX that provides skip-tracing and profile data via ProfileX/Neokred ("**Data Provider**"). Partner may enable Insights on a per-client basis to enrich debtor profiles with:

- **Skip Tracing** — Updated addresses, contact details, employment info
- **Employment Data** — Current and historical employer records
- **GST/UPI Information** — Business registration and payment details
- **Phone Cross-Lookups** — Reverse phone/mobile→UAN/GSTIN matching

---

## 2. How Insights Works

### 2.1 Access & Triggering

- **Only Managers & Admins** can request Insights lookups (agents see results read-only)
- Lookups are triggered manually from a debtor's **Insights tab**
- Results are cached and reused across the same portfolio to minimize cost
- Historical lookups are archived monthly for compliance and reconciliation

### 2.2 Billing Model

**Cost Structure:**
- Each service carries a **per-lookup fee** (e.g., ₹46 for Skip Tracing, ₹5–₹15 for Employment)
- Fees vary by **result status:**
  - **Found (Status 1)** — typically ₹46
  - **Not Found (Status 2/3)** — typically ₹1–₹5 (still billable; "not found" is also a result)
  - **Error (HTTP 500)** — not billable
- **Price list** is maintained by Data Provider and shared in Appendix A

### 2.3 Caching & Reuse (Cost Savings)

To avoid duplicate charges:
- **Same phone + same service, same month** — reused at ₹0 (no new charge)
- **Cross-portfolio reuse** — if another partner uploads the same debtor, the cached result is reused
- **Monthly archive** — all lookups (paid and cached) are permanently stored per IST month for audit
- **Cache invalidation** — Partner may request a fresh lookup (recharging if same month) via Support

---

## 3. Data Shared with ProfileX

Partner acknowledges that the following **borrower data is shared with Data Provider** to fulfill Insights requests:

- Borrower mobile number (required)
- Borrower name
- Loan reference / account number
- Employment status, GST/UPI (when chaining dependent lookups)

**Partner remains responsible** for:
- Obtaining borrower consent for third-party data sharing (where legally required)
- Ensuring compliance with privacy laws in the borrower's jurisdiction
- Notifying borrowers if their data is sold/shared (per applicable privacy policies)

**Axiotta will not:**
- Share Partner's internal collection strategies, call scripts, or agent data
- Provide Data Provider access to Partner's Portal or call logs
- Combine ProfileX results with call data before sharing with Data Provider

---

## 4. Accuracy & Limitations

**Data Provider does NOT guarantee:**
- 100% accuracy of returned data — results are best-effort lookups
- Real-time updates — data may be 30–90 days old
- Completeness — "not found" does not mean the borrower has no known address

**Partner acknowledges:**
- All skip-trace results are **suggestions only** for use in collection strategy
- Axiotta & Data Provider are not liable for wrong, outdated, or misleading data
- Partner must independently verify critical information before legal/regulatory action
- Collection calls based on incorrect address data are Partner's liability, not Axiotta's

---

## 5. Monthly Budget & Limits

### 5.1 Budget Control

**Per-Client Monthly Budget:** ₹[X] (set by Admin during client enablement)

**Budget Period:** IST Calendar Month (1st–end of month, reset on 1st)

**When budget is exhausted:**
- New Insights requests are **blocked** with a message: "Monthly budget exceeded"
- Partner must either:
  - Wait until the next calendar month (automatic reset)
  - Request a temporary budget increase (via Support, requires approval)
  - Pay overage fees (if permitted in Appendix B; typically not allowed)

### 5.2 Overage Policy

- **No automatic overages** — lookups are rejected, not charged beyond budget
- **Planned increases** — Partner may request a higher monthly limit 15 days before month-end
- **Annual cap** — Total annual spend cannot exceed [₹X] without prior written amendment

---

## 6. Monthly Archives & Retention

**Purpose:** Permanent record-keeping for audit, compliance, and reconciliation with Data Provider invoices.

**What's archived monthly (in Excel):**
- All Insights lookups (successful, not-found, cached reuse)
- Call logs, payment records, disputes for that month
- Debtor account status changes
- Agent/manager activity audit trail

**Archives are stored in** Axiotta's private cloud storage (AWS S3, encrypted) **and accessible to:**
- Axiotta admins (for billing reconciliation and compliance)
- Partner admin only (via Admin → Archive History)

**Retention:** 7 years (per India's tax/regulatory requirements)

**Cost:** Included in monthly subscription; no separate archival fees

---

## 7. Data Hygiene & Phone Writeback

**Insights may return alternate phone numbers** (skip-trace bundles include LPG Connection, Employer Landline, etc.).

**Axiolta's Phone Writeback Policy:**
- ✓ **DO writeback:** Borrower mobile numbers (primary contact)
- ✗ **DO NOT writeback:** Employer landlines, distributor numbers, branch offices
- ✗ **DO NOT writeback:** Non-standard formats or ambiguous numbers

**Why:** Calling an employer or distributor to discuss borrower debt is a potential regulatory violation (NCBC/TDSAT) and reputational risk.

Partner acknowledges this policy is **non-negotiable** and Axiotta enforces it automatically to protect both parties.

---

## 8. Service Enablement & Disablement

### 8.1 Initial Setup

**To enable Insights for a Client:**
1. Superadmin navigates to Client Settings → Insights
2. Selects services from the catalogue (Skip Tracing, Employment, GST, etc.)
3. Sets monthly budget and approval workflow
4. Axiotta sends test credentials (if applicable)
5. Partner confirms successful test lookup
6. Service goes live

### 8.2 Service Availability

Each service in the catalogue may be:
- **Enabled** — Partner can request lookups
- **Disabled** — Requests are rejected (e.g., if budget exhausted, service deprecated, or Partner opted out)
- **Removed from catalogue** — Axiotta notifies 30 days in advance if Data Provider retires a service

---

## 9. Fees & Payment

**Insights is billed separately from Portfolio Upload fees.**

**Billing Method:**
- **Post-paid (arrears):** Axiotta charges monthly based on actual lookups + archived usage
- **Invoice cycle:** Data Provider invoices Axiotta; Axiotta invoices Partner
- **Payment terms:** [Net 30 / Net 15] from invoice date
- **Late payment penalty:** 1.5% per month on overdue amounts

**Reconciliation:**
- Partner receives monthly usage report (lookups by service, result status, cost)
- Partner may dispute charges within 30 days of invoice
- Data Provider's records are authoritative for billing disputes

---

## 10. Data Protection & Compliance

**Axiotta will:**
- Not sell, share, or disclose Insights results to third parties (except Data Provider for provisioning)
- Encrypt all data in transit (TLS) and at rest (AES-256)
- Maintain audit logs of all Insights requests (user, time, debtor, service, cost)
- Comply with DPDP Act 2023 and RBI guidelines for third-party data sharing

**Partner will:**
- Not re-sell Insights data or results to competing platforms
- Not bulk-export skip-trace results for purposes other than internal collection
- Not disclose Data Provider's identity as a source unless legally required

---

## 11. Service Limitations & Disclaimers

**Axiotta provides Insights on an "AS-IS" basis.**

**Axiotta is NOT liable for:**
- Inaccurate, incomplete, or outdated data returned by Data Provider
- Borrower complaints or legal claims arising from incorrect data used in collection
- Regulatory fines (NCBC, TDSAT, RBI) if Partner uses Insights data in violation of law
- Reputational harm if Insights contact details are wrong (calling wrong person, etc.)

**Partner assumes all risk** of using Insights data in collection calls, legal proceedings, or regulatory filings.

**Axiotta's total liability** for Insights-related claims is **limited to fees paid for that specific lookup** (not exceeding ₹500 per claim).

---

## 12. Termination of Insights

**Either party** may disable Insights at any time with 7 days' notice.

**Upon termination:**
- No new lookups can be requested
- Existing results remain available in Partner's Portal for 180 days
- Monthly archives are retained per Section 6 (7 years)
- Partner remains liable for all lookups already charged

---

## 13. Amendments & Changes

**Data Provider may change:**
- Service availability or add new services (30 days' notice)
- Pricing (reviewed quarterly; increases effective next calendar month with 30 days' notice)
- Data accuracy/coverage (no separate notice required; stated in monthly reports)

**Partner may opt out of a service** by requesting disablement via Admin Settings.

---

## 14. Dispute Resolution

**Billing Disputes:**
- Partner has 30 days from invoice date to dispute charges
- Submit disputes with supporting evidence (screenshots, lookup date/time) to support@samvadx.com
- Axiotta investigates within 10 business days

**Non-Billing Disputes:**
- Escalate to Support (48-hour response)
- Mediation / Arbitration under Portfolio Upload Agreement terms (Section 10)

---

## Appendices

- **Appendix A:** ProfileX Service Catalogue & Pricing (updated quarterly)
- **Appendix B:** Monthly Budget & Overage Policy
- **Appendix C:** DPDP Compliance & Data Processing Agreement
- **Appendix D:** Alternate Phone Writeback Exclusion List

---

**Partner Acknowledgment:**

Partner certifies it understands and accepts:
- ✓ Insights is a premium, pay-per-use service separate from Portfolio Upload
- ✓ Costs are variable based on result status and service selected
- ✓ Monthly budget limits and archive retention policies
- ✓ Data Protection and accuracy disclaimers above
- ✓ Non-reuse of skip-trace results outside authorized collection activities

---

**Authorized Signature:**

Partner Firm: ____________________________  
Name & Title: ____________________________  
Date: ____________________________

Axiotta Representative: ____________________________  
Date: ____________________________
