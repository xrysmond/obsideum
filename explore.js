/* ═══════════════════════════════════════════════════════════
   OBSIDEUM — explore.js  (Phase 9I-rebuild)
   Market explore tab — DeFiLlama powered, fully chain-aware.

   DATA SOURCE:
     coins.llama.fi/prices/current  — live prices, no rate limit
     coins.llama.fi/percentage      — 24h % change, parallel call

   TOKEN LIST:
     CHAIN_TOKEN_LIST — curated, all addresses pre-resolved.
     Every multi-chain token (USDC, USDT, WETH, LINK, AAVE, DAI…)
     has a SEPARATE entry per chain with the correct contract address
     for that chain. ETH on Arbitrum ≠ ETH on Ethereum. Both are
     first-class tokens with their own chain badge.

   TAP PATH:
     Synchronous. Address known at render time — stored in
     data-address/data-chain on every row. Click → setState()
     immediately. Zero async. Zero freeze risk. Every row tappable.

   LOGOS:
     TrustWallet CDN — token logos + chain logos.
     Chain badge rendered bottom-right of every token logo.
     Native tokens share the chain info logo.
     Unichain has no TW coverage → graceful fallback.

   BUG FIXES:
     ✓ Async on tap path (resolveMarketAddress) — removed entirely
     ✓ Chain logos on pills and rows — added
     ✓ ETH / multi-chain tokens not chain-aware — fixed
     ✓ Some tokens unclickable (null address) — impossible now
     ✓ Token view infinite skeleton — impossible now
     ✓ explore-view overflow clipping — fixed via style injection

   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════ */
  var CHAIN_NAMES = {
    1:      'Ethereum',
    10:     'Optimism',
    56:     'BNB Chain',
    130:    'Unichain',
    137:    'Polygon',
    8453:   'Base',
    42161:  'Arbitrum',
    43114:  'Avalanche',
  };

  var CHAIN_COLORS = {
    1:      '#627EEA',
    10:     '#FF0420',
    56:     '#F0B90B',
    130:    '#FC72FF',
    137:    '#8247E5',
    8453:   '#0052FF',
    42161:  '#12AAFF',
    43114:  '#E84142',
  };

  /*
   * TrustWallet asset repo folder per chainId.
   * Used for both chain logos (info/logo.png) and
   * token logos (assets/{checksumAddress}/logo.png).
   * null = no TW coverage — falls back to letter avatar.
   * 'smartchain' is the correct folder name for BNB Chain.
   */
  var TW_FOLDER = {
    1:      'ethereum',
    10:     'optimism',
    56:     'smartchain',
    130:    null,
    137:    'polygon',
    8453:   'base',
    42161:  'arbitrum',
    43114:  'avalanche',
  };

  var TW_CDN = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/';

  var STABLE_SYMS = {
    USDT:1, USDC:1, DAI:1, FRAX:1, TUSD:1, BUSD:1, LUSD:1,
    PYUSD:1, USDE:1, USDBC:1, GUSD:1, SUSD:1, CRVUSD:1,
    MKUSD:1, DOLA:1, AGEUR:1, EURC:1, USDP:1, FDUSD:1, USDS:1,
  };

  var CACHE_TTL_MS = 60 * 1000;  /* 60 seconds — DeFiLlama has no rate limit */

  /* ════════════════════════════════════════════════════════
     CHAIN TOKEN LIST

     Curated per-chain. Every entry has a pre-resolved address.
     Multi-chain tokens appear once per chain — separate object,
     separate address, separate chain badge.

     Fields:
       sym      — display symbol (UPPERCASE)
       name     — full display name
       chain    — chainId (number)
       address  — checksummed EIP-55 address OR 'NATIVE'
       llamaKey — DeFiLlama key (lowercase address OR coingecko:id)
       stable   — true if stablecoin
       native   — true if chain-native (ETH, BNB, MATIC, AVAX)

     NOTE: address is CHECKSUMMED for TrustWallet CDN.
           llamaKey uses LOWERCASE address for DeFiLlama API.
  ════════════════════════════════════════════════════════ */
  var CHAIN_TOKEN_LIST = {

    /* ── Ethereum mainnet ───────────────────────────── */
    1: [
      { sym:'ETH',   name:'Ether',                  chain:1, address:'NATIVE',                                     llamaKey:'coingecko:ethereum',       native:true },
      { sym:'USDT',  name:'Tether USD',             chain:1, address:'0xdAC17F958D2ee523a2206206994597C13D831ec7', llamaKey:'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7', stable:true },
      { sym:'USDC',  name:'USD Coin',               chain:1, address:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', llamaKey:'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', stable:true },
      { sym:'WBTC',  name:'Wrapped Bitcoin',        chain:1, address:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', llamaKey:'ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' },
      { sym:'DAI',   name:'Dai Stablecoin',         chain:1, address:'0x6B175474E89094C44Da98b954EedeAC495271d0F', llamaKey:'ethereum:0x6b175474e89094c44da98b954eedeac495271d0f', stable:true },
      { sym:'WETH',  name:'Wrapped Ether',          chain:1, address:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', llamaKey:'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
      { sym:'LINK',  name:'Chainlink',              chain:1, address:'0x514910771AF9Ca656af840dff83E8264EcF986CA', llamaKey:'ethereum:0x514910771af9ca656af840dff83e8264ecf986ca' },
      { sym:'UNI',   name:'Uniswap',                chain:1, address:'0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', llamaKey:'ethereum:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984' },
      { sym:'AAVE',  name:'Aave',                   chain:1, address:'0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', llamaKey:'ethereum:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9' },
      { sym:'MKR',   name:'Maker',                  chain:1, address:'0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', llamaKey:'ethereum:0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2' },
      { sym:'CRV',   name:'Curve DAO Token',        chain:1, address:'0xD533a949740bb3306d119CC777fa900bA034cd52', llamaKey:'ethereum:0xd533a949740bb3306d119cc777fa900ba034cd52' },
      { sym:'LDO',   name:'Lido DAO Token',         chain:1, address:'0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', llamaKey:'ethereum:0x5a98fcbea516cf06857215779fd812ca3bef1b32' },
      { sym:'SNX',   name:'Synthetix',              chain:1, address:'0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6f', llamaKey:'ethereum:0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f' },
      { sym:'COMP',  name:'Compound',               chain:1, address:'0xc00e94Cb662C3520282E6f5717214004A7f26888', llamaKey:'ethereum:0xc00e94cb662c3520282e6f5717214004a7f26888' },
      { sym:'GRT',   name:'The Graph',              chain:1, address:'0xc944E90C64B2c07662A292be6244BDf05Cda44a7', llamaKey:'ethereum:0xc944e90c64b2c07662a292be6244bdf05cda44a7' },
      { sym:'STETH', name:'Lido Staked Ether',      chain:1, address:'0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', llamaKey:'ethereum:0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
      { sym:'FRAX',  name:'Frax',                   chain:1, address:'0x853d955aCEf822Db058eb8505911ED77F175b99e', llamaKey:'ethereum:0x853d955acef822db058eb8505911ed77f175b99e', stable:true },
      { sym:'SHIB',  name:'Shiba Inu',              chain:1, address:'0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', llamaKey:'ethereum:0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce' },
      { sym:'PEPE',  name:'Pepe',                   chain:1, address:'0x6982508145454Ce325dDbE47a25d4ec3d2311933', llamaKey:'ethereum:0x6982508145454ce325ddbe47a25d4ec3d2311933' },
      { sym:'ENS',   name:'Ethereum Name Service',  chain:1, address:'0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', llamaKey:'ethereum:0xc18360217d8f7ab5e7c516566761ea12ce7f9d72' },
    ],

    /* ── Optimism ───────────────────────────────────── */
    10: [
      { sym:'ETH',   name:'Ether',                  chain:10, address:'NATIVE',                                     llamaKey:'coingecko:ethereum',        native:true },
      { sym:'USDC',  name:'USD Coin',               chain:10, address:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', llamaKey:'optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85', stable:true },
      { sym:'USDT',  name:'Tether USD',             chain:10, address:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', llamaKey:'optimism:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', stable:true },
      { sym:'WETH',  name:'Wrapped Ether',          chain:10, address:'0x4200000000000000000000000000000000000006', llamaKey:'optimism:0x4200000000000000000000000000000000000006' },
      { sym:'WBTC',  name:'Wrapped Bitcoin',        chain:10, address:'0x68f180fcCe6836688e9084f035309E29Bf0A2095', llamaKey:'optimism:0x68f180fcce6836688e9084f035309e29bf0a2095' },
      { sym:'OP',    name:'Optimism',               chain:10, address:'0x4200000000000000000000000000000000000042', llamaKey:'optimism:0x4200000000000000000000000000000000000042' },
      { sym:'LINK',  name:'Chainlink',              chain:10, address:'0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', llamaKey:'optimism:0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6' },
      { sym:'DAI',   name:'Dai Stablecoin',         chain:10, address:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', llamaKey:'optimism:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', stable:true },
      { sym:'AAVE',  name:'Aave',                   chain:10, address:'0x76FB31fb4af56892A25e32cFC43De717950c9278', llamaKey:'optimism:0x76fb31fb4af56892a25e32cfc43de717950c9278' },
      { sym:'UNI',   name:'Uniswap',                chain:10, address:'0x6fd9d7AD17242c41f7131d257212c54A0e816691', llamaKey:'optimism:0x6fd9d7ad17242c41f7131d257212c54a0e816691' },
      { sym:'SNX',   name:'Synthetix',              chain:10, address:'0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4', llamaKey:'optimism:0x8700daec35af8ff88c16bdf0418774cb3d7599b4' },
      { sym:'FRAX',  name:'Frax',                   chain:10, address:'0x2E3D870790dC77A83dd1d18184Acc7439A53f475', llamaKey:'optimism:0x2e3d870790dc77a83dd1d18184acc7439a53f475', stable:true },
      { sym:'CRV',   name:'Curve DAO Token',        chain:10, address:'0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53', llamaKey:'optimism:0x0994206dfe8de6ec6920ff4d779b0d950605fb53' },
    ],

    /* ── BNB Chain ──────────────────────────────────── */
    56: [
      { sym:'BNB',   name:'BNB',                    chain:56, address:'NATIVE',                                     llamaKey:'coingecko:binancecoin',     native:true },
      { sym:'USDT',  name:'Tether USD',             chain:56, address:'0x55d398326f99059fF775485246999027B3197955', llamaKey:'bsc:0x55d398326f99059ff775485246999027b3197955', stable:true },
      { sym:'USDC',  name:'USD Coin',               chain:56, address:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', llamaKey:'bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', stable:true },
      { sym:'WBNB',  name:'Wrapped BNB',            chain:56, address:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', llamaKey:'bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
      { sym:'ETH',   name:'Ethereum Token',         chain:56, address:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8', llamaKey:'bsc:0x2170ed0880ac9a755fd29b2688956bd959f933f8' },
      { sym:'BTCB',  name:'Bitcoin BEP2',           chain:56, address:'0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', llamaKey:'bsc:0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c' },
      { sym:'CAKE',  name:'PancakeSwap Token',      chain:56, address:'0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', llamaKey:'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' },
      { sym:'LINK',  name:'Chainlink',              chain:56, address:'0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', llamaKey:'bsc:0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd' },
      { sym:'DAI',   name:'Dai Token',              chain:56, address:'0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', llamaKey:'bsc:0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', stable:true },
      { sym:'UNI',   name:'Uniswap',                chain:56, address:'0xBf5140A22578168FD562DCcF235E5D43A02ce9B1', llamaKey:'bsc:0xbf5140a22578168fd562dccf235e5d43a02ce9b1' },
      { sym:'AAVE',  name:'Aave Token',             chain:56, address:'0xfb6115445Bff7b52FeB98650C87f44907E58f802', llamaKey:'bsc:0xfb6115445bff7b52feb98650c87f44907e58f802' },
      { sym:'DOT',   name:'Polkadot Token',         chain:56, address:'0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', llamaKey:'bsc:0x7083609fce4d1d8dc0c979aaab8c869ea2c873402' },
    ],

    /* ── Unichain ───────────────────────────────────── */
    130: [
      { sym:'ETH',   name:'Ether',                  chain:130, address:'NATIVE',                                    llamaKey:'coingecko:ethereum',        native:true },
      { sym:'WETH',  name:'Wrapped Ether',          chain:130, address:'0x4200000000000000000000000000000000000006', llamaKey:'unichain:0x4200000000000000000000000000000000000006' },
      { sym:'USDC',  name:'USD Coin',               chain:130, address:'0x078D782b760474a361dDA6e603b5bd42e027fBEE', llamaKey:'unichain:0x078d782b760474a361dda6e603b5bd42e027fbee', stable:true },
    ],

    /* ── Polygon ────────────────────────────────────── */
    137: [
      { sym:'MATIC', name:'Polygon',                chain:137, address:'NATIVE',                                    llamaKey:'coingecko:matic-network',   native:true },
      { sym:'USDC',  name:'USD Coin (PoS)',         chain:137, address:'0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', llamaKey:'polygon:0x2791bca1f2de4661ed88a30c99a7a9449aa84174', stable:true },
      { sym:'USDT',  name:'Tether USD',             chain:137, address:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F', llamaKey:'polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f', stable:true },
      { sym:'WETH',  name:'Wrapped Ether',          chain:137, address:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', llamaKey:'polygon:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619' },
      { sym:'WBTC',  name:'Wrapped Bitcoin',        chain:137, address:'0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', llamaKey:'polygon:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6' },
      { sym:'WMATIC',name:'Wrapped Matic',          chain:137, address:'0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', llamaKey:'polygon:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
      { sym:'LINK',  name:'Chainlink',              chain:137, address:'0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', llamaKey:'polygon:0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39' },
      { sym:'AAVE',  name:'Aave',                   chain:137, address:'0xD6DF932A45C0f255f85145f286eA0b292B21C90B', llamaKey:'polygon:0xd6df932a45c0f255f85145f286ea0b292b21c90b' },
      { sym:'DAI',   name:'Dai Stablecoin',         chain:137, address:'0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', llamaKey:'polygon:0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', stable:true },
      { sym:'UNI',   name:'Uniswap',                chain:137, address:'0xb33EaAd8d922B1083446DC23f610c2567fB5180f', llamaKey:'polygon:0xb33eaad8d922b1083446dc23f610c2567fb5180f' },
      { sym:'CRV',   name:'Curve DAO Token',        chain:137, address:'0x172370d5Cd63279eFa6d502DAB29171933a610AF', llamaKey:'polygon:0x172370d5cd63279efa6d502dab29171933a610af' },
      { sym:'FRAX',  name:'Frax',                   chain:137, address:'0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89', llamaKey:'polygon:0x45c32fa6df82ead1e2ef74d17b76547eddfaff89', stable:true },
    ],

    /* ── Base ───────────────────────────────────────── */
    8453: [
      { sym:'ETH',   name:'Ether',                  chain:8453, address:'NATIVE',                                   llamaKey:'coingecko:ethereum',        native:true },
      { sym:'USDC',  name:'USD Coin',               chain:8453, address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', llamaKey:'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', stable:true },
      { sym:'WETH',  name:'Wrapped Ether',          chain:8453, address:'0x4200000000000000000000000000000000000006', llamaKey:'base:0x4200000000000000000000000000000000000006' },
      { sym:'DAI',   name:'Dai Stablecoin',         chain:8453, address:'0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', llamaKey:'base:0x50c5725949a6f0c72e6c4a641f24049a917db0cb', stable:true },
      { sym:'USDT',  name:'Tether USD',             chain:8453, address:'0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', llamaKey:'base:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', stable:true },
      { sym:'CBETH', name:'Coinbase Wrapped Staked ETH', chain:8453, address:'0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', llamaKey:'base:0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22' },
      { sym:'AERO',  name:'Aerodrome Finance',      chain:8453, address:'0x940181a94A35A4569E4529A3CDfB74e38FD98631', llamaKey:'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631' },
      { sym:'LINK',  name:'Chainlink',              chain:8453, address:'0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', llamaKey:'base:0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196' },
      { sym:'USDBC', name:'USD Base Coin',          chain:8453, address:'0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', llamaKey:'base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', stable:true },
    ],

    /* ── Arbitrum One ───────────────────────────────── */
    42161: [
      { sym:'ETH',   name:'Ether',                  chain:42161, address:'NATIVE',                                  llamaKey:'coingecko:ethereum',        native:true },
      { sym:'USDC',  name:'USD Coin',               chain:42161, address:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831', llamaKey:'arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831', stable:true },
      { sym:'USDT',  name:'Tether USD',             chain:42161, address:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', llamaKey:'arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', stable:true },
      { sym:'WETH',  name:'Wrapped Ether',          chain:42161, address:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', llamaKey:'arbitrum:0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
      { sym:'WBTC',  name:'Wrapped Bitcoin',        chain:42161, address:'0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', llamaKey:'arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f' },
      { sym:'ARB',   name:'Arbitrum',               chain:42161, address:'0x912CE59144191C1204E64559FE8253a0e49E6548', llamaKey:'arbitrum:0x912ce59144191c1204e64559fe8253a0e49e6548' },
      { sym:'LINK',  name:'Chainlink',              chain:42161, address:'0xf97f4df75117a78c1A5a0DBb814Af92458539FB2', llamaKey:'arbitrum:0xf97f4df75117a78c1a5a0dbb814af92458539fb2' },
      { sym:'UNI',   name:'Uniswap',                chain:42161, address:'0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', llamaKey:'arbitrum:0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0' },
      { sym:'AAVE',  name:'Aave',                   chain:42161, address:'0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', llamaKey:'arbitrum:0xba5ddd1f9d7f570dc94a51479a000e3bce967196' },
      { sym:'DAI',   name:'Dai Stablecoin',         chain:42161, address:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', llamaKey:'arbitrum:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', stable:true },
      { sym:'GMX',   name:'GMX',                    chain:42161, address:'0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', llamaKey:'arbitrum:0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a' },
      { sym:'FRAX',  name:'Frax',                   chain:42161, address:'0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F', llamaKey:'arbitrum:0x17fc002b466eec40dae837fc4be5c67993ddbd6f', stable:true },
      { sym:'SNX',   name:'Synthetix',              chain:42161, address:'0xcBA56Cd8216FCBBF3fA6DF6EC3B170F1E5F35979', llamaKey:'arbitrum:0xcba56cd8216fcbbf3fa6df6ec3b170f1e5f35979' },
      { sym:'CRV',   name:'Curve DAO Token',        chain:42161, address:'0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978', llamaKey:'arbitrum:0x11cdb42b0eb46d95f990bedd4695a6e3fa034978' },
      { sym:'GRT',   name:'The Graph',              chain:42161, address:'0x9623063377AD1B27544C965cCd7342f7EA7e88C7', llamaKey:'arbitrum:0x9623063377ad1b27544c965ccd7342f7ea7e88c7' },
      { sym:'PENDLE',name:'Pendle',                 chain:42161, address:'0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', llamaKey:'arbitrum:0x0c880f6761f1af8d9aa9c466984b80dab9a8c9e8' },
    ],

    /* ── Avalanche C-Chain ──────────────────────────── */
    43114: [
      { sym:'AVAX',  name:'Avalanche',              chain:43114, address:'NATIVE',                                  llamaKey:'coingecko:avalanche-2',     native:true },
      { sym:'USDC',  name:'USD Coin',               chain:43114, address:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', llamaKey:'avax:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', stable:true },
      { sym:'USDT',  name:'Tether USD',             chain:43114, address:'0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', llamaKey:'avax:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', stable:true },
      { sym:'WAVAX', name:'Wrapped AVAX',           chain:43114, address:'0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', llamaKey:'avax:0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7' },
      { sym:'WETH',  name:'Wrapped Ether',          chain:43114, address:'0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', llamaKey:'avax:0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab' },
      { sym:'WBTC',  name:'Wrapped Bitcoin',        chain:43114, address:'0x50b7545627a5162F82A992c33b87aDc75187B218', llamaKey:'avax:0x50b7545627a5162f82a992c33b87adc75187b218' },
      { sym:'LINK',  name:'Chainlink',              chain:43114, address:'0x5947BB275c521040051D82396192181b413227A3', llamaKey:'avax:0x5947bb275c521040051d82396192181b413227a3' },
      { sym:'DAI',   name:'Dai Stablecoin',         chain:43114, address:'0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', llamaKey:'avax:0xd586e7f844cea2f87f50152665bcbc2c279d8d70', stable:true },
      { sym:'AAVE',  name:'Aave Token',             chain:43114, address:'0x63a72806098Bd3D9520cC43356dD78afe5D386D9', llamaKey:'avax:0x63a72806098bd3d9520cc43356dd78afe5d386d9' },
      { sym:'JOE',   name:'JoeToken',               chain:43114, address:'0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd', llamaKey:'avax:0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd' },
      { sym:'GMX',   name:'GMX',                    chain:43114, address:'0x62edc0692BD897D2295872a9FFCac5425011c661', llamaKey:'avax:0x62edc0692bd897d2295872a9ffcac5425011c661' },
    ],

  };

  /* ════════════════════════════════════════════════════════
     MODULE STATE — local only, nothing written to STATE
  ════════════════════════════════════════════════════════ */
  var _mounted        = false;  /* true once mobile-explore has been mounted */
  var _mountedDesktop = false;  /* true once desktop-explore-layout has been mounted */
  var _container      = null;   /* last-mounted container (mobile or desktop) */
  var _exploreChain   = null;
  var _category       = 'all';
  var _sortCol        = null;
  var _sortDir        = 'desc';
  var _search         = '';
  var _debounce       = null;
  var _refreshTimer   = null;

  /* Per-chain cache */
  var _cache        = {};   /* { chainId: mergedToken[] }  */
  var _cacheTime    = {};   /* { chainId: timestamp ms }   */
  var _fetchingFor  = {};   /* { chainId: Promise }        */

  /* ════════════════════════════════════════════════════════
     ACCESSORS
  ════════════════════════════════════════════════════════ */
  function getCachedData(chainId) {
    var age = Date.now() - (_cacheTime[chainId] || 0);
    return (_cache[chainId] && age < CACHE_TTL_MS) ? _cache[chainId] : null;
  }

  function getActiveNetworks() {
    return (window.STATE && STATE.settings && STATE.settings.activeNetworks) || [1];
  }

  function getWalletChain() {
    return (window.STATE && STATE.network) || 1;
  }

  /* ════════════════════════════════════════════════════════
     LOGO URL HELPERS
  ════════════════════════════════════════════════════════ */
  function chainLogoUrl(chainId) {
    var f = TW_FOLDER[chainId];
    return f ? TW_CDN + f + '/info/logo.png' : null;
  }

  function tokenLogoUrl(token) {
    var f = TW_FOLDER[token.chain];
    if (!f) return null;
    if (token.native) return TW_CDN + f + '/info/logo.png';
    return TW_CDN + f + '/assets/' + token.address + '/logo.png';
  }

  /* ════════════════════════════════════════════════════════
     DEFILLAMA FETCH
     Two parallel calls per chain: prices + 24h percentage.
     Results merged onto the static token list.
     Cache TTL: 60s. Deduplicates in-flight requests.
  ════════════════════════════════════════════════════════ */
  function fetchChain(chainId) {
    /* Return cached data immediately if fresh */
    var cached = getCachedData(chainId);
    if (cached) return Promise.resolve(cached);

    /* Deduplicate in-flight for the same chain */
    if (_fetchingFor[chainId]) return _fetchingFor[chainId];

    var tokens = CHAIN_TOKEN_LIST[chainId];
    if (!tokens || !tokens.length) return Promise.resolve([]);

    var coinsStr   = tokens.map(function (t) { return t.llamaKey; }).join(',');
    var priceUrl   = 'https://coins.llama.fi/prices/current/'  + coinsStr + '?searchWidth=4h';
    var pctUrl     = 'https://coins.llama.fi/percentage/'      + coinsStr + '?period=24h';
    var hdrs       = { Accept: 'application/json' };

    var promise = Promise.all([
      fetch(priceUrl, { headers: hdrs }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      fetch(pctUrl,   { headers: hdrs }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
    ])
    .then(function (results) {
      var priceCoins = (results[0] && results[0].coins) || {};
      var pctCoins   = (results[1] && results[1].coins) || {};

      var merged = tokens.map(function (t) {
        var coinInfo  = priceCoins[t.llamaKey] || {};
        var pct       = pctCoins[t.llamaKey];
        var price     = (typeof coinInfo.price  === 'number' && isFinite(coinInfo.price))  ? coinInfo.price  : null;
        var change24h = (typeof pct             === 'number' && isFinite(pct))             ? pct             : null;

        return {
          sym:       t.sym,
          name:      t.name,
          chain:     t.chain,
          address:   t.address,
          llamaKey:  t.llamaKey,
          stable:    t.stable  || STABLE_SYMS[t.sym] || false,
          native:    t.native  || false,
          price:     price,
          change24h: change24h,
        };
      });

      _cache[chainId]     = merged;
      _cacheTime[chainId] = Date.now();
      return merged;
    })
    .catch(function (err) {
      console.warn('[explore.js] fetchChain', chainId, err.message || err);
      /* Keep stale data on error. If no stale data, return list with null prices. */
      if (_cache[chainId]) return _cache[chainId];
      return tokens.map(function (t) {
        return {
          sym: t.sym, name: t.name, chain: t.chain, address: t.address,
          llamaKey: t.llamaKey, stable: t.stable || STABLE_SYMS[t.sym] || false,
          native: t.native || false, price: null, change24h: null,
        };
      });
    })
    .finally(function () {
      delete _fetchingFor[chainId];
    });

    _fetchingFor[chainId] = promise;
    return promise;
  }

  /* ════════════════════════════════════════════════════════
     ENSURE DATA + RENDER
  ════════════════════════════════════════════════════════ */
  function ensureAndRender(chainId) {
    var listEl = _container && _container.querySelector('#explore-list');
    if (!listEl) return;

    if (getCachedData(chainId)) {
      update();
      return;
    }

    renderSkeleton(listEl);

    fetchChain(chainId).then(function () {
      if (_exploreChain === chainId && _container) update();
    });
  }

  /* ════════════════════════════════════════════════════════
     AUTO-REFRESH — 60s rolling interval for active chain
  ════════════════════════════════════════════════════════ */
  function startAutoRefresh(chainId) {
    clearInterval(_refreshTimer);
    _refreshTimer = setInterval(function () {
      if (!_mounted || !_container) { clearInterval(_refreshTimer); return; }
      /* Bust cache and refetch silently */
      delete _cache[chainId];
      delete _cacheTime[chainId];
      fetchChain(chainId).then(function () {
        if (_mounted && _container && _exploreChain === chainId) inPlaceUpdate();
      });
    }, CACHE_TTL_MS);
  }

  /* ════════════════════════════════════════════════════════
     FILTER + SORT PIPELINE
  ════════════════════════════════════════════════════════ */
  function applyFilters(tokens) {
    var q = _search.trim().toLowerCase();

    if (q) {
      tokens = tokens.filter(function (t) {
        return t.name.toLowerCase().indexOf(q) > -1
            || t.sym.toLowerCase().indexOf(q)  > -1;
      });
    }

    if (_category === 'stables') {
      tokens = tokens.filter(function (t) { return t.stable; });
    } else if (_category === 'gainers') {
      tokens = tokens.filter(function (t) { return t.change24h !== null && t.change24h > 0; });
    } else if (_category === 'losers') {
      tokens = tokens.filter(function (t) { return t.change24h !== null && t.change24h < 0; });
    }

    var out = tokens.slice();

    if (_category === 'trending') {
      out.sort(function (a, b) { return Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0); });
    } else if (_category === 'gainers') {
      out.sort(function (a, b) { return (b.change24h || 0) - (a.change24h || 0); });
    } else if (_category === 'losers') {
      out.sort(function (a, b) { return (a.change24h || 0) - (b.change24h || 0); });
    } else if (_sortCol === 'price') {
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

    return out;
  }

  /* ════════════════════════════════════════════════════════
     FORMATTING
  ════════════════════════════════════════════════════════ */
  function fmtUSD(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return '$' + (v / 1e9).toFixed(2)  + 'B';
    if (v >= 1e6)  return '$' + (v / 1e6).toFixed(2)  + 'M';
    if (v >= 1e3)  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1)    return '$' + v.toFixed(2);
    if (v >= 0.001) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(4);
  }

  function fmtChange(c) {
    if (c === null || c === undefined || isNaN(c)) return '—';
    return (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ════════════════════════════════════════════════════════
     ROW HTML

     data-address + data-chain on every row.
     Tap handler reads these directly → setState immediately.
     No async. No resolve call. No freeze risk.
     Chain badge positioned absolute bottom-right of logo wrap.
  ════════════════════════════════════════════════════════ */
  function buildRowHtml(entry) {
    var chgValid  = entry.change24h !== null && !isNaN(entry.change24h);
    var dir       = chgValid ? (entry.change24h > 0 ? 'up' : entry.change24h < 0 ? 'dn' : '') : '';
    var arrow     = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
    var sym0      = escHtml((entry.sym || '?')[0]);
    var tLogo     = tokenLogoUrl(entry);
    var cLogo     = chainLogoUrl(entry.chain);
    var chainName = escHtml(CHAIN_NAMES[entry.chain] || 'Chain ' + entry.chain);

    return [
      '<div class="asset-row explore-row"',
        ' data-address="' + escHtml(entry.address) + '"',
        ' data-chain="'   + entry.chain + '"',
        ' role="button" tabindex="0"',
        ' aria-label="'   + escHtml(entry.sym) + ' on ' + chainName + '">',

      '<div class="asset-row-logo-wrap">',
        tLogo
          ? '<img class="asset-row-logo" src="' + escHtml(tLogo) + '" alt="' + escHtml(entry.sym) + '"'
              + ' loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
          : '',
        '<div class="asset-row-logo-fallback"' + (tLogo ? ' style="display:none"' : '') + '>' + sym0 + '</div>',
        cLogo
          ? '<img class="explore-chain-badge" src="' + escHtml(cLogo) + '" alt="' + chainName + '" loading="lazy">'
          : '',
      '</div>',

      '<div class="asset-row-identity">',
        '<span class="asset-row-name">'  + escHtml(entry.sym)  + '</span>',
        '<span class="asset-row-chain">' + escHtml(entry.name) + '</span>',
      '</div>',

      '<div class="asset-row-price">',
        '<span class="asset-row-usd">' + fmtUSD(entry.price) + '</span>',
        '<span class="asset-row-change ' + dir + '">',
          (arrow ? '<span class="explore-arrow">' + arrow + '</span>' : ''),
          chgValid ? fmtChange(entry.change24h) : '—',
        '</span>',
      '</div>',

      '</div>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     DESKTOP ROW HTML
     Extends mobile row with Volume + Market Cap columns.
     Rendered when _container is #desktop-explore-layout.
  ════════════════════════════════════════════════════════ */
  function buildRowHtmlDesktop(entry) {
    var base    = buildRowHtml(entry);
    var volStr  = (entry.volume24h !== null && entry.volume24h !== undefined) ? fmtUSD(entry.volume24h) : '—';
    var mcapStr = (entry.marketCap !== null  && entry.marketCap  !== undefined) ? fmtUSD(entry.marketCap)  : '—';
    /* Inject extra columns before the closing </div> of the row */
    return base.slice(0, base.lastIndexOf('</div>'))
      + '<div class="explore-desk-vol">'  + volStr  + '</div>'
      + '<div class="explore-desk-mcap">' + mcapStr + '</div>'
      + '</div>';
  }

  /* ════════════════════════════════════════════════════════
     SKELETON
  ════════════════════════════════════════════════════════ */
  function renderSkeleton(listEl) {
    var ws = [72, 88, 60, 95, 78, 110, 64, 82];
    listEl.innerHTML = ws.map(function (w) {
      return [
        '<div class="asset-row" style="pointer-events:none">',
          '<div class="asset-row-logo-wrap">',
            '<div class="skeleton" style="width:36px;height:36px;border-radius:50%"></div>',
          '</div>',
          '<div class="asset-row-identity">',
            '<div class="skeleton" style="width:' + w + 'px;height:10px;margin-bottom:5px;border-radius:3px"></div>',
            '<div class="skeleton" style="width:40px;height:9px;border-radius:3px"></div>',
          '</div>',
          '<div class="asset-row-price">',
            '<div class="skeleton" style="width:60px;height:10px;margin-bottom:5px;border-radius:3px;margin-left:auto"></div>',
            '<div class="skeleton" style="width:44px;height:9px;border-radius:3px;margin-left:auto"></div>',
          '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  /* ════════════════════════════════════════════════════════
     IN-PLACE PRICE UPDATE
     Updates price/change text on visible rows without
     re-rendering — preserves scroll position.
     Falls back to full update if sort order depends on values.
  ════════════════════════════════════════════════════════ */
  function inPlaceUpdate() {
    if (!_mounted || !_container) return;
    /* If sort relies on value order, full re-render is needed */
    if (_sortCol || _category === 'trending' || _category === 'gainers' || _category === 'losers') {
      update();
      return;
    }

    var data   = getCachedData(_exploreChain);
    if (!data) return;
    var listEl = _container.querySelector('#explore-list');
    if (!listEl) return;

    listEl.querySelectorAll('.explore-row').forEach(function (row) {
      var addr  = row.dataset.address;
      var cid   = Number(row.dataset.chain);
      var entry = null;
      for (var i = 0; i < data.length; i++) {
        if (data[i].address === addr && data[i].chain === cid) { entry = data[i]; break; }
      }
      if (!entry) return;

      var usdEl    = row.querySelector('.asset-row-usd');
      var changeEl = row.querySelector('.asset-row-change');

      if (usdEl) usdEl.textContent = fmtUSD(entry.price);
      if (changeEl) {
        var chgValid  = entry.change24h !== null && !isNaN(entry.change24h);
        var dir       = chgValid ? (entry.change24h > 0 ? 'up' : entry.change24h < 0 ? 'dn' : '') : '';
        var arrow     = dir === 'up' ? '▲' : dir === 'dn' ? '▼' : '';
        changeEl.className = 'asset-row-change ' + dir;
        changeEl.innerHTML = (arrow ? '<span class="explore-arrow">' + arrow + '</span>' : '')
                           + (chgValid ? fmtChange(entry.change24h) : '—');
      }
    });
  }

  /* ════════════════════════════════════════════════════════
     UPDATE — full render from cache
  ════════════════════════════════════════════════════════ */
  function update() {
    if (!_mounted || !_container) return;

    var listEl  = _container.querySelector('#explore-list');
    var countEl = _container.querySelector('#explore-count');
    if (!listEl) return;

    var data = getCachedData(_exploreChain);
    if (!data) return;

    var filtered = applyFilters(data);

    if (countEl) countEl.textContent = filtered.length ? '(' + filtered.length + ')' : '';

    if (!filtered.length) {
      listEl.innerHTML = '<div class="explore-empty">No tokens match your search.</div>';
      return;
    }

    var isDesk = _container && _container.id === 'desktop-explore-layout';
    listEl.innerHTML = filtered.map(isDesk ? buildRowHtmlDesktop : buildRowHtml).join('');

    /* Wire tap — synchronous, reads data-address + data-chain directly */
    listEl.querySelectorAll('.explore-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var addr = row.dataset.address;
        var cid  = Number(row.dataset.chain);
        if (!addr) return;
        /* Single setState call. state:token listener handles ALL navigation. */
        setState({ token: addr, tokenChainId: cid });
      });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
    });

    /* Sync sort arrow classes */
    _container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      var c = col.dataset.col;
      col.classList.toggle('sorted-asc',  _sortCol === c && _sortDir === 'asc');
      col.classList.toggle('sorted-desc', _sortCol === c && _sortDir === 'desc');
    });
  }

  /* ════════════════════════════════════════════════════════
     CHAIN PILLS HTML
     Each pill includes a chain logo img from TrustWallet CDN.
     Fallback to colored dot when TW has no coverage (Unichain).
  ════════════════════════════════════════════════════════ */
  function buildChainPills() {
    var nets = getActiveNetworks();
    return nets.map(function (cid) {
      var color  = CHAIN_COLORS[cid] || '#888';
      var active = cid === _exploreChain;
      var logo   = chainLogoUrl(cid);
      var name   = CHAIN_NAMES[cid] || 'Chain ' + cid;
      return [
        '<button class="explore-chain-pill' + (active ? ' active' : '') + '"',
          ' data-chain="' + cid + '"',
          ' style="--pill-color:' + color + '"',
          ' aria-pressed="' + active + '"',
          ' aria-label="'   + escHtml(name) + '">',
          logo
            ? '<img class="explore-chain-pill-logo" src="' + escHtml(logo) + '"'
                + ' alt="" loading="lazy" onerror="this.style.display=\'none\'">'
            : '<span class="explore-chain-pill-dot" style="background:' + color + '"></span>',
          '<span>' + escHtml(name) + '</span>',
        '</button>',
      ].join('');
    }).join('');
  }

  /* ════════════════════════════════════════════════════════
     SORT ARROW SVG
  ════════════════════════════════════════════════════════ */
  function sortArrow() {
    return [
      '<span class="explore-sort-arrow" aria-hidden="true">',
        '<svg width="7" height="10" viewBox="0 0 7 10" fill="none">',
          '<path class="sort-up-path" d="M3.5 1v8M1 3.5L3.5 1 6 3.5"',
            ' stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
          '<path class="sort-dn-path" d="M1 6.5L3.5 9 6 6.5"',
            ' stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
      '</span>',
    ].join('');
  }

  /* ════════════════════════════════════════════════════════
     CSS INJECTION
     Overrides explore CSS in app.html's style block.
     Injected once per page load.
  ════════════════════════════════════════════════════════ */
  function injectExploreStyles() {
    if (document.getElementById('explore-styles-v2')) return;
    var s = document.createElement('style');
    s.id  = 'explore-styles-v2';
    s.textContent = [
      /* Pill flex layout — required for logo img + text side-by-side */
      '.explore-chain-pill { display:flex !important; align-items:center !important; gap:6px !important; }',
      /* Chain logo img inside pill */
      '.explore-chain-pill-logo { width:16px; height:16px; border-radius:50%; object-fit:cover; flex-shrink:0; display:block; }',
      /* Colored dot fallback when no TW logo (Unichain) */
      '.explore-chain-pill-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; display:inline-block; }',
      /* Move padding-bottom off view (Bug 5 fix) */
      '.explore-view { padding-bottom:0 !important; }',
      /* Scroll padding lives on the LIST, not the container */
      '.explore-list { padding-bottom:calc(env(safe-area-inset-bottom,0px) + 80px) !important; }',
      /* Logo wrap must be relative so chain badge can absolute-position */
      '.asset-row-logo-wrap { position:relative !important; }',
      /* Chain badge — bottom-right corner of token logo */
      '.explore-chain-badge { position:absolute; bottom:-2px; right:-2px; width:14px; height:14px; border-radius:50%; border:1.5px solid var(--void); background:var(--void); object-fit:cover; pointer-events:none; display:block; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ════════════════════════════════════════════════════════
     FULL MOUNT
  ════════════════════════════════════════════════════════ */
  function mountExplore(container, isDesktop) {
    if (!container) return;

    injectExploreStyles();

    /* Default chain — wallet chain if active, else first active network */
    if (!_exploreChain) {
      var nets = getActiveNetworks();
      var wc   = getWalletChain();
      _exploreChain = (nets.indexOf(wc) > -1) ? wc : (nets[0] || 1);
    }

    container.innerHTML = [
      '<div class="explore-view">',

        '<div class="explore-search-row">',
          '<div class="explore-search-wrap">',
            '<svg class="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"',
              ' stroke="var(--dim)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"',
              ' aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-4-4"/></svg>',
            '<input class="explore-search-input" id="explore-search" type="text"',
              ' placeholder="Search name or symbol…"',
              ' value="' + escHtml(_search) + '"',
              ' autocomplete="off" autocorrect="off" spellcheck="false" inputmode="search"',
              ' aria-label="Search tokens">',
            '<button class="explore-search-clear" id="explore-search-clear"',
              ' aria-label="Clear search"' + (_search ? '' : ' hidden') + '>',
              '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">',
                '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
              '</svg>',
            '</button>',
          '</div>',
        '</div>',

        '<div class="explore-chain-pills" id="explore-chain-pills"',
          ' role="group" aria-label="Filter by chain">',
          buildChainPills(),
        '</div>',

        '<div class="explore-categories" role="tablist" aria-label="Token categories">',
          ['all','trending','gainers','losers','stables'].map(function (cat) {
            var labels = { all:'All', trending:'Trending', gainers:'Gainers', losers:'Losers', stables:'Stablecoins' };
            return '<button class="explore-cat' + (_category === cat ? ' active' : '') + '"'
              + ' data-cat="' + cat + '" role="tab">' + labels[cat] + '</button>';
          }).join(''),
        '</div>',

        '<div class="explore-col-header" aria-hidden="true">',
          '<span class="explore-col-token">',
            'TOKEN <span class="explore-count-badge" id="explore-count"></span>',
          '</span>',
          '<span class="explore-col-sortable explore-col-price" data-col="price"',
            ' role="button" tabindex="0" aria-label="Sort by price">PRICE' + sortArrow() + '</span>',
          '<span class="explore-col-sortable explore-col-change" data-col="change"',
            ' role="button" tabindex="0" aria-label="Sort by 24h change">24H' + sortArrow() + '</span>',
        '</div>',

        '<div class="explore-list" id="explore-list" role="list"></div>',

      '</div>',
    ].join('');

    _container = container;
    if (isDesktop) _mountedDesktop = true;
    else           _mounted        = true;

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
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        update();
      });
    });

    /* ── Chain pills ── */
    container.querySelectorAll('.explore-chain-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        var cid = Number(pill.dataset.chain);
        if (cid === _exploreChain) return;

        _exploreChain = cid;
        container.querySelectorAll('.explore-chain-pill').forEach(function (p) {
          var active = Number(p.dataset.chain) === cid;
          p.classList.toggle('active', active);
          p.setAttribute('aria-pressed', String(active));
        });

        startAutoRefresh(cid);
        ensureAndRender(cid);
      });
    });

    /* ── Sort columns ── */
    container.querySelectorAll('.explore-col-sortable').forEach(function (col) {
      function handleSort() {
        var c    = col.dataset.col;
        _sortDir = (_sortCol === c && _sortDir === 'desc') ? 'asc' : 'desc';
        _sortCol = c;
        _category = 'all';
        container.querySelectorAll('.explore-cat').forEach(function (b) { b.classList.remove('active'); });
        var allBtn = container.querySelector('[data-cat="all"]');
        if (allBtn) allBtn.classList.add('active');
        update();
      }
      col.addEventListener('click', handleSort);
      col.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(); }
      });
    });

    /* ── Initial load ── */
    startAutoRefresh(_exploreChain);
    ensureAndRender(_exploreChain);
  }

  /* ════════════════════════════════════════════════════════
     STATE LISTENERS
  ════════════════════════════════════════════════════════ */

  /* ════════════════════════════════════════════════════════
     STATE LISTENERS
  ════════════════════════════════════════════════════════ */

  /* Mobile tab activated */
  document.addEventListener('state:mobileTab', function (e) {
    if (e.detail !== 'explore') return;
    var container = document.getElementById('mobile-explore');
    if (!container) return;

    if (!_mounted) {
      mountExplore(container, false);
    } else {
      /* Switch active container back to mobile if user was on desktop */
      _container = container;
      ensureAndRender(_exploreChain);
    }
  });

  /* Desktop view activated — fired by app.html setDesktopView('explore') */
  document.addEventListener('desktop:explore', function () {
    var container = document.getElementById('desktop-explore-layout');
    if (!container) return;

    if (!_mountedDesktop) {
      mountExplore(container, true);
    } else {
      _container = container;
      ensureAndRender(_exploreChain);
    }
  });

}());
