# RecoveryAI — Data Models

All interfaces below reflect the TypeScript types used in route files. D1 schema should mirror these shapes.

## Debtor (core record)

From `src/lib/mock-debtors.ts`:

```ts
interface Debtor {
  id: string; // e.g. "L-10042"
  name: string;
  phone: string; // masked: "+91 98XXX XX789"
  loanAmount: number; // principal in ₹
  outstanding: number; // current outstanding in ₹
  dpd: number; // days past due
  language: string; // preferred contact language
  portfolio: string; // batch name e.g. "Personal Loan Q2"
  product: string; // "Personal Loan" | "Credit Card NPA" | "MSME Loan" | ...
  lender: string; // originating bank/NBFC
  score: number; // AI collectability score 0–100
  pos: string; // point of sale / branch
  email?: string;
  address?: string;
  employer?: string;
  // EMI schedule, call history, messages, payments — joined on fetch
}
```

## Call record

```ts
interface CallLog {
  id: string;
  debtorId: string;
  date: string;
  time: string;
  duration: string; // "MM:SS"
  outcome: CallOutcome; // see below
  notes: string;
  agent: string;
  recordingUrl?: string; // playback URL
  aiHandled: boolean;
}

type CallOutcome =
  | "paid"
  | "promised"
  | "refused"
  | "no_answer"
  | "callback"
  | "voicemail"
  | "dispute"
  | "settlement";
```

## Disposition form (submitted after each call)

```ts
interface DispositionForm {
  outcome: CallOutcome;
  notes: string;
  ptpDate: string;
  ptpAmount: string;
  callbackDate: string;
  callbackTime: string;
  escalate: boolean;
  settlementAmount: string;
  settlementDate: string;
  settlementWaiver: string;
}
```

## Payment record

```ts
interface PaymentRecord {
  id: string; // "RX-001"
  debtorName: string;
  loanId: string;
  phone: string;
  portfolio: string;
  amount: number;
  method: "UPI" | "NEFT" | "RTGS" | "eNACH" | "Cash" | "Cheque";
  ref: string; // bank reference e.g. "UPI20260622AMTV1234"
  date: string;
  time: string;
  status: "confirmed" | "pending_verification" | "bounced" | "partial";
  collectedBy: "agent" | "ai" | "self";
  agentName: string;
  lender: string;
  product: string;
  dpd: number;
  verifiedAt?: string;
}
```

## Settlement record

```ts
interface SettlementRecord {
  id: string; // "STL-001"
  debtorName: string;
  loanId: string;
  outstanding: number;
  settlementAmount: number;
  waiver: number; // percentage
  date: string;
  status: "approved" | "pending_approval" | "rejected";
  approvedBy?: string;
  agentName: string;
  reason: string;
}
```

## Message / campaign record

```ts
interface Campaign {
  id: string;
  debtorName: string;
  loanId: string;
  phone: string;
  outstanding: number;
  dpd: number;
  language: string;
  channel: "whatsapp" | "sms" | "ivr";
  status: "completed" | "pending" | "dropped" | "escalated" | "opted_out";
  lastMsg: string; // preview of last message
  lastActivity: string;
  messageCount: number;
  deliveryStatus: "delivered" | "read" | "failed" | "pending";
  aiHandled: boolean;
}
```

## Agent status

```ts
type AgentStatus = "available" | "break" | "lunch" | "training" | "offline";
```

## Daily targets (set by manager per agent)

```ts
interface DailyTargets {
  calls: { target: number; actual: number; unit: "calls" };
  ptpCount: { target: number; actual: number; unit: "PTPs" };
  ptpAmount: { target: number; actual: number; unit: "₹" };
  collections: { target: number; actual: number; unit: "₹" };
  talkTime: { target: number; actual: number; unit: "min" };
  contactRate: { target: number; actual: number; unit: "%" };
}
```
