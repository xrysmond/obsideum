/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — market.js  (Phase 9H-rebuild)
   Price authority for portfolio USD values.

   SWITCHED: CoinGecko (30 req/min, 429s) → DeFiLlama (500 req/5min, free)

   Architecture:
   ─────────────
   ONE batch request fetches ALL known token prices at once.
   No per-chain stagger. No rate-limit cliff.

   Writes ONLY to STATE.prices — portfolio.js reads this.
   Explore tab owns its own CoinGecko fetch (see explore.js).

   DeFiLlama coin identifier format (verified):
     chain:lowercase_address   e.g.  ethereum:0xa0b869...
     coingecko:slug            e.g.  coingecko:ethereum

   Chain names verified at coins.llama.fi:
     ethereum · optimism · bsc · unichain · polygon · base · arbitrum · avax

   Rate limit: ~500 req / 5 min (free). We do 1 req / 60s — trivially safe.

   window.resolveMarketAddress — kept for explore.js compatibility.
   Resolved from KNOWN_ADDRESSES only (no CoinGecko call — avoids lag).

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     DEFILLAMA CHAIN NAMES
     Verified identifiers for coins.llama.fi/prices/current/
  ════════════════════════════════════════════════════════ */
  var LLAMA_CHAIN = {
    1:      'ethereum',
    10:     'optimism',
    56:     'bsc',
    130:    'unichain',
    137:    'polygon',
    8453:   'base',
    42161:  'arbitrum',
    43114:  'avax',
  };

  /* ════════════════════════════════════════════════════════
     NATIVE TOKEN COINGECKO SLUGS
     DeFiLlama resolves ETH/BNB/etc via coingecko: prefix.
     Maps to which NATIVE_<chainId> keys to write in STATE.prices.
  ════════════════════════════════════════════════════════ */
  var NATIVE_COINS = [
    { cgid: 'coingecko:ethereum',      chains: [1, 10, 130, 8453, 42161] },
    { cgid: 'coingecko:binancecoin',   chains: [56]   },
    { cgid: 'coingecko:matic-network', chains: [137]  },
    { cgid: 'coingecko:avalanche-2',   chains: [43114] },
  ];

  /* ════════════════════════════════════════════════════════
     KNOWN ERC-20 ADDRESSES
     { coingecko_id: { chainId: checksumAddress } }
     Shared with explore.js via window.KNOWN_ADDRESSES.
  ════════════════════════════════════════════════════════ */
  var KNOWN_ADDRESSES = {
    'ethereum':          { 1:'NATIVE', 10:'NATIVE', 130:'NATIVE', 8453:'NATIVE', 42161:'NATIVE' },
    'binancecoin':       { 56:'NATIVE' },
    'matic-network':     { 137:'NATIVE', 1:'0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0' },
    'avalanche-2':       { 43114:'NATIVE' },
    'usd-coin':          { 1:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 10:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 56:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 137:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 42161:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 43114:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
    'tether':            { 1:'0xdAC17F958D2ee523a2206206994597C13D831ec7', 56:'0x55d398326f99059fF775485246999027B3197955', 137:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 42161:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 43114:'0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' },
    'weth':              { 1:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 10:'0x4200000000000000000000000000000000000006', 8453:'0x4200000000000000000000000000000000000006', 42161:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
    'wrapped-bitcoin':   { 1:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 42161:'0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' },
    'dai':               { 1:'0x6B175474E89094C44Da98b954EedeAC495271d0F', 137:'0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 42161:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' },
    'chainlink':         { 1:'0x514910771AF9Ca656af840dff83E8264EcF986CA', 137:'0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', 42161:'0xf97f4df75117a78c1A5a0DBb814Af92458539FB4' },
    'uniswap':           { 1:'0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
    'aave':              { 1:'0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 137:'0xD6DF932A45C0f255f85145f286eA0b292B21C90B', 42161:'0xba5DdD1f9d7F570dc94a51479a000E3BCE967196' },
    'maker':             { 1:'0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' },
    'shiba-inu':         { 1:'0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE' },
    'staked-ether':      { 1:'0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84' },
    'wrapped-steth':     { 1:'0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' },
    'frax':              { 1:'0x853d955aCEf822Db058eb8505911ED77F175b99e' },
    'pancakeswap-token': { 56:'0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' },
    'rocket-pool-eth':   { 1:'0xae78736Cd615f374D3085123A210448E74Fc6393' },
  };

  /* ════════════════════════════════════════════════════════
     BUILD COIN REQUEST
     Returns:
       coinList  — array of DeFiLlama coin identifier strings
       nativeMap — { 'coingecko:ethereum': [chainIds...], ... }
       erc20Map  — { 'chain:lowercase_addr': 'ChecksumAddr' }
  ════════════════════════════════════════════════════════ */
  function buildCoinRequest() {
    var coinList  = [];
    var nativeMap = {};
    var erc20Map  = {};
    var seen      = {};

    /* Native tokens via coingecko: prefix */
    NATIVE_COINS.forEach(function (n) {
      coinList.push(n.cgid);
      nativeMap[n.cgid] = n.chains;
    });

    /* ERC-20 tokens — chain:lowercase_address */
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
        /* erc20Map maps DeFiLlama key → checksummed address for STATE.prices */
        erc20Map[llamaKey] = addr;
      });
    });

    return { coinList: coinList, nativeMap: nativeMap, erc20Map: erc20Map };
  }

  /* ════════════════════════════════════════════════════════
     FETCH PRICES FROM DEFILLAMA
     Single batch request. Parses response into STATE.prices.

     STATE.prices key format (must match portfolio.js):
       Native:  'NATIVE_<chainId>'
       ERC-20:  checksummed contract address string
  ════════════════════════════════════════════════════════ */
  var _request = buildCoinRequest();

  async function fetchPrices() {
    var url = 'https://coins.llama.fi/prices/current/'
      + _request.coinList.join(',')
      + '?searchWidth=4h';

    var res;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal:  AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
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
    try {
      data = await res.json();
    } catch (err) {
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

      /* Native tokens: write to NATIVE_<chainId> for each chain */
      if (_request.nativeMap[key]) {
        _request.nativeMap[key].forEach(function (chainId) {
          pricesUpdate['NATIVE_' + chainId] = priceData;
        });
        return;
      }

      /* ERC-20 tokens: write to checksummed address */
      var checksumAddr = _request.erc20Map[key];
      if (checksumAddr) {
        pricesUpdate[checksumAddr] = priceData;
      }
    });

    if (!Object.keys(pricesUpdate).length) return;

    /* Merge: keep existing prices for tokens not in this batch */
    var merged = Object.assign({}, (window.STATE && STATE.prices) || {}, pricesUpdate);
    setState({ prices: merged });
  }

  /* ════════════════════════════════════════════════════════
     ADDRESS RESOLUTION  (for explore.js token tap)
     Reads KNOWN_ADDRESSES only — no network calls.
     Returns Promise<string|null> for API compatibility.
  ════════════════════════════════════════════════════════ */
  function resolveAddress(entry, chainId) {
    if (entry.address) return Promise.resolve(entry.address);

    var known = KNOWN_ADDRESSES[entry.id];
    if (known && known[chainId]) {
      entry.address = known[chainId];
      return Promise.resolve(entry.address);
    }

    /* Cross-ref STATE.tokenList by symbol (active chain only) */
    var activeChain = window.STATE && STATE.network;
    if (Number(chainId) === Number(activeChain)) {
      var tList = (window.STATE && STATE.tokenList) || [];
      var match = tList.find(function (t) {
        return t.symbol && t.symbol.toUpperCase() === entry.symbol && t.address !== 'NATIVE';
      });
      if (match) {
        entry.address = match.address;
        return Promise.resolve(entry.address);
      }
    }

    return Promise.resolve(null);
  }

  /* ════════════════════════════════════════════════════════
     POLLING
     60s interval. Immediate on load, and again on wallet connect.
  ════════════════════════════════════════════════════════ */
  var _pollTimer = null;

  function startMarketPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    fetchPrices();
    _pollTimer = setInterval(fetchPrices, 60000);
  }

  /* ════════════════════════════════════════════════════════
     GLOBALS — kept for explore.js + app.html compatibility
  ════════════════════════════════════════════════════════ */
  window.resolveMarketAddress = resolveAddress;
  window.KNOWN_ADDRESSES      = KNOWN_ADDRESSES;  /* explore.js reads this */

  /* ════════════════════════════════════════════════════════
     BOOT
  ════════════════════════════════════════════════════════ */
  document.addEventListener('state:wallet', startMarketPolling);
  startMarketPolling();

}());
