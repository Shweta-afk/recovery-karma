/** 5 standard DPD buckets used in Indian collections */
export type DPDBucket = "X" | "1" | "2" | "NPA" | "WriteOff";

export interface PaymentRecord {
  date: string;
  amount: number;
  method: string;
  status: "paid" | "bounced" | "missed";
  ref?: string;
}

export interface ContactAttempt {
  date: string;
  time: string;
  channel: "call" | "whatsapp" | "sms" | "email";
  outcome: string;
  agent: string;
}

export interface Debtor {
  id: string;
  name: string;
  phone: string;
  altPhone?: string;
  email?: string;
  loanAmount: number;
  dpd: number;
  aiScore: number;
  scoreReason: string;
  lastContacted: string | null;
  portfolio: string;
  language: string;
  // Personal
  gender?: "Male" | "Female" | "Other";
  dob?: string;
  age?: number;
  city?: string;
  state?: string;
  pincode?: string;
  address?: string;
  // Loan details
  lender?: string;
  loanType?: string;
  loanId?: string;
  disbursedOn?: string;
  tenure?: number; // months
  interestRate?: number;
  emiAmount?: number;
  emiDueDate?: number; // day of month
  principalOutstanding?: number;
  interestOutstanding?: number;
  penaltyCharges?: number;
  totalOverdue?: number;
  // Employment
  employer?: string;
  employerType?: "Salaried" | "Self-Employed" | "Business" | "Retired" | "Unemployed";
  monthlyIncome?: number;
  // Bank
  bankName?: string;
  accountType?: string;
  ifscCode?: string;
  // Co-applicant / guarantor
  coApplicantName?: string;
  coApplicantPhone?: string;
  guarantorName?: string;
  // History
  totalPaid?: number;
  paymentHistory?: PaymentRecord[];
  contactHistory?: ContactAttempt[];
  // Flags
  legalNotice?: boolean;
  disputeFlag?: boolean;
  pdcBounced?: number;
  settlementOffer?: number;
}

export const PORTFOLIOS = [
  "Personal Loan Q1",
  "Two-Wheeler Auto",
  "Credit Card NPA",
  "MSME Working Cap",
] as const;

export const MOCK_DEBTORS: Debtor[] = [
  {
    id: "L-10042", name: "Rahul Sharma", phone: "+91 98XXX XX789", altPhone: "+91 93XXX XX321", email: "rahul.sharma@gmail.com",
    loanAmount: 245000, dpd: 12, aiScore: 9, scoreReason: "Promised payment last week, high contact rate", lastContacted: "2026-06-21", portfolio: "Personal Loan Q1", language: "Hindi",
    gender: "Male", dob: "1988-04-15", age: 38, city: "Delhi", state: "Delhi", pincode: "110092", address: "H-14, Laxmi Nagar, East Delhi",
    lender: "HDFC Bank", loanType: "Personal Loan", loanId: "L-10042", disbursedOn: "2025-03-01", tenure: 24, interestRate: 14.5, emiAmount: 11840, emiDueDate: 5,
    principalOutstanding: 198000, interestOutstanding: 42000, penaltyCharges: 5000, totalOverdue: 47000,
    employer: "Infosys Ltd", employerType: "Salaried", monthlyIncome: 68000,
    bankName: "SBI", accountType: "Savings", ifscCode: "SBIN0001234",
    totalPaid: 47000,
    paymentHistory: [
      { date: "2026-05-05", amount: 11840, method: "UPI", status: "paid", ref: "UTR8823441" },
      { date: "2026-04-05", amount: 11840, method: "NEFT", status: "paid", ref: "UTR7712330" },
      { date: "2026-03-05", amount: 11840, method: "UPI", status: "paid", ref: "UTR6601229" },
      { date: "2026-02-05", amount: 11840, method: "NACH", status: "bounced" },
      { date: "2026-01-05", amount: 11840, method: "NACH", status: "paid", ref: "NACH5500118" },
    ],
    contactHistory: [
      { date: "2026-06-21", time: "10:14 AM", channel: "call", outcome: "PTP — will pay by 25 Jun", agent: "Priya Singh" },
      { date: "2026-06-18", time: "03:30 PM", channel: "whatsapp", outcome: "Read, no reply", agent: "System" },
      { date: "2026-06-15", time: "11:00 AM", channel: "call", outcome: "No answer", agent: "Ravi Mehta" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 1,
  },
  {
    id: "L-10018", name: "Priya Iyer", phone: "+91 90XXX XX221", altPhone: "+91 80XXX XX445", email: "priya.iyer@yahoo.com",
    loanAmount: 87500, dpd: 45, aiScore: 9, scoreReason: "Salary credit detected yesterday, strong intent signals", lastContacted: "2026-06-22", portfolio: "Credit Card NPA", language: "English",
    gender: "Female", dob: "1992-09-22", age: 33, city: "Chennai", state: "Tamil Nadu", pincode: "600028", address: "12B, Anna Nagar, Chennai",
    lender: "Bajaj Finance", loanType: "Credit Card", loanId: "L-10018", disbursedOn: "2024-09-15", tenure: 12, interestRate: 36.0, emiAmount: 8200, emiDueDate: 15,
    principalOutstanding: 62000, interestOutstanding: 18000, penaltyCharges: 7500, totalOverdue: 25500,
    employer: "Cognizant Technology", employerType: "Salaried", monthlyIncome: 55000,
    bankName: "ICICI Bank", accountType: "Savings", ifscCode: "ICIC0002201",
    totalPaid: 24600,
    paymentHistory: [
      { date: "2026-05-15", amount: 8200, method: "UPI", status: "paid", ref: "UTR9900221" },
      { date: "2026-04-15", amount: 8200, method: "UPI", status: "paid", ref: "UTR8811002" },
      { date: "2026-03-15", amount: 8200, method: "NEFT", status: "missed" },
      { date: "2026-02-15", amount: 8200, method: "NACH", status: "bounced" },
    ],
    contactHistory: [
      { date: "2026-06-22", time: "09:15 AM", channel: "call", outcome: "Agreed to pay ₹8,200 today", agent: "Priya Singh" },
      { date: "2026-06-20", time: "02:00 PM", channel: "sms", outcome: "SMS sent — payment link", agent: "System" },
      { date: "2026-06-17", time: "10:30 AM", channel: "call", outcome: "Callback requested after 6 PM", agent: "Mohit Rao" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 2,
  },
  {
    id: "L-10211", name: "Amit Verma", phone: "+91 99XXX XX104", email: "amit.verma@vermatraders.in",
    loanAmount: 1250000, dpd: 8, aiScore: 10, scoreReason: "PTP active, partial payment received, will close soon", lastContacted: "2026-06-22", portfolio: "MSME Working Cap", language: "Hindi",
    gender: "Male", dob: "1979-01-30", age: 47, city: "Mumbai", state: "Maharashtra", pincode: "400069", address: "Office 204, Trade Centre, Andheri West, Mumbai",
    lender: "Axis Bank", loanType: "MSME Working Capital", loanId: "L-10211", disbursedOn: "2024-06-01", tenure: 36, interestRate: 13.5, emiAmount: 42500, emiDueDate: 1,
    principalOutstanding: 980000, interestOutstanding: 220000, penaltyCharges: 50000, totalOverdue: 270000,
    employer: "Verma Traders Pvt Ltd", employerType: "Business", monthlyIncome: 280000,
    bankName: "Axis Bank", accountType: "Current", ifscCode: "UTIB0001100",
    coApplicantName: "Sunita Verma", coApplicantPhone: "+91 98XXX XX701",
    totalPaid: 127500,
    paymentHistory: [
      { date: "2026-06-01", amount: 42500, method: "NEFT", status: "paid", ref: "UTR0011223" },
      { date: "2026-05-01", amount: 42500, method: "NEFT", status: "paid", ref: "UTR9900112" },
      { date: "2026-04-01", amount: 42500, method: "NEFT", status: "missed" },
      { date: "2026-03-01", amount: 42500, method: "NEFT", status: "paid", ref: "UTR8800001" },
    ],
    contactHistory: [
      { date: "2026-06-22", time: "11:00 AM", channel: "call", outcome: "Confirmed payment of ₹85,000 this week", agent: "Sonal Desai" },
      { date: "2026-06-19", time: "04:30 PM", channel: "email", outcome: "Statement sent", agent: "System" },
    ],
    legalNotice: false, disputeFlag: false, settlementOffer: 1100000,
  },
  {
    id: "L-10087", name: "Sneha Reddy", phone: "+91 97XXX XX556", email: "sneha.reddy@techemail.com",
    loanAmount: 64000, dpd: 22, aiScore: 8, scoreReason: "Picks up calls, polite tone, employed in IT", lastContacted: "2026-06-20", portfolio: "Two-Wheeler Auto", language: "Telugu",
    gender: "Female", dob: "1997-06-10", age: 28, city: "Hyderabad", state: "Telangana", pincode: "500081", address: "Flat 3B, Madhapur, Hyderabad",
    lender: "Bajaj Finserv", loanType: "Two-Wheeler Loan", loanId: "L-10087", disbursedOn: "2025-08-01", tenure: 18, interestRate: 15.0, emiAmount: 4200, emiDueDate: 10,
    principalOutstanding: 52000, interestOutstanding: 8000, penaltyCharges: 4000, totalOverdue: 12000,
    employer: "Wipro Technologies", employerType: "Salaried", monthlyIncome: 42000,
    bankName: "HDFC Bank", accountType: "Savings", ifscCode: "HDFC0003312",
    totalPaid: 8400,
    paymentHistory: [
      { date: "2026-05-10", amount: 4200, method: "UPI", status: "paid", ref: "UTR5512331" },
      { date: "2026-04-10", amount: 4200, method: "UPI", status: "paid", ref: "UTR4401220" },
      { date: "2026-03-10", amount: 4200, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-20", time: "12:30 PM", channel: "call", outcome: "Promised EMI by 28 Jun", agent: "Mohit Rao" },
      { date: "2026-06-16", time: "10:00 AM", channel: "whatsapp", outcome: "Read — replied 'will pay soon'", agent: "System" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10309", name: "Vikram Singh", phone: "+91 98XXX XX012", altPhone: "+91 70XXX XX889",
    loanAmount: 320000, dpd: 67, aiScore: 7, scoreReason: "Inconsistent contact, broken 2 PTPs in last 60 days", lastContacted: "2026-06-19", portfolio: "Personal Loan Q1", language: "Hindi",
    gender: "Male", dob: "1984-11-03", age: 41, city: "Jaipur", state: "Rajasthan", pincode: "302015", address: "Plot 44, Vaishali Nagar, Jaipur",
    lender: "HDFC Bank", loanType: "Personal Loan", loanId: "L-10309", disbursedOn: "2024-11-01", tenure: 36, interestRate: 15.5, emiAmount: 11200, emiDueDate: 3,
    principalOutstanding: 278000, interestOutstanding: 38000, penaltyCharges: 14000, totalOverdue: 52000,
    employer: "Self — Vikram Enterprises", employerType: "Self-Employed", monthlyIncome: 75000,
    bankName: "PNB", accountType: "Savings", ifscCode: "PUNB0041200",
    totalPaid: 22400,
    paymentHistory: [
      { date: "2026-04-03", amount: 11200, method: "NEFT", status: "paid", ref: "UTR3300112" },
      { date: "2026-03-03", amount: 11200, method: "NACH", status: "bounced" },
      { date: "2026-02-03", amount: 11200, method: "NACH", status: "bounced" },
      { date: "2026-01-03", amount: 11200, method: "NEFT", status: "paid", ref: "UTR2200001" },
    ],
    contactHistory: [
      { date: "2026-06-19", time: "11:45 AM", channel: "call", outcome: "Broke PTP again — rescheduled", agent: "Ravi Mehta" },
      { date: "2026-06-12", time: "03:00 PM", channel: "call", outcome: "PTP set — not kept", agent: "Ravi Mehta" },
      { date: "2026-06-05", time: "10:00 AM", channel: "call", outcome: "No answer", agent: "Priya Singh" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 2,
  },
  {
    id: "L-10455", name: "Ananya Bose", phone: "+91 91XXX XX334", email: "ananya.bose@gmail.com",
    loanAmount: 178000, dpd: 35, aiScore: 8, scoreReason: "WhatsApp read receipts seen, prefers digital contact", lastContacted: "2026-06-21", portfolio: "Credit Card NPA", language: "Bengali",
    gender: "Female", dob: "1994-03-18", age: 32, city: "Kolkata", state: "West Bengal", pincode: "700054", address: "2nd Floor, Salt Lake, Kolkata",
    lender: "Bajaj Finance", loanType: "Credit Card", loanId: "L-10455", disbursedOn: "2025-01-01", tenure: 24, interestRate: 36.0, emiAmount: 9800, emiDueDate: 20,
    principalOutstanding: 140000, interestOutstanding: 28000, penaltyCharges: 10000, totalOverdue: 38000,
    employer: "Tata Consultancy Services", employerType: "Salaried", monthlyIncome: 58000,
    bankName: "Axis Bank", accountType: "Savings", ifscCode: "UTIB0002234",
    totalPaid: 29400,
    paymentHistory: [
      { date: "2026-05-20", amount: 9800, method: "UPI", status: "paid", ref: "UTR7700881" },
      { date: "2026-04-20", amount: 9800, method: "UPI", status: "paid", ref: "UTR6600770" },
      { date: "2026-03-20", amount: 9800, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-21", time: "02:15 PM", channel: "whatsapp", outcome: "Replied — salary on 24th, will pay", agent: "System" },
      { date: "2026-06-18", time: "10:00 AM", channel: "call", outcome: "No answer — WhatsApp sent", agent: "Priya Singh" },
    ],
    legalNotice: false, disputeFlag: false,
  },
  {
    id: "L-10122", name: "Karthik Nair", phone: "+91 99XXX XX901", email: "karthik.nair@email.com",
    loanAmount: 52000, dpd: 18, aiScore: 7, scoreReason: "Recent UPI activity, possible payment capacity", lastContacted: "2026-06-18", portfolio: "Two-Wheeler Auto", language: "Malayalam",
    gender: "Male", dob: "1999-07-25", age: 26, city: "Kochi", state: "Kerala", pincode: "682030", address: "TC 14/2, Vyttila, Kochi",
    lender: "Bajaj Finserv", loanType: "Two-Wheeler Loan", loanId: "L-10122", disbursedOn: "2025-06-01", tenure: 18, interestRate: 16.0, emiAmount: 3400, emiDueDate: 8,
    principalOutstanding: 42000, interestOutstanding: 6500, penaltyCharges: 3500, totalOverdue: 10000,
    employer: "Kerala Startup Hub", employerType: "Salaried", monthlyIncome: 28000,
    bankName: "Federal Bank", accountType: "Savings", ifscCode: "FDRL0001233",
    totalPaid: 6800,
    paymentHistory: [
      { date: "2026-05-08", amount: 3400, method: "UPI", status: "paid", ref: "UTR4412201" },
      { date: "2026-04-08", amount: 3400, method: "UPI", status: "paid", ref: "UTR3301100" },
      { date: "2026-03-08", amount: 3400, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-18", time: "04:00 PM", channel: "call", outcome: "Will pay by weekend via GPay", agent: "Mohit Rao" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10277", name: "Meera Joshi", phone: "+91 98XXX XX670", altPhone: "+91 77XXX XX112", email: "meera.joshi@outlook.com",
    loanAmount: 95000, dpd: 28, aiScore: 8, scoreReason: "Spouse co-signer reachable, household stable", lastContacted: "2026-06-22", portfolio: "Personal Loan Q1", language: "Marathi",
    gender: "Female", dob: "1985-12-05", age: 40, city: "Pune", state: "Maharashtra", pincode: "411001", address: "Row House 7, Koregaon Park, Pune",
    lender: "HDFC Bank", loanType: "Personal Loan", loanId: "L-10277", disbursedOn: "2025-05-01", tenure: 18, interestRate: 13.0, emiAmount: 6200, emiDueDate: 12,
    principalOutstanding: 76000, interestOutstanding: 14000, penaltyCharges: 5000, totalOverdue: 19000,
    employer: "Maharashtra Govt", employerType: "Salaried", monthlyIncome: 48000,
    bankName: "Bank of Maharashtra", accountType: "Savings", ifscCode: "MAHB0001234",
    coApplicantName: "Suresh Joshi", coApplicantPhone: "+91 77XXX XX112",
    totalPaid: 18600,
    paymentHistory: [
      { date: "2026-05-12", amount: 6200, method: "NACH", status: "paid", ref: "NACH8812001" },
      { date: "2026-04-12", amount: 6200, method: "NACH", status: "paid", ref: "NACH7701000" },
      { date: "2026-03-12", amount: 6200, method: "NACH", status: "paid", ref: "NACH6600889" },
      { date: "2026-02-12", amount: 6200, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-22", time: "10:30 AM", channel: "call", outcome: "Spouse picked up — promised payment", agent: "Leena Krishnan" },
      { date: "2026-06-17", time: "09:00 AM", channel: "sms", outcome: "Reminder SMS sent", agent: "System" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 1,
  },
  {
    id: "L-10501", name: "Rohan Mehta", phone: "+91 90XXX XX448",
    loanAmount: 410000, dpd: 88, aiScore: 4, scoreReason: "Phone switched off frequently, address verification failed", lastContacted: "2026-06-15", portfolio: "MSME Working Cap", language: "Gujarati",
    gender: "Male", dob: "1980-02-14", age: 46, city: "Ahmedabad", state: "Gujarat", pincode: "380015", address: "Shop 12, Navrangpura, Ahmedabad (unverified)",
    lender: "Axis Bank", loanType: "MSME Working Capital", loanId: "L-10501", disbursedOn: "2024-08-01", tenure: 24, interestRate: 16.5, emiAmount: 20500, emiDueDate: 15,
    principalOutstanding: 368000, interestOutstanding: 62000, penaltyCharges: 30000, totalOverdue: 92000,
    employer: "Mehta Trading Co", employerType: "Business", monthlyIncome: 90000,
    bankName: "Kotak Mahindra", accountType: "Current", ifscCode: "KKBK0001234",
    totalPaid: 41000,
    paymentHistory: [
      { date: "2026-04-15", amount: 20500, method: "NEFT", status: "paid", ref: "UTR2211100" },
      { date: "2026-03-15", amount: 20500, method: "NEFT", status: "missed" },
      { date: "2026-02-15", amount: 20500, method: "NACH", status: "bounced" },
      { date: "2026-01-15", amount: 20500, method: "NACH", status: "bounced" },
    ],
    contactHistory: [
      { date: "2026-06-15", time: "11:20 AM", channel: "call", outcome: "Phone switched off", agent: "Ravi Mehta" },
      { date: "2026-06-10", time: "03:00 PM", channel: "call", outcome: "No answer", agent: "Ravi Mehta" },
      { date: "2026-06-03", time: "10:00 AM", channel: "sms", outcome: "SMS sent — undelivered", agent: "System" },
    ],
    legalNotice: true, disputeFlag: false, pdcBounced: 3,
  },
  {
    id: "L-10333", name: "Divya Krishnan", phone: "+91 97XXX XX115", email: "divya.krishnan@gmail.com",
    loanAmount: 27500, dpd: 5, aiScore: 9, scoreReason: "Auto-debit failure only, account funded today", lastContacted: "2026-06-22", portfolio: "Credit Card NPA", language: "Tamil",
    gender: "Female", dob: "2000-05-20", age: 26, city: "Bangalore", state: "Karnataka", pincode: "560038", address: "Flat 101, Koramangala, Bangalore",
    lender: "Bajaj Finance", loanType: "Credit Card", loanId: "L-10333", disbursedOn: "2025-10-01", tenure: 6, interestRate: 36.0, emiAmount: 5100, emiDueDate: 22,
    principalOutstanding: 21000, interestOutstanding: 3500, penaltyCharges: 3000, totalOverdue: 6500,
    employer: "Infosys Ltd", employerType: "Salaried", monthlyIncome: 35000,
    bankName: "HDFC Bank", accountType: "Savings", ifscCode: "HDFC0004421",
    totalPaid: 5100,
    paymentHistory: [
      { date: "2026-05-22", amount: 5100, method: "UPI", status: "paid", ref: "UTR9911001" },
      { date: "2026-04-22", amount: 5100, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-22", time: "09:45 AM", channel: "call", outcome: "Paid ₹8,200 during call via UPI link", agent: "AI Bot" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10199", name: "Sandeep Yadav", phone: "+91 99XXX XX782", email: "sandeep.yadav@msme.com",
    loanAmount: 615000, dpd: 52, aiScore: 6, scoreReason: "Negotiating settlement, requested manager callback", lastContacted: "2026-06-20", portfolio: "MSME Working Cap", language: "Hindi",
    gender: "Male", dob: "1976-08-11", age: 49, city: "Lucknow", state: "Uttar Pradesh", pincode: "226001", address: "Office 3, Hazratganj, Lucknow",
    lender: "Axis Bank", loanType: "MSME Working Capital", loanId: "L-10199", disbursedOn: "2024-04-01", tenure: 36, interestRate: 14.0, emiAmount: 21000, emiDueDate: 7,
    principalOutstanding: 550000, interestOutstanding: 55000, penaltyCharges: 10000, totalOverdue: 65000,
    employer: "Yadav Agro Exports", employerType: "Business", monthlyIncome: 120000,
    bankName: "SBI", accountType: "Current", ifscCode: "SBIN0009922",
    coApplicantName: "Rekha Yadav", coApplicantPhone: "+91 94XXX XX554",
    totalPaid: 63000,
    paymentHistory: [
      { date: "2026-05-07", amount: 21000, method: "NEFT", status: "paid", ref: "UTR8801122" },
      { date: "2026-04-07", amount: 21000, method: "NEFT", status: "paid", ref: "UTR7700011" },
      { date: "2026-03-07", amount: 21000, method: "NACH", status: "bounced" },
      { date: "2026-02-07", amount: 21000, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-20", time: "02:00 PM", channel: "call", outcome: "Requesting 15% interest waiver — escalated", agent: "Ravi Mehta" },
      { date: "2026-06-14", time: "11:00 AM", channel: "email", outcome: "Sent settlement options letter", agent: "System" },
    ],
    legalNotice: false, disputeFlag: true, settlementOffer: 580000, pdcBounced: 2,
  },
  {
    id: "L-10421", name: "Pooja Bhatt", phone: "+91 98XXX XX209", altPhone: "+91 80XXX XX334", email: "pooja.bhatt@gmail.com",
    loanAmount: 142000, dpd: 41, aiScore: 7, scoreReason: "Responsive on WhatsApp, slower on phone calls", lastContacted: "2026-06-19", portfolio: "Personal Loan Q1", language: "Hindi",
    gender: "Female", dob: "1991-04-02", age: 35, city: "Mumbai", state: "Maharashtra", pincode: "400016", address: "D-204, Prabhadevi, Mumbai",
    lender: "HDFC Bank", loanType: "Personal Loan", loanId: "L-10421", disbursedOn: "2025-02-01", tenure: 24, interestRate: 14.5, emiAmount: 6900, emiDueDate: 18,
    principalOutstanding: 112000, interestOutstanding: 22000, penaltyCharges: 8000, totalOverdue: 30000,
    employer: "Freelance Designer", employerType: "Self-Employed", monthlyIncome: 45000,
    bankName: "ICICI Bank", accountType: "Savings", ifscCode: "ICIC0001100",
    totalPaid: 20700,
    paymentHistory: [
      { date: "2026-05-18", amount: 6900, method: "UPI", status: "paid", ref: "UTR6600112" },
      { date: "2026-04-18", amount: 6900, method: "NACH", status: "bounced" },
      { date: "2026-03-18", amount: 6900, method: "UPI", status: "paid", ref: "UTR5500001" },
      { date: "2026-02-18", amount: 6900, method: "UPI", status: "paid", ref: "UTR4411998" },
    ],
    contactHistory: [
      { date: "2026-06-19", time: "07:30 PM", channel: "whatsapp", outcome: "Replied — will pay after project payment", agent: "System" },
      { date: "2026-06-15", time: "12:00 PM", channel: "call", outcome: "Callback requested for evening", agent: "Priya Singh" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 1,
  },
  {
    id: "L-10068", name: "Arjun Kapoor", phone: "+91 91XXX XX833", email: "arjun.kapoor@email.com",
    loanAmount: 38000, dpd: 14, aiScore: 8, scoreReason: "First-time default, clean prior history, salary stable", lastContacted: "2026-06-21", portfolio: "Two-Wheeler Auto", language: "Punjabi",
    gender: "Male", dob: "2001-09-15", age: 24, city: "Chandigarh", state: "Punjab", pincode: "160022", address: "House 34, Sector 22, Chandigarh",
    lender: "Hero FinCorp", loanType: "Two-Wheeler Loan", loanId: "L-10068", disbursedOn: "2025-09-01", tenure: 18, interestRate: 15.5, emiAmount: 2500, emiDueDate: 6,
    principalOutstanding: 31000, interestOutstanding: 4500, penaltyCharges: 2500, totalOverdue: 7000,
    employer: "Punjab National Bank (Trainee)", employerType: "Salaried", monthlyIncome: 22000,
    bankName: "SBI", accountType: "Savings", ifscCode: "SBIN0008811",
    totalPaid: 5000,
    paymentHistory: [
      { date: "2026-05-06", amount: 2500, method: "UPI", status: "paid", ref: "UTR3312211" },
      { date: "2026-04-06", amount: 2500, method: "UPI", status: "paid", ref: "UTR2201100" },
      { date: "2026-03-06", amount: 2500, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-21", time: "09:00 AM", channel: "call", outcome: "Apologised, PTP by Friday", agent: "Mohit Rao" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10588", name: "Nikita Rao", phone: "+91 98XXX XX020", email: "nikita.rao@gmail.com",
    loanAmount: 230000, dpd: 73, aiScore: 5, scoreReason: "Disputed dues, requires reconciliation before payment", lastContacted: "2026-06-17", portfolio: "Credit Card NPA", language: "Kannada",
    gender: "Female", dob: "1990-02-28", age: 36, city: "Bangalore", state: "Karnataka", pincode: "560001", address: "Apt 5B, Residency Road, Bangalore",
    lender: "Bajaj Finance", loanType: "Credit Card", loanId: "L-10588", disbursedOn: "2024-07-01", tenure: 24, interestRate: 36.0, emiAmount: 12800, emiDueDate: 25,
    principalOutstanding: 185000, interestOutstanding: 38000, penaltyCharges: 17000, totalOverdue: 55000,
    employer: "Infosys (on leave)", employerType: "Salaried", monthlyIncome: 62000,
    bankName: "HDFC Bank", accountType: "Savings", ifscCode: "HDFC0005512",
    totalPaid: 38400,
    paymentHistory: [
      { date: "2026-04-25", amount: 12800, method: "NEFT", status: "paid", ref: "UTR1100991" },
      { date: "2026-03-25", amount: 12800, method: "NACH", status: "bounced" },
      { date: "2026-02-25", amount: 12800, method: "NACH", status: "bounced" },
      { date: "2026-01-25", amount: 12800, method: "NEFT", status: "paid", ref: "UTR0011880" },
    ],
    contactHistory: [
      { date: "2026-06-17", time: "03:15 PM", channel: "call", outcome: "Disputed ₹2,30,000 amount — ticket D-002", agent: "Sonal Desai" },
      { date: "2026-06-12", time: "10:00 AM", channel: "email", outcome: "Reconciliation statement sent", agent: "System" },
    ],
    legalNotice: false, disputeFlag: true, pdcBounced: 2,
  },
  {
    id: "L-10145", name: "Manish Gupta", phone: "+91 97XXX XX461", email: "manish.gupta@business.in",
    loanAmount: 88000, dpd: 26, aiScore: 7, scoreReason: "Asked for 7-day extension, likely to keep PTP", lastContacted: "2026-06-22", portfolio: "Personal Loan Q1", language: "Hindi",
    gender: "Male", dob: "1987-06-30", age: 38, city: "Noida", state: "Uttar Pradesh", pincode: "201301", address: "B-14, Sector 62, Noida",
    lender: "HDFC Bank", loanType: "Personal Loan", loanId: "L-10145", disbursedOn: "2025-04-01", tenure: 18, interestRate: 14.0, emiAmount: 5800, emiDueDate: 28,
    principalOutstanding: 70000, interestOutstanding: 12000, penaltyCharges: 6000, totalOverdue: 18000,
    employer: "Amazon India", employerType: "Salaried", monthlyIncome: 55000,
    bankName: "ICICI Bank", accountType: "Savings", ifscCode: "ICIC0003311",
    totalPaid: 11600,
    paymentHistory: [
      { date: "2026-05-28", amount: 5800, method: "NACH", status: "paid", ref: "NACH9900112" },
      { date: "2026-04-28", amount: 5800, method: "NACH", status: "paid", ref: "NACH8801001" },
      { date: "2026-03-28", amount: 5800, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-22", time: "12:05 PM", channel: "call", outcome: "Extension of 7 days approved", agent: "Priya Singh" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10612", name: "Sara Khan", phone: "+91 90XXX XX174", email: "sara.khan@email.com",
    loanAmount: 49500, dpd: 9, aiScore: 9, scoreReason: "Strong sentiment in last call, mentioned UPI payment today", lastContacted: "2026-06-22", portfolio: "Two-Wheeler Auto", language: "Urdu",
    gender: "Female", dob: "1998-01-12", age: 28, city: "Hyderabad", state: "Telangana", pincode: "500003", address: "12, Nampally, Hyderabad",
    lender: "Hero FinCorp", loanType: "Two-Wheeler Loan", loanId: "L-10612", disbursedOn: "2025-10-01", tenure: 12, interestRate: 15.0, emiAmount: 4600, emiDueDate: 14,
    principalOutstanding: 40000, interestOutstanding: 5500, penaltyCharges: 4000, totalOverdue: 9500,
    employer: "Zomato Pvt Ltd", employerType: "Salaried", monthlyIncome: 30000,
    bankName: "Axis Bank", accountType: "Savings", ifscCode: "UTIB0003399",
    totalPaid: 4600,
    paymentHistory: [
      { date: "2026-05-14", amount: 4600, method: "UPI", status: "paid", ref: "UTR8800001" },
      { date: "2026-04-14", amount: 4600, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-22", time: "02:28 PM", channel: "call", outcome: "Confirmed UPI payment by evening", agent: "Priya Singh" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10366", name: "Tarun Desai", phone: "+91 99XXX XX590",
    loanAmount: 805000, dpd: 105, aiScore: 3, scoreReason: "Legal notice sent, no engagement in 30+ days", lastContacted: "2026-05-18", portfolio: "MSME Working Cap", language: "Gujarati",
    gender: "Male", dob: "1972-12-20", age: 53, city: "Surat", state: "Gujarat", pincode: "395009", address: "Shop 8, Ring Road, Surat",
    lender: "Axis Bank", loanType: "MSME Working Capital", loanId: "L-10366", disbursedOn: "2024-01-01", tenure: 36, interestRate: 17.0, emiAmount: 28800, emiDueDate: 20,
    principalOutstanding: 720000, interestOutstanding: 100000, penaltyCharges: 55000, totalOverdue: 155000,
    employer: "Desai Textile Mill", employerType: "Business", monthlyIncome: 0,
    bankName: "HDFC Bank", accountType: "Current", ifscCode: "HDFC0007788",
    totalPaid: 28800,
    paymentHistory: [
      { date: "2026-02-20", amount: 28800, method: "NEFT", status: "paid", ref: "UTR0099001" },
      { date: "2026-01-20", amount: 28800, method: "NEFT", status: "missed" },
      { date: "2025-12-20", amount: 28800, method: "NACH", status: "bounced" },
      { date: "2025-11-20", amount: 28800, method: "NACH", status: "bounced" },
    ],
    contactHistory: [
      { date: "2026-05-18", time: "04:00 PM", channel: "call", outcome: "Abusive — call disconnected", agent: "AI Bot" },
      { date: "2026-05-10", time: "10:00 AM", channel: "sms", outcome: "Legal notice SMS sent", agent: "System" },
      { date: "2026-04-28", time: "11:00 AM", channel: "call", outcome: "No answer", agent: "Sonal Desai" },
    ],
    legalNotice: true, disputeFlag: false, pdcBounced: 4,
  },
  {
    id: "L-10094", name: "Lakshmi Pillai", phone: "+91 98XXX XX317", email: "lakshmi.pillai@gmail.com",
    loanAmount: 62500, dpd: 33, aiScore: 7, scoreReason: "Family business recovering, partial payments expected", lastContacted: "2026-06-20", portfolio: "Credit Card NPA", language: "Tamil",
    gender: "Female", dob: "1983-11-08", age: 42, city: "Coimbatore", state: "Tamil Nadu", pincode: "641004", address: "14, RS Puram, Coimbatore",
    lender: "Bajaj Finance", loanType: "Credit Card", loanId: "L-10094", disbursedOn: "2025-01-15", tenure: 12, interestRate: 36.0, emiAmount: 6500, emiDueDate: 16,
    principalOutstanding: 48000, interestOutstanding: 10000, penaltyCharges: 4500, totalOverdue: 14500,
    employer: "Pillai Silk Stores", employerType: "Business", monthlyIncome: 38000,
    bankName: "Canara Bank", accountType: "Savings", ifscCode: "CNRB0001122",
    totalPaid: 13000,
    paymentHistory: [
      { date: "2026-05-16", amount: 6500, method: "NEFT", status: "paid", ref: "UTR5501221" },
      { date: "2026-04-16", amount: 6500, method: "NEFT", status: "paid", ref: "UTR4400110" },
      { date: "2026-03-16", amount: 6500, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-20", time: "10:00 AM", channel: "call", outcome: "Will pay partial — ₹6,500 by Monday", agent: "Leena Krishnan" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10478", name: "Imran Sheikh", phone: "+91 91XXX XX642", email: "imran.sheikh@email.com",
    loanAmount: 113000, dpd: 19, aiScore: 8, scoreReason: "Promised installment by Friday, reliable in past cycles", lastContacted: "2026-06-21", portfolio: "Personal Loan Q1", language: "Hindi",
    gender: "Male", dob: "1993-03-25", age: 33, city: "Mumbai", state: "Maharashtra", pincode: "400008", address: "Flat 7, Mohammed Ali Road, Mumbai",
    lender: "HDFC Bank", loanType: "Personal Loan", loanId: "L-10478", disbursedOn: "2025-07-01", tenure: 18, interestRate: 13.5, emiAmount: 7300, emiDueDate: 25,
    principalOutstanding: 90000, interestOutstanding: 16000, penaltyCharges: 7000, totalOverdue: 23000,
    employer: "IndusInd Bank", employerType: "Salaried", monthlyIncome: 52000,
    bankName: "IndusInd Bank", accountType: "Savings", ifscCode: "INDB0001243",
    totalPaid: 14600,
    paymentHistory: [
      { date: "2026-05-25", amount: 7300, method: "NACH", status: "paid", ref: "NACH8801122" },
      { date: "2026-04-25", amount: 7300, method: "NACH", status: "paid", ref: "NACH7700011" },
      { date: "2026-03-25", amount: 7300, method: "NACH", status: "missed" },
    ],
    contactHistory: [
      { date: "2026-06-21", time: "03:02 PM", channel: "call", outcome: "PTP set — paying Friday via UPI", agent: "Mohit Rao" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 0,
  },
  {
    id: "L-10523", name: "Geeta Menon", phone: "+91 97XXX XX058",
    loanAmount: 21500, dpd: 61, aiScore: 4, scoreReason: "Hostile on prior call, escalate to female agent", lastContacted: "2026-06-16", portfolio: "Two-Wheeler Auto", language: "Malayalam",
    gender: "Female", dob: "1975-07-14", age: 50, city: "Thrissur", state: "Kerala", pincode: "680001", address: "TC 22/4, Near Temple Road, Thrissur",
    lender: "Hero FinCorp", loanType: "Two-Wheeler Loan", loanId: "L-10523", disbursedOn: "2024-12-01", tenure: 18, interestRate: 17.5, emiAmount: 1500, emiDueDate: 20,
    principalOutstanding: 18000, interestOutstanding: 2500, penaltyCharges: 1000, totalOverdue: 3500,
    employer: "Retired Teacher", employerType: "Retired", monthlyIncome: 12000,
    bankName: "South Indian Bank", accountType: "Savings", ifscCode: "SIBL0000123",
    totalPaid: 3000,
    paymentHistory: [
      { date: "2026-05-20", amount: 1500, method: "Cash", status: "paid", ref: "CSH001" },
      { date: "2026-04-20", amount: 1500, method: "Cash", status: "paid", ref: "CSH002" },
      { date: "2026-03-20", amount: 1500, method: "Cash", status: "missed" },
      { date: "2026-02-20", amount: 1500, method: "NACH", status: "bounced" },
    ],
    contactHistory: [
      { date: "2026-06-16", time: "11:22 AM", channel: "call", outcome: "Hostile — field visit flagged", agent: "Leena Krishnan" },
      { date: "2026-06-09", time: "10:00 AM", channel: "call", outcome: "No answer", agent: "Leena Krishnan" },
    ],
    legalNotice: false, disputeFlag: false, pdcBounced: 1,
  },
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
  if (dpd === 0) return "X";
  if (dpd <= 30) return "1";
  if (dpd <= 90) return "2";
  if (dpd <= 179) return "NPA";
  return "WriteOff";
}

export const BUCKET_META: Record<DPDBucket, { label: string; color: string; description: string }> = {
  X:        { label: "Bucket X",    color: "text-success border-success/30 bg-success/10",         description: "0 DPD — Current" },
  "1":      { label: "Bucket 1",    color: "text-primary border-primary/30 bg-primary/10",          description: "1–30 DPD — Early" },
  "2":      { label: "Bucket 2",    color: "text-warning-foreground border-warning/40 bg-warning/10", description: "31–90 DPD — Mid" },
  NPA:      { label: "NPA (90+)",   color: "text-destructive border-destructive/30 bg-destructive/10", description: "91–179 DPD — Sub-standard" },
  WriteOff: { label: "Write-Off",   color: "text-muted-foreground border-border bg-muted/30",       description: "180+ DPD — Written off" },
};

export function formatINR(n: number): string {
  // Indian numbering: 12,34,567
  const s = Math.round(n).toString();
  if (s.length <= 3) return "₹" + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const withCommas = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + withCommas + "," + last3;
}
