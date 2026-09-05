/* prices.js — Phase 4B: TradingView Lightweight Charts v4.2.2
 * Area series with violet gradient fill.
 * Mock price history seeded into STATE.priceHistory.
 * Phase 7B wires real Uniswap API fetch; renderChart() is untouched.
 * Phase 7A wires Chainlink polling; updateAllPrices() added here then.
 */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────
     MOCK PRICE HISTORY
     Shape: { prices: [[timestamp_ms, price_usd], ...] }
     Matches Uniswap API shape exactly — Phase 7B replaces the source,
     renderChart() never changes.
  ───────────────────────────────────────────────────────────────── */
  var MOCK_PRICE_HISTORY = (function () {
    var now = Date.now();

    function pr(n) {
      var x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
      return x - Math.floor(x);
    }

    function randn(seed) {
      var u1 = Math.max(1e-10, pr(seed));
      var u2 = pr(seed + 0.5);
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    /* Mean-reverting random walk — deterministic, looks like real price action */
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
      pts[pts.length - 1][1] = base;
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
  ───────────────────────────────────────────────────────────────── */
  function showChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.add('skeleton');
  }

  function hideChartSkeleton(priceDiv) {
    if (priceDiv) priceDiv.classList.remove('skeleton');
  }

  /* ─────────────────────────────────────────────────────────────────
     DESTROY — remove chart instance and clear container
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
     INIT — area series with violet gradient fill
     handleScroll / handleScale enabled with mobile-safe config:
       vertTouchDrag: false  →  vertical page scroll still works
       horzTouchDrag: true   →  swipe left/right scrubs the timeline
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
        mode: 1, /* CrosshairMode.Magnet — snaps crosshair to nearest data point */
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

    /* ResizeObserver — chart width tracks the right panel */
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
     RENDER — set price history data on the chart
     rawPrices: [[timestamp_ms, price_usd], ...]
     Converts ms → s for Lightweight Charts. Phase 7B swaps the data
     source; this function is never touched.
  ───────────────────────────────────────────────────────────────── */
  function renderChart(instance, rawPrices) {
    if (!instance || !instance.series) return;
    if (!rawPrices || !rawPrices.length) return;

    var data = rawPrices.map(function (pt) {
      return { time: Math.floor(pt[0] / 1000), value: pt[1] };
    });

    instance.series.setData(data);
    instance.chart.timeScale().fitContent();

    /* Enforce 1 % minimum visible price window.
       LW Charts fills the full chart height with whatever range the data
       has — a 0.000181 stablecoin move looks identical to a 20 % crash.
       autoscaleInfoProvider expands the window to at least 1 % of the
       midpoint price when the actual data range is smaller than that.
       Volatile assets (ETH, BTC) have ranges >> 1 % so they are
       unaffected — Math.min / Math.max never shrink an existing range. */
    var prices   = data.map(function (d) { return d.value; });
    var minP     = Math.min.apply(null, prices);
    var maxP     = Math.max.apply(null, prices);
    var mid      = (maxP + minP) / 2;
    var minRange = mid * 0.01; /* 1 % floor */

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
     WIRE TOGGLES — event delegation on the slot element
     WHY DELEGATION:
       mountChart can fire twice per token select (panel:render +
       state:token both dispatch). Two calls → two wireToggles calls →
       two click listeners per button. The second listener's guard
       (.active already set by first) bails out immediately — chart
       never rerenders on toggle.
     FIX:
       One delegated listener on the slot. Removed and replaced on
       each wireToggles call. Instance always read from priceDiv._lc
       at click time — never a stale closure reference.
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

    /* Position indicator on the initially active toggle after layout */
    requestAnimationFrame(function () {
      posIndicator(slot.querySelector('.chart-toggle.active'));
    });

    /* Remove previous listener — safe when _toggleHandler is undefined */
    if (slot._toggleHandler) {
      slot.removeEventListener('click', slot._toggleHandler);
      slot._toggleHandler = null;
    }

    /* One delegated listener handles all three toggle buttons */
    slot._toggleHandler = function (e) {
      var btn = e.target.closest('.chart-toggle');
      if (!btn || btn.classList.contains('active')) return;

      Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      posIndicator(btn);

      /* Read current live instance — never stale */
      var priceDiv = slot.querySelector('.price-chart');
      var instance = priceDiv && priceDiv._lc;
      if (!instance) return;

      var tf = btn.dataset.range;
      var cached = window.STATE
        && STATE.priceHistory
        && STATE.priceHistory[address]
        && STATE.priceHistory[address][tf];

      if (cached && cached.prices) {
        hideChartSkeleton(priceDiv);
        renderChart(instance, cached.prices);
      } else {
        showChartSkeleton(priceDiv);
        /* Phase 7B: real Uniswap V3 subgraph fetch wires here */
      }
    };

    slot.addEventListener('click', slot._toggleHandler);
  }

  /* ─────────────────────────────────────────────────────────────────
     MOUNT — full chart lifecycle, debounced per container
     WHY DEBOUNCE:
       panel:render and state:token fire in the same tick when a token
       is selected. Without debouncing, mountChart runs twice: the
       second destroyChart wipes the instance the first one built,
       and both wireToggles calls stack listeners on the same buttons.
     FIX:
       setTimeout(fn, 0) collapses concurrent calls into one, always
       using the most recent address/tf, running after all synchronous
       event handlers (including DOM injection) have completed.
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

        var history = window.STATE
          && STATE.priceHistory
          && STATE.priceHistory[address]
          && STATE.priceHistory[address][tf || '24H'];

        if (history && history.prices) {
          hideChartSkeleton(priceDiv);
          renderChart(instance, history.prices);
        } else {
          showChartSkeleton(priceDiv);
          /* Phase 7B: fetch → hideChartSkeleton() → renderChart() */
        }

        /* Sync active toggle to the mounted timeframe */
        Array.from(slot.querySelectorAll('.chart-toggle')).forEach(function (b) {
          b.classList.toggle('active', b.dataset.range === (tf || '24H'));
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

  /* Desktop — right panel switched to token view */
  document.addEventListener('panel:render', function (e) {
    if (e.detail !== 'token') return;
    mountChart(rightContent, window.STATE && STATE.token, '24H');
  });

  /* Mobile — token view activated */
  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'token') return;
    mountChart(mobileTokenView, window.STATE && STATE.token, '24H');
  });

  /* Token changed while token view is already visible */
  document.addEventListener('state:token', function (e) {
    var address = e.detail;
    if (window.STATE && STATE.rightPanel === 'token') mountChart(rightContent,    address, '24H');
    if (window.STATE && STATE.mobileView === 'token') mountChart(mobileTokenView, address, '24H');
  });

  /* priceHistory updated — Phase 7B real fetch lands here */
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
