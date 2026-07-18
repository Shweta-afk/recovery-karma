# RecoveryAI — Architecture

## Route tree

```
/                          → index.tsx           (landing / redirect)
/login                     → login.tsx
/dashboard/                → dashboard.index.tsx  (agent KPI dashboard)
/dashboard/call-queue      → dashboard.call-queue.tsx
/dashboard/debtors         → dashboard.debtors.tsx
/dashboard/payments        → dashboard.payments.tsx
/dashboard/messages        → dashboard.messages.tsx
/dashboard/reports         → dashboard.reports.tsx
/dashboard/settings        → dashboard.settings.tsx
/manager/                  → manager.index.tsx
/manager/upload            → manager.upload.tsx
/manager/portfolio         → manager.portfolio.tsx    (agent assignment / reassignment)
/manager/queue             → manager.queue.tsx        (per-agent live queues, manager's own queue)
/manager/channels          → manager.channels.tsx     (channel contribution reporting)
/manager/audit             → manager.audit.tsx
/admin/                    → admin.index.tsx
/admin/portfolio           → admin.portfolio.tsx
```

Layout wrappers: `dashboard.tsx`, `manager.tsx`, `admin.tsx` each render a sidebar + `<Outlet />`.

## Component layers

```
Route file (page logic + state)
  └─ shadcn/ui primitives   (Card, Table, Sheet, Dialog, Badge, etc.)
       └─ Tailwind classes
```

No shared page-level components outside route files. Reusable pieces (e.g. `DebtorProfileSheet`) are defined as functions within the route file that uses them — kept co-located to avoid premature abstraction.

## Active call architecture

Call state lives entirely in `dashboard.call-queue.tsx`:

```
CallPhase: "idle" | "ringing" | "connected" | "ended"
CallView:  "panel" | "modal"

startCall(debtor) → phase=ringing → setTimeout 3s → phase=connected
endCall()         → phase=ended   → disposition form opens
submitDisposition → logs call, optionally opens EscalationModal
```

- **Panel mode**: `fixed bottom-0 left-0 right-0 z-50` slide-up bar
- **Modal mode**: `<Dialog>` overlay — toggled mid-call without losing state

## Data flow

```
Excel upload (manager)
  → D1 database (Cloudflare)
    → fetch-debtors.ts (server loader)
      → Route component (mock-debtors.ts fallback in dev)
```

In production, `fetch-debtors.ts` queries D1. In development, `MOCK_DEBTORS` from `mock-debtors.ts` is used as a fallback so the UI works without a live database.

## Auth

Server-side session check in `src/lib/auth.tsx`. Each protected layout route (`dashboard.tsx`, `manager.tsx`, `admin.tsx`) calls the auth helper in its `loader` — redirects to `/login` on failure.

## Timers and intervals

`RecordingPlayer` and `ActiveCallContent` each own their own `setInterval` via `useRef` + `useEffect` cleanup. No shared timer context. Call duration is measured from `Date.now()` at connect time, not a global clock.
