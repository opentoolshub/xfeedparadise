#!/bin/bash
# Archive the iOS app and package a signed App Store IPA for TestFlight.
#
#   safari/scripts/archive-ios.sh APP_PROFILE EXT_PROFILE [BUILD_NUMBER]
#
# APP_PROFILE / EXT_PROFILE: IOS_APP_STORE .mobileprovision files for
#   io.opentoolshub.xfeedparadise and io.opentoolshub.xfeedparadise.Extension
#   (created through the App Store Connect API, signed by the identity below).
# BUILD_NUMBER defaults to 1; it must increase for every upload.
# Env: SIGN_IDENTITY  codesign identity (name or SHA-1); default "Apple Distribution: IdeaFlow, Inc. (JESMXK96LG)"
#      OUT            output directory (default safari/build/release)
#
# Run it inside a GUI login session (for example a tmux server started from the
# desktop session). codesign over a plain SSH session fails with
# errSecInternalComponent because it cannot reach the login keychain.
# The archive is built unsigned and signed by hand, because Xcode's export step
# has been unreliable with Xcode 26.2 on these machines.
set -euo pipefail

APP_PROFILE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
EXT_PROFILE=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
BUILD_NUMBER=${3:-1}
TEAM=JESMXK96LG
APP_ID=io.opentoolshub.xfeedparadise
SIGN_IDENTITY=${SIGN_IDENTITY:-"Apple Distribution: IdeaFlow, Inc. (JESMXK96LG)"}

SAFARI=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-$SAFARI/build/release}
VERSION=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SAFARI/../manifest.json")
ARCHIVE="$OUT/XFeedParadise-iOS-$VERSION-$BUILD_NUMBER.xcarchive"
IPA="$OUT/XFeedParadise-$VERSION-$BUILD_NUMBER.ipa"
WORK="$OUT/ipa-work"

echo "==> archive $VERSION ($BUILD_NUMBER), unsigned"
rm -rf "$ARCHIVE" "$WORK" "$IPA"
mkdir -p "$OUT"
xcodebuild -project "$SAFARI/XFeed Paradise/XFeed Paradise.xcodeproj" -scheme "XFeed Paradise (iOS)" \
  -configuration Release -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -derivedDataPath "$OUT/DerivedData" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  archive > "$OUT/archive.log" 2>&1 || { grep -E ' error:' "$OUT/archive.log" | sort -u | head; echo "archive failed, see $OUT/archive.log"; exit 1; }

mkdir -p "$WORK/Payload"
cp -Rp "$ARCHIVE/Products/Applications/XFeed Paradise.app" "$WORK/Payload/"
APP="$WORK/Payload/XFeed Paradise.app"
EXT="$APP/PlugIns/XFeed Paradise Extension.appex"
[ -f "$EXT/manifest.json" ] || { echo "extension resources missing from the archive"; exit 1; }

sign() { # bundle profile bundle-id
  local bundle=$1 profile=$2 id=$3 ent
  ent=$(mktemp -t xfp-ent).plist
  cp "$profile" "$bundle/embedded.mobileprovision"
  /usr/bin/python3 - "$ent" "$TEAM" "$id" <<'PY'
import plistlib, sys
path, team, bundle_id = sys.argv[1:]
plistlib.dump({"application-identifier": "%s.%s" % (team, bundle_id),
               "com.apple.developer.team-identifier": team,
               "get-task-allow": False,
               "beta-reports-active": True}, open(path, "wb"))
PY
  codesign --force --sign "$SIGN_IDENTITY" --entitlements "$ent" --generate-entitlement-der "$bundle"
  rm -f "$ent"
}

echo "==> sign"
sign "$EXT" "$EXT_PROFILE" "$APP_ID.Extension"
sign "$APP" "$APP_PROFILE" "$APP_ID"
codesign --verify --deep --strict "$APP"

echo "==> package"
[ -d "$ARCHIVE/SwiftSupport" ] && cp -Rp "$ARCHIVE/SwiftSupport" "$WORK/"
xattr -cr "$WORK"
(cd "$WORK" && zip -qry "$IPA" .)
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E '^(Identifier|Authority=Apple Distribution|TeamIdentifier)'
echo "IPA: $IPA ($(du -h "$IPA" | cut -f1))"
