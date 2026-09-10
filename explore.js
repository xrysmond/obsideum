/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — explore.js  (Phase 9H-rebuild v2)

   ╔═══════════════════════════════════════════════════════════════╗
   ║  BUGS FIXED vs Phase 9H                                      ║
   ╠═══════════════════════════════════════════════════════════════╣
   ║  1. Tokens on non-Ethereum chains NOT CLICKABLE              ║
   ║     Root cause: address resolved once at fetchChain time      ║
   ║     from window.KNOWN_ADDRESSES — but only ~20 tokens/chain  ║
   ║     have known addresses. All others had null → no nav.      ║
   ║                                                               ║
   ║     Fix A: Resolve address LIVE at tap time (not from cache). ║
   ║     Fix B: Background-fetch Uniswap V3 token list for the    ║
   ║            explore chain via The Graph subgraph.              ║
   ║            Covers 200+ top-TVL tokens per chain.             ║
   ║            Match by symbol at tap time — no CoinGecko call.  ║
   ║                                                               ║
   ║  2. SEARCH TEXT CARRIES OVER when switching chains           ║
   ║     Fix: clear _search + input value on chain pill switch.   ║
   ║                                                               ║
   ║  3. SORT DIRECTION doesn't reset on category switch          ║
   ║     Fix: reset _sortDir = 'desc' in category click handler.  ║
   ║                                                               ║
   ║  4. EXPLORE TAB never mounts on re-entry after first visit   ║
   ║     Fix: guard on _container validity, not just _mounted.    ║
   ╚═══════════════════════════════════════════════════════════════╝

   Architecture:
   ─────────────
   • CoinGecko /coins/markets — fetched lazily per chain, cached 5 min.
     Gives market data (price, change, market cap, rank, image).

   • The Graph Uniswap V3 subgraph — fetched in background when a
     chain is opened in explore. Gives on-chain addresses for tokens.
     Stored in _tokenListCache[chainId] — NEVER writes STATE.tokenList.

   • Address resolution order at tap time (no network calls):
       1. NATIVE check (entry.id === chain's native CoinGecko ID)
       2. window.KNOWN_ADDRESSES[cgid][chainId]  (hardcoded ~30 tokens)
       3. _tokenListCache[chainId] symbol match  (200+ subgraph tokens)
       4. null → token shown dimmed, tap shows "Not navigable" toast

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────────
     CONSTANTS
  ────────────────────────────────────────────────────────────────── */
  var CHAIN_NAMES = {
    1:     'Ethereum',
    10:    'Optimism',
    56:    'BNB Chain',
    130:   'Unichain',
    137:   'Polygon',
    8453:  'Base',
    42161: 'Arbitrum',
    43114: 'Avalanche',
  };

  var CHAIN_COLORS = {
    1:     '#627EEA',
    10:    '#FF0420',
    56:    '#F0B90B',
    130:   '#FC72FF',
    137:   '#8247E5',
    8453:  '#0052FF',
    42161: '#12AAFF',
    43114: '#E84142',
  };

  /*
   * CoinGecko category slugs per chain.
   * Verified at coingecko.com/en/categories/<slug>.
   * null → no dedicated category; omit param → global top 100.
   */
  var CHAIN_CATEGORY = {
    1:     'ethereum-ecosystem',
    10:    'optimism-ecosystem',
    56:    'binance-smart-chain',
    130:   null,
    137:   'polygon-ecosystem',
    8453:  'base-ecosystem',
    42161: 'arbitrum-ecosystem',
    43114: 'avalanche-ecosystem',
  };

  /* CoinGecko ID for each chain's native token */
  var CHAIN_NATIVE_CGID = {
    1:     'ethereum',
    10:    'ethereum',
    56:    'binancecoin',
    130:   'ethereum',
    137:   'matic-network',
    8453:  'ethereum',
    42161: 'ethereum',
    43114: 'avalanche-2',
  };

  var STABLE_SYMBOLS = {
    /* Core */
    USDC:1, USDT:1, DAI:1, BUSD:1, TUSD:1, FRAX:1, LUSD:1,
    /* Circle ecosystem */
    PYUSD:1, EURC:1, USDP:1,
    /* Bridged / chain variants */
    'USDC.E':1, USDBC:1, 'USDbC':1, USDT0:1,
    /* Algo / yield */
    USDE:1, USDS:1, MKUSD:1, CRVUSD:1, DOLA:1, SUSD:1,
    GUSD:1, FDUSD:1, AGEUR:1,
    /* Less common but real */
    USDD:1, HAY:1, GRAI:1, BOLD:1, BEAN:1,
  };

  var CACHE_TTL_MS     = 5  * 60 * 1000;  /* 5 min CoinGecko market data */
  var TOKEN_LIST_TTL   = 30 * 60 * 1000;  /* 30 min The Graph token list  */
  var NO_ADDRESS_CLASS = 'explore-row--no-nav';

  /* ──────────────────────────────────────────────────────────────────
     MODULE STATE  (all local — nothing here writes global STATE)
  ────────────────────────────────────────────────────────────────── */
  var _mounted      = false;
  var _container    = null;
  var _exploreChain = null;
  var _category     = 'all';
  var _sortCol      = null;
  var _sortDir      = 'desc';
  var _search       = '';
  var _debounce     = null;

  /* CoinGecko market data cache */
  var _marketCache    = {};   /* { chainId: token[] } */
  var _marketTime     = {};   /* { chainId: Date.now() } */
  var _marketFetching = {};   /* { chainId: Promise } */

  /* Uniswap V3 token list cache (from The Graph) */
  var _tokenListCache    = {};   /* { chainId: [{address, symbol, name}] } */
  var _tokenListTime     = {};   /* { chainId: Date.now() } */
  var _tokenListFetching = {};   /* { chainId: Promise } */

  /* ──────────────────────────────────────────────────────────────────
     ACCESSORS
  ────────────────────────────────────────────────────────────────── */
  function getActiveNetworks() {
    return (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
  }

  function getWalletChain() {
    return Number((window.STATE && STATE.network) || 1);
  }

  function isFreshMarket(chainId) {
    return !!(_marketCache[chainId] && (Date.now() - (_marketTime[chainId] || 0)) < CACHE_TTL_MS);
  }

  function isFreshTokenList(chainId) {
    return !!(_tokenListCache[chainId] && (Date.now() - (_tokenListTime[chainId] || 0)) < TOKEN_LIST_TTL);
  }

  /* ──────────────────────────────────────────────────────────────────
     COINGECKO MARKET FETCH
     Lazy, per-chain, cached 5 minutes.
     Rate impact: at most 1 request per chain per 5 minutes.
  ────────────────────────────────────────────────────────────────── */
  function fetchMarketData(chainId) {
    if (isFreshMarket(chainId)) return Promise.resolve(_marketCache[chainId]);
    if (_marketFetching[chainId]) return _marketFetching[chainId];

    var category   = CHAIN_CATEGORY[chainId] || null;
    var nativeCgId = CHAIN_NATIVE_CGID[chainId];

    var url = 'https://api.coingecko.com/api/v3/coins/markets'
      + '?vs_currency=usd'
      + '&order=market_cap_desc'
      + '&per_page=100'
      + '&page=1'
      + '&sparkline=false'
      + '&price_change_percentage=24h'
      + (category ? '&category=' + encodeURIComponent(category) : '');

    var p = fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 429) {
          /* Rate limited — return stale if available */
          console.warn('[explore.js] CoinGecko 429 on chain', chainId);
          if (_marketCache[chainId]) return _marketCache[chainId];
          throw new Error('Rate limited, no cache');
        }
        if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
        return res.json();
      })
      .then(function (coins) {
        if (!Array.isArray(coins)) throw new Error('Response not array');

        var known = window.KNOWN_ADDRESSES || {};

        var tokens = coins.map(function (c, idx) {
          /* Quick address lookup from KNOWN_ADDRESSES at parse time.
             Even if null, resolveAddressLive() will try the token list. */
          var addr = null;
          if (c.id === nativeCgId) {
            addr = 'NATIVE';
          } else {
            var k = known[c.id];
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
            rank:      c.market_cap_rank || (idx + 1),
            address:   addr,
          };
        });

        _marketCache[chainId] = tokens;
        _marketTime[chainId]  = Date.now();
        return tokens;
      })
      .catch(function (err) {
        console.warn('[explore.js] fetchMarketData', chainId, err.message);
        return _marketCache[chainId] || [];
      })
      .finally(function () { delete _marketFetching[chainId]; });

    _marketFetching[chainId] = p;
    return p;
  }

  /* ──────────────────────────────────────────────────────────────────
     THE GRAPH TOKEN LIST FETCH
     Background fetch of top-200 Uniswap V3 tokens per chain.
     Used ONLY for address resolution — does NOT write STATE.tokenList.
     Reads subgraph config exported by market.js.
  ────────────────────────────────────────────────────────────────── */
  function fetchTokenList(chainId) {
    if (isFreshTokenList(chainId)) return Promise.resolve(_tokenListCache[chainId]);
    if (_tokenListFetching[chainId]) return _tokenListFetching[chainId];

    var subgraphIds = window.OBSIDEUM_SUBGRAPH_IDS || {};
    var graphKey    = window.OBSIDEUM_GRAPH_KEY    || '';
    var subgraphId  = subgraphIds[Number(chainId)];

    if (!subgraphId) return Promise.resolve([]);

    var endpoint = 'https://gateway.thegraph.com/api/' + graphKey
                 + '/subgraphs/id/' + subgraphId;

    var query = JSON.stringify({
      query: '{ tokens(first:200 orderBy:totalValueLockedUSD orderDirection:desc where:{totalValueLockedUSD_gt:"5000"}) { id symbol name } }',
    });

    var p = fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    query,
    })
    .then(function (res) {
      if (!res.ok) throw new Error('Graph HTTP ' + res.status);
      return res.json();
    })
    .then(function (json) {
      var raw   = (json.data && json.data.tokens) || [];
      var list  = raw.map(function (t) {
        /* Checksum the lowercase address returned by The Graph */
        var addr = t.id;
        try {
          if (typeof ethers !== 'undefined' && ethers.utils && ethers.utils.getAddress) {
            addr = ethers.utils.getAddress(t.id);
          }
        } catch (_) {}
        return { address: addr, symbol: (t.symbol || '').toUpperCase(), name: t.name || '' };
      });
      _tokenListCache[chainId] = list;
      _tokenListTime[chainId]  = Date.now();
      return list;
    })
    .catch(function (err) {
      console.warn('[explore.js] fetchTokenList', chainId, err.message);
      return _tokenListCache[chainId] || [];
    })
    .finally(function () { delete _tokenListFetching[chainId]; });

    _tokenListFetching[chainId] = p;
    return p;
  }

  /* ──────────────────────────────────────────────────────────────────
     LIVE ADDRESS RESOLUTION  (called at tap time, no network)
     Checks three sources in order — all synchronous.
  ────────────────────────────────────────────────────────────────── */
  function resolveAddressLive(entry, chainId) {
    var cgid       = entry.id;
    var nativeCgId = CHAIN_NATIVE_CGID[Number(chainId)];

    /* 1. Native token */
    if (cgid === nativeCgId) return 'NATIVE';

    /* 2. KNOWN_ADDRESSES — covers ~30 well-known tokens */
    var known = window.KNOWN_ADDRESSES || {};
    var k = known[cgid];
    if (k && k[chainId]) return k[chainId];

    /* 3. The Graph token list — symbol match (covers 200+ per chain) */
    var tl  = _tokenListCache[Number(chainId)] || [];
    var sym = entry.symbol;  /* already uppercase */
    /* Try symbol first (fast) */
    var bySymbol = tl.find(function (t) { return t.symbol === sym; });
    if (bySymbol) return bySymbol.address;
    /* Try name fallback (handles 'USD Coin' → 'USDC' mismatches) */
    var lname  = (entry.name || '').toLowerCase();
    var byName = tl.find(function (t) {
      return t.name && t.name.toLowerCase() === lname;
    });
    if (byName) return byName.address;

    return null;
  }

  /* ──────────────────────────────────────────────────────────────────
     ENSURE DATA + RENDER
  ────────────────────────────────────────────────────────────────── */
  function ensureAndRender(chainId) {
    if (!_container) return;
    var listEl = _container.querySelector('#explore-list');
    if (!listEl) return;

    if (isFreshMarket(chainId)) {
      update();
      /* Also kick off token list fetch in background if needed */
      if (!isFreshTokenList(chainId)) fetchTokenList(chainId);
      return;
    }

    renderSkeleton(listEl);

    /* Kick off both fetches in parallel */
    var marketP    = fetchMarketData(chainId);
    var tokenListP = isFreshTokenList(chainId) ? Promise.resolve() : fetchTokenList(chainId);

    Promise.all([marketP, tokenListP]).then(function () {
      if (_exploreChain === Number(chainId) && _container) {
        update();
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     FILTER + SORT PIPELINE
  ────────────────────────────────────────────────────────────────── */
  function applyFilters(tokens) {
    var out = tokens;
    var q   = _search.trim().toLowerCase();

    /* Text search */
    if (q) {
      out = out.filter(function (t) {
        return t.name.toLowerCase().indexOf(q) > -1
            || t.symbol.toLowerCase().indexOf(q) > -1;
      });
    }

    /* Category filter */
    switch (_category) {
      case 'stables':
        out = out.filter(function (t) { return STABLE_SYMBOLS[t.symbol]; });
        break;
      case 'gainers':
        out = out.filter(function (t) { return t.change24h !== null && t.change24h > 0; });
        break;
      case 'losers':
        out = out.filter(function (t) { return t.change24h !== null && t.change24h < 0; });
        break;
      /* 'all' and 'trending' need no filter */
    }

    /* Sort */
    out = out.slice(); /* always sort a copy */

    switch (_category) {
      case 'trending':
        /* Most volatile by absolute 24h change — nulls last */
        out.sort(function (a, b) {
          var va = a.change24h !== null ? Math.abs(a.change24h) : -Infinity;
          var vb = b.change24h !== null ? Math.abs(b.change24h) : -Infinity;
          return vb - va;
        });
        break;
      case 'gainers':
        /* Largest gain first */
        out.sort(function (a, b) { return (b.change24h || 0) - (a.change24h || 0); });
        break;
      case 'losers':
        /* Biggest loss first */
        out.sort(function (a, b) { return (a.change24h || 0) - (b.change24h || 0); });
        break;
      default:
        /* 'all' / 'stables' — respect column sort or default to market cap rank */
        if (_sortCol === 'price') {
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
        /* else: CoinGecko already gave us market_cap_desc, keep it */
    }

    return out;
  }

  /* ──────────────────────────────────────────────────────────────────
     FORMATTING
  ────────────────────────────────────────────────────────────────── */
  function fmtPrice(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 100000) return '$' + Math.round(v).toLocaleString('en-US');
    if (v >= 1)      return '$' + v.toFixed(2);
    if (v >= 0.0001) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(3);
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

  /* ──────────────────────────────────────────────────────────────────
     ROW HTML
     Includes rank number, nav indicator, improved layout.
  ────────────────────────────────────────────────────────────────── */
  function buildRowHtml(entry) {
    var chgValid  = entry.change24h !== null && !isNaN(entry.change24h);
    var dir       = chgValid ? (entry.change24h > 0 ? 'up' : entry.change24h < 0 ? 'dn' : '') : '';
    var arrow     = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
    var sym0      = escHtml((entry.symbol || '?')[0]);
    /* Determine if this token is navigable.
       Check KNOWN_ADDRESSES and native at build time for fast path.
       Token list cache check happens at tap time. */
    var nativeCid = CHAIN_NATIVE_CGID[_exploreChain];
    var known     = window.KNOWN_ADDRESSES || {};
    var fastAddr  = entry.id === nativeCid ? 'NATIVE'
                  : (known[entry.id] && known[entry.id][_exploreChain]) ? known[entry.id][_exploreChain]
                  : _tokenListCache[_exploreChain]
                      ? (function(){
                          var sym = entry.symbol;
                          var t = (_tokenListCache[_exploreChain]).find(function(x){return x.symbol===sym;});
                          return t ? t.address : null;
                        }())
                      : 'maybe'; /* token list still loading — optimistic */
    var noNav     = fastAddr === null;
    var rankStr   = entry.rank ? String(entry.rank) : '—';

    return [
      '<div class="asset-row explore-row' + (noNav ? ' ' + NO_ADDRESS_CLASS : '') + '"',
        ' data-cgid="' + escHtml(entry.id) + '"',
        noNav ? ' aria-disabled="true"' : ' role="button" tabindex="0"',
        ' aria-label="' + escHtml(entry.name) + (noNav ? ' (not available on this chain)' : '') + '">',

        /* Rank */
        '<div class="explore-row-rank" aria-hidden="true">' + escHtml(rankStr) + '</div>',

        /* Logo */
        '<div class="asset-row-logo-wrap">',
          entry.image
            ? '<img class="asset-row-logo" src="' + escHtml(entry.image) + '"'
                + ' alt="" loading="lazy"'
                + ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
            : '',
          '<div class="asset-row-logo-fallback"' + (entry.image ? ' style="display:none"' : '') + '>'
            + sym0 + '</div>',
        '</div>',

        /* Identity */
        '<div class="asset-row-identity">',
          '<span class="asset-row-name">' + escHtml(entry.name) + '</span>',
          '<span class="asset-row-chain">' + escHtml(entry.symbol) + '</span>',
        '</div>',

        /* Price + change */
        '<div class="asset-row-price">',
          '<span class="asset-row-usd">' + fmtPrice(entry.price) + '</span>',
          '<span class="asset-row-change ' + dir + '">',
            (arrow ? '<span class="explore-arrow" aria-hidden="true">' + arrow + '</span>' : ''),
            chgValid ? fmtChange(entry.change24h) : '—',
          '</span>',
        '</div>',

      '</div>',
    ].join('');
  }

  /* ──────────────────────────────────────────────────────────────────
     SKELETON
  ────────────────────────────────────────────────────────────────── */
  function renderSkeleton(listEl) {
    var ws = [80, 100, 65, 95, 72, 115, 70, 88, 62, 98];
    listEl.innerHTML = ws.map(function (w) {
      return [
        '<div class="asset-row" style="pointer-events:none" aria-hidden="true">',
          '<div class="explore-row-rank skeleton" style="width:18px;height:11px;border-radius:3px"></div>',
          '<div class="asset-row-logo-wrap">',
            '<div class="skeleton" style="width:36px;height:36px;border-radius:50%"></div>',
          '</div>',
          '<div class="asset-row-identity">',
            '<div class="skeleton" style="width:' + w + 'px;height:10px;margin-bottom:6px;border-radius:3px"></div>',
            '<div class="skeleton" style="width:36px;height:9px;border-radius:3px"></div>',
          '</div>',
          '<div class="asset-row-price">',
            '<div class="skeleton" style="width:60px;height:10px;margin-bottom:6px;border-radius:3px;margin-left:auto"></div>',
            '<div class="skeleton" style="width:46px;height:9px;border-radius:3px;margin-left:auto"></div>',
          '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  /* ──────────────────────────────────────────────────────────────────
     EMPTY STATE
  ────────────────────────────────────────────────────────────────── */
  function buildEmptyHtml() {
    var msgs = {
      gainers:  'No gainers right now on this chain.',
      losers:   'No losers right now on this chain.',
      stables:  'No stablecoins found in this list.',
      trending: 'No trending data available.',
    };
    var msg = _search
      ? 'No results for "' + escHtml(_search) + '".'
      : (msgs[_category] || 'No tokens to display.');
    return '<div class="explore-empty">' + msg + '</div>';
  }

  /* ──────────────────────────────────────────────────────────────────
     TAP HANDLER — wired on each update() render
  ────────────────────────────────────────────────────────────────── */
  function wireTaps(listEl) {
    listEl.querySelectorAll('.explore-row:not(.' + NO_ADDRESS_CLASS + ')').forEach(function (row) {
      row.addEventListener('click', function () {
        var cgid  = row.dataset.cgid;
        var chain = _exploreChain;
        var data  = _marketCache[chain] || [];
        var entry = data.find(function (t) { return t.id === cgid; });
        if (!entry) return;

        /* Resolve address LIVE — always reads from live caches, not the
           stale value stored inside the token object. */
        var addr = resolveAddressLive(entry, chain);

        if (!addr) {
          /* Token list might still be loading — wait for it */
          fetchTokenList(chain).then(function () {
            var retryAddr = resolveAddressLive(entry, chain);
            if (retryAddr) {
              setState({ token: retryAddr, tokenChainId: chain });
            }
            /* If still null after token list loads: token is not on
               Uniswap V3 for this chain — silently ignore */
          });
          return;
        }

        setState({ token: addr, tokenChainId: chain });
      });

      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     UPDATE — renders current state from market cache
  ────────────────────────────────────────────────────────────────── */
  function update() {
    if (!_container) return;

    var listEl  = _container.querySelector('#explore-list');
    var countEl = _container.querySelector('#explore-count');
    if (!listEl) return;

    var data = _marketCache[_exploreChain];
    if (!data) return; /* skeleton shown by ensureAndRender */

    var filtered = applyFilters(data);

    if (countEl) {
      countEl.textContent = filtered.length ? filtered.length : '';
    }

    if (!filtered.length) {
      listEl.innerHTML = buildEmptyHtml();
      return;
    }

    listEl.innerHTML = filtered.map(buildRowHtml).join('');
    wireTaps(listEl);

    /* Update sort arrow states */
    _container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      var c = col.dataset.col;
      col.classList.toggle('sorted-asc',  _sortCol === c && _sortDir === 'asc');
      col.classList.toggle('sorted-desc', _sortCol === c && _sortDir === 'desc');
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     CHAIN PILLS HTML
  ────────────────────────────────────────────────────────────────── */
  function buildPillsHtml() {
    var nets = getActiveNetworks();
    return nets.map(function (cid) {
      var color  = CHAIN_COLORS[cid] || '#888';
      var active = Number(cid) === _exploreChain;
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

  /* ──────────────────────────────────────────────────────────────────
     SORT ARROW SVG
  ────────────────────────────────────────────────────────────────── */
  function sortArrow() {
    return [
      '<span class="explore-sort-arrow" aria-hidden="true">',
        '<svg width="7" height="10" viewBox="0 0 7 10" fill="none">',
          '<path class="sort-up-path" d="M3.5 1v8M1 3.5L3.5 1 6 3.5"',
            ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
          '<path class="sort-dn-path" d="M1 6.5L3.5 9 6 6.5"',
            ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
      '</span>',
    ].join('');
  }

  /* ──────────────────────────────────────────────────────────────────
     FULL MOUNT
  ────────────────────────────────────────────────────────────────── */
  function mountExplore(container) {
    if (!container) return;
    if (!_exploreChain) _exploreChain = getWalletChain();

    container.innerHTML = [
      '<div class="explore-view">',

        /* Search */
        '<div class="explore-search-row">',
          '<div class="explore-search-wrap">',
            '<svg class="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"',
              ' stroke="var(--dim)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
              ' aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-4-4"/></svg>',
            '<input class="explore-search-input" id="explore-search" type="text"',
              ' placeholder="Search tokens…" value="' + escHtml(_search) + '"',
              ' autocomplete="off" autocorrect="off" spellcheck="false" inputmode="search"',
              ' aria-label="Search tokens">',
            '<button class="explore-search-clear" id="explore-search-clear"',
              ' aria-label="Clear search"' + (_search ? '' : ' hidden') + '>',
              '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">',
                '<path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
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
          (function () {
            var CATS = [
              { id: 'all',      label: 'All'         },
              { id: 'trending', label: 'Trending'    },
              { id: 'gainers',  label: 'Gainers'     },
              { id: 'losers',   label: 'Losers'      },
              { id: 'stables',  label: 'Stablecoins' },
            ];
            return CATS.map(function (c) {
              return '<button class="explore-cat' + (_category === c.id ? ' active' : '') + '"'
                + ' data-cat="' + c.id + '"'
                + ' role="tab"'
                + ' aria-selected="' + (_category === c.id) + '">'
                + c.label + '</button>';
            }).join('');
          }()),
        '</div>',

        /* Column headers */
        '<div class="explore-col-header" aria-hidden="true">',
          '<span class="explore-col-rank"></span>',
          '<span class="explore-col-token">',
            'TOKEN <span class="explore-count-badge" id="explore-count"></span>',
          '</span>',
          '<button class="explore-col-sortable explore-col-price" data-col="price"',
            ' aria-label="Sort by price" tabindex="0">PRICE' + sortArrow() + '</button>',
          '<button class="explore-col-sortable explore-col-change" data-col="change"',
            ' aria-label="Sort by 24h change" tabindex="0">24H' + sortArrow() + '</button>',
        '</div>',

        /* List */
        '<div class="explore-list" id="explore-list" role="list"></div>',

      '</div>',
    ].join('');

    _container = container;
    _mounted   = true;

    var searchEl = container.querySelector('#explore-search');
    var clearEl  = container.querySelector('#explore-search-clear');

    /* ── Search ── */
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

    /* ── Category tabs ── */
    container.querySelectorAll('.explore-cat').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (_category === btn.dataset.cat) return;
        _category = btn.dataset.cat;
        _sortCol  = null;
        _sortDir  = 'desc';   /* BUG FIX: always reset direction on category change */

        container.querySelectorAll('.explore-cat').forEach(function (b) {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        update();
      });
    });

    /* ── Chain pills ── */
    container.querySelectorAll('.explore-chain-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cid = Number(pill.dataset.chain);
        if (cid === _exploreChain) return;

        _exploreChain = cid;

        /* BUG FIX: clear search when switching chains */
        _search = ''; searchEl.value = ''; clearEl.hidden = true;
        clearTimeout(_debounce);

        container.querySelectorAll('.explore-chain-pill').forEach(function (p) {
          var active = Number(p.dataset.chain) === cid;
          p.classList.toggle('active', active);
          p.setAttribute('aria-pressed', String(active));
        });

        ensureAndRender(cid);
      });
    });

    /* ── Sort columns ── */
    container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      function doSort() {
        var c    = col.dataset.col;
        _sortDir = (_sortCol === c && _sortDir === 'desc') ? 'asc' : 'desc';
        _sortCol = c;
        /* Reset category to 'all' so sort applies to full unfiltered list */
        _category = 'all';
        container.querySelectorAll('.explore-cat').forEach(function (b) {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        var allBtn = container.querySelector('[data-cat="all"]');
        if (allBtn) { allBtn.classList.add('active'); allBtn.setAttribute('aria-selected', 'true'); }
        update();
      }
      col.addEventListener('click', doSort);
      col.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); }
      });
    });

    /* Initial data load */
    ensureAndRender(_exploreChain);

    /* Prefetch common secondary chains in the background */
    _prefetchAdjacentChains();
  }

  /* ──────────────────────────────────────────────────────────────────
     PREFETCH — load token lists for the most commonly used chains
     in the background after the primary chain renders.
  ────────────────────────────────────────────────────────────────── */
  function _prefetchAdjacentChains() {
    var walletChain = getWalletChain();
    /* Prefetch token lists for chains the user is likely to visit */
    var prefetchOrder = [1, 42161, 8453, 137, 56, 10, 43114, 130];
    var queue = prefetchOrder.filter(function (cid) {
      return cid !== walletChain && !isFreshTokenList(cid);
    });

    /* Stagger by 2s each to avoid bursting The Graph */
    queue.forEach(function (cid, i) {
      setTimeout(function () {
        if (!isFreshTokenList(cid)) fetchTokenList(cid);
      }, (i + 1) * 2000);
    });
  }

  /* ──────────────────────────────────────────────────────────────────
     STATE LISTENERS
  ────────────────────────────────────────────────────────────────── */

  document.addEventListener('state:mobileTab', function (e) {
    if (e.detail !== 'explore') return;

    var container = document.getElementById('mobile-explore');
    if (!container) return;

    if (!_mounted || !_container || !document.body.contains(_container)) {
      mountExplore(container);
    } else {
      /* Refresh if stale, otherwise instant from cache */
      ensureAndRender(_exploreChain);
    }
  });

  /* NOTE: state:marketData listener removed —
     explore.js no longer depends on STATE.marketData. */

}());
