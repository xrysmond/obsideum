/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — state.js
   Single source of truth. No library. No framework.
   App state + settings persistence + wallet persistence.
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */

window.STATE = {

  /* ── Wallet + Identity ── */
  wallet:         null,       // string | null — '0xabc...'
  ens:            null,       // string | null — 'name.eth'
  network:        null,       // number — chain ID (1=Ethereum, 42161=Arbitrum, 8453=Base, 10=Optimism)
  connected:      false,      // boolean

  /* ── Navigation ── */
  view:           'markets',  // 'markets' | 'settings'                  (desktop main view)
  rightPanel:     null,       // 'token' | 'swap' | 'history' | null     (desktop right column)
  mobileView:     'markets',  // 'markets' | 'token' | 'swap' | 'history' | 'settings'
  prevMobileView: null,       // string | null — for back arrow navigation

  /* ── Active content ── */
  token:          null,       // string | null — contract address of currently viewed token

  /* ── Live data — populated by prices.js and graph.js ── */
  prices:         {},         // { [address]: { usd, change24h, updatedAt } }
  tokenList:      [],         // [{ address, symbol, name, logo, decimals }]
  trades:         [],         // The Graph trade history for current wallet
  priceHistory:   {},         // { [address]: { '24H': [...], '7D': [...], '30D': [...] } }

  /* ── Settings — persisted to localStorage, loaded before first render ── */
  settings: {

    /* Trading */
    slippage:          0.5,       // number  — 0.1 | 0.5 | 1.0 | custom
    slippageMode:      'preset',  // string  — 'preset' | 'custom'
    deadline:          20,        // number  — minutes, transaction deadline
    mevProtection:     true,      // boolean — Flashbots Protect RPC on Ethereum mainnet
    expertMode:        false,     // boolean — disables price impact warnings
    autoApprove:       false,     // boolean — auto-approve maximum token spend

    /* Networks */
    defaultNetwork:    1,         // number  — chain ID: 1 | 42161 | 8453 | 10
    gasPreference:     'fast',    // string  — 'standard' | 'fast' | 'instant'
    customRPC:         '',        // string  — custom RPC URL, empty = use default

    /* Tokens */
    tokenLists:        ['default'], // string[] — active token list identifiers
    hideSmallBalances: false,       // boolean  — hide tokens with wallet value under $1

    /* Display */
    quoteCurrency:     'USD',     // string  — 'USD' | 'ETH'
    priceFormat:       'full',    // string  — 'full' | 'compact'
    decimalPrecision:  4,         // number  — 2 | 4 | 6
  }

};

/* ═══════════════════════════════════════
   setState(patch)
   Merges patch into STATE.
   Dispatches state:<key> for every changed key.
═══════════════════════════════════════ */

function setState(patch) {
  const changed = Object.keys(patch);
  Object.assign(window.STATE, patch);
  changed.forEach(k =>
    document.dispatchEvent(
      new CustomEvent('state:' + k, { detail: window.STATE[k] })
    )
  );
}

/* ═══════════════════════════════════════
   updateSetting(key, value)
   Mutates one settings key.
   Persists full settings object to localStorage.
   Dispatches settings:<key>.
═══════════════════════════════════════ */

function updateSetting(key, value) {
  STATE.settings[key] = value;
  try {
    localStorage.setItem('obsideum:settings', JSON.stringify(STATE.settings));
  } catch (_) { /* storage full or blocked — fail silently */ }
  document.dispatchEvent(new CustomEvent('settings:' + key, { detail: value }));
}

/* ═══════════════════════════════════════
   loadSettings()
   Restores settings from localStorage.
   Deep-merges over defaults — missing keys stay default.
   Corrupt or absent storage: defaults used silently.
   Called immediately at end of this file —
   before any HTML renders or scripts wire up.
═══════════════════════════════════════ */

function loadSettings() {
  try {
    const saved = localStorage.getItem('obsideum:settings');
    if (saved) Object.assign(STATE.settings, JSON.parse(saved));
  } catch (_) { /* corrupt storage — defaults stand, no throw */ }
}

/* ═══════════════════════════════════════
   INIT
   loadSettings() runs immediately — before any
   HTML renders or other scripts execute.

   NOTE: No window.ethereum listeners here.
   WalletConnect EthereumProvider (wallet.js) is the
   single connection layer — it handles accountsChanged,
   chainChanged, and disconnect for all wallet types.
═══════════════════════════════════════ */

loadSettings();
