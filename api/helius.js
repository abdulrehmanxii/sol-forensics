// Vercel serverless function — server-side proxy (key hidden in env)
// Env vars required:  HELIUS_API_KEY  (your Helius key)
//                     ACCESS_CODE     (shared passcode for you + friends)
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const code = req.headers["x-access"] || "";
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: "Access code galat" });

  const KEY = process.env.HELIUS_API_KEY;
  if (!KEY) return res.status(500).json({ error: "server key missing (HELIUS_API_KEY)" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  try {
    let r;
    if (body.type === "parse") {
      r = await fetch(`https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: body.signatures || [] })
      });
    } else if (body.type === "enh") {
      let url = `https://api-mainnet.helius-rpc.com/v0/addresses/${body.address}/transactions?api-key=${KEY}&limit=100`;
      if (body.before) url += `&before=${body.before}`;
      r = await fetch(url);
    } else {
      r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: body.method, params: body.params }),
      });
    }
    const text = await r.text();
    res.setHeader("Content-Type", "application/json");
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
