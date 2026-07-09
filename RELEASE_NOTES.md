<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- **Mine EXFER in the wallet.** A new Earn panel in the Wallet tab puts your device's CPU to work — pick solo or a pool, choose a payout address and thread count, start and stop, and watch live hashrate, shares, and uptime.
- **Live honeypot check.** The research agent now runs a real on-chain buy→sell simulation against the live pool, so it can prove whether a brand-new token is actually sellable and show its true buy/sell tax — without waiting for third-party data to catch up.
- **Reads verified contract source.** Add a free Etherscan key in settings and the agent flags rug functions (mint, blacklist, pausable, owner-adjustable tax) from the real source; without a key it says so instead of guessing.
- **Honest by default.** Missing safety data shows as "unverified", never as safe. The agent grounds every claim in what it actually fetched and won't push EXFER on guessed numbers — and if you ask what EXFER is worth, you get its real on-chain economics and native-pool liquidity alongside the honest market risks.
- More resilient research under rate limits, cleaner result cards (no raw JSON), a research-forward home screen, and assorted UI fixes.
