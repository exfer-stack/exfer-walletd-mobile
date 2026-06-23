<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Clearer swap costs. The "Fees" total used to fold in price impact (the
  slippage on a large trade), which made it look far higher than what you
  actually pay. Now "Fees" shows only the real cost — the 0.3% liquidity fee
  plus the small on-chain network fee — and price impact is shown on its own
  separate line, so a thin-pool trade no longer reads as a giant fee.
