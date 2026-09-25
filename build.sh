#!/bin/bash

# XFeed Paradise - Build script for Chrome Web Store
# Creates a clean zip file ready for submission

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Building XFeed Paradise for Chrome Web Store...${NC}"

# Get version from manifest
VERSION=$(grep '"version"' manifest.json | sed 's/.*: "\(.*\)".*/\1/')
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid manifest version: $VERSION" >&2
  exit 1
fi
OUTPUT="xfeed-paradise-v${VERSION}.zip"

# Remove old build if exists
rm -f "$OUTPUT"

# Package only files required by manifest.json; never bundle old ZIPs or plans.
zip -r "$OUTPUT" manifest.json popup.html popup.js background.js \
  content.js content-googlenews.js filter.js db.js styles.css \
  icons/icon16.png icons/icon48.png icons/icon128.png

# Show result
echo -e "${GREEN}Build complete!${NC}"
echo "Output: $OUTPUT"
echo "Size: $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "Next steps:"
echo "1. Go to https://chrome.google.com/webstore/devconsole"
echo "2. Click 'New Item' or update existing"
echo "3. Upload $OUTPUT"
echo "4. Add screenshots from store_assets/"
echo "5. Set privacy policy URL to: https://github.com/opentoolshub/xfeedparadise/blob/main/PRIVACY.md"
