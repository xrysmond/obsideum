# OBSIDEUM

Decentralized trading interface built on Uniswap V3 and Privy.

Live: https://xrysmond.github.io/obsideum/app
Built by Waeven Xrysmond · UNCHAINED9 · ETHOnline 2026

---

## Uniswap Integration

All Uniswap logic lives in [`swap.js`](https://github.com/xrysmond/obsideum/blob/main/swap.js).

---

### QuoterV2 — price simulation

Used for single-hop and multi-hop quote simulation via `callStatic`.

| Chain | Address |
|---|---|
| Ethereum | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Arbitrum One | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Optimism | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Polygon | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Base | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| BNB Chain | `0x78D78E420Da98ad378D7799bE8f4AF69033EB077` |
| Unichain | `0x385a5cf5f83e99f7bb2852b6a19c3538b9fa7658` |
| Avalanche | `0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F` |

---

### View Quoter — gas-free quote simulation

Primary quote path on supported chains. Pure view function, no revert pattern. Falls back to QuoterV2 where not deployed (Unichain).

| Chain | Address |
|---|---|
| Ethereum | `0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3` |
| Arbitrum One | `0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3` |
| Optimism | `0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3` |
| Polygon | `0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3` |
| BNB Chain | `0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3` |
| Base | `0x222ca98f00ed15b1fae10b61c277703a194cf5d2` |
| Avalanche | `0xf0c802dcb0cf1c4f7b953756b49d940eed190221` |

---

### SwapRouter02 — execution

| Chain | Address |
|---|---|
| Ethereum | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Arbitrum One | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Optimism | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Polygon | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Base | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| BNB Chain | `0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2` |
| Unichain | `0x73855d06de49d0fe4a9c42636ba96c62da12ff9c` |
| Avalanche | `0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE` |

---

### Key functions in swap.js

`getBestDirectQuote` — tries all three fee tiers (500 / 3000 / 10000) and returns the best single-hop quote

`getMultiHopQuote` — encodes paths through WETH and USDC as intermediaries, calls `quoteExactInput` when no direct pool exists

`executeSwapTx` — calls `exactInputSingle` or `exactInput` on SwapRouter02 depending on whether the route is single-hop or multi-hop
