// Vercel debug endpoint — browser mein khol ke dekho kya ho raha hai
// Open: https://<your-app>.vercel.app/api/debug?code=YOUR_ACCESS_CODE
module.exports = async (req, res) => {
  const code = req.headers["x-access"] || (req.query && req.query.code) || "";
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Access code galat. ?code=... lagao" });
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_KEY;
  if (!URL || !KEY) return res.status(500).json({ error: "Supabase env missing" });
  try {
    const r = await fetch(`${URL}/rest/v1/new_tokens?select=symbol,holders,top10_pct,has_social,cur_mcap_usd,is_mover,evaluated_at&evaluated_at=not.is.null&order=evaluated_at.desc&limit=30`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    const rows = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: rows });

    const s = { evaluated_coins_recent: rows.length, with_mcap_data: 0, mcap_6k_100k: 0, holders_50plus: 0, has_social: 0, top10_under_30: 0, MOVERS: 0 };
    rows.forEach(t => {
      if (t.cur_mcap_usd != null) s.with_mcap_data++;
      if (t.cur_mcap_usd != null && t.cur_mcap_usd >= 6000 && t.cur_mcap_usd <= 100000) s.mcap_6k_100k++;
      if (t.holders != null && t.holders >= 50) s.holders_50plus++;
      if (t.has_social) s.has_social++;
      if (t.top10_pct != null && t.top10_pct < 30) s.top10_under_30++;
      if (t.is_mover) s.MOVERS++;
    });
    res.setHeader("Content-Type", "application/json");
    res.status(200).json({ summary: s, note: "Agar evaluated_coins_recent=0 -> worker enricher nahi chal raha. Warna dekho kaunsa filter 0 hai.", sample: rows.slice(0, 12) }, null, 2);
  } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
};
