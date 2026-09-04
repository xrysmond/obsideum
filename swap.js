/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — swap.js
   Phase 5A — Swap UI (complete)
   Phase 5B — Uniswap V3 direct: Quoter V2 · SwapRouter02 · MEV
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CONTRACTS + CONSTANTS
  ════════════════════════════════════════════════════════ */
  var SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
  var QUOTER_V2      = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
  var FLASHBOTS_RPC  = 'https://rpc.flashbots.net';
  var DEFAULT_FEE    = 3000;   /* 0.30% — highest-liquidity pool tier       */
  var FEE_FACTOR     = 0.9975; /* 0.25% interface fee — applied to display  */

  var WETH_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  var USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  /* ════════════════════════════════════════════════════════
     ABIs

     Quoter V2 — quoteExactInputSingle is called via callStatic.
     It is NOT a view function (it touches state internally to
     simulate the swap), but callStatic makes it read-only:
     no gas, no tx, no wallet required.

     SwapRouter02 (IV3SwapRouter interface) — exactInputSingle
     does NOT include deadline in the struct. That is correct.
     Deadline is set at the multicall wrapper level, which reverts
     the entire batch if the block timestamp exceeds it.
     This is the canonical pattern for SwapRouter02.
  ════════════════════════════════════════════════════════ */
  var QUOTER_V2_ABI = [
    'function quoteExactInputSingle(' +
    '  (address tokenIn, address tokenOut, uint256 amountIn,' +
    '   uint24 fee, uint160 sqrtPriceLimitX96) params' +
    ') external returns (' +
    '  uint256 amountOut, uint160 sqrtPriceX96After,' +
    '  uint32 initializedTicksCrossed, uint256 gasEstimate' +
    ')'
  ];

  var SWAP_ROUTER_ABI = [
    'function exactInputSingle(' +
    '  (address tokenIn, address tokenOut, uint24 fee, address recipient,' +
    '   uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params' +
    ') external payable returns (uint256 amountOut)',
    'function multicall(uint256 deadline, bytes[] data)' +
    ' external payable returns (bytes[] results)'
  ];

  var ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ];

  /* ════════════════════════════════════════════════════════
     MOCK DATA
     Shown when STATE.tokenList / STATE.prices are not yet
     populated (Phase 7A wires live Chainlink data).
     Also used as display fallback when Quoter V2 fails.
  ════════════════════════════════════════════════════════ */
  var MOCK_TOKEN_LIST = [
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether',  decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8  },
    { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', name: 'Chainlink',       decimals: 18 },
    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI',  name: 'Uniswap',        decimals: 18 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI',  name: 'Dai Stablecoin', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin',       decimals: 6  }
  ];

  var MOCK_PRICES = {
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { usd: 3247.82,  change24h:  2.61 },
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': { usd: 67420.00, change24h:  1.14 },
    '0x514910771AF9Ca656af840dff83E8264EcF986CA': { usd: 14.23,    change24h: -0.52 },
    '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984': { usd: 8.20,     change24h:  3.08 },
    '0x6B175474E89094C44Da98b954EedeAC495271d0F': { usd: 1.00,     change24h:  0.01 },
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { usd: 1.00,     change24h: -0.01 }
  };

  /* ════════════════════════════════════════════════════════
     SHARED SWAP STATE
     One object shared between desktop panel + mobile view.
     Both containers wire independent event handlers but read
     from the same S — so flipping the token in one panel
     does NOT reset the other.
  ════════════════════════════════════════════════════════ */
  var S = {
    fromAddress:  WETH_ADDR,
    toAddress:    USDC_ADDR,
    pickerTarget: null   /* 'from' | 'to' — which side the picker is open for */
  };

  /* ════════════════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════════════ */
  function tokenList() {
    return (window.STATE && STATE.tokenList && STATE.tokenList.length)
      ? STATE.tokenList : MOCK_TOKEN_LIST;
  }

  function prices() {
    return (window.STATE && STATE.prices && Object.keys(STATE.prices).length)
      ? STATE.prices : MOCK_PRICES;
  }

  function getToken(address) {
    var list = tokenList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].address === address) return list[i];
    }
    return null;
  }

  function logoUrl(address) {
    return 'https://raw.githubusercontent.com/trustwallet/assets/master/' +
           'blockchains/ethereum/assets/' + address + '/logo.png';
  }

  function fmtPrice(usd) {
    if (usd >= 1000) return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (usd >= 1)    return '$' + usd.toFixed(2);
    return '$' + usd.toFixed(6);
  }

  function fmtAmount(n) {
    if (n >= 1000000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1000)    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    if (n >= 1)       return n.toFixed(4);
    if (n >= 0.0001)  return n.toFixed(6);
    return n.toFixed(8);
  }

  /* ════════════════════════════════════════════════════════
     PROVIDER + SIGNER

     Phase 6A sets window.privyProvider (Privy EIP-1193).
     Until then, window.ethereum is the fallback for testing.
     Quotes are read-only — they work without any wallet via
     the public RPC fallback below.
  ════════════════════════════════════════════════════════ */

  /* Cached fallback — only instantiated once, only when needed */
  var _fallbackProvider = null;

  function getReadProvider() {
    /* Prefer wallet provider — same network, better consistency */
    var pp = window.privyProvider || window.ethereum;
    if (pp) return new ethers.providers.Web3Provider(pp);
    /* No wallet: use public RPC so quotes work before connection */
    if (!_fallbackProvider) {
      _fallbackProvider = new ethers.providers.JsonRpcProvider('https://eth.llamarpc.com');
    }
    return _fallbackProvider;
  }

  function getWalletProvider() {
    var pp = window.privyProvider || window.ethereum;
    return pp ? new ethers.providers.Web3Provider(pp) : null;
  }

  /*
   * getSwapSigner()
   *
   * MEV protection: when enabled + on Ethereum mainnet, the user signs
   * with their normal wallet but the signed transaction is broadcast to
   * Flashbots' private relay instead of the public mempool. This prevents
   * front-running bots from seeing and sandwiching the transaction.
   *
   * signer.connect(fbProvider) routes broadcast through Flashbots while
   * keeping signing in the user's wallet.
   *
   * Phase 6A: Privy's EIP-1193 provider enables proper Flashbots routing.
   * The structure here is Phase 6A-ready — no changes to swap.js needed.
   */
  async function getSwapSigner() {
    var walletProvider = getWalletProvider();
    if (!walletProvider) throw new Error('No wallet connected');
    var signer = walletProvider.getSigner();
    if (window.STATE && STATE.settings.mevProtection && STATE.network === 1) {
      var fbProvider = new ethers.providers.JsonRpcProvider(FLASHBOTS_RPC);
      return signer.connect(fbProvider);
    }
    return signer;
  }

  /* ════════════════════════════════════════════════════════
     PRICE IMPACT
     Uses rawAmountOut from Quoter (before our 0.25% fee)
     vs the spot rate from Chainlink/mock prices.
     Impact = how much worse than spot the execution rate is.
  ════════════════════════════════════════════════════════ */
  function calcPriceImpact(amountInBN, rawAmountOutBN, fromAddress, toAddress, decimalsIn, decimalsOut) {
    var p         = prices();
    var fromPrice = p[fromAddress] && p[fromAddress].usd;
    var toPrice   = p[toAddress]   && p[toAddress].usd;
    if (!fromPrice || !toPrice) return null;

    var amountInNum  = parseFloat(ethers.utils.formatUnits(amountInBN,     decimalsIn));
    var amountOutNum = parseFloat(ethers.utils.formatUnits(rawAmountOutBN, decimalsOut));

    var valueInUSD      = amountInNum * fromPrice;
    var expectedAtSpot  = valueInUSD  / toPrice;
    var impact          = (1 - amountOutNum / expectedAtSpot) * 100;
    return Math.max(0, parseFloat(impact.toFixed(2)));
  }

  /* ════════════════════════════════════════════════════════
     QUOTER V2 — callStatic
     Read-only. No gas. No wallet required.
     Returns raw Uniswap amountOut before any interface fee.
  ════════════════════════════════════════════════════════ */
  async function getQuote(tokenIn, tokenOut, amountInBN) {
    var provider = getReadProvider();
    var quoter   = new ethers.Contract(QUOTER_V2, QUOTER_V2_ABI, provider);
    var result   = await quoter.callStatic.quoteExactInputSingle({
      tokenIn:           tokenIn,
      tokenOut:          tokenOut,
      amountIn:          amountInBN,
      fee:               DEFAULT_FEE,
      sqrtPriceLimitX96: ethers.BigNumber.from(0)
    });
    /* Named return values from ABI, with index fallback */
    return { amountOut: result.amountOut || result[0] };
  }

  /* ════════════════════════════════════════════════════════
     MOCK QUOTE — display-only fallback
     Used when Quoter V2 fails (RPC down, wrong network).
     _isMock = true → execute button always opens wallet sheet.
  ════════════════════════════════════════════════════════ */
  function mockQuote(fromAddress, toAddress, amountStr) {
    var val = parseFloat(amountStr);
    if (!amountStr || isNaN(val) || val <= 0) return null;
    var p  = prices();
    var fp = p[fromAddress];
    var tp = p[toAddress];
    if (!fp || !tp) return null;
    return { raw: (val * fp.usd / tp.usd) * FEE_FACTOR, impact: null };
  }

  /* ════════════════════════════════════════════════════════
     ERC-20 APPROVAL
     Checks existing allowance first — only sends approve()
     if insufficient. Approves max uint256 when autoApprove
     is on, exact amount otherwise.
  ════════════════════════════════════════════════════════ */
  async function ensureAllowance(tokenAddress, amountNeeded, signer) {
    var token     = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    var owner     = await signer.getAddress();
    var allowance = await token.allowance(owner, SWAP_ROUTER_02);
    if (allowance.gte(amountNeeded)) return; /* already sufficient */
    var approveAmount = (window.STATE && STATE.settings.autoApprove)
      ? ethers.constants.MaxUint256
      : amountNeeded;
    var tx = await token.approve(SWAP_ROUTER_02, approveAmount);
    await tx.wait();
  }

  /* ════════════════════════════════════════════════════════
     TRADE RECORDER
     Prepends to STATE.trades and persists to localStorage.
     Called by executeSwap() after tx.wait() confirms.
  ════════════════════════════════════════════════════════ */
  function recordTrade(hash, fromToken, toToken, fromAmountStr, toAmountNum, valueUSD) {
    var trade = {
      hash:       hash,
      timestamp:  Date.now(),
      fromSymbol: fromToken.symbol,
      toSymbol:   toToken.symbol,
      fromAmount: fromAmountStr,
      toAmount:   fmtAmount(toAmountNum),
      valueUSD:   parseFloat(valueUSD.toFixed(2)),
      network:    window.STATE ? STATE.network : 1,
      type:       'spot'
    };
    if (window.STATE) {
      STATE.trades.unshift(trade);
      try { localStorage.setItem('obsideum:trades', JSON.stringify(STATE.trades)); } catch (_) {}
    }
  }

  /* ════════════════════════════════════════════════════════
     EXECUTE SWAP
     Flow: approve (if needed) → build calldata → multicall
     with deadline → wait for receipt → recordTrade.

     Deadline at the multicall level is the correct pattern for
     SwapRouter02. The multicall function reverts the entire
     batch if block.timestamp > deadline — same protection as
     the old SwapRouter's per-struct deadline, but composable.

     callbacks: { onApproving, onConfirming, onSuccess, onError }
  ════════════════════════════════════════════════════════ */
  async function executeSwap(tokenIn, tokenOut, amountInBN, rawAmountOutBN, fromToken, toToken, fromAmountStr, callbacks) {
    try {
      var signer = await getSwapSigner();

      /* ── Slippage — applied to raw Uniswap output, not to display amount ── */
      var slippageBps = Math.round((window.STATE ? STATE.settings.slippage : 0.5) * 100);
      var minOut      = rawAmountOutBN.mul(10000 - slippageBps).div(10000);

      /* ── Approval ── */
      callbacks.onApproving();
      await ensureAllowance(tokenIn, amountInBN, signer);

      /* ── Build swap calldata ── */
      callbacks.onConfirming();
      var router    = new ethers.Contract(SWAP_ROUTER_02, SWAP_ROUTER_ABI, signer);
      var recipient = (window.STATE && STATE.wallet) ? STATE.wallet : await signer.getAddress();

      var callData = router.interface.encodeFunctionData('exactInputSingle', [{
        tokenIn:           tokenIn,
        tokenOut:          tokenOut,
        fee:               DEFAULT_FEE,
        recipient:         recipient,
        amountIn:          amountInBN,
        amountOutMinimum:  minOut,
        sqrtPriceLimitX96: ethers.BigNumber.from(0)
      }]);

      /* ── Submit via multicall with deadline ── */
      var deadline = Math.floor(Date.now() / 1000) +
                     ((window.STATE ? STATE.settings.deadline : 20) * 60);
      var tx      = await router.multicall(deadline, [callData]);
      var receipt = await tx.wait();

      /* ── Record — use fee-adjusted display amount ── */
      var feeAdjBN    = rawAmountOutBN.mul(9975).div(10000);
      var toAmountNum = parseFloat(ethers.utils.formatUnits(feeAdjBN, toToken.decimals));
      var p           = prices();
      var fromPrice   = p[tokenIn] ? p[tokenIn].usd : 0;
      var amountInNum = parseFloat(ethers.utils.formatUnits(amountInBN, fromToken.decimals));

      recordTrade(receipt.transactionHash, fromToken, toToken, fromAmountStr, toAmountNum, amountInNum * fromPrice);

      callbacks.onSuccess(receipt.transactionHash);

    } catch (err) {
      callbacks.onError(err);
    }
  }

  /* ════════════════════════════════════════════════════════
     LOGO FALLBACK
  ════════════════════════════════════════════════════════ */
  function logoFallback(img, fallbackEl, symbol) {
    if (!img) return;
    img.onerror = function () {
      img.style.display = 'none';
      if (fallbackEl) {
        fallbackEl.textContent   = symbol ? symbol[0] : '?';
        fallbackEl.style.display = 'flex';
      }
    };
  }

  /* ════════════════════════════════════════════════════════
     BUILD SWAP CARD HTML
  ════════════════════════════════════════════════════════ */
  function buildSwapHTML(fromToken, toToken) {
    var p     = prices();
    var fp    = p[fromToken.address];
    var tp    = p[toToken.address];
    var fpStr = fp ? fmtPrice(fp.usd) : null;
    var tpStr = tp ? fmtPrice(tp.usd) : null;

    var chevron =
      '<svg class="swap-chevron" width="8" height="5" viewBox="0 0 8 5" fill="none">' +
      '<path class="swap-chevron-path" d="M1 1l3 3 3-3"' +
      ' stroke="rgba(107,112,144,.55)" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function slotSel(idPrefix, token) {
      return '<div class="swap-selector" id="' + idPrefix + '-selector" role="button" tabindex="0">' +
        '<img class="swap-token-logo" id="' + idPrefix + '-logo"' +
        ' src="' + logoUrl(token.address) + '" alt="' + token.symbol + '" width="22" height="22">' +
        '<div class="swap-token-logo-fallback" style="display:none">' + token.symbol[0] + '</div>' +
        '<span class="swap-token-symbol" id="' + idPrefix + '-symbol">' + token.symbol + '</span>' +
        chevron + '</div>';
    }

    return (
      /* ─── SWAP CARD ─── */
      '<div class="swap-card glass-p" id="swap-card">' +

        '<div>' +
          '<span class="swap-side-label">FROM</span>' +
          '<div class="swap-slot" id="swap-from">' +
            slotSel('from', fromToken) +
            '<input class="swap-amount" id="from-amount" type="text"' +
            ' inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false">' +
            '<span class="swap-balance" id="from-balance">' +
              (fpStr ? 'Price \u00b7 ' + fpStr : 'Balance \u2014') +
            '</span>' +
          '</div>' +
        '</div>' +

        '<div class="swap-dir-wrap">' +
          '<button class="swap-dir-btn" id="swap-dir" aria-label="Flip swap direction">\u21c5</button>' +
        '</div>' +

        '<div>' +
          '<span class="swap-side-label">TO</span>' +
          '<div class="swap-slot" id="swap-to">' +
            slotSel('to', toToken) +
            '<div class="swap-amount-out" id="to-amount">\u2014</div>' +
            '<span class="swap-balance" id="to-balance">' +
              (tpStr ? 'Price \u00b7 ' + tpStr : 'Balance \u2014') +
            '</span>' +
          '</div>' +
        '</div>' +

        '<div class="swap-meta">' +
          '<span class="swap-rate" id="swap-rate">\u2014</span>' +
          '<span class="swap-fee">Fee \u00b7 <span class="swap-fee-value">0.25%</span></span>' +
        '</div>' +

        '<div class="swap-impact" id="swap-impact" hidden>' +
          '<span class="swap-impact-label">Price Impact</span>' +
          '<span class="swap-impact-value" id="impact-value">\u2014</span>' +
        '</div>' +

        '<button class="btn btn-primary swap-execute" id="swap-execute" disabled>' +
          '<div class="btn-pulse-ring"></div>' +
          '<div class="btn-inner">' +
            '<div class="glass-sheen"></div>' +
            '<span id="exec-label">EXECUTE SWAP</span>' +
          '</div>' +
        '</button>' +

      '</div>' +

      /* ─── SUCCESS STATE ─── */
      '<div class="swap-success" id="swap-success" hidden>' +
        '<div class="success-ring">' +
          '<svg class="success-check" viewBox="0 0 48 48" width="32" height="32">' +
            '<polyline class="check-line" points="8,26 20,38 40,14"' +
            ' stroke="var(--up)" stroke-width="2.5" fill="none"' +
            ' stroke-linecap="round" stroke-linejoin="round"' +
            ' stroke-dasharray="52" stroke-dashoffset="52"/>' +
          '</svg>' +
        '</div>' +
        '<span class="success-label">Swap Complete</span>' +
        '<span class="success-sublabel">Transaction confirmed</span>' +
        '<div class="success-hash" id="success-hash"></div>' +
        '<a class="success-etherscan" id="success-etherscan"' +
        ' href="#" target="_blank" rel="noopener" hidden>View on Etherscan \u2197</a>' +
        '<button class="btn btn-primary swap-again" id="swap-again" hidden>' +
          '<div class="btn-pulse-ring"></div>' +
          '<div class="btn-inner"><div class="glass-sheen"></div><span>SWAP AGAIN</span></div>' +
        '</button>' +
      '</div>'
    );
  }

  /* ════════════════════════════════════════════════════════
     WIRE A MOUNTED CARD
     All DOM queries scoped to `container` — safe for
     simultaneous desktop right panel + mobile swap view.
  ════════════════════════════════════════════════════════ */
  function wireCard(container) {
    var fromInput  = container.querySelector('#from-amount');
    var toAmountEl = container.querySelector('#to-amount');
    var rateEl     = container.querySelector('#swap-rate');
    var impactEl   = container.querySelector('#swap-impact');
    var impactVal  = container.querySelector('#impact-value');
    var executeBtn = container.querySelector('#swap-execute');
    var execLabel  = container.querySelector('#exec-label');
    var dirBtn     = container.querySelector('#swap-dir');
    var swapCard   = container.querySelector('#swap-card');
    var swapSucc   = container.querySelector('#swap-success');

    var _debounce   = null;
    var _rotation   = 0;
    var _quoteSeq   = 0;     /* increments on every input — cancels stale responses */
    var _isMock     = false; /* true → display only, execute blocked                */
    var _lastQuote  = null;  /* { rawAmountOutBN, amountInBN, impact }              */
    var _confirming = false; /* true → two-click high-impact gate is armed          */
    var _confirmTmr = null;

    /* ── Logo fallbacks ── */
    ['from', 'to'].forEach(function (side) {
      var img = container.querySelector('#' + side + '-logo');
      logoFallback(img, img && img.nextElementSibling,
        (container.querySelector('#' + side + '-symbol') || {}).textContent || '?');
    });

    /* ── Reset exec button ── */
    function resetExecBtn(label) {
      _confirming = false;
      clearTimeout(_confirmTmr);
      executeBtn.classList.remove('confirm', 'confirming');
      if (execLabel) execLabel.textContent = label || 'EXECUTE SWAP';
    }

    /* ── Set exec button label based on current state ── */
    function updateExecLabel(impact) {
      resetExecBtn();
      if (_isMock || !window.STATE || !STATE.connected) {
        if (execLabel) execLabel.textContent = 'CONNECT WALLET';
      } else if (impact !== null && impact > 5 && !(window.STATE && STATE.settings.expertMode)) {
        if (execLabel) execLabel.textContent = 'EXECUTE SWAP (' + impact.toFixed(1) + '% IMPACT)';
      } else {
        if (execLabel) execLabel.textContent = 'EXECUTE SWAP';
      }
    }

    /* ── Display a resolved quote ── */
    function showQuoteResult(amountOutNum, impact, fromTok, toTok) {
      /* Output fade-in */
      toAmountEl.classList.remove('quoting');
      toAmountEl.style.transition = 'opacity 60ms var(--ease-in)';
      toAmountEl.style.opacity    = '0';
      setTimeout(function () {
        toAmountEl.textContent      = fmtAmount(amountOutNum);
        toAmountEl.classList.add('has-value');
        toAmountEl.style.opacity    = '1';
        toAmountEl.style.transition = 'opacity 120ms var(--ease-out)';
      }, 60);

      /* Rate line */
      var p  = prices();
      var fp = p[S.fromAddress];
      var tp = p[S.toAddress];
      if (fp && tp) {
        rateEl.textContent = '1 ' + fromTok.symbol + ' \u2248 ' +
          fmtAmount((fp.usd / tp.usd) * FEE_FACTOR) + ' ' + toTok.symbol;
        rateEl.classList.add('has-rate');
      }

      /* Price impact display */
      if (impact !== null && impact > 1) {
        impactEl.hidden = false;
        impactVal.textContent = impact.toFixed(2) + '%';
        impactEl.classList.toggle('high', impact > 5);
      } else {
        impactEl.hidden = true;
        impactEl.classList.remove('high');
      }

      /* Exec button */
      executeBtn.disabled = false;
      updateExecLabel(impact);
    }

    /* ── Async quote (Quoter V2, with mock fallback) ── */
    async function updateOutput() {
      var raw = fromInput ? fromInput.value.trim() : '';
      var val = raw.replace(/\.$/, ''); /* trailing dot — valid while typing, strip for parse */

      if (!val || isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
        toAmountEl.textContent = '\u2014';
        toAmountEl.classList.remove('has-value', 'quoting');
        toAmountEl.style.opacity = '1';
        rateEl.textContent = '\u2014';
        rateEl.classList.remove('has-rate');
        impactEl.hidden = true;
        executeBtn.disabled = true;
        _lastQuote = null;
        _isMock    = false;
        resetExecBtn();
        return;
      }

      var fromTok = getToken(S.fromAddress);
      var toTok   = getToken(S.toAddress);
      if (!fromTok || !toTok) return;

      /* Parse — guard excess decimals (USDC has 6, input might have more) */
      var amountInBN;
      try {
        amountInBN = ethers.utils.parseUnits(val, fromTok.decimals);
      } catch (_) {
        var dot = val.indexOf('.');
        if (dot !== -1) val = val.slice(0, dot + 1 + fromTok.decimals);
        if (fromInput) fromInput.value = val;
        try { amountInBN = ethers.utils.parseUnits(val, fromTok.decimals); }
        catch (__) { return; }
      }

      /* Quoting indicator */
      toAmountEl.classList.add('quoting');
      toAmountEl.style.opacity = '0.35';

      /* Sequence stamp — discard any response that isn't the latest */
      var seq = ++_quoteSeq;

      try {
        var quote = await getQuote(S.fromAddress, S.toAddress, amountInBN);
        if (seq !== _quoteSeq) return; /* newer request in flight — discard */

        var feeAdjBN     = quote.amountOut.mul(9975).div(10000);
        var amountOutNum = parseFloat(ethers.utils.formatUnits(feeAdjBN, toTok.decimals));
        var impact       = calcPriceImpact(amountInBN, quote.amountOut,
                             S.fromAddress, S.toAddress,
                             fromTok.decimals, toTok.decimals);

        _lastQuote = { rawAmountOutBN: quote.amountOut, amountInBN: amountInBN, impact: impact };
        _isMock    = false;

        showQuoteResult(amountOutNum, impact, fromTok, toTok);

      } catch (_err) {
        if (seq !== _quoteSeq) return;

        /* Quoter failed — show mock for visual continuity, block execute */
        var mq = mockQuote(S.fromAddress, S.toAddress, val);
        _lastQuote = null;
        _isMock    = true;

        if (mq) {
          showQuoteResult(mq.raw, mq.impact, fromTok, toTok);
        } else {
          toAmountEl.classList.remove('quoting');
          toAmountEl.style.opacity = '1';
          executeBtn.disabled = true;
        }
      }
    }

    /* ── Input handler — debounce 300ms ── */
    if (fromInput) {
      fromInput.addEventListener('input', function () {
        /* Sanitize — numeric only, single decimal point */
        var v = fromInput.value.replace(/[^\d.]/g, '');
        var parts = v.split('.');
        if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
        if (v !== fromInput.value) fromInput.value = v;

        /* Invalidate immediately — prevents stale execute on fast typing */
        _lastQuote = null;
        _isMock    = false;
        executeBtn.disabled = true;

        clearTimeout(_debounce);
        _debounce = setTimeout(updateOutput, 300);
      });

      fromInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { clearTimeout(_debounce); updateOutput(); }
      });
    }

    /* ── Token selectors ── */
    function openFor(side) { S.pickerTarget = side; openTokenPicker(); }

    var fromSel = container.querySelector('#from-selector');
    var toSel   = container.querySelector('#to-selector');

    if (fromSel) {
      fromSel.addEventListener('click', function () { openFor('from'); });
      fromSel.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFor('from'); }
      });
    }
    if (toSel) {
      toSel.addEventListener('click', function () { openFor('to'); });
      toSel.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFor('to'); }
      });
    }

    /* ── Direction flip ── */
    if (dirBtn) {
      dirBtn.addEventListener('click', function () {
        var tmp       = S.fromAddress;
        S.fromAddress = S.toAddress;
        S.toAddress   = tmp;

        _rotation += 180;
        dirBtn.style.transition = 'transform 300ms var(--ease-spr)';
        dirBtn.style.transform  = 'rotate(' + _rotation + 'deg)';

        /* Carry the last output into the new input field */
        var prevOut = toAmountEl.textContent.replace(/[^0-9.]/g, '');
        if (fromInput && prevOut && !isNaN(parseFloat(prevOut))) {
          fromInput.value = prevOut;
        }

        refreshCardSelectors(container);
        refreshCardBalances(container);
        _lastQuote = null;
        _isMock    = false;
        executeBtn.disabled = true;
        resetExecBtn();
        clearTimeout(_debounce);
        _debounce = setTimeout(updateOutput, 60);
      });
    }

    /* ── Success animation ── */
    function playSuccess(txHash) {
      swapCard.hidden = true;
      swapSucc.hidden = false;

      /* Checkmark draw-in */
      var line = swapSucc.querySelector('.check-line');
      if (line) {
        requestAnimationFrame(function () {
          line.style.transition       = 'stroke-dashoffset 380ms var(--ease-out)';
          line.style.strokeDashoffset = '0';
        });
      }

      /* Typewriter hash at 18ms/char */
      var hashEl = swapSucc.querySelector('#success-hash');
      if (hashEl) {
        hashEl.textContent = '';
        var chars = txHash.split('');
        var idx   = 0;
        var tw    = setInterval(function () {
          if (idx >= chars.length) { clearInterval(tw); return; }
          hashEl.textContent += chars[idx++];
        }, 18);
      }

      /* Etherscan link + Swap Again fade in after typewriter completes */
      setTimeout(function () {
        var ethEl   = swapSucc.querySelector('#success-etherscan');
        var againEl = swapSucc.querySelector('#swap-again');
        if (ethEl) {
          ethEl.href   = 'https://etherscan.io/tx/' + txHash;
          ethEl.hidden = false;
          requestAnimationFrame(function () { ethEl.classList.add('visible'); });
        }
        setTimeout(function () {
          if (againEl) {
            againEl.hidden = false;
            requestAnimationFrame(function () { againEl.classList.add('visible'); });
          }
        }, 120);
      }, txHash.length * 18 + 240);
    }

    /* ── Execute button ── */
    if (executeBtn) {
      executeBtn.addEventListener('click', function () {
        if (executeBtn.disabled) return;

        /* No wallet or mock quote — open wallet sheet */
        if (!window.STATE || !STATE.connected || _isMock || !_lastQuote) {
          if (typeof openWalletSheet === 'function') openWalletSheet();
          else if (typeof showToast  === 'function') showToast('Connect your wallet to swap', 'tok');
          return;
        }

        var impact     = _lastQuote.impact;
        var expertMode = window.STATE && STATE.settings.expertMode;

        /*
         * Two-click high-impact gate.
         * When impact > 5% and expert mode is off, first click arms the gate:
         * button turns red via .confirm class, label shows impact %.
         * Second click (or any click during the 2s window) executes.
         * If no second click within 2s, gate resets automatically.
         */
        if (impact !== null && impact > 5 && !expertMode && !_confirming) {
          _confirming = true;
          executeBtn.classList.add('confirm');
          if (execLabel) execLabel.textContent = 'CONFIRM (' + impact.toFixed(1) + '% IMPACT)';
          _confirmTmr = setTimeout(function () {
            _confirming = false;
            executeBtn.classList.remove('confirm');
            updateExecLabel(impact);
          }, 2000);
          return;
        }

        /* All gates passed — execute */
        var fromTok    = getToken(S.fromAddress);
        var toTok      = getToken(S.toAddress);
        var fromAmount = fromInput ? fromInput.value.trim() : '0';

        executeSwap(
          S.fromAddress,
          S.toAddress,
          _lastQuote.amountInBN,
          _lastQuote.rawAmountOutBN,
          fromTok,
          toTok,
          fromAmount,
          {
            onApproving: function () {
              executeBtn.disabled = true;
              executeBtn.classList.remove('confirm');
              executeBtn.classList.add('confirming');
              if (execLabel) execLabel.textContent = 'APPROVING\u2026';
            },
            onConfirming: function () {
              if (execLabel) execLabel.textContent = 'CONFIRMING\u2026';
            },
            onSuccess: function (txHash) {
              playSuccess(txHash);
            },
            onError: function (err) {
              executeBtn.disabled = false;
              executeBtn.classList.remove('confirming', 'confirm');
              _confirming = false;

              /* User rejected in wallet (code 4001) vs actual failure */
              var msg = (err && err.code === 4001)
                ? 'Transaction rejected'
                : 'Swap failed \u2014 try again';
              if (typeof showToast === 'function') showToast(msg, 'terr');

              /* Restore label */
              updateExecLabel(_lastQuote ? _lastQuote.impact : null);

              /* Shake the card */
              if (swapCard) {
                swapCard.classList.add('shake');
                setTimeout(function () { swapCard.classList.remove('shake'); }, 400);
              }
            }
          }
        );
      });
    }

    /* ── Swap Again ── */
    var swapAgain = swapSucc ? swapSucc.querySelector('#swap-again') : null;
    if (swapAgain) {
      swapAgain.addEventListener('click', function () {
        var line  = swapSucc.querySelector('.check-line');
        var ethEl = swapSucc.querySelector('#success-etherscan');
        var ag    = swapSucc.querySelector('#swap-again');
        if (line)  line.style.strokeDashoffset = '52';
        if (ethEl) { ethEl.classList.remove('visible'); ethEl.hidden = true; }
        if (ag)    { ag.classList.remove('visible');    ag.hidden    = true; }

        swapSucc.hidden = true;
        swapCard.hidden = false;

        if (fromInput) fromInput.value = '';
        toAmountEl.textContent = '\u2014';
        toAmountEl.classList.remove('has-value', 'quoting');
        toAmountEl.style.opacity = '1';
        rateEl.textContent = '\u2014';
        rateEl.classList.remove('has-rate');
        impactEl.hidden = true;
        _lastQuote  = null;
        _isMock     = false;
        _confirming = false;
        executeBtn.disabled = true;
        resetExecBtn();

        if (fromInput) setTimeout(function () { fromInput.focus(); }, 80);
      });
    }
  }

  /* ════════════════════════════════════════════════════════
     CARD STATE HELPERS
  ════════════════════════════════════════════════════════ */
  function refreshCardSelectors(container) {
    ['from', 'to'].forEach(function (side) {
      var addr  = side === 'from' ? S.fromAddress : S.toAddress;
      var token = getToken(addr);
      if (!token) return;
      var img      = container.querySelector('#' + side + '-logo');
      var fallback = img && img.nextElementSibling;
      var sym      = container.querySelector('#' + side + '-symbol');
      if (img) {
        img.src           = logoUrl(token.address);
        img.alt           = token.symbol;
        img.style.display = '';
        if (fallback) fallback.style.display = 'none';
        logoFallback(img, fallback, token.symbol);
      }
      if (sym) sym.textContent = token.symbol;
    });
  }

  function refreshCardBalances(container) {
    var p = prices();
    ['from', 'to'].forEach(function (side) {
      var addr  = side === 'from' ? S.fromAddress : S.toAddress;
      var price = p[addr];
      var el    = container.querySelector('#' + side + '-balance');
      if (el) el.textContent = price ? 'Price \u00b7 ' + fmtPrice(price.usd) : 'Balance \u2014';
    });
  }

  /* ════════════════════════════════════════════════════════
     MOUNT SWAP CARD
  ════════════════════════════════════════════════════════ */
  function mountSwapCard(container) {
    if (!container) return;

    /* Inherit token context when navigating from token detail panel */
    var preToken = window.STATE && STATE.token;
    if (preToken && preToken !== S.toAddress) {
      S.fromAddress = preToken;
    } else if (preToken && preToken === S.toAddress) {
      S.fromAddress = S.toAddress;
      S.toAddress   = (preToken === USDC_ADDR) ? WETH_ADDR : USDC_ADDR;
    }
    if (S.fromAddress === S.toAddress) {
      S.toAddress = (S.fromAddress === USDC_ADDR) ? WETH_ADDR : USDC_ADDR;
    }

    var fromToken = getToken(S.fromAddress) || tokenList()[0];
    var toToken   = getToken(S.toAddress)   || tokenList()[5] || tokenList()[1];

    /* Brief skeleton flash before real card renders */
    container.innerHTML =
      '<div class="swap-view">' +
        '<div class="swap-skeleton">' +
          '<div class="skeleton swap-skel-slot"></div>' +
          '<div class="swap-skel-dir"></div>' +
          '<div class="skeleton swap-skel-slot"></div>' +
          '<div class="skeleton swap-skel-btn"></div>' +
        '</div>' +
      '</div>';

    setTimeout(function () {
      container.innerHTML = '<div class="swap-view">' + buildSwapHTML(fromToken, toToken) + '</div>';
      wireCard(container);
    }, 320);
  }

  /* ════════════════════════════════════════════════════════
     TOKEN PICKER
  ════════════════════════════════════════════════════════ */
  var pickerOverlay = document.getElementById('token-picker-overlay');
  var pickerSearch  = document.getElementById('token-picker-search');
  var pickerList    = document.getElementById('token-picker-list');

  function buildPickerRow(token, isSelected) {
    var price = prices()[token.address];
    var div   = document.createElement('div');
    div.className = 'picker-token-row' + (isSelected ? ' selected' : '');
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', isSelected ? '-1' : '0');
    div.innerHTML =
      '<img class="picker-token-logo" src="' + logoUrl(token.address) + '"' +
      ' alt="' + token.symbol + '" width="28" height="28">' +
      '<div class="picker-token-logo-fallback" style="display:none">' + token.symbol[0] + '</div>' +
      '<div class="picker-token-info">' +
        '<span class="picker-token-name">'   + token.name   + '</span>' +
        '<span class="picker-token-symbol">' + token.symbol + '</span>' +
      '</div>' +
      (price ? '<span class="picker-token-price">' + fmtPrice(price.usd) + '</span>' : '');

    logoFallback(
      div.querySelector('.picker-token-logo'),
      div.querySelector('.picker-token-logo-fallback'),
      token.symbol
    );

    if (!isSelected) {
      function pick() {
        var side  = S.pickerTarget;
        var prev  = side === 'from' ? S.fromAddress : S.toAddress;
        var other = side === 'from' ? S.toAddress   : S.fromAddress;
        /* If picking the token that's already on the other side — swap them */
        if (token.address === other) {
          if (side === 'from') { S.fromAddress = token.address; S.toAddress   = prev; }
          else                 { S.toAddress   = token.address; S.fromAddress = prev; }
        } else {
          if (side === 'from') S.fromAddress = token.address;
          else                 S.toAddress   = token.address;
        }
        closeTokenPicker();
        refreshAllCards();
      }
      div.addEventListener('click', pick);
      div.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    }
    return div;
  }

  function renderPickerList(query) {
    if (!pickerList) return;
    pickerList.innerHTML = '';
    var lower    = query.toLowerCase().trim();
    var filtered = lower ? tokenList().filter(function (t) {
      return t.name.toLowerCase().indexOf(lower) > -1 ||
             t.symbol.toLowerCase().indexOf(lower) > -1;
    }) : tokenList();

    filtered.forEach(function (t) {
      var isCurrent = (S.pickerTarget === 'from')
        ? t.address === S.fromAddress
        : t.address === S.toAddress;
      pickerList.appendChild(buildPickerRow(t, isCurrent));
    });

    if (!filtered.length) {
      pickerList.innerHTML =
        '<div class="token-list-empty">' +
        '<span class="token-list-empty-label">No results for \u201c' + query + '\u201d</span>' +
        '</div>';
    }
  }

  function openTokenPicker() {
    if (!pickerOverlay) return;
    if (pickerSearch) pickerSearch.value = '';
    renderPickerList('');
    pickerOverlay.classList.add('open');
    if (pickerSearch) setTimeout(function () { pickerSearch.focus(); }, 140);
  }

  function closeTokenPicker() {
    if (!pickerOverlay) return;
    pickerOverlay.classList.remove('open');
    if (pickerSearch) pickerSearch.value = '';
  }

  if (pickerOverlay) {
    pickerOverlay.addEventListener('click', function (e) {
      if (e.target === pickerOverlay) closeTokenPicker();
    });
    pickerOverlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeTokenPicker();
    });
  }

  if (pickerSearch) {
    pickerSearch.addEventListener('input',   function ()  { renderPickerList(pickerSearch.value); });
    pickerSearch.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeTokenPicker(); });
  }

  /* After token pick: update both panels and re-fire quote */
  function refreshAllCards() {
    [
      document.getElementById('right-panel-content'),
      document.getElementById('mobile-swap')
    ].forEach(function (c) {
      if (!c || !c.querySelector('.swap-view')) return;
      refreshCardSelectors(c);
      refreshCardBalances(c);
      var inp = c.querySelector('#from-amount');
      if (inp && inp.value) inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /* ════════════════════════════════════════════════════════
     STATE EVENT LISTENERS
  ════════════════════════════════════════════════════════ */

  /* Desktop right panel */
  document.addEventListener('panel:render', function (e) {
    var container = document.getElementById('right-panel-content');
    if (e.detail === 'swap') {
      if (container) mountSwapCard(container);
    } else {
      var old = container && container.querySelector('.swap-view');
      if (old) old.parentNode.removeChild(old);
    }
  });

  /* Mobile swap view */
  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'swap') return;
    var container = document.getElementById('mobile-swap');
    if (container) mountSwapCard(container);
  });

  /* Live price update — refresh balance/price labels only, no re-render */
  document.addEventListener('state:prices', function () {
    [
      document.getElementById('right-panel-content'),
      document.getElementById('mobile-swap')
    ].forEach(function (c) {
      if (!c || !c.querySelector('.swap-view')) return;
      refreshCardBalances(c);
    });
  });

}());
