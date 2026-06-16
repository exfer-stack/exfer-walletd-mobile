<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Automatic recovery for interrupted swaps — now both directions. If a swap is
  cut off at the final step (network drop, app closed, reinstall, new phone), the
  wallet finds your stranded funds and returns them automatically when you reopen
  it: your EXFER on a sell, and now your BNB on a buy. As long as you have your
  wallet, no action is needed.
- Clearer guidance while a swap is in progress. The app now reminds you to keep
  it open and online until the swap finishes, and to reopen it to continue if you
  closed it — so a swap is far less likely to be left waiting.
- Stability improvements.
