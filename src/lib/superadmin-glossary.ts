// Plain-language explanations for everything the superadmin portal shows. One source for the
// ⓘ hints beside numbers and column headings, the "How to read this page" boxes, and the Help
// page — so when a number's meaning changes, change it here and every place updates.
//
// Write for someone who has never seen the portal: no code words, say what the number is and
// what to do about it. If a rule changes in platform-usage.ts or revenue-report.ts (e.g. the
// "slowing" threshold), update the matching text here.

export interface GlossaryEntry {
  /** The name as it appears on screen. */
  term: string;
  /** One or two sentences: what it is, and (where useful) what to do about it. */
  text: string;
}

export const GLOSSARY = {
  // ── The date filter ──────────────────────────────────────────────────────
  period: {
    term: "Date filter",
    text: "Pick a period with the buttons (7, 30, 90 days, this month, last month) or the two date boxes. Every number on the page covers that period, and your choice carries over to the other superadmin pages.",
  },
  comparison: {
    term: "+12% / −40%",
    text: "Compares this period with the same number of days just before it. Green = went up, red = went down. 'new' means there was nothing to compare with.",
  },

  // ── Calling ──────────────────────────────────────────────────────────────
  activeCompanies: {
    term: "Active companies",
    text: "How many approved companies made at least one call or Insights lookup in the period, out of all approved companies.",
  },
  activeCallers: {
    term: "Active callers",
    text: "How many people (agents or managers) made at least one call in the period.",
  },
  calls: {
    term: "Calls",
    text: "Every call logged through SamvadX in the period, whether or not anyone picked up.",
  },
  contacts: {
    term: "Contacts",
    text: "Calls where the agent actually spoke to someone — everything except 'No answer' and 'Voicemail'.",
  },
  contactRate: {
    term: "Contact rate",
    text: "Contacts ÷ calls. Out of all calls, the share where someone picked up and talked. Low means agents are dialling but not reaching people.",
  },
  talkTime: {
    term: "Talk time",
    text: "Total length of all calls in the period.",
  },

  // ── Insights ─────────────────────────────────────────────────────────────
  insightsLookups: {
    term: "Insights lookups",
    text: "How many ProfileX searches were run (on borrowers, plus ones an admin typed in by hand).",
  },
  foundData: {
    term: "Found data",
    text: "Of those lookups, the share that came back with information. ProfileX charges even when nothing is found.",
  },
  insightsBilled: {
    term: "Insights billed",
    text: "What companies were charged from their Insights wallets for lookups — your Insights revenue.",
  },
  profilexCost: {
    term: "ProfileX cost",
    text: "What ProfileX actually charges SamvadX for those same lookups, at their published prices.",
  },
  insightsMargin: {
    term: "Insights margin",
    text: "Insights billed minus ProfileX cost — your profit on Insights. If it is negative, that company's price is below your cost.",
  },
  wallet: {
    term: "Insights wallet",
    text: "The company's Insights balance right now (not affected by the date filter). Lookups stop working when it reaches zero — top it up from Insights Wallet.",
  },

  // ── Company status ───────────────────────────────────────────────────────
  health: {
    term: "Health",
    text: "A quick label for how much a company is using SamvadX in the period. Hover the label itself to see what it means.",
  },
  healthActive: {
    term: "Active",
    text: "Made calls or Insights lookups in the period.",
  },
  healthSlowing: {
    term: "Slowing",
    text: "Calls + lookups fell below 60% of the previous period (counted once that period had at least 10). Worth a check-in call.",
  },
  healthDormant: {
    term: "Dormant",
    text: "No calls and no lookups at all in the period. They may have stopped using SamvadX.",
  },
  healthNew: {
    term: "New",
    text: "Joined less than 14 days ago and hasn't started using SamvadX yet.",
  },
  healthNotLive: {
    term: "Not live",
    text: "Still waiting for approval, or rejected — nobody there can use the app.",
  },
  seats: {
    term: "Seats",
    text: "Agents in use out of the limit you set (e.g. 18/20); managers shown below. Orange at 90% or more — they will soon need more seats. No limit set shows just the number in use.",
  },
  lastActivity: {
    term: "Last activity",
    text: "The last time anyone at the company made a call, ran a lookup or signed in.",
  },
  lastSignIn: {
    term: "Last sign-in",
    text: "When this person last logged in to SamvadX. 'Never' means they have an account but have not logged in.",
  },
  lastCallLookup: {
    term: "Last call/lookup",
    text: "The last time this person made a call or ran an Insights lookup.",
  },
  portfolios: {
    term: "Portfolios",
    text: "The account files the company uploaded. Open = still being worked; closed = ended or past its end date. Only counts are shown, never borrower details.",
  },

  // ── Overview extras ──────────────────────────────────────────────────────
  needsAttention: {
    term: "Needs attention",
    text: "Your to-do list: companies waiting for approval, companies that stopped using SamvadX, Insights wallets that will run out within 7 days, companies at 90%+ of their seats, and Excel requests waiting for you. Click one to open it.",
  },
  dailyUsage: {
    term: "Daily usage",
    text: "Calls (blue) and Insights lookups (green) for each day of the period, Indian time.",
  },
  topCompanies: {
    term: "Top companies",
    text: "The five companies with the most calls or lookups in the period. The bar shows each one compared with the top company.",
  },

  // ── Revenue ──────────────────────────────────────────────────────────────
  billed: {
    term: "Billed",
    text: "Invoices you issued in the period, including GST. Cancelled invoices are left out; credit notes are shown separately and taken off in 'net'.",
  },
  received: {
    term: "Received",
    text: "Money that arrived in the period, by the date it was received (recorded on each invoice with 'Record payment'). Part-payments count as they come in.",
  },
  outstanding: {
    term: "Outstanding now",
    text: "What companies still owe you right now, whatever dates you picked — each unpaid invoice less payments received and credit notes issued.",
  },
  overdue: {
    term: "Overdue now",
    text: "The part of 'Outstanding' that is past its due date.",
  },
  ageing: {
    term: "How long it's been owed",
    text: "Unpaid invoices grouped by how many days past the due date they are. The older the money, the more urgent the follow-up.",
  },
  oldestOverdue: {
    term: "Oldest overdue",
    text: "How many days late this company's oldest unpaid invoice is.",
  },
  gstSummary: {
    term: "GST summary by month",
    text: "Taxable value and CGST/SGST/IGST of the invoices issued each month, for GST filing. The Excel download adds every invoice with the customer's GSTIN.",
  },
  creditNote: {
    term: "Credit note",
    text: "The GST-correct way to reduce or reverse an invoice that was already issued (e.g. a wrong amount). It has its own number, counts in the month it is issued, and reduces what the company owes. Issue one from an opened invoice.",
  },
  losingMoney: {
    term: "Losing money",
    text: "This company is charged less for Insights than ProfileX charges you. Raise their Insights prices on their Settings tab.",
  },
  seatUpsell: {
    term: "Seat upsell",
    text: "Companies using 90% or more of their seat limit — a good moment to offer them more seats or a bigger plan.",
  },

  // ── Contracts ────────────────────────────────────────────────────────────
  platformTerms: {
    term: "SamvadX platform terms",
    text: "The terms that apply to every company. Each company's admins see the current version on their Contracts page.",
  },
  companyAgreement: {
    term: "Signed agreement",
    text: "One company's own signed contract (e.g. its MSA). Only that company's admins can see it.",
  },
  contractChange: {
    term: "Contract change",
    text: "A short note you publish when a feature is added or changes (e.g. a new Insights lookup and its price). The admins of the companies it applies to get a notification and see it on their Contracts page.",
  },
  requiresAcceptance: {
    term: "Admins must accept",
    text: "On: one admin of each company must accept the change (they tick a box and type their name); you see who accepted and when. Off: it is shown for information only.",
  },
  acceptanceStatus: {
    term: "Accepted",
    text: "How many of the companies the change applies to have accepted it. Open a change to see who accepted for each company, or to email the admins who still haven't.",
  },

  excel: {
    term: "Download Excel",
    text: "Saves what the table shows, for the dates you picked, as an Excel file.",
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

/** Short "How to read this page" notes, shown at the top of each superadmin page. */
export const PAGE_GUIDES = {
  overview: {
    title: "Overview",
    points: [
      "The whole platform at a glance: how much all companies are using calling and Insights.",
      "Each number compares the chosen period with the same number of days before it (the green/red %).",
      "Start with 'Needs attention' — it lists what you should act on today.",
      "Hover or tap any ⓘ to see what a number means.",
    ],
  },
  companies: {
    title: "Companies",
    points: [
      "One row per company with how much they used SamvadX in the chosen period.",
      "Health tells you at a glance who is active, slowing down or has stopped (Dormant).",
      "Click a column heading to sort — e.g. sort by Health to see Dormant companies first.",
      "Click a company to open its full page.",
    ],
  },
  company: {
    title: "Company page",
    points: [
      "Overview: this company's usage, a daily chart and its portfolios.",
      "Users: everyone at the company — who signs in and who actually makes calls or lookups.",
      "Billing: seat limits, invoices and every Insights wallet movement.",
      "Settings: approval, subdomain and which Insights services they get at what price.",
    ],
  },
  revenue: {
    title: "Revenue",
    points: [
      "Money from SamvadX's own invoices to companies — not the companies' collections.",
      "Billed and Received follow the dates you pick; Outstanding and Overdue are always as of today.",
      "Use 'How long it's been owed' to decide who to chase for payment first.",
      "Insights margin shows which companies are profitable on Insights; 'Seat upsell' shows who needs more seats.",
    ],
  },
  wallet: {
    title: "Insights Wallet",
    points: [
      "Actual wallet: your real balance with ProfileX. Top it up there first, then record it here.",
      "Master wallet: your pool to hand out to companies as Insights budget.",
      "Allocate to a company: adds budget to that company's wallet.",
      "Wallet history: every top-up, allocation and lookup charge in the chosen dates.",
    ],
  },
  insights: {
    title: "Insights Activity",
    points: [
      "Every ProfileX lookup across all companies in the chosen dates.",
      "'Company charged' is what the company paid; 'Actual ProfileX cost' is what you paid. The difference is your margin.",
      "'Paid, no data' = ProfileX charged but found nothing. 'Failed' = never charged.",
      "Excel requests from companies wait for your approval at the top.",
    ],
  },
  invoices: {
    title: "Invoices",
    points: [
      "Make & send: pick the company — the details its admin filled in and its price list are fetched for you.",
      "Choose a tab — Setup, Insights, Monthly (Calls is coming soon) — then Preview to see exactly what the company will get, and Issue.",
      "Send emails the invoice with a link to it in their SamvadX account. 'Viewed' appears once one of their admins opens it.",
      "Open an invoice to record a payment or issue a credit note — that is what Revenue counts as received.",
    ],
  },
  contracts: {
    title: "Contracts",
    points: [
      "Agreement: ONE agreement for every company. Publish it once; each company sees it with its own details (and yours) filled in.",
      "The list shows every company: Not sent, Sent, Viewed or Signed (who and when). 'Their copy' shows exactly what they see — or what they signed.",
      "Your company's name, CIN, address and signatory come from Invoices → SamvadX details; change them there and every agreement follows.",
      "Change notices: tell companies about a new feature or price. Each one shows who has seen it and who has accepted it.",
    ],
  },
  activity: {
    title: "Superadmin Activity",
    points: [
      "A record of everything a superadmin has done: approvals, subdomains, seat limits, role changes, Insights settings and money movements.",
      "Filter by company or dates to answer 'who changed this, and when?'",
    ],
  },
} satisfies Record<string, { title: string; points: string[] }>;

export type PageGuideKey = keyof typeof PAGE_GUIDES;

/** How the Help page groups the glossary. Every GLOSSARY key must appear here (tested). */
export const HELP_SECTIONS: { title: string; keys: GlossaryKey[] }[] = [
  { title: "Dates and comparisons", keys: ["period", "comparison"] },
  {
    title: "Calling",
    keys: ["activeCompanies", "activeCallers", "calls", "contacts", "contactRate", "talkTime"],
  },
  {
    title: "Insights (ProfileX)",
    keys: [
      "insightsLookups",
      "foundData",
      "insightsBilled",
      "profilexCost",
      "insightsMargin",
      "wallet",
    ],
  },
  {
    title: "Company health and people",
    keys: [
      "health",
      "healthActive",
      "healthSlowing",
      "healthDormant",
      "healthNew",
      "healthNotLive",
      "seats",
      "lastActivity",
      "lastSignIn",
      "lastCallLookup",
      "portfolios",
    ],
  },
  { title: "Overview", keys: ["needsAttention", "dailyUsage", "topCompanies"] },
  {
    title: "Revenue",
    keys: [
      "billed",
      "received",
      "outstanding",
      "overdue",
      "ageing",
      "oldestOverdue",
      "gstSummary",
      "creditNote",
      "losingMoney",
      "seatUpsell",
    ],
  },
  {
    title: "Contracts",
    keys: [
      "platformTerms",
      "companyAgreement",
      "contractChange",
      "requiresAcceptance",
      "acceptanceStatus",
    ],
  },
  { title: "Downloads", keys: ["excel"] },
];
