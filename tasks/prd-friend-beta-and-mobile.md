# PRD: Friend beta, Chrome Web Store, and mobile path

Status: release direction confirmed, 2026-09-24. Jacob chose a desktop-Chrome-first, unlisted Chrome Web Store release with capped managed AI scoring and **no community feed upload**. Details of the managed service and publisher account remain to be verified. This document is a plan, not an implementation or a store submission.

## 1. Introduction and current status

Get XFeed Paradise into a friend's hands through an unlisted Chrome Web Store item without uploading their feed or embedding a shared AI key in the extension. Use the trial to validate the filter before a broader launch and mobile work.

Current v1.3.1 facts from the source audit:

- X/Twitter and Google News content scripts save encountered items in local IndexedDB.
- Groq GPT-OSS 20B scores items when the user has provided a Groq key. Item text is sent to Groq for scoring. Without a key, keyword scoring is available.
- **Community sync is currently on by default**: `db.js` treats an absent `xfp_sync_enabled` preference as true, and the popup checkbox starts checked. When an AI refinement callback runs while the item remains in the page, the script queues text, URL, author identifiers, score, visibility and engagement fields for Supabase. The callback also incorrectly marks a keyword fallback as `scoredWithAI: true`.
- The configured `xvexqhejjdcysxgxanlm.supabase.co` hostname returned NXDOMAIN from local, Cloudflare and Google DNS on 2026-09-24. Upload attempts to that URL should fail now; actual historical uploads and deployed database state were **not** verified.
- There is no Cloudflare Workers AI fallback or managed-key proxy in the extension. The old backend repository is a Supabase prototype, not a working managed Groq service.
- The Chrome Web Store publisher account and any existing unlisted listing have not been inspected. Store assets exist, but release copy and packaging need review.

## 2. Recommended product shape and release sequence

One Chrome extension listing and one shared scoring core. Use clearly separated modes/features, not two nearly identical Chrome extensions:

1. **No-upload desktop build:** remove/disable Supabase ingestion and its host permission, including for upgrades from the old default-on sync setting. Keyword scoring still works when managed AI is unavailable. Test the unpacked build on desktop Chrome before store submission.
2. **Capped managed AI trial:** the extension sends only text needed for scoring to a small authenticated proxy. The proxy holds a dedicated Groq key, enforces per-invite and aggregate budgets, and does not retain post text. The user sees clear disclosure that scoring text leaves the device. Community feed upload remains absent. Keep BYOK, if retained, as an optional advanced mode—not a requirement for the friend.
3. **Unlisted Chrome Web Store release:** submit that same no-feed-upload build as one unlisted item and send its install link to the friend after review. Unlisted links can be shared but are not access controls; all visibility modes receive store review. Do not create a duplicate “mobile” Chrome listing.
4. **Optional community feed, later and conditional:** do not restore backend ingestion merely by adding an opt-in toggle. First resolve X/Google News content-rights and terms questions, then service design, exact consent, retention/deletion and access controls. If viable, make it a separately disclosed opt-in feature.
5. **Mobile:** share the scoring/filtering core, but package and adapt it for a supported mobile browser. iOS Safari web extension/TestFlight is the likely iPhone route; Firefox for Android add-ons are an Android possibility. Neither route can filter the native X app without a different product integration.

If the friend's first device is not desktop Chrome, reorder stages 1–3 after a device-specific spike. Google says Chrome Web Store extensions cannot be installed in mobile Chrome; Apple provides a Safari web-extension conversion and distribution path; Mozilla supports Firefox Android add-ons. [Chrome support](https://support.google.com/chrome_webstore/answer/1698338), [Apple Safari extensions](https://developer.apple.com/safari/extensions/), [Firefox Android](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android).

## 3. Goals

- Give one invited friend a working, clearly disclosed feed filter with a minimal setup path.
- Ensure the first shared build has no community feed upload path, regardless of old sync preferences.
- Allow the friend to try AI scoring without receiving a raw Groq key, subject to a server-enforced usage cap.
- Make the first store package and privacy disclosures match observed network behavior.
- Keep mobile work from delaying the desktop friend trial.

## 4. User stories

### US-001: Local-only default

As a new user, I want filtering to work without an account and without contributing my feed to a database.

Acceptance criteria:
- [ ] A fresh install and an upgraded install cannot send community-ingestion requests, regardless of the old `xfp_sync_enabled` value.
- [ ] X and Google News filtering work with keyword scoring when AI is unavailable.
- [ ] Scrolling, successful AI scoring, and AI failure generate no requests to the old Supabase host in the release build.
- [ ] The popup says where local data is kept and which text, if any, leaves the device.
- [ ] Automated checks cover fresh, migrated, and explicitly opted-out preferences.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-002: Managed, capped AI trial

As an invited tester, I want AI scoring to work without creating or handling a provider key.

Acceptance criteria:
- [ ] The extension package and Chrome storage contain no shared Groq or Cloudflare secret.
- [ ] A revocable invite credential is required; invalid or exhausted invites fall back to keyword scores without blocking the feed.
- [ ] The proxy enforces per-invite and aggregate request/token budgets and a 10-item maximum batch.
- [ ] The proxy sends only scoring text to Groq, does not persist post text, and records only minimal usage/error counters; the extension explains this transfer before AI is enabled.
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
- [ ] Match manifest permissions to actual hosts/features; remove the obsolete Supabase host permission and community-sync UI from the first release.
- [ ] Refresh screenshots, listing, privacy policy, test instructions and data-use declarations to reflect the exact shipped behavior.
- [ ] Upload a versioned ZIP with `manifest.json` at its root and pass local unpacked smoke tests before submission.
- [ ] Submit one **unlisted** item; record review status and final install link. Review is an external gate, not a guaranteed delivery time.
- [ ] Verify in browser using dev-browser skill (or the available equivalent browser test surface).

### US-005: Later optional community contribution

As a user, I want to choose whether my viewed posts contribute to a shared feed.

Acceptance criteria:
- [ ] Source-platform content rights and terms have been reviewed before implementing any upload path; user consent alone does not settle these questions.
- [ ] If the feature proceeds, it remains off until the user takes a clear affirmative action after seeing exact fields, recipient, purpose, retention and deletion terms.
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

- FR-1: The first release must not upload feed items to a community database, including for users upgrading from the current default-on sync setting.
- FR-2: Keep local keyword scoring usable without a provider or managed-service credential.
- FR-3: Keep scoring traffic separate from community ingestion; disclose scoring text sent to the proxy/Groq and do not store it as a shared feed.
- FR-4: Route managed trial requests through a backend holding the Groq secret, with revocable invitations and server-side budgets.
- FR-5: Show the active mode, provider/fallback status, and data-sharing state in the extension UI.
- FR-6: Build the store artifact from an explicit allowlist and check it for bundled credentials.
- FR-7: Require a source-terms/content-rights review and an explicit consent flow before any later feed-ingestion feature.
- FR-8: Use a shared scoring contract across desktop/mobile adapters; platform-specific DOM and UI remain separate.

## 6. Non-goals for the first friend release

- No mobile Chrome extension or native X-app interception.
- No upload of viewed feed items to Supabase or another community database, even if an old installation had sync enabled.
- No public, unlimited shared API key embedded in the extension.
- No separate “sync edition” or “mobile edition” Chrome listing.
- No automatic Cloudflare Workers AI fallback until managed proxy usage and failure rates justify it.

## 7. Technical and store considerations

- A Cloudflare Worker could host the managed scoring endpoint and later invoke either Groq or Workers AI. If chosen, keep provider selection on the server, not in the extension; use a separate Groq project key, quotas, size limits and abuse controls. Groq explicitly advises a trusted backend proxy for browser clients, and its free GPT-OSS 20B limit is shared at the organization level. [Groq security](https://console.groq.com/docs/production-readiness/security-onboarding), [Groq limits](https://console.groq.com/docs/rate-limits).
- When needed, add Workers AI GPT-OSS 20B as a **server-side** fallback for Groq quota/429/5xx. Cap Cloudflare Neurons and degrade to keywords if both providers fail. See [capacity estimate](../docs/CLOUDFLARE_WORKERS_AI_USAGE.md).
- The current `build.sh` zips the repository recursively without excluding older ZIP files, so fix and inspect the release artifact before submission.
- The current store listing says filtering is entirely local despite external AI calls, and mentions optional community sync that is currently on by default. Reconcile code, popup, listing and privacy policy before publishing. Chrome requires accurate disclosures and user consent for relevant data practices. [Store user-data policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [publication steps](https://developer.chrome.com/docs/webstore/publish/).
- For a later shared feed, X's current terms prohibit scraping without prior written consent and restrict reproduction/transmission of its content outside provided interfaces; Google's terms note third-party rights in Google News content. An opt-in toggle is not, by itself, clearance to ingest and redistribute that content. [X terms](https://x.com/en/tos), [Google terms](https://policies.google.com/terms?hl=en-US).
- Store review is variable and applies to unlisted/private items too. A direct unpacked install can reach a technical friend sooner; a reviewed store link is the smoother general onboarding route. [Distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [review process](https://developer.chrome.com/docs/webstore/review-process/).

## 8. Success metrics

- The invited friend completes setup and sees at least ten scored/filtered items on the chosen supported surface.
- Zero community-ingestion requests from fresh and upgraded installs, verified in network inspection.
- Zero shared provider keys in the published package or current release source tree.
- Managed trial stays within configured per-invite and provider budgets; on limit/error, local filtering continues.
- One submitted store item has a verified install link after review.

## 9. Comparable Chrome extensions (store listings checked 2026-09-24)

- [Cocoon](https://chromewebstore.google.com/detail/cocoon/ohidacajglhknbikhmdbkaiplbgcgjkj): AI filtering of X based on interests, BYO OpenRouter key, no developer-run feed database claimed.
- [AI Twitter Filter](https://chromewebstore.google.com/detail/ai-twitter-filter/gpgmeejjkhbmepdcffeooijjjdbbdikg): natural-language X filters such as negativity or rage bait, BYO OpenAI/OpenRouter key, post text sent to provider for evaluation.
- [FeedShield](https://chromewebstore.google.com/detail/feedshield/ngpbogmnapokeceaaaegjgmaabgppifd): X rage-bait/AI-slop filter with a managed classification service and a published free usage cap; its listing says post text is sent to its server but not stored permanently.
- [CleanX](https://chromewebstore.google.com/detail/cleanx/khncgaglndkecnodbfpfbpefpnelfmbc): X negativity/rage-bait filter advertising managed cloud AI and an on-device option.
- [News Blockade](https://chromewebstore.google.com/detail/news-blockade/ghcpgpmeofengchfmphanicmllephfdj): keyword-based filtering that works on Google News; not an AI-powered uplift/rage classifier.

These are descriptions from current listings, not independent audits of their behavior. They establish that both BYOK and capped managed-service models exist; they do not establish store approval for a shared corpus of scraped posts. XFeed Paradise's proposed differentiation is an attention-protective score across X **and** Google News, with local fallback and explicit data-flow choices. Validate that framing with the friend rather than assuming uniqueness.

## 10. Remaining questions and external gates

1. Confirm the publisher account and whether an XFeed Paradise store item already exists; update an existing item if appropriate.
2. Define the managed invite budget, abuse controls and dedicated Groq key ownership before implementation. The friend's keyless experience must not expose the key in the package.
3. For later mobile work, is the target `x.com` in a supported mobile browser or the native X app? Which mobile platform should follow desktop?
4. The unlisted item still needs Chrome Web Store review before the friend receives a store link.
