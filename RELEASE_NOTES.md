<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Swaps now finish reliably. A BNB→EXFER swap could get stuck on "Sending your
  funds" even after the EXFER had already arrived, or wrongly show "unmatched"
  when the pool had in fact taken the other side. The wallet now re-checks the
  pool and the chain directly while a swap is in progress, so it completes a
  settled swap and picks up a matched one on its own — including swaps that were
  already stuck (they recover the next time you open the app). Your funds were
  always safe on-chain; this fixes the screen catching up to reality.

- Honest in-progress wording. A swap that's still confirming no longer claims it
  "didn't match" or tells you to close the app — closing during the confirmation
  window is exactly what could strand it. It now says it's still confirming, asks
  you to keep the app open, and explains your funds auto-return if it genuinely
  doesn't match.
