# RecoveryAI — Project Context

## What this is

RecoveryAI is a debt-collections platform for call-centre agents and managers. It handles a portfolio of debtors (uploaded via Excel), lets agents make and log calls, track PTPs and payments, escalate disputes, and gives managers a portfolio-level view.

## User roles

| Role    | Entry route  | What they do                                                                       |
| ------- | ------------ | ---------------------------------------------------------------------------------- |
| Agent   | `/dashboard` | Work the call queue, log outcomes, view debtor profiles, track their daily targets |
| Manager | `/manager`   | Upload portfolios, assign accounts, audit calls, view team performance             |
| Admin   | `/admin`     | Platform-level settings, portfolio management                                      |

## Tech stack

- **Framework**: TanStack Start (SSR) + TanStack Router (file-based routing)
- **UI**: React 18 + TypeScript, Tailwind CSS, shadcn/ui components
- **State**: Local `useState` per route — no global store
- **Build / dev**: Vite (port 8080), `bun run dev`
- **Deploy**: Cloudflare Workers (`wrangler`)
- **DB**: Cloudflare D1 (SQLite at the edge); Supabase used in some auth flows
- **Auth**: Server-side session check in `src/lib/auth.tsx`

## Key conventions

- Route files live in `src/routes/`. Nested routes use dot-notation (`dashboard.call-queue.tsx`).
- `routeTree.gen.ts` is auto-generated — never edit it by hand.
- All mock/demo data (debtor portfolios, calls, payments) lives in `src/lib/mock-debtors.ts`. Real data flows through D1 via `src/lib/fetch-debtors.ts`.
- Monetary values stored as integers (paise/rupees as-is); displayed via `formatINR()` from `mock-debtors.ts`.
- `cn()` from `src/lib/utils.ts` is used for conditional classnames throughout.
- Sidebar collapse uses `collapsible="offcanvas"` on the shadcn Sidebar component.
- Scroll-isolated tables use `max-h-[Npx] overflow-auto` + `sticky top-0 bg-card z-10` on the header.

## Colour system

Semantic colours only — no raw hex. Opacity-modulated for muted professional tone:

- **Success (green)**: confirmed, paid, PTP kept → `bg-success/8 text-success/70 border-success/15`
- **Warning (amber)**: pending, callback → `bg-warning/8 text-warning-foreground/70 border-warning/15`
- **Destructive (red)**: bounced, refused, high DPD → `bg-destructive/8 text-destructive/70 border-destructive/15`
- **Blue**: PTP promised, partial → `bg-blue-500/8 text-blue-500/70 border-blue-400/15`
- **Teal**: settlement → `bg-teal-500/8 text-teal-600/70 border-teal-400/15`
- **Orange**: dispute → `bg-orange-500/8 text-orange-600/70 border-orange-400/15`
- **Violet**: AI-handled items → `bg-violet-500/8 text-violet-500/70 border-violet-400/15`

Never use bright solid colour badges. Interactive buttons (call start, submit) may use solid `bg-success` or `bg-destructive`.
