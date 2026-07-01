<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Swaps and transfers now confirm much faster — your wallet now broadcasts each transaction to several network nodes at once, so it reaches a miner quickly instead of waiting on a single node. Buys, sells, and sends that used to take many minutes now usually finish in about a minute or two.
- Fixed an empty gap below the bottom tab bar on phones with gesture navigation (no on-screen system buttons). The tab bar now sits flush at the bottom again.
- Fixed your saved AI/LLM key and wallet password not sticking on Android: they were overwriting each other in on-device storage, so after the app restarted you'd be asked to re-enter your password or re-add your key. Each secret is now stored separately and persists across restarts.
