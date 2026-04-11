/**
 * fetch-data.js
 * Runs inside GitHub Actions. Calls Luxor + F2Pool + Binance,
 * writes data/latest.json and appends to data/history.json (90-day rolling).
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const LUXOR_API_KEY   = process.env.LUXOR_API_KEY   || '';
const F2POOL_SECRET   = process.env.F2POOL_SECRET    || '';
const F2POOL_USER     = process.env.F2POOL_USER      || '';
const POWER_RATE      = parseFloat(process.env.POWER_RATE || '0.07');
const MACHINE_WATTS   = 3900;
const TOTAL_MACHINES  = 590;

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function luxorGet(endpoint) {
  const res = await fetch(`https://app.luxor.tech/api/v2${endpoint}`, {
    headers: { Authorization: LUXOR_API_KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Luxor ${endpoint} → ${res.status}`);
  return res.json();
}

async function f2poolPost(endpoint, body = {}) {
  const res = await fetch(`https://api.f2pool.com/v2${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'F2P-API-SECRET': F2POOL_SECRET },
    body: JSON.stringify({ currency: 'bitcoin', user_name: F2POOL_USER, ...body }),
  });
  if (!res.ok) throw new Error(`F2Pool ${endpoint} → ${res.status}`);
  return res.json();
}

async function getBtcPrice() {
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
  const d = await res.json();
  return {
    price: parseFloat(d.lastPrice),
    change24h: parseFloat(d.priceChangePercent),
    high24h: parseFloat(d.highPrice),
    low24h: parseFloat(d.lowPrice),
  };
}

function workerStatus(w) {
  const s = (w.status || '').toLowerCase();
  if (s === 'online' || s === 'active') return 'online';
  if (s === 'dead' || s === 'inactive') return 'dead';
  return 'offline';
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchLuxor() {
  if (!LUXOR_API_KEY) return null;
  try {
const ws = await luxorGet('/workspace');
const workspaceId = ws.data?.[0]?.id || ws.id;
const subs = await luxorGet(`/workspace/${workspaceId}/subaccounts`);
const subList = subs.data || subs.subaccounts || [];
    const results = await Promise.allSettled(
      subList.map(s => luxorGet(`/subaccount/${s.name || s.id}/workers?status=all&limit=1000`))
    );
    const workers = results.flatMap((r, i) => {
      if (r.status !== 'fulfilled') return [];
      return (r.value?.data || r.value?.workers || []).map(w => ({
        name: w.name || w.worker_name || '',
        status: workerStatus(w),
        hashrate_24h: w.hashrate_24h || w.hashrate24h || 0,
        hashrate_15m: w.hashrate_15m || w.hashrate || 0,
        reject_rate: w.reject_rate || w.rejected_rate || 0,
        last_share: w.last_share_at || w.last_share || null,
        subaccount: subList[i]?.name || subList[i]?.id || '',
        pool: 'luxor',
      }));
    });
    const online = workers.filter(w => w.status === 'online').length;
    const offline = workers.filter(w => w.status === 'offline').length;
    const dead = workers.filter(w => w.status === 'dead').length;
    return { workers, online, offline, dead, total: workers.length };
  } catch (e) {
    console.error('Luxor fetch failed:', e.message);
    return null;
  }
}

async function fetchF2Pool() {
  if (!F2POOL_SECRET || !F2POOL_USER) return null;
  try {
    const [hr, wd] = await Promise.all([
      f2poolPost('/hash_rate/info'),
      f2poolPost('/hash_rate/worker/list'),
    ]);
    const raw = wd.workers || wd.data || [];
    const workers = raw.map(w => ({
      name: w.name || w.worker_name || '',
      status: workerStatus(w),
      hashrate_24h: w.hashrate_24h || 0,
      hashrate_15m: w.hashrate_15m || w.hashrate || 0,
      reject_rate: w.reject_rate || w.rejected_rate || 0,
      last_share: w.last_share_at || w.last_share || null,
      pool: 'f2pool',
    }));
    const online = workers.filter(w => w.status === 'online').length;
    const offline = workers.filter(w => w.status === 'offline').length;
    const dead = workers.filter(w => w.status === 'dead').length;
    return {
      workers,
      online, offline, dead, total: workers.length,
      hashrate_24h: hr.hashrate_24h || 0,
      mined_24h: hr.mined_24h || hr.revenue_24h || 0,
      estimated_revenue: hr.estimated_revenue_24h || null,
    };
  } catch (e) {
    console.error('F2Pool fetch failed:', e.message);
    return null;
  }
}

// ─── Compute snapshot ─────────────────────────────────────────────────────────

function buildSnapshot(btc, luxor, f2pool) {
  const now = new Date();
  const sydneyDate = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('/').reverse().join('-'); // YYYY-MM-DD

  // Combined worker counts
  const luxorOnline  = luxor?.online  || 0;
  const luxorOffline = luxor?.offline || 0;
  const luxorDead    = luxor?.dead    || 0;
  const f2Online     = f2pool?.online  || 0;
  const f2Offline    = f2pool?.offline || 0;
  const f2Dead       = f2pool?.dead    || 0;

  const totalOnline  = luxorOnline + f2Online;
  const totalOffline = luxorOffline + f2Offline + luxorDead + f2Dead;
  const fleetUtil    = TOTAL_MACHINES > 0 ? (totalOnline / TOTAL_MACHINES) * 100 : 0;

  // Power
  const onlineWatts   = totalOnline * MACHINE_WATTS;
  const dailyPowerCost = (onlineWatts / 1000) * 24 * POWER_RATE;
  const maxDailyPower  = (TOTAL_MACHINES * MACHINE_WATTS / 1000) * 24 * POWER_RATE;

  // Revenue — prefer pool-reported, fall back to hashrate estimate
  const mined24h = f2pool?.mined_24h || 0;
  const revenue  = mined24h && btc?.price ? mined24h * btc.price : null;
  const netProfit = revenue !== null ? revenue - dailyPowerCost : null;

  // Offline machine list (top offenders by pool order)
  const allWorkers = [
    ...(luxor?.workers || []),
    ...(f2pool?.workers || []),
  ];
  const downWorkers = allWorkers
    .filter(w => w.status !== 'online')
    .map(w => ({
      name: w.name,
      status: w.status,
      pool: w.pool,
      last_share: w.last_share,
    }));

  return {
    date: sydneyDate,
    timestamp: now.toISOString(),
    btc: btc || null,
    fleet: {
      total: TOTAL_MACHINES,
      online: totalOnline,
      offline: totalOffline,
      utilisation: parseFloat(fleetUtil.toFixed(2)),
    },
    power: {
      rate: POWER_RATE,
      machine_watts: MACHINE_WATTS,
      online_kw: parseFloat((onlineWatts / 1000).toFixed(2)),
      daily_cost: parseFloat(dailyPowerCost.toFixed(2)),
      max_daily_cost: parseFloat(maxDailyPower.toFixed(2)),
    },
    revenue: {
      btc_mined: mined24h || null,
      usd: revenue !== null ? parseFloat(revenue.toFixed(2)) : null,
      net_profit: netProfit !== null ? parseFloat(netProfit.toFixed(2)) : null,
    },
    pools: {
      luxor: luxor ? { online: luxorOnline, offline: luxorOffline + luxorDead } : null,
      f2pool: f2pool ? { online: f2Online, offline: f2Offline + f2Dead, hashrate_24h: f2pool.hashrate_24h } : null,
    },
    down_workers: downWorkers,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching data...');
  const [btc, luxor, f2pool] = await Promise.all([
    getBtcPrice().catch(e => { console.error('BTC price failed:', e.message); return null; }),
    fetchLuxor(),
    fetchF2Pool(),
  ]);

  const snapshot = buildSnapshot(btc, luxor, f2pool);
  console.log(`Snapshot: ${snapshot.date} | Online: ${snapshot.fleet.online}/${snapshot.fleet.total} | BTC: $${btc?.price?.toFixed(0) || '—'}`);

  // Write latest.json
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));

  // Load + update history.json (rolling 90-day)
  const historyPath = path.join(DATA_DIR, 'history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch {}

  // Replace today's entry if it already exists, otherwise prepend
  const idx = history.findIndex(h => h.date === snapshot.date);
  if (idx >= 0) history[idx] = snapshot;
  else history.unshift(snapshot);

  // Keep 90 days
  history = history.slice(0, 90);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  console.log(`Done. History: ${history.length} days stored.`);
}

main().catch(e => { console.error(e); process.exit(1); });
