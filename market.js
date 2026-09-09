/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — market.js
   Standalone market data layer. Completely decoupled from the
   wallet/DEX layer (prices.js, STATE.tokenList, STATE.network).

   Fetches CoinGecko /coins/markets per chain, stores results
   in STATE.marketData[chainId]. Dispatches state:marketData
   on every update so explore.js re-renders live.

   Category IDs verified against:
     /coins/categories/list endpoint + coingecko.com/en/categories/*
   Platform IDs verified against:
     /asset_platforms endpoint
   Field names verified against:
     /coins/markets OpenAPI spec — standard response (no optional params)

   Free public API. No key required. Rate limit: ~30 req/min.
   Stagger strategy: 400ms between chain fetches per cycle.
   Poll interval: 60s — market data doesn't need to be faster.

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CHAIN → COINGECKO MAPPINGS
     Verified against live CoinGecko endpoints Sep 2026.
  ════════════════════════════════════════════════════════ */

  /*
   * Category slug per chain — used in /coins/markets?category=
   * Source: coingecko.com/en/categories/<slug>
   * Null = chain too new for a dedicated category; falls back
   * to a filtered global top-100 without a category param.
   */
  var CHAIN_CATEGORY = {
    1:      'ethereum-ecosystem',
    10:     'optimism-ecosystem',
    56:     'binance-smart-chain',   /* NOT 'bnb-chain' — verified from URL path */
    130:    null,                    /* Unichain — too new, no category yet */
    137:    'polygon-ecosystem',
    8453:   'base-ecosystem',
    42161:  'arbitrum-ecosystem',
    43114:  'avalanche-ecosystem',
  };

  /*
   * Platform ID per chain — used in /coins/{id} platforms object
   * for contract address resolution on token tap.
   * Source: /asset_platforms endpoint
   */
  var CHAIN_PLATFORM = {
    1:      'ethereum',
    10:     'optimistic-ethereum',
    56:     'binance-smart-chain',
    130:    'unichain',
    137:    'polygon-pos',
    8453:   'base',
    42161:  'arbitrum-one',
    43114:  'avalanche',
  };

  /*
   * CoinGecko coin ID of the native token per chain.
   * These are assigned address = 'NATIVE' automatically
   * so no extra API call is needed for them.
   */
  var CHAIN_NATIVE_CGID = {
    1:      'ethereum',
    10:     'ethereum',
    56:     'binancecoin',
    130:    'ethereum',
    137:    'matic-network',
    8453:   'ethereum',
    42161:  'ethereum',
    43114:  'avalanche-2',
  };

  /*
   * Pre-resolved contract addresses for the most common tokens.
   * Avoids an extra /coins/{id} call on tap for these.
   * Shape: { coingecko_id: { chainId: address } }
   * Addresses are checksummed ERC-20 format or 'NATIVE'.
   */
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
     ADDRESS RESOLUTION
     Called by explore.js on token tap.
     Priority:
       1. KNOWN_ADDRESSES map (instant, no network)
       2. STATE.tokenList cross-ref (instant, active chain only)
       3. CoinGecko /coins/{id} (one fetch, cached on entry)
     Returns Promise<string|null>
  ════════════════════════════════════════════════════════ */
  function resolveAddress(entry, chainId) {
    /* 1. Already resolved in a prior call */
    if (entry.address) return Promise.resolve(entry.address);

    /* 2. Known address map */
    var known = KNOWN_ADDRESSES[entry.id];
    if (known && known[chainId]) {
      entry.address = known[chainId];
      return Promise.resolve(entry.address);
    }

    /* 3. Cross-reference active chain's wallet tokenList */
    var activeChain = window.STATE && STATE.network;
    if (Number(chainId) === Number(activeChain)) {
      var tList = (window.STATE && STATE.tokenList) || [];
      var match = tList.find(function (t) {
        return t.symbol.toUpperCase() === entry.symbol && t.address !== 'NATIVE';
      });
      if (match) {
        entry.address = match.address;
        return Promise.resolve(entry.address);
      }
    }

    /* 4. On-demand CoinGecko /coins/{id} fetch
     * Uses platforms object which maps platform ID → contract address.
     * Field verified: data.platforms["ethereum"] = "0x..." */
    var platform = CHAIN_PLATFORM[chainId];
    if (!platform) return Promise.resolve(null);

    return fetch(
      'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(entry.id)
        + '?localization=false&tickers=false&market_data=false'
        + '&community_data=false&developer_data=false&sparkline=false',
      { headers: { Accept: 'application/json' } }
    )
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var addr = (data && data.platforms && data.platforms[platform]) || null;
        if (addr) entry.address = addr; /* cache on entry object */
        return addr;
      })
      .catch(function (err) {
        console.warn('[market.js] resolveAddress', entry.id, err.message);
        return null;
      });
  }

  /* ════════════════════════════════════════════════════════
     FETCH MARKET DATA FOR ONE CHAIN
  ════════════════════════════════════════════════════════ */
  var _inFlight = {};

  async function fetchChain(chainId) {
    if (_inFlight[chainId]) return;
    _inFlight[chainId] = true;

    var category = CHAIN_CATEGORY[chainId] || null;

    /*
     * /coins/markets endpoint.
     * Fields used:
     *   id, symbol, name, image          — always present
     *   current_price                    — always present
     *   price_change_percentage_24h      — always present (NO extra param needed)
     *   total_volume, market_cap         — always present
     *   market_cap_rank                  — always present
     *
     * NOTE: price_change_percentage_24h_in_currency is a DIFFERENT field
     * only populated when ?price_change_percentage=24h is passed.
     * We use price_change_percentage_24h — simpler, always there.
     */
    var url = 'https://api.coingecko.com/api/v3/coins/markets'
      + '?vs_currency=usd'
      + '&order=market_cap_desc'
      + '&per_page=100'
      + '&page=1'
      + '&sparkline=false'
      + (category ? '&category=' + encodeURIComponent(category) : '');

    try {
      var res = await fetch(url, { headers: { Accept: 'application/json' } });

      if (res.status === 429) {
        console.warn('[market.js] Rate limited on chain', chainId, '— retaining stale data');
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);

      var coins = await res.json();
      if (!Array.isArray(coins)) throw new Error('Response is not an array');

      var nativeCgId = CHAIN_NATIVE_CGID[chainId] || null;

      var tokens = coins.map(function (c) {
        var addr = null;
        if (c.id === nativeCgId) {
          addr = 'NATIVE';
        } else {
          var k = KNOWN_ADDRESSES[c.id];
          if (k && k[chainId]) addr = k[chainId];
        }

        return {
          id:        c.id,
          symbol:    (c.symbol || '').toUpperCase(),
          name:      c.name   || '',
          image:     c.image  || '',
          price:     typeof c.current_price             === 'number' ? c.current_price             : null,
          change24h: typeof c.price_change_percentage_24h === 'number' ? c.price_change_percentage_24h : null,
          volume24h: typeof c.total_volume              === 'number' ? c.total_volume              : null,
          marketCap: typeof c.market_cap                === 'number' ? c.market_cap                : null,
          rank:      c.market_cap_rank || null,
          address:   addr,
        };
      });

      /* Merge into STATE.marketData — preserve other chains */
      var current = Object.assign({}, (window.STATE && STATE.marketData) || {});
      current[chainId] = tokens;
      setState({ marketData: current });

    } catch (err) {
      console.warn('[market.js] fetchChain', chainId, 'failed:', err.message);
    } finally {
      _inFlight[chainId] = false;
    }
  }

  /* ════════════════════════════════════════════════════════
     POLLING
     Stagger: 400ms between chains to stay well within
     the 30 req/min free tier limit.
     (8 active chains × 1 req = 8 req per 60s cycle = safe)
  ════════════════════════════════════════════════════════ */
  var _pollTimer = null;

  function fetchAllChains() {
    var networks = (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
    networks.forEach(function (chainId, i) {
      setTimeout(function () {
        fetchChain(chainId).catch(function (err) {
          console.warn('[market.js]', err.message);
        });
      }, i * 400);
    });
  }

  function startMarketPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    fetchAllChains();
    _pollTimer = setInterval(fetchAllChains, 60000);
  }

  /* ════════════════════════════════════════════════════════
     GLOBALS
     resolveAddress exposed so explore.js can call it on tap.
  ════════════════════════════════════════════════════════ */
  window.resolveMarketAddress = resolveAddress;
  window.CHAIN_PLATFORM_IDS   = CHAIN_PLATFORM; /* spare reference */

  /* ════════════════════════════════════════════════════════
     BOOT
  ════════════════════════════════════════════════════════ */
  document.addEventListener('state:wallet', startMarketPolling);
  startMarketPolling();

}());
