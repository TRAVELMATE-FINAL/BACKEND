# Keep-Alive Setup — Stop Render Free Tier From Sleeping

Render's free tier spins your service down after **~15 minutes of inactivity**.
The first request after that takes 30–60 seconds (the cold start), which makes
the app feel broken to users.

We use **two layers** of keep-alive — set up both for maximum reliability.

---

## Layer 1 — Internal self-ping (already wired)

The server's `server.js` runs `startSelfPing()` on boot. While the server is
running, it pings its own `/health` endpoint every 10 minutes.

**To enable**, set this env var on Render:

| Key | Value |
|-----|-------|
| `SELF_URL` | `https://travelmate-backend-dzpq.onrender.com` |

Render Dashboard → travelmate-backend → **Environment** → **Add Environment
Variable** → Save Changes (Render auto-redeploys).

After redeploy, check the Logs tab — you should see:
```
Self-ping enabled -> https://travelmate-backend-dzpq.onrender.com/health (every 10 min)
self-ping https://travelmate-backend-dzpq.onrender.com/health -> 200
```

> ⚠️ **Self-ping alone is not enough.** If the server has already spun down,
> it can't ping itself. That's why we also need Layer 2.

---

## Layer 2 — External pinger (the real fix)

Use **one** of these options. GitHub Actions is the easiest because the
workflow file is already in this repo at
`.github/workflows/keep-alive.yml`.

### Option A — GitHub Actions cron (recommended, free, zero setup)

1. Push this repo to GitHub (if not already).
2. The workflow `.github/workflows/keep-alive.yml` runs **every 10 minutes**
   automatically — no further setup.
3. To confirm it's working:
   - Open your repo on GitHub → **Actions** tab
   - You should see "Keep TravelMate backend awake" runs every 10 minutes
   - Click any run → confirm it shows `HTTP 200`

**Caveats:**
- GitHub may delay scheduled runs by 5–15 minutes during high load. The
  worst case (15-min delay + 10-min schedule = 25 min) might still allow
  Render to sleep briefly. In practice it works fine for almost all use
  cases.

### Option B — UptimeRobot (free, browser-based)

1. Sign up at **https://uptimerobot.com** (free, no credit card)
2. Click **Add New Monitor**
3. Settings:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** TravelMate backend
   - **URL:** `https://travelmate-backend-dzpq.onrender.com/health`
   - **Monitoring Interval:** 5 minutes
4. Save. UptimeRobot now pings every 5 minutes, well below Render's
   15-min sleep threshold.

### Option C — cron-job.org (free, even simpler)

1. Sign up at **https://cron-job.org**
2. Create new cronjob:
   - **URL:** `https://travelmate-backend-dzpq.onrender.com/health`
   - **Schedule:** Every 10 minutes
3. Save and enable.

---

## Verification

After both layers are running:

1. Wait 20 minutes (longer than Render's sleep timeout).
2. Hit `https://travelmate-backend-dzpq.onrender.com/` in your browser.
3. It should respond **instantly** (sub-second), not after a 30s cold start.

If it's still slow:
- Check Render Logs for `self-ping ... -> 200` messages — if missing, the
  `SELF_URL` env var isn't set.
- Check GitHub Actions → keep-alive workflow → recent runs are succeeding.

---

## Upgrading to a paid tier (the real real fix)

The keep-alive trick works but is fragile. The proper fix is to upgrade
Render's plan to **Starter ($7/mo)**, which has no sleep timeout. Do this
once you start getting real users.
