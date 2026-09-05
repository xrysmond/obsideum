/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — wallet.js
   Phase 6A: Privy connection · session persistence · provider · UI updates.
   Phase 6B: ENS resolution + ENSv2 subname registration (stub here).
   Phase 6C: Wallet bottom sheet full content rendering (stub here).

   Architecture: micro-island React pattern.
   An invisible React root wraps PrivyProvider and bridges Privy's
   React hooks to the vanilla JS app via window._privyBridge.
   No React anywhere else in the codebase.

   Provider contract:
     window.privyProvider — EIP-1193 compatible.
     swap.js consumes: new ethers.providers.Web3Provider(window.privyProvider)
     All signing, ENS, and Chainlink calls use this provider identically.

   DOM handled by 2C wiring (state events — do not duplicate):
     state:wallet  → #sidebar-wallet text + #swb-dot class
     state:ens     → #sidebar-wallet fade → ENS name, var(--em-2)
     state:network → #sidebar-network text + mismatch colour

   DOM owned by wallet.js:
     #mobile-wallet-btn  label + disconnected class (Phase 6C adds element)
     #wallet-sheet       open / close / render (Phase 6C adds DOM)
     .sidebar-wallet-block click → openWalletSheet()

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════════════════════════
   CONFIGURATION
═══════════════════════════════════════ */

var PRIVY_APP_ID = 'cmtemvtdu01rn0cjipu1ic33f';

/*
 * PrivyProvider config — v2 API (docs.privy.io/basics/react/setup).
 * appearance.theme / accentColor reinforce the Privy dashboard branding
 * (OBSIDEUM · #9C3DBB already configured in the dashboard).
 * loginMethods filter shown options; dashboard enablement takes precedence.
 * embeddedWallets.ethereum.createOnLogin: v2 nested key, verified at docs.
 */
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

/* ═══════════════════════════════════════
   GLOBALS
═══════════════════════════════════════ */

/* EIP-1193 provider — set after wallet auth, null on disconnect.
   Consumed by swap.js: new ethers.providers.Web3Provider(window.privyProvider) */
window.privyProvider = null;

/* Internal state */
var _privyInitialized = false;
var _disconnectTimer  = null;

/*
 * Resolved when the PrivyBridge React component has initialized
 * and Privy's ready state is true. connect() awaits this before
 * calling login() to avoid a race against the SDK loading.
 */
var _privyReadyResolve;
var _privyReady = new Promise(function (res) { _privyReadyResolve = res; });

/* ═══════════════════════════════════════
   IDENTITY HELPERS
═══════════════════════════════════════ */

/*
 * Returns display identity in priority order:
 * ENSv2 subname → standard ENS name → truncated address → null
 */
function getIdentityLabel() {
  if (STATE.ensSubname) return STATE.ensSubname;
  if (STATE.ens)        return STATE.ens;
  if (STATE.wallet)     return truncateAddress(STATE.wallet);
  return null;
}

/*
 * 6+4 truncation: 0x74f3...3aB2
 * Matches the format used in 2C's local truncateAddress.
 */
function truncateAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/* ═══════════════════════════════════════
   MOBILE WALLET PILL
   #mobile-wallet-btn is added by Phase 6C.
   All calls here are null-guarded — safe to call in 6A.
═══════════════════════════════════════ */

/*
 * updateMobilePill()
 * Syncs label text and disconnected class on #mobile-wallet-btn.
 * Identity priority: ENSv2 subname > ENS > truncated address.
 * Pill label truncated to 18 chars if identity is a long ENS subname.
 */
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

  var text = getIdentityLabel() || truncateAddress(STATE.wallet);
  /* Long ENS subnames (e.g. yourname.obsideum.eth) truncated to fit pill */
  if (text.length > 18) text = text.slice(0, 15) + '\u2026';
  label.textContent = text;
}

/* ═══════════════════════════════════════
   WALLET BOTTOM SHEET
   DOM elements added by Phase 6C.
   All entry points null-guarded — safe to call in 6A.
═══════════════════════════════════════ */

/*
 * openWalletSheet()
 * Shows the wallet bottom sheet with a slide-up transition.
 * Double rAF ensures display: block settles before the transition fires.
 * If not connected: sheet shows only the CONNECT WALLET button.
 * If connected: sheet renders identity, address, trades, network, Privy label.
 */
function openWalletSheet() {
  var sheet   = document.getElementById('wallet-sheet');
  var overlay = document.getElementById('wallet-sheet-overlay');

  /*
   * Wallet sheet DOM is added in Phase 6C.
   * Until then: if the user isn't connected, go straight to Privy's modal.
   * If already connected, nothing to show yet — 6C handles that state.
   * This bypass is removed once Phase 6C adds the sheet to the HTML.
   */
  if (!sheet || !overlay) {
    if (!STATE.connected) connect();
    return;
  }

  renderWalletSheet();

  sheet.hidden   = false;
  overlay.hidden = false;

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      sheet.classList.add('panel-visible');
      overlay.style.opacity    = '0';
      overlay.style.transition = 'opacity 240ms var(--ease-out)';
      requestAnimationFrame(function () {
        overlay.style.opacity = '1';
      });
    });
  });
}

/*
 * closeWalletSheet()
 * Slides sheet down and hides after transition completes.
 * Resets overlay opacity and disconnect button confirm state.
 */
function closeWalletSheet() {
  var sheet   = document.getElementById('wallet-sheet');
  var overlay = document.getElementById('wallet-sheet-overlay');
  if (!sheet || !overlay) return;

  sheet.classList.remove('panel-visible');
  overlay.style.transition = 'opacity 200ms var(--ease-in)';
  overlay.style.opacity    = '0';

  setTimeout(function () {
    sheet.hidden   = true;
    overlay.hidden = true;
    overlay.style.opacity    = '';
    overlay.style.transition = '';
    _resetDisconnectBtn();
  }, 240);
}

/*
 * renderWalletSheet()
 * Stub in Phase 6A. Full three-state implementation in Phase 6C.
 *
 * Phase 6C renders:
 *   State A — not connected: CONNECT WALLET button only.
 *   State B — connected, no subname: identity + address + network + Privy + disconnect.
 *   State C — connected, ENSv2 subname: same as B + recent trades + registered label.
 *
 * Called by: openWalletSheet(), state:wallet, state:ens, state:ensSubname listeners
 * when the sheet is already open.
 */
function renderWalletSheet() {
  /* Phase 6C implementation. */
}

/* ═══════════════════════════════════════
   DISCONNECT CONFIRM PATTERN
   Two-step: first click → confirm label + 2s reset timer.
   Second click → executes disconnect().
   Element added by Phase 6C. Null-guarded.
═══════════════════════════════════════ */

function _resetDisconnectBtn() {
  var btn = document.getElementById('wallet-sheet-disconnect');
  if (!btn) return;
  clearTimeout(_disconnectTimer);
  btn.textContent      = 'DISCONNECT WALLET';
  btn.dataset.confirm  = 'false';
  btn.classList.remove('btn-destructive--confirming');
}

function _handleDisconnectClick() {
  var btn = document.getElementById('wallet-sheet-disconnect');
  if (!btn) return;

  if (btn.dataset.confirm !== 'true') {
    /* First click — enter confirm state */
    btn.textContent      = 'CONFIRM DISCONNECT';
    btn.dataset.confirm  = 'true';
    btn.classList.add('btn-destructive--confirming');
    _disconnectTimer = setTimeout(_resetDisconnectBtn, 2000);
  } else {
    /* Second click within 2s — execute */
    clearTimeout(_disconnectTimer);
    disconnect();
  }
}

/* ═══════════════════════════════════════
   ENS RESOLUTION — STUB
   Full implementation in Phase 6B.
   Phase 6B:
     - ethers.providers.Web3Provider(privyProvider).lookupAddress(address)
     - setState({ ens: name }) on resolve → 2C state:ens handler fires transition
     - checkSubnameAvailable(label) — queries ENSv2 SubnameRegistrar on Sepolia
     - registerSubname(label) — wallet_switchEthereumChain + SubnameRegistrar.register()
     - Identity priority applied everywhere on resolve
═══════════════════════════════════════ */

/*
 * resolveENS(address)
 * Stub in Phase 6A — no-op.
 * Phase 6B: async reverse lookup via ethers + ENSv2 subname check.
 */
async function resolveENS(address) { /* Phase 6B. */ void address; }

/* ═══════════════════════════════════════
   PROVIDER EVENT WIRING
═══════════════════════════════════════ */

/*
 * wireProviderEvents(provider)
 * Attaches EIP-1193 event listeners for account and chain changes.
 * Guards against embedded wallet providers that may not emit events.
 * Disconnect event: not all providers emit this reliably — Privy's
 * own auth state change is the primary disconnect signal.
 */
function wireProviderEvents(provider) {
  if (!provider || typeof provider.on !== 'function') return;

  provider.on('accountsChanged', function (accounts) {
    if (!accounts || !accounts.length) {
      /* User removed all accounts — treat as disconnect */
      window.privyProvider = null;
      setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
    } else {
      /* Account switched — update address, re-resolve ENS */
      setState({ wallet: accounts[0], ens: null, ensSubname: null });
      resolveENS(accounts[0]);
    }
  });

  provider.on('chainChanged', function (chainId) {
    setState({ network: parseInt(chainId, 16) });
    document.dispatchEvent(new CustomEvent('network:changed'));
  });

  provider.on('disconnect', function () {
    /* Some providers emit this on network error as well — only act if not connected */
    if (STATE.connected) {
      window.privyProvider = null;
      setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
    }
  });
}

/* ═══════════════════════════════════════
   PRIVY MICRO-ISLAND
   Dynamic import: React 18 + @privy-io/react-auth via esm.sh.
   An invisible React root mounts PrivyProvider + PrivyBridge.
   All Privy state bridges to vanilla JS via window._privyBridge.
═══════════════════════════════════════ */

/*
 * PrivyBridge — invisible React functional component.
 * Three effects:
 *   1. Bridge exposure  — every render. Keeps refs fresh. Resolves _privyReady.
 *   2. Provider init    — fires when primaryAddr changes (connect / account switch).
 *   3. Disconnect guard — fires when authenticated goes false.
 *
 * Wallet priority inside useWallets():
 *   Prefer external wallet (MetaMask, Brave, Coinbase) over Privy embedded wallet.
 *   Embedded wallet has walletClientType === 'privy'.
 *   External wallets have walletClientType === 'metamask' | 'coinbase_wallet' | etc.
 */
function _buildPrivyBridge(useEffect, usePrivy, useWallets) {
  return function PrivyBridge() {
    var privyHooks   = usePrivy();
    var walletHooks  = useWallets();

    var ready         = privyHooks.ready;
    var authenticated = privyHooks.authenticated;
    var user          = privyHooks.user;
    var login         = privyHooks.login;
    var logout        = privyHooks.logout;
    var wallets       = walletHooks.wallets;

    /* Select primary wallet: external wallet preferred over embedded */
    var primaryWallet = (authenticated && wallets && wallets.length > 0)
      ? (wallets.find(function (w) { return w.walletClientType !== 'privy'; }) || wallets[0])
      : null;
    var primaryAddr = primaryWallet ? primaryWallet.address : null;

    /* ── Effect 1: Bridge exposure ────────────────────────────────
       No dep array — intentional. Ensures window._privyBridge always
       holds the latest login/logout function references.
       _privyReadyResolve is idempotent — safe to call on every render.
    ─────────────────────────────────────────────────────────────── */
    useEffect(function () {
      window._privyBridge = {
        login:         login,
        logout:        logout,
        ready:         ready,
        authenticated: authenticated,
        user:          user,
      };
      if (ready) _privyReadyResolve();
    });

    /* ── Effect 2: Provider init ──────────────────────────────────
       Fires when ready becomes true OR when primaryAddr changes
       (new wallet connected, account switched).
       alive flag prevents a stale Promise from overwriting a newer one.
    ─────────────────────────────────────────────────────────────── */
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
        .then(function (results) {
          if (!alive || !results) return;
          var accounts = results[0];
          var chainId  = results[1];
          if (!accounts || !accounts.length) return;

          setState({
            wallet:    accounts[0],
            connected: true,
            network:   parseInt(chainId, 16),
          });

          resolveENS(accounts[0]);
          wireProviderEvents(window.privyProvider);
        })
        .catch(function (err) {
          if (!alive) return;
          console.error('[OBSIDEUM wallet] Provider init failed:', err);
          /* showToast is defined in app.html boot script — safe at this async point */
          if (typeof showToast === 'function') {
            showToast('Could not access wallet. Try reconnecting.', 'err');
          }
        });

      return function () { alive = false; };

    }, [ready, primaryAddr]); /* eslint-disable-line react-hooks/exhaustive-deps */

    /* ── Effect 3: Disconnect / logout detection ──────────────────
       When authenticated goes false after being true, clear state.
       Guards STATE.connected so the initial render (not yet connected)
       does not trigger a spurious state clear.
    ─────────────────────────────────────────────────────────────── */
    useEffect(function () {
      if (!ready) return;
      if (!authenticated) {
        window.privyProvider = null;
        if (STATE.connected) {
          setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
        }
      }
    }, [ready, authenticated]); /* eslint-disable-line react-hooks/exhaustive-deps */

    return null; /* invisible — renders no DOM */
  };
}

/*
 * initPrivy()
 * Dynamically loads React 18 + @privy-io/react-auth from esm.sh.
 * ?deps=react@18,react-dom@18 aligns Privy's peer deps to our React instance —
 * prevents duplicate React contexts which break hook rules.
 * Mounts an invisible React root (#privy-root) at the bottom of <body>.
 * Must be called before connect() or checkExistingConnection().
 * Guard: _privyInitialized prevents double-init across async calls.
 */
async function initPrivy() {
  if (_privyInitialized) return;
  _privyInitialized = true;

  try {
    var reactMod    = await import('https://esm.sh/react@18');
    var reactDomMod = await import('https://esm.sh/react-dom@18/client');
    var privyMod    = await import('https://esm.sh/@privy-io/react-auth?deps=react@18,react-dom@18');

    var React       = reactMod.default;
    var useEffect   = reactMod.useEffect;
    var createRoot  = reactDomMod.createRoot;

    var PrivyProvider = privyMod.PrivyProvider;
    var usePrivy      = privyMod.usePrivy;
    var useWallets    = privyMod.useWallets;

    var PrivyBridge = _buildPrivyBridge(useEffect, usePrivy, useWallets);

    /* Mount point — aria-hidden, display:none, pointer-events:none */
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
      showToast('Wallet service unavailable. Please refresh.', 'err');
    }
  }
}

/* ═══════════════════════════════════════
   PUBLIC API
   checkExistingConnection — called by app.html boot script.
   connect — called by wallet sheet CONNECT button (Phase 6C).
   disconnect — called by wallet sheet disconnect button.
═══════════════════════════════════════ */

/*
 * checkExistingConnection()
 * Called from app.html immediately after FX.start().
 * Initializes the Privy SDK. Session restoration is automatic:
 * PrivyBridge's useEffect fires once Privy is ready and re-authenticates
 * any stored session token, then sets STATE via setState().
 */
async function checkExistingConnection() {
  await initPrivy();
  /*
   * Session restoration is handled inside PrivyBridge.
   * If Privy has a valid stored session, it authenticates silently —
   * useEffect fires → provider init → setState({ wallet, connected, network }).
   * No explicit action needed here.
   */
}

/*
 * connect()
 * Opens Privy's branded login modal. Supports: external wallets (MetaMask,
 * Brave, Coinbase), embedded wallet (email, social login).
 * State update happens automatically via PrivyBridge's provider init effect
 * once the user authenticates. connect() only needs to trigger the modal.
 */
async function connect() {
  /* Wait for Privy SDK to finish initializing before opening the modal */
  await _privyReady;

  if (!window._privyBridge) {
    if (typeof showToast === 'function') {
      showToast('Wallet service not ready. Please try again.', 'err');
    }
    return;
  }

  try {
    await window._privyBridge.login();
    /* STATE updates via PrivyBridge useEffect — no action needed here */
  } catch (err) {
    var msg = (err && err.message) ? err.message.toLowerCase() : '';
    /* User closed the modal — suppress. Any other error — toast. */
    if (!msg.includes('cancel') && !msg.includes('reject') && !msg.includes('close') && !msg.includes('dismiss')) {
      console.error('[OBSIDEUM wallet] Login error:', err);
      if (typeof showToast === 'function') {
        showToast('Connection failed. Please try again.', 'err');
      }
    }
  }
}

/*
 * disconnect()
 * Logs out of Privy, clears all wallet state, closes the sheet,
 * and redirects to the landing page.
 * Handles partial failures: state is cleared even if Privy logout fails.
 */
async function disconnect() {
  closeWalletSheet();

  if (!window._privyBridge) {
    window.location.href = 'index.html';
    return;
  }

  try {
    await window._privyBridge.logout();
    /* PrivyBridge Effect 3 handles state clear on authenticated → false */
  } catch (err) {
    console.error('[OBSIDEUM wallet] Logout error:', err);
    /* Force clear even on failure — user experience must not be stuck */
    window.privyProvider = null;
    setState({ wallet: null, connected: false, ens: null, ensSubname: null, network: null });
  } finally {
    window.location.href = 'index.html';
  }
}

/* ═══════════════════════════════════════
   STATE EVENT LISTENERS
   2C wiring already handles:
     state:wallet  → #sidebar-wallet text + #swb-dot class
     state:ens     → #sidebar-wallet fade → ENS name + --em-2 color
     state:network → #sidebar-network text + mismatch warning
   wallet.js handles:
     #mobile-wallet-btn via updateMobilePill()
     Wallet sheet re-render when open
═══════════════════════════════════════ */

function _sheetIsOpen() {
  var sheet = document.getElementById('wallet-sheet');
  return sheet && !sheet.hidden;
}

document.addEventListener('state:wallet', function () {
  updateMobilePill();
  if (_sheetIsOpen()) renderWalletSheet();
});

document.addEventListener('state:ens', function () {
  updateMobilePill();
  if (_sheetIsOpen()) renderWalletSheet();
});

document.addEventListener('state:ensSubname', function () {
  updateMobilePill();
  if (_sheetIsOpen()) renderWalletSheet();
});

document.addEventListener('state:connected', function () {
  updateMobilePill();
});

document.addEventListener('state:network', function () {
  if (_sheetIsOpen()) renderWalletSheet();
});

/* ═══════════════════════════════════════
   CLICK WIRING
   sidebar-wallet-block — present in app-1.html.
   All wallet sheet elements — null-guarded (Phase 6C adds DOM).
   mobile-wallet-btn — null-guarded (Phase 6C adds element).
═══════════════════════════════════════ */

(function wireClicks() {

  /* ── Desktop: sidebar wallet block → open sheet ── */
  var sidebarBlock = document.querySelector('.sidebar-wallet-block');
  if (sidebarBlock) {
    sidebarBlock.style.cursor = 'pointer';
    sidebarBlock.addEventListener('click', openWalletSheet);
    sidebarBlock.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openWalletSheet();
      }
    });
    /* Keyboard accessibility: make the block focusable */
    if (!sidebarBlock.getAttribute('tabindex')) {
      sidebarBlock.setAttribute('tabindex', '0');
      sidebarBlock.setAttribute('role', 'button');
      sidebarBlock.setAttribute('aria-label', 'Open wallet');
    }
  }

  /* ── Mobile: wallet pill → open sheet (Phase 6C adds element) ── */
  var mobileBtn = document.getElementById('mobile-wallet-btn');
  if (mobileBtn) {
    mobileBtn.addEventListener('click', openWalletSheet);
  }

  /* ── Overlay tap → dismiss sheet ── */
  var overlay = document.getElementById('wallet-sheet-overlay');
  if (overlay) {
    overlay.addEventListener('click', closeWalletSheet);
  }

  /* ── Disconnect button ── */
  var disconnectBtn = document.getElementById('wallet-sheet-disconnect');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', _handleDisconnectClick);
  }

}());

/* ═══════════════════════════════════════
   SWIPE-TO-DISMISS
   Sheet element added by Phase 6C.
   Guard: no-op if #wallet-sheet is absent.
   Threshold: swipe down > 80px OR fast downward flick (velocity > 0.5 px/ms).
   Full gesture polish in Phase 9B.
═══════════════════════════════════════ */

(function wireSwipe() {
  var sheet = document.getElementById('wallet-sheet');
  if (!sheet) return;

  var _touch = null;

  sheet.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    _touch = { y: t.clientY, time: Date.now() };
  }, { passive: true });

  sheet.addEventListener('touchend', function (e) {
    if (!_touch) return;
    var t   = e.changedTouches[0];
    var dy  = t.clientY - _touch.y;
    var dt  = Math.max(1, Date.now() - _touch.time);
    var vel = dy / dt;
    _touch  = null;

    if (dy > 80 || (dy > 24 && vel > 0.5)) {
      closeWalletSheet();
    }
  }, { passive: true });

}());
