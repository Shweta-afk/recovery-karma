export type DPDBucket = "0-30" | "31-60" | "61-90" | "90+";

export interface Debtor {
  id: string;
  name: string;
  phone: string; // masked
  loanAmount: number;
  dpd: number;
  aiScore: number; // 1-10
  scoreReason: string;
  lastContacted: string | null; // ISO date or null
  portfolio: string;
  language: string;
}

export const PORTFOLIOS = [
  "Personal Loan Q1",
  "Two-Wheeler Auto",
  "Credit Card NPA",
  "MSME Working Cap",
] as const;

export const MOCK_DEBTORS: Debtor[] = [
  { id: "L-10042", name: "Rahul Sharma", phone: "+91 98XXX XX789", loanAmount: 245000, dpd: 12, aiScore: 9, scoreReason: "Promised payment last week, high contact rate", lastContacted: "2026-06-21", portfolio: "Personal Loan Q1", language: "Hindi" },
  { id: "L-10018", name: "Priya Iyer", phone: "+91 90XXX XX221", loanAmount: 87500, dpd: 45, aiScore: 9, scoreReason: "Salary credit detected yesterday, strong intent signals", lastContacted: "2026-06-22", portfolio: "Credit Card NPA", language: "English" },
  { id: "L-10211", name: "Amit Verma", phone: "+91 99XXX XX104", loanAmount: 1250000, dpd: 8, aiScore: 10, scoreReason: "PTP active, partial payment received, will close soon", lastContacted: "2026-06-22", portfolio: "MSME Working Cap", language: "Hindi" },
  { id: "L-10087", name: "Sneha Reddy", phone: "+91 97XXX XX556", loanAmount: 64000, dpd: 22, aiScore: 8, scoreReason: "Picks up calls, polite tone, employed in IT", lastContacted: "2026-06-20", portfolio: "Two-Wheeler Auto", language: "Telugu" },
  { id: "L-10309", name: "Vikram Singh", phone: "+91 98XXX XX012", loanAmount: 320000, dpd: 67, aiScore: 7, scoreReason: "Inconsistent contact, broken 2 PTPs in last 60 days", lastContacted: "2026-06-19", portfolio: "Personal Loan Q1", language: "Hindi" },
  { id: "L-10455", name: "Ananya Bose", phone: "+91 91XXX XX334", loanAmount: 178000, dpd: 35, aiScore: 8, scoreReason: "WhatsApp read receipts seen, prefers digital contact", lastContacted: "2026-06-21", portfolio: "Credit Card NPA", language: "Bengali" },
  { id: "L-10122", name: "Karthik Nair", phone: "+91 99XXX XX901", loanAmount: 52000, dpd: 18, aiScore: 7, scoreReason: "Recent UPI activity, possible payment capacity", lastContacted: "2026-06-18", portfolio: "Two-Wheeler Auto", language: "Malayalam" },
  { id: "L-10277", name: "Meera Joshi", phone: "+91 98XXX XX670", loanAmount: 95000, dpd: 28, aiScore: 8, scoreReason: "Spouse co-signer reachable, household stable", lastContacted: "2026-06-22", portfolio: "Personal Loan Q1", language: "Marathi" },
  { id: "L-10501", name: "Rohan Mehta", phone: "+91 90XXX XX448", loanAmount: 410000, dpd: 88, aiScore: 4, scoreReason: "Phone switched off frequently, address verification failed", lastContacted: "2026-06-15", portfolio: "MSME Working Cap", language: "Gujarati" },
  { id: "L-10333", name: "Divya Krishnan", phone: "+91 97XXX XX115", loanAmount: 27500, dpd: 5, aiScore: 9, scoreReason: "Auto-debit failure only, account funded today", lastContacted: "2026-06-22", portfolio: "Credit Card NPA", language: "Tamil" },
  { id: "L-10199", name: "Sandeep Yadav", phone: "+91 99XXX XX782", loanAmount: 615000, dpd: 52, aiScore: 6, scoreReason: "Negotiating settlement, requested manager callback", lastContacted: "2026-06-20", portfolio: "MSME Working Cap", language: "Hindi" },
  { id: "L-10421", name: "Pooja Bhatt", phone: "+91 98XXX XX209", loanAmount: 142000, dpd: 41, aiScore: 7, scoreReason: "Responsive on WhatsApp, slower on phone calls", lastContacted: "2026-06-19", portfolio: "Personal Loan Q1", language: "Hindi" },
  { id: "L-10068", name: "Arjun Kapoor", phone: "+91 91XXX XX833", loanAmount: 38000, dpd: 14, aiScore: 8, scoreReason: "First-time default, clean prior history, salary stable", lastContacted: "2026-06-21", portfolio: "Two-Wheeler Auto", language: "Punjabi" },
  { id: "L-10588", name: "Nikita Rao", phone: "+91 98XXX XX020", loanAmount: 230000, dpd: 73, aiScore: 5, scoreReason: "Disputed dues, requires reconciliation before payment", lastContacted: "2026-06-17", portfolio: "Credit Card NPA", language: "Kannada" },
  { id: "L-10145", name: "Manish Gupta", phone: "+91 97XXX XX461", loanAmount: 88000, dpd: 26, aiScore: 7, scoreReason: "Asked for 7-day extension, likely to keep PTP", lastContacted: "2026-06-22", portfolio: "Personal Loan Q1", language: "Hindi" },
  { id: "L-10612", name: "Sara Khan", phone: "+91 90XXX XX174", loanAmount: 49500, dpd: 9, aiScore: 9, scoreReason: "Strong sentiment in last call, mentioned UPI payment today", lastContacted: "2026-06-22", portfolio: "Two-Wheeler Auto", language: "Urdu" },
  { id: "L-10366", name: "Tarun Desai", phone: "+91 99XXX XX590", loanAmount: 805000, dpd: 105, aiScore: 3, scoreReason: "Legal notice sent, no engagement in 30+ days", lastContacted: "2026-05-18", portfolio: "MSME Working Cap", language: "Gujarati" },
  { id: "L-10094", name: "Lakshmi Pillai", phone: "+91 98XXX XX317", loanAmount: 62500, dpd: 33, aiScore: 7, scoreReason: "Family business recovering, partial payments expected", lastContacted: "2026-06-20", portfolio: "Credit Card NPA", language: "Tamil" },
  { id: "L-10478", name: "Imran Sheikh", phone: "+91 91XXX XX642", loanAmount: 113000, dpd: 19, aiScore: 8, scoreReason: "Promised installment by Friday, reliable in past cycles", lastContacted: "2026-06-21", portfolio: "Personal Loan Q1", language: "Hindi" },
  { id: "L-10523", name: "Geeta Menon", phone: "+91 97XXX XX058", loanAmount: 21500, dpd: 61, aiScore: 4, scoreReason: "Hostile on prior call, escalate to female agent", lastContacted: "2026-06-16", portfolio: "Two-Wheeler Auto", language: "Malayalam" },
];

export const TODAY_STATS = {
  callsMade: 47,
  target: 80,
  outcomes: {
    paid: 6,
    promised: 14,
    refused: 5,
    noAnswer: 22,
  },
};

export function bucketOf(dpd: number): DPDBucket {
  if (dpd <= 30) return "0-30";
  if (dpd <= 60) return "31-60";
  if (dpd <= 90) return "61-90";
  return "90+";
}

export function formatINR(n: number): string {
  // Indian numbering: 12,34,567
  const s = Math.round(n).toString();
  if (s.length <= 3) return "₹" + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const withCommas = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + withCommas + "," + last3;
}
