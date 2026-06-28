<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Activity no longer goes blank. A network hiccup while opening Activity — or
  switching tabs — could wipe your transaction history until it reloaded. It now
  keeps what it already has and fills in the rest. Your history was always safe
  on-chain; this just stops the screen from losing it.

- Activity is back in time order. Swaps and recent transactions could sink to the
  bottom (or look missing) before the chain tip had loaded; they now interleave
  by real time, newest first. A very active address's latest transactions are no
  longer cut off either.
