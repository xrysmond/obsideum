/* ═══════════════════════════════════════════════════════════════════
   OBSIDEUM — swap.js
   Phase 5A — Swap UI (complete)
   Phase 5B — Uniswap Trading API: quotes · routing · execution · UniswapX
   Flags 1–5 resolved. Docs-verified. Production grade.
   UNCHAINED9. Built by Waeven Xrysmond.
═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════
     CONSTANTS — Phase 5B

     Trading API base URL verified at:
     api-docs.uniswap.org/api-reference/swapping/quote
     API key provided by Waeven Xrysmond.

     No SWAP_ROUTER_02, QUOTER_V2, FLASHBOTS_RPC, DEFAULT_FEE,
     FEE_FACTOR, or TRADING_API_ROUTER — all removed in Phase 5B.
     Approval is handled by /check_approval endpoint (Permit2).
     MEV protection is UniswapX routing, not Flashbots broadcast.
  ════════════════════════════════════════════════════════ */
  var UNISWAP_API_KEY  = '7ydkXOSzAfaM4oimvBHhPEDsujSgqE_KTd3yhIaKGqs';
  var UNISWAP_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';

  /* Request header — must be consistent across /quote, /check_approval, /swap, /order */
  var UNISWAP_ROUTER_VERSION = '2.0';

  var WETH_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  var USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  /* ════════════════════════════════════════════════════════
     ABIs
     ERC-20 retained only for balance reads if needed in future.
     All approval logic now handled by /check_approval endpoint.
  ════════════════════════════════════════════════════════ */
  var ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ];

  /* ════════════════════════════════════════════════════════
     MOCK DATA
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
  ════════════════════════════════════════════════════════ */
  var S = {
    fromAddress:  WETH_ADDR,
    toAddress:    USDC_ADDR,
    pickerTarget: null
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
     Phase 6A: window.privyProvider (Privy EIP-1193) slots in here.
     MEV protection = UniswapX routing via Trading API — no Flashbots.
  ════════════════════════════════════════════════════════ */
  var _fallbackProvider = null;

  function getReadProvider() {
    var pp = window.privyProvider || window.ethereum;
    if (pp) return new ethers.providers.Web3Provider(pp);
    if (!_fallbackProvider) {
      _fallbackProvider = new ethers.providers.JsonRpcProvider('https://eth.llamarpc.com');
    }
    return _fallbackProvider;
  }

  function getWalletProvider() {
    var pp = window.privyProvider || window.ethereum;
    return pp ? new ethers.providers.Web3Provider(pp) : null;
  }

  async function getSwapSigner() {
    var wp = getWalletProvider();
    if (!wp) throw new Error('No wallet connected');
    return wp.getSigner();
  }

  /* ════════════════════════════════════════════════════════
     TRADING API — SHARED HEADERS
  ════════════════════════════════════════════════════════ */
  function apiHeaders() {
    return {
      'Content-Type':            'application/json',
      'x-api-key':               UNISWAP_API_KEY,
      'x-universal-router-version': UNISWAP_ROUTER_VERSION
    };
  }

  /* ════════════════════════════════════════════════════════
     ROUTE HELPERS — docs-verified field names

     isDutchRoute: routing field = "DUTCH_V2" | "DUTCH_V3" | "DUTCH_LIMIT"
     (all Dutch variants contain the string 'DUTCH')

     extractAmountOut:
       Classic → quoteResponse.quote.output.amount
       Dutch   → quoteResponse.quote.orderInfo.outputs[0].endAmount
                 (endAmount = guaranteed minimum after full decay)

     extractGasUSD:
       Classic → quoteResponse.quote.gasFeeUSD
       Dutch   → quoteResponse.quote.classicGasUseEstimateUSD
  ════════════════════════════════════════════════════════ */
  function isDutchRoute(routing) {
    return !!(routing && routing.indexOf('DUTCH') > -1);
  }

  function extractAmountOut(quoteResponse) {
    if (!quoteResponse || !quoteResponse.quote) return null;
    var q = quoteResponse.quote;

    /* Classic: output.amount */
    if (q.output && q.output.amount) return q.output.amount.toString();

    /* Dutch: guaranteed minimum = endAmount of first output */
    if (q.orderInfo && q.orderInfo.outputs && q.orderInfo.outputs.length) {
      var out = q.orderInfo.outputs[0];
      return (out.endAmount || out.startAmount || '').toString();
    }

    /* Fallback: aggregatedOutputs */
    if (q.aggregatedOutputs && q.aggregatedOutputs.length) {
      var ao = q.aggregatedOutputs[0];
      return (ao.minAmount || ao.amount || '').toString();
    }

    return null;
  }

  function extractGasUSD(quoteResponse) {
    if (!quoteResponse || !quoteResponse.quote) return null;
    var q = quoteResponse.quote;
    /* Classic uses gasFeeUSD; Dutch carries classicGasUseEstimateUSD */
    return q.gasFeeUSD || q.classicGasUseEstimateUSD || null;
  }

  /* ════════════════════════════════════════════════════════
     PRICE IMPACT
     Uses Trading API output vs Chainlink/mock spot — no fee applied.
  ════════════════════════════════════════════════════════ */
  function calcPriceImpact(amountInBN, amountOutBN, fromAddress, toAddress, decimalsIn, decimalsOut) {
    var p         = prices();
    var fromPrice = p[fromAddress] && p[fromAddress].usd;
    var toPrice   = p[toAddress]   && p[toAddress].usd;
    if (!fromPrice || !toPrice) return null;

    var inNum  = parseFloat(ethers.utils.formatUnits(amountInBN,  decimalsIn));
    var outNum = parseFloat(ethers.utils.formatUnits(amountOutBN, decimalsOut));

    var valueInUSD     = inNum * fromPrice;
    var expectedAtSpot = valueInUSD / toPrice;
    var impact         = (1 - outNum / expectedAtSpot) * 100;
    return Math.max(0, parseFloat(impact.toFixed(2)));
  }

  /* ════════════════════════════════════════════════════════
     UNISWAP TRADING API — QUOTE
     Docs: api-docs.uniswap.org/api-reference/swapping/quote

     Field notes (all verified):
     · tokenInChainId / tokenOutChainId — NOT a single chainId
     · swapper — required by API; use wallet if available
     · routingPreference 'BEST_PRICE' — all routes including UniswapX
     · MEV protection off: add protocols filter ['V2','V3','V4']
       to exclude UniswapX. Still uses 'BEST_PRICE' routing.
     · 'CLASSIC', 'BEST_PRICE_V2', 'UNISWAPX_V2' are deprecated.
     · generatePermitAsTransaction: false — get Permit2 message
       (sign only, no on-chain tx for permit). Docs recommend false.

     swapper param: pass real wallet at execute time for valid
     permitData. At display-quote time, pass wallet if connected
     or a stable placeholder — output amounts are unaffected.
  ════════════════════════════════════════════════════════ */
  async function getQuote(tokenIn, tokenOut, amountInBN, swapper) {
    var chainId  = (window.STATE && STATE.network) ? STATE.network : 1;
    var slippage = (window.STATE ? STATE.settings.slippage : 0.5);

    /* MEV protection: allow UniswapX when enabled on mainnet */
    var useUniswapX = !!(window.STATE &&
                         STATE.settings.mevProtection &&
                         STATE.network === 1);

    var body = {
      type:                     'EXACT_INPUT',
      amount:                   amountInBN.toString(),
      tokenIn:                  tokenIn,
      tokenOut:                 tokenOut,
      tokenInChainId:           chainId,
      tokenOutChainId:          chainId,
      swapper:                  swapper || (window.STATE && STATE.wallet) || '0x0000000000000000000000000000000000000001',
      slippageTolerance:        slippage,
      routingPreference:        'BEST_PRICE',
      generatePermitAsTransaction: false
    };

    /* Classic-only: restrict to on-chain protocols, exclude UniswapX */
    if (!useUniswapX) {
      body.protocols = ['V2', 'V3', 'V4'];
    }

    var res = await fetch(UNISWAP_API_BASE + '/quote', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(body)
    });

    if (!res.ok) {
      var errData = {};
      try { errData = await res.json(); } catch (_) {}
      throw new Error('Trading API: ' + (errData.errorCode || errData.detail || res.statusText));
    }

    return await res.json();
    /*
     * Response shape (docs-verified):
     *   .routing          → 'CLASSIC' | 'DUTCH_V2' | 'DUTCH_V3' | 'DUTCH_LIMIT' | ...
     *   .permitData       → { domain, values, types } — Permit2 EIP-712 to sign
     *   .quote            → route-specific execution payload (see extractAmountOut / /swap / /order)
     *   .quote.output.amount         → Classic: output amount (raw string)
     *   .quote.gasFeeUSD             → Classic: gas estimate USD
     *   .quote.orderInfo.outputs[0].endAmount → Dutch: guaranteed minimum output
     *   .quote.classicGasUseEstimateUSD       → Dutch: gas estimate USD
     *   .quote.orderId    → Dutch: orderId for /order POST and polling
     */
  }

  /* ════════════════════════════════════════════════════════
     MOCK QUOTE — display-only fallback
     Active when Trading API is unavailable or key is not set.
     No fee. _isMock = true locks execute button.
  ════════════════════════════════════════════════════════ */
  function mockQuote(fromAddress, toAddress, amountStr) {
    var val = parseFloat(amountStr);
    if (!amountStr || isNaN(val) || val <= 0) return null;
    var p  = prices();
    var fp = p[fromAddress];
    var tp = p[toAddress];
    if (!fp || !tp) return null;
    return {
      amountOut: (val * fp.usd / tp.usd).toFixed(6),
      gasUSD:    '2.40',
      routing:   'CLASSIC'
    };
  }

  /* ════════════════════════════════════════════════════════
     CHECK APPROVAL — Permit2 gate
     Docs: api-docs.uniswap.org/guides/permit2

     /check_approval verifies whether the Permit2 contract
     has a sufficient ERC-20 allowance for the given token.
     If not, it returns a fully-formed approval transaction.
     The Permit2 contract manages time-limited allowances
     to the Universal Router — replacing direct SwapRouter02
     approvals. A token approved once stays approved
     indefinitely (until revoked).

     Non-critical: if this call fails the swap still proceeds.
     The swap tx itself will revert if allowance is genuinely
     missing — that error surfaces through onError normally.
  ════════════════════════════════════════════════════════ */
  async function checkApprovalIfNeeded(tokenAddress, amountInBN, walletAddress, chainId, signer, callbacks) {
    /* Native ETH never needs approval */
    if (tokenAddress === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE') return;

    try {
      var res = await fetch(UNISWAP_API_BASE + '/check_approval', {
        method:  'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          token:         tokenAddress,
          amount:        amountInBN.toString(),
          walletAddress: walletAddress,
          chainId:       chainId
        })
      });

      if (!res.ok) return; /* non-critical — let swap proceed */

      var data = await res.json();

      /* data.approval is null when Permit2 already has sufficient allowance */
      if (data.approval && data.approval.to) {
        callbacks.onApproving();
        var tx = await signer.sendTransaction(data.approval);
        await tx.wait();
      }
    } catch (_) {
      /* non-critical — proceed anyway */
    }
  }

  /* ════════════════════════════════════════════════════════
     ORDER STATUS POLLER — Dutch Auction (UniswapX)
     Docs: api-docs.uniswap.org/api-reference/swapping/get_uniswapx_order

     Endpoint: GET /orders?orderId={id}
     Response:  { orders: [{ orderStatus, txHash, settledAmounts }] }
     Status values (lowercase): 'open', 'filled', 'cancelled', 'expired', 'error'
     txHash: fill transaction hash (only present when filled)
     settledAmounts[0].amountOut: actual output received (post-fill)

     Returns { cancel } so wireCard can abort if user resets the card
     before the Dutch Auction fills (Flag 5 — poll cancellation).
  ════════════════════════════════════════════════════════ */
  function pollOrderStatus(orderId, callbacks, timeout) {
    var deadline  = Date.now() + (timeout || 180000); /* 3 min max — Dutch TTL ~60–180s */
    var interval  = 2000;
    var cancelled = false;

    function cancel() { cancelled = true; }

    function poll() {
      if (cancelled) return;
      if (Date.now() > deadline) {
        callbacks.onError({ message: 'Order expired \u2014 try again' });
        return;
      }

      fetch(UNISWAP_API_BASE + '/orders?orderId=' + encodeURIComponent(orderId), {
        headers: { 'x-api-key': UNISWAP_API_KEY }
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (cancelled) return;

        var order  = data.orders && data.orders[0];
        if (!order) { setTimeout(poll, interval); return; } /* no data yet — keep polling */

        var status = order.orderStatus; /* 'open' | 'filled' | 'cancelled' | 'expired' | 'error' */

        if (status === 'filled') {
          callbacks.onFilled(order); /* passes full order object: txHash + settledAmounts */
        } else if (status === 'cancelled' || status === 'expired' || status === 'error') {
          callbacks.onError({ message: 'Order ' + status + ' \u2014 try again' });
        } else {
          /* 'open' — still in progress */
          setTimeout(poll, interval);
        }
      })
      .catch(function () {
        /* Network error — retry silently until deadline */
        if (!cancelled) setTimeout(poll, interval);
      });
    }

    setTimeout(poll, interval);
    return { cancel: cancel };
  }

  /* ════════════════════════════════════════════════════════
     TRADE RECORDER — unchanged
     No fee adjustment. API output is the exact received amount.
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
     EXECUTE SWAP — two paths, one success state.

     Both paths re-quote at execution time with the real wallet
     address. This ensures permitData is valid for the signer
     (display quotes may have used a placeholder swapper).

     ── Classic (V2 / V3 / V4 on-chain) ──────────────────
     1.  Re-quote with real wallet → fresh permitData
     2.  /check_approval → ERC20.approve(Permit2) if needed → callbacks.onApproving
     3.  callbacks.onConfirming
     4.  Sign freshQuote.permitData (EIP-712 Permit2 message)
     5.  POST /swap → swap calldata { to, data, value, gasLimit, ... }
     6.  signer.sendTransaction(swapData.swap)
     7.  tx.wait() → recordTrade + callbacks.onSuccess(hash)

     ── Dutch Auction (UniswapX V2 / V3) ─────────────────
     1.  Re-quote with real wallet → Dutch order + permitData
     2.  callbacks.onConfirming   ← no approve, no gas for approval
     3.  Sign freshQuote.permitData (EIP-712 Permit2 for UniswapX reactor)
     4.  POST /order { signature, quote: freshQuote.quote }
     5.  orderId = freshQuote.quote.orderId (present in quote response)
     6.  pollOrderStatus(orderId) → returns { cancel }
     7.  callbacks.onPollStarted({ cancel }) → wireCard stores _pollCancel
     8.  On fill: settledAmounts[0].amountOut → recordTrade → callbacks.onSuccess(txHash)
     9.  On expiry: callbacks.onError

     callbacks: { onApproving, onConfirming, onPollStarted, onSuccess, onError }
  ════════════════════════════════════════════════════════ */
  async function executeSwap(displayQuote, tokenIn, amountInBN, fromToken, toToken, fromAmountStr, callbacks) {
    try {
      var signer  = await getSwapSigner();
      var wallet  = await signer.getAddress();
      var chainId = (window.STATE && STATE.network) ? STATE.network : 1;

      /* Always re-quote with the real wallet address for valid permitData */
      callbacks.onConfirming();
      var freshQuote = await getQuote(tokenIn, toToken.address, amountInBN, wallet);

      var routing = freshQuote.routing;
      var dutch   = isDutchRoute(routing);
      var p       = prices();

      /* ─── Dutch Auction ──────────────────────────────── */
      if (dutch) {
        /* Sign Permit2 EIP-712 message — no approve tx, no gas for it */
        var pd        = freshQuote.permitData;
        var signature = '';
        if (pd && pd.domain) {
          signature = await signer._signTypedData(pd.domain, pd.types, pd.values);
        }

        /* Submit order */
        var orderRes = await fetch(UNISWAP_API_BASE + '/order', {
          method:  'POST',
          headers: apiHeaders(),
          body: JSON.stringify({
            signature: signature,
            quote:     freshQuote.quote
          })
        });
        if (!orderRes.ok) {
          var oErr = {};
          try { oErr = await orderRes.json(); } catch (_) {}
          throw new Error('Order submission failed: ' + (oErr.errorCode || orderRes.statusText));
        }

        /* orderId is in the quote response — no need to parse POST /order response */
        var orderId = freshQuote.quote.orderId;
        if (!orderId) throw new Error('No orderId in quote response');

        /* Start polling — wireCard stores the cancel handle via onPollStarted */
        var handle = pollOrderStatus(orderId, {
          onFilled: function (orderData) {
            /* Use actual settled amount when available (post-fill truth) */
            var rawOut = (orderData.settledAmounts && orderData.settledAmounts[0])
              ? orderData.settledAmounts[0].amountOut
              : extractAmountOut(freshQuote);

            if (!rawOut) rawOut = '0';
            var amountOutBN = ethers.BigNumber.from(rawOut.toString());
            var toAmtNum    = parseFloat(ethers.utils.formatUnits(amountOutBN, toToken.decimals));
            var fromAmtNum  = parseFloat(ethers.utils.formatUnits(amountInBN,  fromToken.decimals));
            var fromPrice   = p[fromToken.address] ? p[fromToken.address].usd : 0;

            recordTrade(orderData.txHash, fromToken, toToken, fromAmountStr, toAmtNum, fromAmtNum * fromPrice);
            callbacks.onSuccess(orderData.txHash);
          },
          onError: function (err) {
            callbacks.onError(err);
          }
        });

        /* Expose cancel handle to wireCard (_pollCancel) */
        if (typeof callbacks.onPollStarted === 'function') {
          callbacks.onPollStarted(handle);
        }

      /* ─── Classic ────────────────────────────────────── */
      } else {
        /* Step 1: approval gate (parallel with nothing — must happen before signing) */
        await checkApprovalIfNeeded(tokenIn, amountInBN, wallet, chainId, signer, callbacks);

        /* Step 2: sign Permit2 message from fresh quote */
        callbacks.onConfirming();
        var pData = freshQuote.permitData;
        var sig   = '';
        if (pData && pData.domain) {
          sig = await signer._signTypedData(pData.domain, pData.types, pData.values);
        }

        /* Step 3: POST /swap to get final unsigned calldata */
        var swapBody = { quote: freshQuote.quote };
        if (sig)   swapBody.signature   = sig;
        if (pData) swapBody.permitData  = pData;

        var swapRes = await fetch(UNISWAP_API_BASE + '/swap', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify(swapBody)
        });
        if (!swapRes.ok) {
          var sErr = {};
          try { sErr = await swapRes.json(); } catch (_) {}
          throw new Error('Swap calldata failed: ' + (sErr.errorCode || swapRes.statusText));
        }
        var swapData = await swapRes.json();
        var swapTx   = swapData.swap; /* { to, from, data, value, gasLimit, maxFeePerGas, maxPriorityFeePerGas } */

        /* Step 4: send the transaction */
        var txReq = {
          to:   swapTx.to,
          data: swapTx.data,
          value: swapTx.value || '0x0'
        };
        /* Use API gas estimates when present — avoids estimateGas failure on complex routes */
        if (swapTx.gasLimit)            txReq.gasLimit            = swapTx.gasLimit;
        if (swapTx.maxFeePerGas)        txReq.maxFeePerGas        = swapTx.maxFeePerGas;
        if (swapTx.maxPriorityFeePerGas) txReq.maxPriorityFeePerGas = swapTx.maxPriorityFeePerGas;

        var tx      = await signer.sendTransaction(txReq);
        var receipt = await tx.wait();

        /* Step 5: record + succeed */
        var rawOut      = extractAmountOut(freshQuote);
        if (!rawOut) rawOut = '0';
        var amountOutBN = ethers.BigNumber.from(rawOut.toString());
        var toAmtNum    = parseFloat(ethers.utils.formatUnits(amountOutBN, toToken.decimals));
        var fromAmtNum  = parseFloat(ethers.utils.formatUnits(amountInBN,  fromToken.decimals));
        var fromPrice   = p[fromToken.address] ? p[fromToken.address].usd : 0;

        recordTrade(receipt.transactionHash, fromToken, toToken, fromAmountStr, toAmtNum, fromAmtNum * fromPrice);
        callbacks.onSuccess(receipt.transactionHash);
      }

    } catch (err) {
      callbacks.onError(err);
    }
  }

  /* ════════════════════════════════════════════════════════
     LOGO FALLBACK — unchanged
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
     swap-fee removed. Replaced by #swap-gas + #swap-routing.
     CSS for both lives in app.html (Flag 1 resolved there).
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
          '<span class="swap-gas"     id="swap-gas"></span>' +
          '<span class="swap-routing" id="swap-routing" hidden></span>' +
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

     Phase 5B data-flow changes from 5A:
     · _lastQuote: { quoteResponse, amountInBN, amountOutBN, impact }
     · _pollCancel: stores Dutch Auction poll cancel fn (Flag 5)
     · clearMeta: resets #swap-gas / #swap-routing
     · cancelPoll: aborts in-flight poll (Swap Again, token flip, error)
     · updateOutput: extracts amountOut via extractAmountOut(),
       shows gas via extractGasUSD(), shows routing tag for Dutch
     · showQuoteResult: rate line has no FEE_FACTOR
     · updateExecLabel: separates "CONNECT WALLET" from "NETWORK UNAVAILABLE"
     · Execute handler: pre-disables button; wires onPollStarted callback
     · Swap Again: cancelPoll() before card reset
  ════════════════════════════════════════════════════════ */
  function wireCard(container) {
    var fromInput  = container.querySelector('#from-amount');
    var toAmountEl = container.querySelector('#to-amount');
    var rateEl     = container.querySelector('#swap-rate');
    var gasEl      = container.querySelector('#swap-gas');
    var routingEl  = container.querySelector('#swap-routing');
    var impactEl   = container.querySelector('#swap-impact');
    var impactVal  = container.querySelector('#impact-value');
    var executeBtn = container.querySelector('#swap-execute');
    var execLabel  = container.querySelector('#exec-label');
    var dirBtn     = container.querySelector('#swap-dir');
    var swapCard   = container.querySelector('#swap-card');
    var swapSucc   = container.querySelector('#swap-success');

    var _debounce   = null;
    var _rotation   = 0;
    var _quoteSeq   = 0;
    var _isMock     = false;
    var _lastQuote  = null;  /* { quoteResponse, amountInBN, amountOutBN, impact } */
    var _confirming = false;
    var _confirmTmr = null;
    var _pollCancel = null;  /* Dutch Auction poll cancel fn — Flag 5 */

    /* ── Logo fallbacks ── */
    ['from', 'to'].forEach(function (side) {
      var img = container.querySelector('#' + side + '-logo');
      logoFallback(img, img && img.nextElementSibling,
        (container.querySelector('#' + side + '-symbol') || {}).textContent || '?');
    });

    /* ── Cancel any in-flight Dutch Auction poll ── */
    function cancelPoll() {
      if (_pollCancel) { _pollCancel(); _pollCancel = null; }
    }

    /* ── Clear gas + routing meta elements ── */
    function clearMeta() {
      if (gasEl)     gasEl.textContent = '';
      if (routingEl) { routingEl.hidden = true; routingEl.textContent = ''; }
    }

    /* ── Reset exec button to base state ── */
    function resetExecBtn(label) {
      _confirming = false;
      clearTimeout(_confirmTmr);
      executeBtn.classList.remove('confirm', 'confirming');
      if (execLabel) execLabel.textContent = label || 'EXECUTE SWAP';
    }

    /* ── Set exec button label based on connection + mock state ── */
    function updateExecLabel(impact) {
      resetExecBtn();
      if (!window.STATE || !STATE.connected) {
        /* Wallet not connected — prompt it */
        if (execLabel) execLabel.textContent = 'CONNECT WALLET';
      } else if (_isMock) {
        /* Connected but Trading API unavailable — lock, explain */
        if (execLabel) execLabel.textContent = 'NETWORK UNAVAILABLE';
        executeBtn.disabled = true;
      } else if (impact !== null && impact > 5 && !(window.STATE && STATE.settings.expertMode)) {
        if (execLabel) execLabel.textContent = 'EXECUTE SWAP (' + impact.toFixed(1) + '% IMPACT)';
      } else {
        if (execLabel) execLabel.textContent = 'EXECUTE SWAP';
      }
    }

    /* ── Render a resolved quote into the card ── */
    function showQuoteResult(amountOutNum, impact, fromTok, toTok) {
      toAmountEl.classList.remove('quoting');
      toAmountEl.style.transition = 'opacity 60ms var(--ease-in)';
      toAmountEl.style.opacity    = '0';
      setTimeout(function () {
        toAmountEl.textContent      = fmtAmount(amountOutNum);
        toAmountEl.classList.add('has-value');
        toAmountEl.style.opacity    = '1';
        toAmountEl.style.transition = 'opacity 120ms var(--ease-out)';
      }, 60);

      /* Rate line — no fee, pure spot */
      var p  = prices();
      var fp = p[S.fromAddress];
      var tp = p[S.toAddress];
      if (fp && tp) {
        rateEl.textContent = '1 ' + fromTok.symbol + ' \u2248 ' +
          fmtAmount(fp.usd / tp.usd) + ' ' + toTok.symbol;
        rateEl.classList.add('has-rate');
      }

      /* Price impact */
      if (impact !== null && impact > 1) {
        impactEl.hidden = false;
        impactVal.textContent = impact.toFixed(2) + '%';
        impactEl.classList.toggle('high', impact > 5);
      } else {
        impactEl.hidden = true;
        impactEl.classList.remove('high');
      }

      executeBtn.disabled = false;
      updateExecLabel(impact);
    }

    /* ── Async quote on every input change ── */
    async function updateOutput() {
      var raw = fromInput ? fromInput.value.trim() : '';
      var val = raw.replace(/\.$/, '');

      if (!val || isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
        toAmountEl.textContent = '\u2014';
        toAmountEl.classList.remove('has-value', 'quoting');
        toAmountEl.style.opacity = '1';
        rateEl.textContent = '\u2014';
        rateEl.classList.remove('has-rate');
        impactEl.hidden = true;
        clearMeta();
        executeBtn.disabled = true;
        _lastQuote = null;
        _isMock    = false;
        resetExecBtn();
        return;
      }

      var fromTok = getToken(S.fromAddress);
      var toTok   = getToken(S.toAddress);
      if (!fromTok || !toTok) return;

      /* Parse — guard against excess decimals (e.g. USDC = 6) */
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

      toAmountEl.classList.add('quoting');
      toAmountEl.style.opacity = '0.35';

      var seq = ++_quoteSeq;

      try {
        /* Display quote — use wallet if connected, placeholder if not */
        var displayWallet = (window.STATE && STATE.wallet) ? STATE.wallet : null;
        var quoteResponse = await getQuote(S.fromAddress, S.toAddress, amountInBN, displayWallet);
        if (seq !== _quoteSeq) return; /* stale — newer in flight */

        /* Extract amountOut */
        var rawOut = extractAmountOut(quoteResponse);
        if (!rawOut || rawOut === '0') throw new Error('No output amount in quote');

        var amountOutBN  = ethers.BigNumber.from(rawOut);
        var amountOutNum = parseFloat(ethers.utils.formatUnits(amountOutBN, toTok.decimals));
        var impact       = calcPriceImpact(amountInBN, amountOutBN,
                             S.fromAddress, S.toAddress,
                             fromTok.decimals, toTok.decimals);

        _lastQuote = {
          quoteResponse: quoteResponse,
          amountInBN:    amountInBN,
          amountOutBN:   amountOutBN,
          impact:        impact
        };
        _isMock = false;

        /* Gas display — revealed after quote resolves */
        var gasUSD = extractGasUSD(quoteResponse);
        if (gasEl) {
          gasEl.textContent = gasUSD
            ? 'Gas \u00b7 ~$' + parseFloat(gasUSD).toFixed(2)
            : '';
        }

        /* UniswapX routing tag */
        var dutch = isDutchRoute(quoteResponse.routing);
        if (routingEl) {
          routingEl.hidden      = !dutch;
          routingEl.textContent = dutch ? 'via UniswapX' : '';
        }

        showQuoteResult(amountOutNum, impact, fromTok, toTok);

      } catch (_err) {
        if (seq !== _quoteSeq) return;

        /* API unavailable — mock fallback, execute locked */
        var mq = mockQuote(S.fromAddress, S.toAddress, val);
        _lastQuote = null;
        _isMock    = true;

        if (mq) {
          showQuoteResult(parseFloat(mq.amountOut), null, fromTok, toTok);
          if (gasEl)     gasEl.textContent = 'Gas \u00b7 ~$' + mq.gasUSD;
          if (routingEl) { routingEl.hidden = true; routingEl.textContent = ''; }
          /* updateExecLabel re-locks via _isMock = true */
          updateExecLabel(null);
        } else {
          toAmountEl.classList.remove('quoting');
          toAmountEl.style.opacity = '1';
          clearMeta();
          executeBtn.disabled = true;
          updateExecLabel(null);
        }
      }
    }

    /* ── Input event: sanitize + debounce ── */
    if (fromInput) {
      fromInput.addEventListener('input', function () {
        var v     = fromInput.value.replace(/[^\d.]/g, '');
        var parts = v.split('.');
        if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
        if (v !== fromInput.value) fromInput.value = v;

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

        var prevOut = toAmountEl.textContent.replace(/[^0-9.]/g, '');
        if (fromInput && prevOut && !isNaN(parseFloat(prevOut))) {
          fromInput.value = prevOut;
        }

        refreshCardSelectors(container);
        refreshCardBalances(container);
        cancelPoll();
        _lastQuote = null;
        _isMock    = false;
        executeBtn.disabled = true;
        clearMeta();
        resetExecBtn();
        clearTimeout(_debounce);
        _debounce = setTimeout(updateOutput, 60);
      });
    }

    /* ── Success animation ── */
    function playSuccess(txHash) {
      swapCard.hidden = true;
      swapSucc.hidden = false;

      var line = swapSucc.querySelector('.check-line');
      if (line) {
        requestAnimationFrame(function () {
          line.style.transition       = 'stroke-dashoffset 380ms var(--ease-out)';
          line.style.strokeDashoffset = '0';
        });
      }

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

        /* Wallet not connected → open sheet */
        if (!window.STATE || !STATE.connected) {
          if (typeof openWalletSheet === 'function') openWalletSheet();
          else if (typeof showToast  === 'function') showToast('Connect your wallet to swap', 'tok');
          return;
        }

        /* API unavailable (mock) → lock, no-op */
        if (_isMock || !_lastQuote) return;

        var impact     = _lastQuote.impact;
        var expertMode = window.STATE && STATE.settings.expertMode;

        /* Two-click high-impact gate */
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

        /* All gates passed — disable immediately, prevent double-fire */
        executeBtn.disabled = true;
        executeBtn.classList.remove('confirm');
        executeBtn.classList.add('confirming');
        if (execLabel) execLabel.textContent = 'CONFIRMING\u2026';

        var fromTok    = getToken(S.fromAddress);
        var toTok      = getToken(S.toAddress);
        var fromAmount = fromInput ? fromInput.value.trim() : '0';

        executeSwap(
          _lastQuote.quoteResponse,
          S.fromAddress,
          _lastQuote.amountInBN,
          fromTok,
          toTok,
          fromAmount,
          {
            onApproving: function () {
              /* Button already disabled above — update label only */
              if (execLabel) execLabel.textContent = 'APPROVING\u2026';
            },
            onConfirming: function () {
              if (execLabel) execLabel.textContent = 'CONFIRMING\u2026';
            },
            onPollStarted: function (handle) {
              /* Store cancel fn — lets Swap Again abort the Dutch poll */
              _pollCancel = handle.cancel;
            },
            onSuccess: function (txHash) {
              _pollCancel = null;
              playSuccess(txHash);
            },
            onError: function (err) {
              _pollCancel = null;
              executeBtn.disabled = false;
              executeBtn.classList.remove('confirming', 'confirm');
              _confirming = false;

              var msg = (err && err.code === 4001)
                ? 'Transaction rejected'
                : (err && err.message) || 'Swap failed \u2014 try again';
              if (typeof showToast === 'function') showToast(msg, 'terr');

              updateExecLabel(_lastQuote ? _lastQuote.impact : null);

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
        /* Cancel any in-flight Dutch poll before resetting */
        cancelPoll();

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
        clearMeta();
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
     CARD STATE HELPERS — unchanged
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
     MOUNT SWAP CARD — unchanged
  ════════════════════════════════════════════════════════ */
  function mountSwapCard(container) {
    if (!container) return;

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
     TOKEN PICKER — unchanged
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
     STATE EVENT LISTENERS — unchanged
  ════════════════════════════════════════════════════════ */
  document.addEventListener('panel:render', function (e) {
    var container = document.getElementById('right-panel-content');
    if (e.detail === 'swap') {
      if (container) mountSwapCard(container);
    } else {
      var old = container && container.querySelector('.swap-view');
      if (old) old.parentNode.removeChild(old);
    }
  });

  document.addEventListener('state:mobileView', function (e) {
    if (e.detail !== 'swap') return;
    var container = document.getElementById('mobile-swap');
    if (container) mountSwapCard(container);
  });

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
