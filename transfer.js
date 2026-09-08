/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — transfer.js
   Phase 9D — Send flow: token picker · ENS/address resolution ·
               amount input · gas estimation · ERC-20 + native send.
   Phase 9E — Receive flow: per-network address · clipboard copy ·
               QR code via qrcode.js · one QR open at a time.
   No mock data. Real on-chain calls. Failure is always visible.
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────────── */

  /* Minimal ERC-20 ABI — transfer only */
  var ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
  ];

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

  /* Trust Wallet CDN folder names per chain — Unichain (130) has no coverage */
  var CHAIN_FOLDERS = {
    1:      'ethereum',
    10:     'optimism',
    56:     'smartchain',
    137:    'polygon',
    8453:   'base',
    42161:  'arbitrum',
    43114:  'avalanche',
  };

  /* Block explorer TX URLs per chain. Try window.EXPLORER_URLS first (from wallet.js) */
  var _LOCAL_EXPLORER_TX = {
    1:      'https://etherscan.io/tx/',
    10:     'https://optimistic.etherscan.io/tx/',
    56:     'https://bscscan.com/tx/',
    130:    'https://uniscan.xyz/tx/',
    137:    'https://polygonscan.com/tx/',
    8453:   'https://basescan.org/tx/',
    42161:  'https://arbiscan.io/tx/',
    43114:  'https://snowscan.xyz/tx/',
  };

  /* WETH (mainnet) — used as ETH price proxy for gas USD display */
  var WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

  /* ─────────────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────────── */

  var _resolveTimer = null;   /* debounce handle — resolveRecipient 400ms  */
  var _gasTimer     = null;   /* debounce handle — estimateSendGas  600ms  */
  var _activeChip   = 'all';  /* currently selected network chip key       */
  var _ensProvider  = null;   /* lazy JsonRpcProvider for ENS (mainnet)    */

  /* ─────────────────────────────────────────────────────────────────────
     UTILITIES
  ───────────────────────────────────────────────────────────────────── */

  function escHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function formatUSD(value) {
    if (value === null || value === undefined || isNaN(value)) return '\u2014';
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
    if (isNaN(num)) return '\u2014 ' + (symbol || '');
    if (num === 0)  return '0 ' + (symbol || '');
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M ' + (symbol || '');
    if (num >= 1e3) return num.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' ' + (symbol || '');
    if (num >= 1)   return num.toFixed(4) + ' ' + (symbol || '');
    if (num >= 0.0001) return num.toFixed(6) + ' ' + (symbol || '');
    return num.toPrecision(4) + ' ' + (symbol || '');
  }

  function truncAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '\u2026' + addr.slice(-4);
  }

  function isNativeToken(token) {
    return !!(token && token.address === 'NATIVE');
  }

  function chainLogoUrl(chainId) {
    var folder = CHAIN_FOLDERS[chainId];
    return folder
      ? 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
        + folder + '/info/logo.png'
      : '';
  }

  function tokenLogoUrl(address, chainId) {
    if (!address || address === 'NATIVE') return chainLogoUrl(chainId);
    var folder = CHAIN_FOLDERS[chainId];
    if (!folder) return '';
    try {
      var cs = ethers.utils.getAddress(address);
      return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/'
        + folder + '/assets/' + cs + '/logo.png';
    } catch (_) {
      return chainLogoUrl(chainId);
    }
  }

  function getExplorerTxUrl(chainId, txHash) {
    var table = (window.EXPLORER_URLS && Object.keys(window.EXPLORER_URLS).length)
      ? window.EXPLORER_URLS
      : _LOCAL_EXPLORER_TX;
    return (table[chainId] || _LOCAL_EXPLORER_TX[chainId] || 'https://etherscan.io/tx/') + txHash;
  }

  /* Lazy mainnet provider — ENS always resolved on Ethereum mainnet */
  function getEnsProvider() {
    if (!_ensProvider) {
      _ensProvider = new ethers.providers.JsonRpcProvider('https://eth.llamarpc.com');
    }
    return _ensProvider;
  }

  /* Signer via Privy — matches swap.js pattern */
  function getSendSigner() {
    var pp = window.privyProvider || window.ethereum;
    if (!pp) return Promise.reject(new Error('No wallet connected.'));
    return Promise.resolve(new ethers.providers.Web3Provider(pp).getSigner());
  }

  /* Parse raw ethers error into a user-readable string */
  function parseEthError(err) {
    if (!err) return 'Transaction failed.';
    var msg = err.reason || err.message || String(err);
    if (/user rejected|User denied|ACTION_REJECTED/i.test(msg)) return 'Transaction rejected.';
    if (/insufficient funds/i.test(msg))                         return 'Insufficient funds for gas.';
    if (/nonce/i.test(msg))                                      return 'Nonce mismatch \u2014 try again.';
    if (/gas required exceeds/i.test(msg))                       return 'Gas limit exceeded.';
    return msg.slice(0, 120);
  }

  /* ─────────────────────────────────────────────────────────────────────
     HTML BUILDERS — Spec-compliant button structures.
  ───────────────────────────────────────────────────────────────────── */

  function buildBtnPrimaryHtml(label, extraClass) {
    return [
      '<button class="btn btn-primary' + (extraClass ? ' ' + extraClass : '') + '">',
        '<div class="btn-pulse-ring"></div>',
        '<div class="btn-inner">',
          '<div class="glass-sheen"></div>',
          '<span>' + escHtml(label) + '</span>',
        '</div>',
      '</button>',
    ].join('');
  }

  function buildBtnWhiteHtml(label, extraClass) {
    return [
      '<button class="btn btn-white' + (extraClass ? ' ' + extraClass : '') + '">',
        '<div class="btn-pulse-ring"></div>',
        '<div class="btn-inner">',
          '<div class="glass-sheen"></div>',
          '<span>' + escHtml(label) + '</span>',
        '</div>',
      '</button>',
    ].join('');
  }

  /* Full send view DOM — step 1 (token picker) + step 2 (recipient + amount) */
  function buildSendViewHTML() {
    return [

      /* ── Step 1: Token picker ────────────────────────────── */
      '<div id="send-step-token" class="send-step">',

        '<div class="search-wrap">',
          '<input class="glass-input send-token-search" id="send-token-search"',
            ' type="text" placeholder="Search tokens\u2026"',
            ' autocomplete="off" spellcheck="false" aria-label="Search tokens">',
        '</div>',

        '<div class="send-network-chips" id="send-network-chips">',
          '<button class="network-chip active" data-chain="all">All</button>',
          '<button class="network-chip" data-chain="1">Ethereum</button>',
          '<button class="network-chip" data-chain="42161">Arbitrum</button>',
          '<button class="network-chip" data-chain="8453">Base</button>',
          '<button class="network-chip" data-chain="10">Optimism</button>',
          '<button class="network-chip" data-chain="137">Polygon</button>',
          '<button class="network-chip" data-chain="56">BNB</button>',
          '<button class="network-chip" data-chain="43114">Avalanche</button>',
          '<button class="network-chip" data-chain="130">Unichain</button>',
        '</div>',

        '<div id="send-token-list" class="send-token-list"></div>',

      '</div>',

      /* ── Step 2: Recipient + Amount ──────────────────────── */
      '<div id="send-step-recipient" class="send-step" hidden>',

        '<div id="send-selected-token-badge" class="send-selected-token-badge"></div>',

        '<div class="send-recipient-wrap">',
          '<input class="glass-input send-recipient-input" id="send-recipient"',
            ' type="text" placeholder="Address or ENS name"',
            ' autocomplete="off" spellcheck="false"',
            ' aria-label="Recipient address or ENS name">',
          '<div class="send-ens-status" id="send-ens-status" hidden></div>',
        '</div>',

        '<div id="send-amount-wrap" class="send-amount-wrap" hidden>',
          '<div class="send-amount-row">',
            '<input class="send-amount-input" id="send-amount"',
              ' type="number" min="0" step="any" placeholder="0.00"',
              ' autocomplete="off" aria-label="Amount to send">',
            '<button class="send-max-btn" id="send-max-btn" aria-label="Send maximum">MAX</button>',
          '</div>',
          '<span class="send-amount-usd" id="send-amount-usd">\u2014</span>',
          '<div class="send-gas-row" id="send-gas-row" hidden>',
            '<span class="send-gas-label">Gas</span>',
            '<span class="send-gas-value" id="send-gas-value">\u2014</span>',
          '</div>',
        '</div>',

        '<div class="send-cta" id="send-cta" hidden></div>',

      '</div>',

    ].join('');
  }

  /* ─────────────────────────────────────────────────────────────────────
     MOUNT SEND VIEW
     Entry point. Called by `send:mount` event.
     options.fromToken — when true, preselects STATE.token from portfolioBalances.

     Mobile:  container is #mobile-send (already has class .send-view)
     Desktop: container is #right-panel-content (wrapped in a .send-view div)
  ───────────────────────────────────────────────────────────────────── */

  function mountSendView(container, options) {
    if (!container) return;
    var fromToken = !!(options && options.fromToken);

    resetSendFlow();
    _activeChip = 'all';

    var isMobileContainer = (container.id === 'mobile-send');

    if (isMobileContainer) {
      /* Mobile: render steps directly inside #mobile-send (already has .send-view) */
      container.innerHTML = buildSendViewHTML();
    } else {
      /* Desktop: wrap in .send-view so core.css layout rules apply */
      container.innerHTML = '<div class="send-view">' + buildSendViewHTML() + '</div>';
    }

    wireChips(container);
    wireSendSearch(container);

    if (fromToken && window.STATE && STATE.token) {
      var token = findHeldToken(STATE.token);
      if (token) {
        selectSendToken(token);
        return;
      }
    }

    renderSendStep1(container);
  }

  /* ─────────────────────────────────────────────────────────────────────
     STEP 1 — TOKEN PICKER
     Reads STATE.portfolioBalances. No async fetch — that belongs to portfolio.js.
     Four states: skeleton not needed here (data is synchronous from cache).
     Shows: loaded token list / empty / error+retry / no-wallet.
  ───────────────────────────────────────────────────────────────────── */

  function renderSendStep1(container) {
    var tokenListEl = (container || document).querySelector('#send-token-list');
    if (!tokenListEl) return;

    /* Not connected */
    if (!window.STATE || !STATE.wallet) {
      tokenListEl.innerHTML = '<div class="send-empty">Connect a wallet to send.</div>';
      return;
    }

    var balances   = STATE.portfolioBalances || {};
    var heldTokens = flattenHeldTokens(balances);

    /* No held tokens — either portfolio not loaded yet or all chains failed */
    if (heldTokens.length === 0) {
      tokenListEl.innerHTML = [
        '<div class="send-error">',
          '<span>Could not load balances.</span>',
          buildBtnWhiteHtml('RETRY', 'send-retry-btn'),
        '</div>',
      ].join('');

      var retryBtn = tokenListEl.querySelector('.send-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', function () {
          tokenListEl.innerHTML = '<div class="send-empty">Loading\u2026</div>';
          if (window.mountPortfolio) window.mountPortfolio();
          /* Re-render after portfolio.js has had time to update STATE */
          setTimeout(function () { renderSendStep1(container); }, 2000);
        });
      }
      return;
    }

    /* Render token rows sorted by USD desc */
    tokenListEl.innerHTML = '';
    heldTokens.forEach(function (token) {
      tokenListEl.appendChild(buildSendTokenRow(token));
    });

    filterSendList(_activeChip);
  }

  /* Flatten STATE.portfolioBalances into sorted array of held tokens */
  function flattenHeldTokens(balances) {
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
          usd:      entry.usd      || 0,
          symbol:   entry.symbol   || '???',
          name:     entry.name     || entry.symbol || address.slice(0, 8),
          decimals: entry.decimals || 18,
        });
      });
    });
    return held.sort(function (a, b) { return b.usd - a.usd; });
  }

  /* Lookup a single held token by address across all chains. Returns highest-USD instance. */
  function findHeldToken(address) {
    var balances = (window.STATE && STATE.portfolioBalances) || {};
    var found    = null;

    Object.keys(balances).forEach(function (chainId) {
      var chainData = balances[chainId];
      if (!chainData || chainData._error) return;
      var entry = chainData[address];
      if (!entry || parseFloat(entry.balance) <= 0) return;
      if (!found || (entry.usd || 0) > (found.usd || 0)) {
        found = {
          address:  address,
          chainId:  Number(chainId),
          balance:  entry.balance,
          usd:      entry.usd      || 0,
          symbol:   entry.symbol   || '???',
          name:     entry.name     || entry.symbol || address.slice(0, 8),
          decimals: entry.decimals || 18,
        };
      }
    });

    return found;
  }

  /* Build a single send token row element */
  function buildSendTokenRow(token) {
    var logo  = tokenLogoUrl(token.address, token.chainId);
    var badge = chainLogoUrl(token.chainId);
    var chain = CHAIN_NAMES[token.chainId] || ('Chain ' + token.chainId);
    var sym   = (token.symbol || '?').slice(0, 4);

    var div = document.createElement('div');
    div.className       = 'send-token-row';
    div.dataset.chainId = String(token.chainId);
    div.setAttribute('role', 'button');

    div.innerHTML = [
      '<div class="asset-row-logo-wrap">',
        logo
          ? '<img class="asset-row-logo" src="' + escHtml(logo) + '" alt="' + escHtml(sym) + '"'
            + ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
          : '',
        '<div class="asset-row-logo-fallback"' + (logo ? ' style="display:none">' : '>') + escHtml(sym) + '</div>',
        badge
          ? '<img class="asset-row-chain-badge" src="' + escHtml(badge) + '" alt="' + escHtml(chain) + '">'
          : '',
      '</div>',
      '<div class="send-token-row-identity">',
        '<span class="send-token-row-name">'  + escHtml(token.name) + '</span>',
        '<span class="send-token-row-chain">' + escHtml(chain)      + '</span>',
      '</div>',
      '<div class="send-token-row-amounts">',
        '<span class="send-token-row-usd">'    + formatUSD(token.usd)                       + '</span>',
        '<span class="send-token-row-amount">' + escHtml(formatBalance(token.balance, token.symbol)) + '</span>',
      '</div>',
    ].join('');

    div.addEventListener('click', function () { selectSendToken(token); });

    return div;
  }

  /* ─────────────────────────────────────────────────────────────────────
     NETWORK CHIP WIRING + FILTER
  ───────────────────────────────────────────────────────────────────── */

  function wireChips(container) {
    container.querySelectorAll('.network-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var c = chip.dataset.chain;
        filterSendList(c === 'all' ? 'all' : Number(c));
      });
    });
  }

  function filterSendList(chainId) {
    _activeChip = chainId;

    document.querySelectorAll('.send-token-row[data-chain-id]').forEach(function (row) {
      row.hidden = (chainId !== 'all') && (row.dataset.chainId !== String(chainId));
    });

    document.querySelectorAll('.network-chip').forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.chain === String(chainId));
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     SEARCH FILTER WIRING (Step 1)
     Combines with chip filter — hidden rows stay hidden.
  ───────────────────────────────────────────────────────────────────── */

  function wireSendSearch(container) {
    var input = container.querySelector('#send-token-search');
    if (!input) return;

    input.addEventListener('input', function () {
      var q    = input.value.trim().toLowerCase();
      var rows = document.querySelectorAll('.send-token-row');

      rows.forEach(function (row) {
        var chipMatch = (_activeChip === 'all') || (row.dataset.chainId === String(_activeChip));

        if (!q) {
          row.hidden = !chipMatch;
          return;
        }

        var nameEl  = row.querySelector('.send-token-row-name');
        var chainEl = row.querySelector('.send-token-row-chain');
        var name    = nameEl  ? nameEl.textContent.toLowerCase()  : '';
        var chain   = chainEl ? chainEl.textContent.toLowerCase() : '';
        row.hidden  = !(chipMatch && (name.indexOf(q) > -1 || chain.indexOf(q) > -1));
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     STEP 2 — TOKEN SELECTED
     Hides step 1, shows step 2. Renders badge and wires all interactions.
  ───────────────────────────────────────────────────────────────────── */

  function selectSendToken(token) {
    var sf = window.STATE && STATE.sendFlow;
    if (sf) {
      sf.token        = token;
      sf.step         = 'recipient';
      sf.recipient    = '';
      sf.resolvedAddr = null;
      sf.recipientEns = undefined;
      sf.amount       = '';
      sf.gasEst       = null;
    }

    var step1 = document.getElementById('send-step-token');
    var step2 = document.getElementById('send-step-recipient');
    if (step1) step1.hidden = true;
    if (step2) step2.hidden = false;

    renderSelectedTokenBadge(token);
    resetStep2Fields();
    wireStep2();
  }

  function renderSelectedTokenBadge(token) {
    var badge = document.getElementById('send-selected-token-badge');
    if (!badge) return;

    var logo   = tokenLogoUrl(token.address, token.chainId);
    var chain  = CHAIN_NAMES[token.chainId] || ('Chain ' + token.chainId);
    var balStr = formatBalance(token.balance, token.symbol);

    badge.innerHTML = [
      logo
        ? '<img src="' + escHtml(logo) + '" alt="' + escHtml(token.symbol) + '"'
          + ' width="24" height="24" style="border-radius:50%;flex-shrink:0"'
          + ' onerror="this.style.display=\'none\'">'
        : '',
      '<div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">',
        '<span style="font-family:var(--fm);font-size:.78rem;letter-spacing:.02em;color:var(--br)">',
          escHtml(token.symbol) + ' \u00b7 ' + escHtml(chain),
        '</span>',
        '<span style="font-family:var(--fm);font-size:.60rem;letter-spacing:.02em;color:var(--dim)">',
          'Available: ' + escHtml(balStr),
        '</span>',
      '</div>',
      '<button class="send-change-btn" aria-label="Change token">CHANGE</button>',
    ].join('');

    /* Style the change button via element style to keep CSS vars working */
    var changeBtn = badge.querySelector('.send-change-btn');
    if (changeBtn) {
      changeBtn.style.cssText = [
        'background:transparent',
        'border:1px solid var(--em-lo)',
        'color:var(--em-2)',
        'font-family:var(--fm)',
        'font-size:.48rem',
        'letter-spacing:.24em',
        'text-transform:uppercase',
        'padding:5px 10px',
        'border-radius:5px',
        'cursor:none',
        'outline:none',
        'flex-shrink:0',
        '-webkit-tap-highlight-color:transparent',
        'transition:border-color 120ms var(--ease-std),background 120ms var(--ease-std)',
      ].join(';');
      changeBtn.addEventListener('click', resetToStep1);
    }
  }

  /* Navigate back to token picker */
  function resetToStep1() {
    var sf = window.STATE && STATE.sendFlow;
    if (sf) {
      sf.step         = 'token';
      sf.token        = null;
      sf.recipient    = '';
      sf.resolvedAddr = null;
      sf.recipientEns = undefined;
      sf.amount       = '';
      sf.gasEst       = null;
    }

    var step1 = document.getElementById('send-step-token');
    var step2 = document.getElementById('send-step-recipient');
    if (step1) step1.hidden = false;
    if (step2) step2.hidden = true;

    /* Restore chip filter state */
    filterSendList(_activeChip);
    clearTimeout(_resolveTimer);
    clearTimeout(_gasTimer);
  }

  /* Reset all step 2 UI fields to initial state */
  function resetStep2Fields() {
    var resets = {
      'send-recipient':   function (el) { el.value = ''; },
      'send-amount':      function (el) { el.value = ''; },
      'send-ens-status':  function (el) { el.className = 'send-ens-status'; el.textContent = ''; el.hidden = true; },
      'send-amount-wrap': function (el) { el.hidden = true; },
      'send-gas-row':     function (el) { el.hidden = true; },
      'send-cta':         function (el) { el.hidden = true; el.innerHTML = ''; },
      'send-amount-usd':  function (el) { el.textContent = '\u2014'; },
      'send-gas-value':   function (el) { el.textContent = '\u2014'; },
    };
    Object.keys(resets).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) resets[id](el);
    });
    clearTimeout(_resolveTimer);
    clearTimeout(_gasTimer);
  }

  /* Wire all step 2 interactions. cloneNode clears previous listeners without leak. */
  function wireStep2() {
    /* Render SEND button into CTA (hidden until recipient resolves) */
    var sendCta = document.getElementById('send-cta');
    if (sendCta) {
      sendCta.innerHTML = buildBtnPrimaryHtml('SEND', 'send-submit-btn');
      var sendBtn = sendCta.querySelector('.send-submit-btn');
      if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.addEventListener('click', executeSend);
      }
    }

    /* Recipient input */
    var recipientEl = document.getElementById('send-recipient');
    if (recipientEl) {
      var newR = recipientEl.cloneNode(true);
      recipientEl.parentNode.replaceChild(newR, recipientEl);
      newR.addEventListener('input', function () {
        var val = newR.value.trim();
        var sf  = window.STATE && STATE.sendFlow;
        if (sf) { sf.recipient = val; sf.resolvedAddr = null; sf.recipientEns = undefined; }
        clearTimeout(_resolveTimer);
        _resolveTimer = setTimeout(function () { resolveRecipient(val); }, 400);
      });
    }

    /* Amount input */
    var amountEl = document.getElementById('send-amount');
    if (amountEl) {
      var newA = amountEl.cloneNode(true);
      amountEl.parentNode.replaceChild(newA, amountEl);
      newA.addEventListener('input', function () {
        var sf = window.STATE && STATE.sendFlow;
        if (sf) sf.amount = newA.value;
        updateSendAmountUSD();
        updateSendButton();
        clearTimeout(_gasTimer);
        _gasTimer = setTimeout(estimateSendGas, 600);
      });
    }

    /* MAX button */
    var maxEl = document.getElementById('send-max-btn');
    if (maxEl) {
      var newM = maxEl.cloneNode(true);
      maxEl.parentNode.replaceChild(newM, maxEl);
      newM.addEventListener('click', setMaxAmount);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     RESOLVE RECIPIENT
     Debounced 400ms. Four distinct states rendered in #send-ens-status:
       1. empty      — hide status + amount-wrap + cta
       2. resolving  — "Resolving…" (ENS in-flight)
       3. resolved   — green "Valid address" / "→ 0xabcd…ef01"
       4. invalid    — red "Invalid address" / "Name not found" / "Invalid checksum"
  ───────────────────────────────────────────────────────────────────── */

  function resolveRecipient(input) {
    var ensEl   = document.getElementById('send-ens-status');
    var amtWrap = document.getElementById('send-amount-wrap');
    var sendCta = document.getElementById('send-cta');
    var sf      = window.STATE && STATE.sendFlow;

    if (!ensEl || !amtWrap) return;

    /* Reset resolved state on every new input */
    if (sf) { sf.resolvedAddr = null; sf.recipientEns = undefined; }
    updateSendButton();

    /* ── Empty ─────────────────────────── */
    if (!input) {
      ensEl.className   = 'send-ens-status';
      ensEl.textContent = '';
      ensEl.hidden       = true;
      amtWrap.hidden     = true;
      if (sendCta) sendCta.hidden = true;
      return;
    }

    /* ── 0x address ────────────────────── */
    if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
      try {
        var checksummed = ethers.utils.getAddress(input);
        ensEl.className   = 'send-ens-status resolved';
        ensEl.textContent = 'Valid address';
        ensEl.hidden       = false;
        if (sf) sf.resolvedAddr = checksummed;
        amtWrap.hidden  = false;
        if (sendCta) sendCta.hidden = false;
        updateSendButton();
      } catch (_) {
        ensEl.className   = 'send-ens-status invalid';
        ensEl.textContent = 'Invalid checksum';
        ensEl.hidden       = false;
        amtWrap.hidden     = true;
        if (sendCta) sendCta.hidden = true;
      }
      return;
    }

    /* ── ENS name (contains dot) ────────── */
    if (input.indexOf('.') > -1) {
      ensEl.className   = 'send-ens-status resolving';
      ensEl.textContent = 'Resolving\u2026';
      ensEl.hidden       = false;
      amtWrap.hidden     = true;
      if (sendCta) sendCta.hidden = true;

      var capturedInput = input;

      getEnsProvider().resolveName(capturedInput).then(function (resolved) {
        /* Guard: abort if the input changed before this resolved */
        var currentEl = document.getElementById('send-recipient');
        if (!currentEl || currentEl.value.trim() !== capturedInput) return;

        if (resolved) {
          ensEl.className   = 'send-ens-status resolved';
          ensEl.textContent = '\u2192 ' + truncAddr(resolved);
          ensEl.hidden       = false;
          if (sf) {
            sf.resolvedAddr = resolved;
            sf.recipientEns = capturedInput;
          }
          amtWrap.hidden  = false;
          if (sendCta) sendCta.hidden = false;
          updateSendButton();
        } else {
          ensEl.className   = 'send-ens-status invalid';
          ensEl.textContent = 'Name not found';
          ensEl.hidden       = false;
          amtWrap.hidden     = true;
          if (sendCta) sendCta.hidden = true;
        }
      }).catch(function () {
        var currentEl = document.getElementById('send-recipient');
        if (!currentEl || currentEl.value.trim() !== capturedInput) return;
        ensEl.className   = 'send-ens-status invalid';
        ensEl.textContent = 'Resolution failed';
        ensEl.hidden       = false;
        amtWrap.hidden     = true;
        if (sendCta) sendCta.hidden = true;
      });

      return;
    }

    /* ── Invalid ───────────────────────── */
    ensEl.className   = 'send-ens-status invalid';
    ensEl.textContent = 'Invalid address';
    ensEl.hidden       = false;
    amtWrap.hidden     = true;
    if (sendCta) sendCta.hidden = true;
  }

  /* ─────────────────────────────────────────────────────────────────────
     MAX AMOUNT
     Fills amount input with available balance.
     For native tokens: reserves 0.001 ETH as gas buffer.
  ───────────────────────────────────────────────────────────────────── */

  function setMaxAmount() {
    var sf = window.STATE && STATE.sendFlow;
    if (!sf || !sf.token) return;

    var token     = sf.token;
    var balances  = (window.STATE && STATE.portfolioBalances) || {};
    var chainData = balances[token.chainId];
    var entry     = chainData && chainData[token.address];
    if (!entry) return;

    var bal = parseFloat(entry.balance);
    if (isNaN(bal) || bal <= 0) return;

    /* Reserve gas buffer for native — none for ERC-20 */
    var maxVal    = isNativeToken(token) ? Math.max(0, bal - 0.001) : bal;
    var precision = Math.min(isNativeToken(token) ? 6 : (token.decimals || 18), 8);
    var maxStr    = maxVal.toFixed(precision);

    var amtEl = document.getElementById('send-amount');
    if (!amtEl) return;
    amtEl.value = maxStr;
    if (sf) sf.amount = maxStr;

    updateSendAmountUSD();
    updateSendButton();
    clearTimeout(_gasTimer);
    _gasTimer = setTimeout(estimateSendGas, 600);
  }

  /* ─────────────────────────────────────────────────────────────────────
     AMOUNT → USD PREVIEW
  ───────────────────────────────────────────────────────────────────── */

  function updateSendAmountUSD() {
    var usdEl = document.getElementById('send-amount-usd');
    if (!usdEl) return;

    var sf = window.STATE && STATE.sendFlow;
    if (!sf || !sf.token) { usdEl.textContent = '\u2014'; return; }

    var amtEl  = document.getElementById('send-amount');
    var amount = parseFloat(amtEl ? amtEl.value : sf.amount);
    if (isNaN(amount) || amount <= 0) { usdEl.textContent = '\u2014'; return; }

    var prices = (window.STATE && STATE.prices) || {};
    var entry  = prices[sf.token.address];
    if (!entry || !entry.usd) { usdEl.textContent = '\u2014'; return; }

    usdEl.textContent = formatUSD(amount * entry.usd);
  }

  /* ─────────────────────────────────────────────────────────────────────
     GAS ESTIMATION
     Best-effort. Debounced 600ms. Never blocks the send action.
     Displays ETH cost + USD (via WETH mainnet price proxy).
  ───────────────────────────────────────────────────────────────────── */

  function estimateSendGas() {
    var sf     = window.STATE && STATE.sendFlow;
    var gasRow = document.getElementById('send-gas-row');
    var gasVal = document.getElementById('send-gas-value');
    if (!sf || !sf.token || !sf.resolvedAddr || !gasRow || !gasVal) return;

    var amtEl  = document.getElementById('send-amount');
    var amount = amtEl ? amtEl.value.trim() : sf.amount;
    if (!amount || parseFloat(amount) <= 0) return;

    var token = sf.token;
    var amountBN;
    try {
      amountBN = isNativeToken(token)
        ? ethers.utils.parseEther(amount)
        : ethers.utils.parseUnits(amount, token.decimals);
    } catch (_) {
      return;
    }

    getSendSigner().then(function (signer) {
      var provider = signer.provider;

      var gasPromise = isNativeToken(token)
        ? provider.estimateGas({
            to:    sf.resolvedAddr,
            value: amountBN,
            from:  window.STATE && STATE.wallet,
          })
        : (function () {
            var contract = new ethers.Contract(token.address, ERC20_ABI, signer);
            return contract.estimateGas.transfer(sf.resolvedAddr, amountBN);
          }());

      return gasPromise.then(function (gasUnits) {
        return provider.getGasPrice().then(function (gasPrice) {
          var gasCostWei = gasUnits.mul(gasPrice);
          var gasCostEth = parseFloat(ethers.utils.formatEther(gasCostWei));
          var display    = gasCostEth.toFixed(6) + ' ETH';

          /* Append USD using WETH price as ETH proxy */
          var prices    = (window.STATE && STATE.prices) || {};
          var wethEntry = prices[ethers.utils.getAddress(WETH_MAINNET)];
          if (wethEntry && wethEntry.usd) {
            display += ' (' + formatUSD(gasCostEth * wethEntry.usd) + ')';
          }

          if (sf) sf.gasEst = display;
          gasVal.textContent = display;
          gasRow.hidden      = false;
        });
      });
    }).catch(function () {
      /* Non-critical — gas estimation failure is quiet */
      gasVal.textContent = '\u2014';
      gasRow.hidden      = false;
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     SEND BUTTON STATE
     Enabled only when: valid resolved address + amount > 0 + amount ≤ balance.
  ───────────────────────────────────────────────────────────────────── */

  function updateSendButton() {
    var sendBtn = document.querySelector('.send-submit-btn');
    if (!sendBtn) return;

    var sf = window.STATE && STATE.sendFlow;
    if (!sf || !sf.resolvedAddr || !sf.token) {
      sendBtn.disabled = true;
      return;
    }

    var amtEl  = document.getElementById('send-amount');
    var amount = parseFloat(amtEl ? amtEl.value : '');
    if (isNaN(amount) || amount <= 0) {
      sendBtn.disabled = true;
      return;
    }

    var balances  = (window.STATE && STATE.portfolioBalances) || {};
    var chainData = balances[sf.token.chainId];
    var entry     = chainData && chainData[sf.token.address];
    var balance   = entry ? parseFloat(entry.balance) : 0;

    sendBtn.disabled = (amount > balance);
  }

  /* ─────────────────────────────────────────────────────────────────────
     EXECUTE SEND
     Two paths: native ETH sendTransaction / ERC-20 contract.transfer()
     Loading state during wallet prompt + confirmation wait.
     Success: tx hash + explorer link. Failure: readable error message.
  ───────────────────────────────────────────────────────────────────── */

  function executeSend() {
    var sf = window.STATE && STATE.sendFlow;
    if (!sf || !sf.token || !sf.resolvedAddr) return;

    var amtEl  = document.getElementById('send-amount');
    var amount = amtEl ? amtEl.value.trim() : sf.amount;
    if (!amount || parseFloat(amount) <= 0) return;

    /* Validate amount ≤ balance before committing */
    var token     = sf.token;
    var balances  = (window.STATE && STATE.portfolioBalances) || {};
    var chainData = balances[token.chainId];
    var entry     = chainData && chainData[token.address];
    var balance   = entry ? parseFloat(entry.balance) : 0;

    if (parseFloat(amount) > balance) {
      appendSendStatus('error', 'Amount exceeds available balance.');
      return;
    }

    var amountBN;
    try {
      amountBN = isNativeToken(token)
        ? ethers.utils.parseEther(amount)
        : ethers.utils.parseUnits(amount, token.decimals);
    } catch (_) {
      appendSendStatus('error', 'Invalid amount — check decimal precision.');
      return;
    }

    setSendButtonState('loading', 'SENDING\u2026');
    appendSendStatus('pending', 'Waiting for wallet approval\u2026');

    getSendSigner().then(function (signer) {
      var txPromise = isNativeToken(token)
        ? signer.sendTransaction({ to: sf.resolvedAddr, value: amountBN })
        : new ethers.Contract(token.address, ERC20_ABI, signer).transfer(sf.resolvedAddr, amountBN);

      return txPromise.then(function (tx) {
        appendSendStatus('pending', 'Submitted \u2014 waiting for confirmation\u2026');

        return tx.wait().then(function (receipt) {
          var txHash  = receipt.transactionHash;
          var chainId = (window.STATE && STATE.network) || token.chainId || 1;

          recordTransfer(txHash, token, sf.resolvedAddr, amount);
          setSendButtonState('idle', 'SEND');
          appendSendStatus('success', 'Sent', txHash, getExplorerTxUrl(chainId, txHash));
        });
      });

    }).catch(function (err) {
      setSendButtonState('idle', 'SEND');
      appendSendStatus('error', parseEthError(err));
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     BUTTON STATE MANAGEMENT
  ───────────────────────────────────────────────────────────────────── */

  function setSendButtonState(state, label) {
    var sendBtn = document.querySelector('.send-submit-btn');
    if (!sendBtn) return;
    var span = sendBtn.querySelector('span');
    if (span) span.textContent = label;

    if (state === 'loading') {
      sendBtn.disabled = true;
    } else {
      updateSendButton(); /* re-evaluate enabled based on current fields */
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     SEND STATUS MESSAGE
     Appended below the SEND button. Replaces previous status.
     pending → dim  |  success → green  |  error → red
     Success renders tx hash as explorer link.
  ───────────────────────────────────────────────────────────────────── */

  function appendSendStatus(type, message, txHash, explorerUrl) {
    var sendCta = document.getElementById('send-cta');
    if (!sendCta) return;

    /* Replace previous status */
    var prev = sendCta.querySelector('.send-tx-status');
    if (prev) prev.parentNode.removeChild(prev);
    if (!message) return;

    var colorMap = { pending: 'var(--dim)', success: 'var(--up)', error: 'var(--dn)' };

    var el = document.createElement('div');
    el.className = 'send-tx-status';
    el.style.cssText = [
      'font-family:var(--fm)',
      'font-size:.64rem',
      'letter-spacing:.04em',
      'line-height:1.5',
      'padding:var(--sp-2) 0',
      'color:' + (colorMap[type] || 'var(--dim)'),
      'animation:fadeSlideIn 180ms var(--ease-spr)',
      'word-break:break-word',
    ].join(';');

    if (type === 'success' && txHash && explorerUrl) {
      el.innerHTML = escHtml(message) + ' \u2014 '
        + '<a href="' + escHtml(explorerUrl) + '" target="_blank" rel="noopener noreferrer"'
        + ' style="color:var(--em-2);text-decoration:underline;cursor:pointer">'
        + escHtml(truncAddr(txHash))
        + '</a>';
    } else {
      el.textContent = message;
    }

    sendCta.appendChild(el);
    sendCta.hidden = false;
  }

  /* ─────────────────────────────────────────────────────────────────────
     RECORD TRANSFER
     Pushes a send record to STATE.trades and persists to localStorage.
     Schema matches recordTrade in swap.js.
  ───────────────────────────────────────────────────────────────────── */

  function recordTransfer(txHash, token, recipient, amount) {
    if (!window.STATE) return;
    var sf = STATE.sendFlow;

    var record = {
      type:      'send',
      txHash:    txHash,
      fromToken: token.symbol,
      toToken:   null,
      amount:    amount,
      recipient: (sf && sf.recipientEns) || recipient,
      network:   STATE.network,
      timestamp: Date.now(),
    };

    STATE.trades.unshift(record);
    try {
      localStorage.setItem('obsideum:trades', JSON.stringify(STATE.trades));
    } catch (_) { /* storage full — fail silently */ }
  }

  /* ─────────────────────────────────────────────────────────────────────
     RESET SEND FLOW
     Resets STATE.sendFlow to initial values. Clears debounce timers.
  ───────────────────────────────────────────────────────────────────── */

  function resetSendFlow() {
    var sf = window.STATE && STATE.sendFlow;
    if (!sf) return;
    sf.step         = 'token';
    sf.token        = null;
    sf.recipient    = '';
    sf.resolvedAddr = null;
    sf.recipientEns = undefined;
    sf.amount       = '';
    sf.gasEst       = null;
    clearTimeout(_resolveTimer);
    clearTimeout(_gasTimer);
  }

  /* ─────────────────────────────────────────────────────────────────────
     PHASE 9D — STATE LISTENERS
  ───────────────────────────────────────────────────────────────────── */

  /*
   * send:mount — dispatched by Phase 8D action button handler for both
   * mobile and desktop. Container is detected by viewport width.
   * This is the ONLY mount trigger — panel:render does not mount send UI.
   */
  document.addEventListener('send:mount', function (e) {
    var isMobile  = window.innerWidth < 768;
    var container = isMobile
      ? document.getElementById('mobile-send')
      : document.getElementById('right-panel-content');
    if (!container) return;
    mountSendView(container, { fromToken: !!(e.detail && e.detail.fromToken) });
  });

  /*
   * panel:render — for cleanup only when navigating to a different right-panel view.
   * Mounting is handled exclusively by send:mount to avoid a double-mount on desktop
   * (openRightPanel fires panel:render, then action handler fires send:mount).
   */
  document.addEventListener('panel:render', function (e) {
    if (e.detail === 'send') return;
    var container = document.getElementById('right-panel-content');
    if (!container) return;
    var sendWrap = container.querySelector('.send-view');
    if (sendWrap) container.removeChild(sendWrap);
  });

  /*
   * state:prices — refresh USD preview when prices update mid-flow.
   */
  document.addEventListener('state:prices', function () {
    var amtEl = document.getElementById('send-amount');
    if (amtEl && amtEl.value) updateSendAmountUSD();
  });

  /* ─────────────────────────────────────────────────────────────────────
     PHASE 9E — RECEIVE FLOW
     mountReceiveView  — per-network address list + copy + QR
     copyAddress       — clipboard with visual button feedback
     toggleQR          — expand / collapse (one open at a time)

     chainLogoUrl() and CHAIN_NAMES are defined in Phase 9D above.
     CHAIN_LOGO_KEY from the plan spec is functionally identical to
     CHAIN_FOLDERS — reusing existing implementation, no duplication.
  ───────────────────────────────────────────────────────────────────── */

  /* ── SVG icon literals — inline, no external dependency ── */

  var _SVG_COPY = [
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"',
      ' stroke="currentColor" stroke-width="1.5"',
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '<rect x="9" y="9" width="13" height="13" rx="2"/>',
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    '</svg>',
  ].join('');

  var _SVG_CHECK = [
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"',
      ' stroke="currentColor" stroke-width="2"',
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '<polyline points="20 6 9 17 4 12"/>',
    '</svg>',
  ].join('');

  var _SVG_QR = [
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"',
      ' stroke="currentColor" stroke-width="1.5"',
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '<rect x="3" y="3" width="7" height="7" rx="1"/>',
      '<rect x="14" y="3" width="7" height="7" rx="1"/>',
      '<rect x="3" y="14" width="7" height="7" rx="1"/>',
      '<path d="M14 14h.01M14 17h.01M14 20h.01',
        'M17 14h.01M17 17h.01M17 20h.01',
        'M20 14h.01M20 17h.01M20 20h.01"/>',
    '</svg>',
  ].join('');

  /* ─────────────────────────────────────────────────────────────────────
     mountReceiveView(container)
     Mobile:  container is #mobile-receive (already has .receive-view class)
     Desktop: container is #right-panel-content (wraps in .receive-view div)

     Not connected → empty state.
     Connected     → intro note + one row per chain in activeNetworks.
  ───────────────────────────────────────────────────────────────────── */

  function mountReceiveView(container) {
    if (!container) return;

    var wallet            = window.STATE && STATE.wallet;
    var isMobileContainer = (container.id === 'mobile-receive');

    /* ── Not connected ─────────────────────────────────────── */
    if (!wallet) {
      var emptyHtml = '<div class="portfolio-empty">Connect a wallet to receive.</div>';
      container.innerHTML = isMobileContainer
        ? emptyHtml
        : '<div class="receive-view">' + emptyHtml + '</div>';
      return;
    }

    /* ── Build network rows ────────────────────────────────── */
    var activeNetworks = (window.STATE && STATE.settings && STATE.settings.activeNetworks)
      || [1, 42161, 8453, 10, 137, 56, 43114, 130];

    var addrTrunc = truncAddr(wallet);

    var rowsHtml = activeNetworks.map(function (chainId) {
      var name     = CHAIN_NAMES[chainId] || ('Chain ' + chainId);
      var logo     = chainLogoUrl(chainId);
      var chainStr = String(chainId);

      return [
        '<div class="receive-network-row" data-chain="' + chainStr + '">',

          /* Network logo — fallback to abbreviated text if no CDN coverage (e.g. Unichain) */
          logo
            ? '<img class="receive-network-logo"'
              + ' src="' + escHtml(logo) + '"'
              + ' alt="' + escHtml(name) + '"'
              + ' width="28" height="28"'
              + ' onerror="this.style.opacity=\'0\'">'
            : '<div class="receive-network-logo"'
              + ' style="background:rgba(156,61,187,.10);display:flex;align-items:center;'
              + 'justify-content:center;font-family:var(--fm);font-size:.46rem;'
              + 'letter-spacing:.06em;color:var(--dim)">'
              + escHtml(name.slice(0, 3).toUpperCase())
              + '</div>',

          '<div class="receive-network-info">',
            '<span class="receive-network-name">' + escHtml(name)      + '</span>',
            '<span class="receive-network-addr">' + escHtml(addrTrunc) + '</span>',
          '</div>',

          /* Copy button */
          '<button class="receive-copy-btn"',
            ' data-chain="' + chainStr + '"',
            ' aria-label="Copy address on ' + escHtml(name) + '">',
            _SVG_COPY,
          '</button>',

          /* QR toggle button */
          '<button class="receive-qr-btn"',
            ' data-chain="' + chainStr + '"',
            ' aria-label="Show QR code for ' + escHtml(name) + '">',
            _SVG_QR,
          '</button>',

        '</div>',

        /* QR expand area — hidden by default, one canvas per chain */
        '<div class="receive-qr-expand" id="receive-qr-' + chainStr + '" hidden>',
          '<canvas id="receive-qr-canvas-' + chainStr + '"></canvas>',
        '</div>',

      ].join('');
    }).join('');

    var contentHtml = [
      '<p class="receive-intro-note">',
        'Your address is the same across all EVM networks. ',
        'Always verify the destination network when sending to you.',
      '</p>',
      '<div id="receive-network-list" class="receive-network-list">',
        rowsHtml,
      '</div>',
    ].join('');

    /* Inject — mobile uses the container directly, desktop wraps */
    container.innerHTML = isMobileContainer
      ? contentHtml
      : '<div class="receive-view">' + contentHtml + '</div>';

    /* Wire event delegation on the correct scope */
    var scope = isMobileContainer
      ? container
      : (container.querySelector('.receive-view') || container);
    wireReceive(scope);
  }

  /* ─────────────────────────────────────────────────────────────────────
     wireReceive(scope)
     Event delegation for copy + QR buttons — one listener, zero leaks.
  ───────────────────────────────────────────────────────────────────── */

  function wireReceive(scope) {
    if (!scope) return;
    scope.addEventListener('click', function (e) {
      var copyBtn = e.target.closest('.receive-copy-btn');
      if (copyBtn) {
        copyAddress(Number(copyBtn.dataset.chain));
        return;
      }
      var qrBtn = e.target.closest('.receive-qr-btn');
      if (qrBtn) {
        toggleQR(Number(qrBtn.dataset.chain));
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     copyAddress(chainId)
     Writes STATE.wallet to clipboard.
     Success → copy icon swaps to checkmark (600ms), then restores.
     Failure → "Failed" label for 2s, then restores.
  ───────────────────────────────────────────────────────────────────── */

  function copyAddress(chainId) {
    var wallet = window.STATE && STATE.wallet;
    if (!wallet) return;

    var btn = document.querySelector('.receive-copy-btn[data-chain="' + chainId + '"]');
    if (!btn) return;

    navigator.clipboard.writeText(wallet).then(function () {
      /* Swap to checkmark */
      var prevHtml = btn.innerHTML;
      btn.innerHTML    = _SVG_CHECK;
      btn.style.color  = 'var(--up)';

      setTimeout(function () {
        if (btn.isConnected) {
          btn.innerHTML   = prevHtml;
          btn.style.color = '';
        }
      }, 600);

    }).catch(function () {
      /* Clipboard permission denied — show brief text */
      var prevHtml = btn.innerHTML;
      btn.innerHTML = [
        '<span style="font-family:var(--fm);font-size:.46rem;letter-spacing:.06em;',
          'color:var(--dn);white-space:nowrap">Failed</span>',
      ].join('');

      setTimeout(function () {
        if (btn.isConnected) btn.innerHTML = prevHtml;
      }, 2000);
    });
  }

  /* ─────────────────────────────────────────────────────────────────────
     toggleQR(chainId)
     Collapses any open QR panel first (one open at a time).
     Expand  → QRCode.toCanvas() with violet-on-dark colors.
     Collapse → ctx.clearRect() + hidden.
     QRCode not loaded → "QR unavailable" message.
  ───────────────────────────────────────────────────────────────────── */

  function toggleQR(chainId) {
    var qrExpand = document.getElementById('receive-qr-' + chainId);
    if (!qrExpand) return;

    var isExpanding = qrExpand.hidden;

    /* Close all currently open QR panels (other than this one) */
    document.querySelectorAll('.receive-qr-expand:not([hidden])').forEach(function (el) {
      if (el === qrExpand) return;
      var cv = el.querySelector('canvas');
      if (cv) {
        try {
          cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
        } catch (_) {}
      }
      el.hidden = true;
    });

    /* ── Collapse ──────────────────────────────────────────── */
    if (!isExpanding) {
      var cv = qrExpand.querySelector('canvas');
      if (cv) {
        try {
          cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
        } catch (_) {}
      }
      qrExpand.hidden = true;
      return;
    }

    /* ── Expand ────────────────────────────────────────────── */
    qrExpand.hidden = false;

    var wallet = window.STATE && STATE.wallet;
    if (!wallet) return;

    var canvas = document.getElementById('receive-qr-canvas-' + chainId);
    if (!canvas) return;

    /* QRCode library not loaded (CDN failure) */
    if (typeof QRCode === 'undefined') {
      qrExpand.innerHTML = [
        '<p style="font-family:var(--fm);font-size:.60rem;letter-spacing:.08em;',
          'color:var(--dim);text-align:center;padding:var(--sp-4)">QR unavailable</p>',
      ].join('');
      return;
    }

    QRCode.toCanvas(
      canvas,
      wallet,
      {
        width:                180,
        color:                { dark: '#9C3DBB', light: '#070709' },
        errorCorrectionLevel: 'M',
      },
      function (err) {
        if (err) {
          /* Generation failed — replace canvas with error message */
          qrExpand.innerHTML = [
            '<p style="font-family:var(--fm);font-size:.60rem;letter-spacing:.08em;',
              'color:var(--dn);text-align:center;padding:var(--sp-4)">QR generation failed</p>',
          ].join('');
        }
      }
    );
  }

  /* ─────────────────────────────────────────────────────────────────────
     PHASE 9E — STATE LISTENERS
  ───────────────────────────────────────────────────────────────────── */

  /*
   * receive:mount — dispatched by Phase 8D action button handler.
   * Detects mobile vs desktop by viewport width.
   */
  document.addEventListener('receive:mount', function () {
    var isMobile  = window.innerWidth < 768;
    var container = isMobile
      ? document.getElementById('mobile-receive')
      : document.getElementById('right-panel-content');
    if (!container) return;
    mountReceiveView(container);
  });

  /*
   * panel:render — remove receive-view wrapper when right panel navigates away.
   * Mirrors the equivalent cleanup listener from Phase 9D (send flow).
   */
  document.addEventListener('panel:render', function (e) {
    if (e.detail === 'receive') return;
    var container = document.getElementById('right-panel-content');
    if (!container) return;
    var receiveWrap = container.querySelector('.receive-view');
    if (receiveWrap) container.removeChild(receiveWrap);
  });

  /*
   * state:wallet — re-render receive view when wallet connects or changes.
   * Keeps address display current without requiring user to close and reopen.
   */
  document.addEventListener('state:wallet', function () {
    /* Mobile: re-render if receive is the active sub-view */
    var mobileReceive = document.getElementById('mobile-receive');
    if (mobileReceive && !mobileReceive.hidden) {
      mountReceiveView(mobileReceive);
    }
    /* Desktop: re-render if receive is the open right panel */
    if (window.STATE && STATE.rightPanel === 'receive') {
      var rightContent = document.getElementById('right-panel-content');
      if (rightContent) mountReceiveView(rightContent);
    }
  });

  /* ─────────────────────────────────────────────────────────────────────
     WINDOW EXPORTS
  ───────────────────────────────────────────────────────────────────── */

  window.mountSendView    = mountSendView;
  window.mountReceiveView = mountReceiveView;

}());
