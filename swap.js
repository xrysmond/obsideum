/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — swap.js
   Phase 5 (rewritten): on-chain DEX via Uniswap V3.

   Quote  → QuoterV2.quoteExactInputSingle  (callStatic, all 3 fee tiers)
   Route  → getBestDirectQuote → getMultiHopQuote (WETH + USDC intermediaries)
   Exec   → SwapRouter02.exactInputSingle / exactInput
   Native → multicall(exactInput[Single], unwrapWETH9)  — no WETH UX exposed
   Approve→ ERC-20.approve  (Permit2 removed — no backend, no CORS)
   Network→ wallet_switchEthereumChain → wallet_addEthereumChain fallback

   No centralized API. No CORS risk. No API keys.
   Reads: JsonRpcProvider (public RPCs, mirrors portfolio.js).
   Writes: window.privyProvider (Privy EIP-1193 bridge).

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

'use strict';

(function () {

  /* ═══════════════════════════════════════════════════════════
     CONTRACT ADDRESSES — per chain
  ═══════════════════════════════════════════════════════════ */

  /* Uniswap V3 QuoterV2 — callStatic only, zero gas cost to caller */
  var QUOTER_V2 = {
    1:      '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    10:     '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    56:     '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    130:    '0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658',  /* docs.uniswap.org/contracts/v3/reference/deployments/unichain-deployments */
    137:    '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    8453:   '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',  /* docs.uniswap.org/contracts/v3/reference/deployments/base-deployments */
    42161:  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    43114:  '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
  };

  /* View-only quoter — pure view function, NO revert pattern, works on any public RPC.
     Primary quote path for supported chains. Falls back to QuoterV2 for others.
     Interface = QuoterV2 struct params (confirmed from IQuoter.sol in view-quoter-v3 repo).
     Source: github.com/Uniswap/view-quoter-v3 */
  var VIEW_QUOTER = {
    1:     '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
    10:    '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
    56:    '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
    137:   '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
    8453:  '0x222ca98f00ed15b1fae10b61c277703a194cf5d2',
    42161: '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
    43114: '0xf0c802dcb0cf1c4f7b953756b49d940eed190221',
  };

  /* Uniswap V3 SwapRouter02 — executes exactInput[Single] */
  var SWAP_ROUTER_02 = {
    1:      '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    10:     '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    56:     '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    130:    '0x73855d06de49d0fe4a9c42636ba96c62da12ff9c',  /* docs.uniswap.org/contracts/v3/reference/deployments/unichain-deployments */
    137:    '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    8453:   '0x2626664c2603336E57B271c5C0b26F421741e481',
    42161:  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    43114:  '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
  };

  /* Wrapped native token per chain (ETH→WETH, BNB→WBNB, etc.) */
  var WETH = {
    1:      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    10:     '0x4200000000000000000000000000000000000006',
    56:     '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    130:    '0x4200000000000000000000000000000000000006',
    137:    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    8453:   '0x4200000000000000000000000000000000000006',
    42161:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    43114:  '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
  };

  /* USDC per chain — second hop candidate for non-direct routes */
  var USDC = {
    1:      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    10:     '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    56:     '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    130:    '0x078D782a88a93fABCE4c1d6e3B50ECD6D8Ca1De3',
    137:    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    8453:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    42161:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    43114:  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6C',
  };

  /* V3 fee tiers probed in parallel: 0.05% / 0.3% / 1% */
  var FEE_TIERS = [500, 3000, 10000];

  /* Chain display metadata */
  var CHAIN_META = {
    1:      { label: 'ETH',  name: 'Ethereum'    },
    10:     { label: 'OP',   name: 'Optimism'    },
    56:     { label: 'BNB',  name: 'BNB Chain'   },
    130:    { label: 'UNI',  name: 'Unichain'    },
    137:    { label: 'POL',  name: 'Polygon'     },
    8453:   { label: 'BASE', name: 'Base'         },
    42161:  { label: 'ARB',  name: 'Arbitrum'    },
    43114:  { label: 'AVAX', name: 'Avalanche'   },
  };

  /* Native token metadata per chain (mirrors portfolio.js CHAIN_NATIVE_TOKENS) */
  var CHAIN_NATIVE = {
    1:      { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    10:     { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    56:     { address: 'NATIVE', symbol: 'BNB',  name: 'BNB',       decimals: 18 },
    130:    { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    137:    { address: 'NATIVE', symbol: 'POL',  name: 'Polygon',   decimals: 18 },
    8453:   { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    42161:  { address: 'NATIVE', symbol: 'ETH',  name: 'Ethereum',  decimals: 18 },
    43114:  { address: 'NATIVE', symbol: 'AVAX', name: 'Avalanche', decimals: 18 },
  };

  /* Native gas reserve when user hits MAX (prevents tx failure) */
  var NATIVE_GAS_RESERVE = ethers.utils.parseEther('0.0025');

  /* Block explorers for TX links in success state */
  var EXPLORER_TX = {
    1:      'https://etherscan.io/tx/',
    10:     'https://optimistic.etherscan.io/tx/',
    56:     'https://bscscan.com/tx/',
    130:    'https://uniscan.xyz/tx/',
    137:    'https://polygonscan.com/tx/',
    8453:   'https://basescan.org/tx/',
    42161:  'https://arbiscan.io/tx/',
    43114:  'https://snowtrace.io/tx/',
  };

  /* params for wallet_addEthereumChain when switching to a chain the wallet doesn't have */
  var CHAIN_ADD_PARAMS = {
    10: {
      chainId: '0xa',     chainName: 'Optimism',
      nativeCurrency: { name: 'Ether',  symbol: 'ETH',  decimals: 18 },
      rpcUrls: ['https://mainnet.optimism.io'],
      blockExplorerUrls: ['https://optimistic.etherscan.io'],
    },
    56: {
      chainId: '0x38',    chainName: 'BNB Chain',
      nativeCurrency: { name: 'BNB',    symbol: 'BNB',  decimals: 18 },
      rpcUrls: ['https://bsc-dataseed.binance.org'],
      blockExplorerUrls: ['https://bscscan.com'],
    },
    130: {
      chainId: '0x82',    chainName: 'Unichain',
      nativeCurrency: { name: 'Ether',  symbol: 'ETH',  decimals: 18 },
      rpcUrls: ['https://mainnet.unichain.org'],
      blockExplorerUrls: ['https://uniscan.xyz'],
    },
    137: {
      chainId: '0x89',    chainName: 'Polygon',
      nativeCurrency: { name: 'POL',    symbol: 'POL',  decimals: 18 },
      rpcUrls: ['https://polygon-rpc.com'],
      blockExplorerUrls: ['https://polygonscan.com'],
    },
    8453: {
      chainId: '0x2105',  chainName: 'Base',
      nativeCurrency: { name: 'Ether',  symbol: 'ETH',  decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
    },
    42161: {
      chainId: '0xa4b1',  chainName: 'Arbitrum One',
      nativeCurrency: { name: 'Ether',  symbol: 'ETH',  decimals: 18 },
      rpcUrls: ['https://arb1.arbitrum.io/rpc'],
      blockExplorerUrls: ['https://arbiscan.io'],
    },
    43114: {
      chainId: '0xa86a',  chainName: 'Avalanche C-Chain',
      nativeCurrency: { name: 'AVAX',   symbol: 'AVAX', decimals: 18 },
      rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
      blockExplorerUrls: ['https://snowtrace.io'],
    },
  };

  /* Public RPCs (mirrors portfolio.js — same providers, no duplication) */
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

  /* Trust Wallet CDN chain folder names (for logo resolution) */
  var CHAIN_FOLDERS = {
    1:     'ethereum',   10:    'optimism',  56:    'smartchain',
    137:   'polygon',    8453:  'base',       42161: 'arbitrum',
    43114: 'avalanche',
  };

  /* ═══════════════════════════════════════════════════════════
     ABIs — JSON format (more reliable than human-readable for tuple types)
  ═══════════════════════════════════════════════════════════ */

  /* View-only quoter ABI — SAME struct interface as QuoterV2.
     Confirmed from view-quoter-v3/contracts/interfaces/IQuoter.sol:
     takes QuoteExactInputSingleParams struct, returns 4 values.
     stateMutability is 'view' (no callStatic needed, but we use it anyway for safety). */
  var VIEW_QUOTER_ABI = [
    {
      inputs: [{
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      }],
      name: 'quoteExactInputSingle',
      outputs: [
        { name: 'amountOut',               type: 'uint256' },
        { name: 'sqrtPriceX96After',       type: 'uint160' },
        { name: 'initializedTicksCrossed', type: 'uint32'  },
        { name: 'gasEstimate',             type: 'uint256' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        { name: 'path',     type: 'bytes'   },
        { name: 'amountIn', type: 'uint256' },
      ],
      name: 'quoteExactInput',
      outputs: [
        { name: 'amountOut',                   type: 'uint256'   },
        { name: 'sqrtPriceX96AfterList',       type: 'uint160[]' },
        { name: 'initializedTicksCrossedList', type: 'uint32[]'  },
        { name: 'gasEstimate',                 type: 'uint256'   },
      ],
      stateMutability: 'view',
      type: 'function',
    },
  ];

  /* QuoterV2 — struct param, state-changing (revert-based), 4 return values.
     Used as fallback when view-quoter isn't deployed on the chain. */
  var QUOTER_V2_ABI = [
    {
      inputs: [{
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      }],
      name: 'quoteExactInputSingle',
      outputs: [
        { name: 'amountOut',               type: 'uint256' },
        { name: 'sqrtPriceX96After',       type: 'uint160' },
        { name: 'initializedTicksCrossed', type: 'uint32'  },
        { name: 'gasEstimate',             type: 'uint256' },
      ],
      stateMutability: 'nonpayable',
      type: 'function',
    },
    {
      inputs: [
        { name: 'path',     type: 'bytes'   },
        { name: 'amountIn', type: 'uint256' },
      ],
      name: 'quoteExactInput',
      outputs: [
        { name: 'amountOut',                   type: 'uint256'   },
        { name: 'sqrtPriceX96AfterList',       type: 'uint160[]' },
        { name: 'initializedTicksCrossedList', type: 'uint32[]'  },
        { name: 'gasEstimate',                 type: 'uint256'   },
      ],
      stateMutability: 'nonpayable',
      type: 'function',
    },
  ];

  var ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
    'function exactInput(tuple(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
    'function refundETH() payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
  ];

  var ERC20_ABI = [
    'function approve(address spender,uint256 amount) returns (bool)',
    'function allowance(address owner,address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
  ];

  /* WETH wrap/unwrap ABI — used when swapping ETH↔WETH (same underlying asset) */
  var WETH_ABI = [
    'function deposit() payable',
    'function withdraw(uint256 wad)',
  ];

  /* ═══════════════════════════════════════════════════════════
     MODULE STATE
  ═══════════════════════════════════════════════════════════ */

  /* Active token selection — shared across desktop + mobile card instances */
  var S = {
    fromAddress:  'NATIVE',
    toAddress:    null,
    pickerTarget: 'from',
  };

  /* Cached read-only JsonRpcProvider per chain (fallback) */
  var _readProviders = {};

  /* Cached Web3Provider wrapping the wallet (preferred for QuoterV2 callStatic) */
  var _walletProvider      = null;
  var _walletProviderChain = null;

  /* ═══════════════════════════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════════════════════════ */

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function isNative(addr) {
    return !addr || addr === 'NATIVE';
  }

  /* Resolve NATIVE sentinel → chain WETH address for contract calls */
  function toERC20Addr(addr, chainId) {
    return isNative(addr) ? (WETH[chainId] || addr) : addr;
  }

  /* Provider resolution — three-tier priority:
     1. Wallet's own provider (Web3Provider wrapping privyProvider) — preferred because
        it routes through Privy/MetaMask infra which fully supports QuoterV2's revert-
        based callStatic simulation. Public RPCs sometimes drop the revert data.
     2. Cached JsonRpcProvider against our public RPCs — fallback when no wallet.
     Only used for reads. All writes go through getSigner() regardless. */
  function getReadProvider(chainId) {
    var curChain = window.STATE && STATE.network && Number(STATE.network);

    /* Prefer the wallet provider when it's on the chain we're quoting */
    if (window.privyProvider && curChain && curChain === Number(chainId)) {
      if (_walletProvider && _walletProviderChain === Number(chainId)) {
        return _walletProvider;
      }
      try {
        _walletProvider      = new ethers.providers.Web3Provider(window.privyProvider);
        _walletProviderChain = Number(chainId);
        return _walletProvider;
      } catch (e) {
        console.warn('[swap] Web3Provider wrap failed, falling back to JsonRpcProvider:', e);
      }
    }

    /* Fallback: public JsonRpcProvider */
    if (!_readProviders[chainId]) {
      var rpc = CHAIN_RPC[chainId];
      if (!rpc) throw new Error('No public RPC for chain ' + chainId);
      _readProviders[chainId] = new ethers.providers.JsonRpcProvider(rpc);
    }
    return _readProviders[chainId];
  }

  /* Privy signer for write operations */
  function getSigner() {
    if (!window.privyProvider) throw new Error('NO_WALLET');
    return new ethers.providers.Web3Provider(window.privyProvider).getSigner();
  }

  /* Look up token metadata from STATE.tokenList, fall back to CHAIN_NATIVE */
  function getTokenMeta(address, chainId) {
    if (isNative(address)) return CHAIN_NATIVE[chainId] || CHAIN_NATIVE[1];
    var list = (window.STATE && STATE.tokenList) || [];
    return list.find(function (t) {
      return t.address && t.address.toLowerCase() === (address || '').toLowerCase();
    }) || null;
  }

  /* Trust Wallet CDN logo — chain-aware */
  function logoUrl(address, chainId) {
    var folder = CHAIN_FOLDERS[chainId] || 'ethereum';
    if (isNative(address)) {
      return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/' +
             folder + '/info/logo.png';
    }
    return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/' +
           folder + '/assets/' + address + '/logo.png';
  }

  /* Amount formatters */
  function fmtN(n) {
    if (n === 0) return '0';
    if (n >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
    if (n >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1)    return n.toFixed(4);
    if (n >= 1e-4) return n.toFixed(6);
    return n.toExponential(3);
  }

  function fmtUsd(n) {
    if (n == null || isNaN(n)) return '';
    return '$' + (n >= 1000
      ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : n < 0.01 ? n.toFixed(4) : n.toFixed(2));
  }

  function fmtBN(bn, decimals) {
    try { return fmtN(parseFloat(ethers.utils.formatUnits(bn, decimals || 18))); }
    catch (e) { return '—'; }
  }

  /* Read held balance from STATE.portfolioBalances as BigNumber, or null */
  function getHeldBN(address, chainId, decimals) {
    var bals = window.STATE && STATE.portfolioBalances &&
               STATE.portfolioBalances[chainId];
    var entry = bals && bals[address];
    if (!entry || entry.balance == null) return null;
    try {
      var s = String(parseFloat(entry.balance));
      /* Clamp decimal places to token decimals */
      var dot = s.indexOf('.');
      if (dot !== -1 && s.length - dot - 1 > (decimals || 18)) {
        s = parseFloat(s).toFixed(decimals || 18);
      }
      return ethers.utils.parseUnits(s, decimals || 18);
    } catch (e) { return null; }
  }

  /* Map a raw ethers error to a clean one-liner */
  function parseEthError(err) {
    if (!err) return 'Transaction failed';
    var code = err.code;
    var msg  = (err.message || String(err)).toLowerCase();
    if (code === 4001 || /user (rejected|denied)/i.test(msg)) return 'REJECTED';
    if (/insufficient funds/i.test(msg))         return 'INSUFFICIENT GAS';
    if (/nonce/i.test(msg))                      return 'NONCE CONFLICT — RETRY';
    if (/deadline|expired/i.test(msg))           return 'DEADLINE EXCEEDED';
    if (/too little received|slippage/i.test(msg)) return 'SLIPPAGE EXCEEDED';
    if (/execution reverted/i.test(msg))         return 'SWAP REVERTED';
    if (/gas/i.test(msg))                        return 'GAS ESTIMATION FAILED';
    return 'TRANSACTION FAILED';
  }

  /* Debounce factory */
  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /* ═══════════════════════════════════════════════════════════
     NETWORK SWITCHING
  ═══════════════════════════════════════════════════════════ */

  function switchNetwork(chainId) {
    return new Promise(function (resolve, reject) {
      if (!window.privyProvider) { reject(new Error('NO_WALLET')); return; }
      window.privyProvider.request({
        method:  'wallet_switchEthereumChain',
        params:  [{ chainId: '0x' + chainId.toString(16) }],
      }).then(resolve).catch(function (err) {
        /* 4902 = chain not added to wallet */
        if ((err.code === 4902 || err.code === -32603) && CHAIN_ADD_PARAMS[chainId]) {
          window.privyProvider.request({
            method: 'wallet_addEthereumChain',
            params: [CHAIN_ADD_PARAMS[chainId]],
          }).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     QUOTE ENGINE — two-tier architecture

     Tier 1: View-only quoter (pure view fn, no revert pattern, any RPC works)
             Chains: 1/10/56/137/8453/42161/43114.
             Interface = QuoterV2 struct (confirmed from IQuoter.sol source).
             Returns 4 values: amountOut, sqrtPriceX96After, ticksCrossed, gasEstimate.

     Tier 2: QuoterV2 callStatic via wallet provider (revert-based, wallet infra handles it)
             Used for Unichain (130) where view-quoter isn't deployed.
             Falls back to public JsonRpcProvider if wallet not connected.
  ═══════════════════════════════════════════════════════════ */

  /* ── View-only quoter: single fee tier, struct call, returns result or null ── */
  function _viewQuoteTier(tokenIn, tokenOut, fee, amountIn, chainId) {
    var addr = VIEW_QUOTER[chainId];
    if (!addr) return Promise.resolve(null);
    var provider = getReadProvider(chainId);
    var quoter   = new ethers.Contract(addr, VIEW_QUOTER_ABI, provider);

    /* struct call — same interface as QuoterV2 */
    return quoter.callStatic.quoteExactInputSingle({
      tokenIn:           tokenIn,
      tokenOut:          tokenOut,
      amountIn:          amountIn,
      fee:               fee,
      sqrtPriceLimitX96: 0,
    }).then(function (r) {
      /* r[0]=amountOut, r[3]=gasEstimate */
      if (!r[0] || r[0].isZero()) return null;
      return { amountOut: r[0], gasEstimate: r[3], fee: fee, isMultiHop: false };
    }).catch(function (e) {
      console.error('[swap] view-quoter failed fee=' + fee + ':', e.message || e);
      return null;
    });
  }

  /* ── QuoterV2: single fee tier via callStatic, returns amountOut+gasEstimate or null ── */
  function _v2QuoteTier(tokenIn, tokenOut, fee, amountIn, chainId) {
    var addr = QUOTER_V2[chainId];
    if (!addr) return Promise.resolve(null);
    var provider = getReadProvider(chainId);
    var quoter   = new ethers.Contract(addr, QUOTER_V2_ABI, provider);

    return quoter.callStatic.quoteExactInputSingle({
      tokenIn:           tokenIn,
      tokenOut:          tokenOut,
      amountIn:          amountIn,
      fee:               fee,
      sqrtPriceLimitX96: 0,
    }).then(function (r) {
      /* r[0]=amountOut, r[1]=sqrtPriceX96After, r[2]=ticksCrossed, r[3]=gasEstimate */
      if (!r[0] || r[0].isZero()) return null;
      return { amountOut: r[0], gasEstimate: r[3], fee: fee, isMultiHop: false };
    }).catch(function (e) {
      console.error('[swap] QuoterV2 callStatic failed fee=' + fee + ':', e.message || e);
      return null;
    });
  }

  /* ── Race all 3 fee tiers with the appropriate quoter for this chain ── */
  function getBestDirectQuote(tokenIn, tokenOut, amountIn, chainId) {
    var hasViewQuoter = !!VIEW_QUOTER[chainId];

    var tasks = FEE_TIERS.map(function (fee) {
      return hasViewQuoter
        ? _viewQuoteTier(tokenIn, tokenOut, fee, amountIn, chainId)
        : _v2QuoteTier(tokenIn, tokenOut, fee, amountIn, chainId);
    });

    return Promise.all(tasks).then(function (results) {
      var valid = results.filter(Boolean);
      if (!valid.length) return null;
      return valid.reduce(function (best, c) {
        return c.amountOut.gt(best.amountOut) ? c : best;
      });
    });
  }

  /* ── Encode V3 multi-hop path ── */
  function encodePath(tokenIn, fee1, mid, fee2, tokenOut) {
    return ethers.utils.solidityPack(
      ['address','uint24','address','uint24','address'],
      [tokenIn, fee1, mid, fee2, tokenOut]
    );
  }

  /* ── Multi-hop quotes via WETH and USDC intermediaries ── */
  function getMultiHopQuote(tokenIn, tokenOut, amountIn, chainId) {
    var weth = WETH[chainId];
    var usdc = USDC[chainId];
    var tiL  = tokenIn.toLowerCase();
    var toL  = tokenOut.toLowerCase();

    var mids = [];
    if (weth && weth.toLowerCase() !== tiL && weth.toLowerCase() !== toL) mids.push(weth);
    if (usdc && usdc.toLowerCase() !== tiL && usdc.toLowerCase() !== toL) mids.push(usdc);
    if (!mids.length) return Promise.resolve(null);

    var FEE_PAIRS   = [[500,500],[500,3000],[3000,500],[3000,3000]];
    var hasView     = !!VIEW_QUOTER[chainId];
    var viewAddr    = VIEW_QUOTER[chainId];
    var v2Addr      = QUOTER_V2[chainId];
    var provider    = getReadProvider(chainId);

    var jobs = [];
    mids.forEach(function (mid) {
      FEE_PAIRS.forEach(function (pair) {
        var path = encodePath(tokenIn, pair[0], mid, pair[1], tokenOut);

        var job;
        if (hasView && viewAddr) {
          var vq = new ethers.Contract(viewAddr, VIEW_QUOTER_ABI, provider);
          job = vq.callStatic.quoteExactInput(path, amountIn)
            .then(function (r) {
              if (!r || !r[0] || r[0].isZero()) return null;
              return {
                amountOut:    r[0],
                gasEstimate:  r[3],
                fee:          null,
                isMultiHop:   true,
                path:         path,
                intermediate: mid,
                fee1:         pair[0],
                fee2:         pair[1],
              };
            })
            .catch(function (e) {
              console.error('[swap] view multi-hop failed:', e.message || e);
              return null;
            });
        } else if (v2Addr) {
          var v2q = new ethers.Contract(v2Addr, QUOTER_V2_ABI, provider);
          job = v2q.callStatic.quoteExactInput(path, amountIn)
            .then(function (r) {
              if (!r[0] || r[0].isZero()) return null;
              return {
                amountOut:    r[0],
                gasEstimate:  r[3],
                fee:          null,
                isMultiHop:   true,
                path:         path,
                intermediate: mid,
                fee1:         pair[0],
                fee2:         pair[1],
              };
            })
            .catch(function (e) {
              console.error('[swap] v2 multi-hop failed:', e.message || e);
              return null;
            });
        } else {
          job = Promise.resolve(null);
        }

        jobs.push(job);
      });
    });

    return Promise.all(jobs).then(function (results) {
      var valid = results.filter(Boolean);
      if (!valid.length) return null;
      return valid.reduce(function (best, c) {
        return c.amountOut.gt(best.amountOut) ? c : best;
      });
    });
  }

  /* ── Master quote: direct, then multi-hop fallback ── */
  function getQuote(tokenIn, tokenOut, amountIn, chainId) {
    return getBestDirectQuote(tokenIn, tokenOut, amountIn, chainId)
      .then(function (direct) {
        if (direct) return direct;
        return getMultiHopQuote(tokenIn, tokenOut, amountIn, chainId);
      });
  }

  /* ═══════════════════════════════════════════════════════════
     WRAP / UNWRAP — ETH ↔ WETH is NOT a swap
     No Uniswap pool for WETH/WETH. Bypass the router entirely.
  ═══════════════════════════════════════════════════════════ */

  function isWrapUnwrap(fromAddr, toAddr, chainId) {
    var a = toERC20Addr(fromAddr, chainId);
    var b = toERC20Addr(toAddr,   chainId);
    return !!a && !!b && a.toLowerCase() === b.toLowerCase();
  }

  function executeWrapUnwrap(fromAddr, amountIn, chainId, signer) {
    var wethAddr = WETH[chainId];
    if (!wethAddr) return Promise.reject(new Error('No WETH on chain ' + chainId));
    var weth = new ethers.Contract(wethAddr, WETH_ABI, signer);
    return isNative(fromAddr)
      ? weth.deposit({ value: amountIn })   /* ETH → WETH */
      : weth.withdraw(amountIn);             /* WETH → ETH */
  }

  /* ═══════════════════════════════════════════════════════════
     APPROVAL — ERC-20.approve (no Permit2)
  ═══════════════════════════════════════════════════════════ */

  function ensureApproval(tokenIn, amountIn, wallet, chainId, signer, onStatus) {
    if (isNative(tokenIn)) return Promise.resolve(true);

    var routerAddr = SWAP_ROUTER_02[chainId];
    if (!routerAddr) return Promise.reject(new Error('No router for chain ' + chainId));

    var token = new ethers.Contract(tokenIn, ERC20_ABI, signer);

    return token.allowance(wallet, routerAddr).then(function (allowance) {
      if (allowance.gte(amountIn)) return true;

      var meta   = getTokenMeta(tokenIn, chainId);
      var sym    = meta ? meta.symbol : 'TOKEN';
      var useMax = window.STATE && STATE.settings && STATE.settings.autoApprove;

      onStatus('APPROVING ' + sym + '\u2026');
      return token.approve(
        routerAddr,
        useMax ? ethers.constants.MaxUint256 : amountIn
      ).then(function (tx) {
        onStatus('WAITING FOR APPROVAL\u2026');
        return tx.wait().then(function () { return true; });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     EXECUTION — SwapRouter02
     Native input:  send ETH value; router wraps it internally
     Native output: multicall(exactInput[Single], unwrapWETH9)
  ═══════════════════════════════════════════════════════════ */

  function executeSwapTx(opts) {
    var tokenInAddr  = opts.tokenInAddr;
    var tokenOutAddr = opts.tokenOutAddr;
    var amountIn     = opts.amountIn;
    var quote        = opts.quote;
    var chainId      = opts.chainId;
    var signer       = opts.signer;
    var slippage     = opts.slippage || 0.5;

    var routerAddr = SWAP_ROUTER_02[chainId];
    if (!routerAddr) return Promise.reject(new Error('No SwapRouter02 on chain ' + chainId));

    /* Resolve wallet address — opts.wallet may be null if STATE.wallet hasn't populated yet */
    var walletPromise = opts.wallet
      ? Promise.resolve(opts.wallet)
      : signer.getAddress();

    return walletPromise.then(function (wallet) {
      var router       = new ethers.Contract(routerAddr, ROUTER_ABI, signer);
      var isFromNative = isNative(tokenInAddr);
      var isToNative   = isNative(tokenOutAddr);
      var swapIn       = isFromNative ? WETH[chainId] : tokenInAddr;
      var swapOut      = isToNative   ? WETH[chainId] : tokenOutAddr;

      var bps     = Math.round(slippage * 100);
      var minOut  = quote.amountOut.mul(10000 - bps).div(10000);
      var txValue = isFromNative ? amountIn : ethers.constants.Zero;

      if (!quote.isMultiHop) {
        /* ── Single-hop: exactInputSingle ── */
        var params = {
          tokenIn:           swapIn,
          tokenOut:          swapOut,
          fee:               quote.fee,
          recipient:         isToNative ? routerAddr : wallet,
          amountIn:          amountIn,
          amountOutMinimum:  minOut,
          sqrtPriceLimitX96: 0,
        };
        if (isToNative) {
          var d1 = router.interface.encodeFunctionData('exactInputSingle', [params]);
          var d2 = router.interface.encodeFunctionData('unwrapWETH9', [minOut, wallet]);
          return router.multicall([d1, d2], { value: txValue });
        }
        return router.exactInputSingle(params, { value: txValue });

      } else {
        /* ── Multi-hop: exactInput with encoded path ── */
        var mhParams = {
          path:             quote.path,
          recipient:        isToNative ? routerAddr : wallet,
          amountIn:         amountIn,
          amountOutMinimum: minOut,
        };
        if (isToNative) {
          var d3 = router.interface.encodeFunctionData('exactInput', [mhParams]);
          var d4 = router.interface.encodeFunctionData('unwrapWETH9', [minOut, wallet]);
          return router.multicall([d3, d4], { value: txValue });
        }
        return router.exactInput(mhParams, { value: txValue });
      }
    }); /* end walletPromise.then */
  }

  /* ═══════════════════════════════════════════════════════════
     TRADE RECORDING — writes to STATE.trades + localStorage
     Schema must match what wallet.js and token detail read.
  ═══════════════════════════════════════════════════════════ */

  function recordTrade(opts) {
    var record = {
      type:       'swap',
      fromSymbol: opts.fromMeta ? opts.fromMeta.symbol : '?',
      toSymbol:   opts.toMeta   ? opts.toMeta.symbol   : '?',
      fromAmount: opts.fromAmt,
      toAmount:   opts.toAmt,
      hash:       opts.hash,
      chainId:    opts.chainId,
      timestamp:  Date.now(),
    };
    STATE.trades.unshift(record);
    try {
      localStorage.setItem('obsideum:trades', JSON.stringify(STATE.trades.slice(0, 500)));
    } catch (e) { /* storage full */ }
  }

  /* ═══════════════════════════════════════════════════════════
     HTML BUILDER
  ═══════════════════════════════════════════════════════════ */

  function _slotSelHTML(side, token, chainId) {
    var addr   = token ? token.address : null;
    var symbol = token ? (token.symbol || '\u2014') : '\u2014';
    var src    = token ? esc(logoUrl(addr, chainId)) : '';

    return (
      '<div class="swap-selector" id="' + side + '-selector"' +
          ' role="button" tabindex="0" aria-label="Select ' + side + ' token">' +
        '<img class="swap-token-logo" id="' + side + '-logo"' +
            ' src="' + src + '" alt="' + esc(symbol) + '"' +
            ' onerror="this.style.display=\'none\';' +
              'var fb=document.getElementById(\'' + side + '-logo-fb\');' +
              'if(fb){fb.style.display=\'flex\';}">' +
        '<span class="swap-token-logo-fallback" id="' + side + '-logo-fb"' +
            ' style="display:none">' + esc((symbol || '?').charAt(0)) + '</span>' +
        '<span class="swap-token-symbol" id="' + side + '-symbol">' + esc(symbol) + '</span>' +
        '<svg class="swap-chevron" viewBox="0 0 8 5" fill="none" aria-hidden="true">' +
          '<path d="M1 1L4 4L7 1" stroke="var(--dim)" stroke-width="1.5"' +
              ' stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</div>'
    );
  }

  function buildSwapHTML(fromToken, toToken, chainId) {
    var activeNets = (window.STATE && STATE.settings && STATE.settings.activeNetworks)
      || [1, 10, 8453, 42161];

    /* Chain chip row */
    var chipsHTML = activeNets.map(function (cid) {
      var m = CHAIN_META[cid];
      if (!m) return '';
      return (
        '<button class="swap-chain-chip' + (cid === chainId ? ' active' : '') + '"' +
            ' data-chain-id="' + cid + '">' +
          m.label +
        '</button>'
      );
    }).join('');

    return (
      /* ── Chain chips ── */
      '<div class="swap-chain-chips" id="swap-chain-chips">' + chipsHTML + '</div>' +

      /* ── Main card ── */
      '<div class="swap-card glass-p" id="swap-card">' +

        /* FROM section + pct row share a wrapper */
        '<div class="swap-from-section">' +
          '<span class="swap-side-label">FROM</span>' +
          '<div class="swap-slot" id="swap-from">' +
            _slotSelHTML('from', fromToken, chainId) +
            '<input class="swap-amount" id="from-amount"' +
                ' type="text" inputmode="decimal" placeholder="0"' +
                ' autocomplete="off" spellcheck="false" aria-label="Amount to swap">' +
            '<span class="swap-balance" id="from-balance">Balance \u2014</span>' +
          '</div>' +
          '<div class="swap-pct-row" id="swap-pct-row">' +
            '<button class="swap-pct-btn" data-pct="25">25%</button>' +
            '<button class="swap-pct-btn" data-pct="50">50%</button>' +
            '<button class="swap-pct-btn" data-pct="100">MAX</button>' +
          '</div>' +
        '</div>' +

        /* Direction flip */
        '<div class="swap-dir-wrap">' +
          '<button class="swap-dir-btn" id="swap-dir" aria-label="Flip tokens">' +
            '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
              '<path d="M4 1v9M4 10L2 8M4 10L6 8"' +
                  ' stroke="var(--em-2)" stroke-width="1.4"' +
                  ' stroke-linecap="round" stroke-linejoin="round"/>' +
              '<path d="M10 13V4M10 4L8 6M10 4L12 6"' +
                  ' stroke="var(--em-2)" stroke-width="1.4"' +
                  ' stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +

        /* TO section */
        '<div>' +
          '<span class="swap-side-label">TO</span>' +
          '<div class="swap-slot" id="swap-to">' +
            _slotSelHTML('to', toToken, chainId) +
            '<span class="swap-amount-out" id="to-amount">\u2014</span>' +
            '<span class="swap-balance" id="to-balance">Balance \u2014</span>' +
          '</div>' +
        '</div>' +

        /* Meta row: rate + gas + route tag */
        '<div class="swap-meta">' +
          '<span class="swap-rate" id="swap-rate">\u2014</span>' +
          '<span class="swap-gas"     id="swap-gas"></span>' +
          '<span class="swap-routing" id="swap-routing" hidden></span>' +
        '</div>' +

        /* Price impact (hidden until > 1%) */
        '<div class="swap-impact" id="swap-impact" hidden>' +
          '<span class="swap-impact-label">PRICE IMPACT</span>' +
          '<span class="swap-impact-value" id="impact-value">\u2014</span>' +
        '</div>' +

        /* Execute CTA */
        '<button class="btn btn-primary swap-execute" id="swap-execute" disabled>' +
          '<div class="btn-pulse-ring"></div>' +
          '<div class="btn-inner">' +
            '<div class="glass-sheen"></div>' +
            '<span id="exec-label">ENTER AN AMOUNT</span>' +
          '</div>' +
        '</button>' +

      '</div>' + /* .swap-card */

      /* ── Success state ── */
      '<div class="swap-success" id="swap-success" hidden>' +
        '<div class="success-ring">' +
          '<svg class="success-check" width="28" height="28" viewBox="0 0 28 28" fill="none">' +
            '<path class="check-line" d="M6 14L11 20L22 8"' +
                ' stroke="var(--up)" stroke-width="2"' +
                ' stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>' +
        '</div>' +
        '<span class="success-label">SWAPPED</span>' +
        '<span class="success-sublabel" id="success-sublabel"></span>' +
        '<span class="success-hash"     id="success-hash"></span>' +
        '<a class="success-etherscan"   id="success-etherscan"' +
            ' target="_blank" rel="noopener noreferrer">VIEW ON EXPLORER</a>' +
        '<button class="btn btn-primary swap-again" id="swap-again">' +
          '<div class="btn-pulse-ring"></div>' +
          '<div class="btn-inner"><div class="glass-sheen"></div>' +
            '<span>SWAP AGAIN</span>' +
          '</div>' +
        '</button>' +
      '</div>' +

      /* ── Error state ── */
      '<div class="swap-error" id="swap-error" hidden>' +
        '<span class="swap-error-label" id="swap-error-label">FAILED</span>' +
        '<button class="swap-retry" id="swap-retry">TRY AGAIN</button>' +
      '</div>'
    );
  }

  /* ═══════════════════════════════════════════════════════════
     CARD WIRING
     Called once per mounted .swap-view element.
     All event handlers close over local state (_quote, _quoting, etc.)
     so desktop + mobile instances are fully independent.
  ═══════════════════════════════════════════════════════════ */

  function wireCard(container) {
    /* ── DOM refs ── */
    var fromInput  = container.querySelector('#from-amount');
    var toOutput   = container.querySelector('#to-amount');
    var fromBal    = container.querySelector('#from-balance');
    var toBal      = container.querySelector('#to-balance');
    var fromSel    = container.querySelector('#from-selector');
    var toSel      = container.querySelector('#to-selector');
    var dirBtn     = container.querySelector('#swap-dir');
    var execBtn    = container.querySelector('#swap-execute');
    var execLabel  = container.querySelector('#exec-label');
    var rateEl     = container.querySelector('#swap-rate');
    var gasEl      = container.querySelector('#swap-gas');
    var routingEl  = container.querySelector('#swap-routing');
    var impactDiv  = container.querySelector('#swap-impact');
    var impactVal  = container.querySelector('#impact-value');
    var cardEl     = container.querySelector('#swap-card');
    var successDiv = container.querySelector('#swap-success');
    var errorDiv   = container.querySelector('#swap-error');
    var errorLabel = container.querySelector('#swap-error-label');
    var chipsWrap  = container.querySelector('#swap-chain-chips');
    var pctRow     = container.querySelector('#swap-pct-row');

    /* ── Quote state ── */
    var _quote           = null;
    var _quoting         = false;
    var _qtId            = 0;
    var _impactConfirmed = false;

    /* ── Accessors ── */
    function chain()     { return (window.STATE && STATE.network) || 1; }
    function fromMeta()  { return getTokenMeta(S.fromAddress, chain()); }
    function toMeta()    { return getTokenMeta(S.toAddress,   chain()); }
    function fromDec()   { var m = fromMeta(); return m ? m.decimals : 18; }
    function toDec()     { var m = toMeta();   return m ? m.decimals : 18; }

    /* ── Execute button state machine ── */
    function setExec(state, label) {
      /* state: 'disabled' | 'ready' | 'busy' | 'connect' */
      execBtn.disabled = (state !== 'ready' && state !== 'connect');
      execBtn.classList.toggle('confirming', state === 'busy');
      execLabel.textContent = label;
    }

    function refreshExecState() {
      if (!window.STATE || !STATE.connected) {
        setExec('connect', 'CONNECT WALLET'); return;
      }
      var raw = fromInput ? fromInput.value.trim() : '';
      var n   = parseFloat(raw);
      if (!raw || isNaN(n) || n <= 0) {
        setExec('disabled', 'ENTER AN AMOUNT'); return;
      }
      if (!S.toAddress) {
        setExec('disabled', 'SELECT A TOKEN'); return;
      }
      if (S.fromAddress === S.toAddress) {
        setExec('disabled', 'SELECT DIFFERENT TOKEN'); return;
      }
      /* Wrap/unwrap: skip quoting check — it's always available */
      if (_quote && _quote.isWrap) {
        var ch0 = chain();
        var held0 = getHeldBN(S.fromAddress, ch0, fromDec());
        if (held0 !== null) {
          try {
            var amtBN0 = ethers.utils.parseUnits(raw, fromDec());
            if (amtBN0.gt(held0)) { setExec('disabled', 'INSUFFICIENT BALANCE'); return; }
          } catch (e) { setExec('disabled', 'INVALID AMOUNT'); return; }
        }
        setExec('ready', isNative(S.fromAddress) ? 'WRAP ETH' : 'UNWRAP WETH'); return;
      }
      if (_quoting) {
        setExec('disabled', 'FINDING BEST RATE\u2026'); return;
      }
      if (!_quote) {
        setExec('disabled', 'NO ROUTE FOUND'); return;
      }
      /* Balance check */
      var held = getHeldBN(S.fromAddress, chain(), fromDec());
      if (held !== null) {
        try {
          var amtBN = ethers.utils.parseUnits(raw, fromDec());
          if (amtBN.gt(held)) { setExec('disabled', 'INSUFFICIENT BALANCE'); return; }
        } catch (e) { setExec('disabled', 'INVALID AMOUNT'); return; }
      }
      /* High-impact second-confirm label */
      if (impactDiv && !impactDiv.hidden && impactDiv.classList.contains('high') && !_impactConfirmed) {
        setExec('ready', 'CONFIRM HIGH IMPACT \u2014 SWAP'); return;
      }
      setExec('ready', 'EXECUTE SWAP');
    }

    /* ── Balance display ── */
    function refreshBals() {
      var ch    = chain();
      var bals  = window.STATE && STATE.portfolioBalances && STATE.portfolioBalances[ch];
      var ftMeta = fromMeta();
      var ttMeta = toMeta();

      function balLine(entry, meta) {
        if (!entry || entry.balance == null) return 'Balance \u2014';
        var n   = parseFloat(entry.balance);
        var sym = meta ? meta.symbol : '';
        var usdPart = (entry.usd && entry.usd > 0) ? '  \u00b7  ' + fmtUsd(entry.usd) : '';
        return 'Balance\u2002' + fmtN(n) + (sym ? ' ' + sym : '') + usdPart;
      }

      if (fromBal) fromBal.textContent = balLine(bals && bals[S.fromAddress], ftMeta);
      if (toBal && S.toAddress) toBal.textContent = balLine(bals && bals[S.toAddress], ttMeta);
      else if (toBal) toBal.textContent = 'Balance \u2014';
    }

    /* ── Reset output side ── */
    function resetOutput() {
      _quote = null;
      if (toOutput)  { toOutput.textContent = '\u2014'; toOutput.classList.remove('has-value'); }
      if (rateEl)    { rateEl.textContent = '\u2014'; rateEl.classList.remove('has-rate'); }
      if (gasEl)     gasEl.textContent = '';
      if (routingEl) routingEl.hidden = true;
      if (impactDiv) impactDiv.hidden = true;
      refreshExecState();
    }

    /* ── Render a resolved quote ── */
    function renderQuote(quote, raw) {
      _quote = quote;

      /* ── Wrap/unwrap path: 1:1 rate, no routing ── */
      if (quote.isWrap) {
        var outFmtW = fmtBN(quote.amountOut, toDec());
        if (toOutput) { toOutput.textContent = outFmtW; toOutput.classList.add('has-value'); }
        if (rateEl)   { rateEl.textContent = '1:1 \u00b7 no price impact'; rateEl.classList.add('has-rate'); }
        if (gasEl)    gasEl.textContent = '\u223c30k gas';
        if (routingEl){ routingEl.textContent = isNative(S.fromAddress) ? 'WETH.deposit()' : 'WETH.withdraw()'; routingEl.hidden = false; }
        if (impactDiv) impactDiv.hidden = true;
        refreshExecState();
        return;
      }

      /* Output amount */
      var outFmt = fmtBN(quote.amountOut, toDec());
      if (toOutput) { toOutput.textContent = outFmt; toOutput.classList.add('has-value'); }

      /* Exchange rate */
      try {
        var inN  = parseFloat(raw);
        var outN = parseFloat(ethers.utils.formatUnits(quote.amountOut, toDec()));
        if (inN > 0 && outN > 0) {
          var rate = outN / inN;
          var fm   = fromMeta();
          var tm   = toMeta();
          if (rateEl) {
            rateEl.textContent =
              '1\u2009' + (fm ? fm.symbol : '?') + '\u2009=\u2009' +
              fmtN(rate) + '\u2009' + (tm ? tm.symbol : '?');
            rateEl.classList.add('has-rate');
          }
        }
      } catch (e) {}

      /* Gas estimate (QuoterV2 returns gas units; display as "~XXk gas") */
      if (gasEl) {
        try {
          var gu = quote.gasEstimate && quote.gasEstimate.toNumber
            ? quote.gasEstimate.toNumber()
            : 0;
          gasEl.textContent = gu > 0 ? '\u223c' + Math.round(gu / 1000) + 'k gas' : '';
        } catch (e) { gasEl.textContent = ''; }
      }

      /* Route label */
      if (routingEl) {
        if (quote.isMultiHop) {
          var midSym = '?';
          var wch = WETH[chain()];
          var uch = USDC[chain()];
          if (wch && quote.intermediate && quote.intermediate.toLowerCase() === wch.toLowerCase()) {
            var nat = CHAIN_NATIVE[chain()];
            midSym = nat ? nat.symbol : 'WETH';
          } else if (uch && quote.intermediate && quote.intermediate.toLowerCase() === uch.toLowerCase()) {
            midSym = 'USDC';
          }
          routingEl.textContent =
            'via\u2009' + midSym + '\u2009\u00b7\u2009' +
            (quote.fee1 / 10000).toFixed(2) + '%\u2009+\u2009' +
            (quote.fee2 / 10000).toFixed(2) + '%';
          routingEl.hidden = false;
        } else {
          routingEl.textContent = 'V3\u2009\u00b7\u2009' + (quote.fee / 10000).toFixed(2) + '%';
          routingEl.hidden = false;
        }
      }

      /* Price impact (approximate, needs both token prices in STATE.prices) */
      if (impactDiv && impactVal) {
        try {
          var ch2   = chain();
          var inKey  = isNative(S.fromAddress) ? toERC20Addr(S.fromAddress, ch2) : S.fromAddress;
          var outKey = isNative(S.toAddress)   ? toERC20Addr(S.toAddress,   ch2) : S.toAddress;
          var inP    = STATE.prices && STATE.prices[inKey]  && STATE.prices[inKey].usd;
          var outP   = STATE.prices && STATE.prices[outKey] && STATE.prices[outKey].usd;
          if (inP && outP) {
            var inVal  = parseFloat(raw) * inP;
            var outVal = parseFloat(ethers.utils.formatUnits(quote.amountOut, toDec())) * outP;
            if (inVal > 0 && outVal > 0) {
              var impact = ((inVal - outVal) / inVal) * 100;
              if (impact > 1) {
                impactVal.textContent = impact.toFixed(2) + '%';
                impactDiv.classList.toggle('high', impact > 5);
                impactDiv.hidden = false;
              } else {
                impactDiv.hidden = true;
              }
            } else { impactDiv.hidden = true; }
          } else { impactDiv.hidden = true; }
        } catch (e) { impactDiv.hidden = true; }
      }

      refreshExecState();
    }

    /* ── Debounced quote trigger ── */
    var _triggerQuote = debounce(function () {
      var raw = fromInput ? fromInput.value.trim() : '';
      var n   = parseFloat(raw);
      var ch  = chain();

      if (!raw || isNaN(n) || n <= 0 || !S.fromAddress || !S.toAddress) {
        resetOutput(); return;
      }
      if (S.fromAddress === S.toAddress) { resetOutput(); return; }

      var amtBN;
      try { amtBN = ethers.utils.parseUnits(raw, fromDec()); }
      catch (e) { resetOutput(); return; }

      /* ── Wrap/unwrap fast path — no DEX needed, instant quote ── */
      if (isWrapUnwrap(S.fromAddress, S.toAddress, ch)) {
        _quoting = false;
        var wrapQuote = { isWrap: true, amountOut: amtBN, fee: null, isMultiHop: false };
        renderQuote(wrapQuote, raw);
        return;
      }

      var swapIn  = toERC20Addr(S.fromAddress, ch);
      var swapOut = toERC20Addr(S.toAddress,   ch);

      _quoting = true;
      _qtId++;
      var myId = _qtId;
      refreshExecState();

      getQuote(swapIn, swapOut, amtBN, ch)
        .then(function (result) {
          if (myId !== _qtId) return;
          _quoting = false;
          if (result) {
            renderQuote(result, raw);
          } else {
            _quote = null;
            resetOutput();
          }
        })
        .catch(function () {
          if (myId !== _qtId) return;
          _quoting = false;
          _quote = null;
          resetOutput();
        });
    }, 500);

    /* ── Show/hide full card vs success/error ── */
    function _showCard() {
      if (cardEl)    cardEl.hidden    = false;
      if (chipsWrap) chipsWrap.hidden = false;
      if (pctRow)    pctRow.hidden    = false;
      if (successDiv) successDiv.hidden = true;
      if (errorDiv)   errorDiv.hidden   = true;
    }

    function _hideCard() {
      if (cardEl)    cardEl.hidden    = true;
      if (chipsWrap) chipsWrap.hidden = true;
      if (pctRow)    pctRow.hidden    = true;
    }

    /* ── Success state ── */
    function showSuccess(hash, ch, fm, tm, fromAmt, toAmt, successLabel) {
      _hideCard();
      if (!successDiv) return;

      var sub = successDiv.querySelector('#success-sublabel');
      var hsh = successDiv.querySelector('#success-hash');
      var lnk = successDiv.querySelector('#success-etherscan');
      var agn = successDiv.querySelector('#swap-again');
      var cl  = successDiv.querySelector('.check-line');
      var lbl = successDiv.querySelector('.success-label');

      /* Reset check animation */
      if (cl) { cl.style.transition = 'none'; cl.style.strokeDashoffset = '52'; }

      /* Override header label for wrap/unwrap */
      if (lbl) lbl.textContent = successLabel || 'SWAPPED';

      if (sub) sub.textContent =
        fromAmt + '\u2009' + (fm ? fm.symbol : '') +
        '\u2009\u2192\u2009' +
        toAmt + '\u2009' + (tm ? tm.symbol : '');

      if (hsh) hsh.textContent = hash
        ? hash.slice(0, 20) + '\u2026' + hash.slice(-8)
        : '';

      if (lnk && hash) {
        lnk.href = (EXPLORER_TX[ch] || 'https://etherscan.io/tx/') + hash;
        setTimeout(function () { lnk.classList.add('visible'); }, 700);
      }

      if (agn) {
        agn.classList.add('visible');
        agn.onclick = function () {
          if (lnk) lnk.classList.remove('visible');
          if (agn) agn.classList.remove('visible');
          successDiv.hidden = true;
          fromInput && (fromInput.value = '');
          _quote   = null;
          _quoting = false;
          _impactConfirmed = false;
          _showCard();
          resetOutput();
          refreshBals();
        };
      }

      successDiv.hidden = false;

      /* Animate checkmark */
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!cl) return;
          cl.style.transition = 'stroke-dashoffset 520ms var(--ease-spr)';
          cl.style.strokeDashoffset = '0';
        });
      });
    }

    /* ── Error state ── */
    function showSwapError(msg) {
      _hideCard();
      if (!errorDiv) return;
      if (errorLabel) errorLabel.textContent = msg || 'SWAP FAILED';
      var retry = errorDiv.querySelector('#swap-retry');
      if (retry) {
        retry.onclick = function () {
          errorDiv.hidden = true;
          _impactConfirmed = false;
          _showCard();
          refreshExecState();
        };
      }
      errorDiv.hidden = false;
    }

    /* ═══ Event listeners ═══ */

    /* FROM input */
    if (fromInput) {
      fromInput.addEventListener('input', function () {
        _impactConfirmed = false;
        resetOutput();
        _triggerQuote();
      });
    }

    /* PCT buttons */
    if (pctRow) {
      pctRow.addEventListener('click', function (e) {
        var btn = e.target.closest('.swap-pct-btn');
        if (!btn) return;
        var pct   = Number(btn.getAttribute('data-pct'));
        var ch    = chain();
        var bals  = window.STATE && STATE.portfolioBalances && STATE.portfolioBalances[ch];
        var entry = bals && bals[S.fromAddress];
        if (!entry || entry.balance == null) return;

        var bal = parseFloat(entry.balance);
        if (!bal || isNaN(bal)) return;

        var amt;
        if (pct === 100 && isNative(S.fromAddress)) {
          /* Reserve gas buffer from MAX */
          try {
            var balBN = ethers.utils.parseEther(
              parseFloat(bal).toFixed(18).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0')
            );
            var maxBN = balBN.sub(NATIVE_GAS_RESERVE);
            amt = maxBN.lte(0) ? 0 : parseFloat(ethers.utils.formatEther(maxBN));
          } catch (e2) { amt = Math.max(0, bal - 0.0025); }
        } else {
          amt = bal * pct / 100;
        }

        if (!amt || amt <= 0) return;
        var dec = fromDec();
        fromInput.value = parseFloat(amt.toFixed(Math.min(dec, 8))).toString();
        fromInput.dispatchEvent(new Event('input'));
      });
    }

    /* Direction flip */
    if (dirBtn) {
      dirBtn.addEventListener('click', function () {
        var tmp       = S.fromAddress;
        S.fromAddress = S.toAddress || 'NATIVE';
        S.toAddress   = tmp;
        _impactConfirmed = false;
        if (fromInput) fromInput.value = '';
        refreshCardSelectors(container);
        refreshBals();
        resetOutput();
      });
    }

    /* Token selectors → open picker */
    if (fromSel) {
      fromSel.addEventListener('click', function () {
        S.pickerTarget = 'from';
        openTokenPicker();
      });
    }
    if (toSel) {
      toSel.addEventListener('click', function () {
        S.pickerTarget = 'to';
        openTokenPicker();
      });
    }

    /* Chain chips */
    if (chipsWrap) {
      chipsWrap.addEventListener('click', function (e) {
        var chip = e.target.closest('.swap-chain-chip');
        if (!chip) return;
        var target = Number(chip.getAttribute('data-chain-id'));
        if (target === chain()) return;

        /* Dim all chips while the switch is pending */
        chipsWrap.querySelectorAll('.swap-chain-chip').forEach(function (c) {
          c.classList.add('switching');
        });

        switchNetwork(target).catch(function (err) {
          /* Re-enable on failure */
          chipsWrap.querySelectorAll('.swap-chain-chip').forEach(function (c) {
            c.classList.remove('switching');
          });
          var m = CHAIN_META[target];
          var label = m ? m.name : 'Network';
          var msg = (err && err.code === 4001)
            ? label + ' switch rejected'
            : label + ' switch failed';
          if (typeof showToast === 'function') showToast(msg, 'terr');
        });
        /* On success: state:network fires → remounts card automatically */
      });
    }

    /* Execute button */
    if (execBtn) {
      execBtn.addEventListener('click', function () {
        /* Connect flow */
        if (!window.STATE || !STATE.connected) {
          if (typeof connect === 'function') connect();
          return;
        }

        if (!_quote) return;

        /* High-impact: first click sets confirmed, second executes */
        if (impactDiv && !impactDiv.hidden && impactDiv.classList.contains('high')) {
          if (!_impactConfirmed) {
            _impactConfirmed = true;
            refreshExecState();
            return;
          }
        }

        var raw = fromInput ? fromInput.value.trim() : '';
        var ch  = chain();
        var fm  = fromMeta();
        var tm  = toMeta();

        var amtBN;
        try { amtBN = ethers.utils.parseUnits(raw, fromDec()); }
        catch (e) { setExec('disabled', 'INVALID AMOUNT'); return; }

        var signer;
        try { signer = getSigner(); }
        catch (e) { if (typeof connect === 'function') connect(); return; }

        /* ── WRAP / UNWRAP PATH — ETH ↔ WETH ── */
        if (_quote && _quote.isWrap) {
          setExec('busy', 'CONFIRM IN WALLET\u2026');
          executeWrapUnwrap(S.fromAddress, amtBN, ch, signer)
            .then(function (tx) {
              setExec('busy', 'PENDING\u2026');
              return tx.wait();
            })
            .then(function (receipt) {
              _impactConfirmed = false;
              var label = isNative(S.fromAddress) ? 'WRAPPED' : 'UNWRAPPED';
              showSuccess(receipt.transactionHash, ch, fm, tm, raw, raw, label);
            })
            .catch(function (err) {
              _impactConfirmed = false;
              var msg = parseEthError(err);
              if (msg === 'REJECTED') { refreshExecState(); return; }
              showSwapError(msg);
            });
          return;
        }

        /* ── SWAP PATH ── */
        setExec('busy', 'APPROVING\u2026');

        /* Resolve the wallet address from signer — avoids STATE.wallet null bug */
        signer.getAddress().then(function (walletAddr) {
          return ensureApproval(S.fromAddress, amtBN, walletAddr, ch, signer, function (lbl) {
            setExec('busy', lbl);
          }).then(function () {
            setExec('busy', 'CONFIRM IN WALLET\u2026');
            return executeSwapTx({
              tokenInAddr:  S.fromAddress,
              tokenOutAddr: S.toAddress,
              amountIn:     amtBN,
              quote:        _quote,
              chainId:      ch,
              signer:       signer,
              wallet:       walletAddr,
              slippage:     (window.STATE && STATE.settings && STATE.settings.slippage) || 0.5,
            });
          });
        })
        .then(function (tx) {
          setExec('busy', 'PENDING\u2026');
          return tx.wait().then(function (receipt) {
            recordTrade({
              fromMeta: fm,
              toMeta:   tm,
              fromAmt:  raw,
              toAmt:    fmtBN(_quote.amountOut, toDec()),
              hash:     receipt.transactionHash,
              chainId:  ch,
            });
            return receipt;
          });
        })
        .then(function (receipt) {
          _impactConfirmed = false;
          showSuccess(
            receipt.transactionHash, ch,
            fm, tm,
            raw, fmtBN(_quote.amountOut, toDec())
          );
        })
        .catch(function (err) {
          _impactConfirmed = false;
          var msg = parseEthError(err);
          if (msg === 'REJECTED') { refreshExecState(); return; }
          showSwapError(msg);
        });
      });
    }

    /* Balance refresh signal (dispatched on .swap-view by state:portfolioBalances) */
    container.addEventListener('swap:refreshBals', function () { refreshBals(); });

    /* Exec state refresh signal (dispatched on .swap-view by state:connected) */
    container.addEventListener('swap:refreshExec', function () { refreshExecState(); });

    /* ── Initial render ── */
    refreshBals();
    refreshExecState();
  }

  /* ═══════════════════════════════════════════════════════════
     SELECTOR REFRESH — updates token logos + symbols in place
  ═══════════════════════════════════════════════════════════ */

  function refreshCardSelectors(container) {
    var ch = (window.STATE && STATE.network) || 1;

    function updateSlot(side, address) {
      var meta   = getTokenMeta(address, ch);
      if (!meta) return;
      var symbol = meta.symbol || '?';
      var src    = logoUrl(address, ch);

      var logo  = container.querySelector('#' + side + '-logo');
      var logofb = container.querySelector('#' + side + '-logo-fb');
      var symEl = container.querySelector('#' + side + '-symbol');

      if (logo) {
        logo.src   = src;
        logo.alt   = symbol;
        logo.style.display = '';
        logo.onerror = function () {
          logo.style.display = 'none';
          if (logofb) { logofb.textContent = symbol.charAt(0); logofb.style.display = 'flex'; }
        };
      }
      if (logofb) { logofb.textContent = symbol.charAt(0); logofb.style.display = 'none'; }
      if (symEl)  symEl.textContent = symbol;
    }

    updateSlot('from', S.fromAddress);
    if (S.toAddress) updateSlot('to', S.toAddress);
  }

  /* ═══════════════════════════════════════════════════════════
     TOKEN PICKER — shared overlay, wired once at boot
  ═══════════════════════════════════════════════════════════ */

  function _pickerRowHTML(token, chainId) {
    var addr   = token.address;
    var symbol = token.symbol || '?';
    var name   = token.name   || '';
    var src    = esc(logoUrl(addr, chainId));

    var priceEntry = window.STATE && STATE.prices &&
                     STATE.prices[isNative(addr) ? toERC20Addr(addr, chainId) : addr];
    var priceStr = (priceEntry && priceEntry.usd) ? fmtUsd(priceEntry.usd) : '';

    return (
      '<div class="picker-token-row" data-address="' + esc(addr) + '"' +
          ' role="button" tabindex="0">' +
        '<img class="picker-token-logo" src="' + src + '" alt="' + esc(symbol) + '"' +
            ' onerror="this.style.display=\'none\';' +
              'var fb=this.nextElementSibling;if(fb){fb.style.display=\'flex\';}">' +
        '<span class="picker-token-logo-fallback" style="display:none">' +
          esc((symbol || '?').charAt(0)) +
        '</span>' +
        '<div class="picker-token-info">' +
          '<span class="picker-token-name">'   + esc(name)   + '</span>' +
          '<span class="picker-token-symbol">' + esc(symbol) + '</span>' +
        '</div>' +
        (priceStr ? '<span class="picker-token-price">' + esc(priceStr) + '</span>' : '') +
      '</div>'
    );
  }

  function _renderPickerChains() {
    var chipsEl = document.getElementById('picker-chain-chips');
    if (!chipsEl) return;
    var activeNets = (window.STATE && STATE.settings && STATE.settings.activeNetworks)
      || [1, 10, 8453, 42161];
    var ch = (window.STATE && STATE.network) || 1;
    chipsEl.innerHTML = activeNets.map(function (cid) {
      var m = CHAIN_META[cid];
      if (!m) return '';
      return (
        '<button class="picker-chain-chip' + (cid === ch ? ' active' : '') + '"' +
            ' data-chain-id="' + cid + '">' +
          m.label +
        '</button>'
      );
    }).join('');
  }

  function _renderPickerList(query) {
    var listEl = document.getElementById('token-picker-list');
    if (!listEl) return;

    var ch     = (window.STATE && STATE.network) || 1;
    var native = CHAIN_NATIVE[ch] || CHAIN_NATIVE[1];
    var list   = (window.STATE && STATE.tokenList) || [];
    var tokens = [native].concat(list.filter(function (t) {
      return t.address && t.address !== 'NATIVE';
    }));

    var q = (query || '').trim().toLowerCase();
    if (q) {
      tokens = tokens.filter(function (t) {
        return (t.symbol  && t.symbol.toLowerCase().indexOf(q)  !== -1) ||
               (t.name    && t.name.toLowerCase().indexOf(q)    !== -1) ||
               (t.address && t.address.toLowerCase()            === q);
      });
    }

    if (!tokens.length) {
      listEl.innerHTML = '<div class="picker-empty">No tokens found</div>';
      return;
    }

    listEl.innerHTML = tokens.slice(0, 80).map(function (t) {
      return _pickerRowHTML(t, ch);
    }).join('');
  }

  function openTokenPicker() {
    var overlay = document.getElementById('token-picker-overlay');
    var inp     = document.getElementById('token-picker-search');
    if (!overlay) return;

    _renderPickerChains();
    _renderPickerList('');

    /* CSS transitions handle everything — just add the class.
     * No inline style manipulation: the JS double-RAF was fighting the CSS
     * transition and causing the animation to snap to end state mid-flight. */
    overlay.classList.add('open');

    setTimeout(function () { inp && inp.focus(); }, 180);
  }
  function closeTokenPicker() {
    var overlay = document.getElementById('token-picker-overlay');
    if (!overlay) return;

    /* Remove class — CSS transitions the overlay and picker back to hidden state.
     * No inline style reset needed: we never set inline styles in openTokenPicker. */
    overlay.classList.remove('open');

    /* Clear search after the CSS transition finishes so there's no flash-of-empty */
    setTimeout(function () {
      var inp = document.getElementById('token-picker-search');
      if (inp) inp.value = '';
    }, 240);
  }

  function wireTokenPicker() {
    var overlay = document.getElementById('token-picker-overlay');
    var searchInp = document.getElementById('token-picker-search');
    var listEl    = document.getElementById('token-picker-list');
    if (!overlay) return;

    /* Backdrop close */
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeTokenPicker();
    });

    /* Search filter */
    if (searchInp) {
      searchInp.addEventListener('input', function () {
        _renderPickerList(searchInp.value);
      });
    }

    /* Row selection */
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        var row = e.target.closest('.picker-token-row');
        if (!row) return;
        var addr = row.getAttribute('data-address');
        if (!addr) return;

        if (S.pickerTarget === 'from') {
          if (addr === S.toAddress) S.toAddress = S.fromAddress;
          S.fromAddress = addr;
        } else {
          if (addr === S.fromAddress) S.fromAddress = S.toAddress;
          S.toAddress = addr;
        }

        closeTokenPicker();

        /* Refresh all mounted swap cards */
        ['right-panel-content', 'mobile-swap'].forEach(function (id) {
          var outer = document.getElementById(id);
          var view  = outer && outer.querySelector('.swap-view');
          if (!view) return;
          refreshCardSelectors(view);
          /* Re-quote if FROM amount already set */
          var inp = view.querySelector('#from-amount');
          if (inp && parseFloat(inp.value) > 0) inp.dispatchEvent(new Event('input'));
        });
      });

      listEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          var row = e.target.closest('.picker-token-row');
          if (row) row.click();
        }
      });
    }

    /* ── Picker chain chip selection ── */
    var pickerHeader = overlay.querySelector('.token-picker-header');
    if (pickerHeader) {
      pickerHeader.addEventListener('click', function (e) {
        var chip = e.target.closest('.picker-chain-chip');
        if (!chip) return;
        var target = Number(chip.getAttribute('data-chain-id'));
        if (target === ((window.STATE && STATE.network) || 1)) return;

        /* Dim all chips while wallet prompt is pending */
        document.querySelectorAll('.picker-chain-chip').forEach(function (c) {
          c.classList.add('switching');
        });

        switchNetwork(target).catch(function (err) {
          /* Re-enable on failure */
          document.querySelectorAll('.picker-chain-chip').forEach(function (c) {
            c.classList.remove('switching');
          });
          var m = CHAIN_META[target];
          if (typeof showToast === 'function') {
            showToast((m ? m.name : 'Network') + ' switch failed', 'terr');
          }
        });
        /* On success: state:network → loadTokenList → state:tokenList → picker re-renders */
      });
    }

    /* Re-render picker when token list loads (after chain switch or initial load) */
    document.addEventListener('state:tokenList', function () {
      var ov = document.getElementById('token-picker-overlay');
      if (!ov || !ov.classList.contains('open')) return;
      var searchInp = document.getElementById('token-picker-search');
      _renderPickerChains();
      _renderPickerList(searchInp ? searchInp.value : '');
    });
  }

  /* ═══════════════════════════════════════════════════════════
     MOUNT
  ═══════════════════════════════════════════════════════════ */

  function mountSwapCard(container) {
    if (!container) return;

    var ch   = (window.STATE && STATE.network) || 1;
    var list = (window.STATE && STATE.tokenList) || [];

    /* Carry STATE.token as FROM preselection (from token detail panel) */
    var preToken = window.STATE && STATE.token;
    if (preToken && preToken !== 'NATIVE' && getTokenMeta(preToken, ch)) {
      if (preToken.toLowerCase() !== (S.toAddress || '').toLowerCase()) {
        S.fromAddress = preToken;
      } else {
        /* Pretoken is already in TO — put it in FROM, pick default TO */
        S.fromAddress = preToken;
        S.toAddress   = null;
      }
    }

    /* Default FROM: native */
    if (!S.fromAddress) S.fromAddress = 'NATIVE';

    /* Default TO: first ERC-20 that isn't WETH or FROM */
    if (!S.toAddress) {
      var wch = WETH[ch] ? WETH[ch].toLowerCase() : '';
      var frL = S.fromAddress.toLowerCase();
      var first = list.find(function (t) {
        var al = (t.address || '').toLowerCase();
        return t.address && al !== 'native' && al !== wch && al !== frL;
      });
      S.toAddress = first ? first.address : (USDC[ch] || null);
    }

    var fromMeta = getTokenMeta(S.fromAddress, ch);
    var toMeta   = S.toAddress ? getTokenMeta(S.toAddress, ch) : null;

    container.innerHTML =
      '<div class="swap-view">' +
        buildSwapHTML(fromMeta, toMeta, ch) +
      '</div>';

    var view = container.querySelector('.swap-view');
    wireCard(view);
  }

  /* ═══════════════════════════════════════════════════════════
     STATE LISTENERS
  ═══════════════════════════════════════════════════════════ */

  /* Desktop right panel */
  document.addEventListener('panel:render', function (e) {
    if (e.detail !== 'swap') return;
    var el = document.getElementById('right-panel-content');
    if (el) mountSwapCard(el);
  });

  /* Mobile swap tab */
  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'swap') return;
    var el = document.getElementById('mobile-swap');
    if (el) mountSwapCard(el);
  });

  /* Network change — reset provider cache and remount */
  document.addEventListener('state:network', function () {
    /* Invalidate wallet provider cache — chain changed, need fresh Web3Provider */
    _walletProvider      = null;
    _walletProviderChain = null;

    S.fromAddress = 'NATIVE';
    S.toAddress   = null;
    ['right-panel-content', 'mobile-swap'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.querySelector('.swap-view')) mountSwapCard(el);
    });
  });

  /* Prices refreshed — re-quote to update price impact */
  document.addEventListener('state:prices', function () {
    ['right-panel-content', 'mobile-swap'].forEach(function (id) {
      var el   = document.getElementById(id);
      var view = el && el.querySelector('.swap-view');
      if (!view) return;
      var inp = view.querySelector('#from-amount');
      if (inp && parseFloat(inp.value) > 0) inp.dispatchEvent(new Event('input'));
    });
  });

  /* Portfolio balances updated — refresh balance lines */
  document.addEventListener('state:portfolioBalances', function () {
    ['right-panel-content', 'mobile-swap'].forEach(function (id) {
      var el   = document.getElementById(id);
      var view = el && el.querySelector('.swap-view');
      if (view) view.dispatchEvent(new CustomEvent('swap:refreshBals'));
    });
  });

  /* Connection state changed — refresh exec button */
  document.addEventListener('state:connected', function () {
    ['right-panel-content', 'mobile-swap'].forEach(function (id) {
      var el   = document.getElementById(id);
      var view = el && el.querySelector('.swap-view');
      if (!view) return;
      var execBtn = view.querySelector('#swap-execute');
      if (execBtn) execBtn.dispatchEvent(new CustomEvent('swap:refreshExec'));
    });
  });

  /* ── Boot ── */
  wireTokenPicker();

}());
