import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const LUXOR_API_KEY  = process.env.LUXOR_API_KEY  || '';
const F2POOL_SECRET  = process.env.F2POOL_SECRET   || '';
const F2POOL_USER    = process.env.F2POOL_USER     || '';
const POWER_RATE     = parseFloat(process.env.POWER_RATE || '0.07');
const MACHINE_WATTS  = 3900;
const TOTAL_MACHINES = 590;
const LUXOR_SUBACCOUNT = 'iwah2478';

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

async function getBtcPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
    const d = await res.json();
    if (d?.bitcoin?.usd) return { price: d.bitcoin.usd, change24h: d.bitcoin.usd_24h_change || 0, high24h: null, low24h: null };
  } catch (e) { console.log('CoinGecko failed:', e.message); }
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    const d = await res.json();
    if (d?.data?.amount) return { price: parseFloat(d.data.amount), change24h: null, high24h: null, low24h: null };
  } catch (e) { console.log('Coinbase failed:', e.message); }
  return null;
}

async function fetchLuxor() {
  if (!LUXOR_API_KEY) { console.log('Luxor: no API key'); return null; }
  try {
    const q = [
      '{getWorkerDetails(',
      'mpn:BTC,',
      'uname:"iwah2478",',
      'first:1000,',
      'duration:{days:1})',
      '{edges{node{workerName status hashrate updatedAt}}',
      'totalCount}}'
    ].join('');
    const res = await fetch('https://api.luxor.tech/graphql', {
      method: 'POST',
      headers: { 'x-lux-api-key': LUXOR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const d = await res.json();
    console.log('Luxor response:', JSON.stringify(d).slice(0, 400));
    const edges = d?.data?.getWorkerDetails?.edges || [];
    const workers = edges.map(e => ({
      name: e.node.workerName,
      status: e.node.status?.toLowerCase() === 'active' ? 'online' : 'offline',
      hashrate_24h: parseFloat(e.node.hashrate) || 0,
      hashrate_15m: 0,
      reject_rate: 0,
      last_share: e.node.updatedAt,
      pool: 'luxor',
    }));
    const online = workers.filter(w => w.status === 'online').length;
    const offline = workers.filter(w => w.status === 'offline').length;
    console.log('Luxor: ' + online + ' online, ' + offline + ' offline, ' + workers.length + ' total');
    return { workers, online, offline, dead: 0, total: workers.length };
  } catch (e) { console.error('Luxor failed:', e.message); return null; }
}

async function f2poolPost(endpoint, body) {
  const res = await fetch('https://api.f2pool.com/v2' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'F2P-API-SECRET': F2POOL_SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('F2Pool ' + endpoint + ' ' + res.status + ': ' + text.slice(0, 200));
  return JSON.parse(text);
}

async function fetchF2Pool() {
  if (!F2POOL_SECRET || !F2POOL_USER) { console.log('F2Pool: no credentials'); return null; }
  try {
    const body = { currency: 'bitcoin', mining_user_name: F2POOL_USER };
    const [hr, wd] = await Promise.all([
      f2poolPost('/hash_rate/info', body),
      f2poolPost('/hash_rate/worker/list', body),
    ]);
    console.log('F2Pool hr:', JSON.stringify(hr).slice(0, 300));
    console.log('F2Pool workers:', JSON.stringify(wd).slice(0, 300));
    const raw = wd.workers || wd.data || wd.list || [];
    const workers = raw.map(w => ({
      name: w.name || w.worker_name || '',
      status: w.last_share_at && (Date.now()/1000 - w.last_share_at) < 900 ? 'online' : 'offline',
      hashrate_24h: w.hashrate_24h || w.h24 || 0,
      hashrate_15m: w.hashrate_15m || w.hashrate || w.h1 || 0,
      reject_rate: w.reject_rate || 0,
      last_share: w.last_share_at || w.last_share || null,
      pool: 'f2pool',
    }));
    const online = workers.filter(w => w.status === 'online').length;
    const offline = workers.filter(w => w.status === 'offline').length;
    console.log('F2Pool: ' + online + ' online, ' + offline + ' offline, ' + workers.length + ' total');
    return {
      workers, online, offline, dead: 0, total: workers.length,
      hashrate_24h: hr.hashrate_24h || hr.info?.h24_hash_rate || 0,
      mined_24h: hr.mined_24h || hr.revenue_24h || 0,
    };
  } catch (e) { console.error('F2Pool failed:', e.message); return null; }
}

function buildSnapshot(btc, luxor, f2pool) {
  const now = new Date();
  const sydneyDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('/').reverse().join('-');
  const luxorOnline = luxor?.online || 0, luxorOffline = luxor?.offline || 0;
  const f2Online = f2pool?.online || 0, f2Offline = f2pool?.offline || 0;
  const totalOnline = luxorOnline + f2Online;
  const totalOffline = luxorOffline + f2Offline;
  const onlineWatts = totalOnline * MACHINE_WATTS;
  const dailyPowerCost = (onlineWatts / 1000) * 24 * POWER_RATE;
  const maxDailyPower = (TOTAL_MACHINES * MACHINE_WATTS / 1000) * 24 * POWER_RATE;
  const mined24h = f2pool?.mined_24h || 0;
  const revenue = mined24h && btc?.price ? mined24h * btc.price : null;
  const netProfit = revenue !== null ? revenue - dailyPowerCost : null;
  const allWorkers = [...(luxor?.workers || []), ...(f2pool?.workers || [])];
  const downWorkers = allWorkers.filter(w => w.status !== 'online').map(w => ({ name: w.name, status: w.status, pool: w.pool, last_share: w.last_share }));
  return {
    date: sydneyDate,
    timestamp: now.toISOString(),
    btc: btc || null,
    fleet: { total: TOTAL_MACHINES, online: totalOnline, offline: totalOffline, utilisation: parseFloat(((totalOnline / TOTAL_MACHINES) * 100).toFixed(2)) },
    power: { rate: POWER_RATE, machine_watts: MACHINE_WATTS, online_kw: parseFloat((onlineWatts / 1000).toFixed(2)), daily_cost: parseFloat(dailyPowerCost.toFixed(2)), max_daily_cost: parseFloat(maxDailyPower.toFixed(2)) },
    revenue: { btc_mined: mined24h || null, usd: revenue !== null ? parseFloat(revenue.toFixed(2)) : null, net_profit: netProfit !== null ? parseFloat(netProfit.toFixed(2)) : null },
    pools: {
      luxor: luxor ? { online: luxorOnline, offline: luxorOffline } : null,
      f2pool: f2pool ? { online: f2Online, offline: f2Offline, hashrate_24h: f2pool.hashrate_24h } : null,
    },
    down_workers: downWorkers,
  };
}

async function main() {
  console.log('Fetching data...');
  const [btc, luxor, f2pool] = await Promise.all([
    getBtcPrice().catch(e => { console.error('BTC failed:', e.message); return null; }),
    fetchLuxor(),
    fetchF2Pool(),
  ]);
  console.log('BTC: $' + (btc?.price || '—') + ' | Luxor: ' + (luxor?.total ?? 'failed') + ' | F2Pool: ' + (f2pool?.total ?? 'failed'));
  const snapshot = buildSnapshot(btc, luxor, f2pool);
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));
  const historyPath = path.join(DATA_DIR, 'history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch {}
  const idx = history.findIndex(h => h.date === snapshot.date);
  if (idx >= 0) history[idx] = snapshot; else history.unshift(snapshot);
  history = history.slice(0, 90);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  console.log('Done. Online: ' + snapshot.fleet.online + '/' + snapshot.fleet.total + ' | History: ' + history.length + ' days');
}

main().catch(e => { console.error(e); process.exit(1); });
