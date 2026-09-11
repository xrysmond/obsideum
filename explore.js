/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — explore.js  (Phase 9J — full rebuild)
   Token explorer tab.

   DATA SOURCES:
   ─────────────
   Token discovery:  Uniswap default token list
                     https://tokens.uniswap.org
                     Every token has a real address → every row is tappable.
                     No KNOWN_ADDRESSES. No null-address blocking. Ever.

   Prices:           DeFiLlama /prices/current/ (batch, no rate limit)
                     https://coins.llama.fi/prices/current/

   24h change:       DeFiLlama /percentage/ endpoint
                     https://coins.llama.fi/percentage/

   Token logos:      logoURI from token list → Trust Wallet asset CDN
   Chain logos:      Trust Wallet chain CDN  (pills + row badge)

   CHAIN FILTER:
   ─────────────
   Image pills: chain logo + short name.
   Updates _exploreChain only. Never touches STATE.network.

   NAVIGATION:
   ─────────────
   Every tap → setState({ token: address, tokenChainId: chainId })
   state:token listener in app.html owns all navigation.

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CHAIN CONFIG
  ════════════════════════════════════════════════════════ */
  var CHAINS = {
    1:     { name: 'Ethereum',  short: 'ETH',  color: '#627EEA', llama: 'ethereum',  tw: 'ethereum',   cgid: 'coingecko:ethereum',      nSym: 'ETH',  nName: 'Ethereum'  },
    10:    { name: 'Optimism',  short: 'OP',   color: '#FF0420', llama: 'optimism',  tw: 'optimism',   cgid: 'coingecko:ethereum',      nSym: 'ETH',  nName: 'Ethereum'  },
    56:    { name: 'BNB Chain', short: 'BNB',  color: '#F0B90B', llama: 'bsc',       tw: 'smartchain', cgid: 'coingecko:binancecoin',   nSym: 'BNB',  nName: 'BNB'       },
    130:   { name: 'Unichain',  short: 'UNI',  color: '#FC72FF', llama: 'unichain',  tw: null,         cgid: 'coingecko:ethereum',      nSym: 'ETH',  nName: 'Ethereum'  },
    137:   { name: 'Polygon',   short: 'POL',  color: '#8247E5', llama: 'polygon',   tw: 'polygon',    cgid: 'coingecko:matic-network', nSym: 'POL',  nName: 'Polygon'   },
    8453:  { name: 'Base',      short: 'BASE', color: '#0052FF', llama: 'base',      tw: 'base',       cgid: 'coingecko:ethereum',      nSym: 'ETH',  nName: 'Ethereum'  },
    42161: { name: 'Arbitrum',  short: 'ARB',  color: '#12AAFF', llama: 'arbitrum',  tw: 'arbitrum',   cgid: 'coingecko:ethereum',      nSym: 'ETH',  nName: 'Ethereum'  },
    43114: { name: 'Avalanche', short: 'AVAX', color: '#E84142', llama: 'avax',      tw: 'avalanche',  cgid: 'coingecko:avalanche-2',   nSym: 'AVAX', nName: 'Avalanche' },
  };

  var STABLE_SYMBOLS = {
    USDC:1, USDT:1, DAI:1, FRAX:1, TUSD:1, BUSD:1, LUSD:1,
    PYUSD:1, USDE:1, USDBC:1, GUSD:1, SUSD:1, CRVUSD:1,
    MKUSD:1, DOLA:1, AGEUR:1, EURC:1, USDP:1, FDUSD:1, USDS:1,
    USDD:1, CUSD:1, EURS:1, SEUR:1, MIMATIC:1, ALUSD:1,
  };

  var TOKEN_LIST_URL = 'https://tokens.uniswap.org';
  var LLAMA_PRICES   = 'https://coins.llama.fi/prices/current/';
  var LLAMA_PCT      = 'https://coins.llama.fi/percentage/';
  var TW_CHAIN_LOGO  = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/{f}/info/logo.png';
  var TW_ASSET_LOGO  = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/{f}/assets/{a}/logo.png';

  var PRICE_TTL  = 2 * 60 * 1000;          /* 2 min — re-fetch prices */
  var LIST_TTL   = 24 * 60 * 60 * 1000;    /* 24 h  — token list */
  var MAX_TOKENS = 100;                     /* per chain */
  var BATCH      = 50;                      /* DeFiLlama coins per request */

  /* ════════════════════════════════════════════════════════
     MODULE STATE
     Everything local. Nothing here writes to global STATE.
  ════════════════════════════════════════════════════════ */
  var _mounted      = false;
  var _container    = null;
  var _exploreChain = null;
  var _category     = 'all';
  var _sortCol      = null;
  var _sortDir      = 'desc';
  var _search       = '';
  var _debounce     = null;

  var _listData     = null;   /* raw Uniswap token array (all chains) */
  var _listTime     = 0;      /* when it was fetched */
  var _byChain      = {};     /* { chainId: Token[] }  — skeleton tokens, no prices yet */

  var _cache        = {};     /* { chainId: { tokens: Token[], at: number } } */
  var _flying       = {};     /* { chainId: Promise } — deduplicate in-flight */

  /* ════════════════════════════════════════════════════════
     URL HELPERS
  ════════════════════════════════════════════════════════ */
  function chainLogoUrl(chainId) {
    var c = CHAINS[chainId];
    if (!c || !c.tw) return '';
    return TW_CHAIN_LOGO.replace('{f}', c.tw);
  }

  function tokenLogoUrl(tok) {
    if (tok.logoURI) return tok.logoURI;
    var c = CHAINS[tok.chainId];
    if (!c || !c.tw || tok.address === 'NATIVE') return '';
    return TW_ASSET_LOGO.replace('{f}', c.tw).replace('{a}', tok.address);
  }

  /* DeFiLlama coin ID for a token */
  function llamaKey(tok) {
    if (tok.address === 'NATIVE') {
      var c = CHAINS[tok.chainId];
      return c ? c.cgid : null;
    }
    var cfg = CHAINS[tok.chainId];
    if (!cfg) return null;
    return cfg.llama + ':' + tok.address.toLowerCase();
  }

  /* ════════════════════════════════════════════════════════
     FETCH UNISWAP TOKEN LIST  (cached 24h in localStorage)
  ════════════════════════════════════════════════════════ */
  function fetchTokenList() {
    var now = Date.now();

    /* In-memory hit */
    if (_listData && (now - _listTime) < LIST_TTL) {
      return Promise.resolve(_listData);
    }

    /* localStorage hit */
    try {
      var raw = localStorage.getItem('obsideum:tokenlist:v2');
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.t && (now - p.t) < LIST_TTL && Array.isArray(p.d)) {
          _listData = p.d;
          _listTime = p.t;
          return Promise.resolve(_listData);
        }
      }
    } catch (_) {}

    return fetch(TOKEN_LIST_URL, { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('Token list HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.tokens)) throw new Error('Malformed token list');
        _listData = data.tokens;
        _listTime = now;
        try {
          localStorage.setItem('obsideum:tokenlist:v2', JSON.stringify({ t: now, d: data.tokens }));
        } catch (_) {}
        return _listData;
      });
  }

  /* ════════════════════════════════════════════════════════
     BUILD TOKEN ARRAY FOR ONE CHAIN
     Native first, then ERC-20s from Uniswap list.
     No prices yet — those come from DeFiLlama.
  ════════════════════════════════════════════════════════ */
  function tokensForChain(chainId) {
    if (_byChain[chainId]) return _byChain[chainId];
    var cfg = CHAINS[chainId];
    if (!cfg || !_listData) return [];

    var erc20 = _listData
      .filter(function (t) { return t.chainId === Number(chainId) && t.address; })
      .slice(0, MAX_TOKENS - 1)
      .map(function (t) {
        return {
          address:   t.address,
          symbol:    (t.symbol || '').toUpperCase(),
          name:      t.name   || '',
          decimals:  t.decimals || 18,
          logoURI:   t.logoURI  || '',
          chainId:   Number(chainId),
          price:     null,
          change24h: null,
        };
      });

    var native = {
      address:   'NATIVE',
      symbol:    cfg.nSym,
      name:      cfg.nName,
      decimals:  18,
      logoURI:   chainLogoUrl(chainId),  /* chain logo doubles as native token logo */
      chainId:   Number(chainId),
      price:     null,
      change24h: null,
    };

    var result = [native].concat(erc20);
    _byChain[chainId] = result;
    return result;
  }

  /* ════════════════════════════════════════════════════════
     DEFILLAMA PRICES  (batch GET, no rate limit)
  ════════════════════════════════════════════════════════ */
  function fetchPrices(tokens) {
    var keys = tokens.map(llamaKey).filter(Boolean);
    if (!keys.length) return Promise.resolve({});

    var batches = [], i;
    for (i = 0; i < keys.length; i += BATCH) {
      batches.push(keys.slice(i, i + BATCH));
    }

    return Promise.all(batches.map(function (b) {
      return fetch(LLAMA_PRICES + b.join(',') + '?searchWidth=4h', {
        headers: { Accept: 'application/json' },
      })
        .then(function (r) { return r.ok ? r.json() : { coins: {} }; })
        .then(function (d) { return (d && d.coins) || {}; })
        .catch(function () { return {}; });
    })).then(function (results) {
      return results.reduce(function (acc, r) { return Object.assign(acc, r); }, {});
    });
  }

  /* ════════════════════════════════════════════════════════
     DEFILLAMA 24H CHANGE  (batch GET)
  ════════════════════════════════════════════════════════ */
  function fetchChanges(tokens) {
    var keys = tokens.map(llamaKey).filter(Boolean);
    if (!keys.length) return Promise.resolve({});

    var batches = [], i;
    for (i = 0; i < keys.length; i += BATCH) {
      batches.push(keys.slice(i, i + BATCH));
    }

    return Promise.all(batches.map(function (b) {
      return fetch(LLAMA_PCT + b.join(',') + '?period=24h', {
        headers: { Accept: 'application/json' },
      })
        .then(function (r) { return r.ok ? r.json() : { coins: {} }; })
        .then(function (d) { return (d && d.coins) || {}; })
        .catch(function () { return {}; });
    })).then(function (results) {
      return results.reduce(function (acc, r) { return Object.assign(acc, r); }, {});
    });
  }

  /* ════════════════════════════════════════════════════════
     ENSURE DATA + RENDER
  ════════════════════════════════════════════════════════ */
  function ensureAndRender(chainId) {
    var listEl = _container && _container.querySelector('#explore-list');
    if (!listEl) return;

    var now    = Date.now();
    var cached = _cache[chainId];

    /* Fresh cache → render immediately */
    if (cached && (now - cached.at) < PRICE_TTL) {
      update();
      return;
    }

    /* Show skeleton only on first load (no stale data) */
    if (!cached) renderSkeleton(listEl);

    /* Deduplicate in-flight requests */
    if (_flying[chainId]) return;

    var p = fetchTokenList()
      .then(function () {
        var tokens = tokensForChain(chainId);
        if (!tokens.length) return [];

        return Promise.all([
          fetchPrices(tokens),
          fetchChanges(tokens),
        ]).then(function (results) {
          var prices  = results[0];
          var changes = results[1];

          return tokens.map(function (tok) {
            var key  = llamaKey(tok);
            var pe   = key ? prices[key]  : null;
            var chg  = key ? changes[key] : null;
            return Object.assign({}, tok, {
              price:     (pe && typeof pe.price === 'number') ? pe.price : null,
              change24h: typeof chg === 'number' ? chg : null,
            });
          });
        });
      })
      .then(function (merged) {
        _cache[chainId] = { tokens: merged, at: Date.now() };
        if (_exploreChain === Number(chainId) && _container) {
          markPillLoaded(chainId);
          update();
        }
      })
      .catch(function (err) {
        console.warn('[explore] chain', chainId, err.message || err);
        var el = _container && _container.querySelector('#explore-list');
        if (el && _exploreChain === Number(chainId)) renderError(el);
      })
      .finally(function () { delete _flying[chainId]; });

    _flying[chainId] = p;
  }

  /* ════════════════════════════════════════════════════════
     FILTER + SORT
  ════════════════════════════════════════════════════════ */
  function applyFilters(tokens) {
    var q = _search.trim().toLowerCase();

    if (q) {
      tokens = tokens.filter(function (t) {
        return t.name.toLowerCase().indexOf(q)   > -1
            || t.symbol.toLowerCase().indexOf(q) > -1;
      });
    }

    if      (_category === 'stables') { tokens = tokens.filter(function (t) { return STABLE_SYMBOLS[t.symbol]; }); }
    else if (_category === 'gainers') { tokens = tokens.filter(function (t) { return t.change24h !== null && t.change24h > 0; }); }
    else if (_category === 'losers')  { tokens = tokens.filter(function (t) { return t.change24h !== null && t.change24h < 0; }); }

    var out = tokens.slice();

    if      (_category === 'trending') { out.sort(function (a, b) { return Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0); }); }
    else if (_category === 'gainers')  { out.sort(function (a, b) { return (b.change24h || 0) - (a.change24h || 0); }); }
    else if (_category === 'losers')   { out.sort(function (a, b) { return (a.change24h || 0) - (b.change24h || 0); }); }
    else if (_sortCol === 'price') {
      out.sort(function (a, b) { var d = (b.price || 0) - (a.price || 0); return _sortDir === 'asc' ? -d : d; });
    } else if (_sortCol === 'change') {
      out.sort(function (a, b) { var d = (b.change24h || 0) - (a.change24h || 0); return _sortDir === 'asc' ? -d : d; });
    }

    return out;
  }

  /* ════════════════════════════════════════════════════════
     FORMATTERS
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

  function esc(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ════════════════════════════════════════════════════════
     CHAIN BADGE  (14px circle pinned to token logo)
  ════════════════════════════════════════════════════════ */
  function chainBadge(chainId) {
    var cfg = CHAINS[chainId] || {};
    var url = chainLogoUrl(chainId);
    if (url) {
      return '<img class="ex-badge" src="' + esc(url) + '" alt=""'
        + ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
        + '<div class="ex-badge ex-badge-fb" style="background:' + esc(cfg.color || '#888') + ';display:none">'
        + esc((cfg.short || '?')[0]) + '</div>';
    }
    return '<div class="ex-badge ex-badge-fb" style="background:' + esc(cfg.color || '#888') + '">'
      + esc((cfg.short || '?')[0]) + '</div>';
  }

  /* ════════════════════════════════════════════════════════
     ROW HTML
  ════════════════════════════════════════════════════════ */
  function buildRow(tok) {
    var chgOk = tok.change24h !== null && !isNaN(tok.change24h);
    var dir   = chgOk ? (tok.change24h > 0 ? 'up' : tok.change24h < 0 ? 'dn' : '') : '';
    var arrow = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
    var logo  = tokenLogoUrl(tok);
    var fb    = esc((tok.symbol || '?')[0]);

    return [
      '<div class="asset-row explore-row"',
        ' data-addr="' + esc(tok.address) + '"',
        ' data-chain="' + tok.chainId + '"',
        ' role="button" tabindex="0"',
        ' aria-label="' + esc(tok.name) + '">',

        /* Logo + chain badge */
        '<div class="asset-row-logo-wrap explore-logo-wrap">',
          logo
            ? '<img class="asset-row-logo" src="' + esc(logo) + '" alt="' + esc(tok.symbol) + '"'
                + ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
            : '',
          '<div class="asset-row-logo-fallback"' + (logo ? ' style="display:none"' : '') + '>' + fb + '</div>',
          /* Chain badge */
          '<div class="explore-badge-wrap">',
            chainBadge(tok.chainId),
          '</div>',
        '</div>',

        /* Identity */
        '<div class="asset-row-identity">',
          '<span class="asset-row-name">' + esc(tok.name) + '</span>',
          '<span class="asset-row-chain">' + esc(tok.symbol) + '</span>',
        '</div>',

        /* Price + change */
        '<div class="asset-row-price">',
          '<span class="asset-row-usd">' + fmtUSD(tok.price) + '</span>',
          '<span class="asset-row-change ' + dir + '">',
            arrow ? '<span class="explore-arrow">' + arrow + '</span>' : '',
            chgOk ? fmtChange(tok.change24h) : '—',
          '</span>',
        '</div>',

      '</div>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     STATES
  ════════════════════════════════════════════════════════ */
  function renderSkeleton(listEl) {
    var ws = [72, 88, 60, 95, 78, 110, 64, 82, 70, 90];
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

  function renderError(listEl) {
    listEl.innerHTML = [
      '<div class="explore-empty">',
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--dim)"',
          ' stroke-width="1.5" stroke-linecap="round" aria-hidden="true">',
          '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
        '</svg>',
        '<span>Failed to load token data.</span>',
        '<span style="font-size:.54rem;opacity:.45">Check connection and try again.</span>',
      '</div>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     MAIN RENDER
  ════════════════════════════════════════════════════════ */
  function update() {
    if (!_mounted || !_container) return;

    var listEl  = _container.querySelector('#explore-list');
    var countEl = _container.querySelector('#explore-count');
    if (!listEl) return;

    var cached = _cache[_exploreChain];
    if (!cached || !cached.tokens) return;

    var filtered = applyFilters(cached.tokens);

    if (countEl) countEl.textContent = filtered.length ? '(' + filtered.length + ')' : '';

    if (!filtered.length) {
      listEl.innerHTML = '<div class="explore-empty"><span>No tokens match.</span></div>';
      return;
    }

    listEl.innerHTML = filtered.map(buildRow).join('');

    /* Wire taps — EVERY row has a real address, all are tappable */
    listEl.querySelectorAll('.explore-row').forEach(function (row) {
      function tap() {
        var addr    = row.dataset.addr;
        var chainId = Number(row.dataset.chain);
        if (!addr) return;
        setState({ token: addr, tokenChainId: chainId });
      }
      row.addEventListener('click', tap);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(); }
      });
    });

    /* Sort arrow state */
    _container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      var c = col.dataset.col;
      col.classList.toggle('sort-asc',  _sortCol === c && _sortDir === 'asc');
      col.classList.toggle('sort-desc', _sortCol === c && _sortDir === 'desc');
    });
  }

  /* ════════════════════════════════════════════════════════
     CHAIN PILLS  (image + short name)
  ════════════════════════════════════════════════════════ */
  function buildPillsHtml() {
    var nets = (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
    return nets.map(function (cid) {
      var cfg    = CHAINS[cid] || {};
      var active = cid === _exploreChain;
      var url    = chainLogoUrl(cid);
      var logoHtml = url
        ? '<img class="ex-pill-img" src="' + esc(url) + '" alt=""'
            + ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
            + '<div class="ex-pill-img ex-pill-fb" style="background:' + esc(cfg.color || '#888') + ';display:none">'
            + esc((cfg.short || '?')[0]) + '</div>'
        : '<div class="ex-pill-img ex-pill-fb" style="background:' + esc(cfg.color || '#888') + '">'
            + esc((cfg.short || '?')[0]) + '</div>';

      return [
        '<button class="explore-chain-pill' + (active ? ' active' : '') + '"',
          ' data-chain="' + cid + '"',
          ' aria-pressed="' + active + '"',
          ' aria-label="' + esc(cfg.name || 'Chain ' + cid) + '">',
          logoHtml,
          '<span class="ex-pill-name">' + esc(cfg.short || cfg.name || '') + '</span>',
        '</button>',
      ].join('');
    }).join('');
  }

  function markPillLoaded(chainId) {
    if (!_container) return;
    var p = _container.querySelector('.explore-chain-pill[data-chain="' + chainId + '"]');
    if (p) p.classList.add('has-data');
  }

  /* ════════════════════════════════════════════════════════
     SORT ARROW
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
    if (!_exploreChain) _exploreChain = (window.STATE && STATE.network) || 1;

    container.innerHTML = [
      '<div class="explore-view">',

        /* Search bar */
        '<div class="explore-search-row">',
          '<div class="explore-search-wrap">',
            '<svg class="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"',
              ' stroke="var(--dim)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
              ' aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-4-4"/></svg>',
            '<input class="explore-search-input" id="explore-search" type="text"',
              ' placeholder="Search tokens…" value="' + esc(_search) + '"',
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

        /* Chain pills */
        '<div class="explore-chain-pills" id="explore-chain-pills"',
          ' role="group" aria-label="Filter by chain">',
          buildPillsHtml(),
        '</div>',

        /* Category tabs */
        '<div class="explore-categories" role="tablist" aria-label="Token categories">',
          ['all','trending','gainers','losers','stables'].map(function (cat) {
            var L = { all:'All', trending:'Trending', gainers:'Gainers', losers:'Losers', stables:'Stablecoins' };
            return '<button class="explore-cat' + (_category === cat ? ' active' : '') + '"'
              + ' data-cat="' + cat + '" role="tab">' + L[cat] + '</button>';
          }).join(''),
        '</div>',

        /* Column headers */
        '<div class="explore-col-header" aria-hidden="true">',
          '<span class="explore-col-token">TOKEN',
            ' <span class="explore-count-badge" id="explore-count"></span>',
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

    var searchEl = container.querySelector('#explore-search');
    var clearEl  = container.querySelector('#explore-search-clear');

    /* Search */
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

    /* Categories */
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

    /* Chain pills */
    container.querySelectorAll('.explore-chain-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cid = Number(pill.dataset.chain);
        if (cid === _exploreChain) return;

        _exploreChain = cid;
        _category     = 'all';
        _sortCol      = null;

        container.querySelectorAll('.explore-chain-pill').forEach(function (p) {
          var on = Number(p.dataset.chain) === cid;
          p.classList.toggle('active', on);
          p.setAttribute('aria-pressed', String(on));
        });
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        var allBtn = container.querySelector('[data-cat="all"]');
        if (allBtn) allBtn.classList.add('active');

        ensureAndRender(cid);
      });
    });

    /* Sort columns */
    container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      function sort() {
        var c = col.dataset.col;
        _sortDir  = (_sortCol === c && _sortDir === 'desc') ? 'asc' : 'desc';
        _sortCol  = c;
        _category = 'all';
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        var allBtn = container.querySelector('[data-cat="all"]');
        if (allBtn) allBtn.classList.add('active');
        update();
      }
      col.addEventListener('click', sort);
      col.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); }
      });
    });

    /* Initial load */
    ensureAndRender(_exploreChain);
  }

  /* ════════════════════════════════════════════════════════
     STATE LISTENER
  ════════════════════════════════════════════════════════ */
  document.addEventListener('state:mobileTab', function (e) {
    if (e.detail !== 'explore') return;
    var container = document.getElementById('mobile-explore');
    if (!container) return;

    if (!_mounted) {
      mountExplore(container);
    } else {
      /* Re-fetch if prices are stale, render from cache if fresh */
      var cached = _cache[_exploreChain];
      if (!cached || (Date.now() - cached.at) >= PRICE_TTL) {
        ensureAndRender(_exploreChain);
      } else {
        update();
      }
    }
  });

}());
