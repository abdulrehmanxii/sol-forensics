// Vercel serverless — reads new_tokens (live feed) with filters
// Env: SUPABASE_URL, SUPABASE_KEY, ACCESS_CODE
module.exports = async (req, res) => {
  const code = req.headers["x-access"] || "";
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Access code galat" });
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_KEY;
  if (!URL || !KEY) return res.status(500).json({ error: "Supabase env missing" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const minMcap = Number(body.minMcap) || 0;
  const minBuy = Number(body.minDevBuy) || 0;
  const search = (body.search || "").trim();
  const limit = Math.min(Number(body.limit) || 60, 100);

  let q = `new_tokens?select=*&order=created_at.desc&limit=${limit}`;
  if (body.movers) {
    q += `&is_mover=eq.true`;
  } else {
    if (minMcap > 0) q += `&market_cap_sol=gte.${minMcap}`;
    if (minBuy > 0) q += `&initial_buy_sol=gte.${minBuy}`;
  }
  if (search) { const s = encodeURIComponent(`*${search}*`); q += `&or=(name.ilike.${s},symbol.ilike.${s})`; }

  try {
    const r = await fetch(`${URL}/rest/v1/${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: `supabase ${r.status}: ${txt.slice(0, 160)}` });
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(txt);
  } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
};
