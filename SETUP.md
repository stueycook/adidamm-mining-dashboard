# Adidamm Mining Dashboard — Setup Guide

Live URL: `https://YOUR-USERNAME.github.io/adidamm-mining-dashboard`
Refreshes: 6:00 AM AEST every day (+ manual trigger anytime)

---

## Step 1 — Create the GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it exactly: `adidamm-mining-dashboard`
3. Set to **Private** (recommended — keeps your data off public internet)
4. Click **Create repository**

---

## Step 2 — Upload these files

On the new repo page, click **uploading an existing file** and drag in everything from this folder. Commit directly to `main`.

---

## Step 3 — Add your API keys as GitHub Secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these four secrets:

| Secret name | Where to find it |
|---|---|
| `LUXOR_API_KEY` | Luxor → Workspace → API Keys → Generate New Key |
| `LUXOR_WORKSPACE` | Your workspace slug from the URL: `app.luxor.tech/w/YOUR_SLUG` |
| `F2POOL_SECRET` | F2Pool → Account Settings → API → Generate API Token |
| `F2POOL_USER` | Your F2Pool account username |

---

## Step 4 — Enable GitHub Pages

Go to your repo → **Settings** → **Pages**

- Source: **Deploy from a branch**
- Branch: `main` → folder: `/ (root)`
- Click **Save**

Your URL will be: `https://YOUR-USERNAME.github.io/adidamm-mining-dashboard`

---

## Step 5 — Run the first snapshot manually

Go to your repo → **Actions** → **Daily Mining Snapshot** → **Run workflow** → **Run workflow**

Wait ~30 seconds. Refresh the dashboard URL — you should see live data.

---

## Step 6 — Install npm dependencies (one time only)

Before the Action runs automatically for the first time, you need to commit a `package-lock.json`:

```bash
# On your local machine:
cd adidamm-mining-dashboard
npm install
git add package-lock.json
git commit -m "add lockfile"
git push
```

Alternatively, change `npm ci` to `npm install` in `.github/workflows/daily-update.yml` — either works.

---

## Schedule

The Action runs automatically at **6:00 AM AEST** every day (8:00 PM UTC).

To change the time, edit `.github/workflows/daily-update.yml` and update the cron line:
- 5am AEST = `0 19 * * *`
- 7am AEST = `0 21 * * *`

Note: AEST is UTC+10. During daylight saving (Oct–Apr), Sydney is AEDT (UTC+11) — adjust by 1 hour if needed.

---

## Toggle views

| View | What it shows |
|---|---|
| Daily | Today's snapshot — current online/offline, today's revenue vs power |
| Weekly | 7-day rollup — cumulative revenue, power, profit; worst offenders |
| Monthly | 30-day rollup — same |
| 90 Days | Full 90-day history — builds up over time as snapshots accumulate |

The weekly/monthly/90-day views become available automatically as daily snapshots accumulate.

---

## Machines config

All 590 machines are set to **3,900W** each. To change this, edit `fetch-data.js`:

```js
const MACHINE_WATTS = 3900;   // ← change this
const TOTAL_MACHINES = 590;   // ← change this if fleet size changes
```

Commit and push — the next Action run will use the new value.
