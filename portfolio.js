(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────
     PHASE 9A — portfolio.js
     Balance aggregation across active chains. Asset list rendering.
     Four states: skeleton → loaded / empty / error.
     No mock data. Real API calls. Failure is visible.
  ───────────────────────────────────────────────────────────────────── */

  /* ─────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────── */

  var CHAIN_RPC = {
    1:      'https://eth.llamarpc.com',
    10:     'https://mainnet.optimism.io',
    56:     'https://bsc-dataseed.binance.org',
    130:    'https://mainnet.unichain.org',
    137:    'https://polygon-rpc.com',
    8453:   'https://mainnet.base.org',
    42161:  'https://arb1.arbitrum.io/rpc',
    43114:  'https://api.avax.network/ext/bc/C/rpc',
  };

  var CHAIN_NAMES = {
    1:      'Ethereum',
    10:     'Optimism',
    56:     'BNB Chain',
    130:    'Unichain',
    137:    'Polygon',
    8453:   'Base',
    42161:  'Arbitrum One',
    43114:  'Avalanche',
  };

  /* Trust Wallet CDN folder names. Unichain (130) has no coverage. */
  var CHAIN_FOLDERS = {
    1:      'ethereum',
    10:     'optimism',
    56:     'smartchain',
    137:    'polygon',
    8453:   'base',
    42161:  'arbitrum',
    43114:  'avalanche',
  };

  /* Chain-specific native token metadata.
   * Used in fetchAllBalances so BNB chain shows 'BNB / BNB Chain'
   * not 'Ethereum / BNB Chain' (which was the bug: STATE.tokenList
   * is loaded for the ACTIVE chain only, carrying the wrong NATIVE
   * token metadata for every other chain in the loop). */
  var CHAIN_NATIVE_TOKENS = {
    1:      { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    10:     { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    56:     { address: 'NATIVE', symbol: 'BNB',  name: 'BNB',       decimals: 18 },
    130:    { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    137:    { address: 'NATIVE', symbol: 'POL',  name: 'Polygon',   decimals: 18 },
    8453:   { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    42161:  { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    43114:  { address: 'NATIVE', symbol: 'AVAX', name: 'Avalanche', decimals: 18 },
  };

  var ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

  var FETCH_TIMEOUT_MS = 8000;   /* per individual call */
  var POLL_INTERVAL_MS = 60000;  /* portfolio refresh rate */

  /* ─────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────── */

  var _pollTimer  = null;
  var _mounted    = false;
  var _providers  = {}; /* { chainId: ethers.providers.JsonRpcProvider } */

  /* ─────────────────────────────────────────
     UTILITIES
  ───────────────────────────────────────── */

  function getWalletAddress() {
    var wallets = window.STATE && STATE.wallets;
    if (wallets && wallets.length > 0) {
      var active = wallets[STATE.activeWallet];
      if (active && active.address) return active.address;
    }
    return window.STATE && STATE.wallet;
  }

  function getProvider(chainId) {
    if (!_providers[chainId]) {
      var rpc = CHAIN_RPC[chainId];
      if (!rpc) throw new Error('No public RPC configured for chain ' + chainId);
      _providers[chainId] = new ethers.providers.JsonRpcProvider(rpc);
    }
    return _providers[chainId];
  }

  function chainLogoUrl(chainId) {
    var folder = CHAIN_FOLDERS[chainId];
    if (!folder) return '';
    return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
      + folder + '/info/logo.png';
  }

  /* Maps each chain's native token to its CANONICAL logo folder.
   * ETH is always the Ethereum logo regardless of which L2 it's on.
   * The chain badge (small corner overlay) shows the network.
   * The main token logo shows the asset. These are different things. */
  var NATIVE_LOGO_FOLDER = {
    1:      'ethereum',    /* ETH  → Ethereum logo  */
    10:     'ethereum',    /* ETH on Optimism        */
    130:    'ethereum',    /* ETH on Unichain        */
    8453:   'ethereum',    /* ETH on Base            */
    42161:  'ethereum',    /* ETH on Arbitrum        */
    56:     'smartchain',  /* BNB  → BSC logo        */
    137:    'polygon',     /* POL  → Polygon logo    */
    43114:  'avalanche',   /* AVAX → Avalanche logo  */
  };

  function nativeLogoUrl(chainId) {
    var folder = NATIVE_LOGO_FOLDER[chainId] || CHAIN_FOLDERS[chainId];
    if (!folder) return '';
    return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
      + folder + '/info/logo.png';
  }

  function tokenLogoUrl(address, chainId) {
    if (!address || address === 'NATIVE') return nativeLogoUrl(chainId);
    var folder = CHAIN_FOLDERS[chainId];
    if (!folder) return nativeLogoUrl(chainId);
    try {
      var checksumAddr = ethers.utils.getAddress(address);
      return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
        + folder + '/assets/' + checksumAddr + '/logo.png';
    } catch (_) {
      return nativeLogoUrl(chainId);
    }
  }

  function formatUSD(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    if (value === 0) return '$0.00';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (value >= 1)   return '$' + value.toFixed(2);
    if (value >= 0.001) return '$' + value.toFixed(4);
    return '$' + value.toPrecision(4);
  }

  function formatBalance(balance, symbol) {
    var num = parseFloat(balance);
    if (isNaN(num)) return '— ' + symbol;
    if (num === 0)  return '0 ' + symbol;
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M ' + symbol;
    if (num >= 1e3) return num.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' ' + symbol;
    if (num >= 1)   return num.toFixed(4) + ' ' + symbol;
    if (num >= 0.0001) return num.toFixed(6) + ' ' + symbol;
    return num.toPrecision(4) + ' ' + symbol;
  }

  function formatChange(change) {
    if (change === null || change === undefined || isNaN(change)) return '—';
    var sign = change >= 0 ? '+' : '';
    return sign + change.toFixed(2) + '%';
  }

  function withTimeout(promise, ms) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('Request timed out after ' + ms + 'ms'));
      }, ms);
    });
    return Promise.race([promise, timeout]).then(
      function (result) { clearTimeout(timer); return result; },
      function (err)    { clearTimeout(timer); throw err; }
    );
  }

  /* ─────────────────────────────────────────
     JSON-RPC HELPER
     Used for eth_getBalance on non-active chains.
  ───────────────────────────────────────── */

  function jsonRpc(url, method, params) {
    return withTimeout(
      fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (json) {
        if (json.error) throw new Error(json.error.message || 'RPC error');
        return json.result;
      }),
      FETCH_TIMEOUT_MS
    );
  }

  /* ─────────────────────────────────────────
     BALANCE FETCHERS
  ───────────────────────────────────────── */

  function fetchNativeBalance(walletAddress, chainId) {
    var activeChain = window.STATE && STATE.network;
    var usePrivy = window.privyProvider && activeChain && Number(activeChain) === Number(chainId);

    var request = usePrivy
      ? Promise.resolve(
          window.privyProvider.request({
            method: 'eth_getBalance',
            params: [walletAddress, 'latest'],
          })
        )
      : (CHAIN_RPC[chainId]
          ? jsonRpc(CHAIN_RPC[chainId], 'eth_getBalance', [walletAddress, 'latest'])
          : Promise.reject(new Error('No RPC for chain ' + chainId)));

    return withTimeout(request, FETCH_TIMEOUT_MS).then(function (hex) {
      var raw = ethers.BigNumber.from(hex);
      return { balance: ethers.utils.formatEther(raw), raw: raw };
    });
  }

  function fetchTokenBalance(walletAddress, tokenAddress, decimals, chainId) {
    return withTimeout(
      (function () {
        var provider = getProvider(chainId);
        var contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);
        return contract.balanceOf(walletAddress).then(function (raw) {
          return {
            balance: ethers.utils.formatUnits(raw, decimals || 18),
            raw:     raw,
          };
        });
      }()),
      FETCH_TIMEOUT_MS
    );
  }

  /* ─────────────────────────────────────────
     FETCH ALL BALANCES
     Per active chain: native + all tokenList tokens.
     Filters balance > 0, looks up USD from STATE.prices.
     Calls savePortfolioCache after each successful chain.
     Returns { chainId: { address: {...} } | { _error: true } }
  ───────────────────────────────────────── */

  function fetchAllBalances(walletAddress) {
    var activeNetworks = (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [];
    var activeChainId  = (window.STATE && STATE.network) || 1;

    /* ERC-20 tokens from the active chain's tokenList only.
     * STATE.tokenList is loaded for the active chain — using it for OTHER chains
     * would check Ethereum ERC-20 addresses against BNB Chain balances (always 0)
     * while writing wrong token metadata for the native token. */
    var erc20Tokens = ((window.STATE && STATE.tokenList) || [])
      .filter(function (t) { return t.address !== 'NATIVE'; });

    var allResults = {};

    var chainPromises = activeNetworks.map(function (chainId) {
      var chainBalances = {};
      var prices        = window.STATE && STATE.prices;
      var nativeDef     = CHAIN_NATIVE_TOKENS[chainId];

      /* ── Native balance — every active chain ── */
      var nativeFetch = nativeDef
        ? fetchNativeBalance(walletAddress, chainId).then(function (result) {
            var num = parseFloat(result.balance);
            if (isNaN(num) || num <= 0) return;

            /* Use NATIVE_<chainId> price key written by prices.js updateAllPrices().
             * Fall back to 'NATIVE' for backwards compat with any cached data. */
            var priceKey   = 'NATIVE_' + chainId;
            var priceEntry = prices && (prices[priceKey] || prices['NATIVE']);
            var usd        = priceEntry ? num * priceEntry.usd : 0;

            chainBalances['NATIVE'] = {
              balance:  result.balance,
              usd:      usd,
              symbol:   nativeDef.symbol,   /* BNB on BNB Chain, ETH on Arbitrum, etc. */
              name:     nativeDef.name,
              decimals: nativeDef.decimals,
              chainId:  chainId,
            };
          }).catch(function (e) {
            console.warn('[portfolio] native skip chain', chainId + ':', e.message);
          })
        : Promise.resolve();

      /* ── ERC-20 balances — active chain only ── */
      var erc20Promises = (chainId === activeChainId)
        ? erc20Tokens.map(function (token) {
            return fetchTokenBalance(walletAddress, token.address, token.decimals, chainId)
              .then(function (result) {
                var num = parseFloat(result.balance);
                if (isNaN(num) || num <= 0) return;

                var priceEntry = prices && prices[token.address];
                var usd        = priceEntry ? num * priceEntry.usd : 0;

                chainBalances[token.address] = {
                  balance:  result.balance,
                  usd:      usd,
                  symbol:   token.symbol,
                  name:     token.name,
                  decimals: token.decimals || 18,
                  chainId:  chainId,
                };
              }).catch(function (e) {
                console.warn('[portfolio] skip', token.symbol, 'chain', chainId + ':', e.message);
              });
          })
        : [];

      return Promise.all([nativeFetch].concat(erc20Promises)).then(function () {
        savePortfolioCache(chainId, chainBalances);
        allResults[chainId] = chainBalances;
      }).catch(function (e) {
        console.error('[portfolio] chain', chainId, 'failed:', e.message);
        allResults[chainId] = { _error: true };
      });
    });

    return Promise.all(chainPromises).then(function () {
      return allResults;
    });
  }

  /* ─────────────────────────────────────────
     DETECT HELD TOKENS
     Flattens balances, enriches with metadata, sorts by USD desc.
  ───────────────────────────────────────── */

  function detectHeldTokens(balances) {
    var held = [];

    Object.keys(balances).forEach(function (chainId) {
      var chainData = balances[chainId];
      if (!chainData || chainData._error) return;

      Object.keys(chainData).forEach(function (address) {
        var entry = chainData[address];
        if (!entry || parseFloat(entry.balance) <= 0) return;

        held.push({
          address:  address,
          chainId:  Number(chainId),
          balance:  entry.balance,
          usd:      entry.usd || 0,
          symbol:   entry.symbol || '???',
          name:     entry.name  || entry.symbol || address.slice(0, 6),
          decimals: entry.decimals || 18,
        });
      });
    });

    return held.sort(function (a, b) { return b.usd - a.usd; });
  }

  /* ─────────────────────────────────────────
     PORTFOLIO TOTAL
  ───────────────────────────────────────── */

  function calcPortfolioTotal(heldTokens) {
    var total = heldTokens.reduce(function (sum, t) { return sum + (t.usd || 0); }, 0);
    setState({ portfolioTotal: total });
    return total;
  }

  /* ─────────────────────────────────────────
     ACTION BUTTONS HTML
     Swap / Send / Receive — exact spec structure.
  ───────────────────────────────────────── */

  var ACTION_BUTTONS_HTML = [
    '<div class="portfolio-actions">',
      '<button class="action-btn" data-action="swap" aria-label="Swap">',
        '<div class="action-btn-icon">',
          '<svg viewBox="0 0 20 20" width="20" height="20" fill="none"',
            ' stroke="currentColor" stroke-width="1.5"',
            ' stroke-linecap="round" stroke-linejoin="round">',
            '<path d="M5 15V5m0 0L2 8m3-3 3 3"/>',
            '<path d="M15 5v10m0 0 3-3m-3 3-3-3"/>',
          '</svg>',
        '</div>',
        '<span class="action-btn-label">Swap</span>',
      '</button>',
      '<button class="action-btn" data-action="send" aria-label="Send">',
        '<div class="action-btn-icon">',
          '<svg viewBox="0 0 20 20" width="20" height="20" fill="none"',
            ' stroke="currentColor" stroke-width="1.5"',
            ' stroke-linecap="round" stroke-linejoin="round">',
            '<path d="M4 16 16 4m0 0H8m8 0v8"/>',
          '</svg>',
        '</div>',
        '<span class="action-btn-label">Send</span>',
      '</button>',
      '<button class="action-btn" data-action="receive" aria-label="Receive">',
        '<div class="action-btn-icon">',
          '<svg viewBox="0 0 20 20" width="20" height="20" fill="none"',
            ' stroke="currentColor" stroke-width="1.5"',
            ' stroke-linecap="round" stroke-linejoin="round">',
            '<path d="M16 4 4 16m0 0h8m-8 0V8"/>',
          '</svg>',
        '</div>',
        '<span class="action-btn-label">Receive</span>',
      '</button>',
    '</div>',
  ].join('');

  /* ─────────────────────────────────────────
     LOGO HTML BUILDER
     Returns the img + fallback div combo.
     Fallback shows on image load error.
  ───────────────────────────────────────── */

  function buildLogoHtml(logoUrl, sym) {
    var s = (sym || '?').slice(0, 4);
    if (!logoUrl) {
      return '<div class="asset-row-logo-fallback">' + s + '</div>';
    }
    return [
      '<img class="asset-row-logo" src="' + logoUrl + '" alt="' + s + '"',
        ' onerror="this.style.display=\'none\';',
          'this.nextElementSibling.style.display=\'flex\'">',
      '<div class="asset-row-logo-fallback" style="display:none">' + s + '</div>',
    ].join('');
  }

  /* ─────────────────────────────────────────
     SKELETON ROWS
     Rendered while balance fetch is in flight.
  ───────────────────────────────────────── */

  function renderSkeletonRows(container, count) {
    var html = '';
    for (var i = 0; i < count; i++) {
      html += [
        '<div class="asset-row">',
          '<div class="asset-row-logo-wrap">',
            '<div class="skeleton" style="width:36px;height:36px;border-radius:50%;flex-shrink:0"></div>',
          '</div>',
          '<div class="asset-row-identity">',
            '<div class="skeleton skel-line skel-w-80"></div>',
            '<div class="skeleton skel-line" style="width:44%"></div>',
          '</div>',
          '<div class="asset-row-price">',
            '<div class="skeleton skel-line" style="width:52px"></div>',
            '<div class="skeleton skel-line" style="width:36px;margin-top:3px"></div>',
          '</div>',
        '</div>',
      ].join('');
    }
    container.innerHTML = html;
  }

  /* ─────────────────────────────────────────
     BUILD HELD ROW
     Token the wallet holds — shows balance in token + USD.
  ───────────────────────────────────────── */

  function buildHeldRow(token) {
    var logo    = tokenLogoUrl(token.address, token.chainId);
    var badge   = chainLogoUrl(token.chainId);
    var chain   = CHAIN_NAMES[token.chainId] || ('Chain ' + token.chainId);
    var usdStr  = formatUSD(token.usd);
    var balStr  = formatBalance(token.balance, token.symbol);
    var badgeEl = badge
      ? '<img class="asset-row-chain-badge" src="' + badge + '" alt="' + chain + '">'
      : '';

    var div = document.createElement('div');
    div.className         = 'asset-row held';
    div.dataset.address   = token.address;
    div.dataset.chainId   = String(token.chainId);
    div.dataset.usd       = String(token.usd);

    div.innerHTML = [
      '<div class="asset-row-logo-wrap">',
        buildLogoHtml(logo, token.symbol),
        badgeEl,
      '</div>',
      '<div class="asset-row-identity">',
        '<span class="asset-row-name">' + escHtml(token.name) + '</span>',
        '<span class="asset-row-chain">' + chain + '</span>',
      '</div>',
      '<div class="asset-row-balance">',
        '<span class="asset-row-balance-usd">' + usdStr + '</span>',
        '<span class="asset-row-balance-amount">' + escHtml(balStr) + '</span>',
      '</div>',
    ].join('');

    div.addEventListener('click', function () {
      /* Pass both address AND chainId — the detail panel needs both to show
       * the right token. Without chainId, ETH on Arbitrum and ETH on Ethereum
       * are indistinguishable (both have address 'NATIVE'). */
      setState({ token: token.address, tokenChainId: token.chainId });
    });

    return div;
  }

  /* ─────────────────────────────────────────
     BUILD MARKET ROW
     All other tokens from STATE.tokenList — shows live price + 24h change.
  ───────────────────────────────────────── */

  function buildMarketRow(token) {
    var chainId    = (window.STATE && STATE.network) || 1;
    var logo       = tokenLogoUrl(token.address, chainId);
    var badge      = chainLogoUrl(chainId);
    var chain      = CHAIN_NAMES[chainId] || ('Chain ' + chainId);
    var prices     = window.STATE && STATE.prices;
    var priceEntry = prices && prices[token.address];
    var usdStr     = priceEntry ? formatUSD(priceEntry.usd)     : '—';
    var change     = priceEntry ? priceEntry.change24h          : null;
    var changeStr  = formatChange(change);
    var changeCls  = change > 0 ? ' up' : (change < 0 ? ' dn' : '');
    var badgeEl    = badge
      ? '<img class="asset-row-chain-badge" src="' + badge + '" alt="' + chain + '">'
      : '';

    var div = document.createElement('div');
    div.className       = 'asset-row';
    div.dataset.address = token.address;

    div.innerHTML = [
      '<div class="asset-row-logo-wrap">',
        buildLogoHtml(logo, token.symbol),
        badgeEl,
      '</div>',
      '<div class="asset-row-identity">',
        '<span class="asset-row-name">' + escHtml(token.name) + '</span>',
        '<span class="asset-row-chain">' + chain + '</span>',
      '</div>',
      '<div class="asset-row-price">',
        '<span class="asset-row-usd">' + usdStr + '</span>',
        '<span class="asset-row-change' + changeCls + '">' + changeStr + '</span>',
      '</div>',
    ].join('');

    div.addEventListener('click', function () {
      setState({ token: token.address, tokenChainId: chainId });
    });

    return div;
  }

  /* ─────────────────────────────────────────
     RENDER ASSET LIST
     Held tokens pinned top, then MARKET divider, then full token list.
  ───────────────────────────────────────── */

  function renderAssetList(container, heldTokens) {
    var tokenList      = (window.STATE && STATE.tokenList) || [];
    var heldAddressSet = {};
    heldTokens.forEach(function (t) {
      heldAddressSet[t.address.toLowerCase()] = true;
    });

    container.innerHTML = '';

    /* Held section */
    heldTokens.forEach(function (token) {
      container.appendChild(buildHeldRow(token));
    });

    /* Market divider + rows */
    var divider = document.createElement('div');
    divider.className   = 'portfolio-section-label';
    divider.textContent = 'MARKET';
    container.appendChild(divider);

    var marketTokens = tokenList.filter(function (t) {
      return !heldAddressSet[t.address.toLowerCase()];
    });

    if (marketTokens.length === 0) {
      var notice = document.createElement('div');
      notice.className   = 'portfolio-empty';
      notice.textContent = tokenList.length === 0
        ? 'Market data loading…'
        : 'All discovered tokens are in your wallet.';
      container.appendChild(notice);
    } else {
      marketTokens.forEach(function (token) {
        container.appendChild(buildMarketRow(token));
      });
    }
  }

  /* ─────────────────────────────────────────
     RETRY BUTTON HTML
  ───────────────────────────────────────── */

  function retryBtnHtml(label) {
    return [
      '<button class="btn btn-white portfolio-retry-btn">',
        '<div class="btn-pulse-ring"></div>',
        '<div class="btn-inner">',
          '<div class="glass-sheen"></div>',
          '<span>' + label + '</span>',
        '</div>',
      '</button>',
    ].join('');
  }

  /* ─────────────────────────────────────────
     SCAFFOLD HTML
     Returns the shell for both containers.
     Asset list containers are empty — filled by renderAssetList.
  ───────────────────────────────────────── */

  function mobileSkeleton(totalStr) {
    return [
      '<div class="portfolio-balance-section">',
        '<span class="portfolio-total-label">TOTAL BALANCE</span>',
        '<span class="portfolio-total-usd" id="portfolio-total-usd">' + totalStr + '</span>',
        '<span class="portfolio-total-change" id="portfolio-total-change"></span>',
        ACTION_BUTTONS_HTML,
      '</div>',
      '<div class="portfolio-assets-section">',
        '<div class="portfolio-section-label">ASSETS</div>',
        '<div id="portfolio-asset-list" class="portfolio-asset-list"></div>',
      '</div>',
    ].join('');
  }

  function desktopSkeleton(totalStr) {
    return [
      '<div class="portfolio-balance-section desktop">',
        '<span class="portfolio-total-label">PORTFOLIO</span>',
        '<span class="portfolio-total-usd" id="portfolio-total-usd-desktop">' + totalStr + '</span>',
        '<span class="portfolio-total-change" id="portfolio-total-change-desktop"></span>',
        ACTION_BUTTONS_HTML,
      '</div>',
      '<div class="portfolio-section-label">ASSETS</div>',
      '<div id="desktop-asset-list" class="portfolio-asset-list"></div>',
    ].join('');
  }

  /* ─────────────────────────────────────────
     SHOW SKELETON
     Called immediately on mountPortfolio — before fetch.
  ───────────────────────────────────────── */

  function showSkeleton(mobileContainer, desktopContainer) {
    var connected = !!getWalletAddress();

    mobileContainer.innerHTML  = mobileSkeleton('—');
    desktopContainer.innerHTML = desktopSkeleton('—');

    var mobileList  = document.getElementById('portfolio-asset-list');
    var desktopList = document.getElementById('desktop-asset-list');

    if (connected) {
      renderSkeletonRows(mobileList,  4);
      renderSkeletonRows(desktopList, 4);
    } else {
      var emptyHtml = '<div class="portfolio-empty">Connect a wallet to see your portfolio.</div>';
      mobileList.innerHTML  = emptyHtml;
      desktopList.innerHTML = emptyHtml;
    }
  }

  /* ─────────────────────────────────────────
     RENDER PORTFOLIO
     Full render into both containers after fetch resolves.
     heldTokens: computed held assets.
     chainErrors: object of { chainId: true } for failed chains.
  ───────────────────────────────────────── */

  function renderPortfolio(mobileContainer, desktopContainer, heldTokens, chainErrors) {
    var connected  = !!getWalletAddress();
    var total      = connected && heldTokens.length ? calcPortfolioTotal(heldTokens) : 0;
    var totalStr   = connected ? formatUSD(total) : '—';
    var hasErrors  = chainErrors && Object.keys(chainErrors).length > 0;
    var allFailed  = hasErrors && heldTokens.length === 0;

    mobileContainer.innerHTML  = mobileSkeleton(totalStr);
    desktopContainer.innerHTML = desktopSkeleton(totalStr);

    var mobileList  = document.getElementById('portfolio-asset-list');
    var desktopList = document.getElementById('desktop-asset-list');

    /* Not connected — empty state */
    if (!connected) {
      var emptyHtml = '<div class="portfolio-empty">Connect a wallet to see your portfolio.</div>';
      mobileList.innerHTML  = emptyHtml;
      desktopList.innerHTML = emptyHtml;
      return;
    }

    /* All chains failed and nothing to show — error state with retry */
    if (allFailed) {
      var errorHtml = [
        '<div class="portfolio-error">',
          '<span>Could not load balances.</span>',
          retryBtnHtml('RETRY'),
        '</div>',
      ].join('');
      mobileList.innerHTML  = errorHtml;
      desktopList.innerHTML = errorHtml;

      mobileList.querySelector('.portfolio-retry-btn').addEventListener('click', mountPortfolio);
      desktopList.querySelector('.portfolio-retry-btn').addEventListener('click', mountPortfolio);
      return;
    }

    /* Partial chain errors — show a notice at the top, then render what we have */
    if (hasErrors) {
      var failedChains = Object.keys(chainErrors)
        .map(function (id) { return CHAIN_NAMES[id] || ('Chain ' + id); })
        .join(', ');
      var noticeHtml = [
        '<div class="portfolio-error" style="min-height:auto;padding:var(--sp-2) var(--sp-3)">',
          'Could not fetch: ' + escHtml(failedChains) + '.',
        '</div>',
      ].join('');
      var mobileNotice  = document.createElement('div');
      var desktopNotice = document.createElement('div');
      mobileNotice.innerHTML  = noticeHtml;
      desktopNotice.innerHTML = noticeHtml;
      mobileList.appendChild(mobileNotice.firstElementChild);
      desktopList.appendChild(desktopNotice.firstElementChild);
    }

    renderAssetList(mobileList,  heldTokens);
    renderAssetList(desktopList, heldTokens);
  }

  /* ─────────────────────────────────────────
     UPDATE PRICES IN ROWS
     Called on state:prices — no re-fetch.
     Updates .asset-row-balance-usd and .asset-row-usd text only.
  ───────────────────────────────────────── */

  function updatePricesInRows() {
    var prices   = window.STATE && STATE.prices;
    var balances = window.STATE && STATE.portfolioBalances;
    if (!prices || !_mounted) return;

    /* Held rows — recompute USD from stored balance + new price */
    document.querySelectorAll('.asset-row.held[data-address]').forEach(function (row) {
      var address    = row.dataset.address;
      var chainId    = Number(row.dataset.chainId);
      /* Native token price is stored per-chain as 'NATIVE_<chainId>' */
      var priceKey   = address === 'NATIVE' ? ('NATIVE_' + chainId) : address;
      var priceEntry = prices[priceKey];
      if (!priceEntry) return;

      var chainData = balances && balances[chainId];
      var entry     = chainData && chainData[address];
      if (!entry) return;

      var usd   = parseFloat(entry.balance) * priceEntry.usd;
      var usdEl = row.querySelector('.asset-row-balance-usd');
      if (usdEl) usdEl.textContent = formatUSD(usd);

      /* Keep data-usd in sync for total recompute below */
      row.dataset.usd = String(usd);
    });

    /* Market rows — update price + change */
    document.querySelectorAll('.asset-row:not(.held)[data-address]').forEach(function (row) {
      var address    = row.dataset.address;
      var priceEntry = prices[address];
      if (!priceEntry) return;

      var usdEl    = row.querySelector('.asset-row-usd');
      var changeEl = row.querySelector('.asset-row-change');

      if (usdEl) usdEl.textContent = formatUSD(priceEntry.usd);
      if (changeEl) {
        var c = priceEntry.change24h;
        changeEl.textContent = formatChange(c);
        changeEl.className   = 'asset-row-change' + (c > 0 ? ' up' : c < 0 ? ' dn' : '');
      }
    });

    /* Recompute portfolio total from fresh prices × stored balances */
    var total = 0;
    Object.keys(balances || {}).forEach(function (chainId) {
      var chainData = balances[chainId];
      if (!chainData || chainData._error) return;
      Object.keys(chainData).forEach(function (address) {
        var entry      = chainData[address];
        if (!entry || parseFloat(entry.balance) <= 0) return;
        var cid        = Number(chainId);
        var priceKey   = address === 'NATIVE' ? ('NATIVE_' + cid) : address;
        var priceEntry = prices[priceKey];
        var usd        = priceEntry
          ? parseFloat(entry.balance) * priceEntry.usd
          : (entry.usd || 0);
        total += usd;
      });
    });

    setState({ portfolioTotal: total });
    var totalStr = formatUSD(total);

    var mEl = document.getElementById('portfolio-total-usd');
    var dEl = document.getElementById('portfolio-total-usd-desktop');
    if (mEl) mEl.textContent = totalStr;
    if (dEl) dEl.textContent = totalStr;
  }

  /* ─────────────────────────────────────────
     MOUNT PORTFOLIO
     Entry point. Skeleton → fetch → render.
  ───────────────────────────────────────── */

  function mountPortfolio() {
    var mobileContainer  = document.getElementById('mobile-portfolio');
    var desktopContainer = document.getElementById('portfolio-main');
    if (!mobileContainer || !desktopContainer) return;

    var walletAddress = getWalletAddress();

    showSkeleton(mobileContainer, desktopContainer);

    if (!walletAddress) {
      renderPortfolio(mobileContainer, desktopContainer, [], {});
      return;
    }

    fetchAllBalances(walletAddress).then(function (allBalances) {
      /* Merge fresh results with stale cache for failed chains.
         If a chain errored, its last known holdings are preserved. */
      var staleCache  = (window.STATE && STATE.portfolioBalances) || {};
      var merged      = Object.assign({}, staleCache);
      var chainErrors = {};

      Object.keys(allBalances).forEach(function (chainId) {
        var result = allBalances[chainId];
        if (result && result._error) {
          chainErrors[chainId] = true;
          /* Keep stale data — do not overwrite merged[chainId] */
        } else {
          merged[chainId] = result;
        }
      });

      var heldTokens = detectHeldTokens(merged);
      renderPortfolio(mobileContainer, desktopContainer, heldTokens, chainErrors);
      _mounted = true;

    }).catch(function (e) {
      console.error('[portfolio] mount failed:', e.message);
      renderPortfolio(mobileContainer, desktopContainer, [], { all: true });
    });
  }

  /* ─────────────────────────────────────────
     POLLING
  ───────────────────────────────────────── */

  function startPortfolioPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    mountPortfolio();
    _pollTimer = setInterval(mountPortfolio, POLL_INTERVAL_MS);
  }

  /* ─────────────────────────────────────────
     UTILITY — HTML escape
  ───────────────────────────────────────── */

  function escHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  /* ─────────────────────────────────────────
     STATE LISTENERS
  ───────────────────────────────────────── */

  /* Wallet connected or changed → full refresh */
  document.addEventListener('state:wallet', function () {
    startPortfolioPolling();
  });

  /* New prices → update USD in-place, no re-fetch */
  document.addEventListener('state:prices', function () {
    updatePricesInRows();
  });

  /* Token list changed (new chain, new discoveries) → re-render list */
  document.addEventListener('state:tokenList', function () {
    if (!_mounted) return;
    var mobileList  = document.getElementById('portfolio-asset-list');
    var desktopList = document.getElementById('desktop-asset-list');
    if (!mobileList || !desktopList) return;

    var balances   = (window.STATE && STATE.portfolioBalances) || {};
    var heldTokens = detectHeldTokens(balances);
    renderAssetList(mobileList,  heldTokens);
    renderAssetList(desktopList, heldTokens);
  });

  /* Portfolio tab activated — ensure content is mounted */
  document.addEventListener('state:mobileTab', function (e) {
    if (e.detail !== 'portfolio') return;
    var list = document.getElementById('portfolio-asset-list');
    if (!list || !_mounted) mountPortfolio();
  });

  /* ─────────────────────────────────────────
     WINDOW EXPORTS
     mountPortfolio exposed for transfer.js retry flow.
  ───────────────────────────────────────── */

  window.mountPortfolio = mountPortfolio;

  /* ─────────────────────────────────────────
     INIT
  ───────────────────────────────────────── */

  startPortfolioPolling();

}());
