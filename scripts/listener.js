// scripts/listener.js — PumpPortal new-token listener (GitHub Actions, $0)
// Streams new pump.fun launches → inserts into Supabase new_tokens.
// Env (GitHub Actions Secrets): SUPABASE_URL, SUPABASE_KEY
const WebSocket = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RUN_MS = 5 * 60 * 60 * 1000; // ~5 hours, then exit (workflow restarts)

async function sbInsert(rows) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/new_tokens`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
  } catch (e) { console.error("insert fail:", e.message); }
}
async function prune() {
  // keep last 2 days only (DB chhota rahe)
  const iso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/new_tokens?created_at=lt.${iso}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" },
    });
    console.log("pruned old tokens before", iso);
  } catch (e) { console.error("prune fail:", e.message); }
}

let batch = [];
let count = 0;
async function flush() {
  if (!batch.length) return;
  const b = batch; batch = [];
  count += b.length;
  await sbInsert(b);
  console.log(`flushed ${b.length} (total ${count})`);
}

function connect() {
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  ws.on("open", () => { ws.send(JSON.stringify({ method: "subscribeNewToken" })); console.log("subscribed to new tokens"); });
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (!m || !m.mint) return; // skip confirmation / non-token msgs
      batch.push({
        mint: m.mint,
        name: m.name || null,
        symbol: m.symbol || null,
        dev: m.traderPublicKey || null,
        initial_buy_sol: typeof m.solAmount === "number" ? m.solAmount : null,
        market_cap_sol: typeof m.marketCapSol === "number" ? m.marketCapSol : null,
      });
      if (batch.length >= 25) flush();
    } catch (_) {}
  });
  ws.on("close", () => { console.log("ws closed — reconnecting in 2s"); setTimeout(connect, 2000); });
  ws.on("error", (e) => { console.error("ws error:", e.message); });
}

(async () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_KEY"); process.exit(1); }
  await prune();
  connect();
  setInterval(flush, 5000);                 // har 5s flush
  setTimeout(() => { console.log("run window done, exiting"); process.exit(0); }, RUN_MS);
})();
