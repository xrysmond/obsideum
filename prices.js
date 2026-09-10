/* prices.js — Phase 9H-rebuild
 *
 * BUG FIXED: Chart history always queried Ethereum mainnet subgraph
 * regardless of which chain the token lives on.
 * WBNB on BNB Chain was being looked up in the Ethereum subgraph → 0 results
 * → chart skeleton stayed forever for every non-Ethereum token.
 *
 * FIX: subgraphQuery(query, chainId) now builds the endpoint from
 * SUBGRAPH_IDS[chainId] instead of the hardcoded Ethereum constant.
 * fetchPriceHistory, ensurePriceHistory, mountChart, wireToggles, and
 * fetchTokenMetadata all receive and propagate chainId.
 *
 * UNCHAINED9. Built by Waeven Xrysmond.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
     UNISWAP V3 SUBGRAPH IDs — ALL SUPPORTED CHAINS
     Verified at developers.uniswap.org/docs/ecosystem/subgraphs
  ───────────────────────────────────────────────────────────────── */
  var SUBGRAPH_IDS = {
    1:     '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV', /* Ethereum     */
    10:    'Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj', /* Optimism     */
    56:    'F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2', /* BNB Chain    */
    130:   'BCfy6Vw9No3weqVq9NhyGo4FkVCJep1ZN9RMJj5S32fX', /* Unichain     */
    137:   '3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm', /* Polygon      */
    8453:  '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG', /* Base         */
    42161: 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM', /* Arbitrum One */
    43114: 'GVH9h9KZ9CqheUEL93qMbq7QwgoBu32QXQDPR6bev4Eo', /* Avalanche    */
  };

  var THE_GRAPH_API_KEY = 'ba6a6c595dff86ed9d73903bcca93b22';

  /* ─────────────────────────────────────────────────────────────────
     NATIVE TOKEN DEFINITIONS  (unchanged)
  ───────────────────────────────────────────────────────────────── */
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

  /* ─────────────────────────────────────────────────────────────────
     TOKEN DISCOVERY  (unchanged from Phase 9C)
  ───────────────────────────────────────────────────────────────── */
  async function loadTokenList(chainId) {
    var subgraphId = SUBGRAPH_IDS[chainId];
    if (!subgraphId) return;

    var endpoint = 'https://gateway.thegraph.com/api/' + THE_GRAPH_API_KEY
                 + '/subgraphs/id/' + subgraphId;

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
          address:  ethers.utils.getAddress(t.id),
          symbol:   t.symbol,
          name:     t.name,
          decimals: parseInt(t.decimals, 10),
        };
      });

      var tokenList = native ? [native].concat(discovered) : discovered;
      setState({ tokenList: tokenList });

    } catch (err) {
      console.error('[prices.js] loadTokenList failed (chain ' + chainId + '):', err.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     SUBGRAPH ENDPOINT BUILDER  ← KEY FIX
     Replaces the hardcoded UNISWAP_V3_SUBGRAPH constant.
     Always returns the correct endpoint for the given chainId.
  ───────────────────────────────────────────────────────────────── */
  function getSubgraphEndpoint(chainId) {
    var id = SUBGRAPH_IDS[Number(chainId)];
    if (!id) return null;
    return 'https://gateway.thegraph.com/api/' + THE_GRAPH_API_KEY
           + '/subgraphs/id/' + id;
  }

  /* ─────────────────────────────────────────────────────────────────
     SUBGRAPH QUERY  ← FIXED: accepts chainId
     chainId defaults to STATE.tokenChainId → STATE.network → 1
  ───────────────────────────────────────────────────────────────── */
  async function subgraphQuery(query, chainId) {
    var cid      = Number(chainId)
               || (window.STATE && Number(STATE.tokenChainId))
               || (window.STATE && Number(STATE.network))
               || 1;
    var endpoint = getSubgraphEndpoint(cid);

    if (!endpoint) {
      throw new Error('[prices.js] No subgraph for chain ' + cid);
    }

    var res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query: query }),
    });

    if (!res.ok) {
      throw new Error('[prices.js] Subgraph HTTP ' + res.status + ' (chain ' + cid + ')');
    }

    var json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error('[prices.js] Subgraph GraphQL: ' + json.errors[0].message);
    }

    return json.data;
  }

  /* ─────────────────────────────────────────────────────────────────
     CACHE STALE CHECK  (unchanged)
  ───────────────────────────────────────────────────────────────── */
  var STALE_MS = {
    '24H': 5  * 60 * 1000,
    '7D':  60 * 60 * 1000,
    '30D': 60 * 60 * 1000,
  };

  function isCacheStale(address, timeframe) {
    var entry = window.STATE
      && STATE.priceHistory
      && STATE.priceHistory[address]
      && STATE.priceHistory[address][timeframe];

    if (!entry || !entry.prices || !entry.prices.length) return true;
    if (!entry.fetchedAt) return true;
    return (Date.now() - entry.fetchedAt) > STALE_MS[timeframe];
  }

  /* ─────────────────────────────────────────────────────────────────
     FETCH PRICE HISTORY  ← FIXED: accepts and propagates chainId
  ───────────────────────────────────────────────────────────────── */
  async function fetchPriceHistory(address, timeframe, chainId) {
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
    } else {
      since = now - 30 * 24 * 3600;
      query = '{ tokenDayDatas(' +
        'first: 30, ' +
        'orderBy: date, ' +
        'orderDirection: asc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + since + ' }' +
        ') { date priceUSD } }';
    }

    /* Pass chainId to subgraphQuery — uses correct chain's subgraph */
    var data = await subgraphQuery(query, chainId);
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

    raw = raw.filter(function (pt) { return pt[1] > 0; });

    if (!raw.length) {
      throw new Error('[prices.js] No price history for ' + address + ' [' + timeframe + '] (chain ' + chainId + ')');
    }

    var h = Object.assign({}, (window.STATE && STATE.priceHistory) || {});
    if (!h[address]) h[address] = {};
    h[address][timeframe] = { prices: raw, fetchedAt: Date.now() };
    setState({ priceHistory: h });

    return raw;
  }

  /* ─────────────────────────────────────────────────────────────────
     ENSURE PRICE HISTORY  ← FIXED: passes chainId through
  ───────────────────────────────────────────────────────────────── */
  async function ensurePriceHistory(address, timeframe, chainId) {
    if (!isCacheStale(address, timeframe)) return;
    await fetchPriceHistory(address, timeframe, chainId);
  }

  /* ─────────────────────────────────────────────────────────────────
     TOKEN METADATA  ← FIXED: uses correct chain's subgraph
  ───────────────────────────────────────────────────────────────── */
  async function fetchTokenMetadata(address, chainId) {
    try {
      var laddr     = address.toLowerCase();
      var yesterday = Math.floor((Date.now() - 24 * 3600000) / 1000);
      var query = '{ tokenDayDatas(' +
        'first: 1, ' +
        'orderBy: date, ' +
        'orderDirection: desc, ' +
        'where: { token: "' + laddr + '", date_gt: ' + yesterday + ' }' +
        ') { volumeUSD } }';

      var data    = await subgraphQuery(query, chainId);
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
    } catch (_) { /* non-critical */ }
  }

  /* ─────────────────────────────────────────────────────────────────
     FORMATTERS  (unchanged)
  ───────────────────────────────────────────────────────────────── */
  function fmtP(usd) {
    if (usd === null || usd === undefined) return '\u2014';
    if (usd >= 10000) return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (usd >= 1)     return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(6);
  }

  /* ─────────────────────────────────────────────────────────────────
     SKELETON  (unchanged)
  ───────────────────────────────────────────────────────────────── */
  function showChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.add('skeleton');
  }
  function hideChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     DESTROY  (unchanged)
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
     INIT CHART  (unchanged)
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
        mode: 1,
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
     RENDER CHART  (unchanged)
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
    var minRange = mid * 0.01;

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
     WIRE TOGGLES  ← FIXED: accepts and captures chainId
  ───────────────────────────────────────────────────────────────── */
  function wireToggles(slot, address, chainId) {
    /* Resolve wrapped address for subgraph — chain-specific */
    var chartAddr = (address === 'NATIVE' && window.NATIVE_CHART_ADDRESS)
      ? (window.NATIVE_CHART_ADDRESS[chainId] || address)
      : address;

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

      var priceDiv = slot.querySelector('.price-chart');
      var instance = priceDiv && priceDiv._lc;
      if (!instance) return;

      var tf    = btn.dataset.range;
      var entry = window.STATE
        && STATE.priceHistory
        && STATE.priceHistory[chartAddr]
        && STATE.priceHistory[chartAddr][tf];

      if (entry && entry.prices && !isCacheStale(chartAddr, tf)) {
        hideChartSkeleton(priceDiv);
        renderChart(instance, entry.prices);
      } else {
        showChartSkeleton(priceDiv);
        /* chainId captured from wireToggles closure — correct for this token */
        ensurePriceHistory(chartAddr, tf, chainId).then(function () {
          var liveInst = priceDiv._lc;
          var fresh    = window.STATE
            && STATE.priceHistory
            && STATE.priceHistory[chartAddr]
            && STATE.priceHistory[chartAddr][tf];
          if (liveInst && fresh && fresh.prices && priceDiv.classList.contains('skeleton')) {
            hideChartSkeleton(priceDiv);
            renderChart(liveInst, fresh.prices);
          }
        }).catch(function (err) {
          hideChartSkeleton(priceDiv);
          console.error('[prices.js] Chart fetch failed:', err);
        });
      }
    };

    slot.addEventListener('click', slot._toggleHandler);
  }

  /* ─────────────────────────────────────────────────────────────────
     MOUNT CHART  ← FIXED: reads chainId from STATE.tokenChainId
     and passes it to all sub-functions
  ───────────────────────────────────────────────────────────────── */
  function mountChart(container, address, tf) {
    if (container._lcMountTimer) clearTimeout(container._lcMountTimer);
    container._lcMountTimer = setTimeout(function () {
      container._lcMountTimer = null;

      requestAnimationFrame(function () {
        var slot     = container.querySelector('.token-panel-chart-slot');
        var priceDiv = slot && slot.querySelector('.price-chart');
        if (!slot || !priceDiv || !address) return;

        /* Capture chainId at mount time — this is the chain the token belongs to */
        var chainId = Number(
          (window.STATE && STATE.tokenChainId) ||
          (window.STATE && STATE.network) ||
          1
        );

        /* NATIVE tokens use the wrapped equivalent for subgraph history.
         * NATIVE_CHART_ADDRESS is set by app.html before prices.js loads.
         * Now chain-specific: WETH on Ethereum ≠ WBNB on BNB ≠ WAVAX on Avalanche */
        var chartAddr = (address === 'NATIVE' && window.NATIVE_CHART_ADDRESS)
          ? (window.NATIVE_CHART_ADDRESS[chainId] || address)
          : address;

        destroyChart(priceDiv);

        var instance = initChart(priceDiv);
        if (!instance) return;

        var activeTf = tf || '24H';
        var entry    = window.STATE
          && STATE.priceHistory
          && STATE.priceHistory[chartAddr]
          && STATE.priceHistory[chartAddr][activeTf];

        if (entry && entry.prices && !isCacheStale(chartAddr, activeTf)) {
          hideChartSkeleton(priceDiv);
          renderChart(instance, entry.prices);
        } else {
          showChartSkeleton(priceDiv);
          /* Pass chainId — fetch from the token's own chain subgraph */
          ensurePriceHistory(chartAddr, activeTf, chainId).then(function () {
            var liveInst = priceDiv._lc;
            var fresh    = window.STATE
              && STATE.priceHistory
              && STATE.priceHistory[chartAddr]
              && STATE.priceHistory[chartAddr][activeTf];
            if (liveInst && fresh && fresh.prices && priceDiv.classList.contains('skeleton')) {
              hideChartSkeleton(priceDiv);
              renderChart(liveInst, fresh.prices);
            }
          }).catch(function (err) {
            hideChartSkeleton(priceDiv);
            console.error('[prices.js] Chart fetch failed:', err);
          });
        }

        Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
          b.classList.toggle('active', b.dataset.range === activeTf);
        });

        /* Pass chainId to wireToggles so toggle handler uses the right subgraph */
        wireToggles(slot, chartAddr, chainId);
      });
    }, 0);
  }

  /* ─────────────────────────────────────────────────────────────────
     STATE EVENT LISTENERS
  ───────────────────────────────────────────────────────────────── */
  var rightContent    = document.getElementById('right-panel-content');
  var mobileTokenView = document.getElementById('mobile-token');

  document.addEventListener('panel:render', function (e) {
    if (e.detail !== 'token') return;
    mountChart(rightContent, window.STATE && STATE.token, '24H');
  });

  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'token') return;
    mountChart(mobileTokenView, window.STATE && STATE.token, '24H');
  });

  document.addEventListener('state:token', function (e) {
    var address = e.detail;
    if (window.STATE && STATE.rightPanel === 'token') mountChart(rightContent,    address, '24H');
    if (window.STATE && STATE.mobileView === 'token') mountChart(mobileTokenView, address, '24H');
    if (address) {
      /* Pass chainId to fetchTokenMetadata for correct volume subgraph */
      var cid = (window.STATE && STATE.tokenChainId) || (window.STATE && STATE.network) || 1;
      fetchTokenMetadata(address, cid);
    }
  });

  document.addEventListener('state:priceHistory', function () {
    var address = window.STATE && STATE.token;
    if (!address) return;

    function remountIfSkeleton(container) {
      if (!container) return;
      var slot     = container.querySelector('.token-panel-chart-slot');
      var priceDiv = slot && slot.querySelector('.price-chart');
      if (priceDiv && priceDiv.classList.contains('skeleton')) {
        var btn = slot.querySelector('.chart-toggle.active');
        mountChart(container, address, btn ? btn.dataset.range : '24H');
      }
    }

    if (STATE.rightPanel === 'token') remountIfSkeleton(rightContent);
    if (STATE.mobileView === 'token') remountIfSkeleton(mobileTokenView);
  });

  document.addEventListener('state:wallet', function () {
    loadTokenList((window.STATE && STATE.network) || 1);
  });

  document.addEventListener('state:network', function (e) {
    loadTokenList(e.detail || (window.STATE && STATE.network) || 1);
  });

  /* ─────────────────────────────────────────────────────────────────
     BOOT
  ───────────────────────────────────────────────────────────────── */
  loadTokenList((window.STATE && STATE.network) || 1);

}());
