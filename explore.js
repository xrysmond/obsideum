/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — explore.js
   Market explore tab. Live prices, search, chain filter,
   category tabs (All / Trending / Gainers / Losers / Stablecoins),
   sortable columns, in-place price updates.
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════ */

  /* Chain-specific metadata */
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

  /* Brand color per chain — dots on pills + active glow */
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

  /* TrustWallet asset folder per chain (mirrors portfolio.js) */
  var CHAIN_FOLDERS = {
    1:      'ethereum',
    10:     'optimism',
    56:     'smartchain',
    130:    'ethereum',   /* Unichain uses ETH logo */
    137:    'polygon',
    8453:   'base',
    42161:  'arbitrum',
    43114:  'avalanche',
  };

  /* Common stablecoin symbols for category filter */
  var STABLE_SYMBOLS = {
    USDC: 1, USDT: 1, DAI: 1, FRAX: 1, TUSD: 1, BUSD: 1, LUSD: 1,
    PYUSD: 1, USDE: 1, USDBC: 1, GUSD: 1, SUSD: 1, CRVUSD: 1,
    MKUSD: 1, DOLA: 1, AGEUR: 1, EURC: 1, USDP: 1, FDUSD: 1,
  };

  /* ════════════════════════════════════════════════════════
     MODULE STATE
     Persists across tab switches — only destroyed on page reload.
  ════════════════════════════════════════════════════════ */
  var _mounted     = false;         /* true after first mount */
  var _container   = null;          /* cached DOM ref */
  var _category    = 'all';         /* 'all'|'trending'|'gainers'|'losers'|'stables' */
  var _sortCol     = null;          /* null | 'price' | 'change' */
  var _sortDir     = 'desc';        /* 'asc' | 'desc' */
  var _search      = '';            /* live search string */
  var _debounce    = null;          /* search debounce timer */

  /* ════════════════════════════════════════════════════════
     STATE ACCESSORS
  ════════════════════════════════════════════════════════ */
  function getTokenList()     { return (window.STATE && STATE.tokenList)                              || []; }
  function getPrices()        { return (window.STATE && STATE.prices)                                 || {}; }
  function getCurrentChain()  { return (window.STATE && STATE.network)                                || 1;  }
  function getActiveNetworks(){ return (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1]; }

  /* ════════════════════════════════════════════════════════
     FORMATTING
  ════════════════════════════════════════════════════════ */
  function formatUSD(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v === 0)    return '$0.00';
    if (v >= 1e9)   return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6)   return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3)   return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1)     return '$' + v.toFixed(2);
    if (v >= 0.001) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(4);
  }

  function formatChange(c) {
    if (c === null || c === undefined || isNaN(c)) return '—';
    return (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ════════════════════════════════════════════════════════
     ASSET LOGO
     Mirrors portfolio.js — reuses TrustWallet CDN.
  ════════════════════════════════════════════════════════ */
  function tokenLogoUrl(address, chainId) {
    var folder = CHAIN_FOLDERS[chainId] || 'ethereum';

    /* Native token → chain info/logo.png */
    if (!address || address === 'NATIVE') {
      return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
        + folder + '/info/logo.png';
    }

    /* ERC-20 → chain/assets/<checksum>/logo.png */
    try {
      var cs = ethers.utils.getAddress(address);
      return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
        + folder + '/assets/' + cs + '/logo.png';
    } catch (_) {
      return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
        + folder + '/info/logo.png';
    }
  }

  /* ════════════════════════════════════════════════════════
     FILTER + SORT PIPELINE
     Order: search → category → sort.
     Returns a new array — source array is never mutated.
  ════════════════════════════════════════════════════════ */
  function applyFilters(tokens) {
    var prices = getPrices();
    var q      = _search.trim().toLowerCase();

    /* 1. Search — name and symbol, case-insensitive */
    if (q) {
      tokens = tokens.filter(function (t) {
        return t.name.toLowerCase().indexOf(q)   > -1
            || t.symbol.toLowerCase().indexOf(q) > -1;
      });
    }

    /* 2. Category filter */
    if (_category === 'stables') {
      tokens = tokens.filter(function (t) {
        return STABLE_SYMBOLS[t.symbol.toUpperCase()];
      });
    } else if (_category === 'gainers') {
      tokens = tokens.filter(function (t) {
        var p = prices[t.address];
        return p && typeof p.change24h === 'number' && p.change24h > 0;
      });
    } else if (_category === 'losers') {
      tokens = tokens.filter(function (t) {
        var p = prices[t.address];
        return p && typeof p.change24h === 'number' && p.change24h < 0;
      });
    }

    /* 3. Sort */
    var sorted = tokens.slice(); /* copy — no in-place mutation */

    if (_category === 'trending') {
      /* Trending = highest absolute 24h move (biggest movers, up or down) */
      sorted.sort(function (a, b) {
        var pa = prices[a.address], pb = prices[b.address];
        var ca = (pa && typeof pa.change24h === 'number') ? Math.abs(pa.change24h) : 0;
        var cb = (pb && typeof pb.change24h === 'number') ? Math.abs(pb.change24h) : 0;
        return cb - ca;
      });
    } else if (_category === 'gainers') {
      sorted.sort(function (a, b) {
        var pa = prices[a.address], pb = prices[b.address];
        return (pb ? pb.change24h || 0 : 0) - (pa ? pa.change24h || 0 : 0);
      });
    } else if (_category === 'losers') {
      sorted.sort(function (a, b) {
        var pa = prices[a.address], pb = prices[b.address];
        return (pa ? pa.change24h || 0 : 0) - (pb ? pb.change24h || 0 : 0);
      });
    } else if (_sortCol === 'price') {
      sorted.sort(function (a, b) {
        var pa = prices[a.address], pb = prices[b.address];
        var ua = pa ? (pa.usd || 0) : 0;
        var ub = pb ? (pb.usd || 0) : 0;
        return _sortDir === 'asc' ? ua - ub : ub - ua;
      });
    } else if (_sortCol === 'change') {
      sorted.sort(function (a, b) {
        var pa = prices[a.address], pb = prices[b.address];
        var ca = pa ? (pa.change24h || 0) : 0;
        var cb = pb ? (pb.change24h || 0) : 0;
        return _sortDir === 'asc' ? ca - cb : cb - ca;
      });
    }
    /* Default (category = 'all' or 'stables', no sortCol) → TVL order from subgraph */

    return sorted;
  }

  /* ════════════════════════════════════════════════════════
     BUILD SINGLE ROW HTML
     Reuses .asset-row + .asset-row-* classes from core.css.
  ════════════════════════════════════════════════════════ */
  function buildRowHtml(token, chainId) {
    var prices  = getPrices();
    var p       = prices[token.address];
    var price   = p ? formatUSD(p.usd)      : '—';
    var change  = p ? p.change24h           : null;
    var valid   = typeof change === 'number' && !isNaN(change);
    var chgStr  = valid ? formatChange(change) : '—';
    var dir     = valid ? (change > 0 ? 'up' : change < 0 ? 'dn' : '') : '';
    var arrow   = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
    var logoSrc = tokenLogoUrl(token.address, chainId);
    var sym0    = escHtml((token.symbol || '?')[0].toUpperCase());

    return [
      '<div class="asset-row explore-row" data-address="' + escHtml(token.address) + '"',
        ' role="button" tabindex="0" aria-label="' + escHtml(token.name) + '">',

        '<div class="asset-row-logo-wrap">',
          '<img class="asset-row-logo" src="' + logoSrc + '"',
            ' alt="' + escHtml(token.symbol) + '"',
            ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">',
          '<div class="asset-row-logo-fallback" style="display:none">' + sym0 + '</div>',
        '</div>',

        '<div class="asset-row-identity">',
          '<span class="asset-row-name">' + escHtml(token.name) + '</span>',
          '<span class="asset-row-chain">' + escHtml(token.symbol) + '</span>',
        '</div>',

        '<div class="asset-row-price">',
          '<span class="asset-row-usd">' + price + '</span>',
          '<span class="asset-row-change ' + dir + '">',
            (arrow ? '<span class="explore-arrow">' + arrow + '</span>' : '') + chgStr,
          '</span>',
        '</div>',

      '</div>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     SKELETON  (8 rows — variable name widths for realism)
  ════════════════════════════════════════════════════════ */
  function renderSkeleton(listEl) {
    var widths = [72, 88, 60, 80, 100, 68, 90, 76];
    listEl.innerHTML = widths.map(function (w) {
      return [
        '<div class="asset-row" style="pointer-events:none">',
          '<div class="asset-row-logo-wrap">',
            '<div class="skeleton" style="width:36px;height:36px;border-radius:50%"></div>',
          '</div>',
          '<div class="asset-row-identity">',
            '<div class="skeleton" style="width:' + w + 'px;height:10px;margin-bottom:5px;border-radius:3px"></div>',
            '<div class="skeleton" style="width:32px;height:8px;border-radius:3px"></div>',
          '</div>',
          '<div class="asset-row-price" style="align-items:flex-end">',
            '<div class="skeleton" style="width:58px;height:10px;margin-bottom:5px;border-radius:3px"></div>',
            '<div class="skeleton" style="width:42px;height:8px;border-radius:3px"></div>',
          '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  /* ════════════════════════════════════════════════════════
     RENDER TOKEN LIST
     Full re-render — used when tokenList or filters change.
  ════════════════════════════════════════════════════════ */
  function renderList(listEl, tokens, chainId) {
    if (!tokens.length) {
      listEl.innerHTML = [
        '<div class="explore-empty">',
          '<svg width="36" height="36" viewBox="0 0 24 24" fill="none"',
            ' stroke="var(--dim)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">',
            '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
          '</svg>',
          '<span>No tokens found</span>',
        '</div>',
      ].join('');
      return;
    }

    listEl.innerHTML = tokens.map(function (t) { return buildRowHtml(t, chainId); }).join('');

    /* Wire tap → token detail */
    listEl.querySelectorAll('.explore-row').forEach(function (row) {
      function openToken() {
        setState({ token: row.dataset.address });
        if (window.innerWidth < 768) {
          if (typeof setMobileSubView === 'function') setMobileSubView('token');
        } else {
          if (typeof openRightPanel === 'function') openRightPanel('token');
        }
      }
      row.addEventListener('click', openToken);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openToken(); }
      });
    });
  }

  /* ════════════════════════════════════════════════════════
     IN-PLACE PRICE UPDATE
     Called on state:prices — updates text content only.
     Preserves scroll position and DOM structure.
  ════════════════════════════════════════════════════════ */
  function updatePricesInPlace(container) {
    if (!container) return;
    var listEl = container.querySelector('#explore-list');
    if (!listEl) return;
    var prices = getPrices();

    listEl.querySelectorAll('.explore-row[data-address]').forEach(function (row) {
      var address = row.dataset.address;
      var p       = prices[address];
      if (!p) return;

      var usdEl    = row.querySelector('.asset-row-usd');
      var changeEl = row.querySelector('.asset-row-change');

      if (usdEl) usdEl.textContent = formatUSD(p.usd);

      if (changeEl) {
        var c   = p.change24h;
        var valid = typeof c === 'number' && !isNaN(c);
        var dir   = valid ? (c > 0 ? 'up' : c < 0 ? 'dn' : '') : '';
        var arrow = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
        changeEl.innerHTML = (arrow ? '<span class="explore-arrow">' + arrow + '</span>' : '')
          + (valid ? formatChange(c) : '—');
        changeEl.className = 'asset-row-change' + (dir ? ' ' + dir : '');
      }
    });
  }

  /* ════════════════════════════════════════════════════════
     SORT INDICATOR UPDATE
     Highlights the active sort column arrow.
  ════════════════════════════════════════════════════════ */
  function updateSortIndicators(container) {
    container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      var isActive = col.dataset.col === _sortCol;
      col.classList.toggle('sort-active', isActive);
      col.classList.toggle('sort-asc',    isActive && _sortDir === 'asc');
      col.classList.toggle('sort-desc',   isActive && _sortDir === 'desc');
    });
  }

  /* ════════════════════════════════════════════════════════
     TOKEN COUNT BADGE
  ════════════════════════════════════════════════════════ */
  function updateCount(container, visible, total) {
    var el = container.querySelector('#explore-count');
    if (!el) return;
    var n = visible;
    el.textContent = (_search || _category !== 'all')
      ? n + ' token' + (n !== 1 ? 's' : '')
      : total + ' tokens';
  }

  /* ════════════════════════════════════════════════════════
     FULL UPDATE
     Runs the filter pipeline, renders the list,
     updates sort indicators and count badge.
  ════════════════════════════════════════════════════════ */
  function update(container) {
    if (!container) return;
    var listEl  = container.querySelector('#explore-list');
    if (!listEl) return;

    var chainId = getCurrentChain();
    var all     = getTokenList().filter(function (t) { return t.address !== 'NATIVE'; });
    var visible = applyFilters(all);

    renderList(listEl, visible, chainId);
    updateSortIndicators(container);
    updateCount(container, visible.length, all.length);
  }

  /* ════════════════════════════════════════════════════════
     BUILD CHAIN PILLS HTML
  ════════════════════════════════════════════════════════ */
  function buildChainPills() {
    var chain    = getCurrentChain();
    var networks = getActiveNetworks();
    return networks.map(function (cid) {
      var name  = CHAIN_NAMES[cid] || ('Chain ' + cid);
      var color = CHAIN_COLORS[cid] || 'var(--em)';
      var glow  = color + '44';
      return [
        '<button class="explore-chain-pill' + (cid === chain ? ' active' : '') + '"',
          ' data-chain="' + cid + '" aria-label="' + escHtml(name) + '">',
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
  function sortArrowSvg() {
    return [
      '<span class="explore-sort-arrow" aria-hidden="true">',
        '<svg width="7" height="10" viewBox="0 0 7 10" fill="none">',
          '<path d="M3.5 1v8M1 3.5L3.5 1 6 3.5"',
            ' stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"',
            ' class="sort-up-path"/>',
          '<path d="M1 6.5L3.5 9 6 6.5"',
            ' stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"',
            ' class="sort-dn-path"/>',
        '</svg>',
      '</span>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     FULL MOUNT
     Builds the entire view DOM, wires all interactions.
     Called once on first visit to the Explore tab.
  ════════════════════════════════════════════════════════ */
  function mountExplore(container) {
    if (!container) return;

    container.innerHTML = [
      '<div class="explore-view">',

        /* ── Search ── */
        '<div class="explore-search-row">',
          '<div class="explore-search-wrap">',
            '<svg class="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"',
              ' stroke="var(--dim)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
              ' aria-hidden="true">',
              '<circle cx="10.5" cy="10.5" r="6.5"/>',
              '<path d="M21 21l-4-4"/>',
            '</svg>',
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
        '<div class="explore-chain-pills" id="explore-chain-pills" role="group" aria-label="Filter by chain">',
          buildChainPills(),
        '</div>',

        /* ── Category tabs ── */
        '<div class="explore-categories" role="tablist" aria-label="Token categories">',
          '<button class="explore-cat' + (_category === 'all'      ? ' active' : '') + '" data-cat="all"      role="tab">All</button>',
          '<button class="explore-cat' + (_category === 'trending' ? ' active' : '') + '" data-cat="trending" role="tab">Trending</button>',
          '<button class="explore-cat' + (_category === 'gainers'  ? ' active' : '') + '" data-cat="gainers"  role="tab">Gainers</button>',
          '<button class="explore-cat' + (_category === 'losers'   ? ' active' : '') + '" data-cat="losers"   role="tab">Losers</button>',
          '<button class="explore-cat' + (_category === 'stables'  ? ' active' : '') + '" data-cat="stables"  role="tab">Stablecoins</button>',
        '</div>',

        /* ── Column header ── */
        '<div class="explore-col-header" aria-hidden="true">',
          '<span class="explore-col-token">',
            'TOKEN',
            '<span class="explore-count-badge" id="explore-count"></span>',
          '</span>',
          '<span class="explore-col-sortable explore-col-price" data-col="price"',
            ' role="button" tabindex="0" aria-label="Sort by price">',
            'PRICE', sortArrowSvg(),
          '</span>',
          '<span class="explore-col-sortable explore-col-change" data-col="change"',
            ' role="button" tabindex="0" aria-label="Sort by 24h change">',
            '24H', sortArrowSvg(),
          '</span>',
        '</div>',

        /* ── Token list ── */
        '<div class="explore-list" id="explore-list" role="list">',
        '</div>',

      '</div>',
    ].join('');

    _container = container;
    _mounted   = true;

    var listEl   = container.querySelector('#explore-list');
    var searchEl = container.querySelector('#explore-search');
    var clearEl  = container.querySelector('#explore-search-clear');

    /* Show skeleton if tokenList not yet loaded */
    if (!getTokenList().length) renderSkeleton(listEl);

    /* ── Search ── */
    searchEl.addEventListener('input', function () {
      _search    = searchEl.value;
      clearEl.hidden = !_search;
      clearTimeout(_debounce);
      _debounce  = setTimeout(function () { update(container); }, 180);
    });

    clearEl.addEventListener('click', function () {
      _search        = '';
      searchEl.value = '';
      clearEl.hidden = true;
      clearTimeout(_debounce);
      update(container);
      searchEl.focus();
    });

    /* ── Category tabs ── */
    container.querySelectorAll('.explore-cat').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (_category === btn.dataset.cat) return;
        _category = btn.dataset.cat;
        _sortCol  = null; /* Reset manual sort — category has its own ordering */
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        update(container);
      });
    });

    /* ── Chain pills ── */
    container.querySelectorAll('.explore-chain-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cid = Number(pill.dataset.chain);
        if (cid === getCurrentChain()) return;
        /* Immediate active state feedback */
        container.querySelectorAll('.explore-chain-pill').forEach(function (p) { p.classList.remove('active'); });
        pill.classList.add('active');
        /* Skeleton while loading new chain's tokenList */
        renderSkeleton(listEl);
        /* loadTokenList is defined in prices.js, globally accessible */
        if (typeof loadTokenList === 'function') loadTokenList(cid);
      });
    });

    /* ── Sort column headers ── */
    container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      function handleSort() {
        var c = col.dataset.col;
        if (_sortCol === c) {
          _sortDir = _sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          _sortCol = c;
          _sortDir = 'desc';
        }
        /* Switch to All when manually sorting */
        _category = 'all';
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        container.querySelector('[data-cat="all"]').classList.add('active');
        update(container);
      }
      col.addEventListener('click', handleSort);
      col.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(); }
      });
    });

    /* Initial render */
    update(container);
  }

  /* ════════════════════════════════════════════════════════
     STATE LISTENERS
  ════════════════════════════════════════════════════════ */

  /* Tab switch → Explore */
  document.addEventListener('state:mobileTab', function (e) {
    if (e.detail !== 'explore') return;
    var container = document.getElementById('mobile-explore');
    if (!container) return;
    if (!_mounted) {
      mountExplore(container);
    } else {
      /* Tab was already mounted — just refresh in case data changed while hidden */
      update(container);
    }
  });

  /* TokenList changed (chain switch, wallet connect, etc.) */
  document.addEventListener('state:tokenList', function () {
    if (!_mounted || !_container) return;
    /* Sync chain pill active state to reflect the new active chain */
    var chain = getCurrentChain();
    _container.querySelectorAll('.explore-chain-pill').forEach(function (p) {
      p.classList.toggle('active', Number(p.dataset.chain) === chain);
    });
    update(_container);
  });

  /* Live price tick — in-place update, no scroll jump */
  document.addEventListener('state:prices', function () {
    if (!_mounted || !_container) return;
    /* If category has price-sensitive sort (trending/gainers/losers/sortCol),
     * do a full re-sort. Otherwise just update text in-place. */
    if (_category === 'trending' || _category === 'gainers' || _category === 'losers' || _sortCol) {
      update(_container);
    } else {
      updatePricesInPlace(_container);
    }
  });

}());
