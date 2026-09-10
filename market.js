/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — market.js  (Phase 9H-rebuild v2)

   PRICE AUTHORITY — DeFiLlama only.
   One batch request covers every known token on every chain.
   Rate limit: ~500 req / 5 min.  We send 1 req / 60s. Trivially safe.

   STATE written:
     STATE.prices — { 'NATIVE_<chainId>': {usd,change24h,updatedAt},
                      '<checksumAddr>':    {usd,change24h,updatedAt} }

   STATE NOT written:
     STATE.marketData — no longer used. explore.js owns its own fetch.

   Globals exported for explore.js and prices.js:
     window.KNOWN_ADDRESSES       — CoinGecko-ID → { chainId: address }
     window.OBSIDEUM_SUBGRAPH_IDS — chainId → The Graph subgraph ID
     window.OBSIDEUM_GRAPH_KEY    — The Graph API key
     window.resolveMarketAddress  — (entry, chainId) → Promise<addr|null>

   Verified addresses (sources in comments):
     ARB    arbiscan.io + sharpe.ai/rug-check/chain/arbitrum/arb
     GMX    sharpe.ai/rug-check/chain/arbitrum/gmx + governance.aave.com
     PENDLE sharpe.ai/rug-check/chain/arbitrum/pendle + portals.fi confirmed
     XVS    sharpe.ai/rug-check/chain/bsc/xvs
     OP     moralis explorer confirmed
     AERO   moralis explorer + matcha.xyz confirmed

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────────
     DEFILLAMA CHAIN NAMES  (verified: coins.llama.fi documentation)
  ────────────────────────────────────────────────────────────────── */
  var LLAMA_CHAIN = {
    1:     'ethereum',
    10:    'optimism',
    56:    'bsc',
    130:   'unichain',
    137:   'polygon',
    8453:  'base',
    42161: 'arbitrum',
    43114: 'avax',
  };

  /* ──────────────────────────────────────────────────────────────────
     NATIVE TOKEN COINGECKO SLUGS
     DeFiLlama resolves native assets via coingecko: prefix.
     Maps to which NATIVE_<chainId> keys to write in STATE.prices.
  ────────────────────────────────────────────────────────────────── */
  var NATIVE_COINS = [
    { cgid: 'coingecko:ethereum',      chains: [1, 10, 130, 8453, 42161] },
    { cgid: 'coingecko:binancecoin',   chains: [56]    },
    { cgid: 'coingecko:matic-network', chains: [137]   },
    { cgid: 'coingecko:avalanche-2',   chains: [43114] },
  ];

  /* ──────────────────────────────────────────────────────────────────
     KNOWN ADDRESSES
     { coingecko_id: { chainId: checksumAddress } }

     NATIVE means the chain's native token — use address='NATIVE' in STATE.
     ERC-20 addresses are checksummed (EIP-55).

     Sources for new additions:
       ARB     0x912C...  arbiscan.io/token + sharpe.ai confirmed
       GMX     0xfc5A...  sharpe.ai rug-check + aave governance proposal
       PENDLE  0x0c88...  sharpe.ai rug-check + portals.fi Verified tag
       XVS     0xcF6B...  sharpe.ai rug-check confirmed
       OP      0x4200...42  moralis explorer confirmed
       AERO    0x9401...  moralis explorer + matcha.xyz confirmed
  ────────────────────────────────────────────────────────────────── */
  var KNOWN_ADDRESSES = {
    /* ── Natives ──────────────────────────────────────────────────── */
    'ethereum':          { 1:'NATIVE', 10:'NATIVE', 130:'NATIVE', 8453:'NATIVE', 42161:'NATIVE' },
    'binancecoin':       { 56:'NATIVE' },
    'matic-network':     { 137:'NATIVE', 1:'0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0' },
    'avalanche-2':       { 43114:'NATIVE' },

    /* ── Stablecoins ──────────────────────────────────────────────── */
    'usd-coin': {
      1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      56:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    },
    'tether': {
      1:     '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      56:    '0x55d398326f99059fF775485246999027B3197955',
      137:   '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      43114: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    },

    /* ── Wrapped assets ───────────────────────────────────────────── */
    'weth': {
      1:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      10:    '0x4200000000000000000000000000000000000006',
      8453:  '0x4200000000000000000000000000000000000006',
      42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    'wrapped-bitcoin': {
      1:     '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      42161: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    },

    /* ── DeFi blue-chips (Ethereum) ───────────────────────────────── */
    'dai': {
      1:     '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      137:   '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      42161: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    },
    'chainlink': {
      1:     '0x514910771AF9Ca656af840dff83E8264EcF986CA',
      137:   '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
      42161: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    },
    'uniswap':      { 1: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
    'aave': {
      1:     '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
      137:   '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
      42161: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
    },
    'maker':         { 1: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' },
    'shiba-inu':     { 1: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE' },
    'staked-ether':  { 1: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' },
    'wrapped-steth': { 1: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' },
    'frax':          { 1: '0x853d955aCEf822Db058eb8505911ED77F175b99e' },
    'rocket-pool-eth': { 1: '0xae78736Cd615f374D3085123A210448E74Fc6393' },

    /* ── Arbitrum ecosystem  (verified addresses) ─────────────────── */
    /* ARB: arbiscan.io/token/0x912c... + sharpe.ai confirmed */
    'arbitrum': { 42161: '0x912CE59144191C1204E64559FE8253a0e49E6548' },
    /* GMX: sharpe.ai rug-check + aave governance proposal 0xfc5A... */
    'gmx':      { 42161: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a' },
    /* PENDLE: sharpe.ai "canonical Arbitrum address is 0x0c88..." */
    'pendle':   {
      42161: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
      8453:  '0xa99f6e6785da0f5d6fb42495fe424bce029eeb3e',
    },

    /* ── BNB Chain ecosystem ──────────────────────────────────────── */
    /* CAKE: already canonical in original file */
    'pancakeswap-token': { 56: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' },
    /* XVS: sharpe.ai "canonical BNB Chain address is 0xcF6B..." */
    'venus':             { 56: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63' },

    /* ── Optimism ecosystem ───────────────────────────────────────── */
    /* OP: moralis explorer confirmed 0x4200...42 on optimism */
    'optimism': { 10: '0x4200000000000000000000000000000000000042' },

    /* ── Base ecosystem ───────────────────────────────────────────── */
    /* AERO: moralis explorer + matcha.xyz confirmed 0x9401... */
    'aerodrome-finance': { 8453: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' },
  };

  /* ──────────────────────────────────────────────────────────────────
     THE GRAPH — UNISWAP V3 SUBGRAPH IDs
     Exported on window so explore.js and prices.js can share them.
     Used by explore.js for background token list fetching.
  ────────────────────────────────────────────────────────────────── */
  var SUBGRAPH_IDS = {
    1:     '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
    10:    'Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj',
    56:    'F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2',
    130:   'BCfy6Vw9No3weqVq9NhyGo4FkVCJep1ZN9RMJj5S32fX',
    137:   '3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm',
    8453:  '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG',
    42161: 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM',
    43114: 'GVH9h9KZ9CqheUEL93qMbq7QwgoBu32QXQDPR6bev4Eo',
  };

  var GRAPH_API_KEY = 'ba6a6c595dff86ed9d73903bcca93b22';

  /* ──────────────────────────────────────────────────────────────────
     BUILD DEFILLAMA COIN REQUEST
     Returns the full list of coin identifiers for one batch fetch,
     plus lookup maps for parsing the response back into STATE.prices keys.
  ────────────────────────────────────────────────────────────────── */
  function buildCoinRequest() {
    var coinList  = [];
    var nativeMap = {};  /* 'coingecko:ethereum' → [chainIds] */
    var erc20Map  = {};  /* 'chain:lowercaseAddr' → checksumAddr */
    var seen      = {};

    NATIVE_COINS.forEach(function (n) {
      coinList.push(n.cgid);
      nativeMap[n.cgid] = n.chains;
    });

    Object.keys(KNOWN_ADDRESSES).forEach(function (cgid) {
      var chainMap = KNOWN_ADDRESSES[cgid];
      Object.keys(chainMap).forEach(function (chainId) {
        var addr = chainMap[chainId];
        if (addr === 'NATIVE') return;

        var llamaChain = LLAMA_CHAIN[Number(chainId)];
        if (!llamaChain) return;

        var llamaKey = llamaChain + ':' + addr.toLowerCase();
        if (seen[llamaKey]) return;
        seen[llamaKey] = true;

        coinList.push(llamaKey);
        erc20Map[llamaKey] = addr;  /* checksum preserved from KNOWN_ADDRESSES */
      });
    });

    return { coinList: coinList, nativeMap: nativeMap, erc20Map: erc20Map };
  }

  /* ──────────────────────────────────────────────────────────────────
     FETCH PRICES FROM DEFILLAMA
     Single batch GET request. searchWidth=4h gives the most recent
     price even for low-liquidity tokens without a perfect match.
  ────────────────────────────────────────────────────────────────── */
  var _req = buildCoinRequest();

  async function fetchPrices() {
    var url = 'https://coins.llama.fi/prices/current/'
            + _req.coinList.join(',')
            + '?searchWidth=4h';

    var res;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal:  (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
                   ? AbortSignal.timeout(12000)
                   : undefined,
      });
    } catch (err) {
      console.warn('[market.js] DeFiLlama fetch error:', err.message);
      return;
    }

    if (!res.ok) {
      console.warn('[market.js] DeFiLlama HTTP', res.status);
      return;
    }

    var data;
    try { data = await res.json(); }
    catch (err) {
      console.warn('[market.js] DeFiLlama parse error:', err.message);
      return;
    }

    var coins = data && data.coins;
    if (!coins || typeof coins !== 'object') return;

    var now          = Math.floor(Date.now() / 1000);
    var pricesUpdate = {};

    Object.keys(coins).forEach(function (key) {
      var entry = coins[key];
      if (!entry || typeof entry.price !== 'number' || !isFinite(entry.price)) return;

      var priceData = { usd: entry.price, change24h: null, updatedAt: now };

      if (_req.nativeMap[key]) {
        _req.nativeMap[key].forEach(function (chainId) {
          pricesUpdate['NATIVE_' + chainId] = priceData;
        });
        return;
      }

      var checksumAddr = _req.erc20Map[key];
      if (checksumAddr) pricesUpdate[checksumAddr] = priceData;
    });

    if (!Object.keys(pricesUpdate).length) return;

    var merged = Object.assign({}, (window.STATE && STATE.prices) || {}, pricesUpdate);
    setState({ prices: merged });
  }

  /* ──────────────────────────────────────────────────────────────────
     ADDRESS RESOLUTION  (called by explore.js tap handler)
     Fast path: KNOWN_ADDRESSES + STATE.tokenList for active chain.
     No network calls here — explore.js uses its own token list cache
     for deeper resolution on non-active chains.
  ────────────────────────────────────────────────────────────────── */
  function resolveMarketAddress(entry, chainId) {
    /* Already resolved (set by fetchChain or a previous tap) */
    if (entry.address) return Promise.resolve(entry.address);

    /* KNOWN_ADDRESSES — fastest path */
    var known = KNOWN_ADDRESSES[entry.id];
    if (known && known[chainId]) {
      entry.address = known[chainId];
      return Promise.resolve(entry.address);
    }

    /* STATE.tokenList — only valid for the wallet's active chain */
    var activeChain = window.STATE && Number(STATE.network);
    if (Number(chainId) === activeChain) {
      var list  = (window.STATE && STATE.tokenList) || [];
      var sym   = (entry.symbol || '').toUpperCase();
      var match = list.find(function (t) {
        return t.symbol && t.symbol.toUpperCase() === sym && t.address !== 'NATIVE';
      });
      if (match) {
        entry.address = match.address;
        return Promise.resolve(entry.address);
      }
    }

    return Promise.resolve(null);
  }

  /* ──────────────────────────────────────────────────────────────────
     POLLING — 60s interval, immediate on load and on wallet connect.
  ────────────────────────────────────────────────────────────────── */
  var _pollTimer = null;

  function startMarketPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    fetchPrices();
    _pollTimer = setInterval(fetchPrices, 60000);
  }

  /* ──────────────────────────────────────────────────────────────────
     GLOBALS — shared with explore.js and app.html
  ────────────────────────────────────────────────────────────────── */
  window.KNOWN_ADDRESSES       = KNOWN_ADDRESSES;
  window.OBSIDEUM_SUBGRAPH_IDS = SUBGRAPH_IDS;
  window.OBSIDEUM_GRAPH_KEY    = GRAPH_API_KEY;
  window.resolveMarketAddress  = resolveMarketAddress;

  /* ──────────────────────────────────────────────────────────────────
     BOOT
  ────────────────────────────────────────────────────────────────── */
  document.addEventListener('state:wallet', startMarketPolling);
  startMarketPolling();

}());
