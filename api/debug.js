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

    // probe: kya saare enricher columns DB mein hain?
    let colsOk = true, colErr = null;
    try {
      const pr = await fetch(`${URL}/rest/v1/new_tokens?select=image,tw,tg,web,holders,top10_pct,has_social,cur_mcap_usd,is_mover,evaluated_at&limit=1`, { headers: H });
      if (!pr.ok) { colsOk = false; colErr = (await pr.text()).slice(0, 200); }
    } catch (e) { colsOk = false; colErr = String(e.message); }

    // jo coins EVALUATE ho chuke — unki values + kaunsa filter reject kar raha
    const er = await fetch(`${URL}/rest/v1/new_tokens?select=symbol,holders,top10_pct,has_social,cur_mcap_usd,is_mover,evaluated_at&evaluated_at=not.is.null&order=evaluated_at.desc&limit=40`, { headers: H });
    const ev = await er.json();
    const A = { sample: (ev || []).length, with_mcap_data: 0, mcap_6k_100k: 0, holders_50plus: 0, has_social: 0, top10_under_30: 0, MOVERS: 0 };
    (ev || []).forEach(t => {
      if (t.cur_mcap_usd != null) A.with_mcap_data++;
      if (t.cur_mcap_usd != null && t.cur_mcap_usd >= 6000 && t.cur_mcap_usd <= 100000) A.mcap_6k_100k++;
      if (t.holders != null && t.holders >= 50) A.holders_50plus++;
      if (t.has_social) A.has_social++;
      if (t.top10_pct != null && t.top10_pct < 30) A.top10_under_30++;
      if (t.is_mover) A.MOVERS++;
    });

    res.setHeader("Content-Type", "application/json");
    res.status(200).json({
      LISTENER: { total_coins: total, last_1h: last1, last_24h: last24, healthy: last1 > 0 ? "YES" : "NO" },
      ENRICHER: { evaluated_total: evaluated, movers_total: movers, working: evaluated > 0 ? "YES" : "NO" },
      COLUMNS_ALL_PRESENT: colsOk ? "YES" : "NO — ye SQL chalao!",
      WHICH_FILTER_REJECTS: A,
      sample_evaluated: (ev || []).slice(0, 12),
    });
  } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
};
