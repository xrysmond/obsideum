/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — wallet.js
   Phase 6A: Privy connection · session persistence · provider.
   Phase 6C: Wallet bottom sheet — all three states, ENS claim
             form, recent trades, network switch, copy address.
   Phase 6B: ENS resolution + subname registration (stubs here).

   Architecture: micro-island React pattern.
   Invisible React root wraps PrivyProvider, bridges auth state
   to vanilla JS via window._privyBridge. No React elsewhere.

   Provider contract:
     window.privyProvider — EIP-1193.
     swap.js: new ethers.providers.Web3Provider(window.privyProvider)

   State → DOM (2C handles desktop sidebar, wallet.js owns the rest):
     state:wallet/ens/ensSubname → #mobile-wallet-btn pill
     state:wallet/ens/ensSubname → wallet sheet re-render (if open)
     state:network               → wallet sheet re-render (if open)

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════════════════════════
   CONFIGURATION
═══════════════════════════════════════ */

var PRIVY_APP_ID = 'cmtemvtdu01rn0cjipu1ic33f';

var PRIVY_CONFIG = {
  appearance: {
    theme:       'dark',
    accentColor: '#9C3DBB',
  },
  loginMethods: ['wallet', 'email', 'google', 'twitter'],
  embeddedWallets: {
    ethereum: {
      createOnLogin: 'users-without-wallets',
    },
  },
};

var NETWORK_NAMES = {
  1:        'Ethereum',
  42161:    'Arbitrum One',
  8453:     'Base',
  10:       'Optimism',
  11155111: 'Sepolia',
};

var ETHERSCAN_URLS = {
  1:        'https://etherscan.io/tx/',
  42161:    'https://arbiscan.io/tx/',
  8453:     'https://basescan.org/tx/',
  10:       'https://optimistic.etherscan.io/tx/',
  11155111: 'https://sepolia.etherscan.io/tx/',
};

/* ═══════════════════════════════════════
   GLOBALS
═══════════════════════════════════════ */

window.privyProvider = null;

var _privyInitialized = false;
var _disconnectTimer  = null;
var _claimDebounce    = null;

var _privyReadyResolve;
var _privyReady = new Promise(function (res) { _privyReadyResolve = res; });

/* ═══════════════════════════════════════
   IDENTITY HELPERS
═══════════════════════════════════════ */

function getIdentityLabel() {
  if (STATE.ensSubname) return STATE.ensSubname;
  if (STATE.ens)        return STATE.ens;
  if (STATE.wallet)     return _truncate6x4(STATE.wallet);
  return null;
}

function _truncate6x4(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function _truncate10x8(addr) {
  if (!addr) return '';
  return addr.slice(0, 10) + '...' + addr.slice(-8);
}

function _relTime(ts) {
  var d  = Date.now() - ts;
  var m  = Math.floor(d / 60000);
  var h  = Math.floor(d / 3600000);
  var dy = Math.floor(d / 86400000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  if (h < 24) return h + 'h ago';
  if (dy < 7) return dy + 'd ago';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _explorerUrl(hash) {
  var base = ETHERSCAN_URLS[STATE.network] || 'https://etherscan.io/tx/';
  return base + hash;
}

function _esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════
   MOBILE WALLET PILL
═══════════════════════════════════════ */

function updateMobilePill() {
  var btn   = document.getElementById('mobile-wallet-btn');
  var label = document.getElementById('mobile-wallet-label');
  if (!btn || !label) return;

  if (!STATE.connected) {
    btn.classList.add('disconnected');
    label.textContent = 'CONNECT';
    return;
  }

  btn.classList.remove('disconnected');
  label.textContent = getIdentityLabel() || _truncate6x4(STATE.wallet);
}

/* ═══════════════════════════════════════
   WALLET SHEET — OPEN / CLOSE
═══════════════════════════════════════ */

function openWalletSheet() {
  var sheet   = document.getElementById('wallet-sheet');
  var overlay = document.getElementById('wallet-sheet-overlay');

  if (!sheet || !overlay) {
    if (!STATE.connected) connect();
    return;
  }

  renderWalletSheet();

  overlay.hidden = false;
  sheet.hidden   = false;

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      sheet.classList.add('panel-visible');
      overlay.style.opacity = '1';
    });
  });
}

function closeWalletSheet() {
  var sheet   = document.getElementById('wallet-sheet');
  var overlay = document.getElementById('wallet-sheet-overlay');
  if (!sheet || !overlay) return;

  sheet.classList.remove('panel-visible');
  overlay.style.opacity = '0';

  setTimeout(function () {
    sheet.hidden   = true;
    overlay.hidden = true;
    overlay.style.opacity = '';
    _resetDisconnectBtn();
  }, 320);
}

/* ═══════════════════════════════════════
   WALLET SHEET — RENDER
   State A: not connected
   State B: connected, no ENSv2 subname
   State C: connected + ENSv2 subname registered
═══════════════════════════════════════ */

function renderWalletSheet() {
  var sheet = document.getElementById('wallet-sheet');
  if (!sheet) return;

  var sIdentity = document.getElementById('wallet-sheet-identity');
  var sAddress  = document.getElementById('wallet-sheet-address');
  var sTrades   = document.getElementById('wallet-sheet-trades');
  var sNetwork  = document.getElementById('wallet-sheet-network');
  var sVia      = document.getElementById('wallet-sheet-via');
  var sDisconn  = document.getElementById('wallet-sheet-disconnect');

  if (!sIdentity) return;

  if (!STATE.connected || !STATE.wallet) {
    _renderStateA(sIdentity, sAddress, sTrades, sNetwork, sVia, sDisconn);
    return;
  }

  _renderStateConnected(sIdentity, sAddress, sTrades, sNetwork, sVia, sDisconn);
}

/* ── State A — not connected ─────────────────────────────────── */

function _renderStateA(sIdentity, sAddress, sTrades, sNetwork, sVia, sDisconn) {
  sIdentity.innerHTML =
    '<div class="wsh-connect-section">' +
      '<span class="wsh-connect-eyebrow">Connect to get started</span>' +
      '<button class="btn btn-primary wsh-connect-btn" id="wsh-connect-btn" aria-label="Connect wallet">' +
        'CONNECT WALLET' +
      '</button>' +
    '</div>';

  sAddress.hidden  = true;
  sTrades.hidden   = true;
  sNetwork.hidden  = true;
  sVia.hidden      = true;
  if (sDisconn) sDisconn.hidden = true;

  var btn = document.getElementById('wsh-connect-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      closeWalletSheet();
      connect();
    });
  }
}

/* ── States B + C — connected ────────────────────────────────── */

function _renderStateConnected(sIdentity, sAddress, sTrades, sNetwork, sVia, sDisconn) {
  var hasSubname = !!STATE.ensSubname;
  var hasENS     = !!STATE.ens;
  var hasTrades  = STATE.trades && STATE.trades.length > 0;

  _renderIdentity(sIdentity, hasSubname, hasENS);

  _renderAddress(sAddress);
  sAddress.hidden = false;

  if (hasSubname && hasTrades) {
    _renderTrades(sTrades);
    sTrades.hidden = false;
  } else {
    sTrades.hidden = true;
  }

  _renderNetwork(sNetwork);
  sNetwork.hidden = false;

  _renderVia(sVia);
  sVia.hidden = false;

  if (sDisconn) sDisconn.hidden = false;
}

/* ── Identity section ────────────────────────────────────────── */

function _renderIdentity(el, hasSubname, hasENS) {
  if (hasSubname) {
    el.innerHTML =
      '<span class="wsh-label">Identity</span>' +
      '<div class="wsh-subname">' + _esc(STATE.ensSubname) + '</div>' +
      '<div class="wsh-subname-note">Registered &middot; Sepolia testnet</div>';
    return;
  }

  var identLine = hasENS
    ? '<div class="wsh-id-addr">' + _esc(STATE.ens) + '</div>'
    : '<div class="wsh-id-addr">' + _esc(_truncate6x4(STATE.wallet)) + '</div>';

  el.innerHTML =
    '<span class="wsh-label">Identity</span>' +
    identLine +
    '<button class="wsh-claim-prompt" id="wsh-claim-btn" aria-expanded="false">' +
      '<span class="wsh-claim-arrow" aria-hidden="true">\u203a</span>' +
      '<span>Claim your obsideum.eth identity</span>' +
    '</button>' +
    '<div id="wsh-claim-form" hidden></div>';

  _wireClaimPrompt();
}

function _wireClaimPrompt() {
  var claimBtn  = document.getElementById('wsh-claim-btn');
  var claimForm = document.getElementById('wsh-claim-form');
  if (!claimBtn || !claimForm) return;

  claimBtn.addEventListener('click', function () {
    var expanded = claimBtn.getAttribute('aria-expanded') === 'true';
    if (!expanded) {
      claimBtn.setAttribute('aria-expanded', 'true');
      claimBtn.classList.add('expanded');
      claimForm.hidden = false;
      claimForm.innerHTML = _buildClaimForm();
      _wireClaimForm();
    } else {
      claimBtn.setAttribute('aria-expanded', 'false');
      claimBtn.classList.remove('expanded');
      claimForm.hidden = true;
      clearTimeout(_claimDebounce);
    }
  });
}

function _buildClaimForm() {
  return (
    '<div class="wsh-ens-row">' +
      '<input class="wsh-ens-input" id="wsh-ens-input" type="text" ' +
        'placeholder="yourname" maxlength="32" ' +
        'autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" ' +
        'inputmode="url">' +
      '<span class="wsh-ens-suffix">.obsideum.eth</span>' +
    '</div>' +
    '<div class="wsh-ens-status" id="wsh-ens-status" role="status" aria-live="polite"></div>' +
    '<button class="btn btn-primary wsh-register-btn" id="wsh-register-btn" hidden disabled>' +
      'REGISTER' +
    '</button>'
  );
}

function _wireClaimForm() {
  var input       = document.getElementById('wsh-ens-input');
  var status      = document.getElementById('wsh-ens-status');
  var registerBtn = document.getElementById('wsh-register-btn');
  if (!input || !status || !registerBtn) return;

  setTimeout(function () { input.focus(); }, 80);

  input.addEventListener('input', function () {
    clearTimeout(_claimDebounce);

    /* Sanitise: lowercase alphanumeric + hyphen only */
    var raw = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (input.value !== raw) input.value = raw;

    status.textContent = '';
    status.className   = 'wsh-ens-status';
    registerBtn.hidden   = true;
    registerBtn.disabled = true;

    if (!raw) return;

    if (raw.length < 3) {
      status.textContent = 'Minimum 3 characters';
      status.className   = 'wsh-ens-status checking';
      return;
    }

    status.textContent = 'Checking\u2026';
    status.className   = 'wsh-ens-status checking';

    _claimDebounce = setTimeout(function () {
      checkSubnameAvailable(raw)
        .then(function (available) {
          if (input.value !== raw) return;
          if (available) {
            status.textContent = '\u2713 Available';
            status.className   = 'wsh-ens-status available';
            registerBtn.hidden   = false;
            registerBtn.disabled = false;
          } else {
            status.textContent = '\u2717 Already taken';
            status.className   = 'wsh-ens-status taken';
          }
        })
        .catch(function () {
          status.textContent = 'Could not check \u2014 try again';
          status.className   = 'wsh-ens-status checking';
        });
    }, 420);
  });

  registerBtn.addEventListener('click', function () {
    var label = input.value.trim().toLowerCase();
    if (!label || label.length < 3) return;
    registerBtn.disabled = true;
    registerBtn.textContent = 'REGISTERING\u2026';

    registerSubname(label)
      .then(function () {
        /* Phase 6B: sets STATE.ensSubname → state:ensSubname fires → re-render */
      })
      .catch(function () {
        registerBtn.disabled = false;
        registerBtn.textContent = 'REGISTER';
        var form = document.getElementById('wsh-claim-form');
        if (form) {
          form.classList.add('wsh-shake');
          setTimeout(function () { form.classList.remove('wsh-shake'); }, 400);
        }
        if (typeof showToast === 'function') {
          showToast('Registration failed. Try again.', 'err');
        }
      });
  });
}

/* ── Address section ─────────────────────────────────────────── */

function _renderAddress(el) {
  el.innerHTML =
    '<span class="wsh-label">Address</span>' +
    '<div class="wsh-address-row">' +
      '<span class="wsh-full-addr" title="' + _esc(STATE.wallet) + '">' +
        _esc(_truncate10x8(STATE.wallet)) +
      '</span>' +
      '<button class="btn wsh-copy-btn" id="wsh-copy-btn" aria-label="Copy full address">COPY</button>' +
    '</div>';

  var copyBtn = document.getElementById('wsh-copy-btn');
  if (!copyBtn) return;

  copyBtn.addEventListener('click', function () {
    var addr = STATE.wallet;
    var flash = function () {
      copyBtn.textContent = 'COPIED';
      copyBtn.classList.add('copied');
      setTimeout(function () {
        copyBtn.textContent = 'COPY';
        copyBtn.classList.remove('copied');
      }, 1800);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(addr).then(flash).catch(function () {
        _copyFallback(addr);
        flash();
      });
    } else {
      _copyFallback(addr);
      flash();
    }
  });
}

function _copyFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-999px;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
}

/* ── Trades section (State C) ────────────────────────────────── */

function _renderTrades(el) {
  var recent = STATE.trades.slice(-3).reverse();

  var rows = recent.map(function (t) {
    var from   = _esc((t.fromSymbol || '?').toUpperCase());
    var to     = _esc((t.toSymbol   || '?').toUpperCase());
    var pair   = from + ' \u2192 ' + to;
    var amount = t.fromAmount ? _esc(t.fromAmount + ' ' + (t.fromSymbol || '').toUpperCase()) : '';
    var time   = t.timestamp  ? _esc(_relTime(t.timestamp)) : '';
    var link   = (t.txHash)
      ? '<a class="wsh-trade-link" href="' + _esc(_explorerUrl(t.txHash)) + '" ' +
          'target="_blank" rel="noopener noreferrer" aria-label="View on explorer">\u2197</a>'
      : '';

    return (
      '<div class="wsh-trade-row">' +
        '<span class="wsh-trade-pair">' + pair + '</span>' +
        (amount ? '<span class="wsh-trade-amount">' + amount + '</span>' : '') +
        '<span class="wsh-trade-time">' + time + '</span>' +
        link +
      '</div>'
    );
  }).join('');

  el.innerHTML =
    '<span class="wsh-label">Recent Trades</span>' +
    '<div>' + rows + '</div>' +
    '<button class="btn wsh-view-all-btn" id="wsh-view-all">VIEW ALL \u2192</button>';

  var viewAll = document.getElementById('wsh-view-all');
  if (viewAll) {
    viewAll.addEventListener('click', function () {
      closeWalletSheet();
      if (window.innerWidth >= 768) {
        setState({ view: 'markets', rightPanel: 'history' });
      } else {
        setState({ prevMobileView: STATE.mobileView || 'markets', mobileView: 'history' });
      }
    });
  }
}

/* ── Network section ─────────────────────────────────────────── */

function _renderNetwork(el) {
  var id        = STATE.network;
  var name      = NETWORK_NAMES[id] || (id ? 'Chain ' + id : 'Unknown');
  var defId     = STATE.settings && STATE.settings.defaultNetwork;
  var mismatch  = id && defId && (id !== defId);
  var dotClass  = mismatch ? 'wsh-net-dot warn' : 'wsh-net-dot ok';
  var nameClass = mismatch ? 'wsh-net-name warn' : 'wsh-net-name';

  el.innerHTML =
    '<span class="wsh-label">Network</span>' +
    '<div class="wsh-network-row">' +
      '<div class="wsh-network-left">' +
        '<span class="' + dotClass + '"></span>' +
        '<span class="' + nameClass + '">' + _esc(name) + '</span>' +
      '</div>' +
      (mismatch
        ? '<button class="wsh-switch-btn" id="wsh-switch-btn">SWITCH</button>'
        : '') +
    '</div>';

  if (mismatch) {
    var switchBtn = document.getElementById('wsh-switch-btn');
    if (switchBtn && window.privyProvider && typeof window.privyProvider.request === 'function') {
      switchBtn.addEventListener('click', function () {
        switchBtn.disabled = true;
        window.privyProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + defId.toString(16) }],
        }).catch(function (err) {
          switchBtn.disabled = false;
          if (typeof showToast === 'function') {
            var msg = (err && err.code === 4902)
              ? 'Add this network to your wallet first.'
              : 'Could not switch network.';
            showToast(msg, 'err');
          }
        });
      });
    }
  }
}

/* ── Connected via section ───────────────────────────────────── */

function _renderVia(el) {
  el.innerHTML =
    '<span class="wsh-label">Connected via</span>' +
    '<div class="wsh-via-row">' +
      '<span class="wsh-via-dot" aria-hidden="true"></span>' +
      '<span class="wsh-via-name">Privy</span>' +
    '</div>';
}

/* ═══════════════════════════════════════
   DISCONNECT CONFIRM
═══════════════════════════════════════ */

function _resetDisconnectBtn() {
  var btn = document.getElementById('wallet-sheet-disconnect');
  if (!btn) return;
  clearTimeout(_disconnectTimer);
  btn.textContent     = 'DISCONNECT WALLET';
  btn.dataset.confirm = 'false';
  btn.classList.remove('confirming');
}

function _handleDisconnectClick() {
  var btn = document.getElementById('wallet-sheet-disconnect');
  if (!btn) return;

  if (btn.dataset.confirm !== 'true') {
    btn.textContent     = 'CONFIRM DISCONNECT';
    btn.dataset.confirm = 'true';
    btn.classList.add('confirming');
    _disconnectTimer = setTimeout(_resetDisconnectBtn, 2000);
  } else {
    clearTimeout(_disconnectTimer);
    disconnect();
  }
}

/* ═══════════════════════════════════════
   ENS RESOLUTION — STUBS (Phase 6B)
═══════════════════════════════════════ */

async function resolveENS(address) { void address; }

async function checkSubnameAvailable(label) {
  void label;
  return false;
}

async function registerSubname(label) {
  void label;
  throw new Error('registerSubname: Phase 6B not yet implemented');
}

/* ═══════════════════════════════════════
   PROVIDER EVENTS
═══════════════════════════════════════ */

function wireProviderEvents(provider) {
  if (!provider || typeof provider.on !== 'function') return;

  provider.on('accountsChanged', function (accounts) {
    if (!accounts || !accounts.length) {
      window.privyProvider = null;
      setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
    } else {
      setState({ wallet: accounts[0], ens: null, ensSubname: null });
      resolveENS(accounts[0]);
    }
  });

  provider.on('chainChanged', function (chainId) {
    setState({ network: parseInt(chainId, 16) });
    document.dispatchEvent(new CustomEvent('network:changed'));
  });

  provider.on('disconnect', function () {
    if (STATE.connected) {
      window.privyProvider = null;
      setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
    }
  });
}

/* ═══════════════════════════════════════
   PRIVY MICRO-ISLAND
═══════════════════════════════════════ */

function _buildPrivyBridge(useEffect, usePrivy, useWallets) {
  return function PrivyBridge() {
    var p = usePrivy();
    var w = useWallets();

    var ready         = p.ready;
    var authenticated = p.authenticated;
    var user          = p.user;
    var login         = p.login;
    var logout        = p.logout;
    var wallets       = w.wallets;

    var primaryWallet = (authenticated && wallets && wallets.length)
      ? (wallets.find(function (wlt) { return wlt.walletClientType !== 'privy'; }) || wallets[0])
      : null;
    var primaryAddr = primaryWallet ? primaryWallet.address : null;

    useEffect(function () {
      window._privyBridge = {
        login: login, logout: logout,
        ready: ready, authenticated: authenticated, user: user,
      };
      if (ready) _privyReadyResolve();
    });

    useEffect(function () {
      if (!ready || !primaryAddr || !primaryWallet) return;
      var alive = true;

      primaryWallet.getEthereumProvider()
        .then(function (provider) {
          if (!alive) return;
          window.privyProvider = provider;
          return Promise.all([
            provider.request({ method: 'eth_accounts' }),
            provider.request({ method: 'eth_chainId'  }),
          ]);
        })
        .then(function (res) {
          if (!alive || !res) return;
          var accounts = res[0];
          var chainId  = res[1];
          if (!accounts || !accounts.length) return;
          setState({ wallet: accounts[0], connected: true, network: parseInt(chainId, 16) });
          resolveENS(accounts[0]);
          wireProviderEvents(window.privyProvider);
        })
        .catch(function (err) {
          if (!alive) return;
          console.error('[OBSIDEUM wallet] Provider init failed:', err);
          if (typeof showToast === 'function') showToast('Could not access wallet. Try reconnecting.', 'err');
        });

      return function () { alive = false; };
    }, [ready, primaryAddr]);

    useEffect(function () {
      if (!ready) return;
      if (!authenticated) {
        window.privyProvider = null;
        if (STATE.connected) setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
      }
    }, [ready, authenticated]);

    return null;
  };
}

async function initPrivy() {
  if (_privyInitialized) return;
  _privyInitialized = true;

  try {
    var reactMod    = await import('https://esm.sh/react@18');
    var reactDomMod = await import('https://esm.sh/react-dom@18/client');
    var privyMod    = await import('https://esm.sh/@privy-io/react-auth@2?deps=react@18,react-dom@18');

    var React         = reactMod.default;
    var useEffect     = reactMod.useEffect;
    var createRoot    = reactDomMod.createRoot;
    var PrivyProvider = privyMod.PrivyProvider;
    var usePrivy      = privyMod.usePrivy;
    var useWallets    = privyMod.useWallets;

    var PrivyBridge = _buildPrivyBridge(useEffect, usePrivy, useWallets);

    var container = document.createElement('div');
    container.id = 'privy-root';
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText = 'display:none!important;position:absolute;pointer-events:none;';
    document.body.appendChild(container);

    createRoot(container).render(
      React.createElement(
        PrivyProvider,
        { appId: PRIVY_APP_ID, config: PRIVY_CONFIG },
        React.createElement(PrivyBridge, null)
      )
    );
  } catch (err) {
    console.error('[OBSIDEUM wallet] Privy SDK load failed:', err);
    if (typeof showToast === 'function') showToast('Wallet service unavailable. Please refresh.', 'err');
  }
}

/* ═══════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════ */

async function checkExistingConnection() {
  await initPrivy();
}

async function connect() {
  await _privyReady;
  if (!window._privyBridge) {
    if (typeof showToast === 'function') showToast('Wallet service not ready. Please try again.', 'err');
    return;
  }
  try {
    await window._privyBridge.login();
  } catch (err) {
    var msg = (err && err.message) ? err.message.toLowerCase() : '';
    if (!msg.includes('cancel') && !msg.includes('reject') && !msg.includes('close') && !msg.includes('dismiss')) {
      console.error('[OBSIDEUM wallet] Login error:', err);
      if (typeof showToast === 'function') showToast('Connection failed. Please try again.', 'err');
    }
  }
}

async function disconnect() {
  closeWalletSheet();
  if (!window._privyBridge) { window.location.href = 'index.html'; return; }
  try {
    await window._privyBridge.logout();
  } catch (err) {
    console.error('[OBSIDEUM wallet] Logout error:', err);
    window.privyProvider = null;
    setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
  } finally {
    window.location.href = 'index.html';
  }
}

/* ═══════════════════════════════════════
   STATE EVENT LISTENERS
═══════════════════════════════════════ */

function _sheetIsOpen() {
  var s = document.getElementById('wallet-sheet');
  return !!(s && !s.hidden);
}

document.addEventListener('state:wallet',     function () { updateMobilePill(); if (_sheetIsOpen()) renderWalletSheet(); });
document.addEventListener('state:ens',        function () { updateMobilePill(); if (_sheetIsOpen()) renderWalletSheet(); });
document.addEventListener('state:ensSubname', function () { updateMobilePill(); if (_sheetIsOpen()) renderWalletSheet(); });
document.addEventListener('state:connected',  function () { updateMobilePill(); });
document.addEventListener('state:network',    function () { if (_sheetIsOpen()) renderWalletSheet(); });

/* ═══════════════════════════════════════
   CLICK WIRING
═══════════════════════════════════════ */

(function wireClicks() {
  var sidebarBlock = document.querySelector('.sidebar-wallet-block');
  if (sidebarBlock) {
    sidebarBlock.style.cursor = 'pointer';
    sidebarBlock.setAttribute('tabindex', '0');
    sidebarBlock.setAttribute('role', 'button');
    sidebarBlock.setAttribute('aria-label', 'Open wallet');
    sidebarBlock.setAttribute('aria-haspopup', 'dialog');
    sidebarBlock.addEventListener('click', openWalletSheet);
    sidebarBlock.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWalletSheet(); }
    });
  }

  var mobileBtn = document.getElementById('mobile-wallet-btn');
  if (mobileBtn) mobileBtn.addEventListener('click', openWalletSheet);

  var overlay = document.getElementById('wallet-sheet-overlay');
  if (overlay) overlay.addEventListener('click', closeWalletSheet);

  var disconnBtn = document.getElementById('wallet-sheet-disconnect');
  if (disconnBtn) disconnBtn.addEventListener('click', _handleDisconnectClick);
}());

/* ═══════════════════════════════════════
   SWIPE-TO-DISMISS
═══════════════════════════════════════ */

(function wireSwipe() {
  var sheet = document.getElementById('wallet-sheet');
  if (!sheet) return;

  var _t = null;

  sheet.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    _t = { y: t.clientY, time: Date.now() };
  }, { passive: true });

  sheet.addEventListener('touchend', function (e) {
    if (!_t) return;
    var t   = e.changedTouches[0];
    var dy  = t.clientY - _t.y;
    var dt  = Math.max(1, Date.now() - _t.time);
    var vel = dy / dt;
    _t = null;
    if (dy > 80 || (dy > 24 && vel > 0.5)) closeWalletSheet();
  }, { passive: true });
}());
