# OBSIDEUM

Decentralized trading interface built on Uniswap V3 and Privy.

Live: https://xrysmond.github.io/obsideum/
Built by Waeven Xrysmond · UNCHAINED9 · ETHOnline 2026

---

## Uniswap Integration

All Uniswap logic lives in `swap.js`.

**Contracts used:**

| Contract | Purpose |
|---|---|
| QuoterV2 | Price simulation, single-hop and multi-hop |
| View Quoter (IQuoterV2 view) | Gas-free quote simulation where supported |
| SwapRouter02 | Swap execution |
| V3 Subgraphs | Token discovery and price history |

Chain-specific contract addresses are in `swap.js` under `QUOTER_ADDRS`, `VIEW_QUOTER`, and `ROUTER_ADDRS`.

**Chains:** Ethereum · Arbitrum One · Base · Optimism · Polygon · BNB Chain · Avalanche · Unichain

---

## Key functions in swap.js

`getBestDirectQuote` — queries QuoterV2 across all three fee tiers (500, 3000, 10000) for a single-hop route

`getMultiHopQuote` — builds encoded paths through WETH and USDC as intermediaries and calls `quoteExactInput` when no direct pool exists

`executeSwapTx` — calls `exactInputSingle` or `exactInput` on SwapRouter02 depending on the route

The quoting layer tries the view quoter first (no gas), falls back to QuoterV2 with `callStatic` on chains that don't support it.

---

## Feedback

FEEDBACK.md is in the root of this repo.

Uniswap Developer Feedback Form submission: https://developers.uniswap.org/hackathon-feedback

