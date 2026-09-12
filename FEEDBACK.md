# OBSIDEUM — Uniswap Developer Feedback
**ETHOnline 2026 · UNCHAINED9 · Built by Waeven Xrysmond**

Live: https://xrysmond.github.io/obsideum/
Code: https://github.com/xrysmond/obsideum

---

## What I built

OBSIDEUM is a standalone DeFi trading interface built directly on Uniswap V3. No routing API in the middle. No abstraction layer between the app and the protocol.

The integration covers:

- QuoterV2 for price simulation across all three fee tiers (500, 3000, 10000 basis points)
- Multi-hop routing through WETH and USDC when no direct pool exists between two tokens
- The view quoter interface for gas-free quote simulation on supported chains
- SwapRouter02 for execution across both single-hop and multi-hop paths
- Native ETH handling with address substitution before quoting
- Eight chains: Ethereum mainnet, Optimism, BNB Chain, Unichain, Polygon, Base, Arbitrum One, Avalanche
- Uniswap V3 subgraphs on all eight chains for token discovery and price history

---

## What worked well

The protocol is solid. Once integrated correctly it does exactly what it says on every chain.

Multi-chain support feels like a real feature, not an afterthought. Adding a new chain means adding contract addresses. The subgraph schema is consistent across chains which made token discovery straightforward. The fee tier system gives real price discovery. And having Unichain supported from launch is the right call.

The separation between the quoter and the router is a clean architecture decision. Being able to simulate without touching state, then execute separately, made it simple to build a real-time quote UI without any unnecessary gas cost.

---

## Where the documentation fell short

These are specific gaps, not general complaints.

**QuoterV2 returns tuples and the JavaScript documentation does not show this.**

`quoteExactInputSingle` and `quoteExactInput` both return multiple values. In ethers.js v5 that comes back as a named Result object. You access the amount as `r[0]` or `r.amountOut`, not as a direct BigNumber. There is no example in the Uniswap documentation that shows a JavaScript developer how to handle this. Every example shows a Solidity interface or pseudocode. The actual ethers.js call with correct return value handling is not there.

This is the most common integration mistake a JavaScript developer will make with QuoterV2 and the documentation gives you nothing to avoid it.

**The view quoter and QuoterV2 are not documented as distinct interfaces.**

The view quoter exists on most chains and its `quoteExactInput` and `quoteExactInputSingle` functions are declared as view, meaning you do not need `.callStatic`. QuoterV2 requires `.callStatic` because the function executes and reverts. This difference matters in ethers.js and there is no page that explains it clearly. There is also no chain-by-chain reference showing which chains support the view quoter and which require the standard QuoterV2 fallback.

**Multi-hop path encoding is not shown in JavaScript.**

The `abi.encodePacked(tokenA, fee, tokenB, fee, tokenC)` pattern is referenced but its JavaScript equivalent using `ethers.utils.solidityPack` is not shown anywhere in the documentation. It is something you figure out yourself by reading the Solidity and translating it, which should not be necessary.

---

## What would fix it

One documentation page dedicated to JavaScript developers. Not translated Solidity. Actual ethers.js code showing:

- A complete `quoteExactInputSingle` call with struct input and proper tuple destructuring on the return
- A complete `quoteExactInput` call with path encoding using `solidityPack` and tuple destructuring on the return
- The difference between calling the view quoter directly versus using `.callStatic` on QuoterV2
- A table of which chains support the view quoter interface

That is the entire gap. The protocol itself is well designed. The documentation just needs to meet JavaScript developers at their level instead of assuming they will translate Solidity interfaces into correct ethers.js on their own.

---

## Overall

Uniswap V3 works. The architecture is the right call for a protocol at this scale. The fee tier system and the permissionless liquidity model are genuinely good. The documentation gap is real but narrow. Fix the JavaScript examples and the onboarding experience becomes significantly better.

Rating: 6 out of 10. Would be an 8 with proper ethers.js examples in the docs.

---

UNCHAINED9 · ETHOnline 2026
