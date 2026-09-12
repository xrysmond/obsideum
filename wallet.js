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
   Vanilla JS auth via @privy-io/js-sdk-core
   github.com/privy-io/examples/privy-vanilla-starter

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
   appId + clientId — both required by @privy-io/js-sdk-core.
   Find your clientId in the Privy Dashboard → Settings → Client IDs.
═══════════════════════════════════════ */

var PRIVY_APP_ID    = 'cmtemvtdu01rn0cjipu1ic33f';
var PRIVY_CLIENT_ID = 'client-WY6d5Cv8Sps7wfzQ41LVNn1e1ynnnTS3GSyz2Hc5cuQVG';

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
var _disconnectTimer  = null;
var _claimDebounce    = null;

/* Privy SDK instance and user state */
var _privy             = null;
var _user              = null;
var _getEmbeddedWallet = null;
var _getEntropyDetails = null;

/* Resolves once SDK is loaded, iframe ready, and session checked */
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
      '<span class="wsh-connect-eyebrow">Sign in to OBSIDEUM</span>' +
      '<div class="wsh-login-options">' +
        '<button class="wsh-login-opt" id="wsh-opt-wallet">' +
          '<span class="wsh-login-opt-icon">⬡</span>' +
          '<span>Connect Wallet</span>' +
        '</button>' +
        '<button class="wsh-login-opt" id="wsh-opt-google">' +
          '<span class="wsh-login-opt-icon">G</span>' +
          '<span>Continue with Google</span>' +
        '</button>' +
        '<button class="wsh-login-opt" id="wsh-opt-email">' +
          '<span class="wsh-login-opt-icon">@</span>' +
          '<span>Continue with Email</span>' +
        '</button>' +
      '</div>' +
      '<div id="wsh-email-form" hidden>' +
        '<input class="glass-input wsh-email-input" id="wsh-email-input" type="email" ' +
          'placeholder="Enter your email…" autocomplete="email" spellcheck="false">' +
        '<button class="wsh-login-opt" id="wsh-email-submit">Send Code</button>' +
        '<div id="wsh-otp-wrap" hidden>' +
          '<input class="glass-input wsh-email-input" id="wsh-otp-input" type="text" ' +
            'placeholder="Enter code…" autocomplete="one-time-code" maxlength="6">' +
          '<button class="wsh-login-opt" id="wsh-otp-submit">Verify</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  sA.hidden = true;
  sT.hidden = true;
  sN.hidden = true;
  sV.hidden = true;
  if (sD) sD.hidden = true;

  /* Wallet — SIWE */
  var walletBtn = document.getElementById('wsh-opt-wallet');
  if (walletBtn) {
    walletBtn.addEventListener('click', function () {
      _connectWithWallet();
    });
  }

  /* Google — full-page redirect OAuth */
  var googleBtn = document.getElementById('wsh-opt-google');
  if (googleBtn) {
    googleBtn.addEventListener('click', function () {
      closeWalletSheet();
      connectWithOAuth('google');
    });
  }

  /* Email — show input */
  var emailBtn  = document.getElementById('wsh-opt-email');
  var emailForm = document.getElementById('wsh-email-form');
  if (emailBtn && emailForm) {
    emailBtn.addEventListener('click', function () {
      emailBtn.hidden  = true;
      emailForm.hidden = false;
    });
  }

  /* Send OTP code */
  var emailSubmit = document.getElementById('wsh-email-submit');
  if (emailSubmit) {
    emailSubmit.addEventListener('click', async function () {
      var emailInput = document.getElementById('wsh-email-input');
      var email = emailInput ? emailInput.value.trim() : '';
      if (!email) return;

      emailSubmit.textContent = 'Sending…';
      emailSubmit.disabled = true;
      try {
        await _privyReady;
        await _privy.auth.email.sendCode(email);
        var otpWrap = document.getElementById('wsh-otp-wrap');
        if (otpWrap) otpWrap.hidden = false;
        emailSubmit.textContent = 'Resend';
        emailSubmit.disabled = false;
      } catch (err) {
        emailSubmit.textContent = 'Send Code';
        emailSubmit.disabled = false;
        if (typeof showToast === 'function') showToast('Failed to send code: ' + (err.message || err), 'terr');
      }
    });
  }

  /* Verify OTP */
  var otpSubmit = document.getElementById('wsh-otp-submit');
  if (otpSubmit) {
    otpSubmit.addEventListener('click', async function () {
      var emailInput = document.getElementById('wsh-email-input');
      var otpInput   = document.getElementById('wsh-otp-input');
      var email = emailInput ? emailInput.value.trim() : '';
      var code  = otpInput  ? otpInput.value.trim()   : '';
      if (!email || !code) return;

      otpSubmit.textContent = 'Verifying…';
      otpSubmit.disabled = true;
      try {
        await _privyReady;
        var session = await _privy.auth.email.loginWithCode(
          email, code,
          'login-or-sign-up',
          { embedded: { ethereum: { createOnLogin: 'user-without-wallets' } } }
        );
        closeWalletSheet();
        await _afterLogin(session);
        if (typeof showToast === 'function') showToast('Login successful!', 'tok');
      } catch (err) {
        otpSubmit.textContent = 'Verify';
        otpSubmit.disabled = false;
        if (typeof showToast === 'function') showToast('Invalid code: ' + (err.message || err), 'terr');
      }
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
   PRIVY INIT
   @privy-io/js-sdk-core — no React, no hooks, no bridge.
   Copied from: github.com/privy-io/examples/privy-vanilla-starter/src/privy-client.js
═══════════════════════════════════════ */

async function _loadPrivy() {
  try {
    /* Load vanilla SDK — same CDN pattern the project already uses */
    var mod = await import('https://esm.sh/@privy-io/js-sdk-core');

    var Privy        = mod.default || mod.Privy;
    var LocalStorage = mod.LocalStorage;
    _getEmbeddedWallet = mod.getUserEmbeddedEthereumWallet;
    _getEntropyDetails = mod.getEntropyDetailsFromUser;

    _privy = new Privy({
      appId:    PRIVY_APP_ID,
      clientId: PRIVY_CLIENT_ID,
      storage:  new LocalStorage(),
    });

    /* ── Embedded wallet iframe (privy-client.js) ─────────────────
       The iframe hosts Privy's secure enclave for embedded wallet
       signing. Required even when using external wallets so the
       SDK initialises correctly.                                   */
    var iframe = document.getElementById('privy-iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'privy-iframe';
      iframe.style.cssText = 'display:none!important;position:absolute;pointer-events:none;';
      document.body.appendChild(iframe);
    }
    iframe.src = _privy.embeddedWallet.getURL();
    await new Promise(function (resolve) {
      iframe.onload = function () {
        _privy.setMessagePoster(iframe.contentWindow);
        resolve();
      };
    });
    window.addEventListener('message', function (e) {
      if (e.source !== iframe.contentWindow || !e.data) return;
      try { _privy.embeddedWallet.onMessage(e.data); } catch (_) {}
    });

    /* ── OAuth callback (oauth-login.js checkForOAuthCallback) ─── */
    await _handleOAuthCallback();

    /* ── Restore existing session (auth-manager.js loadUser) ───── */
    await _loadUser();

  } catch (err) {
    console.error('[OBSIDEUM wallet] Privy SDK load failed:', err);
    if (typeof showToast === 'function') {
      showToast('Wallet service unavailable. Please refresh.', 'terr');
    }
  } finally {
    _privyReadyResolve();
  }
}

/* ═══════════════════════════════════════
   OAUTH CALLBACK
   Exact copy of oauth-login.js checkForOAuthCallback() + loginWithCode().
═══════════════════════════════════════ */

async function _handleOAuthCallback() {
  var params    = new URLSearchParams(window.location.search);
  var code      = params.get('privy_oauth_code');
  var state     = params.get('privy_oauth_state');
  var provider  = params.get('privy_oauth_provider');
  var error     = params.get('privy_oauth_error') || params.get('error');
  var errDesc   = params.get('privy_oauth_error_description') || params.get('error_description');
  var oauthAction    = sessionStorage.getItem('privy_oauth_action');
  var storedProvider = sessionStorage.getItem('privy_oauth_provider');

  if (error) {
    if (typeof showToast === 'function') showToast('Login failed: ' + (errDesc || error), 'terr');
    sessionStorage.removeItem('privy_oauth_action');
    sessionStorage.removeItem('privy_oauth_provider');
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }

  if (!code || !state || !provider) return;

  try {
    if (oauthAction === 'link') {
      /* Link OAuth to an existing Privy user */
      await _privy.auth.oauth.linkWithCode(
        code, state, storedProvider || provider, undefined
      );
      if (typeof showToast === 'function') showToast((storedProvider || provider) + ' linked!', 'tok');
      window.history.replaceState({}, '', window.location.pathname);
      window.location.reload();
    } else {
      /* Login — copied verbatim from oauth-login.js loginWithCode() */
      var session = await _privy.auth.oauth.loginWithCode(
        code,
        state,
        provider,
        undefined,
        'login-or-sign-up',
        {
          embedded: {
            ethereum: { createOnLogin: 'user-without-wallets' },
          },
        }
      );
      window.history.replaceState({}, '', window.location.pathname);
      await _afterLogin(session);
      if (typeof showToast === 'function') showToast('Login successful!', 'tok');
    }
  } catch (err) {
    console.error('[OBSIDEUM wallet] OAuth callback error:', err);
    if (typeof showToast === 'function') showToast('Login failed: ' + (err.message || 'unknown'), 'terr');
    window.history.replaceState({}, '', window.location.pathname);
  } finally {
    sessionStorage.removeItem('privy_oauth_action');
    sessionStorage.removeItem('privy_oauth_provider');
  }
}

/* ═══════════════════════════════════════
   SESSION
   auth-manager.js loadUser() pattern.
═══════════════════════════════════════ */

async function _loadUser() {
  try {
    var result = await _privy.user.get();
    _user = result.user;
    if (_user) await _setupProvider();
  } catch (_) {
    _user = null;
  }
}

async function _afterLogin(session) {
  _user = session.user;
  await _setupProvider();
  setState({ wallets: _user ? [{ address: STATE.wallet }] : [], activeWallet: 0 });
  _renderWalletList();
}

/* ═══════════════════════════════════════
   PROVIDER SETUP
   wallet-actions.js pattern:
   External wallet → window.ethereum directly (no Privy wrapper).
   Embedded wallet → privy.embeddedWallet.getEthereumProvider().
═══════════════════════════════════════ */

async function _setupProvider() {
  if (!_user) return;

  var linked = _user.linked_accounts || [];

  /* Prefer external (injected) wallet */
  var extWallet = linked.find(function (a) {
    return a.type === 'wallet' &&
           a.wallet_client_type !== 'privy' &&
           a.chain_type === 'ethereum';
  });

  if (extWallet && window.ethereum) {
    window.privyProvider = window.ethereum;
    try {
      var accs = await window.ethereum.request({ method: 'eth_accounts' });
      var cid  = await window.ethereum.request({ method: 'eth_chainId'  });
      if (accs && accs.length) {
        setState({ wallet: accs[0], connected: true, network: parseInt(cid, 16) });
        resolveENS(accs[0]);
        setState({ wallets: [{ address: accs[0], walletClientType: extWallet.wallet_client_type }], activeWallet: 0 });
      }
    } catch (e) {
      console.error('[OBSIDEUM wallet] External wallet accounts error:', e);
    }
    wireProviderEvents(window.ethereum);
    return;
  }

  /* Embedded wallet */
  if (!_getEmbeddedWallet || !_getEntropyDetails) return;
  var embWallet = _getEmbeddedWallet(_user);
  if (!embWallet) return;

  try {
    var details  = _getEntropyDetails(_user);
    var provider = await _privy.embeddedWallet.getEthereumProvider({
      wallet:            embWallet,
      entropyId:         details.entropyId,
      entropyIdVerifier: details.entropyIdVerifier,
    });
    window.privyProvider = provider;

    var accounts = await provider.request({ method: 'eth_accounts' });
    var chainId  = await provider.request({ method: 'eth_chainId'  });
    if (accounts && accounts.length) {
      setState({ wallet: accounts[0], connected: true, network: parseInt(chainId, 16) });
      resolveENS(accounts[0]);
      setState({ wallets: [{ address: accounts[0], walletClientType: 'privy' }], activeWallet: 0 });
    }
    wireProviderEvents(provider);
  } catch (err) {
    console.error('[OBSIDEUM wallet] Embedded wallet setup error:', err);
  }
}

/* ═══════════════════════════════════════
   VISIBILITY RE-VALIDATION
   Re-checks Privy session when tab regains focus.
   Clears stale STATE.connected if session has expired.
═══════════════════════════════════════ */

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible' || !_privy) return;
  _privy.user.get().catch(function () {
    if (STATE.connected) {
      window.privyProvider = null;
      setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
      _renderWalletList();
    }
  });
});

/* ═══════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════ */

async function checkExistingConnection() {
  _loadPrivy();
}

/* connect — opens the login options sheet.
   The actual SIWE flow lives in _connectWithWallet(), called only
   when the user explicitly taps "Connect Wallet" inside the sheet. */
async function connect() {
  if (STATE.connected) { openWalletSheet(); return; }
  openWalletSheet();
}

/* _connectWithWallet — SIWE flow for injected wallet.
   Called from the "Connect Wallet" button inside _renderA(). */
async function _connectWithWallet() {
  await _privyReady;

  if (!_privy) {
    if (typeof showToast === 'function') showToast('Wallet service not ready. Try again.', 'terr');
    return;
  }

  if (!window.ethereum) {
    if (typeof showToast === 'function') showToast('No wallet detected in this browser.', 'terr');
    return;
  }

  try {
    /* 1. Request accounts */
    var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) return;

    /* 2. Checksum address */
    var rawAddress = accounts[0];
    var address;
    try {
      address = (window.ethers) ? ethers.utils.getAddress(rawAddress) : rawAddress;
    } catch (_) { address = rawAddress; }

    /* 3. Chain ID */
    var chainIdHex       = await window.ethereum.request({ method: 'eth_chainId' });
    var chainIdNum       = parseInt(chainIdHex, 16);
    var formattedChainId = 'eip155:' + chainIdNum;

    /* 4. Get SIWE message */
    var siweInit = await _privy.auth.siwe.init(
      {
        address:          address,
        chainId:          formattedChainId,
        walletClientType: 'metamask',
        connectorType:    'injected',
      },
      window.location.host,
      window.location.origin
    );
    var message = siweInit.message;

    /* 5. Hex-encode message — matches what viem's signMessage sends */
    var msgBytes = new TextEncoder().encode(message);
    var msgHex   = '0x' + Array.from(msgBytes)
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');

    /* 6. Sign */
    var signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [msgHex, address],
    });

    /* 7. Complete login */
    var session = await _privy.auth.siwe.loginWithSiwe(
      signature, undefined, undefined,
      'login-or-sign-up',
      { ethereum: { createOnLogin: 'user-without-wallets' } }
    );

    closeWalletSheet();
    await _afterLogin(session);
    if (typeof showToast === 'function') showToast('Wallet connected!', 'tok');

  } catch (err) {
    var code   = err && err.code;
    var errMsg = (err && err.message) ? err.message : 'Unknown error';
    var errLow = errMsg.toLowerCase();

    if (code === 4001 ||
        errLow.includes('cancel') ||
        errLow.includes('reject') ||
        errLow.includes('denied') ||
        errLow.includes('dismiss')) {
      return;
    }

    console.error('[OBSIDEUM wallet] Wallet connect error:', err);
    if (typeof showToast === 'function') showToast('Login failed: ' + errMsg, 'terr');
  }
}

/* disconnect — auth-manager.js logout() pattern exactly.
   No redirect. Clears state only.                                   */
async function disconnect() {
  closeWalletSheet();
  try {
    if (_privy) await _privy.auth.logout();
  } catch (err) {
    console.error('[OBSIDEUM wallet] Logout error:', err);
  }
  _user              = null;
  window.privyProvider = null;
  setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
  _renderWalletList();
}

/* connectWithOAuth — oauth-login.js loginWithOAuth() exactly.
   Full-page redirect — no popup, guaranteed to work on Brave mobile. */
async function connectWithOAuth(oauthProvider) {
  await _privyReady;
  if (!_privy) {
    if (typeof showToast === 'function') showToast('Wallet service not ready. Try again.', 'terr');
    return;
  }
  try {
    var redirectURI = window.location.href.split('?')[0];
    var result = await _privy.auth.oauth.generateURL(oauthProvider, redirectURI);
    window.location.href = result.url;
  } catch (err) {
    console.error('[OBSIDEUM wallet] OAuth error:', err);
    if (typeof showToast === 'function') showToast('Social login failed. Try again.', 'terr');
  }
}

window.connectWithGoogle  = function () { return connectWithOAuth('google');  };
window.connectWithTwitter = function () { return connectWithOAuth('twitter'); };
window.connectWithOAuth   = connectWithOAuth;

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
  try { localStorage.setItem('obsideum:activeWallet', String(index)); } catch (_) {}

  /* With js-sdk-core, _setupProvider() re-reads the active linked accounts
   * from the Privy user object and sets window.privyProvider correctly.
   * External wallet → window.ethereum; embedded → privy.embeddedWallet provider. */
  _setupProvider()
    .then(function () { _renderWalletList(); })
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
      /* Add wallet — re-runs the SIWE connect flow.
       * With js-sdk-core, linkWallet() doesn't exist; SIWE handles everything. */
      connect();
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
