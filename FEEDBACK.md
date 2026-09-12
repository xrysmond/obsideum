# OBSIDEUM — Uniswap Feedback
Waeven Xrysmond · UNCHAINED9 · ETHOnline 2026

https://xrysmond.github.io/obsideum/
https://github.com/xrysmond/obsideum

---

I built OBSIDEUM, a trading interface that sits directly on top of Uniswap V3. I'm calling QuoterV2 for pricing and SwapRouter02 for execution across eight chains. No routing API. No wrapper. Just the contracts.

Overall the protocol is solid and I'm glad I built on it. The architecture makes sense. The fee tiers work. Multi-chain felt like a real design decision rather than something tacked on. Unichain being supported from day one was a nice surprise.

The part that genuinely cost me time was the documentation. Not because it's bad, but because it's written for people who already know Solidity and assumes you'll translate everything into JavaScript yourself.

The specific thing that got me: QuoterV2's quoteExactInput returns multiple values, not a single number. In ethers.js that comes back as a Result object and you have to access the amount as r[0] or r.amountOut. That's not mentioned anywhere in the docs. Every example either shows a Solidity interface or pseudocode. I had a bug where the whole multi-hop routing was silently broken for days because of this and I had no documentation to point me in the right direction. I eventually figured it out but it should have been a five minute read, not days of debugging.

Same thing with path encoding for multi-hop swaps. The Solidity version is referenced but there's no JavaScript equivalent shown. And the difference between the view quoter and QuoterV2, specifically that one needs callStatic and the other doesn't because it's actually a view function, is never explained clearly anywhere.

None of this is a protocol problem. The protocol does what it says. It's just that the documentation stops at the contract layer and leaves JavaScript developers to figure out the rest themselves. A single page with real ethers.js examples would fix most of this.

That's my honest feedback. I'd build on V3 again.

UNCHAINED9 · ETHOnline 2026
