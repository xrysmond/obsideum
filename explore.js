/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — explore.js
   Market explore tab. Reads from STATE.marketData (populated
   by market.js via CoinGecko). Never touches STATE.tokenList
   or STATE.network — fully decoupled from the wallet layer.

   Chain pills are LOCAL state. Switching chains here does NOT
   mutate any global state — it just switches _exploreChain and
   re-renders from pre-fetched STATE.marketData[chainId].
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════ */
  var CHAIN_NAMES = {
    1:      'Ethereum',
    10:     'Optimism',
    56:     'BNB Chain',
    130:    'Unichain',
    137:    'Polygon',
    8453:   'Base',
    42161:  'Arbitrum',
    43114:  'Avalanche',
  };

  var CHAIN_COLORS = {
    1:      '#627EEA',
    10:     '#FF0420',
    56:     '#F0B90B',
    130:    '#FC72FF',
    137:    '#8247E5',
    8453:   '#0052FF',
    42161:  '#12AAFF',
    43114:  '#E84142',
  };

  var STABLE_SYMBOLS = {
    USDC:1, USDT:1, DAI:1, FRAX:1, TUSD:1, BUSD:1, LUSD:1,
    PYUSD:1, USDE:1, USDBC:1, GUSD:1, SUSD:1, CRVUSD:1,
    MKUSD:1, DOLA:1, AGEUR:1, EURC:1, USDP:1, FDUSD:1, USDS:1,
  };

  /* ════════════════════════════════════════════════════════
     MODULE STATE
     All local. Nothing here writes to global STATE.
  ════════════════════════════════════════════════════════ */
  var _mounted      = false;
  var _container    = null;
  var _exploreChain = null;   /* which chain the explore tab is showing — LOCAL */
  var _category     = 'all'; /* 'all'|'trending'|'gainers'|'losers'|'stables' */
  var _sortCol      = null;  /* null | 'price' | 'change' */
  var _sortDir      = 'desc';
  var _search       = '';
  var _debounce     = null;
  /* _navPending removed — async resolveMarketAddress no longer on tap path (Bug 4) */

  /* ════════════════════════════════════════════════════════
     ACCESSORS
  ════════════════════════════════════════════════════════ */
  function getMarketData(chainId) {
    return (window.STATE && STATE.marketData && STATE.marketData[chainId]) || null;
  }
  function getActiveNetworks() {
    return (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
  }
  function getWalletChain() {
    return (window.STATE && STATE.network) || 1;
  }

  /* ════════════════════════════════════════════════════════
     FORMATTING
  ════════════════════════════════════════════════════════ */
  function fmtUSD(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return '$' + (v / 1e9).toFixed(2)  + 'B';
    if (v >= 1e6)  return '$' + (v / 1e6).toFixed(2)  + 'M';
    if (v >= 1e3)  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1)    return '$' + v.toFixed(2);
    if (v >= 0.001) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(4);
  }

  function fmtChange(c) {
    if (c === null || c === undefined || isNaN(c)) return '—';
    return (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ════════════════════════════════════════════════════════
     FILTER + SORT PIPELINE
  ════════════════════════════════════════════════════════ */
  function applyFilters(tokens) {
    var q = _search.trim().toLowerCase();

    /* 1. Search */
    if (q) {
      tokens = tokens.filter(function (t) {
        return t.name.toLowerCase().indexOf(q) > -1
            || t.symbol.toLowerCase().indexOf(q) > -1;
      });
    }

    /* 2. Category */
    if (_category === 'stables') {
      tokens = tokens.filter(function (t) { return STABLE_SYMBOLS[t.symbol]; });
    } else if (_category === 'gainers') {
      tokens = tokens.filter(function (t) {
        return t.change24h !== null && t.change24h > 0;
      });
    } else if (_category === 'losers') {
      tokens = tokens.filter(function (t) {
        return t.change24h !== null && t.change24h < 0;
      });
    }

    /* 3. Sort */
    var out = tokens.slice();

    if (_category === 'trending') {
      out.sort(function (a, b) {
        return Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0);
      });
    } else if (_category === 'gainers') {
      out.sort(function (a, b) { return (b.change24h || 0) - (a.change24h || 0); });
    } else if (_category === 'losers') {
      out.sort(function (a, b) { return (a.change24h || 0) - (b.change24h || 0); });
    } else if (_sortCol === 'price') {
      out.sort(function (a, b) {
        var d = (b.price || 0) - (a.price || 0);
        return _sortDir === 'asc' ? -d : d;
      });
    } else if (_sortCol === 'change') {
      out.sort(function (a, b) {
        var d = (b.change24h || 0) - (a.change24h || 0);
        return _sortDir === 'asc' ? -d : d;
      });
    }
    /* Default = market cap order (already sorted by API response) */

    return out;
  }

  /* ════════════════════════════════════════════════════════
     ROW HTML
     Uses CoinGecko image URL — no TrustWallet lookup needed.
  ════════════════════════════════════════════════════════ */
  function buildRowHtml(entry) {
    var chgValid = entry.change24h !== null && !isNaN(entry.change24h);
    var dir      = chgValid ? (entry.change24h > 0 ? 'up' : entry.change24h < 0 ? 'dn' : '') : '';
    var arrow    = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
    var sym0     = escHtml((entry.symbol || '?')[0]);

    return [
      '<div class="asset-row explore-row" data-cgid="' + escHtml(entry.id) + '"',
        ' role="button" tabindex="0" aria-label="' + escHtml(entry.name) + '">',

        '<div class="asset-row-logo-wrap">',
          entry.image
            ? '<img class="asset-row-logo" src="' + escHtml(entry.image) + '" alt="' + escHtml(entry.symbol) + '"'
                + ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
            : '',
          '<div class="asset-row-logo-fallback"' + (entry.image ? ' style="display:none"' : '') + '>' + sym0 + '</div>',
        '</div>',

        '<div class="asset-row-identity">',
          '<span class="asset-row-name">' + escHtml(entry.name) + '</span>',
          '<span class="asset-row-chain">' + escHtml(entry.symbol) + '</span>',
        '</div>',

        '<div class="asset-row-price">',
          '<span class="asset-row-usd">' + fmtUSD(entry.price) + '</span>',
          '<span class="asset-row-change ' + dir + '">',
            (arrow ? '<span class="explore-arrow">' + arrow + '</span>' : ''),
            chgValid ? fmtChange(entry.change24h) : '—',
          '</span>',
        '</div>',

      '</div>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     SKELETON
  ════════════════════════════════════════════════════════ */
  function renderSkeleton(listEl) {
    var ws = [72, 88, 60, 95, 78, 110, 64, 82];
    listEl.innerHTML = ws.map(function (w) {
      return [
        '<div class="asset-row" style="pointer-events:none">',
          '<div class="asset-row-logo-wrap">',
            '<div class="skeleton" style="width:36px;height:36px;border-radius:50%"></div>',
          '</div>',
          '<div class="asset-row-identity">',
            '<div class="skeleton" style="width:' + w + 'px;height:10px;margin-bottom:5px;border-radius:3px"></div>',
            '<div class="skeleton" style="width:30px;height:8px;border-radius:3px"></div>',
          '</div>',
          '<div class="asset-row-price" style="align-items:flex-end">',
            '<div class="skeleton" style="width:60px;height:10px;margin-bottom:5px;border-radius:3px"></div>',
            '<div class="skeleton" style="width:44px;height:8px;border-radius:3px"></div>',
          '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  /* ════════════════════════════════════════════════════════
     EMPTY STATE
  ════════════════════════════════════════════════════════ */
  function renderEmpty(listEl, isLoading) {
    if (isLoading) {
      renderSkeleton(listEl);
      return;
    }
    listEl.innerHTML = [
      '<div class="explore-empty">',
        '<svg width="36" height="36" viewBox="0 0 24 24" fill="none"',
          ' stroke="var(--dim)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">',
          '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
        '</svg>',
        '<span>No tokens found</span>',
      '</div>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     RENDER LIST
  ════════════════════════════════════════════════════════ */
  function renderList(listEl, tokens) {
    listEl.innerHTML = tokens.map(buildRowHtml).join('');

    /* Wire taps — Bug 4 fix: no async on the tap critical path.
     * resolveMarketAddress is never called here. Navigate immediately
     * if address is known. If null, do nothing — market.js resolves
     * addresses in the background on its next poll cycle.
     * state:token listener in app.html handles ALL navigation — no
     * direct setMobileSubView or openRightPanel calls from here. */
    listEl.querySelectorAll('.explore-row[data-cgid]').forEach(function (row) {
      function onTap() {
        var cgId  = row.dataset.cgid;
        var data  = getMarketData(_exploreChain) || [];
        var entry = data.find(function (e) { return e.id === cgId; });
        if (!entry) return;

        /* Never block the UI on an HTTP call.
         * If the address is still null, do nothing — wait for market.js. */
        if (!entry.address) return;

        /* Single setState call. state:token listener in app.html
         * handles all navigation — mobile and desktop. */
        setState({ token: entry.address, tokenChainId: _exploreChain });
      }
      row.addEventListener('click', onTap);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(); }
      });
    });
  }

  /* ════════════════════════════════════════════════════════
     IN-PLACE PRICE UPDATE
     Runs on state:marketData when sort is stable —
     updates text without disrupting scroll or DOM structure.
  ════════════════════════════════════════════════════════ */
  function updatePricesInPlace() {
    if (!_container) return;
    var listEl = _container.querySelector('#explore-list');
    if (!listEl) return;

    var data = getMarketData(_exploreChain) || [];
    var idx  = {};
    data.forEach(function (e) { idx[e.id] = e; });

    listEl.querySelectorAll('.explore-row[data-cgid]').forEach(function (row) {
      var entry = idx[row.dataset.cgid];
      if (!entry) return;

      var usdEl    = row.querySelector('.asset-row-usd');
      var changeEl = row.querySelector('.asset-row-change');

      if (usdEl) usdEl.textContent = fmtUSD(entry.price);
      if (changeEl) {
        var c     = entry.change24h;
        var valid = c !== null && !isNaN(c);
        var dir   = valid ? (c > 0 ? 'up' : c < 0 ? 'dn' : '') : '';
        var arrow = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
        changeEl.innerHTML = (arrow ? '<span class="explore-arrow">' + arrow + '</span>' : '')
          + (valid ? fmtChange(c) : '—');
        changeEl.className = 'asset-row-change' + (dir ? ' ' + dir : '');
      }
    });
  }

  /* ════════════════════════════════════════════════════════
     SORT INDICATORS
  ════════════════════════════════════════════════════════ */
  function updateSortIndicators() {
    if (!_container) return;
    _container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      var active = col.dataset.col === _sortCol;
      col.classList.toggle('sort-active', active);
      col.classList.toggle('sort-asc',    active && _sortDir === 'asc');
      col.classList.toggle('sort-desc',   active && _sortDir === 'desc');
    });
  }

  /* ════════════════════════════════════════════════════════
     COUNT BADGE
  ════════════════════════════════════════════════════════ */
  function updateCount(visible, total) {
    if (!_container) return;
    var el = _container.querySelector('#explore-count');
    if (!el) return;
    el.textContent = (_search || _category !== 'all')
      ? visible + ' token' + (visible !== 1 ? 's' : '')
      : total + ' tokens';
  }

  /* ════════════════════════════════════════════════════════
     FULL UPDATE — filter + render + indicators + count
  ════════════════════════════════════════════════════════ */
  function update() {
    if (!_container) return;
    var listEl = _container.querySelector('#explore-list');
    if (!listEl) return;

    var raw = getMarketData(_exploreChain);
    if (!raw) { renderEmpty(listEl, true); return; }  /* still loading */

    var filtered = applyFilters(raw);
    if (!filtered.length) { renderEmpty(listEl, false); return; }

    renderList(listEl, filtered);
    updateSortIndicators();
    updateCount(filtered.length, raw.length);
  }

  /* ════════════════════════════════════════════════════════
     CHAIN PILLS HTML
  ════════════════════════════════════════════════════════ */
  function buildChainPills() {
    return getActiveNetworks().map(function (cid) {
      var name   = CHAIN_NAMES[cid] || ('Chain ' + cid);
      var color  = CHAIN_COLORS[cid] || 'var(--em)';
      var glow   = color + '44';
      var active = cid === _exploreChain;
      return [
        '<button class="explore-chain-pill' + (active ? ' active' : '') + '"',
          ' data-chain="' + cid + '" aria-pressed="' + active + '">',
          '<span class="explore-chain-dot"',
            ' style="background:' + color + ';box-shadow:0 0 6px 1px ' + glow + '">',
          '</span>',
          escHtml(name),
        '</button>',
      ].join('');
    }).join('');
  }

  /* ════════════════════════════════════════════════════════
     SORT ARROW SVG
  ════════════════════════════════════════════════════════ */
  function sortArrow() {
    return [
      '<span class="explore-sort-arrow" aria-hidden="true">',
        '<svg width="7" height="10" viewBox="0 0 7 10" fill="none">',
          '<path class="sort-up-path" d="M3.5 1v8M1 3.5L3.5 1 6 3.5"',
            ' stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
          '<path class="sort-dn-path" d="M1 6.5L3.5 9 6 6.5"',
            ' stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
      '</span>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     FULL MOUNT
     Builds entire view. Called once on first tab visit.
  ════════════════════════════════════════════════════════ */
  function mountExplore(container) {
    if (!container) return;

    /* Default explore chain = wallet's active chain */
    if (!_exploreChain) _exploreChain = getWalletChain();

    container.innerHTML = [
      '<div class="explore-view">',

        /* ── Search ── */
        '<div class="explore-search-row">',
          '<div class="explore-search-wrap">',
            '<svg class="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"',
              ' stroke="var(--dim)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
              ' aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-4-4"/></svg>',
            '<input class="explore-search-input" id="explore-search" type="text"',
              ' placeholder="Search name or symbol…"',
              ' value="' + escHtml(_search) + '"',
              ' autocomplete="off" autocorrect="off" spellcheck="false" inputmode="search"',
              ' aria-label="Search tokens">',
            '<button class="explore-search-clear" id="explore-search-clear"',
              ' aria-label="Clear search"' + (_search ? '' : ' hidden') + '>',
              '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">',
                '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
              '</svg>',
            '</button>',
          '</div>',
        '</div>',

        /* ── Chain pills ── */
        '<div class="explore-chain-pills" id="explore-chain-pills"',
          ' role="group" aria-label="Filter by chain">',
          buildChainPills(),
        '</div>',

        /* ── Category tabs ── */
        '<div class="explore-categories" role="tablist" aria-label="Token categories">',
          ['all','trending','gainers','losers','stables'].map(function (cat) {
            var labels = { all:'All', trending:'Trending', gainers:'Gainers', losers:'Losers', stables:'Stablecoins' };
            return '<button class="explore-cat' + (_category === cat ? ' active' : '') + '"'
              + ' data-cat="' + cat + '" role="tab">' + labels[cat] + '</button>';
          }).join(''),
        '</div>',

        /* ── Column header ── */
        '<div class="explore-col-header" aria-hidden="true">',
          '<span class="explore-col-token">',
            'TOKEN <span class="explore-count-badge" id="explore-count"></span>',
          '</span>',
          '<span class="explore-col-sortable explore-col-price" data-col="price"',
            ' role="button" tabindex="0" aria-label="Sort by price">PRICE' + sortArrow() + '</span>',
          '<span class="explore-col-sortable explore-col-change" data-col="change"',
            ' role="button" tabindex="0" aria-label="Sort by 24h change">24H' + sortArrow() + '</span>',
        '</div>',

        /* ── Token list ── */
        '<div class="explore-list" id="explore-list" role="list"></div>',

      '</div>',
    ].join('');

    _container = container;
    _mounted   = true;

    var listEl   = container.querySelector('#explore-list');
    var searchEl = container.querySelector('#explore-search');
    var clearEl  = container.querySelector('#explore-search-clear');

    /* ── Wire search ── */
    searchEl.addEventListener('input', function () {
      _search = searchEl.value;
      clearEl.hidden = !_search;
      clearTimeout(_debounce);
      _debounce = setTimeout(update, 180);
    });
    clearEl.addEventListener('click', function () {
      _search = ''; searchEl.value = ''; clearEl.hidden = true;
      clearTimeout(_debounce); update(); searchEl.focus();
    });

    /* ── Wire category tabs ── */
    container.querySelectorAll('.explore-cat').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (_category === btn.dataset.cat) return;
        _category = btn.dataset.cat;
        _sortCol  = null;
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        update();
      });
    });

    /* ── Wire chain pills ── */
    container.querySelectorAll('.explore-chain-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cid = Number(pill.dataset.chain);
        if (cid === _exploreChain) return;

        /* Switch local explore chain — NO global setState */
        _exploreChain = cid;
        container.querySelectorAll('.explore-chain-pill').forEach(function (p) {
          var active = Number(p.dataset.chain) === cid;
          p.classList.toggle('active', active);
          p.setAttribute('aria-pressed', String(active));
        });

        /* Skeleton if data not yet loaded; otherwise render immediately */
        var hasData = !!getMarketData(cid);
        if (!hasData) renderSkeleton(listEl);
        else update();
      });
    });

    /* ── Wire sort columns ── */
    container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      function handleSort() {
        var c = col.dataset.col;
        _sortDir = (_sortCol === c && _sortDir === 'desc') ? 'asc' : 'desc';
        _sortCol = c;
        _category = 'all';
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        container.querySelector('[data-cat="all"]').classList.add('active');
        update();
      }
      col.addEventListener('click', handleSort);
      col.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(); }
      });
    });

    /* Initial render */
    update();
  }

  /* ════════════════════════════════════════════════════════
     STATE LISTENERS
  ════════════════════════════════════════════════════════ */

  /* Tab activated */
  document.addEventListener('state:mobileTab', function (e) {
    if (e.detail !== 'explore') return;
    var container = document.getElementById('mobile-explore');
    if (!container) return;
    if (!_mounted) {
      mountExplore(container);
    } else {
      update(); /* Refresh in case data arrived while tab was hidden */
    }
  });

  /* Market data updated (per chain) — dispatched by market.js */
  document.addEventListener('state:marketData', function () {
    if (!_mounted || !_container) return;

    /* If the updated chain IS the one we're showing, update.
     * For sorted categories: full re-render. Stable: in-place. */
    var needsResort = _category === 'trending'
      || _category === 'gainers'
      || _category === 'losers'
      || _sortCol !== null;

    if (needsResort) update();
    else updatePricesInPlace();

    /* Also update chain pill for any chain that now has data (dot state) */
    if (_container) {
      getActiveNetworks().forEach(function (cid) {
        var pill = _container.querySelector('[data-chain="' + cid + '"]');
        if (pill && getMarketData(cid)) pill.classList.add('has-data');
      });
    }
  });

}());
