<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Automatic recovery for interrupted swaps. If a swap was cut off at the final
  step (network drop, app closed) and your EXFER was left locked, the wallet now
  finds and returns it to you automatically when you open the app — even after a
  reinstall or on a new phone, as long as you have your wallet. No action needed.
- Stability improvements.
