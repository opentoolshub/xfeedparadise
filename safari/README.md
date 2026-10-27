# XFeed Paradise for Safari (iPhone, iPad and Mac)

This directory packages the extension at the repository root as a Safari Web
Extension inside a small containing app, so XFeed Paradise can filter x.com
and Google News in Safari on iOS, iPadOS and macOS.

The repository root stays the only copy of the extension source. The Xcode
project does not list the extension files. Each extension target has a
**Sync web extension** build phase that runs `scripts/sync-extension.py`. That
script copies every file the manifest and popup reference into the `.appex`,
and writes a Safari manifest with a classic background service worker:
`providers.js` is inlined because module service workers aren't reliable in
Safari on iOS.

```
safari/
  XFeed Paradise/              Xcode project (iOS + macOS app and extension targets)
    Shared (App)/              containing-app screen (Main.html, Style.css, Script.js)
    Shared (Extension)/        native message handler (unused by the extension)
  scripts/sync-extension.py    repo root -> .appex resources (run by Xcode)
  scripts/archive-ios.sh       signed App Store IPA for TestFlight
  scripts/postprocess-xcodeproj.py   applied once after regenerating the project
  fixtures/x-timeline.html     x.com-like page for simulator smoke tests
```

| | |
|---|---|
| App bundle ID | `io.opentoolshub.xfeedparadise` |
| Extension bundle ID | `io.opentoolshub.xfeedparadise.Extension` |
| Team | `JESMXK96LG` |
| Minimum OS | iOS/iPadOS 16.0, macOS 12.0 |
| Version | Taken from `manifest.json` (`MARKETING_VERSION`) |

## Build

Requirements: Xcode 26 or later (tested with 26.2). No other tools are needed.
The build phase uses the system `python3`.

Open `safari/XFeed Paradise/XFeed Paradise.xcodeproj` in Xcode and run the
**XFeed Paradise (iOS)** or **XFeed Paradise (macOS)** scheme. From the command
line:

```sh
cd "safari/XFeed Paradise"

# iOS Simulator
xcodebuild -project "XFeed Paradise.xcodeproj" -scheme "XFeed Paradise (iOS)" \
  -sdk iphonesimulator -destination "generic/platform=iOS Simulator" \
  -derivedDataPath ../build/DerivedData build

# macOS (ad-hoc signed, for local testing)
xcodebuild -project "XFeed Paradise.xcodeproj" -scheme "XFeed Paradise (macOS)" \
  -configuration Release -destination "generic/platform=macOS" \
  -derivedDataPath ../build/DerivedData CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
```

`safari/build/` is git-ignored. Run `npm test` at the repository root after
changing the extension; `test/mobile.test.js` also checks the Safari resource
build.

### Simulator smoke test

1. Build a Debug app that also injects into a local page:
   add `XFP_EXTRA_MATCHES="http://localhost/*"` to the iOS Simulator command
   above. The sync script refuses this setting in Release builds.
2. Serve the fixture: `cd safari/fixtures && python3 -m http.server PORT --bind 127.0.0.1`
3. `xcrun simctl install <device> "safari/build/DerivedData/Build/Products/Debug-iphonesimulator/XFeed Paradise.app"`
4. Enable the extension in the simulator's Settings app (see below) and set
   **localhost** to **Allow**. No `simctl` command does this, so tap it by hand
   or drive Settings with an XCUITest.
5. Open `http://localhost:PORT/x-timeline.html` in the simulator's Safari. Three
   outrage-bait posts are hidden and the palm-tree button shows a badge of 3.
   Switch the panel to Dim or Collapse and tap a post to check touch behaviour.

## Signed build for TestFlight

1. **One-time, in a browser:** create the App Store Connect app record. The App
   Store Connect API can't create apps. Go to
   [App Store Connect → Apps](https://appstoreconnect.apple.com/apps), choose **+** → **New App**, and enter:
   - Platforms: iOS (add macOS too for a Mac App Store build)
   - Name: **XFeed Paradise**
   - Primary language: English (U.S.)
   - Bundle ID: **io.opentoolshub.xfeedparadise**
   - SKU: **xfeedparadise-ios-001**
   - User access: Full Access

   Both bundle IDs are already registered, as `UNIVERSAL`, through the API.
2. Create `IOS_APP_STORE` provisioning profiles for both bundle IDs, signed by
   the team's Apple Distribution certificate. You can do this through the App
   Store Connect API (`POST /v1/profiles`) or in the developer portal.
3. In a GUI login session, run:

   ```sh
   safari/scripts/archive-ios.sh app.mobileprovision extension.mobileprovision BUILD_NUMBER
   ```

   The archive is built unsigned, then the extension and app are signed with
   the distribution identity. The result is
   `safari/build/release/XFeedParadise-<version>-<build>.ipa`.
   codesign can't reach the login keychain from a plain SSH session and fails
   with `errSecInternalComponent`.
4. Validate, then upload, with an App Store Connect API key:

   ```sh
   xcrun altool --validate-app -f XFeedParadise-*.ipa -t ios --apiKey KEY_ID --apiIssuer ISSUER_ID
   xcrun altool --upload-app   -f XFeedParadise-*.ipa -t ios --apiKey KEY_ID --apiIssuer ISSUER_ID
   ```

   Every upload needs a higher `BUILD_NUMBER`. The app declares
   `ITSAppUsesNonExemptEncryption = NO`, so TestFlight doesn't ask about export
   compliance.
5. Once the build finishes processing, add it to an internal testing group in
   App Store Connect → TestFlight.

### Install on an iPhone with TestFlight

1. Accept the TestFlight invitation email, or open the public link, on the iPhone.
2. Install **TestFlight** from the App Store if needed, then install XFeed Paradise from it.
3. Open XFeed Paradise once. It shows the steps below.

## Turn it on in Safari

**iPhone and iPad**

1. Open **Settings** → **Apps** → **Safari** → **Extensions** → **XFeed Paradise**
   (on iOS 17 and earlier: Settings → Safari → Extensions).
2. Turn on **Allow Extension**.
3. Under Permissions, set **x.com**, **news.google.com** and **api.groq.com** to
   **Allow**. Also allow any other AI provider you configure. Safari treats the
   provider's API host as a website, so AI scoring needs it.
4. Alternatively, in Safari on x.com, tap the page menu in the address bar →
   **XFeed Paradise** → **Always Allow on This Website**.

Open x.com in Safari. The round palm-tree button opens the filter panel. The
toolbar popup is under the page menu → **XFeed Paradise**.

**Mac**

Open the app once, then go to Safari → **Settings** → **Extensions**, turn on
**XFeed Paradise**, and allow x.com, news.google.com and api.groq.com.

## Behaviour on touch screens

- Hide and Collapse work the same as on desktop. **Show anyway** is a normal tap target.
- Dim: touch screens have no hover. The first tap on a dimmed post reveals it
  instead of opening it, and the next tap opens it as usual.
- The panel, toasts and popup follow the screen's safe areas and fit phone widths.

## Regenerating the Xcode project

The project is committed, so only regenerate it if the converter's template has
to change:

```sh
python3 safari/scripts/sync-extension.py --out safari/build/WebExtension
cd safari && xcrun safari-web-extension-converter build/WebExtension --project-location . \
  --app-name "XFeed Paradise" --bundle-identifier io.opentoolshub.xfeedparadise --swift --no-open --no-prompt --force
python3 scripts/postprocess-xcodeproj.py "XFeed Paradise/XFeed Paradise.xcodeproj/project.pbxproj" "$(python3 -c 'import json;print(json.load(open("../manifest.json"))["version"])')"
```

Then restore the customised files with `git checkout` and review the diff:

- `Shared (App)/Resources/*`
- `Shared (App)/ViewController.swift`
- the opaque 1024 px `AppIcon` image

## Known limitations

- The optional AI providers rely on `optional_host_permissions` and
  `permissions.request`. In Safari the user grants hosts in Safari's own
  settings, so allow the provider's API host there if a provider reports that
  access isn't granted.
- Safari may suspend the background worker. State lives in extension storage,
  so it restarts cleanly.
- `storage.sync` doesn't sync between Safari and Chrome.
