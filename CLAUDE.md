# RecoveryAI — Project Context & Workflow

## Project Overview

**RecoveryAI** is an AI-powered collections platform for debt recovery agents. Agents call/message debtors, log outcomes, and the system prioritizes calls using AI scoring. Built with React + Vite + TanStack Start + Supabase.

**Status:** UI complete, all pages built with mock data. Core task: wire Supabase queries to replace mock data and implement server actions for real integrations.

---

## Architecture

### Tech Stack

- **Frontend:** React 19 + TanStack Router + TanStack Query (react-query)
- **Backend:** TanStack Start (uses nitro under the hood) + Node.js runtime
- **Database:** Supabase Postgres (prod) + Row-Level Security
- **Package manager:** bun
- **APIs:** Anthropic (AI scoring), Interakt (WhatsApp), Razorpay (payments), ElevenLabs (voice bot)

### Build & Deploy

- **Vite config:** Uses `@lovable.dev/vite-tanstack-config` with `nitro: { preset: "node" }`
- **Build output:** `dist/` (client) + `.output/server/` (nitro server)
- **Start command:** `node .output/server/index.mjs`
- **Deployment:** Railway (`railway.json`, nixpacks builder). Project `bubbly-communication`, service `recoveryai-app`. Custom domain `axiora.axiotta.com` is configured on the service (DNS on Cloudflare, `axiotta.com` zone) alongside the default `*.up.railway.app` domain.

### Database Schema (9 tables)

```
clients ← clients table (company_name, plan: starter/growth/scale)
  ├─ agents (auth_user_id, role: agent/manager/admin, daily_target)
  ├─ portfolios (lender_name, product_type, priority, total_accounts)
  └─ debtors (portfolio_id, assigned_agent_id, loan_amount, outstanding_balance, dpd, ai_score, status, etc.)
      ├─ call_logs (debtor_id, agent_id, outcome, promise_amount, duration_seconds, recording_url)
      ├─ messages (debtor_id, agent_id, channel: whatsapp/sms/email, content, status, razorpay_link_id)
      ├─ payments (debtor_id, agent_id, amount, razorpay_payment_id, status, payment_type)
      ├─ disputes (debtor_id, raised_by, dispute_type, status: open/resolved/escalated_legal)
      └─ settlement_requests (debtor_id, requested_by, proposed_amount, status: pending_manager/approved/rejected)
```

**RLS:** All tables have `auth_client_id()` function scoping — agents see only their client's data.

**Seed data:** `src/supabase/seed.sql` pre-populates 100+ debtors across multiple portfolios.

---

## Current State: What's Built & What's Mocked

### ✅ Complete (no changes needed)

- **Schema + seed data** — 9 tables with 100+ debtors in Supabase
- **Auth** — Login page + role-based access (agent/manager/admin)
- **App shell** — Sidebar, routes, TanStack Router wired
- **UI pages** — All visual layouts done:
  - `dashboard/` (Call Queue) — table with sorting/filtering
  - `dashboard/debtors` — card grid + profile sheet
  - `dashboard/messages` — chat UI (WhatsApp/SMS/Email)
  - `dashboard/payments` — payment links table + dialog
  - `dashboard/reports` — charts (placeholder)
  - `admin/` — portfolio upload, agent management tiles
  - `login` — form with email/password

### 🟡 Partial (built but reads from mock)

All pages read from `lib/mock-debtors.ts` instead of Supabase. **This is the main blocker.**

---

## Workflow: Wire Supabase Data & Server Actions

### Phase 1 — Replace Mock with Real Data (Priority 1)

#### Step 1.1: Create query hooks (`src/lib/queries.ts`)

This file centralizes all Supabase queries. Use TanStack Query for caching + refetching.

```typescript
// src/lib/queries.ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Debtor, CallLog } from "./types"; // types.ts holds exported types

export function useDebtors(filters?: { portfolio_id?: string; status?: string }) {
  return useQuery({
    queryKey: ["debtors", filters],
    queryFn: async () => {
      let query = supabase
        .from("debtors")
        .select(
          `
          id, name, phone_primary, phone_alternate, email,
          loan_amount, outstanding_balance, dpd, ai_score, ai_score_reason,
          status, last_contacted_at, portfolio_id,
          portfolios(name), agents(name)
        `,
        )
        .limit(100);

      if (filters?.portfolio_id) query = query.eq("portfolio_id", filters.portfolio_id);
      if (filters?.status) query = query.eq("status", filters.status);

      const { data, error } = await query.order("ai_score", { ascending: false });
      if (error) throw error;
      return data as Debtor[];
    },
  });
}

export function useDebtor(id: string) {
  return useQuery({
    queryKey: ["debtor", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("debtors").select("*").eq("id", id).single();
      if (error) throw error;
      return data as Debtor;
    },
  });
}

export function useCallLogsForDebtor(debtorId: string) {
  return useQuery({
    queryKey: ["callLogs", debtorId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("call_logs")
        .select("*, agents(name)")
        .eq("debtor_id", debtorId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as CallLog[];
    },
  });
}

export function useCallLogsToday(agentId?: string) {
  return useQuery({
    queryKey: ["callLogsToday", agentId],
    queryFn: async () => {
      const today = new Date().toISOString().split("T")[0];
      let query = supabase
        .from("call_logs")
        .select("outcome")
        .gte("created_at", `${today}T00:00:00`);

      if (agentId) query = query.eq("agent_id", agentId);

      const { data, error } = await query;
      if (error) throw error;

      // Compute stats
      const stats = {
        callsMade: data.length,
        outcomes: {
          paid: data.filter((d) => d.outcome === "paid").length,
          promised: data.filter((d) => d.outcome === "promised").length,
          refused: data.filter((d) => d.outcome === "refused").length,
          noAnswer: data.filter((d) => d.outcome === "no_answer").length,
        },
      };
      return stats;
    },
  });
}

export function useMessagesForDebtor(debtorId: string) {
  return useQuery({
    queryKey: ["messages", debtorId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("debtor_id", debtorId)
        .order("sent_at", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function usePaymentsForDebtor(debtorId: string) {
  return useQuery({
    queryKey: ["payments", debtorId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("debtor_id", debtorId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useDisputesForDebtor(debtorId: string) {
  return useQuery({
    queryKey: ["disputes", debtorId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("disputes")
        .select("*")
        .eq("debtor_id", debtorId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}
```

#### Step 1.2: Update Call Queue (`dashboard/index.tsx`)

Replace mock data with real queries:

```typescript
import { useDebtors, useCallLogsToday } from "@/lib/queries";

function DashboardPage() {
  const { data: debtors = [], isLoading } = useDebtors();
  const { data: todayStats } = useCallLogsToday();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = debtors.filter((d) => {
      if (bucket !== "all" && bucketOf(d.dpd) !== bucket) return false;
      if (portfolio !== "all" && d.portfolio_id !== portfolio) return false;
      if (q && !d.name.toLowerCase().includes(q)) return false;
      return true;
    });
    // sort, etc.
    return rows;
  }, [debtors, search, bucket, portfolio, sortKey, sortDir]);

  if (isLoading) return <LoadingSkeleton />;

  return (
    <div className="space-y-6">
      {/* stats with todayStats instead of TODAY_STATS */}
      <StatCard value={todayStats?.callsMade ?? 0} />
      {/* table with filtered debtors */}
      <Table>{/* rows from filtered */}</Table>
    </div>
  );
}
```

#### Step 1.3: Update Debtor Profiles (`dashboard/debtors`)

```typescript
import { useDebtor, useCallLogsForDebtor, useMessagesForDebtor, usePaymentsForDebtor, useDisputesForDebtor } from "@/lib/queries";

function DebtorProfile({ debtorId }: { debtorId: string }) {
  const { data: debtor } = useDebtor(debtorId);
  const { data: callLogs = [] } = useCallLogsForDebtor(debtorId);
  const { data: messages = [] } = useMessagesForDebtor(debtorId);
  const { data: payments = [] } = usePaymentsForDebtor(debtorId);
  const { data: disputes = [] } = useDisputesForDebtor(debtorId);

  return (
    <Sheet>
      {/* Use debtor, callLogs, messages, payments, disputes instead of EXTRA[id] mock */}
      <TabsContent value="calls">
        {callLogs.map((log) => (
          <CallLogEntry key={log.id} log={log} />
        ))}
      </TabsContent>
      {/* etc. for messages, payments, disputes */}
    </Sheet>
  );
}
```

---

### Phase 2 — Server Actions for Creating/Updating Data (Priority 2)

Server actions use TanStack Server Functions. Create actions in `src/` or colocate near routes.

#### Step 2.1: Log Call Outcome

```typescript
// src/lib/server/call-actions.ts (server-only)
import { createServerFn } from "@tanstack/react-start";
import { supabase } from "../supabase";

export const logCallOutcome = createServerFn({ method: "POST" })(async ({
  debtorId,
  agentId,
  outcome,
  promiseAmount,
  promiseDate,
  durationSeconds,
  notes,
}: {
  debtorId: string;
  agentId: string;
  outcome: "paid" | "promised" | "refused" | "no_answer" | "callback" | "escalated";
  promiseAmount?: number;
  promiseDate?: string;
  durationSeconds?: number;
  notes?: string;
}) => {
  const { data, error } = await supabase.from("call_logs").insert({
    debtor_id: debtorId,
    agent_id: agentId,
    outcome,
    promise_amount: promiseAmount,
    promise_date: promiseDate,
    duration_seconds: durationSeconds,
    raw_notes: notes,
  });

  if (error) throw error;
  return data;
});
```

Call from component:

```typescript
const [isPending, startTransition] = useTransition();

const handleLogCall = () => {
  startTransition(async () => {
    await logCallOutcome({
      debtorId: debtor.id,
      agentId: currentUser.id,
      outcome: "promised",
      promiseAmount: 8000,
      promiseDate: "2026-06-25",
      notes: "Will pay by EOD tomorrow",
    });
    toast.success("Call logged");
  });
};
```

#### Step 2.2: Send WhatsApp via Interakt

```typescript
// src/lib/server/interakt-actions.ts
import { createServerFn } from "@tanstack/react-start";
import { supabase } from "../supabase";

const INTERAKT_API_KEY = process.env.INTERAKT_API_KEY;
const INTERAKT_API_URL = "https://api.interakt.ai/v1/messages";

export const sendWhatsApp = createServerFn({ method: "POST" })(async ({
  debtorId,
  agentId,
  phoneNumber,
  message,
  paymentLink,
}: {
  debtorId: string;
  agentId: string;
  phoneNumber: string;
  message: string;
  paymentLink?: string;
}) => {
  // 1. Send to Interakt API
  const response = await fetch(INTERAKT_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INTERAKT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone: phoneNumber,
      message: message + (paymentLink ? `\n\n${paymentLink}` : ""),
      type: "template",
    }),
  });

  if (!response.ok) {
    throw new Error(`Interakt API error: ${response.statusText}`);
  }

  const result = await response.json();

  // 2. Log to messages table
  const { data, error } = await supabase.from("messages").insert({
    debtor_id: debtorId,
    agent_id: agentId,
    channel: "whatsapp",
    direction: "outbound",
    content: message,
    status: "sent",
    payment_link_url: paymentLink,
  });

  if (error) throw error;
  return data;
});
```

#### Step 2.3: Create Razorpay Payment Link

```typescript
// src/lib/server/razorpay-actions.ts
import { createServerFn } from "@tanstack/react-start";
import { supabase } from "../supabase";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_API_URL = "https://api.razorpay.com/v1/payment_links";

export const createPaymentLink = createServerFn({ method: "POST" })(async ({
  debtorId,
  agentId,
  amount,
  debtor,
}: {
  debtorId: string;
  agentId: string;
  amount: number;
  debtor: { name: string; phone_primary: string };
}) => {
  // 1. Create link in Razorpay
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch(RAZORPAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amount * 100, // convert to paise
      currency: "INR",
      accept_partial: true,
      customer_notify: 1,
      notify: { sms: true, email: false },
      reference_id: debtorId,
      description: `Payment for ${debtor.name}`,
      contact: debtor.phone_primary,
    }),
  });

  if (!response.ok) {
    throw new Error(`Razorpay API error: ${response.statusText}`);
  }

  const result = await response.json();

  // 2. Record in payments table
  const { data, error } = await supabase.from("payments").insert({
    debtor_id: debtorId,
    agent_id: agentId,
    amount,
    razorpay_link_id: result.id,
    status: "pending",
    payment_type: "full",
  });

  if (error) throw error;

  return {
    paymentLinkId: result.id,
    paymentUrl: result.short_url,
  };
});
```

---

### Phase 3 — AI Scoring (Priority 3)

Score debtors using Anthropic API when portfolio is uploaded or as a batch job.

```typescript
// src/lib/server/ai-scoring.ts
import { createServerFn } from "@tanstack/react-start";
import { supabase } from "../supabase";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const scoreDebtor = createServerFn({ method: "POST" })(async (debtor: {
  id: string;
  name: string;
  dpd: number;
  outstanding_balance: number;
  loan_amount: number;
  email?: string;
  phone_primary: string;
}) => {
  const prompt = `Score this debtor on a scale of 1-10 for likelihood to pay. Consider:
- DPD (Days Past Due): ${debtor.dpd} days
- Outstanding: ₹${debtor.outstanding_balance}
- Loan amount: ₹${debtor.loan_amount}
- Contact available: ${debtor.email ? "email + " : ""}phone

Return JSON: { "score": <1-10>, "reason": "<one-liner reason>" }`;

  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const parsed = JSON.parse(text);

  // Update debtors table
  const { error } = await supabase
    .from("debtors")
    .update({
      ai_score: parsed.score,
      ai_score_reason: parsed.reason,
      score_updated_at: new Date().toISOString(),
    })
    .eq("id", debtor.id);

  if (error) throw error;
  return parsed;
});
```

---

## Development Workflow

### Local Setup

```bash
cd ~/recovery-karma-main
bun install
bun run dev
```

Opens http://localhost:5173 with hot reload.

### Testing Data Changes

1. Make changes to `lib/queries.ts` or component
2. HMR reloads automatically
3. Open DevTools → Network tab to see Supabase API calls
4. RLS errors appear in console if auth is wrong

### Supabase Console

- **URL:** https://supabase.com/dashboard → select your project
- **SQL Editor:** Run queries to verify seed data
- **Auth Users:** See login credentials in Auth → Users
- **Logs:** Real-time query logs under Logs

---

## Deployment to Railway

### Pre-deploy checklist

1. ✅ railway.json at root (`builder: nixpacks`, start command, healthcheck)
2. ✅ package.json has `"start": "node .output/server/index.mjs"`
3. ✅ .env.example has all env vars (VITE_SUPABASE_URL, ANTHROPIC_API_KEY, etc.)
4. ✅ .gitignore ignores .env but not .env.example

### Steps

1. `git push origin main` (service auto-deploys on push to `main`, GitHub repo `Shweta-afk/recovery-karma`)
2. Go to https://railway.com/dashboard → project `bubbly-communication` → service `recoveryai-app`
3. Set env vars under the service's Variables tab (copy values from local .env)
4. Test on the generated `*.up.railway.app` URL, or the custom domain once DNS is verified

### Custom domain (e.g. `axiora.axiotta.com`)

1. In Railway: service → Settings → Networking → **Custom Domain** → enter the domain, select the detected port, Add Domain
2. Railway shows a CNAME + TXT record to add. Add both **exactly as shown** in Cloudflare DNS (zone = the domain's registrar/DNS provider), with the CNAME set to **DNS only** (grey cloud, not proxied) — Railway needs direct traffic to issue the Let's Encrypt cert
3. Wait for Railway to mark the domain as verified/active (cert issuance can take a few minutes up to ~an hour)
4. Free Railway plans have a **custom domain limit per service** — if you hit it, either remove an unused domain or upgrade the plan before adding another

---

## Key Files to Know

| File                         | Purpose                                      |
| ---------------------------- | -------------------------------------------- |
| `vite.config.ts`             | Build config with nitro node preset          |
| `src/lib/supabase.ts`        | Supabase client init                         |
| `src/lib/queries.ts`         | ← **CREATE THIS** — TanStack Query hooks     |
| `src/lib/server/*.ts`        | ← **CREATE THESE** — Server actions for APIs |
| `src/routes/dashboard/*.tsx` | Pages that need query wiring                 |
| `src/routes/login.tsx`       | Auth entry point                             |
| `src/supabase/schema.sql`    | DB schema (reference only)                   |
| `src/supabase/seed.sql`      | Seed data (ran once)                         |
| `railway.json`               | Railway deployment config                    |
| `.env.example`               | Template for env vars                        |

---

## Common Patterns

### Fetch + Display

```typescript
const { data: items = [], isLoading, error } = useQuery(...);
if (isLoading) return <Skeleton />;
if (error) return <ErrorAlert />;
return items.map((item) => <Item key={item.id} {...item} />);
```

### Call a Server Action

```typescript
const [isPending, startTransition] = useTransition();
startTransition(async () => {
  const result = await myServerAction({ ...data });
  toast.success("Done");
});
```

### Refetch After Mutation

```typescript
const queryClient = useQueryClient();
await logCallOutcome({ ... });
queryClient.invalidateQueries({ queryKey: ["callLogs"] }); // auto-refetch
```

---

## Next Immediate Steps (Do in order)

1. **Create `src/lib/queries.ts`** with all hooks (copy-paste from Phase 1.1 above)
2. **Create `src/lib/types.ts`** with TypeScript interfaces for Debtor, CallLog, etc.
3. **Update `dashboard/index.tsx`** to use `useDebtors()` instead of MOCK_DEBTORS
4. **Test in browser** — should show real debtors from seed data
5. **Apply same pattern to all other pages** (debtors, messages, payments, etc.)
6. **Create server actions** in `src/lib/server/` for call logging, WhatsApp, Razorpay
7. **Wire server actions to components** (call button, send message button, etc.)
8. **Test with real Interakt/Razorpay credentials** (or sandbox)
9. **Push to GitHub** — Railway auto-deploys on push to `main`

---

## Notes

- **Supabase RLS:** All queries automatically filter by auth user's client_id via the `auth_client_id()` function in policies. No manual client filtering needed.
- **VITE\_\* vars:** Baked into client bundle at build time. Must be set before `bun run build`.
- **TanStack Start:** Feels like Next.js but uses nitro. Server functions are always `/api/[path]`, no route configuration needed.
- **Mock data:** Delete `lib/mock-debtors.ts` once all pages are wired (not yet).
