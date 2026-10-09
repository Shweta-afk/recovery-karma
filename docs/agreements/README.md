# SamvadX Client Agreements

Master agreement templates for debt recovery firm partners using the SamvadX platform.

---

## Agreements

### 1. **Portfolio Upload Agreement** (`PORTFOLIO_UPLOAD_AGREEMENT.md`)

**Governs:** Upload and management of debtor portfolios, collection activities, data ownership, compliance.

**Key Sections:**
- Data ownership & responsibility (Partner owns, Axiotta hosts)
- Security & privacy (TLS, AES-256, RLS enforcement)
- Compliance requirements (TDSAT, RBI, state collection laws)
- Termination & data retention (90-day deletion window)
- Liability limitations (not liable for Partner's inaccurate data or illegal practices)
- Service availability (99% uptime SLA)

**When to use:** Signing on a new partner firm or refreshing an existing contract.

**Customization needed:**
- `[DATE]` → Effective date
- `[PARTNER FIRM NAME]` → Actual firm name
- `[X MONTHS]` → Historical access window (suggest 24 months)
- `[₹X]` → Setup fee and monthly subscription
- Pricing appendix with per-account rates or flat fee

---

### 2. **Insights (ProfileX Skip-Tracing) Agreement** (`INSIGHTS_PROFILEX_AGREEMENT.md`)

**Governs:** Optional skip-tracing service, pay-per-lookup billing, data caching, monthly budget limits, third-party data sharing.

**Key Sections:**
- Billing model (per-lookup fees, variable by result status)
- Caching & reuse (same phone/month = ₹0, cross-portfolio reuse)
- Data shared with ProfileX (mobile, name, employment chaining inputs)
- Accuracy disclaimers (Axiotta not liable for wrong data)
- Monthly budget enforcement (rejected, not overcharged)
- Monthly archives (permanent IST-month records for audit)
- Phone writeback policy (employer/distributor numbers excluded)
- Audit trail & compliance (DPDP, RBI)

**When to use:** When enabling Insights/skip-tracing for a partner (separate from Portfolio Upload).

**Customization needed:**
- `[DATE]` → Effective date
- `[PARTNER FIRM NAME]` → Actual firm name
- `[X]` → Monthly budget (e.g., ₹50,000)
- `[₹X]` → Annual spend cap
- Appendix A: Actual ProfileX price list (updated quarterly from Data Provider)
- Appendix B: Overage policy (usually none—budget blocks requests)

---

## Implementation Checklist

### Before Signing
- [ ] Fill all `[PLACEHOLDERS]` with actual business terms
- [ ] Add partner firm's legal entity name (as registered)
- [ ] Define monthly budget caps per partner
- [ ] Confirm pricing (flat fee? per-account? per-lookup?)
- [ ] Get legal review (internal counsel or external lawyer)
- [ ] Define dispute resolution locale (e.g., Bangalore, Mumbai)

### Signature & Onboarding
- [ ] Both parties sign (digital/wet signature)
- [ ] Store signed copy in secure document archive (with timestamps)
- [ ] Share counterpart with partner
- [ ] Create admin note in SamvadX with agreement version & date
- [ ] Notify finance team for invoicing setup (if not pre-paid)

### Ongoing
- [ ] Quarterly review of Insights pricing (sync with Data Provider)
- [ ] Annual contract renewal 30 days before expiry
- [ ] Monthly archive downloads (audit compliance trail)
- [ ] Track partner activity for compliance violations (illegal practices, data misuse)

---

## Terms Glossary

| Term | Definition |
|------|-----------|
| **Portfolio** | Debtor account batch uploaded by partner (CSV with borrower details, loan amounts) |
| **Insights** | Skip-tracing/profile enrichment service (ProfileX integration, pay-per-lookup) |
| **Agent** | Collection staff employed by partner firm, assigned accounts via SamvadX |
| **Manager** | Partner firm employee with oversight of agents; can approve Insights lookups |
| **Admin** | Partner's superadmin; controls client access, budgets, settings, archives |
| **Axiotta** | Platform provider (this company) |
| **Data Provider** | ProfileX/Neokred (skip-tracing vendor, bills Axiotta per lookup) |
| **Cache** | Lookup result reused for same phone/service within same IST month (no re-charge) |
| **Archive** | Monthly Excel export of all lookups, calls, payments for compliance & reconciliation |

---

## Legal Review Notes

- **Governing Law:** Agreements reference "Laws of India" — specific state can be Bangalore (HQ) or partner's state (negotiable)
- **Dispute Mechanism:** Arbitration under Arbitration & Conciliation Act, 1996 (avoids court costs/delays)
- **Data Protection:** DPDP Act 2023 (India's new privacy law, effective Sept 2025) + RBI guidelines for financial data
- **Collection Compliance:** TDSAT Act, NCBC (National Collections Bureau) standards, state-specific collection laws
- **Liability Cap:** "Not exceeding annual fees" (portfolio) or "₹500 per claim" (Insights) — protects Axiotta from runaway liability

---

## Appendices to Prepare

### Portfolio Upload Agreement Appendices

**Appendix A: Pricing & Fee Schedule**
```
| Item | Amount | Period | Notes |
|------|--------|--------|-------|
| Setup Fee | ₹X | One-time | Non-refundable |
| Monthly Subscription | ₹X | Monthly | Due on 5th; late fee 1.5%/month |
| Per-Account Fee (optional) | ₹X | Per debtor | If not flat rate |
```

**Appendix B: Data Processing Agreement (DPDP Compliance)**
- Axiotta's role: Data Processor
- Partner's role: Data Controller
- Processing purposes: Debt collection, customer contact
- Data categories: Name, phone, email, address, financial data
- Sub-processors: Supabase (database), Exotel (telephony), Groq (transcription)
- Retention: [X months] after collection closure

**Appendix C: Portfolio Upload Specifications**
- CSV format: Fields, required/optional, format rules
- Example: Loan ID, Borrower Name, Phone, Email, Address, Amount, DPD, etc.
- Validation rules (e.g., phone must be 10 digits, loan_id unique)

---

### Insights Agreement Appendices

**Appendix A: ProfileX Service Catalogue & Pricing**
```
| Service | Status Code | Found Fee | Not Found Fee | Monthly Limit |
|---------|-------------|-----------|---------------|---------------|
| VRE Skip Tracing | 1/2 | ₹46 | ₹5 | Unlimited (subject to budget) |
| Employment Latest | 1/2 | ₹10 | ₹5 | Unlimited |
| GST→Contact | 1/2 | ₹15 | ₹3 | Unlimited |
| Phone→UAN | 1/2 | ₹12 | ₹2 | Unlimited |
| Alternate Phones | 1/2 | ₹8 | ₹1 | Unlimited |
| LPG Connection | 1/2 | ₹20 | ₹5 | Unlimited |
```
(Update quarterly from Data Provider; these are placeholder prices from 2026-09-17)

**Appendix B: Monthly Budget & Overage Policy**
- Budget per IST month (auto-reset 1st)
- No auto-overages (requests blocked, not charged)
- Temporary increase approval (15-day advance request)
- Annual spend cap enforcement

**Appendix C: DPDP & Data Processing**
- ProfileX is a sub-processor (Axiotta shares borrower mobile + name)
- Axiotta responsible for ensuring ProfileX complies with DPDP
- Partner must obtain borrower consent for third-party data sharing
- Data retention in archive: 7 years

**Appendix D: Alternate Phone Writeback Exclusion List**
- Do NOT writeback: Employer, Distributor, Dealer, Branch, GST-registered entity numbers
- Reasoning: Regulatory risk (TDSAT, NCBC), reputational harm
- Automatic enforcement in `extractPhones()` function

---

## Next Steps

1. **Fill placeholders** (dates, names, amounts, locale)
2. **Get legal review** (internal or external counsel)
3. **Set up pricing** (append actual rates in Appendix A)
4. **Print/sign** (wet signature or eSignature platform e.g., Adobe Sign)
5. **File** (secure archive; link in SamvadX admin notes)
6. **Onboard partner** (provide Portal access, initial portfolio, budget)

---

**Questions?** Contact [LEGAL CONTACT / SUPPORT EMAIL]

Last Updated: 2026-09-26
