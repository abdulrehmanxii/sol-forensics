// Vercel debug — open: https://<app>.vercel.app/api/debug?code=YOUR_ACCESS_CODE
module.exports = async (req, res) => {
  const code = req.headers["x-access"] || (req.query && req.query.code) || "";
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Access code galat. ?code=... lagao" });
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_KEY;
  if (!URL || !KEY) return res.status(500).json({ error: "Supabase env missing" });
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

  async function count(filter) {
    try {
      const r = await fetch(`${URL}/rest/v1/new_tokens?select=mint${filter ? "&" + filter : ""}`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
      const cr = r.headers.get("content-range") || "";
      return Number((cr.split("/")[1]) || 0);
    } catch (_) { return -1; }
  }
  try {
    const now = Date.now();
    const h1 = new Date(now - 3600 * 1000).toISOString();
    const h24 = new Date(now - 24 * 3600 * 1000).toISOString();

    const total = await count("");
    const last24 = await count(`created_at=gt.${h24}`);
    const last1 = await count(`created_at=gt.${h1}`);
    const evaluated = await count(`evaluated_at=not.is.null`);
    const movers = await count(`is_mover=eq.true`);

    const nr = await fetch(`${URL}/rest/v1/new_tokens?select=symbol,created_at,evaluated_at,holders,top10_pct,has_social,cur_mcap_usd,is_mover&order=created_at.desc&limit=5`, { headers: H });
    const newest = await nr.json();

    res.setHeader("Content-Type", "application/json");
    res.status(200).json({
      LISTENER: { total_coins: total, last_1h: last1, last_24h: last24, healthy: last1 > 0 ? "YES (coins aa rahe)" : "NO (listener band? worker check karo)" },
      ENRICHER: { evaluated_total: evaluated, movers_total: movers, working: evaluated > 0 ? "YES" : "NO (enricher nahi chala / new code deploy nahi hua)" },
      newest_5: newest,
    });
  } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
};
