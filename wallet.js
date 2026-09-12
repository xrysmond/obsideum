/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — wallet.js
   Phase 6A: Privy connection · session persistence · provider.
   Phase 6C: Wallet bottom sheet — three states, ENS claim
             form, recent trades, network switch, copy address.
   Phase 6B: ENS + ENSv2 registration (stubs here).
   Phase 9G: Accounts tab — mobile + desktop.
   Phase 10A: Multi-wallet — STATE.activeWallet persisted +
              restored. Clamped to live wallets array on init.

   Architecture: micro-island React pattern.
   Invisible React root wraps PrivyProvider, bridges auth state
   to window._privyBridge. No React elsewhere.

   Provider contract:
     window.privyProvider — EIP-1193.
     swap.js: new ethers.providers.Web3Provider(window.privyProvider)

   DOM ownership:
     2C wiring  → desktop sidebar wallet/network text updates
     wallet.js  → mobile pill · wallet sheet · accounts tab · sidebar click

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
  loginMethods: ['email', 'google', 'twitter', 'wallet'],
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

var EXPLORER_URLS = {
  1:        'https://etherscan.io/tx/',
  42161:    'https://arbiscan.io/tx/',
  8453:     'https://basescan.org/tx/',
  10:       'https://optimistic.etherscan.io/tx/',
  11155111: 'https://sepolia.etherscan.io/tx/',
};

/* ═══════════════════════════════════════
   GLOBALS
═══════════════════════════════════════ */

window.privyProvider  = null;
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
  if (STATE.wallet)     return _t6x4(STATE.wallet);
  return null;
}

/* 0x74f3…3aB2 */
function _t6x4(addr) {
  return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
}

/* 0x74f3a1b2…c9d8e7f6 — longer for address section */
function _t10x8(addr) {
  return addr ? addr.slice(0, 10) + '\u2026' + addr.slice(-8) : '';
}

function _relTime(ts) {
  var d  = Date.now() - ts;
  var m  = Math.floor(d / 60000);
  var h  = Math.floor(d / 3600000);
  var dy = Math.floor(d / 86400000);
  if (m  < 1)  return 'just now';
  if (m  < 60) return m + 'm ago';
  if (h  < 24) return h + 'h ago';
  if (dy < 7)  return dy + 'd ago';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _explorerUrl(hash) {
  return (EXPLORER_URLS[STATE.network] || 'https://etherscan.io/tx/') + hash;
}

/* Every user-derived string passes through _esc */
function _esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════
   BUTTON HTML
   core.css requires: btn > btn-pulse-ring + btn-inner > glass-sheen + span
   Every CTA uses this structure — without it, btn-primary and btn-warn
   have NO visual styling (border/bg are on .btn-inner, not .btn).
═══════════════════════════════════════ */

function _btnPrimary(id, label) {
  return (
    '<button class="btn btn-primary btn-full"' + (id ? ' id="' + id + '"' : '') + '>' +
      '<div class="btn-pulse-ring"></div>' +
      '<div class="btn-inner">' +
        '<div class="glass-sheen"></div>' +
        '<span>' + label + '</span>' +
      '</div>' +
    '</button>'
  );
}

function _btnWhite(id, label) {
  return (
    '<button class="btn btn-white"' + (id ? ' id="' + id + '"' : '') + '>' +
      '<div class="btn-pulse-ring"></div>' +
      '<div class="btn-inner">' +
        '<div class="glass-sheen"></div>' +
        '<span>' + label + '</span>' +
      '</div>' +
    '</button>'
  );
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
  label.textContent = getIdentityLabel() || _t6x4(STATE.wallet);
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
    _resetDisconnect();
  }, 320);
}

/* ═══════════════════════════════════════
   WALLET SHEET — RENDER
   State A — not connected
   State B — connected, no ENSv2 subname
   State C — connected + ENSv2 subname
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
    _renderA(sIdentity, sAddress, sTrades, sNetwork, sVia, sDisconn);
    return;
  }

  _renderConnected(sIdentity, sAddress, sTrades, sNetwork, sVia, sDisconn);
}

/* ── State A — not connected ─────────────────────────────────── */

function _renderA(sI, sA, sT, sN, sV, sD) {
  sI.innerHTML =
    '<div class="wsh-connect-section">' +
      '<span class="wsh-connect-eyebrow">Connect your wallet</span>' +
      _btnPrimary('wsh-connect-btn', 'CONNECT WALLET') +
    '</div>';

  sA.hidden = true;
  sT.hidden = true;
  sN.hidden = true;
  sV.hidden = true;
  if (sD) sD.hidden = true;

  var btn = document.getElementById('wsh-connect-btn');
  if (btn) {
    btn.addEventListener('click', function () {
      closeWalletSheet();
      connect();
    });
  }
}

/* ── States B + C ────────────────────────────────────────────── */

function _renderConnected(sI, sA, sT, sN, sV, sD) {
  var hasSubname = !!STATE.ensSubname;
  var hasTrades  = !!(STATE.trades && STATE.trades.length);

  _renderIdentity(sI, hasSubname);

  _renderAddress(sA);
  sA.hidden = false;

  if (hasSubname && hasTrades) {
    _renderTrades(sT);
    sT.hidden = false;
  } else {
    sT.hidden = true;
  }

  _renderNetwork(sN);
  sN.hidden = false;

  _renderVia(sV);
  sV.hidden = false;

  if (sD) sD.hidden = false;
}

/* ── Identity ────────────────────────────────────────────────── */

function _renderIdentity(el, hasSubname) {
  if (hasSubname) {
    el.innerHTML =
      '<span class="wsh-label">Identity</span>' +
      '<div class="wsh-subname">' + _esc(STATE.ensSubname) + '</div>' +
      '<div class="wsh-subname-note">Registered &middot; Sepolia testnet</div>';
    return;
  }

  var ident = STATE.ens
    ? '<div class="wsh-id-addr">' + _esc(STATE.ens) + '</div>'
    : '<div class="wsh-id-addr">' + _esc(_t6x4(STATE.wallet)) + '</div>';

  el.innerHTML =
    '<span class="wsh-label">Identity</span>' +
    ident +
    '<button class="wsh-claim-prompt" id="wsh-claim-btn" aria-expanded="false">' +
      '<span class="wsh-claim-arrow" aria-hidden="true">\u203a</span>' +
      '<span>Claim your obsideum.eth identity</span>' +
    '</button>' +
    '<div id="wsh-claim-form" hidden></div>';

  _wireClaimPrompt();
}

function _wireClaimPrompt() {
  var btn  = document.getElementById('wsh-claim-btn');
  var form = document.getElementById('wsh-claim-form');
  if (!btn || !form) return;

  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') === 'true';
    if (!open) {
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('expanded');
      form.hidden = false;
      form.innerHTML = _claimFormHTML();
      _wireClaimForm();
    } else {
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('expanded');
      form.hidden = true;
      clearTimeout(_claimDebounce);
    }
  });
}

function _claimFormHTML() {
  return (
    '<div class="wsh-claim-form">' +
      '<div class="wsh-ens-row">' +
        '<input class="wsh-ens-input" id="wsh-ens-input" type="text" ' +
          'placeholder="yourname" maxlength="32" ' +
          'autocomplete="off" autocorrect="off" autocapitalize="none" ' +
          'spellcheck="false" inputmode="url">' +
        '<span class="wsh-ens-suffix">.obsideum.eth</span>' +
      '</div>' +
      '<div class="wsh-ens-status" id="wsh-ens-status" role="status" aria-live="polite"></div>' +
      _btnPrimary('wsh-register-btn', 'REGISTER') +
    '</div>'
  );
}

function _wireClaimForm() {
  var input  = document.getElementById('wsh-ens-input');
  var status = document.getElementById('wsh-ens-status');
  var regBtn = document.getElementById('wsh-register-btn');
  if (!input || !status || !regBtn) return;

  regBtn.hidden = true;
  setTimeout(function () { input.focus(); }, 80);

  input.addEventListener('input', function () {
    clearTimeout(_claimDebounce);
    var raw = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (input.value !== raw) input.value = raw;

    status.textContent = '';
    status.className   = 'wsh-ens-status';
    regBtn.hidden = true;

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
        .then(function (ok) {
          if (input.value !== raw) return;
          if (ok) {
            status.textContent = '\u2713 Available';
            status.className   = 'wsh-ens-status available';
            regBtn.hidden = false;
            regBtn.disabled = false;
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

  regBtn.addEventListener('click', function () {
    var label = input.value.trim().toLowerCase();
    if (!label || label.length < 3) return;
    regBtn.disabled = true;
    var s = regBtn.querySelector('span');
    if (s) s.textContent = 'REGISTERING\u2026';

    registerSubname(label).then(function () {
      /* Phase 6B sets STATE.ensSubname → re-render */
    }).catch(function () {
      regBtn.disabled = false;
      if (s) s.textContent = 'REGISTER';
      var f = document.getElementById('wsh-claim-form');
      if (f) {
        f.classList.add('wsh-shake');
        setTimeout(function () { f.classList.remove('wsh-shake'); }, 400);
      }
      if (typeof showToast === 'function') showToast('Registration failed. Try again.', 'terr');
    });
  });
}

/* ── Address ─────────────────────────────────────────────────── */

function _renderAddress(el) {
  el.innerHTML =
    '<span class="wsh-label">Address</span>' +
    '<div class="wsh-address-row">' +
      '<span class="wsh-full-addr" title="' + _esc(STATE.wallet) + '">' +
        _esc(_t10x8(STATE.wallet)) +
      '</span>' +
      '<button class="wsh-copy-btn" id="wsh-copy-btn" aria-label="Copy full address">COPY</button>' +
    '</div>';

  var btn = document.getElementById('wsh-copy-btn');
  if (!btn) return;

  btn.addEventListener('click', function () {
    var flash = function () {
      btn.textContent = 'COPIED';
      btn.classList.add('copied');
      setTimeout(function () {
        btn.textContent = 'COPY';
        btn.classList.remove('copied');
      }, 1800);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(STATE.wallet).then(flash).catch(function () {
        _clipFallback(STATE.wallet); flash();
      });
    } else {
      _clipFallback(STATE.wallet); flash();
    }
  });
}

function _clipFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-999px;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
}

/* ── Trades (State C) ────────────────────────────────────────── */

function _renderTrades(el) {
  var recent = STATE.trades.slice(-3).reverse();

  var rows = recent.map(function (t) {
    var from   = _esc((t.fromSymbol || '?').toUpperCase());
    var to     = _esc((t.toSymbol   || '?').toUpperCase());
    var amount = t.fromAmount
      ? _esc(t.fromAmount + '\u00a0' + (t.fromSymbol || '').toUpperCase())
      : '';
    var time = t.timestamp ? _esc(_relTime(t.timestamp)) : '';
    var link = t.txHash
      ? '<a class="wsh-trade-link" href="' + _esc(_explorerUrl(t.txHash)) + '" ' +
          'target="_blank" rel="noopener noreferrer" aria-label="View on explorer">\u2197</a>'
      : '';

    return (
      '<div class="wsh-trade-row">' +
        '<span class="wsh-trade-pair">' + from + '\u00a0\u2192\u00a0' + to + '</span>' +
        (amount ? '<span class="wsh-trade-amount">' + amount + '</span>' : '') +
        '<span class="wsh-trade-time">' + time + '</span>' +
        link +
      '</div>'
    );
  }).join('');

  el.innerHTML =
    '<span class="wsh-label">Recent Trades</span>' +
    '<div>' + rows + '</div>' +
    '<button class="wsh-view-all-btn" id="wsh-view-all">VIEW ALL \u2192</button>';

  var va = document.getElementById('wsh-view-all');
  if (va) {
    va.addEventListener('click', function () {
      closeWalletSheet();
      if (window.innerWidth >= 768) {
        setState({ view: 'markets', rightPanel: 'history' });
      } else {
        setState({ prevMobileView: STATE.mobileView || 'markets', mobileView: 'history' });
      }
    });
  }
}

/* ── Network ─────────────────────────────────────────────────── */

function _renderNetwork(el) {
  var id       = STATE.network;
  var name     = NETWORK_NAMES[id] || (id ? 'Chain ' + id : 'Unknown');
  var defId    = STATE.settings && STATE.settings.defaultNetwork;
  var mismatch = !!(id && defId && id !== defId);
  var dotCls   = mismatch ? 'wsh-net-dot warn' : 'wsh-net-dot ok';
  var nameCls  = mismatch ? 'wsh-net-name warn' : 'wsh-net-name';

  el.innerHTML =
    '<span class="wsh-label">Network</span>' +
    '<div class="wsh-network-row">' +
      '<div class="wsh-network-left">' +
        '<span class="' + dotCls + '"></span>' +
        '<span class="' + nameCls + '">' + _esc(name) + '</span>' +
      '</div>' +
      (mismatch
        ? '<button class="wsh-switch-btn" id="wsh-switch-btn">SWITCH</button>'
        : '') +
    '</div>';

  if (mismatch) {
    var sb = document.getElementById('wsh-switch-btn');
    if (sb && window.privyProvider && typeof window.privyProvider.request === 'function') {
      sb.addEventListener('click', function () {
        sb.disabled = true;
        window.privyProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x' + defId.toString(16) }],
        }).catch(function (err) {
          sb.disabled = false;
          if (typeof showToast === 'function') {
            showToast(
              (err && err.code === 4902)
                ? 'Add this network to your wallet first.'
                : 'Could not switch network.',
              'terr'
            );
          }
        });
      });
    }
  }
}

/* ── Connected via ───────────────────────────────────────────── */

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
   .confirm on .btn → core.css overrides .btn-inner
   to red border + color.
   Text is in #wsh-disconnect-text span inside btn-inner.
═══════════════════════════════════════ */

function _resetDisconnect() {
  var btn  = document.getElementById('wallet-sheet-disconnect');
  var text = document.getElementById('wsh-disconnect-text');
  if (!btn) return;
  clearTimeout(_disconnectTimer);
  btn.dataset.confirm = 'false';
  btn.classList.remove('confirm');
  if (text) text.textContent = 'DISCONNECT WALLET';
}

function _handleDisconnectClick() {
  var btn  = document.getElementById('wallet-sheet-disconnect');
  var text = document.getElementById('wsh-disconnect-text');
  if (!btn) return;

  if (btn.dataset.confirm !== 'true') {
    btn.dataset.confirm = 'true';
    btn.classList.add('confirm');
    if (text) text.textContent = 'CONFIRM DISCONNECT';
    _disconnectTimer = setTimeout(_resetDisconnect, 2000);
  } else {
    clearTimeout(_disconnectTimer);
    disconnect();
  }
}

/* ═══════════════════════════════════════
   ENS — STUBS (Phase 6B)
═══════════════════════════════════════ */

async function resolveENS(address)          { void address; }
async function checkSubnameAvailable(label) { void label; return false; }
async function registerSubname(label)       { void label; throw new Error('Phase 6B'); }

/* ═══════════════════════════════════════
   PROVIDER EVENTS
═══════════════════════════════════════ */

function wireProviderEvents(provider) {
  if (!provider || typeof provider.on !== 'function') return;
  /* Guard: each provider instance only gets wired once.
   * _buildPrivyBridge's useEffect re-runs on every render — without this,
   * every re-render stacks a new set of accountsChanged / chainChanged /
   * disconnect handlers on the same provider object. */
  if (provider._obsideumWired) return;
  provider._obsideumWired = true;

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
    /* EIP-1193 disconnect fires on network switches and when mobile browsers
     * background the tab — it is NOT a reliable signal that the Privy session
     * ended. Nulling the cached provider forces the next getSigner() call to
     * re-fetch it, but STATE.connected is owned by Privy's authenticated flag
     * only. Clearing it here caused the auto-disconnect bug. */
    window.privyProvider = null;
  });
}

/* ═══════════════════════════════════════
   PRIVY MICRO-ISLAND
   Invisible React root bridges Privy's hooks
   to window._privyBridge for vanilla JS use.

   Exposed on _privyBridge:
     login()      — opens Privy auth modal (all methods)
     logout()     — clears session
     linkWallet() — connector picker without re-auth (use for ADD WALLET)
     linkGoogle() — link Google account to existing Privy user
     linkTwitter()— link Twitter account to existing Privy user
     linkEmail()  — link email to existing Privy user
═══════════════════════════════════════ */

function _buildPrivyBridge(useEffect, usePrivy, useWallets) {
  return function PrivyBridge() {
    var p = usePrivy();
    var w = useWallets();

    var ready = p.ready, authenticated = p.authenticated;
    var user  = p.user,  login = p.login, logout = p.logout;
    var wallets = w.wallets;

    /* Prefer external wallet (MetaMask/Brave) over Privy embedded */
    var primaryWallet = (authenticated && wallets && wallets.length)
      ? (wallets.find(function (wlt) { return wlt.walletClientType !== 'privy'; }) || wallets[0])
      : null;
    var primaryAddr = primaryWallet ? primaryWallet.address : null;

    /* Expose bridge every render — keeps all method refs fresh.
     * Link methods require an authenticated session — Privy handles the guard. */
    useEffect(function () {
      window._privyBridge = {
        login:         login,
        logout:        logout,
        ready:         ready,
        authenticated: authenticated,
        user:          user,
        /* initOAuth — triggers a full-page redirect to the OAuth provider.
         * No popup; works on Brave/mobile. Call: initOAuth({ provider: 'google' }) */
        initOAuth:     p.initOAuth,
        /* Link methods — use when user is already authenticated */
        linkWallet:    p.linkWallet,
        linkGoogle:    p.linkGoogle,
        linkTwitter:   p.linkTwitter,
        linkEmail:     p.linkEmail,
      };
      if (ready) _privyReadyResolve();
    });

    /* Provider init on connect / account switch */
    useEffect(function () {
      if (!ready || !primaryAddr || !primaryWallet) return;
      var alive = true;

      primaryWallet.getEthereumProvider()
        .then(function (provider) {
          if (!alive) return;
          /* For external (injected) wallets — Brave, MetaMask, etc. —
           * Privy returns a wrapped proxy of the wallet's EIP-1193 provider.
           * On Android, this wrapper swallows eth_sendTransaction before it
           * reaches the wallet's native confirmation UI. Use window.ethereum
           * directly so Brave Wallet's bottom sheet actually fires.
           * Embedded Privy wallets sign server-side and use their own
           * provider — leave those untouched. */
          var isExternal  = primaryWallet.walletClientType !== 'privy';
          var useProvider = (isExternal && window.ethereum) ? window.ethereum : provider;
          window.privyProvider = useProvider;
          return Promise.all([
            useProvider.request({ method: 'eth_accounts' }),
            useProvider.request({ method: 'eth_chainId'  }),
          ]);
        })
        .then(function (res) {
          if (!alive || !res) return;
          var accounts = res[0], chainId = res[1];
          if (!accounts || !accounts.length) return;
          setState({ wallet: accounts[0], connected: true, network: parseInt(chainId, 16) });
          resolveENS(accounts[0]);
          wireProviderEvents(window.privyProvider);
        })
        .catch(function (err) {
          if (!alive) return;
          console.error('[OBSIDEUM wallet] Provider init failed:', err);
          if (typeof showToast === 'function') {
            showToast('Could not access wallet. Try reconnecting.', 'terr');
          }
        });

      return function () { alive = false; };
    }, [ready, primaryAddr]);

    /* Logout detection */
    useEffect(function () {
      if (!ready) return;
      if (!authenticated) {
        window.privyProvider = null;
        if (STATE.connected) {
          setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
        }
      }
    }, [ready, authenticated]);

    /* Expose full wallets array. Clamp restored activeWallet index to actual range.
     * loadSettings() may have restored an index that is now OOB (wallet removed between
     * sessions). Clamp here — wallets.length is authoritative. */
    useEffect(function () {
      if (ready && wallets) {
        var savedIdx = (window.STATE && STATE.activeWallet) || 0;
        var validIdx = (savedIdx >= 0 && savedIdx < wallets.length) ? savedIdx : 0;
        setState({ wallets: wallets, activeWallet: validIdx });
      }
    }, [ready, wallets]);

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
    if (typeof showToast === 'function') {
      showToast('Wallet service unavailable. Please refresh.', 'terr');
    }
  }
}

/* ═══════════════════════════════════════
   OAUTH CALLBACK HANDLER
   Mirrors privy-io/examples oauth-login.js.
   PrivyProvider processes the redirect params automatically on mount —
   we just surface errors and clean the URL once it's done.
═══════════════════════════════════════ */

(function handleOAuthCallback() {
  var params    = new URLSearchParams(window.location.search);
  var code      = params.get('privy_oauth_code');
  var state     = params.get('privy_oauth_state');
  var provider  = params.get('privy_oauth_provider');
  var error     = params.get('privy_oauth_error') || params.get('error');
  var errDesc   = params.get('privy_oauth_error_description') || params.get('error_description');

  if (error) {
    _privyReady.then(function () {
      if (typeof showToast === 'function') {
        showToast('Login failed: ' + (errDesc || error), 'terr');
      }
    });
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }

  if (!code || !state || !provider) return;

  /* Callback params present — PrivyProvider will complete the OAuth flow
   * on mount. Once Privy is ready, clean the URL so a hard-reload doesn't
   * re-trigger the flow. */
  _privyReady.then(function () {
    window.history.replaceState({}, '', window.location.pathname);
  });
}());

/* ═══════════════════════════════════════
   SOCIAL LOGIN HELPERS
   Uses initOAuth for a full-page redirect — no popup, no block on Brave mobile.
   Exposed globally so wallet sheet buttons and any other UI can call them.
   Pattern copied directly from privy-io/examples oauth-login.js loginWithOAuth().
═══════════════════════════════════════ */

async function connectWithOAuth(provider) {
  await _privyReady;
  if (!window._privyBridge || typeof window._privyBridge.initOAuth !== 'function') {
    if (typeof showToast === 'function') showToast('Wallet service not ready. Try again.', 'terr');
    return;
  }
  try {
    await window._privyBridge.initOAuth({ provider: provider });
  } catch (err) {
    var msg = (err && err.message) ? err.message.toLowerCase() : '';
    if (!msg.includes('cancel') && !msg.includes('reject') &&
        !msg.includes('close')  && !msg.includes('dismiss')) {
      console.error('[OBSIDEUM wallet] OAuth error:', err);
      if (typeof showToast === 'function') showToast('Social login failed. Try again.', 'terr');
    }
  }
}

window.connectWithGoogle  = function () { return connectWithOAuth('google');  };
window.connectWithTwitter = function () { return connectWithOAuth('twitter'); };
window.connectWithOAuth   = connectWithOAuth;

/* ═══════════════════════════════════════
   VISIBILITY RE-VALIDATION  (Bug 3 — stale connected state)
   When the user switches back to the tab after Privy's session expires in
   the background, STATE.connected stays true but authenticated is false.
   This listener catches that mismatch and clears the stale state.
═══════════════════════════════════════ */

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (!window._privyBridge) return;
  if (window._privyBridge.authenticated === false && STATE.connected) {
    console.log('[OBSIDEUM wallet] Stale session detected on focus — clearing state.');
    window.privyProvider = null;
    setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
  }
});

/* ═══════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════ */

async function checkExistingConnection() {
  await initPrivy();
}

async function connect() {
  await _privyReady;
  if (!window._privyBridge) {
    if (typeof showToast === 'function') showToast('Wallet service not ready. Try again.', 'terr');
    return;
  }
  try {
    await window._privyBridge.login();
  } catch (err) {
    var msg = err && err.message ? err.message.toLowerCase() : '';
    if (!msg.includes('cancel') && !msg.includes('reject') &&
        !msg.includes('close')  && !msg.includes('dismiss')) {
      console.error('[OBSIDEUM wallet] Login error:', err);
      if (typeof showToast === 'function') showToast('Connection failed. Please try again.', 'terr');
    }
  }
}

async function disconnect() {
  closeWalletSheet();
  if (!window._privyBridge) {
    /* Bridge not ready — clear local state only. No redirect. */
    window.privyProvider = null;
    setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
    return;
  }
  try {
    await window._privyBridge.logout();
    /* Success — PrivyBridge's logout-detection useEffect fires,
     * sets authenticated=false, clears STATE. Nothing else needed. */
  } catch (err) {
    console.error('[OBSIDEUM wallet] Logout error:', err);
    window.privyProvider = null;
    setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
  }
  /* REMOVED: window.location.href = 'index.html' — this was the redirect bug.
   * auth-manager.js pattern: logout clears state only, never navigates. */
}

/* ═══════════════════════════════════════
   STATE EVENT LISTENERS
   2C owns desktop sidebar updates (state:wallet, state:ens, state:network).
   wallet.js owns mobile pill + sheet re-render + accounts tab.
═══════════════════════════════════════ */

function _sheetOpen() {
  var s = document.getElementById('wallet-sheet');
  return !!(s && !s.hidden);
}

document.addEventListener('state:wallet',     function () { updateMobilePill(); if (_sheetOpen()) renderWalletSheet(); });
document.addEventListener('state:ens',        function () { updateMobilePill(); if (_sheetOpen()) renderWalletSheet(); });
document.addEventListener('state:ensSubname', function () { updateMobilePill(); if (_sheetOpen()) renderWalletSheet(); });
document.addEventListener('state:connected',  function () { updateMobilePill(); });
document.addEventListener('state:network',    function () { if (_sheetOpen()) renderWalletSheet(); });

/* ── Accounts tab re-render triggers ───────────────────────────── */

/* Returns the currently-visible accounts container, or null */
function _getAccountsContainer() {
  if (window.innerWidth >= 768) {
    var d = document.getElementById('desktop-accounts');
    return (d && !d.hidden) ? d : null;
  }
  return (window.STATE && STATE.mobileTab === 'accounts')
    ? document.getElementById('mobile-accounts')
    : null;
}

/* Returns true when the accounts view is open on either breakpoint */
function _accountsOpen() {
  if (!window.STATE) return false;
  if (STATE.mobileTab === 'accounts') return true;
  var d = document.getElementById('desktop-accounts');
  return !!(d && !d.hidden);
}

/* Mobile — bottom nav switches to accounts */
document.addEventListener('state:mobileTab', function (e) {
  if (e.detail === 'accounts') {
    mountAccountsTab(document.getElementById('mobile-accounts'));
  }
});

/* Desktop — sidebar nav switches to accounts */
document.addEventListener('state:view', function (e) {
  if (e.detail === 'accounts') {
    mountAccountsTab(document.getElementById('desktop-accounts'));
  }
});

/* Wallet connected/switched — re-render whichever accounts view is open */
document.addEventListener('state:wallet', function () {
  var c = _getAccountsContainer();
  if (c) mountAccountsTab(c);
});

/* Wallets array changed (connect or disconnect) — re-render list immediately.
 * state:wallet fires first but uses stale STATE.wallets; this catches the
 * wallets-sync useEffect that fires a frame later with the real array. */
document.addEventListener('state:wallets', function () {
  if (_accountsOpen()) _renderWalletList();
});

/* ENS subname registered — refresh ENS section only */
document.addEventListener('state:ensSubname', function () {
  if (_accountsOpen()) _renderENSSection();
});

/* ═══════════════════════════════════════
   PHASE 9G — ACCOUNTS TAB
   mountAccountsTab() is the entry point.
   Called by Phase 8D (mobile) and app.html setDesktopView (desktop).
   Three sub-renders: wallet list, network toggles, ENS identity section.
═══════════════════════════════════════ */

var ACCOUNTS_CHAINS = [1, 10, 56, 130, 137, 8453, 42161, 43114];

var ACCOUNTS_CHAIN_NAMES = {
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
var ACCOUNTS_CHAIN_FOLDERS = {
  1:      'ethereum',
  10:     'optimism',
  56:     'smartchain',
  137:    'polygon',
  8453:   'base',
  42161:  'arbitrum',
  43114:  'avalanche',
};

function _chainLogoUrl(chainId) {
  var folder = ACCOUNTS_CHAIN_FOLDERS[chainId];
  if (!folder) return '';
  return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/' +
    folder + '/info/logo.png';
}

/* ── Wallet type icon SVG ───────────────────────────────────────── */

function _walletTypeIconSVG(walletClientType) {
  /* Privy embedded → shield icon. External → wallet icon. */
  if (!walletClientType || walletClientType === 'privy') {
    return (
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"' +
        ' stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M8 2L3 4.5v4c0 2.8 2.1 5.2 5 5.8 2.9-.6 5-3 5-5.8v-4L8 2z"/>' +
      '</svg>'
    );
  }
  /* External wallet */
  return (
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"' +
      ' stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="5" width="12" height="8" rx="1.5"/>' +
      '<path d="M5 5V4a3 3 0 016 0v1"/>' +
      '<circle cx="11" cy="9" r="1" fill="currentColor" stroke="none"/>' +
    '</svg>'
  );
}

/* ── Wallet card HTML ───────────────────────────────────────────── */

function _walletCardHTML(wallet, index, isActive) {
  var addr         = wallet.address || '';
  var clientType   = wallet.walletClientType || 'privy';
  var typeLabel    = clientType === 'privy' ? 'Privy · Embedded' : clientType.charAt(0).toUpperCase() + clientType.slice(1);
  var displayIdent = (isActive && STATE.ens) ? _esc(STATE.ens) : '';
  var activeNetworks = (STATE.settings && STATE.settings.activeNetworks) || [];

  /* Network badges — show chain logos for active networks */
  var badges = activeNetworks.slice(0, 6).map(function (chainId) {
    var logo = _chainLogoUrl(chainId);
    var name = ACCOUNTS_CHAIN_NAMES[chainId] || ('Chain ' + chainId);
    return logo
      ? '<img class="accounts-network-badge" src="' + logo + '" alt="' + _esc(name) + '">'
      : '';
  }).join('');

  /* Active card: tappable — opens wallet sheet to view address, disconnect, etc.
   * Inactive card: USE button switches the active wallet. */
  var trailing = isActive
    ? '<span class="accounts-wallet-active-label">ACTIVE\u00a0<span class="accounts-wallet-chevron" aria-hidden="true">\u203a</span></span>'
    : '<button class="accounts-use-btn" data-wallet-index="' + index + '"' +
        ' aria-label="Switch to wallet ' + _esc(_t6x4(addr)) + '">USE</button>';

  return (
    '<div class="accounts-wallet-card' + (isActive ? ' active' : '') + '"' +
      (isActive
        ? ' role="button" tabindex="0" aria-label="Open wallet details — ' + _esc(_t6x4(addr)) + '"'
        : '') +
      ' data-wallet-index="' + index + '">' +
      '<div class="accounts-wallet-type-icon">' +
        _walletTypeIconSVG(clientType) +
      '</div>' +
      '<div class="accounts-wallet-info">' +
        (displayIdent
          ? '<span class="accounts-wallet-ens">' + displayIdent + '</span>'
          : '') +
        '<span class="accounts-wallet-addr">' + _esc(_t6x4(addr)) + '</span>' +
        '<span class="accounts-wallet-type">' + _esc(typeLabel) + '</span>' +
        (badges
          ? '<div class="accounts-wallet-networks">' + badges + '</div>'
          : '') +
      '</div>' +
      trailing +
    '</div>'
  );
}

/* ── Render wallet list ─────────────────────────────────────────── */

function _renderWalletList() {
  var container = document.getElementById('accounts-wallet-list');
  if (!container) return;

  var wallets   = STATE.wallets && STATE.wallets.length ? STATE.wallets : null;
  var activeIdx = STATE.activeWallet || 0;

  /* No Privy wallets array yet — fall back to STATE.wallet single-wallet */
  if (!wallets) {
    if (!STATE.wallet) {
      container.innerHTML =
        '<div class="accounts-empty-state">No wallets connected.</div>';
      return;
    }
    container.innerHTML = _walletCardHTML(
      { address: STATE.wallet, walletClientType: 'privy' },
      0,
      true
    );
  } else {
    container.innerHTML = wallets.map(function (wallet, i) {
      return _walletCardHTML(wallet, i, i === activeIdx);
    }).join('');

    /* Wire USE buttons on inactive cards */
    container.querySelectorAll('.accounts-use-btn[data-wallet-index]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-wallet-index'));
        _setActiveWallet(idx);
      });
    });
  }

  /* Active card tap → open wallet sheet (address, copy, disconnect) */
  container.querySelectorAll('.accounts-wallet-card.active').forEach(function (card) {
    card.addEventListener('click', openWalletSheet);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWalletSheet(); }
    });
  });
}

/* ── Set active wallet ──────────────────────────────────────────── */

function _setActiveWallet(index) {
  var wallets = STATE.wallets;
  if (!wallets || !wallets[index]) return;

  setState({ activeWallet: index });

  /* Persist so the active wallet survives a page reload */
  try { localStorage.setItem('obsideum:activeWallet', String(index)); } catch (_) {}

  var wallet    = wallets[index];
  var _provider = null;

  wallet.getEthereumProvider()
    .then(function (provider) {
      /* Mirror the same external-wallet preference as _buildPrivyBridge:
       * use window.ethereum directly for injected wallets so the native
       * confirmation UI (Brave bottom sheet, MetaMask modal) is triggered
       * when swap.js calls eth_sendTransaction. */
      var isExternal  = wallet.walletClientType !== 'privy';
      var useProvider = (isExternal && window.ethereum) ? window.ethereum : provider;
      _provider            = useProvider;
      window.privyProvider = useProvider;
      return Promise.all([
        useProvider.request({ method: 'eth_accounts' }),
        useProvider.request({ method: 'eth_chainId'  }),
      ]);
    })
    .then(function (res) {
      if (!res) return;
      var accounts = res[0];
      var chainId  = res[1];
      if (!accounts || !accounts.length) return;
      setState({ wallet: accounts[0], connected: true, network: parseInt(chainId, 16) });
      resolveENS(accounts[0]);
      if (_provider) wireProviderEvents(_provider);
      /* Re-render wallet list to reflect new active card */
      _renderWalletList();
    })
    .catch(function (err) {
      console.error('[OBSIDEUM wallet] Switch wallet failed:', err);
      if (typeof showToast === 'function') showToast('Could not switch wallet.', 'terr');
    });
}

/* ── Network toggles ────────────────────────────────────────────── */

function _renderNetworkToggles() {
  var container = document.getElementById('accounts-network-toggles');
  if (!container) return;

  var activeNetworks = (STATE.settings && STATE.settings.activeNetworks) || [];

  container.innerHTML = ACCOUNTS_CHAINS.map(function (chainId) {
    var isOn   = activeNetworks.indexOf(chainId) > -1;
    var name   = ACCOUNTS_CHAIN_NAMES[chainId] || ('Chain ' + chainId);
    var logo   = _chainLogoUrl(chainId);
    var logoEl = logo
      ? '<img class="accounts-network-logo" src="' + logo + '" alt="' + _esc(name) + '"' +
          ' onerror="this.style.display=\'none\'">'
      : '<div class="accounts-network-logo accounts-network-logo--fallback">' +
          _esc(name.slice(0, 2)) +
        '</div>';

    return (
      '<div class="accounts-network-row" data-chain-id="' + chainId + '">' +
        logoEl +
        '<span class="accounts-network-name">' + _esc(name) + '</span>' +
        '<button class="accounts-toggle' + (isOn ? ' on' : '') + '"' +
          ' role="switch"' +
          ' aria-checked="' + isOn + '"' +
          ' aria-label="Toggle ' + _esc(name) + '"' +
          ' data-chain-id="' + chainId + '">' +
        '</button>' +
      '</div>'
    );
  }).join('');

  /* Wire toggle buttons */
  container.querySelectorAll('.accounts-toggle').forEach(function (toggle) {
    function handleToggle() {
      var chainId  = Number(toggle.getAttribute('data-chain-id'));
      var current  = (STATE.settings && STATE.settings.activeNetworks) || [];
      var isOn     = current.indexOf(chainId) > -1;
      var updated  = isOn
        ? current.filter(function (id) { return id !== chainId; })
        : current.concat([chainId]);

      /* Never allow disabling all chains */
      if (updated.length === 0) return;

      updateSetting('activeNetworks', updated);

      /* Update visual immediately — no full re-render needed */
      toggle.classList.toggle('on', !isOn);
      toggle.setAttribute('aria-checked', String(!isOn));

      /* Trigger re-discovery on both sides */
      if (typeof loadTokenList  === 'function') loadTokenList();
      if (typeof window.mountPortfolio === 'function') window.mountPortfolio();
    }

    toggle.addEventListener('click', handleToggle);
    toggle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(); }
    });
  });
}

/* ── ENS identity section ───────────────────────────────────────── */

function _renderENSSection() {
  var container = document.getElementById('accounts-ens-content');
  if (!container) return;

  if (!STATE.connected || !STATE.wallet) {
    container.innerHTML =
      '<span class="accounts-ens-hint">Connect a wallet to claim an ENS identity.</span>';
    return;
  }

  /* State C — ENSv2 subname registered */
  if (STATE.ensSubname) {
    container.innerHTML =
      '<div class="wsh-subname">' + _esc(STATE.ensSubname) + '</div>' +
      '<div class="wsh-subname-note">Registered &middot; Sepolia testnet</div>';
    return;
  }

  /* State B — has primary ENS, no subname yet */
  var identLine = STATE.ens
    ? '<div class="wsh-id-addr">' + _esc(STATE.ens) + '</div>'
    : '<div class="wsh-id-addr">' + _esc(_t6x4(STATE.wallet)) + '</div>';

  container.innerHTML =
    identLine +
    '<button class="wsh-claim-prompt" id="accts-claim-btn" aria-expanded="false">' +
      '<span class="wsh-claim-arrow" aria-hidden="true">\u203a</span>' +
      '<span>Claim your obsideum.eth identity</span>' +
    '</button>' +
    '<div id="accts-claim-form" hidden></div>';

  _wireAccountsClaimPrompt();
}

function _wireAccountsClaimPrompt() {
  var btn  = document.getElementById('accts-claim-btn');
  var form = document.getElementById('accts-claim-form');
  if (!btn || !form) return;

  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') === 'true';
    if (!open) {
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('expanded');
      form.hidden = false;
      form.innerHTML = _acctClaimFormHTML();
      _wireAcctClaimForm();
    } else {
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('expanded');
      form.hidden = true;
      clearTimeout(_claimDebounce);
    }
  });
}

function _acctClaimFormHTML() {
  return (
    '<div class="wsh-claim-form">' +
      '<div class="wsh-ens-row">' +
        '<input class="wsh-ens-input" id="accts-ens-input" type="text"' +
          ' placeholder="yourname" maxlength="32"' +
          ' autocomplete="off" autocorrect="off" autocapitalize="none"' +
          ' spellcheck="false" inputmode="url">' +
        '<span class="wsh-ens-suffix">.obsideum.eth</span>' +
      '</div>' +
      '<div class="wsh-ens-status" id="accts-ens-status" role="status" aria-live="polite"></div>' +
      _btnPrimary('accts-register-btn', 'REGISTER') +
    '</div>'
  );
}

function _wireAcctClaimForm() {
  var input  = document.getElementById('accts-ens-input');
  var status = document.getElementById('accts-ens-status');
  var regBtn = document.getElementById('accts-register-btn');
  if (!input || !status || !regBtn) return;

  regBtn.hidden = true;
  setTimeout(function () { input.focus(); }, 80);

  input.addEventListener('input', function () {
    clearTimeout(_claimDebounce);
    var raw = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (input.value !== raw) input.value = raw;

    status.textContent = '';
    status.className   = 'wsh-ens-status';
    regBtn.hidden = true;

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
        .then(function (ok) {
          if (input.value !== raw) return;
          if (ok) {
            status.textContent = '\u2713 Available';
            status.className   = 'wsh-ens-status available';
            regBtn.hidden      = false;
            regBtn.disabled    = false;
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

  regBtn.addEventListener('click', function () {
    var label = input.value.trim().toLowerCase();
    if (!label || label.length < 3) return;
    regBtn.disabled = true;
    var s = regBtn.querySelector('span');
    if (s) s.textContent = 'REGISTERING\u2026';

    registerSubname(label)
      .then(function () {
        /* Phase 6B sets STATE.ensSubname → state:ensSubname fires → _renderENSSection() */
      })
      .catch(function () {
        regBtn.disabled = false;
        if (s) s.textContent = 'REGISTER';
        var f = document.getElementById('accts-claim-form');
        if (f) {
          f.classList.add('wsh-shake');
          setTimeout(function () { f.classList.remove('wsh-shake'); }, 400);
        }
        if (typeof showToast === 'function') showToast('Registration failed. Try again.', 'terr');
      });
  });
}

/* ── Mount accounts tab ─────────────────────────────────────────── */

function mountAccountsTab(container) {
  if (!container) return;

  container.innerHTML =
    '<div class="accounts-section">' +
      '<div class="accounts-section-label">WALLETS</div>' +
      '<div id="accounts-wallet-list" class="accounts-wallet-list"></div>' +
      /* btn-white: secondary CTA — correct tier for ADD WALLET */
      _btnWhite('accounts-add-wallet', '+ ADD WALLET') +
    '</div>' +
    '<div class="accounts-section">' +
      '<div class="accounts-section-label">NETWORKS</div>' +
      '<div id="accounts-network-toggles" class="accounts-network-toggles"></div>' +
    '</div>' +
    '<div class="accounts-section" id="accounts-ens-section">' +
      '<div class="accounts-section-label">ENS IDENTITY</div>' +
      '<div id="accounts-ens-content"></div>' +
    '</div>';

  _renderWalletList();
  _renderNetworkToggles();
  _renderENSSection();

  var addBtn = document.getElementById('accounts-add-wallet');
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      if (!window._privyBridge) return;
      /*
       * linkWallet() — shows Privy's connector picker without requiring
       * the user to log out and back in. This is the correct call for
       * "add another wallet while already authenticated". It always presents
       * all available connection methods (MetaMask, WalletConnect, Brave, etc.)
       * regardless of which wallet is currently active.
       *
       * login() is wrong here — when already authenticated, Privy may
       * auto-skip the method picker and reconnect the existing wallet.
       */
      if (typeof window._privyBridge.linkWallet === 'function') {
        window._privyBridge.linkWallet();
      } else {
        /* Privy version fallback — link methods not yet available */
        window._privyBridge.login();
      }
    });
  }
}

window.mountAccountsTab = mountAccountsTab;

/* ═══════════════════════════════════════
   CLICK WIRING
═══════════════════════════════════════ */

(function wireClicks() {
  /* Desktop sidebar wallet block */
  var block = document.querySelector('.sidebar-wallet-block');
  if (block) {
    block.style.cursor = 'pointer';
    block.setAttribute('tabindex', '0');
    block.setAttribute('role', 'button');
    block.setAttribute('aria-label', 'Open wallet');
    block.setAttribute('aria-haspopup', 'dialog');
    block.addEventListener('click', openWalletSheet);
    block.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWalletSheet(); }
    });
  }

  /* Mobile wallet pill */
  var pill = document.getElementById('mobile-wallet-btn');
  if (pill) pill.addEventListener('click', openWalletSheet);

  /* Overlay */
  var overlay = document.getElementById('wallet-sheet-overlay');
  if (overlay) overlay.addEventListener('click', closeWalletSheet);

  /* Disconnect — direct since button is static DOM */
  var disconnBtn = document.getElementById('wallet-sheet-disconnect');
  if (disconnBtn) disconnBtn.addEventListener('click', _handleDisconnectClick);
}());

/* ═══════════════════════════════════════
   SWIPE-TO-DISMISS
   >80px down OR fast flick >0.5px/ms.
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
    _t = null;
    if (dy > 80 || (dy > 24 && dy / dt > 0.5)) closeWalletSheet();
  }, { passive: true });
}());
