<!-- Release notes for the NEXT tag. Updated in the release commit; CI injects
     this file into the GitHub Release body, which the in-app update prompt
     fetches and shows. English only; the app renders the "## What's new"
     bullets and stops at the first horizontal rule. History lives in git;
     this file only ever describes the upcoming release. -->

## What's new

- The in-wallet AI assistant's tools now run fully on-device. Previously the assistant tried to launch a helper process that isn't available on phones, so some of its actions could fail; they're now native and reliable.
- More resilient cross-chain swaps: the embedded wallet engine now recovers its in-flight locks after a restart, so a swap interrupted by an app restart won't get stuck or accidentally re-spend, and swap errors are reported more precisely.
