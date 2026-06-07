// scripts/poll.js — Phase 2 poller (GitHub Actions cron, $0)
// Reads tracked coins from Supabase, checks early wallets, alerts exits on Telegram.
// Env (GitHub Actions Secrets): SUPABASE_URL, SUPABASE_KEY, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const HELIUS       = process.env.HELIUS_API_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID;

const RPC   = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;
const PARSE = `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${HELIUS}`;
const short = (s, n = 4) => (s ? s.slice(0, n) + "…" + s.slice(-n) : "");

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc err");
  return j.result;
}
async function parseBySig(sigs) {
  const out = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const r = await fetch(PARSE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transactions: sigs.slice(i, i + 100) }) });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) out.push(...j); }
  }
  return out;
}
async function currentBal(owner, mint) {
  try {
    const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
    let s = 0; ((r && r.value) || []).forEach(a => { s += a.account.data.parsed.info.tokenAmount.uiAmount || 0; });
    return s;
  } catch (_) { return null; }
}
async function tokenPrice(mint) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v2?ids=${mint}`);
    if (r.ok) { const j = await r.json(); const p = j.data && j.data[mint] && j.data[mint].price; if (p) return Number(p); }
  } catch (_) {}
  try {
    const a = await rpc("getAsset", { id: mint });
    const p = a && a.token_info && a.token_info.price_info && a.token_info.price_info.price_per_token;
    if (p != null) return Number(p);
  } catch (_) {}
  return null;
}
async function sb(path, { method = "GET", body = null, prefer = null } = {}) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}
async function tg(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) { console.error("tg fail:", e.message); }
}

async function scanLaunch(mint) {
  let pages = [], before = null;
  for (let p = 0; p < 10; p++) {
    const sigs = await rpc("getSignaturesForAddress", [mint, { limit: 1000, before }]);
    if (!sigs || !sigs.length) break;
    pages = pages.concat(sigs); before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }
  pages.reverse();
  const parsed = await parseBySig(pages.slice(0, 150).map(s => s.signature));
  parsed.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const dev = parsed.length ? parsed[0].feePayer : null;
  const launchTs = parsed.length ? parsed[0].timestamp : null;
  const seen = {}, buyers = [];
  for (const tx of parsed) {
    const recv = (tx.tokenTransfers || []).filter(t => t.mint === mint && t.toUserAccount && Number(t.tokenAmount) > 0);
    for (const tt of recv) {
      const w = tt.toUserAccount;
      if (w === dev || seen[w]) continue;
      seen[w] = true;
      buyers.push({ wallet: w, ts: tx.timestamp, qty: Number(tt.tokenAmount) || 0 });
      if (buyers.length >= 50) break;
    }
    if (buyers.length >= 50) break;
  }
  const firstTs = buyers.length ? buyers[0].ts : launchTs;
  buyers.forEach((b, i) => { b.rank = i + 1; b.sniper = (b.ts - firstTs) <= 2; });
  return { dev, launchTs, buyers };
}

async function initCoin(coin) {
  const mint = coin.mint;
  console.log("init", mint);
  const { dev, launchTs, buyers } = await scanLaunch(mint);
  const initPrice = await tokenPrice(mint);
  await sb(`tracked_coins?mint=eq.${mint}`, { method: "PATCH", prefer: "return=minimal", body: { dev_wallet: dev, launch_ts: launchTs, init_price: initPrice } });
  if (buyers.length) {
    await sb("early_buyers", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: buyers.map(b => ({ mint, wallet: b.wallet, rank: b.rank, entry_ts: b.ts, entry_qty: b.qty, is_sniper: b.sniper })) });
    await sb("positions", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: buyers.map(b => ({ mint, wallet: b.wallet, entry_qty: b.qty, current_qty: b.qty, pct_exited: 0, exited: false })) });
  }
  await tg(`🟢 <b>Tracking started</b>\n${coin.symbol || short(mint)}\nEarly buyers: ${buyers.length} · snipers: ${buyers.filter(b => b.sniper).length}`);
}

async function checkCoin(coin) {
  const mint = coin.mint;
  const nowSec = Math.floor(Date.now() / 1000);
  const positions = await sb(`positions?mint=eq.${mint}&select=*`);

  const ebRows = await sb(`early_buyers?mint=eq.${mint}&select=wallet,entry_ts,rank`);
  const entryTs = {}, rankOf = {};
  (ebRows || []).forEach(r => { entryTs[r.wallet] = r.entry_ts; rankOf[r.wallet] = r.rank; });

  const newlyExited = [];  // {w, rank}
  const partialNow = [];   // {w, pct, rank}

  for (const pos of positions) {
    const bal = await currentBal(pos.wallet, mint);
    if (bal == null) continue;
    const pct = pos.entry_qty > 0 ? Math.max(0, (1 - bal / pos.entry_qty)) * 100 : 0;
    const exited = bal < pos.entry_qty * 0.05;
    const rank = rankOf[pos.wallet] || 999;

    if (!exited && (pos.pct_exited || 0) < 50 && pct >= 50) partialNow.push({ w: pos.wallet, pct, rank });

    await sb(`positions?id=eq.${pos.id}`, { method: "PATCH", prefer: "return=minimal",
      body: { current_qty: bal, pct_exited: pct, exited, last_checked: new Date().toISOString() } });

    if (exited && !pos.exited) {
      newlyExited.push({ w: pos.wallet, rank });
      const prior = await sb(`trades?wallet=eq.${pos.wallet}&mint=eq.${mint}&select=id&limit=1`);
      if (!prior || !prior.length) {
        const bts = entryTs[pos.wallet] || null;
        const exitPrice = await tokenPrice(mint);
        const entryPrice = coin.init_price || null;
        const roi = (entryPrice && exitPrice) ? (exitPrice / entryPrice) : null;
        await sb("trades", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
          body: { wallet: pos.wallet, mint, buy_ts: bts, sell_ts: nowSec, hold_secs: bts ? (nowSec - bts) : null, pct_sold: pct, entry_price: entryPrice, exit_price: exitPrice, roi } });
      }
    }
  }

  const name = coin.symbol || short(mint);

  // individual alerts: ONLY top 10 early wallets (noise control)
  for (const e of newlyExited.filter(x => x.rank <= 10)) {
    const seen = await sb(`alerts_sent?mint=eq.${mint}&wallet=eq.${e.w}&kind=eq.wallet_exit&select=id&limit=1`);
    if (seen && seen.length) continue;
    await tg(`🔴 <b>Top-${e.rank} early wallet EXITED</b>\n${name}\n${short(e.w)} ne pura bag bech diya\nhttps://solscan.io/account/${e.w}`);
    await sb("alerts_sent", { method: "POST", prefer: "return=minimal", body: { mint, wallet: e.w, kind: "wallet_exit" } });
  }
  for (const p of partialNow.filter(x => x.rank <= 10)) {
    const seen = await sb(`alerts_sent?mint=eq.${mint}&wallet=eq.${p.w}&kind=eq.partial50&select=id&limit=1`);
    if (seen && seen.length) continue;
    await tg(`🟠 <b>Top-${p.rank} early wallet selling</b>\n${name}\n${short(p.w)} ne ~${Math.round(p.pct)}% bech diya`);
    await sb("alerts_sent", { method: "POST", prefer: "return=minimal", body: { mint, wallet: p.w, kind: "partial50" } });
  }

  // DUMP: 3+ of TOP 10 early wallets exited in one check
  const top10Exited = newlyExited.filter(x => x.rank <= 10).length;
  if (top10Exited >= 3) {
    await tg(`⚡ <b>DUMP DETECTED</b>\n${name}\nTop-10 early wallets mein se ${top10Exited} ek saath nikal gaye — abhi!`);
    await sb("alerts_sent", { method: "POST", prefer: "return=minimal", body: { mint, kind: "velocity" } });
  }

  // aggregate threshold across all 50 tracked (one-time)
  const total = positions.length;
  const exitedNow = positions.filter(p => p.exited).length + newlyExited.length;
  if (total > 0 && (exitedNow / total) * 100 >= 30) {
    const prior = await sb(`alerts_sent?mint=eq.${mint}&kind=eq.threshold&select=id`);
    if (!prior || !prior.length) {
      await tg(`⚠️ <b>${Math.round((exitedNow / total) * 100)}% early money EXITED</b>\n${name}\nSmart/early wallets nikal rahe — dhyan se.`);
      await sb("alerts_sent", { method: "POST", prefer: "return=minimal", body: { mint, kind: "threshold" } });
    }
  }
  console.log(`checked ${mint}: ${newlyExited.length} exits (${top10Exited} top10), ${partialNow.length} partial`);
}

async function runPoll() {
  for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_KEY, HELIUS, TG_TOKEN, TG_CHAT })) {
    if (!v) { console.error("Missing env:", k); return; }
  }
  const coins = await sb("tracked_coins?active=eq.true&select=*");
  console.log(`${coins.length} coins tracked`);
  for (const coin of coins) {
    try {
      const eb = await sb(`early_buyers?mint=eq.${coin.mint}&select=id&limit=1`);
      if (!eb || !eb.length) await initCoin(coin);
      else await checkCoin(coin);
    } catch (e) { console.error(`coin ${coin.mint} error:`, e.message); }
  }
  console.log("poll done");
}

module.exports = { runPoll, sb, tg, currentBal, tokenPrice, short };
if (require.main === module) runPoll();
