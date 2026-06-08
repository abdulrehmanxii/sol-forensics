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
        market_cap_sol: typeof m.marketCapSol === "number" ? m.marketCapSol : null,
        bonding_curve: m.bondingCurveKey || null });
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

/* ---------------- ENRICHER (Movers — on-chain bonding curve mcap) ---------------- */
const SOL_MINT = "So11111111111111111111111111111111111111112";
async function solPriceUsd() {
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`);
    if (r.ok) { const j = await r.json(); const p = j.data && j.data[SOL_MINT] && j.data[SOL_MINT].price; return Number(p) || null; }
  } catch (_) {}
  return null;
}
// pump.fun bonding curve account decode -> mcap USD (null agar graduated/invalid)
function curveMcapUsd(b64, solPrice) {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 49) return null;
    const vTok = Number(buf.readBigUInt64LE(8));
    const vSol = Number(buf.readBigUInt64LE(16));
    const totalSupply = Number(buf.readBigUInt64LE(40));
    const complete = buf.readUInt8(48) === 1;
    if (complete || !vTok || !vSol || !totalSupply) return null; // graduated/invalid -> dexscreener fallback
    const priceSol = (vSol / 1e9) / (vTok / 1e6);   // SOL per token
    const mcapSol = priceSol * (totalSupply / 1e6);
    return solPrice ? mcapSol * solPrice : null;
  } catch (_) { return null; }
}
async function dexFallback(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return {};
    const j = await r.json(); const pairs = (j && j.pairs) || [];
    if (!pairs.length) return {};
    pairs.sort((a, b) => (((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0)));
    const p = pairs[0]; const info = p.info || {};
    const socials = info.socials || [];
    return {
      mcap: Number(p.fdv || p.marketCap) || null,
      image: info.imageUrl || null,
      tw: (socials.find(x => /twitter|^x$/i.test(x.type || "")) || {}).url || null,
      tg: (socials.find(x => /telegram/i.test(x.type || "")) || {}).url || null,
      web: (info.websites && info.websites[0] && info.websites[0].url) || null,
    };
  } catch (_) { return {}; }
}
// in-range coin ka social/image (metadata) + holders + top10 (Helius)
async function deepCheck(mint, pre) {
  let { image = null, tw = null, tg = null, web = null } = pre || {};
  let social = !!(tw || tg || web), holders = null, top10 = null;
  if (!social || !image) {
    try {
      const a = await rpc("getAsset", { id: mint });
      const links = (a && a.content && a.content.links) || {}; const files = (a && a.content && a.content.files) || [];
      image = image || links.image || (files[0] && (files[0].cdn_uri || files[0].uri)) || null;
      tw = tw || links.twitter || null; tg = tg || links.telegram || null; web = web || links.website || links.external_url || null;
      if (!(tw || tg || web)) {
        const uri = a && a.content && a.content.json_uri;
        if (uri) { try { const jr = await fetch(uri, { signal: AbortSignal.timeout(4000) }); if (jr.ok) { const jj = await jr.json(); const ex = jj.extensions || {}; tw = tw || jj.twitter || ex.twitter || null; tg = tg || jj.telegram || ex.telegram || null; web = web || jj.website || ex.website || null; image = image || jj.image || null; } } catch (_) {} }
      }
      social = !!(tw || tg || web);
    } catch (_) {}
  }
  if (social) {
    try {
      const sup = await rpc("getTokenSupply", [mint]);
      const total = (sup && sup.value && Number(sup.value.uiAmount)) || 0;
      const la = await rpc("getTokenLargestAccounts", [mint]);
      let list = ((la && la.value) || []).map(x => Number(x.uiAmount) || 0);
      if (total > 0) { list = list.filter(v => (v / total) <= 0.5); top10 = (list.slice(0, 10).reduce((a, v) => a + v, 0) / total) * 100; }
    } catch (_) {}
    try { const ta = await rpc("getTokenAccounts", { mint, limit: 1000, options: { showZeroBalance: false } }); holders = (ta && ta.token_accounts && ta.token_accounts.length) || (ta && ta.total) || null; } catch (_) {}
  }
  return { image, tw, tg, web, social, holders, top10 };
}
async function evalOne(coin, mcap) {
  const mint = coin.mint;
  let image = null, tw = null, tg = null, web = null, social = false, holders = null, top10 = null;
  // agar curve se mcap nahi mila (graduated/old) -> DexScreener fallback
  if (mcap == null) { const d = await dexFallback(mint); mcap = d.mcap != null ? d.mcap : null; image = d.image; tw = d.tw; tg = d.tg; web = d.web; social = !!(tw || tg || web); }
  const inRange = mcap != null && mcap >= MOVER_MCAP_MIN && mcap <= MOVER_MCAP_MAX;
  if (inRange) {
    const dc = await deepCheck(mint, { image, tw, tg, web });
    image = dc.image; tw = dc.tw; tg = dc.tg; web = dc.web; social = dc.social; holders = dc.holders; top10 = dc.top10;
  }
  const cMcap = inRange, cSoc = social === true, cTop = top10 != null && top10 < MOVER_TOP10_MAX, cHold = holders != null && holders >= MOVER_HOLDERS_MIN;
  const is_mover = cMcap && cSoc && cTop && cHold;
  await sb(`new_tokens?mint=eq.${mint}`, { method: "PATCH", prefer: "return=minimal",
    body: { holders, top10_pct: top10, has_social: social, cur_mcap_usd: mcap, image, tw, tg, web, is_mover, evaluated_at: new Date().toISOString() } });
  return { is_mover, cTop, cSoc, cHold, cMcap };
}
async function enrichLoop() {
  try {
    const sol = await solPriceUsd();
    const young = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const movers = await sb(`new_tokens?select=mint,bonding_curve&is_mover=eq.true&limit=25`);
    const disc = await sb(`new_tokens?select=mint,bonding_curve&created_at=lt.${encodeURIComponent(young)}&created_at=gt.${encodeURIComponent(old)}&order=evaluated_at.asc.nullsfirst&limit=300`);
    const all = [...(movers || []), ...(disc || [])];
    // batch read bonding curves (100 per call) -> mcap map
    const curveMap = {};
    const withCurve = all.filter(c => c.bonding_curve);
    for (let i = 0; i < withCurve.length; i += 100) {
      const slice = withCurve.slice(i, i + 100);
      try {
        const res = await rpc("getMultipleAccounts", [slice.map(c => c.bonding_curve), { encoding: "base64" }]);
        const vals = (res && res.value) || [];
        slice.forEach((c, idx) => { const acc = vals[idx]; const b64 = acc && acc.data && acc.data[0]; if (b64) { const mc = curveMcapUsd(b64, sol); if (mc != null) curveMap[c.mint] = mc; } });
      } catch (e) { console.error("getMultipleAccounts err:", e.message); }
    }
    let n = 0, mv = 0, t = { mc: 0, soc: 0, hold: 0, top: 0 };
    for (const c of all) {
      const d = await evalOne(c, curveMap[c.mint] != null ? curveMap[c.mint] : null);
      n++; if (d.is_mover) mv++; if (d.cMcap) t.mc++; if (d.cSoc) t.soc++; if (d.cHold) t.hold++; if (d.cTop) t.top++;
    }
    console.log(`sol $${sol} | processed ${n} | curve_mcaps ${Object.keys(curveMap).length} | in_range ${t.mc} | social ${t.soc} | holders50 ${t.hold} | top10ok ${t.top} | movers_now ${mv}`);
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
