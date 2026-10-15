// SamvadX's Master Service Agreement — ONE text for every company (user, 2026-10-12). Rebuilt
// 2026-10-16 from "Samvadx Aggrement (1).docx" with that file's exact wording and layout
// (headings, lettered recitals, tables, page break, footer — markup in contract-template.ts);
// re-run the conversion rather than hand-editing when the Word file changes. Both parties are
// {{placeholders}}: SamvadX's own company from Superadmin → Invoices → SamvadX details
// (billing_profile — rename the company there and every agreement follows), the client from
// what its admin filled in on Admin → Settings (client_billing). Published as a platform
// document (Superadmin → Contracts → Agreement); each company sees it filled with its own
// details and signs it; the exact text signed is frozen in contract_document_status.signed_body.
// This constant is only the starting text — the published version lives in contract_documents
// and is edited on that page.

export const MASTER_AGREEMENT_TITLE = "Master Service Agreement";

export const DEFAULT_MASTER_AGREEMENT_BODY = `# MASTER SERVICE AGREEMENT

^ **SamvadX Platform — Calling, Messaging and Insights Services**

THIS MASTER SERVICE AGREEMENT ("**Agreement**" or "**MSA**") is entered into as of **{{effective_date}}** ("**Effective Date**") and is made and entered into BY AND BETWEEN:

**{{supplier_legal_name_caps}}** {{supplier_entity}}, having its registered office at **{{supplier_address}},** operating the SamvadX Platform, hereinafter referred to as "**{{supplier_short_name}}**" or "**Service Provider**"

^ **OF THE FIRST PART**

^ **AND**

**{{company_legal_name_caps}}**, {{company_entity}}, having its registered office at **{{company_address}}**, hereinafter referred to as "**Client**"

**OF THE SECOND PART**

**WHEREAS:**

+ {{supplier_legal_name}}, hereinafter referred to as **“{{supplier_short_name}}”**, is engaged in providing a cloud-based debt recovery and collections management platform under the brand name **“SamvadX”**, comprising, inter alia, portfolio management, telephony and calling services, messaging services, call tracking and recording, analytics, optional data enrichment facilities, and the provision of telephone numbers, including Direct Inward Dialling numbers (“DIDs”), together with such other features, tools, functionalities and ancillary services as may be made available by {{supplier_short_name}} from time to time (collectively referred to as the **“SamvadX Platform”** or the **“Services”**). {{supplier_short_name}} shall provide the Services in accordance with applicable laws, rules, regulations and regulatory directions, including those issued by the Reserve Bank of India (“RBI”), to the extent applicable to its role and the Services provided by it.
+ The Client is engaged in the business of debt recovery, loan collections and related activities on behalf of banks, financial institutions, non-banking financial companies and other lenders, and represents that it shall carry out it’s activities in compliance with all applicable laws, rules, regulations, regulatory directions and guidelines, including, wherever applicable, those issued by the RBI and the Telecom Regulatory Authority of India (“TRAI”), as well as applicable State laws and regulations governing debt recovery and collection practices.
+ The Client intends to engage {{supplier_short_name}} and avail itself of the SamvadX Platform and the Services, including portfolio management, calling, messaging, call tracking, call recording, analytics, optional data enrichment services and the use of DIDs and other telecommunication facilities made available through {{supplier_short_name}}, subject to the terms and conditions set forth in this Agreement.
+ The Parties acknowledge that the use and provision of the SamvadX Platform and the Services may involve the processing, transmission, storage and management of personal data, customer information, call records and other information relating to the Client’s portfolios and collection activities. Accordingly, the Parties intend to define their respective rights, obligations, responsibilities and liabilities concerning the provision and use of the Services, data protection, confidentiality, regulatory compliance, payment of fees and other matters incidental thereto.
+ Accordingly, the Parties, being desirous of recording their mutual understanding and establishing a comprehensive contractual framework governing the subscription, access to, provision and use of the entire SamvadX Platform and all Services availed of by the Client, including any additional modules, features, functionalities or ancillary services subsequently agreed upon by the Parties, hereby agree to enter into this Master Services Agreement (“Agreement”) on the terms and conditions set forth herein.

**NOW IT IS HEREBY AGREED AS FOLLOWS:**

## 1. DEFINITIONS AND INTERPRETATION

"**Applicable Law**" means any statute, regulation, guideline, circular or directive of a Government Authority, including the DPDP Act 2023, the Information Technology Act 2000, TRAI regulations (including those on unsolicited commercial communications and telecom consumer protection), Telecommunications laws and licence conditions, RBI guidelines and directions (including fair practices and recovery-agent guidelines), and state collection laws.

"**Authorized Personnel**" means employees or agents of Client who have been issued valid login credentials by Client for the SamvadX Platform and who are permitted by Client and the relevant Lender to handle the relevant Portfolio.

"**Authorized Purpose**" means contacting, and recording interactions with, the borrowers, co-borrowers and guarantors named in a Portfolio solely for the lawful recovery or collection of that Portfolio, as authorised by the relevant Lender, and for no other purpose.

"**Calling Services**" means all voice features of the SamvadX Platform, including agent calling, manual dial, single-line, progressive and multi-line (productive) dialing, inbound calling and call queues, IVR and automated call routing, call recording, call logging and dispositions, live-call views, call audit, and call analytics.

"**DID**" means a Direct Inward Dialing telephone number, or any other telephone number or calling line identity, that is allocated or made available to Client through the SamvadX Platform.

"**Lender**" means the bank, non-banking financial company, financial institution or other entity that owns or has assigned the debt in a Portfolio and has authorised Client to act in respect of it.

"**Mandate**" means the written authorisation, assignment or agreement issued by a Lender permitting Client to contact borrowers and recover dues for a Portfolio.

"**Messaging Services**" means SMS, WhatsApp, email and any other messaging features of the SamvadX Platform.

"**Misuse**" has the meaning given in Section 7.

"**Portfolio**" means debtor account data uploaded by Client to the SamvadX Platform.

"**{{supplier_short_name}}**" means {{supplier_legal_name}}. "**SamvadX**" is only a brand name used by {{supplier_short_name}} for its platform and is not a separate legal entity; every right, duty and liability described as that of "SamvadX" in any document, screen or communication is that of {{supplier_short_name}}.

"**SamvadX Platform**" means the cloud-based software platform operated by {{supplier_legal_name}} under the brand name SamvadX, including all Calling Services, Messaging Services, the Insights Service, dashboards, reports and related features.

"**Insights Service**" means the optional data enrichment service including address verification, identity verification, employment verification, and contact information validation.

"**Telecom Provider**" means any licensed telecom operator or carrier whose network, numbers or services are used to provide the Calling Services, including Tata as referred to in Section 6.

## 2. SCOPE OF SERVICES

2.1 **Platform Services:** Portfolio management, call logging, agent and team management, targets and performance analytics, reports, escalations and compliance documentation.

2.2 **Calling Services:** The voice features described in Section 5, including DIDs described in Section 6.

2.3 **Messaging Services:** The features described in Section 8, where made available.

2.4 **Optional Insights Service:** Data enrichment on a pay-per-use basis with prepaid balance model (usage continues until prepaid balance exhausted).

2.5 {{supplier_short_name}} maintains service availability as per technical standards and client requirements. {{supplier_short_name}} may add, modify, improve or withdraw features, providers and technical methods from time to time, provided the core Services are not materially withdrawn without notice.

2.6 Features that are not live or are not enabled for Client are not part of the Services, and no description in this Agreement is a promise that a particular feature is available.

## 3. CLIENT OBLIGATIONS AND LEGAL COMPLIANCE

3.1 Client certifies that Client shall comply with **ALL** Applicable Laws.

3.2 Client retains ownership of Portfolio data and is solely responsible for its accuracy, lawfulness, and borrower consent per DPDP Act 2023.

3.3 Client **SHALL NOT**: (a) make calls or send messages outside the hours and manner permitted by Applicable Law; (b) engage in harassment, threats, abuse or intimidation; (c) record calls without the notice and consent required by Applicable Law; (d) misrepresent the purpose of collection or the identity of the caller or Lender; (e) resell data; (f) violate the TRAI DNC registry or any do-not-disturb preference.

3.4 Client is solely responsible for the conduct of all its Authorized Personnel, agents and sub-contractors, and for training them on Applicable Law and the Lender's collection code of conduct.

3.5 Client shall hold, and maintain for the term of this Agreement, every licence, registration, Lender approval and regulatory permission required for its collection activities, and shall produce evidence of these on {{supplier_short_name}}'s request.

## 4. AUTHORIZED PURPOSE AND LENDER MANDATE

4.1 **Contact Customers Only:** Client shall use the SamvadX Platform, the Calling Services, the Messaging Services and every DID **ONLY** to contact the borrowers, co-borrowers and guarantors of Portfolios that have been assigned or authorised to Client by Lenders. Client shall not use the SamvadX Platform to contact any other person or for any other purpose.

4.2 **Lender Mandate:** Client represents and warrants that, for every Portfolio uploaded, Client holds a valid and current Mandate from the Lender, that the Mandate permits Client to use a platform such as {{supplier_short_name}}, to place calls and send messages, and to record calls, and that Client will upload only accounts covered by the Mandate.

4.3 **Prohibited Uses:** Client shall **NOT** use the SamvadX Platform or any DID for: (a) marketing, sales, promotion or any commercial solicitation; (b) contacting persons who are not named in a Portfolio, other than persons lawfully identified for that account under Applicable Law and the Mandate; (c) personal use or use for any business other than the Lender's collection activity; (d) any activity for another client, agency or third party without written consent of {{supplier_short_name}}; (e) any unlawful, fraudulent or deceptive activity.

4.4 **Mandate Ends:** When a Mandate expires, is withdrawn or is suspended, Client shall immediately stop contacting the borrowers of that Portfolio, shall inform {{supplier_short_name}}, and shall close or remove the Portfolio. {{supplier_short_name}} may suspend calling and messaging on any Portfolio for which a valid Mandate cannot be shown.

4.5 **Verification:** {{supplier_short_name}} may request copies of Mandates, may suspend access pending verification, may restrict dialing to numbers that are part of an uploaded Portfolio, and may cooperate with a Lender or regulator that asks to verify Client's use of the SamvadX Platform. Client lists its current Lender Mandates in Annexure E and shall keep that list up to date.

4.6 **Use Only at the Registered Premises:** The SamvadX Platform, the Calling Services, the Messaging Services and every DID may be used **ONLY** from the registered address of Client stated in this Agreement (or another office address that {{supplier_short_name}} has approved in writing and that is listed in Annexure E), and only on the premises of that address. Client shall not allow any login, extension, DID or calling facility to be used from a home, a shared or co-working space, another company's premises, a mobile location, or any place outside India, unless {{supplier_short_name}} has approved it in writing in advance.

4.7 **Location Controls:** Client shall keep a record of the premises and devices from which each user account is used. {{supplier_short_name}} may check, restrict or block access from locations, networks or devices that are not approved, and may ask for proof of premises. Use from an unapproved location is Misuse under Section 7.

4.8 **No Resale or Third-Party Use:** The Services are for Client's own recovery activity only. Client shall **NOT** resell, sub-license, rent, lease, share, white-label, outsource, or otherwise make the SamvadX Platform, any login, any DID, any call or message capacity, any recording or any data available to any other person, agency, group company or business, whether for payment or free, and shall not use the Services to provide calling, collection or data services to others.

## 5. CALLING SERVICES

5.1 **Features:** Calling Services allow Authorized Personnel to place and receive calls through the SamvadX Platform, view the call queue, log outcomes (dispositions), record promises to pay and callbacks, view call history on an account, and allow managers to audit calls.

5.2 **Dialing Modes:** The SamvadX Platform offers manual dial, single-call dialing, progressive dialing (one account at a time in list order) and multi-line (productive) dialing (several lines at once). Each mode connects the agent first and the borrower after, through the telecom network. Client chooses the mode and is responsible for the way it is used.

5.3 **RBI Guidelines, Calling Hours and Controls:** {{supplier_short_name}} follows the RBI guidelines applicable to its services and designs the Calling Services to support compliance with them. Calls shall be made only within the hours permitted by Applicable Law and RBI guidelines for recovery calls. {{supplier_short_name}} may enforce calling windows, do-not-call lists, channel limits, and other technical controls in the SamvadX Platform, and these controls may be tightened at any time to meet Applicable Law. Client shall not attempt to bypass them.

5.4 **Do-Not-Call and Consent:** Client shall maintain its do-not-call and borrower-preference lists, shall upload or record them on the SamvadX Platform where the feature is provided, and shall stop contacting any person who has lawfully asked not to be contacted. Client is solely responsible for the accuracy and completeness of these lists.

5.5 **Call Recording:** Calls may be recorded by the SamvadX Platform. Client is solely responsible for giving the notice and obtaining any consent required for recording under Applicable Law and the Mandate, including disclosure at the start of the call. Recordings and call records are Personal Data under Client's control, are stored, retained and deleted per {{supplier_short_name}} requirements and Annexure A, and may be disclosed to Lenders, regulators and courts as required by law.

5.6 **Conduct Standards:** Client shall ensure every call follows Annexure D (Calling Compliance Rules): agents identify themselves and the Lender, speak politely, do not use abusive language, do not threaten, do not contact third parties or family members in a manner prohibited by law, and do not disclose the debt to anyone other than the borrower, co-borrower or guarantor.

5.7 **Agent Accounts and Extensions:** Each user account is personal to one individual. Client shall not share credentials, and one user account may be active on one device at a time. Agent phone numbers and extensions are configured or approved by {{supplier_short_name}}, and Client shall give only genuine, authorised numbers.

5.8 **Capacity and Fair Use:** Calling capacity (including concurrent channels), and call and message volumes, are limited per Client as set by {{supplier_short_name}} and as set out in Annexure C. {{supplier_short_name}} may apply fair-use limits to protect the network and other clients, and may throttle or block excessive, abnormal or abusive traffic.

5.9 **AI-Assisted and Automated Features:** Features such as call transcription, tone or sentiment analysis, scores and suggestions are aids that may be inaccurate and are suggestions only; Client shall not rely on them as the sole basis for any legal, disciplinary or recovery decision. {{supplier_short_name}} may introduce further automated and AI-based features, including AI voice features, from time to time. Where such features are made available, they are part of the Calling Services, are subject to the same Authorized Purpose, Mandate and conduct rules, and Client is responsible for the scripts, disclosures and consents they require under Applicable Law.

5.10 **Monitoring for Compliance:** {{supplier_short_name}} may monitor call volumes, patterns, call metadata, recordings and usage of the SamvadX Platform to detect Misuse, protect networks, comply with law and respond to Telecom Provider, Lender or regulator requests.

## 6. DID NUMBERS AND TELECOM RESOURCES

6.1 **Source of Numbers:** DID numbers made available to Client through the SamvadX Platform are obtained by {{supplier_short_name}} from **Tata** [legal entity of Tata Telecom Provider to be confirmed], a licensed Telecom Provider, and are subject to that Telecom Provider's terms, policies and licence conditions, which apply to Client as they apply to {{supplier_short_name}}.

6.2 **No Ownership:** Client acquires only a limited, non-exclusive, non-transferable right to use the DIDs allotted to it, and only while this Agreement is in force. Client acquires no ownership, number-portability right, or right to retain, port out, sell, lease or transfer any DID.

6.3 **Use Only for Authorized Purpose:** DIDs shall be used only for the Authorized Purpose in Section 4 and only through the SamvadX Platform. Client shall not use any DID for any other business, shall not allow third parties to use it, and shall not link or route it to another system or provider.

6.4 **No Alteration of Caller Identity:** Client shall not spoof, mask, rotate, hide, falsify or change the calling number or caller identity, and shall not use SIM-box, bulk-call, auto-dialer or robocall techniques outside the features provided.

6.5 **Change, Reassignment and Withdrawal:** {{supplier_short_name}} or the Telecom Provider may change, reassign, suspend, block or withdraw any DID at any time, with or without notice where required by law, a Telecom Provider, DoT, TRAI or another authority, or where Misuse is suspected. {{supplier_short_name}} is not liable for any loss, interruption or reputational impact arising from such action.

6.6 **Regulatory Registrations:** Where Applicable Law requires registrations in Client's own name (including sender IDs, message templates, content approvals, and telemarketer or entity registrations), Client shall obtain and maintain them at its own cost and shall give {{supplier_short_name}} such evidence as it asks for.

6.7 **Telecom Provider Charges:** Client shall bear charges, penalties, disconnection or reconnection charges, and regulatory fees levied on {{supplier_short_name}} or the Telecom Provider because of Client's use or Misuse of a DID.

6.8 **End of Agreement:** On expiry or termination of this Agreement, all DIDs allotted to Client are withdrawn and return to {{supplier_short_name}} or the Telecom Provider, and Client shall stop using or advertising them.

## 7. MISUSE OF DIDs AND CALLING FACILITIES — NO ASSISTANCE FROM {{supplier_short_name_caps}}

7.1 **Misuse** means any use of a DID, the Calling Services or the SamvadX Platform that: (a) is outside the Authorized Purpose or Mandate; (b) contacts persons not named in a Portfolio; (c) is for marketing, spam, phishing, fraud, impersonation or any deceptive purpose; (d) harasses, threatens, abuses or intimidates any person; (e) violates TRAI, DoT, RBI, DPDP or any Applicable Law or Telecom Provider policy; (f) spoofs or alters caller identity; (g) calls numbers on a do-not-call or do-not-disturb list in breach of law; (h) triggers complaints, spam-labelling, blocking or regulatory notice in respect of a DID; or (i) allows any person other than Authorized Personnel to use it; (j) is used from a location that is not the registered or approved premises under Section 4.6; or (k) is resold, shared or made available to anyone else in breach of Section 4.8.

7.2 **Action by {{supplier_short_name}}:** On suspected or actual Misuse, {{supplier_short_name}} may, without prior notice and without liability, suspend or block calling, messaging or access; withdraw any DID; suspend or terminate this Agreement; preserve and disclose call records, recordings and account data to the Telecom Provider, the Lender, regulators, police and courts; and report the matter to authorities.

7.3 **NO LEGAL OR OTHER ASSISTANCE: IF A DID OR THE CALLING SERVICES ARE MISUSED, {{supplier_short_name_caps}} WILL NOT HELP CLIENT IN ANY LEGAL, REGULATORY, POLICE OR COMMERCIAL PROCEEDING THAT ARISES. {{supplier_short_name_caps}} SHALL NOT AND WILL NOT DEFEND CLIENT OR ITS PERSONNEL, PAY ANY FINE, PENALTY, DAMAGES OR LEGAL COSTS, PROVIDE ANY COMPENSATION OR REIMBURSEMENT, OR TAKE RESPONSIBILITY FOR THE ACTS OF CLIENT OR ITS PERSONNEL.** Client alone bears the entire legal, civil, criminal and regulatory responsibility for its Misuse and that of its Authorized Personnel.

7.4 **Indemnity for Misuse:** Client shall fully indemnify and hold harmless {{supplier_short_name}}, {{supplier_legal_name}}, its directors, officers and employees, and its Telecom Providers against every claim, fine, penalty, disconnection, charge, loss and cost (including legal fees) arising from Client's or its personnel's Misuse, and shall cooperate fully with any investigation.

7.5 No fees, recharges or balances are refundable where access is suspended or terminated for Misuse, and Client stays liable for all amounts due.

## 8. MESSAGING SERVICES

8.1 Messaging Services (SMS, WhatsApp, email and similar) are provided only where made available and enabled for Client, through third-party providers whose approvals, templates and policies apply.

8.2 Client is solely responsible for message content, consent, sender and template registrations (including any required DLT or provider approvals), borrower preferences and timing, and shall use messaging only for the Authorized Purpose. Marketing or promotional messaging is prohibited.

8.3 Delivery is not guaranteed. Messages may be delayed, filtered, rejected or not delivered by providers or recipients, and a message recorded as "sent" means only that a provider accepted it.

8.4 Payment links shared with borrowers are provided by the Lender. Client shall not create, alter or share any other payment link, account number or UPI ID through the SamvadX Platform.

## 9. NO HANDLING OF FUNDS

9.1 {{supplier_short_name}} is a software and telecom platform only. {{supplier_short_name}} is not a payment aggregator, collection agent, lender or financial intermediary, and does **NOT** collect, receive, hold, settle or transfer any money paid by borrowers.

9.2 All payments must be made directly to the Lender's authorised accounts or links. Payment, promise-to-pay and settlement entries in the SamvadX Platform are records entered by Client or imported from files and are not proof of payment, and {{supplier_short_name}} is not liable for any dispute about a payment.

## 10. DATA PROTECTION AND SECURITY

10.1 {{supplier_short_name}} shall implement: TLS 1.2+ encryption in transit, AES-256 encryption at rest, Role-Based Access Controls, audit logs, third-party security audits, and DPDP 2023 compliance.

10.2 The Data Processing Agreement (Annexure A) compliant with DPDP Act 2023 is attached. It covers Portfolio data as well as call recordings, call logs, messages and telephony data.

### 10.3 DATA VISIBILITY AND THIRD-PARTY RESTRICTIONS

{{supplier_short_name}} DOES NOT provide, contribute to, or share any third-party information. ONLY data uploaded by Client (Portfolio) is visible to Client on the SamvadX Platform.

Client DOES NOT have access to: (a) other clients' data; (b) third-party information or external databases; (c) government or public records; (d) vendor or partner data; (e) any information outside Client's own uploaded Portfolio.

ONLY Authorized Personnel with valid login credentials assigned by Client may access the SamvadX Platform and Portfolio data.

Client is solely responsible for: (a) managing access credentials; (b) revoking access for terminated personnel; (c) monitoring and auditing Platform access; (d) ensuring only intended personnel use assigned credentials.

{{supplier_short_name}} may take enforcement actions if Client fails to comply with data visibility restrictions or allows unauthorized access to Portfolio data.

10.4 **Sub-processors:** {{supplier_short_name}} may use hosting, telecom, messaging, transcription and analytics providers (including Telecom Providers) to deliver the Services and shares data with them only as needed for that purpose.

10.5 **Incidents:** Each Party shall promptly inform the other of any security incident affecting the other's data and shall cooperate to investigate and contain it.

10.6 **Retention and Deletion:** Portfolio data, call recordings and logs are retained, archived and deleted per {{supplier_short_name}} requirements and Applicable Law, including after termination. Client shall download any data it needs while access continues.

10.7 **Borrower Rights:** Client, as Data Controller, handles requests from borrowers under DPDP Act 2023, and {{supplier_short_name}} shall reasonably assist as required by law.

## 11. INSIGHTS SERVICE — DATA ENRICHMENT

11.1 Insights is optional data enrichment on a pay-per-use basis with prepaid balance model.

11.2 {{supplier_short_name}} disclaims liability for data accuracy. All results are suggestions only. Client must independently verify before legal action.

11.3 Usage continues until prepaid balance exhausted. See Annexure B for pricing and service details.

11.4 Identical lookups within prepaid recharge period are cached at zero additional cost.

11.5 Insights results may be used only for the Authorized Purpose and only for accounts in Client's Portfolio, and numbers or data returned shall not be used to contact persons other than the borrower, co-borrower or guarantor.

**11.2 DATA ACCESS, AUTHORIZATION AND COMPLIANCE**

**1. Authorized Data Access**

The Service Provider shall fetch, access, upload, process, or otherwise use data only in respect of banks, financial institutions, lenders, or clients with whom the Service Provider has a valid and active partnership, engagement, or written authorization for collection/recovery activities.

**2. Borrower-Specific Access**

Access to borrower/customer information shall be strictly limited to borrowers/accounts assigned or authorized by the respective bank, financial institution, lender, or client. No data relating to any other borrower, client, institution, or third party shall be accessed, fetched, uploaded, processed, or stored without prior written authorization.

**3. Third-Party Data Restriction**

No third-party data, including customer, borrower, account, loan, contact, financial, or other confidential information that is not expressly authorized by the concerned bank or client, shall be uploaded or entered into the Platform/Portal.

**4. No Unauthorized Data Extraction**

The Service Provider shall not attempt to extract, scrape, retrieve, download, copy, transfer, or otherwise obtain any data from the Portal or any connected system beyond the data specifically authorized for its assigned collection/recovery activities.

**5. Data Security and Prevention of Misuse**

Any form of unauthorized access, data extraction, data sharing, data leakage, misuse, manipulation, copying, or other malpractice involving customer or client data is strictly prohibited. The Service Provider shall implement reasonable technical and organizational safeguards to prevent such activities.

**6. No Third-Party Data on the Portal**

Only authorized data belonging to the concerned bank/client and its assigned borrowers may be uploaded, processed, or maintained on the Platform. Third-party or unauthorized data shall not be permitted on the Portal.

**7. Compliance with Applicable Laws**

The Service Provider shall comply with all applicable laws, regulations, contractual obligations, confidentiality requirements, and data-protection requirements relating to the collection, processing, storage, and use of borrower/customer information.

**8. Responsibility for Unauthorized Activity**

If any employee, representative, agent, vendor, or other person acting on behalf of the Service Provider engages in unauthorized data access, extraction, misuse, leakage, or any other malpractice, such activity shall be treated as a material breach of this Agreement. The concerned party shall be responsible for the consequences arising from such unauthorized activity, subject to applicable law.

**9. Indemnification and Legal Responsibility**

To the extent permitted under applicable law, the Service Provider shall be responsible for and shall indemnify the Client against losses, claims, penalties, damages, or legal proceedings arising from the Service Provider's unauthorized access, misuse, disclosure, extraction, or breach of client/customer data, except to the extent caused by the Client's own acts or omissions.

**10. No Unauthorized Use of Platform**

The Platform shall be used solely for legitimate and authorized collection/recovery activities. Any attempt to use the Platform for unauthorized data discovery, extraction, third-party data processing, or any other unlawful or prohibited activity shall constitute a breach of this Agreement.

## 12. TERRITORIAL SCOPE AND LICENSE

12.1 {{supplier_short_name}} grants Client a worldwide, non-exclusive, non-transferable license to use the SamvadX Platform and Insights Service within India and such other jurisdictions where legally permitted.

12.2 Client may **NOT** sublicense, resell, or redistribute the Platform or Services, and shall not use them for any resale purpose, as set out in Section 4.8. Any exception requires prior written consent of {{supplier_short_name}}.

12.3 DIDs and Calling Services are provided for calls to and from numbers within India. International calling, roaming or use outside India is available only if enabled by {{supplier_short_name}} in writing and is otherwise blocked.

## 13. FEES AND PAYMENT

13.1 **Insights:** Setup Fee: ₹10,000. First Recharge: ₹15,000. Monthly Recharge (from 2nd Month): Minimum ₹10,000.

13.2 **Platform, Calling and Messaging:** Platform subscription, user licenses, DID rental, call charges, channel charges, recording storage and messaging charges are as set out in Annexure C or in any Order Form signed by the Parties. Telecom and messaging rates may be revised when the underlying provider revises its charges.

13.3 All fees are **EXCLUSIVE** of GST and statutory levies.

13.4 Unpaid invoices incur 1.5% monthly interest. {{supplier_short_name}} may suspend access, calling and DIDs after non-payment.

13.5 Usage charges for calls and messages already made are payable even if a call was not answered or a message was not delivered.

13.6 **Payment Team:** Invoices and payment inquiries directed to:

| **Authorized name** | **Official Email** | **Contact** | **Designation** | **Signatory** |
| {{company_signatory_name}} | {{company_email}} | {{company_phone}} | {{company_signatory_designation}} |  |
|  |  |  |  |  |

## 14. SUPPORT AND SERVICE HOURS

14.1 {{supplier_short_name}} provides support via email and phone during business hours (Monday–Friday, 09:00–18:00 IST), excluding Indian national holidays.

14.2 Critical issues affecting service availability receive priority response per {{supplier_short_name}} support policy.

14.3 {{supplier_short_name}} does not guarantee 24/7 uptime but maintains technical standards for platform reliability. Planned maintenance and emergency fixes may interrupt the Services, and {{supplier_short_name}} will try to minimise the impact on calling.

14.4 Faults or restrictions arising from Telecom Providers, carriers, internet or devices at Client's end are outside {{supplier_short_name}}'s control.

## 15. INTELLECTUAL PROPERTY AND CODE PROTECTION

15.1 {{supplier_short_name}} retains all intellectual property rights, including source code, algorithms, architecture, UI/UX design, call-handling logic, and proprietary methods comprising the SamvadX Platform.

15.2 Client **SHALL NOT**: (a) copy, reverse-engineer, or decompile Platform code or infrastructure; (b) create derivative works; (c) attempt to extract trade secrets or proprietary methods; (d) reproduce or distribute any part of the SamvadX Platform without written consent; (e) scrape, bulk-export or copy platform data other than through features provided; (f) use the SamvadX Platform to build or train a competing product.

15.3 Breach of IP rights entitles {{supplier_short_name}} to immediate platform suspension and legal action without further notice.

15.4 {{supplier_short_name}} may use anonymized, aggregated and non-identifiable usage statistics to operate and improve the Services.

## 16. REFUND POLICY

16.1 Setup fees, subscription fees, DID rental and usage charges are non-refundable after service commencement.

16.2 Prepaid Insights Service balance is non-refundable; however, unused balance may be carried forward until service termination per {{supplier_short_name}} requirements.

16.3 {{supplier_short_name}} may refund fees (at sole discretion) only if service remains unavailable for consecutive business days and is not due to Client breach, Misuse, Telecom Provider failure or force majeure.

## 17. TERM AND TERMINATION

17.1 Contract term commences on Effective Date and continues until terminated by either Party per this section.

17.2 Either Party may terminate with written notice.

17.3 {{supplier_short_name}} may terminate or suspend immediately if: (a) Client breaches this Agreement; (b) Client fails to pay; (c) illegal activity is detected; (d) there is a Government or regulatory directive; (e) IP violation; (f) data breach caused by Client; (g) Misuse of any DID or the Calling Services; (h) a Lender withdraws or does not renew a Mandate, or Client cannot show a valid Mandate; (i) a Telecom Provider withdraws or restricts service; (j) Client uses the Services from an unapproved location or resells or shares them in breach of Section 4.

17.4 Upon termination: Client access revoked; all DIDs withdrawn; calling and messaging stopped; Portfolio data, recordings and archives handled per {{supplier_short_name}} requirements; and all amounts due remain payable.

17.5 Sections that by their nature should survive (including Sections 7, 10, 15, 18, 19 and 20) survive termination.

## 18. LIABILITY AND LEGAL RESPONSIBILITY

18.1 {{supplier_short_name}} Liability Cap: Fees paid in prior 12 months OR ₹1,00,000, whichever is greater.

18.2 {{supplier_short_name}} is **NOT** liable for: lost profits, lost revenue, third-party claims, reputational harm, undelivered messages, data accuracy, or loss of recovery.

### 18.3 CRITICAL — LEGAL AND REGULATORY LIABILITY WAIVER

IF ANY LEGAL, REGULATORY, OR COMPLIANCE PROBLEM ARISES FOR CLIENT IN CONNECTION WITH USE OF THE SAMVADX PLATFORM, CALLING SERVICES, DIDs, MESSAGING OR INSIGHTS SERVICE, INCLUDING BUT NOT LIMITED TO:

- Regulatory fines or penalties from government authorities;
- Legal claims or disputes from borrowers or third parties;
- Court judgments or orders against Client;
- Compliance violations or enforcement actions;
- Complaints, notices or action by a Lender, Telecom Provider, TRAI, DoT, RBI or police;
- Any other legal or regulatory liability;

**{{supplier_short_name_caps}} SHALL NOT AND WILL NOT PROVIDE COMPENSATION, FINANCIAL ASSISTANCE, REIMBURSEMENT, OR ANY PAYMENT OF ANY KIND TO CLIENT FOR SUCH LEGAL OR REGULATORY PROBLEMS.**

**Client assumes FULL and COMPLETE responsibility and liability for ALL legal, regulatory, and compliance consequences arising from Client's use of the SamvadX Platform and Services.**

18.4 **Client Indemnification:** Client shall indemnify {{supplier_short_name}} for claims arising from Client breach of law, Misuse, misuse of data, borrower complaints, Lender claims, or inaccurate Portfolio data.

18.5 The Services, including telephony, messaging and Insights, are provided "as is" and "as available". Services that depend on third parties are subject to those third parties' terms and failures.

## 19. CONFIDENTIALITY

19.1 Each Party shall maintain confidentiality of the other's Confidential Information except: (a) publicly available; (b) known prior; (c) required by law.

19.2 Confidential Information of Client includes Portfolio data, recordings and call records; Confidential Information of {{supplier_short_name}} includes the platform, pricing, DID allocation and technical information. {{supplier_short_name}} may disclose data as stated in Sections 5.5, 7.2 and 10.4.

## 20. DISPUTE RESOLUTION

20.1 Governed by the Laws of India.

20.2 Disputes resolved through: (1) good-faith negotiation; (2) mediation (IIAC); (3) binding arbitration per Arbitration and Conciliation Act, 1996 (single arbitrator, seat Mumbai, India, final and binding).

20.3 Subject to arbitration, the courts at Mumbai have exclusive jurisdiction. {{supplier_short_name}} may seek urgent injunctive relief from any competent court to protect its IP, DIDs, Telecom Provider relationships or the SamvadX Platform.

## 21. MISCELLANEOUS

21.1 This Agreement (with its Annexures and any Order Form) constitutes the entire agreement.

21.2 Amendments only by written instrument signed by both Parties. {{supplier_short_name}} may update Annexure C rates and operational rules by notice where required by Telecom Provider or legal changes.

21.3 If any provision is invalid, it shall be modified or severed.

21.4 Neither Party is liable for failure due to causes beyond reasonable control (including telecom outages, regulatory action and network failure). Client's payment obligation is NOT excused.

21.5 Client may NOT assign rights. {{supplier_short_name}} may assign with notice.

21.6 Parties are independent contractors. Nothing makes {{supplier_short_name}} a party to Client's arrangements with any Lender.

21.7 Notices shall be in writing to the addresses and email addresses of the Parties.

21.8 Client shall cooperate with {{supplier_short_name}}, Lenders, Telecom Providers and authorities in any audit, inquiry or investigation connected with the Services.

**IN WITNESS WHEREOF**, the Parties have executed this Agreement.

**FOR AND ON BEHALF OF {{supplier_legal_name_caps}}**

Authorized Signatory: {{supplier_signatory_name}}

Name & Title: {{supplier_signatory_designation}}

Date: {{signed_date}}

**FOR AND ON BEHALF OF {{company_legal_name}}**

Authorized Signatory: {{signed_by}}

Name & Title: {{company_signatory_designation}}

Date: {{signed_date}}

@footer {{supplier_legal_name}} — Master Service Agreement`;
