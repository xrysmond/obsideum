/* prices.js — Phase 4B: TradingView Lightweight Charts
 * Chart init, render, time toggle wiring, skeleton, crosshair price update.
 * Mock price history seeded into STATE.priceHistory.
 * Phase 7B wires real Uniswap API fetch into toggle callbacks; renderChart() is untouched.
 * Phase 7A wires Chainlink latestRoundData() polling; updateAllPrices() added here.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
     MOCK PRICE HISTORY
     Shape: { prices: [[timestamp_ms, price_usd], ...] }
     Matches Uniswap API response exactly — data.prices is the array.
     Phase 7B replaces the fetch; chart rendering code is untouched.
  ───────────────────────────────────────────────────────────────── */
  var MOCK_PRICE_HISTORY = (function () {
    var now = Date.now();

    /* Deterministic pseudo-random — same seed always gives same chart shape */
    function pr(n) {
      var x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
      return x - Math.floor(x);
    }

    function randn(seed) {
      var u1 = Math.max(1e-10, pr(seed));
      var u2 = pr(seed + 0.5);
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    /* Mean-reverting random walk — looks like real price action */
    function walk(base, count, stepMs, vol, seed) {
      var pts   = [];
      var kappa = 0.08;
      var p     = base * (1 + randn(seed) * vol);
      for (var i = count; i >= 0; i--) {
        p = Math.max(base * 0.001, p);
        pts.push([now - i * stepMs, +(p.toFixed(p >= 1 ? 2 : 6))]);
        var drift = kappa * (base - p) / base;
        var noise = randn(seed + i * 3 + 7) * vol;
        p = p * (1 + drift + noise);
      }
      pts[pts.length - 1][1] = base; /* pin last value to current price */
      return { prices: pts };
    }

    var T = {
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { b: 3247.82,  s: 10,  v: 0.044  },
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': { b: 67420.00, s: 20,  v: 0.035  },
      '0x514910771AF9Ca656af840dff83E8264EcF986CA': { b: 14.23,    s: 30,  v: 0.057  },
      '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984': { b: 8.20,     s: 40,  v: 0.060  },
      '0x6B175474E89094C44Da98b954EedeAC495271d0F': { b: 1.00,     s: 50,  v: 0.0006 },
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { b: 1.00,     s: 60,  v: 0.0003 },
    };

    var history = {};
    for (var addr in T) {
      var t = T[addr];
      history[addr] = {
        '24H': walk(t.b, 24, 3600000,  t.v / Math.sqrt(24), t.s      ),
        '7D':  walk(t.b, 28, 21600000, t.v / 2,             t.s + 100),
        '30D': walk(t.b, 30, 86400000, t.v,                 t.s + 200),
      };
    }
    return history;
  }());

  /* Seed into STATE.priceHistory — non-destructive, never overwrites real data */
  (function () {
    if (!window.STATE || !window.setState) return;
    var h = STATE.priceHistory || {};
    var changed = false;
    for (var addr in MOCK_PRICE_HISTORY) {
      if (!h[addr]) { h[addr] = MOCK_PRICE_HISTORY[addr]; changed = true; }
    }
    if (changed) setState({ priceHistory: h });
  }());

  /* ─────────────────────────────────────────────────────────────────
     FORMATTERS
  ───────────────────────────────────────────────────────────────── */
  function fmtP(usd) {
    if (usd === null || usd === undefined) return '\u2014';
    if (usd >= 10000) return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (usd >= 1)     return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(6);
  }

  /* ─────────────────────────────────────────────────────────────────
     SKELETON
     Spec: .price-chart div shows .skeleton sweep until setData() fires.
  ───────────────────────────────────────────────────────────────── */
  function showChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.add('skeleton');
  }

  function hideChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     DESTROY — tear down any existing Lightweight Charts instance
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
     INIT — create Lightweight Charts instance in a .price-chart div
     Spec: transparent background, violet crosshair, no scroll/scale,
     crosshair labels background #9C3DBB, violet line #9C3DBB 1.5px.
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
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: 'rgba(156,61,187,.10)',
        timeVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(156,61,187,.5)', width: 1, style: 3, labelBackgroundColor: '#9C3DBB' },
        horzLine: { color: 'rgba(156,61,187,.5)', width: 1, style: 3, labelBackgroundColor: '#9C3DBB' },
      },
      handleScroll: false,
      handleScale:  false,
    });

    var lineSeries = chart.addLineSeries({
      color:                          '#9C3DBB',
      lineWidth:                      1.5,
      crosshairMarkerVisible:         true,
      crosshairMarkerRadius:          4,
      crosshairMarkerBackgroundColor: '#9C3DBB',
      lastValueVisible:               false,
      priceLineVisible:               false,
    });

    /* Crosshair → update .token-panel-usd; restore on leave */
    var _savedPrice = null;
    chart.subscribeCrosshairMove(function (param) {
      var panel   = priceDiv.closest('.token-panel');
      var priceEl = panel && panel.querySelector('.token-panel-usd');
      if (!priceEl) return;

      if (param.point && param.seriesData && param.seriesData.size) {
        var d = param.seriesData.get(lineSeries);
        if (d) {
          if (_savedPrice === null) _savedPrice = priceEl.textContent;
          priceEl.textContent = fmtP(d.value);
        }
      } else if (_savedPrice !== null) {
        priceEl.textContent = _savedPrice;
        _savedPrice = null;
      }
    });

    /* ResizeObserver — chart resizes when right panel width changes */
    var ro = new ResizeObserver(function () {
      if (!priceDiv._lc) return;
      var newW = priceDiv.offsetWidth;
      if (newW > 0) chart.applyOptions({ width: newW });
    });
    ro.observe(priceDiv);

    var instance = { chart: chart, lineSeries: lineSeries, ro: ro };
    priceDiv._lc = instance;
    return instance;
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — load price history data into the chart
     rawPrices: [[timestamp_ms, price_usd], ...]  (Uniswap API / mock shape)
     Lightweight Charts requires seconds; we convert here.
     On time toggle: call renderChart() with new data — chart redraws automatically.
  ───────────────────────────────────────────────────────────────── */
  function renderChart(instance, rawPrices) {
    if (!instance || !instance.lineSeries) return;
    if (!rawPrices || !rawPrices.length) return;
    var data = rawPrices.map(function (pt) {
      return { time: Math.floor(pt[0] / 1000), value: pt[1] };
    });
    instance.lineSeries.setData(data);
    instance.chart.timeScale().fitContent();
  }

  /* ─────────────────────────────────────────────────────────────────
     WIRE TOGGLES — 24H · 7D · 30D sliding indicator
     Indicator slides between buttons: transition left 220ms --ease-spr.
     Cache check first; Phase 7B wires real fetch for missing ranges.
  ───────────────────────────────────────────────────────────────── */
  function wireToggles(slot, priceDiv, instance, address) {
    var toggles   = Array.from(slot.querySelectorAll('.chart-toggle'));
    var indicator = slot.querySelector('.chart-toggle-indicator');

    function posIndicator(btn) {
      if (!indicator) return;
      requestAnimationFrame(function () {
        indicator.style.left  = btn.offsetLeft  + 'px';
        indicator.style.width = btn.offsetWidth + 'px';
      });
    }

    /* Initial position — after layout is complete */
    requestAnimationFrame(function () {
      var active = slot.querySelector('.chart-toggle.active');
      if (active) posIndicator(active);
    });

    toggles.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('active')) return;
        toggles.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        posIndicator(btn);

        var tf     = btn.dataset.range;
        var cached = window.STATE
          && STATE.priceHistory
          && STATE.priceHistory[address]
          && STATE.priceHistory[address][tf];

        if (cached && cached.prices) {
          hideChartSkeleton(priceDiv);
          renderChart(instance, cached.prices);
        } else {
          showChartSkeleton(priceDiv);
          /* Phase 7B: fetchPriceHistory(address, tf).then(...) wires here */
        }
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     MOUNT — full chart lifecycle for a token panel container
  ───────────────────────────────────────────────────────────────── */
  function mountChart(container, address, tf) {
    requestAnimationFrame(function () {
      var slot     = container.querySelector('.token-panel-chart-slot');
      var priceDiv = slot && slot.querySelector('.price-chart');
      if (!slot || !priceDiv || !address) return;

      destroyChart(priceDiv);

      var instance = initChart(priceDiv);
      if (!instance) return;

      /* Load data */
      var history = window.STATE
        && STATE.priceHistory
        && STATE.priceHistory[address]
        && STATE.priceHistory[address][tf || '24H'];

      if (history && history.prices) {
        hideChartSkeleton(priceDiv);
        renderChart(instance, history.prices);
      } else {
        showChartSkeleton(priceDiv);
        /* Phase 7B: fetch here, then hideChartSkeleton() → renderChart() */
      }

      /* Sync active toggle to the requested timeframe */
      Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
        b.classList.toggle('active', b.dataset.range === (tf || '24H'));
      });

      wireToggles(slot, priceDiv, instance, address);
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     STATE EVENT LISTENERS
     Mirrors the pattern used by the token panel builder in app.html.
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

  /* Token changed while already showing token view */
  document.addEventListener('state:token', function (e) {
    var address = e.detail;
    if (window.STATE && STATE.rightPanel === 'token') mountChart(rightContent,    address, '24H');
    if (window.STATE && STATE.mobileView === 'token') mountChart(mobileTokenView, address, '24H');
  });

  /* priceHistory updated — Phase 7B real fetch returns here */
  document.addEventListener('state:priceHistory', function () {
    var address = window.STATE && STATE.token;
    if (!address) return;
    if (STATE.rightPanel === 'token') {
      var slot = rightContent.querySelector('.token-panel-chart-slot');
      var btn  = slot && slot.querySelector('.chart-toggle.active');
      mountChart(rightContent, address, btn ? btn.dataset.range : '24H');
    }
    if (STATE.mobileView === 'token') {
      var mslot = mobileTokenView.querySelector('.token-panel-chart-slot');
      var mbtn  = mslot && mslot.querySelector('.chart-toggle.active');
      mountChart(mobileTokenView, address, mbtn ? mbtn.dataset.range : '24H');
    }
  });

}());
