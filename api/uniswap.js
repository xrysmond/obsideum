const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const API_KEY      = process.env.UNISWAP_API_KEY; /* set this in Vercel dashboard */

export default async function handler(req, res) {
  /* Only allow POST from your own origin */
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', 'https://xrysmond.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).end(); return; }

  /* The path after /api/uniswap — e.g. /quote, /swap, /check_approval, /order */
  const path = req.url.replace('/api/uniswap', '') || '/quote';

  try {
    const upstream = await fetch(UNISWAP_BASE + path, {
      method:  'POST',
      headers: {
        'Content-Type':               'application/json',
        'Accept':                     'application/json',
        'x-api-key':                  API_KEY,
        'x-universal-router-version': '2.0',
      },
      body: JSON.stringify(req.body),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Upstream failed', detail: err.message });
  }
}
