# Tryable Paradise Reader demo

A standalone, sample-data demo using the reader's existing design tokens and the
extension's actual local keyword scorer. No X/Ideaflow/Noos connection, model
request, account credential or backend auth override is used. Initial posts and
authors are fictional. Optional pasted text and sanitized bookmark snapshots stay
in this browser's localStorage; Reset removes the demo state.

The demo supports Filtered / All captured / Saves, threshold changes with retained
capture/decision history, pending captures, sample feed acquisition, deduplicated
bookmark import, local saves, search, original-text revisions and reset. Local
save removal is a demo interaction; the deployed Noos store's current bookmark
membership contract remains additive. This preview does not establish live source
collection or production identity/storage readiness.

Build from repository root:

```
node reader/demo/build.mjs
lavish-axi export reader/demo/dist/paradise-demo.html --out reader/demo/dist/index.html
```

The export is one portable HTML file. It uses no remote scripts/styles/fonts,
and a hash-based CSP blocks connection requests. The exported file can be hosted
as `/demo/index.html` on the existing GitHub Pages site. Copy the existing
`reader/public/icons/icon-512.png` to `/demo/icon.png` for the public link preview.
Source changes do not publish automatically.

Verification (with the existing Playwright dependency/browser):

```
PARADISE_CHROMIUM=/path/to/existing/chromium node reader/demo/check-demo.cjs
```

Set `PARADISE_DEMO_URL` to verify the actual published URL; otherwise the check
starts and closes its own loopback fixture server. `PARADISE_DEMO_EVIDENCE` chooses
an external evidence directory. Browser tests cover the 320/390/1280-pixel views,
threshold reversal without deletion, saved membership, capture ordering, original
revisions, imports/retries/failure preservation, inert pasted text, persistence,
reset, titles, keyboard focus and absence of third-party/network data calls.
These are Chromium fixtures, not physical iPhone acceptance.
