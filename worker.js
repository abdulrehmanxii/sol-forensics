// worker.js — ALWAYS-ON worker (Railway). Listener 24/7 + Poller (backup) + optional INSTANT trade-stream.
// Env: SUPABASE_URL, SUPABASE_KEY, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Optional (for instant exits): PUMPPORTAL_API_KEY   ·   POLL_MS (default 30000)
const WebSocket = require("ws");
const { runPoll, sb, tg, currentBal, tokenPrice, short, rpc } = require("./scripts/poll.js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PP_KEY       = process.env.PUMPPORTAL_API_KEY || null;
const POLL_MS      = Number(process.env.POLL_MS) || 30000;
const FEED_MIN_DEV_BUY = Number(process.env.FEED_MIN_DEV_BUY) || 0;   // 0 = sab store (movers filter strict hai); Railway env se badha sakte ho
const FEED_MIN_MCAP    = Number(process.env.FEED_MIN_MCAP) || 0;
const MOVER_TOP10_MAX   = Number(process.env.MOVER_TOP10_MAX) || 30;
const MOVER_MCAP_MIN    = Number(process.env.MOVER_MCAP_MIN) || 6000;
const MOVER_MCAP_MAX    = Number(process.env.MOVER_MCAP_MAX) || 100000;
const MOVER_HOLDERS_MIN = Number(process.env.MOVER_HOLDERS_MIN) || 50;

/* ---------------- LISTENER: new tokens (free, 24/7) ---------------- */
async function feedInsert(rows) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/new_tokens`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
  } catch (e) { console.error("feed insert fail:", e.message); }
}
async function feedPrune() {
  const iso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/new_tokens?created_at=lt.${iso}`, {
      method: "DELETE", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" },
    });
  } catch (e) { console.error("prune fail:", e.message); }
}
let feedBatch = [], feedTotal = 0;
async function feedFlush() {
  if (!feedBatch.length) return;
  const b = feedBatch; feedBatch = []; feedTotal += b.length;
  await feedInsert(b);
  console.log(`feed +${b.length} (total ${feedTotal})`);
}
function listenerConnect() {
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  ws.on("open", () => { ws.send(JSON.stringify({ method: "subscribeNewToken" })); console.log("listener subscribed"); });
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (!m || !m.mint) return;
      const _buy = typeof m.solAmount === "number" ? m.solAmount : 0;
      const _mc = typeof m.marketCapSol === "number" ? m.marketCapSol : 0;
      if (_buy < FEED_MIN_DEV_BUY) return;                 // filter: kam dev-buy wale skip
      if (FEED_MIN_MCAP && _mc < FEED_MIN_MCAP) return;
      feedBatch.push({ mint: m.mint, name: m.name || null, symbol: m.symbol || null, dev: m.traderPublicKey || null,
        initial_buy_sol: typeof m.solAmount === "number" ? m.solAmount : null,
        market_cap_sol: typeof m.marketCapSol === "number" ? m.marketCapSol : null });
      if (feedBatch.length >= 25) feedFlush();
    } catch (_) {}
  });
  ws.on("close", () => { console.log("listener closed — reconnect 2s"); setTimeout(listenerConnect, 2000); });
  ws.on("error", (e) => console.error("listener err:", e.message));
}

/* ---------------- INSTANT exit detection (optional, needs PP_KEY) ---------------- */
let ppWs = null, subbedMints = [];
async function refreshSubs() {
  try {
    const coins = await sb(`tracked_coins?active=eq.true&select=mint`);
    const mints = (coins || []).map(c => c.mint);
    subbedMints = mints;
    if (ppWs && ppWs.readyState === 1 && mints.length) {
      ppWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
      console.log(`instant: subscribed ${mints.length} coins`);
    }
  } catch (e) { console.error("refreshSubs err:", e.message); }
}
async function handleInstantTrade(mint, wallet) {
  try {
    const pos = await sb(`positions?mint=eq.${mint}&wallet=eq.${wallet}&select=*&limit=1`);
    if (!pos || !pos.length) return;                 // sirf early wallets matter
    const p = pos[0];
    const eb = await sb(`early_buyers?mint=eq.${mint}&wallet=eq.${wallet}&select=rank,entry_ts&limit=1`);
    const rank = (eb && eb[0] && eb[0].rank) || 999;
    const bal = await currentBal(wallet, mint);
    if (bal == null) return;
    const pct = p.entry_qty > 0 ? Math.max(0, (1 - bal / p.entry_qty)) * 100 : 0;
    const exited = bal < p.entry_qty * 0.05;
    await sb(`positions?id=eq.${p.id}`, { method: "PATCH", prefer: "return=minimal",
      body: { current_qty: bal, pct_exited: pct, exited, last_checked: new Date().toISOString() } });

    const tc = await sb(`tracked_coins?mint=eq.${mint}&select=symbol,init_price&limit=1`);
    const name = (tc && tc[0] && tc[0].symbol) || short(mint);

    if (rank <= 10) {
      if (exited && !p.exited) {
        const seen = await sb(`alerts_sent?mint=eq.${mint}&wallet=eq.${wallet}&kind=eq.wallet_exit&select=id&limit=1`);
        if (!seen || !seen.length) {
          await tg(`🔴 <b>Top-${rank} early wallet EXITED</b> ⚡instant\n${name}\n${short(wallet)} ne pura bag bech diya\nhttps://solscan.io/account/${wallet}`);
          await sb("alerts_sent", { method: "POST", prefer: "return=minimal", body: { mint, wallet, kind: "wallet_exit" } });
        }
      } else if (!exited && (p.pct_exited || 0) < 50 && pct >= 50) {
        const seen = await sb(`alerts_sent?mint=eq.${mint}&wallet=eq.${wallet}&kind=eq.partial50&select=id&limit=1`);
        if (!seen || !seen.length) {
          await tg(`🟠 <b>Top-${rank} early wallet selling</b> ⚡instant\n${name}\n${short(wallet)} ne ~${Math.round(pct)}% bech diya`);
          await sb("alerts_sent", { method: "POST", prefer: "return=minimal", body: { mint, wallet, kind: "partial50" } });
        }
      }
    }
    if (exited && !p.exited) {
      const prior = await sb(`trades?wallet=eq.${wallet}&mint=eq.${mint}&select=id&limit=1`);
      if (!prior || !prior.length) {
        const bts = (eb && eb[0] && eb[0].entry_ts) || null;
        const exitPrice = await tokenPrice(mint);
        const entryPrice = (tc && tc[0] && tc[0].init_price) || null;
        const roi = (entryPrice && exitPrice) ? (exitPrice / entryPrice) : null;
        const nowSec = Math.floor(Date.now() / 1000);
        await sb("trades", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
          body: { wallet, mint, buy_ts: bts, sell_ts: nowSec, hold_secs: bts ? (nowSec - bts) : null, pct_sold: pct, entry_price: entryPrice, exit_price: exitPrice, roi } });
      }
    }
  } catch (e) { console.error("instant trade err:", e.message); }
}
function ppConnect() {
  ppWs = new WebSocket(`wss://pumpportal.fun/api/data?api-key=${PP_KEY}`);
  ppWs.on("open", async () => { console.log("INSTANT trade-stream connected"); await refreshSubs(); });
  ppWs.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m && m.mint && m.traderPublicKey && m.txType === "sell" && subbedMints.includes(m.mint)) {
        handleInstantTrade(m.mint, m.traderPublicKey);
      }
    } catch (_) {}
  });
  ppWs.on("close", () => { console.log("trade-stream closed — reconnect 3s"); setTimeout(ppConnect, 3000); });
  ppWs.on("error", (e) => console.error("trade-stream err:", e.message));
}

/* ---------------- ENRICHER (Movers hard-coded filter) ---------------- */
async function dexMcap(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = (j && j.pairs) || [];
    if (!pairs.length) return null;
    pairs.sort((a, b) => (((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0)));
    const p = pairs[0];
    return Number(p.marketCap || p.fdv) || null;
  } catch (_) { return null; }
}
async function enrichCoin(mint) {
  let holders = null, top10 = null, social = null, mcap = null, image = null, tw = null, tg = null, web = null;
  try {
    const sup = await rpc("getTokenSupply", [mint]);
    const total = (sup && sup.value && Number(sup.value.uiAmount)) || 0;
    const la = await rpc("getTokenLargestAccounts", [mint]);
    let list = ((la && la.value) || []).map(x => Number(x.uiAmount) || 0);
    if (total > 0) { list = list.filter(v => (v / total) <= 0.5); top10 = (list.slice(0, 10).reduce((a, v) => a + v, 0) / total) * 100; }
  } catch (_) {}
  try {
    const a = await rpc("getAsset", { id: mint });
    const links = (a && a.content && a.content.links) || {};
    const files = (a && a.content && a.content.files) || [];
    image = links.image || (files[0] && (files[0].cdn_uri || files[0].uri)) || null;
    tw = links.twitter || null; tg = links.telegram || null; web = links.website || links.external_url || null;
    const uri = a && a.content && a.content.json_uri;
    if (uri && (!image || (!tw && !tg && !web))) {
      try { const jr = await fetch(uri, { signal: AbortSignal.timeout(4000) }); if (jr.ok) { const jj = await jr.json(); const ex = jj.extensions || {}; image = image || jj.image || null; tw = tw || jj.twitter || ex.twitter || null; tg = tg || jj.telegram || ex.telegram || null; web = web || jj.website || ex.website || null; } } catch (_) {}
    }
    const ti = a && a.token_info;
    if (ti && ti.price_info && ti.price_info.price_per_token && ti.supply != null && ti.decimals != null) mcap = ti.price_info.price_per_token * (Number(ti.supply) / Math.pow(10, ti.decimals));
  } catch (_) {}
  social = !!(tw || tg || web);
  const dm = await dexMcap(mint);
  if (dm != null) mcap = dm;
  try { const ta = await rpc("getTokenAccounts", { mint, limit: 1000, options: { showZeroBalance: false } }); holders = (ta && ta.token_accounts && ta.token_accounts.length) || (ta && ta.total) || null; } catch (_) {}

  const cTop = top10 != null && top10 < MOVER_TOP10_MAX;
  const cSoc = social === true;
  const cHold = holders != null && holders >= MOVER_HOLDERS_MIN;
  const cMcap = mcap != null && mcap >= MOVER_MCAP_MIN && mcap <= MOVER_MCAP_MAX;
  const is_mover = cTop && cSoc && cHold && cMcap;

  await sb(`new_tokens?mint=eq.${mint}`, { method: "PATCH", prefer: "return=minimal",
    body: { holders, top10_pct: top10, has_social: social === true, cur_mcap_usd: mcap, image, tw, tg, web, is_mover, evaluated_at: new Date().toISOString() } });
  return { is_mover, cTop, cSoc, cHold, cMcap };
}
async function enrichLoop() {
  try {
    // pehle: jo coins kabhi evaluate nahi hue (no or() filter -> PostgREST safe)
    let rows = await sb(`new_tokens?select=mint&evaluated_at=is.null&order=created_at.desc&limit=12`);
    if (!rows || !rows.length) {
      // sab evaluate ho gaye -> 5 min purane re-check karo
      const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      rows = await sb(`new_tokens?select=mint&evaluated_at=lt.${encodeURIComponent(stale)}&order=created_at.desc&limit=12`);
    }
    let n = 0, mv = 0, t = { top: 0, soc: 0, hold: 0, mc: 0 };
    for (const r of (rows || [])) { const d = await enrichCoin(r.mint); n++; if (d.is_mover) mv++; if (d.cTop) t.top++; if (d.cSoc) t.soc++; if (d.cHold) t.hold++; if (d.cMcap) t.mc++; }
    if (n) console.log(`eval ${n} | top10ok ${t.top} | social ${t.soc} | holders50 ${t.hold} | mcap_in_range ${t.mc} | MOVERS ${mv}`);
    else console.log("enrich: koi coin evaluate karne ko nahi mila");
  } catch (e) { console.error("enrich loop err:", e.message); }
  setTimeout(enrichLoop, 15000);
}

/* ---------------- POLLER loop (backup / aggregate alerts) ---------------- */
async function pollLoop() {
  try { await runPoll(); } catch (e) { console.error("poll error:", e.message); }
  setTimeout(pollLoop, POLL_MS);
}

/* ---------------- START ---------------- */
(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_KEY"); process.exit(1); }
  await feedPrune().catch(() => {});
  listenerConnect();
  setInterval(feedFlush, 3000);
  setInterval(feedPrune, 6 * 60 * 60 * 1000);
  pollLoop();
  enrichLoop();                           // <-- MOVERS enricher (ye missing tha)
  console.log("ENRICHER loop started");
  if (PP_KEY) { ppConnect(); setInterval(refreshSubs, 60000); console.log("INSTANT mode ON"); }
  else { console.log("INSTANT mode OFF (PUMPPORTAL_API_KEY not set) — using poll every " + POLL_MS + "ms"); }
  console.log("WORKER UP — listener + poller" + (PP_KEY ? " + instant trade-stream" : ""));
})();
