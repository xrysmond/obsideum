/* prices.js — Phase 9C: Multi-chain token discovery via Uniswap V3 Subgraph
 *           — Phase 9B: Uniswap V3 Subgraph live prices · 15s polling (replaces Phase 7A Chainlink)
 *           — Phase 7B: Uniswap V3 subgraph · real price history · 24H/7D/30D
 *           — Phase 7C: Token metadata · 24h volume
 *
 * Live prices (Phase 9B):
 *   Active chain's Uniswap V3 Subgraph via The Graph decentralised network.
 *   Formula: token.derivedETH × bundle.ethPriceUSD = priceUSD
 *   Subgraph IDs verified for all 8 chains from official 0xddaa-760f7f deployer.
 *   Endpoint: gateway.thegraph.com/api/{key}/subgraphs/id/{id}
 *
 * Token discovery (Phase 9C):
 *   loadTokenList(chainId) — queries top 100 tokens by TVL per chain.
 *   Native token prepended per chain. Called on network switch and boot.
 *
 * Chart history (Phase 7B):
 *   Subgraph ID: 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV (Uniswap v3 Ethereum mainnet)
 *   Schema: TokenHourData.periodStartUnix, TokenHourData.priceUSD
 *           TokenDayData.date, TokenDayData.priceUSD
 *
 * The Graph API key stored in THE_GRAPH_API_KEY constant below.
 *
 * renderChart() — untouched. Data shape: [[timestamp_ms, price_usd], ...]
 * UNCHAINED9. Built by Waeven Xrysmond.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
     PHASE 9B — UNISWAP V3 SUBGRAPH — LIVE PRICES

     Replaces Phase 7A (Chainlink). No Chainlink references remain.
     Queries the active chain's subgraph for top 100 tokens by TVL.
     Formula: token.derivedETH × bundle.ethPriceUSD = priceUSD.
     Subgraph IDs verified for all 8 supported chains.
  ───────────────────────────────────────────────────────────────── */
  var SUBGRAPH_IDS = {
    1:     '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV', /* Ethereum     — verified */
    10:    'Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj', /* Optimism     — verified */
    56:    'F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2', /* BNB Chain    — verified */
    130:   'BCfy6Vw9No3weqVq9NhyGo4FkVCJep1ZN9RMJj5S32fX', /* Unichain     — verified */
    137:   '3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm', /* Polygon      — verified */
    8453:  '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG', /* Base         — verified */
    42161: 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM', /* Arbitrum One — verified */
    43114: 'GVH9h9KZ9CqheUEL93qMbq7QwgoBu32QXQDPR6bev4Eo', /* Avalanche    — verified */
  };

  var _pollInterval = null; /* setInterval handle */

  /*
   * 24h snapshot system — localStorage
   * Stores rolling array of { p: price, t: timestamp_ms } per token address.
   * get24hChange() finds the snapshot closest to exactly 24h ago (±4h tolerance).
   * Returns null if no qualifying snapshot exists — UI shows '—'.
   */
  var _SNAP_KEY = 'obsideum:priceSnap:v1';

  function savePriceSnapshot(address, price) {
    try {
      var snaps = JSON.parse(localStorage.getItem(_SNAP_KEY) || '{}');
      var now   = Date.now();
      var arr   = snaps[address] || [];

      /* Prune anything older than 30h */
      arr = arr.filter(function (s) { return now - s.t < 30 * 3600000; });

      /* Only append if the last snapshot is more than 20 minutes old */
      var last = arr[arr.length - 1];
      if (!last || now - last.t > 20 * 60000) {
        arr.push({ p: price, t: now });
      }

      snaps[address] = arr;
      localStorage.setItem(_SNAP_KEY, JSON.stringify(snaps));
    } catch (_) {}
  }

  function get24hChange(address, currentPrice) {
    try {
      var snaps  = JSON.parse(localStorage.getItem(_SNAP_KEY) || '{}');
      var arr    = snaps[address] || [];
      var target = Date.now() - 24 * 3600000;
      var best   = null;

      arr.forEach(function (s) {
        var diff = Math.abs(s.t - target);
        if (diff < 4 * 3600000) { /* ±4h tolerance around the 24h mark */
          if (!best || diff < Math.abs(best.t - target)) best = s;
        }
      });

      if (!best || !best.p) return null;
      return ((currentPrice - best.p) / best.p) * 100;
    } catch (_) {
      return null;
    }
  }

  /*
   * updateAllPrices(chainId)
   * Queries the specified chain's Uniswap V3 Subgraph for top 100 tokens by TVL.
   * Also stores the bundle's ethPriceUSD as 'NATIVE_<chainId>' — the chain's
   * native token price (ETH on Ethereum/Arbitrum/etc, BNB on BNB Chain, AVAX on Avalanche).
   * Formula: token.derivedETH × bundle.ethPriceUSD = priceUSD.
   * Stablecoins with near-zero derivedETH are anchored to $1.00 (correct peg).
   * On failure: logs error, preserves last known STATE.prices — never clears it.
   */
  async function updateAllPrices(chainId) {
    chainId        = Number(chainId) || (window.STATE && STATE.network) || 1;
    var subgraphId = SUBGRAPH_IDS[chainId] || SUBGRAPH_IDS[1];
    var endpoint   = 'https://gateway.thegraph.com/api/' + THE_GRAPH_API_KEY + '/subgraphs/id/' + subgraphId;

    var query = `{
      bundle(id: "1") { ethPriceUSD }
      tokens(
        first: 100
        orderBy: totalValueLockedUSD
        orderDirection: desc
        where: { totalValueLockedUSD_gt: "50000" }
      ) {
        id
        derivedETH
      }
    }`;

    try {
      var res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query: query }),
      });

      if (!res.ok) throw new Error('Subgraph HTTP ' + res.status);

      var json = await res.json();
      if (!json.data) throw new Error('Subgraph returned no data');

      var ethPrice = parseFloat(json.data.bundle.ethPriceUSD);
      var updates  = {};

      /* Store native token price per chain.
       * Key: 'NATIVE_<chainId>' — portfolio.js reads this for native balance USD.
       * On ETH mainnet: ethPrice = ETH price. On BNB Chain: ethPrice = BNB price.
       * On Arbitrum: ethPrice = ETH price. Subgraph bundle always reflects the chain's
       * native asset pricing basis, making this key correct for every chain. */
      var nativeKey     = 'NATIVE_' + chainId;
      var nativeChange  = get24hChange(nativeKey, ethPrice);
      savePriceSnapshot(nativeKey, ethPrice);
      updates[nativeKey] = {
        usd:       ethPrice,
        change24h: nativeChange,
        updatedAt: Math.floor(Date.now() / 1000),
      };

      json.data.tokens.forEach(function (token) {
        var addr    = ethers.utils.getAddress(token.id); /* normalise to checksum */
        var derived = parseFloat(token.derivedETH);
        var usd     = derived * ethPrice;

        /* Stablecoins: derivedETH is near-zero — anchor to correct peg ($1.00) */
        if (derived < 0.001 && usd < 2) usd = 1.00;

        var change24h = get24hChange(addr, usd);
        savePriceSnapshot(addr, usd);

        updates[addr] = {
          usd:       usd,
          change24h: change24h,
          updatedAt: Math.floor(Date.now() / 1000),
        };
      });

      var merged = Object.assign({}, (window.STATE && STATE.prices) || {}, updates);
      setState({ prices: merged });

    } catch (err) {
      /* Preserve last known prices — never clear STATE.prices on failure.
       * Portfolio layer detects staleness via updatedAt on next balance refresh. */
      console.error('[prices.js] updateAllPrices failed:', err.message);
    }
  }

  /*
   * updateAllChainPrices()
   * Fires updateAllPrices() for every active chain simultaneously.
   * This ensures NATIVE_<chainId> prices exist for all chains the user holds assets on.
   * Without this, native balances on non-active chains compute as $0 USD.
   */
  async function updateAllChainPrices() {
    var activeNetworks = (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
    await Promise.all(
      activeNetworks.map(function (cid) {
        return updateAllPrices(cid).catch(function (err) {
          console.warn('[prices.js] Chain', cid, 'price update failed:', err.message);
        });
      })
    );
  }

  /*
   * startPricePolling()
   * Clears any existing interval, fetches immediately across ALL active chains,
   * polls every 15s.
   * Called at file load and whenever wallet or network state changes.
   */
  function startPricePolling() {
    if (_pollInterval) clearInterval(_pollInterval);
    updateAllChainPrices();
    _pollInterval = setInterval(updateAllChainPrices, 15000);
  }

  /* ─────────────────────────────────────────────────────────────────
     PHASE 9C — MULTI-CHAIN TOKEN DISCOVERY

     Queries the active chain's Uniswap V3 Subgraph for the top 100
     tokens by TVL. Native token prepended per chain definition.
     Called on network switch, wallet connect, and boot.

     On failure: logs error. STATE.tokenList keeps its previous value.
     Portfolio and swap show whatever was last loaded — never blank.
  ───────────────────────────────────────────────────────────────── */

  /*
   * NATIVE_TOKENS
   * Leading token for each supported chain — prepended to the discovered list.
   * address: 'NATIVE' — sentinel used by portfolio.js and transfer.js to
   * distinguish ETH/BNB/AVAX sends from ERC-20 transfers.
   */
  var NATIVE_TOKENS = {
    1:      { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    10:     { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    56:     { address: 'NATIVE', symbol: 'BNB',  name: 'BNB',       decimals: 18 },
    130:    { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    137:    { address: 'NATIVE', symbol: 'POL',  name: 'Polygon',   decimals: 18 },
    8453:   { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    42161:  { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    43114:  { address: 'NATIVE', symbol: 'AVAX', name: 'Avalanche', decimals: 18 },
  };

  /*
   * loadTokenList(chainId)
   * Fetches top 100 tokens by TVL from the chain's Uniswap V3 Subgraph.
   * Prepends the native token for the chain.
   * Writes result to STATE.tokenList via setState — triggers state:tokenList.
   *
   * On unsupported chainId: returns immediately (no-op).
   * On fetch/parse failure: logs error, STATE.tokenList unchanged.
   */
  async function loadTokenList(chainId) {
    var subgraphId = SUBGRAPH_IDS[chainId];
    if (!subgraphId) return; /* unsupported chain — fail silently */

    var endpoint = 'https://gateway.thegraph.com/api/' + THE_GRAPH_API_KEY + '/subgraphs/id/' + subgraphId;

    var query = `{
      tokens(
        first: 100
        orderBy: totalValueLockedUSD
        orderDirection: desc
        where: { totalValueLockedUSD_gt: "50000" }
      ) {
        id symbol name decimals
      }
    }`;

    try {
      var res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query: query }),
      });

      if (!res.ok) throw new Error('Token discovery HTTP ' + res.status);

      var json = await res.json();
      if (!json.data || !json.data.tokens) throw new Error('No token data in response');

      var native     = NATIVE_TOKENS[chainId];
      var discovered = json.data.tokens.map(function (t) {
        return {
          address:  ethers.utils.getAddress(t.id), /* normalise to checksum */
          symbol:   t.symbol,
          name:     t.name,
          decimals: parseInt(t.decimals, 10),
        };
      });

      /* Native token always leads the list — portfolio.js and transfer.js
       * use address === 'NATIVE' to distinguish ETH/native sends */
      var tokenList = native ? [native].concat(discovered) : discovered;
      setState({ tokenList: tokenList });

    } catch (err) {
      /* STATE.tokenList keeps its previous value.
       * If tokenList is empty and wallet is connected,
       * portfolio.js renders the error state on next mount. */
      console.error('[prices.js] loadTokenList failed (chain ' + chainId + '):', err.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     PHASE 7B — UNISWAP V3 SUBGRAPH — CHART HISTORY

     Endpoint: The Graph decentralized network.
     Subgraph ID verified at:
       developers.uniswap.org/docs/ecosystem/subgraphs/overview
       ID: 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV (Uniswap v3 mainnet)

     Auth: API key in URL per documented pattern.
     Free tier — no credit card — thegraph.com/studio.

     Subgraph token IDs are always lowercase.
     address.toLowerCase() applied before every query.
  ───────────────────────────────────────────────────────────────── */
  var THE_GRAPH_API_KEY   = 'ba6a6c595dff86ed9d73903bcca93b22';

  var UNISWAP_V3_SUBGRAPH = 'https://gateway.thegraph.com/api/' +
                            THE_GRAPH_API_KEY +
                            '/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

  /* Cache stale thresholds per timeframe */
  var STALE_MS = {
    '24H': 5  * 60 * 1000, /* 5 minutes */
    '7D':  60 * 60 * 1000, /* 1 hour    */
    '30D': 60 * 60 * 1000, /* 1 hour    */
  };

  /*
   * subgraphQuery(query)
   * POST to the Uniswap V3 subgraph via The Graph gateway.
   * Throws on HTTP error or GraphQL errors in the response body.
   */
  async function subgraphQuery(query) {
    var res = await fetch(UNISWAP_V3_SUBGRAPH, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: query }),
    });

    if (!res.ok) {
      throw new Error('[prices.js] Subgraph HTTP ' + res.status);
    }

    var json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error('[prices.js] Subgraph GraphQL: ' + json.errors[0].message);
    }

    return json.data;
  }

  /*
   * isCacheStale(address, timeframe)
   * Returns true when:
   *   - No cache entry exists
   *   - Entry has no prices array
   *   - Entry has no fetchedAt (i.e. was seeded as mock) — always replace
   *   - fetchedAt is older than STALE_MS[timeframe]
   */
  function isCacheStale(address, timeframe) {
    var entry = window.STATE
      && STATE.priceHistory
      && STATE.priceHistory[address]
      && STATE.priceHistory[address][timeframe];

    if (!entry || !entry.prices || !entry.prices.length) return true;
    if (!entry.fetchedAt) return true; /* mock seed — replace with real data */

    return (Date.now() - entry.fetchedAt) > STALE_MS[timeframe];
  }

  /*
   * fetchPriceHistory(address, timeframe)
   * Queries tokenHourDatas (24H) or tokenDayDatas (7D/30D) from the subgraph.
   * Maps response to [[timestamp_ms, price_usd], ...].
   * Filters zero-price points (hours with no swap activity on that token).
   * Writes result to STATE.priceHistory with fetchedAt timestamp.
   * Throws when the subgraph returns no usable data.
   */
  async function fetchPriceHistory(address, timeframe) {
    var laddr = address.toLowerCase();
    var now   = Math.floor(Date.now() / 1000);
    var query;
    var since;

    if (timeframe === '24H') {
      since = now - 24 * 3600;
      query = '{ tokenHourDatas(' +
        'first: 24, ' +
        'orderBy: periodStartUnix, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", periodStartUnix_gt: ' + since + ' }' +
        ') { periodStartUnix priceUSD } }';
    } else if (timeframe === '7D') {
      since = now - 7 * 24 * 3600;
      query = '{ tokenDayDatas(' +
        'first: 7, ' +
        'orderBy: date, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + since + ' }' +
        ') { date priceUSD } }';
    } else { /* 30D */
      since = now - 30 * 24 * 3600;
      query = '{ tokenDayDatas(' +
        'first: 30, ' +
        'orderBy: date, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + since + ' }' +
        ') { date priceUSD } }';
    }

    var data = await subgraphQuery(query);
    var raw;

    if (timeframe === '24H') {
      raw = (data.tokenHourDatas || []).map(function (d) {
        return [d.periodStartUnix * 1000, parseFloat(d.priceUSD)];
      });
    } else {
      raw = (data.tokenDayDatas || []).map(function (d) {
        return [d.date * 1000, parseFloat(d.priceUSD)];
      });
    }

    /* Drop zero-price points — subgraph emits 0 for hours with no swap activity */
    raw = raw.filter(function (pt) { return pt[1] > 0; });

    if (!raw.length) {
      throw new Error('[prices.js] No price history for ' + address + ' [' + timeframe + ']');
    }

    /* Write cache — triggers state:priceHistory */
    var h = Object.assign({}, (window.STATE && STATE.priceHistory) || {});
    if (!h[address]) h[address] = {};
    h[address][timeframe] = { prices: raw, fetchedAt: Date.now() };
    setState({ priceHistory: h });

    return raw;
  }

  /*
   * ensurePriceHistory(address, timeframe)
   * No-op when cache is fresh. Fetches from subgraph when stale or missing.
   */
  async function ensurePriceHistory(address, timeframe) {
    if (!isCacheStale(address, timeframe)) return;
    await fetchPriceHistory(address, timeframe);
  }

  /* ─────────────────────────────────────────────────────────────────
     PHASE 7C — TOKEN METADATA · 24H VOLUME

     Queries the most recent TokenDayData entry for 24h volume.
     Updates .token-panel-volume elements in desktop and mobile panels.
     Non-critical — errors are swallowed silently.
  ───────────────────────────────────────────────────────────────── */
  async function fetchTokenMetadata(address) {
    try {
      var laddr     = address.toLowerCase();
      var yesterday = Math.floor((Date.now() - 24 * 3600000) / 1000);
      var query = '{ tokenDayDatas(' +
        'first: 1, ' +
        'orderBy: date, ' +
        'orderDirection: desc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + yesterday + ' }' +
        ') { volumeUSD } }';

      var data    = await subgraphQuery(query);
      var dayData = data.tokenDayDatas && data.tokenDayDatas[0];
      if (!dayData) return;

      var vol    = parseFloat(dayData.volumeUSD);
      var fmtVol = vol >= 1e9 ? '$' + (vol / 1e9).toFixed(2) + 'B'
                 : vol >= 1e6 ? '$' + (vol / 1e6).toFixed(2) + 'M'
                 : vol >= 1e3 ? '$' + (vol / 1e3).toFixed(2) + 'K'
                 : '$' + vol.toFixed(2);

      ['right-panel-content', 'mobile-token'].forEach(function (id) {
        var container = document.getElementById(id);
        var volEl     = container && container.querySelector('.token-panel-volume');
        if (volEl) volEl.textContent = fmtVol;
      });
    } catch (_) {
      /* Non-critical — volume display stays blank rather than erroring */
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     FORMATTERS — unchanged from Phase 4B
  ───────────────────────────────────────────────────────────────── */
  function fmtP(usd) {
    if (usd === null || usd === undefined) return '\u2014';
    if (usd >= 10000) return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (usd >= 1)     return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(6);
  }

  /* ─────────────────────────────────────────────────────────────────
     SKELETON — unchanged from Phase 4B
  ───────────────────────────────────────────────────────────────── */
  function showChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.add('skeleton');
  }

  function hideChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     DESTROY — unchanged from Phase 4B
  ───────────────────────────────────────────────────────────────── */
  function destroyChart(priceDiv) {
    if (!priceDiv) return;
    if (priceDiv._lc) {
      try { priceDiv._lc.chart.remove(); } catch (_) {}
      try { priceDiv._lc.ro.disconnect(); } catch (_) {}
      priceDiv._lc = null;
    }
    priceDiv.innerHTML = '';
    priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     INIT — unchanged from Phase 4B
     Area series with violet gradient fill.
     handleScroll / handleScale with mobile-safe config.
  ───────────────────────────────────────────────────────────────── */
  function initChart(priceDiv) {
    if (!priceDiv || typeof LightweightCharts === 'undefined') return null;

    var w = priceDiv.offsetWidth || 400;

    var chart = LightweightCharts.createChart(priceDiv, {
      width:  w,
      height: 200,
      layout: {
        background: { color: 'transparent' },
        textColor:  '#6B7090',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(156,61,187,.06)' },
      },
      rightPriceScale: {
        borderColor:  'rgba(156,61,187,.10)',
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderColor:  'rgba(156,61,187,.10)',
        timeVisible:  false,
        fixRightEdge: true,
      },
      crosshair: {
        mode: 1, /* CrosshairMode.Magnet */
        vertLine: { color: 'rgba(156,61,187,.5)', width: 1, style: 3, labelBackgroundColor: '#9C3DBB' },
        horzLine: { color: 'rgba(156,61,187,.5)', width: 1, style: 3, labelBackgroundColor: '#9C3DBB' },
      },
      handleScroll: {
        mouseWheel:       true,
        pressedMouseMove: true,
        horzTouchDrag:    true,
        vertTouchDrag:    false,
      },
      handleScale: {
        mouseWheel:           true,
        pinch:                true,
        axisPressedMouseMove: true,
      },
      watermark: { visible: false },
    });

    var series = chart.addAreaSeries({
      lineColor:                      '#9C3DBB',
      lineWidth:                      1.5,
      topColor:                       'rgba(156,61,187,0.32)',
      bottomColor:                    'rgba(156,61,187,0.00)',
      crosshairMarkerVisible:         true,
      crosshairMarkerRadius:          4,
      crosshairMarkerBackgroundColor: '#9C3DBB',
      lastValueVisible:               false,
      priceLineVisible:               false,
    });

    /* Crosshair → live price in header; restore original on leave */
    var _savedPrice = null;
    chart.subscribeCrosshairMove(function (param) {
      var panel   = priceDiv.closest('.token-panel');
      var priceEl = panel && panel.querySelector('.token-panel-usd');
      if (!priceEl) return;

      if (param.point && param.seriesData && param.seriesData.size) {
        var d = param.seriesData.get(series);
        if (d) {
          if (_savedPrice === null) _savedPrice = priceEl.textContent;
          priceEl.textContent = fmtP(d.value);
        }
      } else if (_savedPrice !== null) {
        priceEl.textContent = _savedPrice;
        _savedPrice = null;
      }
    });

    /* ResizeObserver — tracks right panel width */
    var ro = new ResizeObserver(function () {
      if (!priceDiv._lc) return;
      var newW = priceDiv.offsetWidth;
      if (newW > 0) chart.applyOptions({ width: newW });
    });
    ro.observe(priceDiv);

    var instance = { chart: chart, series: series, ro: ro };
    priceDiv._lc = instance;
    return instance;
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — unchanged from Phase 4B
     rawPrices: [[timestamp_ms, price_usd], ...]
     Converts ms → s for Lightweight Charts.
     1% minimum visible price window prevents flat stablecoin charts.
  ───────────────────────────────────────────────────────────────── */
  function renderChart(instance, rawPrices) {
    if (!instance || !instance.series) return;
    if (!rawPrices || !rawPrices.length) return;

    var data = rawPrices.map(function (pt) {
      return { time: Math.floor(pt[0] / 1000), value: pt[1] };
    });

    instance.series.setData(data);
    instance.chart.timeScale().fitContent();

    var prices   = data.map(function (d) { return d.value; });
    var minP     = Math.min.apply(null, prices);
    var maxP     = Math.max.apply(null, prices);
    var mid      = (maxP + minP) / 2;
    var minRange = mid * 0.01; /* 1% floor */

    instance.series.applyOptions({
      autoscaleInfoProvider: function () {
        return {
          priceRange: {
            minValue: Math.min(minP, mid - minRange / 2),
            maxValue: Math.max(maxP, mid + minRange / 2),
          },
          margins: { above: 0.10, below: 0.10 },
        };
      },
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     WIRE TOGGLES — Phase 7B: stubs replaced with real subgraph fetch
     Delegation pattern unchanged — see Phase 4B comment for rationale.
  ───────────────────────────────────────────────────────────────── */
  function wireToggles(slot, address) {
    var indicator = slot.querySelector('.chart-toggle-indicator');

    function posIndicator(btn) {
      if (!indicator || !btn) return;
      requestAnimationFrame(function () {
        indicator.style.left  = btn.offsetLeft  + 'px';
        indicator.style.width = btn.offsetWidth + 'px';
      });
    }

    requestAnimationFrame(function () {
      posIndicator(slot.querySelector('.chart-toggle.active'));
    });

    if (slot._toggleHandler) {
      slot.removeEventListener('click', slot._toggleHandler);
      slot._toggleHandler = null;
    }

    slot._toggleHandler = function (e) {
      var btn = e.target.closest('.chart-toggle');
      if (!btn || btn.classList.contains('active')) return;

      Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      posIndicator(btn);

      /* Read live instance at click time — never stale */
      var priceDiv = slot.querySelector('.price-chart');
      var instance = priceDiv && priceDiv._lc;
      if (!instance) return;

      var tf    = btn.dataset.range;
      var entry = window.STATE
        && STATE.priceHistory
        && STATE.priceHistory[address]
        && STATE.priceHistory[address][tf];

      if (entry && entry.prices && !isCacheStale(address, tf)) {
        /* Cache is fresh — render immediately, no network call */
        hideChartSkeleton(priceDiv);
        renderChart(instance, entry.prices);
      } else {
        /* Fetch from subgraph */
        showChartSkeleton(priceDiv);
        ensurePriceHistory(address, tf).then(function () {
          /*
           * Guard: render only if this instance is still live and the
           * state:priceHistory path hasn't already hidden the skeleton.
           */
          var liveInst = priceDiv._lc;
          var fresh    = window.STATE
            && STATE.priceHistory
            && STATE.priceHistory[address]
            && STATE.priceHistory[address][tf];
          if (liveInst && fresh && fresh.prices && priceDiv.classList.contains('skeleton')) {
            hideChartSkeleton(priceDiv);
            renderChart(liveInst, fresh.prices);
          }
        }).catch(function (err) {
          /* Subgraph unavailable — remove skeleton, chart stays empty */
          hideChartSkeleton(priceDiv);
          console.error('[prices.js] Chart fetch failed:', err);
        });
      }
    };

    slot.addEventListener('click', slot._toggleHandler);
  }

  /* ─────────────────────────────────────────────────────────────────
     MOUNT — Phase 7B: stub replaced with real subgraph fetch
     Debounce pattern unchanged — see Phase 4B comment for rationale.
  ───────────────────────────────────────────────────────────────── */
  function mountChart(container, address, tf) {
    if (container._lcMountTimer) clearTimeout(container._lcMountTimer);
    container._lcMountTimer = setTimeout(function () {
      container._lcMountTimer = null;

      requestAnimationFrame(function () {
        var slot     = container.querySelector('.token-panel-chart-slot');
        var priceDiv = slot && slot.querySelector('.price-chart');
        if (!slot || !priceDiv || !address) return;

        destroyChart(priceDiv);

        var instance = initChart(priceDiv);
        if (!instance) return;

        var activeTf = tf || '24H';
        var entry    = window.STATE
          && STATE.priceHistory
          && STATE.priceHistory[address]
          && STATE.priceHistory[address][activeTf];

        if (entry && entry.prices && !isCacheStale(address, activeTf)) {
          /* Cache is fresh — render immediately, no network call */
          hideChartSkeleton(priceDiv);
          renderChart(instance, entry.prices);
        } else {
          /* Fetch from subgraph */
          showChartSkeleton(priceDiv);
          ensurePriceHistory(address, activeTf).then(function () {
            var liveInst = priceDiv._lc;
            var fresh    = window.STATE
              && STATE.priceHistory
              && STATE.priceHistory[address]
              && STATE.priceHistory[address][activeTf];
            if (liveInst && fresh && fresh.prices && priceDiv.classList.contains('skeleton')) {
              hideChartSkeleton(priceDiv);
              renderChart(liveInst, fresh.prices);
            }
          }).catch(function (err) {
            hideChartSkeleton(priceDiv);
            console.error('[prices.js] Chart fetch failed:', err);
          });
        }

        /* Sync active toggle button to the mounted timeframe */
        Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
          b.classList.toggle('active', b.dataset.range === activeTf);
        });

        wireToggles(slot, address);
      });
    }, 0);
  }

  /* ─────────────────────────────────────────────────────────────────
     STATE EVENT LISTENERS
  ───────────────────────────────────────────────────────────────── */
  var rightContent    = document.getElementById('right-panel-content');
  var mobileTokenView = document.getElementById('mobile-token');

  /* Desktop: right panel switched to token view */
  document.addEventListener('panel:render', function (e) {
    if (e.detail !== 'token') return;
    mountChart(rightContent, window.STATE && STATE.token, '24H');
  });

  /* Mobile: token view activated */
  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'token') return;
    mountChart(mobileTokenView, window.STATE && STATE.token, '24H');
  });

  /* Token changed while token view is already visible */
  document.addEventListener('state:token', function (e) {
    var address = e.detail;
    if (window.STATE && STATE.rightPanel === 'token') mountChart(rightContent,    address, '24H');
    if (window.STATE && STATE.mobileView === 'token') mountChart(mobileTokenView, address, '24H');
    /* Phase 7C: fetch 24h volume for the newly selected token */
    if (address) fetchTokenMetadata(address);
  });

  /*
   * priceHistory updated — real fetch result lands here via setState().
   * Guard: only remount when the chart is still showing a skeleton.
   * Prevents double render when .then() in mountChart already handled it.
   */
  document.addEventListener('state:priceHistory', function () {
    var address = window.STATE && STATE.token;
    if (!address) return;

    function remountIfSkeleton(container) {
      if (!container) return;
      var slot     = container.querySelector('.token-panel-chart-slot');
      var priceDiv = slot && slot.querySelector('.price-chart');
      /* Only remount when chart is actively waiting for data */
      if (priceDiv && priceDiv.classList.contains('skeleton')) {
        var btn = slot.querySelector('.chart-toggle.active');
        mountChart(container, address, btn ? btn.dataset.range : '24H');
      }
    }

    if (STATE.rightPanel === 'token') remountIfSkeleton(rightContent);
    if (STATE.mobileView === 'token') remountIfSkeleton(mobileTokenView);
  });

  /*
   * Restart price polling and re-discover tokens on wallet connect or network switch.
   *
   * state:wallet — wallet address in e.detail. Network already set by wallet.js
   *   at the point this fires. Use STATE.network as the authoritative chain.
   *
   * state:network — new chainId in e.detail (direct from setState CustomEvent).
   *   Prefer e.detail; fall back to STATE.network for safety.
   */
  document.addEventListener('state:wallet', function () {
    startPricePolling();
    loadTokenList((window.STATE && STATE.network) || 1);
  });

  document.addEventListener('state:network', function (e) {
    startPricePolling(); /* Already polls all active chains — no extra call needed */
    loadTokenList(e.detail || (window.STATE && STATE.network) || 1);
  });

  /* ─────────────────────────────────────────────────────────────────
     BOOT
     Fetch live prices and discover tokens immediately on file load.
     Default to Ethereum (chainId 1) until wallet connects and sets
     STATE.network — loadTokenList is a no-op for unsupported chainIds.
  ───────────────────────────────────────────────────────────────── */
  startPricePolling();
  loadTokenList((window.STATE && STATE.network) || 1);

}());
