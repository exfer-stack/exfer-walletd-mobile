<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- Buying EXFER now checks, before it starts, that your BNB covers the amount PLUS the small network fee needed to lock it — with a clear message if it doesn't. Previously you could start a buy that spent your whole BNB balance, leaving nothing for gas, so the lock could never go through and the swap got stuck waiting. (No funds were ever at risk — an unlocked buy simply can't complete.)
