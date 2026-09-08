/**
 * Vercel serverless proxy — api/uniswap.js
 *
 * Routes:
 *   POST /api/uniswap/quote            → /v1/quote
 *   POST /api/uniswap/swap             → /v1/swap
 *   POST /api/uniswap/order            → /v1/order
 *   POST /api/uniswap/check_approval   → /v1/check_approval
 *   GET  /api/uniswap/orders           → /v1/orders (order status poll)
 *
 * Set UNISWAP_API_KEY in Vercel dashboard → Settings → Environment Variables.
 * Never put the key in frontend code.
 */

const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1';

export default async function handler(req, res) {
  /* ── CORS — allow your own origins only ─────────────────────────── */
  const allowed = [
    'https://xrysmond.github.io',
    'https://obsideum.vercel.app', /* replace with your actual Vercel URL */
  ];
  const origin = req.headers.origin || '';
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  /* ── Extract endpoint path from URL ─────────────────────────────── */
  /* req.url is the full path as seen by this function, e.g. /api/uniswap/quote
   * We strip the /api/uniswap prefix to get /quote, /swap, etc.            */
  const segment = req.url.split('?')[0].replace(/^\/api\/uniswap/, '') || '/quote';
  const queryString = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const upstreamUrl = UNISWAP_BASE + segment + queryString;

  /* ── Forward the request ─────────────────────────────────────────── */
  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method:  req.method,
      headers: {
        'Content-Type':               'application/json',
        'Accept':                     'application/json',
        'x-api-key':                  process.env.UNISWAP_API_KEY,
        'x-universal-router-version': '2.0',
      },
      /* Only attach body for methods that have one */
      body: (req.method === 'POST' || req.method === 'PUT')
        ? JSON.stringify(req.body)
        : undefined,
    });

    const data = await upstreamRes.json().catch(function () { return {}; });
    res.status(upstreamRes.status).json(data);

  } catch (err) {
    console.error('[uniswap proxy] upstream error:', err.message);
    res.status(502).json({ error: 'Upstream request failed', detail: err.message });
  }
}
