/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — state.js
   Single source of truth. No library. No framework.
   App state + settings persistence + trade history persistence.
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */

window.STATE = {

  /* ── Wallet + Identity ── */
  wallet:         null,   /* string | null  '0xabc...'                               */
  ens:            null,   /* string | null  'name.eth'  (standard reverse lookup)    */
  ensSubname:     null,   /* string | null  'name.obsideum.eth' (ENSv2, Phase 6B)    */
  network:        null,   /* number         chain ID: 1 | 42161 | 8453 | 10          */
  connected:      false,  /* boolean                                                  */

  /* ── Multi-wallet ── */
  wallets:      [],  /* Privy wallet objects array — from useWallets().wallets        */
  activeWallet: 0,   /* number — index of active wallet in wallets[]                 */

  /* ── Navigation ── */
  view:           'markets',    /* 'markets' | 'settings'                            */
  rightPanel:     null,         /* 'token' | 'swap' | 'history' | null               */
  mobileView:     'markets',    /* 'markets' | 'token' | 'swap' | 'history' | 'settings' */
  prevMobileView: null,         /* string | null — back arrow destination            */
  mobileTab:      'portfolio',  /* 'portfolio' | 'swap' | 'accounts'                 */

  /* ── Active content ── */
  token: null,  /* string | null — contract address of currently viewed token        */

  /* ── Live data — populated by prices.js ── */
  prices:       {},  /* { [address]: { usd, change24h, updatedAt } }                */
  tokenList:    [],  /* [{ address, symbol, name, logo, decimals }]                 */
  trades:       [],  /* persisted trade history — loaded by loadTrades() at init    */
  priceHistory: {},  /* { [address]: { '24H': [...], '7D': [...], '30D': [...] } } */

  /* ── Portfolio ── */
  portfolioTotal:    0,   /* number — total USD value across all wallets + chains    */
  portfolioBalances: {},  /* { [chainId]: { [tokenAddress]: { balance: string, usd: number } } } */

  /* ── Send flow ── */
  sendFlow: {
    step:         'token',  /* 'token' | 'recipient'                                */
    token:        null,     /* { address, symbol, name, decimals, chainId } | null  */
    recipient:    '',       /* string — raw address or ENS input                    */
    resolvedAddr: null,     /* string | null — resolved 0x address from ENS         */
    amount:       '',       /* string — raw numeric input                            */
    gasEst:       null,     /* string | null — estimated gas cost in ETH            */
  },

  /* ── Receive ── */
  receiveChain: null,  /* number | null — chainId whose QR is currently expanded    */

  /* ── Settings — persisted to localStorage, loaded before first render ── */
  settings: {

    /* Trading */
    slippage:          0.5,       /* number  — 0.1 | 0.5 | 1.0 | custom          */
    slippageMode:      'preset',  /* string  — 'preset' | 'custom'                */
    deadline:          20,        /* number  — minutes until transaction expires   */
    mevProtection:     true,      /* boolean — Flashbots Protect on Ethereum mainnet */
    expertMode:        false,     /* boolean — skips price impact confirmation     */
    autoApprove:       false,     /* boolean — approve max uint256 vs exact amount */

    /* Networks */
    defaultNetwork:    1,                    /* number   — chain ID: 1 | 42161 | 8453 | 10  */
    activeNetworks:    [1, 42161, 8453, 10], /* number[] — chains the user has enabled      */
    gasPreference:     'fast',               /* string   — 'standard' | 'fast' | 'instant'  */
    customRPC:         '',                   /* string   — empty = use default for network   */

    /* Tokens */
    tokenLists:        ['default'], /* string[] — active token list identifiers   */
    hideSmallBalances: false,       /* boolean  — hide tokens under $1 wallet value */

    /* Display */
    quoteCurrency:     'USD',  /* string  — 'USD' | 'ETH'             */
    priceFormat:       'full', /* string  — 'full' | 'compact'        */
    decimalPrecision:  4,      /* number  — 2 | 4 | 6                 */
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
   Deep-merges over defaults so missing keys stay default.
   Corrupt or absent storage: defaults used silently.
═══════════════════════════════════════ */

function loadSettings() {
  try {
    const saved = localStorage.getItem('obsideum:settings');
    if (saved) Object.assign(STATE.settings, JSON.parse(saved));
  } catch (_) { /* corrupt storage — defaults stand */ }
}

/* ═══════════════════════════════════════
   loadTrades()
   Restores trade history from localStorage.
   Called at init — before any render or swap.js wires up.
   recordTrade() in swap.js writes back after each confirmed swap.
═══════════════════════════════════════ */

function loadTrades() {
  try {
    const saved = localStorage.getItem('obsideum:trades');
    if (saved) STATE.trades = JSON.parse(saved);
  } catch (_) { /* corrupt storage — empty array stands */ }
}

/* ═══════════════════════════════════════
   loadPortfolioCache()
   Restores portfolio balances from localStorage.
   Called at init — stale balances are displayed instantly
   while portfolio.js fetches fresh on-chain data.
   Corrupt or absent storage: empty object stands.
═══════════════════════════════════════ */

function loadPortfolioCache() {
  try {
    const saved = localStorage.getItem('obsideum:portfolio:v1');
    if (saved) STATE.portfolioBalances = JSON.parse(saved);
  } catch (_) { /* corrupt storage — empty object stands */ }
}

/* ═══════════════════════════════════════
   savePortfolioCache(chainId, balances)
   Persists one chain's balances into STATE.portfolioBalances
   and writes the full map to localStorage.
   Called by portfolio.js after each successful balance fetch.
   Exported to window scope — accessible from portfolio.js.
═══════════════════════════════════════ */

function savePortfolioCache(chainId, balances) {
  try {
    STATE.portfolioBalances[chainId] = balances;
    localStorage.setItem('obsideum:portfolio:v1', JSON.stringify(STATE.portfolioBalances));
  } catch (_) { /* storage full or blocked — fail silently */ }
}

window.savePortfolioCache = savePortfolioCache;

/* ═══════════════════════════════════════
   INIT
   All loaders run immediately — before any HTML renders
   or other scripts execute.

   NOTE: No window.ethereum listeners here.
   Privy (wallet.js, Phase 6A) is the single connection layer —
   it handles accountsChanged, chainChanged, and disconnect
   for all wallet types: injected, embedded, and social login.
═══════════════════════════════════════ */

loadSettings();
loadTrades();
loadPortfolioCache();
