# PRD: Friend beta, Chrome Web Store, and mobile path

Status: draft, 2026-09-24. The four decisions under **Open questions** were sent to Jacob; until answered, the assumptions below are recommendations, not approved product choices. This document is a plan, not an implementation or a store submission.

## 1. Introduction and current status

Get XFeed Paradise into a friend's hands quickly without silently uploading their feed or embedding a shared AI key in an extension. Use that trial to validate the filter, then publish a reviewed Chrome Web Store item and explore mobile support.

Current v1.3.1 facts from the source audit:

- X/Twitter and Google News content scripts save encountered items in local IndexedDB.
- Groq GPT-OSS 20B scores items when the user has provided a Groq key. Item text is sent to Groq for scoring. Without a key, keyword scoring is available.
- **Community sync is currently on by default**: `db.js` treats an absent `xfp_sync_enabled` preference as true, and the popup checkbox starts checked. When an AI refinement callback runs while the item remains in the page, the script queues text, URL, author identifiers, score, visibility and engagement fields for Supabase. The callback also incorrectly marks a keyword fallback as `scoredWithAI: true`.
- The configured `xvexqhejjdcysxgxanlm.supabase.co` hostname returned NXDOMAIN from local, Cloudflare and Google DNS on 2026-09-24. Upload attempts to that URL should fail now; actual historical uploads and deployed database state were **not** verified.
- There is no Cloudflare Workers AI fallback or managed-key proxy in the extension. The old backend repository is a Supabase prototype, not a working managed Groq service.
- The Chrome Web Store publisher account and any existing unlisted listing have not been inspected. Store assets exist, but release copy and packaging need review.

## 2. Recommended product shape and release sequence

One Chrome extension listing and one shared scoring core. Use clearly separated modes/features, not two nearly identical Chrome extensions:

1. **Private local friend build:** no Supabase uploads under any default path. Keyword scoring works with no account or key. If an AI route is not ready, this can be tested immediately by loading the unpacked extension on desktop Chrome.
2. **Managed AI friend trial (recommended first complete experience):** the extension sends only scoring text to a small authenticated proxy. The proxy holds a dedicated Groq project key, enforces per-invite and aggregate budgets, and does not retain post text. Local filtering and storage remain; community feed upload remains off. Keep BYOK as an optional advanced mode, not a requirement for the friend.
3. **Chrome Web Store:** submit that same no-feed-upload experience as one unlisted item initially, then make it public after feedback. Unlisted links can be shared but are not access controls; all visibility modes receive store review. Do not create a duplicate “mobile” Chrome listing.
4. **Optional community feed:** restore backend ingestion only after the service, consent, retention/deletion and access controls are designed and verified. Make it a separate, initially off opt-in feature.
5. **Mobile:** share the scoring/filtering core, but package and adapt it for a supported mobile browser. iOS Safari web extension/TestFlight is the likely iPhone route; Firefox for Android add-ons are an Android possibility. Neither route can filter the native X app without a different product integration.

If the friend's first device is not desktop Chrome, reorder stages 1–3 after a device-specific spike. Google says Chrome Web Store extensions cannot be installed in mobile Chrome; Apple provides a Safari web-extension conversion and distribution path; Mozilla supports Firefox Android add-ons. [Chrome support](https://support.google.com/chrome_webstore/answer/1698338), [Apple Safari extensions](https://developer.apple.com/safari/extensions/), [Firefox Android](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android).

## 3. Goals

- Give one invited friend a working, clearly disclosed feed filter with a minimal setup path.
- Ensure the first shared build never uploads a feed item to the community database without an explicit opt-in.
- Allow the friend to try AI scoring without receiving a raw Groq key, subject to a small usage cap.
- Make the first store package and privacy disclosures match observed network behavior.
- Keep mobile work from delaying the desktop friend trial.

## 4. User stories

### US-001: Local-only default

As a new user, I want filtering to work without an account and without contributing my feed to a database.

Acceptance criteria:
- [ ] A fresh install has community sync off; existing installs are not silently re-enabled by migration.
- [ ] X and Google News filtering work with keyword scoring when AI is unavailable.
- [ ] Scrolling, successful AI scoring, and AI failure generate no requests to the old Supabase host in local-only mode.
- [ ] The popup says where local data is kept and which text, if any, leaves the device.
- [ ] Automated checks cover fresh, migrated, and explicitly opted-out preferences.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-002: Managed, capped AI trial

As an invited tester, I want AI scoring to work without creating or handling a provider key.

Acceptance criteria:
- [ ] The extension package and Chrome storage contain no shared Groq or Cloudflare secret.
- [ ] A revocable invite credential is required; invalid or exhausted invites fall back to keyword scores without blocking the feed.
- [ ] The proxy enforces per-invite and aggregate request/token budgets and a 10-item maximum batch.
- [ ] The proxy sends only scoring text to Groq, does not persist post text, and records only minimal usage/error counters.
- [ ] A tested outage/429 path displays a non-alarming fallback status.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-003: Friend distribution and feedback

As the owner, I want to send a simple install path and learn whether the filter helps.

Acceptance criteria:
- [ ] A reproducible clean ZIP/unpacked build contains only runtime files; no older ZIPs, source maps, dependency trees, or secrets.
- [ ] Onboarding names supported sites and the distinction between managed scoring and community upload.
- [ ] The friend can install on the selected platform, filter at least ten sample feed items, pause filtering, and report a problem.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-004: Chrome Web Store submission

As the owner, I want one reviewed store item that I can initially share by link.

Acceptance criteria:
- [ ] Confirm publisher account, existing item status, and whether to update that item or create one.
- [ ] Match manifest permissions to actual hosts/features; remove obsolete Supabase host permission from the no-sync build.
- [ ] Refresh screenshots, listing, privacy policy, test instructions and data-use declarations to reflect the exact shipped behavior.
- [ ] Upload a versioned ZIP with `manifest.json` at its root and pass local unpacked smoke tests before submission.
- [ ] Submit one unlisted/private item as chosen by Jacob; record review status and final install link. Review is an external gate, not a guaranteed delivery time.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-005: Later optional community contribution

As a user, I want to choose whether my viewed posts contribute to a shared feed.

Acceptance criteria:
- [ ] The feature remains off until the user takes a clear affirmative action after seeing exact fields, recipient, purpose, retention and deletion terms.
- [ ] The endpoint is healthy and verified, with access controls and abuse prevention; do not assume the prototype SQL policies are deployed or sufficient.
- [ ] Failed uploads do not lose local filtering, and revoking consent stops future uploads.
- [ ] Tests verify no upload when opted out, and a constrained upload when opted in.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-006: Mobile feasibility spike

As a mobile user, I want to know whether X's mobile web feed can be filtered on my device.

Acceptance criteria:
- [ ] Confirm target device/browser and whether the requirement is mobile web or the native X app.
- [ ] Test current content selectors and touch UI on the target mobile web pages.
- [ ] Produce a working Safari iOS or Firefox Android prototype only for the chosen platform, plus a clear list of incompatible APIs and distribution steps.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

## 5. Functional requirements

- FR-1: Default community upload to off for new and migrated installations; do not call the upload API while off.
- FR-2: Keep local keyword scoring usable without a provider or managed-service credential.
- FR-3: Keep scoring traffic separate from optional community ingestion; scoring text sent to Groq or a proxy is not a database contribution.
- FR-4: Route managed trial requests through a backend holding the Groq secret, with revocable invitations and server-side budgets.
- FR-5: Show the active mode, provider/fallback status, and data-sharing state in the extension UI.
- FR-6: Build the store artifact from an explicit allowlist and check it for bundled credentials.
- FR-7: Require an explicit consent flow before any later feed-ingestion feature.
- FR-8: Use a shared scoring contract across desktop/mobile adapters; platform-specific DOM and UI remain separate.

## 6. Non-goals for the first friend release

- No mobile Chrome extension or native X-app interception.
- No automatic upload of viewed feed items to Supabase or another community database.
- No public, unlimited shared API key embedded in the extension.
- No separate “sync edition” or “mobile edition” Chrome listing.
- No automatic Cloudflare Workers AI fallback until managed proxy usage and failure rates justify it.

## 7. Technical and store considerations

- A Cloudflare Worker could host the managed scoring endpoint and later invoke either Groq or Workers AI. If chosen, keep provider selection on the server, not in the extension; use a separate Groq project key, quotas, size limits and abuse controls. Groq explicitly advises a trusted backend proxy for browser clients, and its free GPT-OSS 20B limit is shared at the organization level. [Groq security](https://console.groq.com/docs/production-readiness/security-onboarding), [Groq limits](https://console.groq.com/docs/rate-limits).
- When needed, add Workers AI GPT-OSS 20B as a **server-side** fallback for Groq quota/429/5xx. Cap Cloudflare Neurons and degrade to keywords if both providers fail. See [capacity estimate](../docs/CLOUDFLARE_WORKERS_AI_USAGE.md).
- The current `build.sh` zips the repository recursively without excluding older ZIP files, so fix and inspect the release artifact before submission.
- The current store listing says filtering is entirely local despite external AI calls, and mentions optional community sync that is currently on by default. Reconcile code, popup, listing and privacy policy before publishing. Chrome requires accurate disclosures and user consent for relevant data practices. [Store user-data policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [publication steps](https://developer.chrome.com/docs/webstore/publish/).
- Store review is variable and applies to unlisted/private items too. A direct unpacked install can reach a technical friend sooner; a reviewed store link is the smoother general onboarding route. [Distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [review process](https://developer.chrome.com/docs/webstore/review-process/).

## 8. Success metrics

- The invited friend completes setup and sees at least ten scored/filtered items on the chosen supported surface.
- Zero community-ingestion requests from a default friend install, verified in network inspection.
- Zero shared provider keys in the published package or current release source tree.
- Managed trial stays within configured per-invite and provider budgets; on limit/error, local filtering continues.
- One submitted store item has a verified install link after review.

## 9. Open questions and assumptions to confirm

1. Friend's first platform: desktop Chrome (assumed), iPhone, or Android? Is the requested mobile target the X app or `x.com` in a browser?
2. First AI funding: quota-limited managed trial (assumed), friend BYOK, or keywords only?
3. First shared build's community contribution: off (assumed), separate opt-in, or on by default? Recommendation is off regardless of the eventual community plan.
4. Initial store visibility: unlisted link (assumed) or public? Does an existing XFeed Paradise store item already exist under the intended publisher account?
