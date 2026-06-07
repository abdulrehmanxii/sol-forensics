// Vercel serverless — "Track this coin" → inserts into Supabase tracked_coins
// Env (Vercel): SUPABASE_URL, SUPABASE_KEY (service_role), ACCESS_CODE
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const code = req.headers["x-access"] || "";
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Access code galat" });

  const URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_KEY;
  if (!URL || !KEY) return res.status(500).json({ error: "Supabase env missing (SUPABASE_URL / SUPABASE_KEY)" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const mint = (body.mint || "").trim();
  const symbol = (body.symbol || "").trim() || null;
  if (!mint) return res.status(400).json({ error: "mint required" });

  try {
    const r = await fetch(`${URL}/rest/v1/tracked_coins`, {
      method: "POST",
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({ mint, symbol, active: true }),
    });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: `supabase ${r.status}: ${txt.slice(0, 160)}` });
    return res.status(200).json({ ok: true, tracked: mint });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
