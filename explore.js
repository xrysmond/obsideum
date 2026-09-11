/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — explore.js  (Phase 9H-rebuild)
   Market explore tab.

   SWITCHED: STATE.marketData (market.js push) →
             own lazy CoinGecko fetch per chain (on-demand)

   Why:  market.js used to poll CoinGecko for all 8 chains every 60s.
         That was 8 req/min constantly — hit the 30 req/min limit,
         triggered 429s, and starved portfolio of prices too.

   Now:  explore fetches ONE chain from CoinGecko when the user
         actually opens the explore tab or switches chain pills.
         Data is cached for CACHE_TTL_MS (5 minutes) per chain.
         market.js (now DeFiLlama) is fully decoupled from explore.

   Chain pills are LOCAL state. Switching chains does NOT mutate
   any global STATE — it just switches _exploreChain.

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

  /*
   * CoinGecko category slugs per chain.
   * Used in /coins/markets?category= for chain-specific token lists.
   * Verified at coingecko.com/en/categories/<slug>.
   * null = no dedicated category; omit param → global top 100.
   */
  var CHAIN_CATEGORY = {
    1:      'ethereum-ecosystem',
    10:     'optimism-ecosystem',
    56:     'binance-smart-chain',
    130:    null,                  /* Unichain — no CoinGecko category yet */
    137:    'polygon-ecosystem',
    8453:   'base-ecosystem',
    42161:  'arbitrum-ecosystem',
    43114:  'avalanche-ecosystem',
  };

  /* CoinGecko native token ID per chain — to auto-assign address='NATIVE' */
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

  var STABLE_SYMBOLS = {
    USDC:1, USDT:1, DAI:1, FRAX:1, TUSD:1, BUSD:1, LUSD:1,
    PYUSD:1, USDE:1, USDBC:1, GUSD:1, SUSD:1, CRVUSD:1,
    MKUSD:1, DOLA:1, AGEUR:1, EURC:1, USDP:1, FDUSD:1, USDS:1,
  };

  var CACHE_TTL_MS = 5 * 60 * 1000;  /* 5 minutes per chain */

  /* ════════════════════════════════════════════════════════
     MODULE STATE
     All local — nothing here writes to global STATE.
  ════════════════════════════════════════════════════════ */
  var _mounted      = false;
  var _container    = null;
  var _exploreChain = null;
  var _category     = 'all';
  var _sortCol      = null;
  var _sortDir      = 'desc';
  var _search       = '';
  var _debounce     = null;

  /* Per-chain cache */
  var _cache       = {};   /* { chainId: token[] }  */
  var _cacheTime   = {};   /* { chainId: Date.now() at fetch } */
  var _fetchingFor = {};   /* { chainId: Promise }  — deduplicates in-flight requests */

  /* ════════════════════════════════════════════════════════
     ACCESSORS
  ════════════════════════════════════════════════════════ */
  function getCachedData(chainId) {
    var age = Date.now() - (_cacheTime[chainId] || 0);
    if (_cache[chainId] && age < CACHE_TTL_MS) return _cache[chainId];
    return null;
  }

  function getActiveNetworks() {
    return (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
  }

  function getWalletChain() {
    return (window.STATE && STATE.network) || 1;
  }

  /* ════════════════════════════════════════════════════════
     COINGECKO FETCH  (lazy, per chain, cached 5 min)
     Returns Promise<token[]> — resolves from cache when fresh.
  ════════════════════════════════════════════════════════ */
  function fetchChain(chainId) {
    /* Return cached data immediately if fresh */
    var cached = getCachedData(chainId);
    if (cached) return Promise.resolve(cached);

    /* Deduplicate in-flight requests for the same chain */
    if (_fetchingFor[chainId]) return _fetchingFor[chainId];

    var category   = CHAIN_CATEGORY[chainId] || null;
    var nativeCgId = CHAIN_NATIVE_CGID[chainId] || null;

    var url = 'https://api.coingecko.com/api/v3/coins/markets'
      + '?vs_currency=usd'
      + '&order=market_cap_desc'
      + '&per_page=100'
      + '&page=1'
      + '&sparkline=false'
      + (category ? '&category=' + encodeURIComponent(category) : '');

    var promise = fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 429) {
          /* Rate limited — keep stale data if we have it */
          console.warn('[explore.js] CoinGecko rate limited on chain', chainId);
          var stale = _cache[chainId];
          if (stale) return stale;
          throw new Error('Rate limited and no cached data');
        }
        if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
        return res.json();
      })
      .then(function (coins) {
        if (!Array.isArray(coins)) throw new Error('Response is not an array');

        /* Resolve address from KNOWN_ADDRESSES (window.KNOWN_ADDRESSES set by market.js) */
        var knownAddrs = window.KNOWN_ADDRESSES || {};

        var tokens = coins.map(function (c) {
          var addr = null;
          if (c.id === nativeCgId) {
            addr = 'NATIVE';
          } else {
            var k = knownAddrs[c.id];
            if (k && k[chainId]) addr = k[chainId];
          }
          return {
            id:        c.id,
            symbol:    (c.symbol || '').toUpperCase(),
            name:      c.name   || '',
            image:     c.image  || '',
            price:     typeof c.current_price               === 'number' ? c.current_price               : null,
            change24h: typeof c.price_change_percentage_24h === 'number' ? c.price_change_percentage_24h : null,
            volume24h: typeof c.total_volume                === 'number' ? c.total_volume                : null,
            marketCap: typeof c.market_cap                  === 'number' ? c.market_cap                  : null,
            rank:      c.market_cap_rank || null,
            address:   addr,
          };
        });

        _cache[chainId]     = tokens;
        _cacheTime[chainId] = Date.now();
        return tokens;
      })
      .catch(function (err) {
        console.warn('[explore.js] fetchChain', chainId, err.message);
        return _cache[chainId] || [];
      })
      .finally(function () {
        delete _fetchingFor[chainId];
      });

    _fetchingFor[chainId] = promise;
    return promise;
  }

  /* ════════════════════════════════════════════════════════
     ENSURE DATA + RENDER
     Fetches if needed, then calls update().
     Shows skeleton while fetching.
  ════════════════════════════════════════════════════════ */
  function ensureAndRender(chainId) {
    var listEl = _container && _container.querySelector('#explore-list');
    if (!listEl) return;

    var cached = getCachedData(chainId);
    if (cached) {
      update();
      return;
    }

    renderSkeleton(listEl);

    fetchChain(chainId).then(function () {
      /* Only render if the user hasn't switched away while fetching */
      if (_exploreChain === chainId && _container) {
        markPillHasData(chainId);
        update();
      }
    });
  }

  /* ════════════════════════════════════════════════════════
     FILTER + SORT PIPELINE
  ════════════════════════════════════════════════════════ */
  function applyFilters(tokens) {
    var q = _search.trim().toLowerCase();

    if (q) {
      tokens = tokens.filter(function (t) {
        return t.name.toLowerCase().indexOf(q) > -1
            || t.symbol.toLowerCase().indexOf(q) > -1;
      });
    }

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

    return out;
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
     ROW HTML
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
            '<div class="skeleton" style="width:40px;height:9px;border-radius:3px"></div>',
          '</div>',
          '<div class="asset-row-price">',
            '<div class="skeleton" style="width:60px;height:10px;margin-bottom:5px;border-radius:3px;margin-left:auto"></div>',
            '<div class="skeleton" style="width:44px;height:9px;border-radius:3px;margin-left:auto"></div>',
          '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  /* ════════════════════════════════════════════════════════
     UPDATE — renders from local cache for _exploreChain
  ════════════════════════════════════════════════════════ */
  function update() {
    if (!_mounted || !_container) return;

    var listEl  = _container.querySelector('#explore-list');
    var countEl = _container.querySelector('#explore-count');
    if (!listEl) return;

    var data = getCachedData(_exploreChain);
    if (!data) {
      /* No data yet — caller should have shown skeleton already */
      return;
    }

    var filtered = applyFilters(data);

    if (countEl) countEl.textContent = filtered.length ? '(' + filtered.length + ')' : '';

    if (!filtered.length) {
      listEl.innerHTML = '<div class="explore-empty">No tokens match your search.</div>';
      return;
    }

    listEl.innerHTML = filtered.map(buildRowHtml).join('');

    /* Wire token taps */
    listEl.querySelectorAll('.explore-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var cgid  = row.dataset.cgid;
        var data  = getCachedData(_exploreChain);
        if (!data) return;

        var entry = data.find(function (t) { return t.id === cgid; });
        if (!entry) return;

        /* Resolve address. For known addresses this is synchronous (no HTTP).
         * For unknowns it may do one CoinGecko /coins/{id} fetch. */
        window.resolveMarketAddress(entry, _exploreChain).then(function (addr) {
          if (!addr) return; /* Could not resolve — do nothing */

          /* Pass full CoinGecko metadata alongside the address.
           * buildPanel in app.html reads STATE.tokenMeta first so it never
           * falls through to getToken() (which only knows STATE.tokenList,
           * i.e. the active wallet chain). This makes every explore token
           * render correctly regardless of which chain it lives on. */
          setState({
            tokenMeta: {
              address:   addr,
              name:      entry.name,
              symbol:    entry.symbol,
              image:     entry.image,       /* CoinGecko CDN — always works cross-chain */
              price:     entry.price,
              change24h: entry.change24h,
              marketCap: entry.marketCap,
              volume24h: entry.volume24h,
            },
            token:        addr,
            tokenChainId: _exploreChain,
          });
        });
      });

      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          row.click();
        }
      });
    });

    /* Update sort arrow classes */
    if (_container) {
      _container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
        var c = col.dataset.col;
        col.classList.toggle('sorted-asc',  _sortCol === c && _sortDir === 'asc');
        col.classList.toggle('sorted-desc', _sortCol === c && _sortDir === 'desc');
      });
    }
  }

  /* ════════════════════════════════════════════════════════
     CHAIN PILLS HTML
  ════════════════════════════════════════════════════════ */
  function buildChainPills() {
    var nets = getActiveNetworks();
    return nets.map(function (cid) {
      var color  = CHAIN_COLORS[cid] || '#888';
      var active = cid === _exploreChain;
      return [
        '<button class="explore-chain-pill' + (active ? ' active' : '') + '"',
          ' data-chain="' + cid + '"',
          ' style="--pill-color:' + color + '"',
          ' aria-pressed="' + active + '"',
          ' aria-label="' + escHtml(CHAIN_NAMES[cid] || 'Chain ' + cid) + '">',
          escHtml(CHAIN_NAMES[cid] || 'Chain ' + cid),
        '</button>',
      ].join('');
    }).join('');
  }

  function markPillHasData(chainId) {
    if (!_container) return;
    var pill = _container.querySelector('[data-chain="' + chainId + '"]');
    if (pill) pill.classList.add('has-data');
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
  ════════════════════════════════════════════════════════ */
  function mountExplore(container) {
    if (!container) return;

    if (!_exploreChain) _exploreChain = getWalletChain();

    container.innerHTML = [
      '<div class="explore-view">',

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

        '<div class="explore-chain-pills" id="explore-chain-pills"',
          ' role="group" aria-label="Filter by chain">',
          buildChainPills(),
        '</div>',

        '<div class="explore-categories" role="tablist" aria-label="Token categories">',
          ['all','trending','gainers','losers','stables'].map(function (cat) {
            var labels = { all:'All', trending:'Trending', gainers:'Gainers', losers:'Losers', stables:'Stablecoins' };
            return '<button class="explore-cat' + (_category === cat ? ' active' : '') + '"'
              + ' data-cat="' + cat + '" role="tab">' + labels[cat] + '</button>';
          }).join(''),
        '</div>',

        '<div class="explore-col-header" aria-hidden="true">',
          '<span class="explore-col-token">',
            'TOKEN <span class="explore-count-badge" id="explore-count"></span>',
          '</span>',
          '<span class="explore-col-sortable explore-col-price" data-col="price"',
            ' role="button" tabindex="0" aria-label="Sort by price">PRICE' + sortArrow() + '</span>',
          '<span class="explore-col-sortable explore-col-change" data-col="change"',
            ' role="button" tabindex="0" aria-label="Sort by 24h change">24H' + sortArrow() + '</span>',
        '</div>',

        '<div class="explore-list" id="explore-list" role="list"></div>',

      '</div>',
    ].join('');

    _container = container;
    _mounted   = true;

    var listEl   = container.querySelector('#explore-list');
    var searchEl = container.querySelector('#explore-search');
    var clearEl  = container.querySelector('#explore-search-clear');

    /* Wire search */
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

    /* Wire category tabs */
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

    /* Wire chain pills */
    container.querySelectorAll('.explore-chain-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cid = Number(pill.dataset.chain);
        if (cid === _exploreChain) return;

        _exploreChain = cid;
        container.querySelectorAll('.explore-chain-pill').forEach(function (p) {
          var active = Number(p.dataset.chain) === cid;
          p.classList.toggle('active', active);
          p.setAttribute('aria-pressed', String(active));
        });

        ensureAndRender(cid);
      });
    });

    /* Wire sort columns */
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

    /* Initial data load for the default chain */
    ensureAndRender(_exploreChain);
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
      /* Re-fetch if stale; render from cache if fresh */
      ensureAndRender(_exploreChain);
    }
  });

  /* NOTE: state:marketData listener removed.
   * explore.js no longer depends on STATE.marketData.
   * It owns its own fetch → _cache flow. */

}());
