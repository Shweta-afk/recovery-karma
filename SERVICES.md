# RecoveryAI — APIs & Services Reference

Complete list of all services currently used, their alternatives, and which are critical vs. optional.

---

## 1. DATABASE & AUTH

### Current: **Supabase** ✅
- **What it does:** PostgreSQL database + Auth + Real-time subscriptions
- **Cost:** Free tier up to 500 MB storage + 2 GB bandwidth/month
- **Env vars:**
  - `VITE_SUPABASE_URL` (client, baked into bundle)
  - `VITE_SUPABASE_ANON_KEY` (client, baked into bundle)
  - `SUPABASE_URL` (server-only)
  - `SUPABASE_SERVICE_ROLE_KEY` (server-only, for admin operations)
- **Why it:** Built-in auth, RLS (row-level security), real-time subscriptions, easy to scale

### Alternatives to Supabase:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **Firebase (Google)** | Easy setup, good mobile integration, built-in auth | Vendor lock-in, less flexible RLS, no easy raw SQL | Free tier limited, ~$25/month for production |
| **MongoDB Atlas + Auth0** | Flexible schema, powerful aggregations, mature auth | No RLS built-in (need middleware), more setup | MongoDB free tier limited, Auth0 free tier OK |
| **PostgreSQL (self-hosted)** | Full control, powerful, RLS native | Need to manage infrastructure, backups, scaling | ~$5-20/month VPS + hosting |
| **PlanetScale (MySQL)** | MySQL compatible, easy scaling, affordable | Less strict than Postgres for data integrity | Free tier OK, pay-as-you-go after |
| **Neon (Postgres)** | Similar to Supabase but focused on Postgres | Less auth features built-in | Free tier OK, $7/month baseline |
| **AWS RDS + Cognito** | Enterprise-scale, very flexible, AWS ecosystem | Complex setup, steeper learning curve | Varies, typically $15-50+/month |

**🔴 CRITICAL:** Don't replace without migration plan (schema + seed data must move intact).

---

## 2. AI & LLM

### Current: **Anthropic Claude** ✅
- **What it does:** AI-powered debtor scoring (likelihood to pay)
- **Model:** `claude-opus-4-8` (latest, most capable)
- **Env var:** `ANTHROPIC_API_KEY`
- **Usage:** Score each debtor on 1-10 scale + reasoning
- **Cost:** ~$15 per 1M input tokens, ~$60 per 1M output tokens
  - Estimate: 100 debtors × 500 chars = 50KB ≈ $0.75/scoring run
- **Why it:** Best-in-class reasoning, handles Indian context well

### Alternatives:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **OpenAI GPT-4o** | Fast, popular, good API | Can be pricier for large batches | $15/1M input, $60/1M output |
| **Google Gemini** | Competitive pricing, multimodal | Less proven for reasoning tasks | $1.50/1M tokens (input), varies (output) |
| **Llama 3.1 (Meta)** | Open source, can self-host | Needs GPU, less reasoning power than Claude | Free (self-hosted) or ~$0.20-0.50/1K tokens |
| **Mixtral (Mistral)** | Efficient, good for cost | Smaller context window | ~$0.14/1M tokens input |
| **Local LLM (Ollama)** | No API costs, private | Slow on CPU, needs GPU, quality varies | Free but infrastructure cost |
| **No AI scoring** | Simplify, reduce costs | Less intelligent call prioritization | $0 but worse UX |

**💛 OPTIONAL:** Scoring improves UX but agents can still work without it (manual prioritization).

---

## 3. MESSAGING (WhatsApp, SMS, Email)

### Current: **Interakt** (WhatsApp) ✅
- **What it does:** Send WhatsApp messages to debtors at scale
- **Env var:** `INTERAKT_API_KEY`
- **Cost:** ~₹0.50-2 per message (pay-as-you-go)
- **Use case:** Send payment links, reminders, PTP confirmations via WhatsApp
- **Why it:** India-focused, good for WhatsApp, built-in template support
- **Webhook:** Can set up to receive inbound messages

### Alternatives for WhatsApp:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **Twilio** | Industry standard, SMS + WhatsApp unified | Pricier (₹2-5/msg), higher volume minimums | ~$0.05 SMS, ~₹1.50 WhatsApp |
| **MessageBird** | Global reach, SMS + WhatsApp | EU-focused, similar cost to Twilio | ~₹1-3/msg |
| **Sinch** | Good for India, SMS + WhatsApp | Less popular for WhatsApp in India | Competitive pricing |
| **Gupshup** | India-focused, WhatsApp + SMS | Smaller than Twilio | ~₹0.30-1/msg |
| **AWS SNS** | Unified with AWS ecosystem | Not great for WhatsApp | Variable, typically $0.50-1/msg |
| **No WhatsApp** | Reduce costs | No messaging channel (only email/SMS) | $0 |

**🟡 MODERATE IMPORTANCE:** WhatsApp is key for debtor engagement but can fall back to SMS/Email if needed.

---

### SMS (Optional, not yet integrated)
No SMS provider currently set up. If needed:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **AWS SNS** | Simple, AWS ecosystem, cheap | Not India-optimized | $0.50-1 per SMS |
| **Exotel** | India-focused, DND compliant | Smaller than Twilio | ₹0.50-1.50/SMS |
| **Route Mobile** | India provider, compliant | Less global reach | ₹0.30-1/SMS |
| **Twilio** | Unified with WhatsApp | Pricier | $0.0075/SMS |

---

### Email (Optional, not yet integrated)
No email provider currently set up. If needed:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **SendGrid** | Industry standard, good deliverability | Overkill for recovery ops | Free tier: 100/day, $20+/month |
| **AWS SES** | Cheap, AWS integrated | Need to manage sender reputation | $0.10 per 1K emails |
| **Mailgun** | Developer-friendly, good APIs | Less adoption | Free tier: 30 days trial, then $35/month |
| **Transactional email (Brevo)** | Cheap, good SMTP support | Smaller | Free tier: 300/day |

---

## 4. PAYMENTS (Razorpay)

### Current: **Razorpay** ✅
- **What it does:** Generate payment links, collect payments from debtors
- **Env vars:**
  - `RAZORPAY_KEY_ID`
  - `RAZORPAY_KEY_SECRET`
- **Cost:** 1.19% + ₹0 per transaction (no fixed fees for collections)
- **Channels:** UPI, card, netbanking, wallet
- **Use case:** Generate payment link → send via WhatsApp → debtor pays → auto-settled
- **Why it:** India's #1 payment gateway, best UX for collections

### Alternatives:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **PayU** | Established, good for collections | Older UI, sometimes slower | 1.5-2.99% + fees |
| **CCAvenue** | 15+ payment methods, Rupay | Corporate-heavy setup | 1.7-3% |
| **Instamojo** | Simple integration, good for SMBs | Lower transaction limits | 0.95% (cards) + ₹15 fixed |
| **Cashfree** | Modern UI, fast payouts | Smaller than Razorpay | 0.95-1.95% |
| **Google Pay for Business** | Zero fees within GPay ecosystem | Limited to GPay users | Free |
| **No payment links** | Reduce complexity | Manual bank transfers only | $0 but lower collection rate |

**🔴 CRITICAL:** Payments are core to the business. Razorpay is the best choice for India.

---

## 5. VOICE BOT (ElevenLabs) - Planned, Not Yet Used

### Current: **ElevenLabs** (planned for voice calls)
- **What it does:** AI-generated voice calls to uncontactable debtors
- **Env vars:**
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_VOICE_ID`
- **Cost:** ~$0.30 per 1000 characters (voice generation)
- **Use case:** Auto-call debtors with payment reminders, collect promises
- **Why it:** Best voice quality, natural-sounding, multilingual
- **Status:** Not yet integrated (Phase 3 feature)

### Alternatives:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **Google Cloud Text-to-Speech** | Good quality, multilingual, reliable | Less natural than ElevenLabs | $16/1M chars |
| **AWS Polly** | AWS ecosystem, cost-effective | Quality not as good as ElevenLabs | $16/1M chars |
| **Twilio** | Voice API + SMS unified | Expensive for voice only | $0.012/min call + $0.03/min TTS |
| **Vonage (Nexmo)** | Full voice/SMS stack | Similar pricing to Twilio | Variable |
| **OpenAI TTS** | New, natural-sounding | Limited voice options | $0.015/1K tokens input |
| **PlayHT** | Affordable, good voices | Smaller than ElevenLabs | ~$6/month starter |
| **No voice bot** | Reduce complexity | Agents must call manually | $0 |

**💛 OPTIONAL:** Voice bot is a nice-to-have for scaling. Phone calls by agents are the current primary channel.

---

## 6. HOSTING & DEPLOYMENT

### Current: **Render** ✅
- **What it does:** Host the web app (Node.js server + static frontend)
- **Plan:** Starter (free tier with limitations, $7+/month for production)
- **Region:** Singapore
- **Build:** `bun install && bun run build`
- **Start:** `node .output/server/index.mjs`
- **Cost:** Free tier OK for dev, ~$7-15/month for production
- **Why it:** Simple, supports bun natively, easy env var management

### Alternatives:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **Vercel** | Next.js native, excellent DX, global CDN | Overkill for this stack (TanStack Start isn't Next.js) | Free tier limited, $20+/month |
| **Netlify** | Easy static + serverless | Not ideal for Node backend | Free tier OK, $19+/month pro |
| **Railway** | Simple, pay-as-you-go, good UX | Newer platform, less proven | $0.30/hour (~$5/month baseline) |
| **Fly.io** | Good Docker support, auto-scaling | Learning curve steeper | $5/month baseline |
| **AWS App Runner** | AWS ecosystem, auto-scaling | Complex setup, console-heavy | $0.005/hour (~$5/month) |
| **Heroku** | Simple but old | Expensive now, dyno pricing changed | $7/month minimum (Nov 2022 changes) |
| **Docker (VPS like Linode/Hetzner)** | Full control, cheaper at scale | Need to manage deployment, SSL, updates | $5-20/month VPS |
| **Self-hosted on EC2** | Max control, can optimize | DevOps headache | $5-50/month depending on traffic |

**🟡 MODERATE:** Render is fine, but Vercel or Railway might be simpler if switching.

---

## 7. ANALYTICS & MONITORING (Not Yet Used)

### Options (recommended to add):

| Service | Purpose | Pricing | When to Add |
|---------|---------|---------|-------------|
| **Sentry** | Error tracking, crash reporting | Free tier: 5K events/month | Phase 2 (after core features work) |
| **PostHog** | Product analytics, user behavior | Free tier OK, $29+/month pro | Phase 3 (understand agent usage) |
| **LogRocket** | Session replay, bug reproduction | $99+/month, no free tier | Later (if needed) |
| **Axiom** | Structured logging | $50/month or pay-as-you-go | Phase 2 (debug in prod) |
| **CloudFlare Web Analytics** | Page views, traffic patterns | Free | Easy add-on anytime |

**💛 OPTIONAL:** Not critical now, but should add error tracking (Sentry) before production.

---

## 8. DOCUMENT & FORM STORAGE (Optional)

If you want to store debtor PDFs, KYC docs, etc.:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **AWS S3** | Industry standard, cheap, durable | Setup complexity | $0.023/GB stored, $0.0004/1K GET |
| **Supabase Storage** | Built into Supabase, simple | Limited to Supabase plan | Included in Supabase bill |
| **Cloudinary** | Image optimization, CDN | Overkill for documents | Free tier OK, $99+/month pro |
| **Firebase Storage** | Google ecosystem, simple | Vendor lock-in | Included in Firestore/Realtime DB bill |
| **Backblaze B2** | Cheap, S3-compatible | Smaller than AWS | $0.006/GB stored |

**💛 OPTIONAL:** Only needed if you have KYC/document workflows.

---

## 9. CALL RECORDING & STORAGE (Optional)

If you want to record agent-debtor calls:

| Service | Pros | Cons | Pricing |
|---------|------|------|---------|
| **Twilio Recordings** | Integrated with Twilio voice | Twilio must be your VoIP provider | ~$0.50/1K minutes |
| **AWS Chime SDK** | AWS ecosystem, supports recording | Setup complexity | ~$0.50/1K minutes |
| **YouTube (unlisted)** | Free, unlimited, easy | Overkill, privacy concerns | Free |
| **S3 + ffmpeg** | Cheap, full control | Manual setup | ~$0.023/GB |

**💛 OPTIONAL:** Not in current scope, but useful for training agents.

---

## Summary: What's Critical vs. Nice-to-Have

### 🔴 CRITICAL (do not remove)
- **Supabase** — Database, auth, core data store
- **Razorpay** — Payments (core business function)

### 🟡 MODERATE (important for UX)
- **Anthropic Claude** — AI scoring (improves call prioritization)
- **Interakt** — WhatsApp (key channel for debtor engagement)
- **Render** — Hosting (app must run somewhere)

### 💛 OPTIONAL (nice-to-have)
- **ElevenLabs** — Voice bot (lower priority, can add later)
- **SMS** — Fallback if WhatsApp fails
- **Email** — Extra channel
- **Sentry** — Error tracking (add before production)
- **Analytics** — PostHog (understand usage patterns)
- **Storage** — Document/recording storage

---

## Cost Estimate (Monthly, Production)

| Service | Monthly Cost |
|---------|--------------|
| Supabase (Postgres) | $25 (pro tier) |
| Anthropic (100 scorings/day) | $25 |
| Interakt (1000 messages/month) | $20 |
| Razorpay (1% of collections) | Variable (~₹5K for ₹500K collected) |
| Render | $7-15 |
| **Total (base)** | **~$75-90** |
| + SMS (optional) | $10-20 |
| + Email (optional) | $10-20 |
| + Sentry (error tracking) | $29 |
| **Total with extras** | **~$125-160** |

---

## Migration Playbook (if you change services)

### Changing database (e.g., Supabase → Firebase)?
1. Export all data from Supabase (JSON dumps)
2. Transform schema to match new DB
3. Import to new DB
4. Update `src/lib/supabase.ts` → new client library
5. Test all queries
6. Gradual traffic cut-over (10% → 50% → 100%)

### Changing payments (e.g., Razorpay → PayU)?
1. Keep both services running in parallel
2. New payment links go to PayU, old ones still work via Razorpay
3. After 30 days, disable Razorpay
4. Update `src/lib/server/razorpay-actions.ts` → new provider

### Changing AI (e.g., Claude → GPT-4)?
1. Update `src/lib/server/ai-scoring.ts`
2. Score test batch with both models
3. Compare results, pick winner
4. Gradually re-score all debtors

---

## Recommendations

**For MVP (now):** Keep Supabase + Razorpay + Anthropic + Interakt. This is the optimal stack for India collections.

**For beta (next month):** Add Sentry for error tracking.

**For scale (3+ months):** Consider SMS backup + ElevenLabs voice bot + analytics.

**Never change:** Supabase (too much data), Razorpay (core business).

