<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- More reliable cross-chain swaps. Fixed a case where a buy that was actually paid could be shown as "failed": the wallet now tracks your on-chain lock correctly, so a completed buy is no longer mislabeled and your coins are always delivered.
- Self-healing swap status. Any earlier buy that was wrongly marked "failed" is now automatically corrected to its true status (completed or refunded) the next time you open the wallet.
