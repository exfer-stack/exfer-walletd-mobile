<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- New: show any address in the checksummed "xf…" format. Every EXFER address
  has two spellings of the exact same account — the familiar hex form, and a
  newer bech32m form that begins with `xf` and carries a built-in typo check.
  On the Receive sheet and an address's detail, tap the small XF / HEX button
  next to the address to switch how that one is displayed, copied, shared and
  encoded in its QR. The default stays hex, so nothing changes unless you
  choose it — and the choice is per address.
- Same account, either spelling. The xf… and hex forms are the identical
  address holding the identical funds, and both are accepted when someone sends
  to you. Your saved names, hidden addresses and recent recipients carry over
  untouched — switching the display never affects your balance or who can pay
  you.
