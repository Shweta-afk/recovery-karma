# Railway Deployment Guide

RecoveryAI is configured to deploy on Railway.app for India-focused operations.

## Why Railway?

- ✅ **Always-on** — No spin-down (critical for webhooks from Razorpay, Interakt, Tata)
- ✅ **Better pricing** — ~$5/month vs Render's $7-12/month
- ✅ **Automatic scaling** — Pay for usage, no plan upgrades needed
- ✅ **Simple setup** — railway.json handles build/start commands

## Prerequisites

1. GitHub account (repo already pushed)
2. Railway account (sign up at railway.app)
3. All environment variables ready (from .env.example)

## Deployment Steps

### 1. Connect Repository

1. Go to https://railway.app/dashboard
2. Click **New Project** → **Deploy from GitHub repo**
3. Select `recovery-karma-main` repository
4. Railway auto-detects `railway.json` and starts build

### 2. Set Environment Variables

In Railway dashboard, go to **Variables** tab and add:

```
NODE_ENV=production
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
ANTHROPIC_API_KEY=sk-ant-...
INTERAKT_API_KEY=your-interakt-key
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=your-secret
ELEVENLABS_API_KEY=your-elevenlabs-key
ELEVENLABS_VOICE_ID=your-voice-id
TELEPHONY_PROVIDER=tata
TATA_ACCESS_TOKEN=your-tata-token
TATA_BASE_URL=https://api-smartflo.tatateleservices.com/v1
TATA_WEBHOOK_URL=https://your-railway-app.railway.app/api/telephony/webhook
VITE_APP_URL=https://your-railway-app.railway.app
```

**Get your Railway URL:** After first deploy, Railway assigns a URL like `https://recovery-karma-abc123.railway.app`. Use this for `TATA_WEBHOOK_URL` and `VITE_APP_URL`.

### 3. Deploy

- Railway auto-deploys on every `git push origin main`
- Watch build logs in dashboard (should take ~2-3 min)
- Once green, app is live at your Railway URL

### 4. Update Tata Webhook (if using telephony)

Once you have your Railway URL from step 2:

1. Update `TATA_WEBHOOK_URL` in Railway Variables to point to your live app
2. Notify your Tata account manager to update webhook endpoint on their side

## Monitoring

### View Logs

Dashboard → **Logs** tab (or use Railway CLI):

```bash
railway logs
```

### Check Health

Navigate to `https://your-app.railway.app/` — should load login page.

### Monitor Database

Supabase Console → Logs tab shows all queries in real-time.

## Scaling & Limits

- **Starter plan:** $5/month includes 512MB RAM
- **Auto-scaling:** If you exceed limits, Railway auto-upgrades (you pay for extra)
- **No spin-down:** App always running (unlike Render)
- **Backup strategy:** Use Supabase's automated backups

## Rollback to Render (Backup)

If issues arise, render.yaml is still configured. To revert:

1. Push to GitHub
2. Go to Render dashboard
3. Trigger manual deploy

Both platforms will stay in sync with git.

## Troubleshooting

### Build fails

Check **Build Logs** tab in Railway dashboard. Common issues:

- Missing env vars (check VITE_* vars are set)
- Node version mismatch (Railway uses latest Node, should be fine)

### App crashes after deploy

Check **Logs** tab for error messages. Most common:

- Supabase connection error → verify `VITE_SUPABASE_URL` and keys
- Missing API keys → add to Variables tab

### Webhooks not firing

- Verify `TATA_WEBHOOK_URL` matches your Railway domain
- Check Railway logs for incoming requests
- Confirm Tata account manager has updated their webhook config

## Useful Commands (Railway CLI)

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Link to your Railway project
railway link

# View live logs
railway logs

# Redeploy current branch
railway up

# Check service status
railway status
```

## Cost Estimate

- **Base:** $5/month (512MB RAM, always-on)
- **Bandwidth:** Free outbound (to your APIs)
- **Storage:** Use Supabase Storage for files/recordings
- **Max:** Scales automatically, typical max $20-30/month for small team

---

**Next steps:**
1. Set up Railway project
2. Add env vars from `.env.example`
3. Push to main → auto-deploy
4. Test login page
5. Update TATA_WEBHOOK_URL once you have live domain
