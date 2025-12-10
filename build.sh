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
OUTPUT="xfeed-paradise-v${VERSION}.zip"

# Remove old build if exists
rm -f "$OUTPUT"

# Create zip excluding dev files
zip -r "$OUTPUT" . \
  -x "*.git*" \
  -x "node_modules/*" \
  -x "*.map" \
  -x "docs/*" \
  -x "store_assets/*" \
  -x "*.sh" \
  -x "*.md" \
  -x ".DS_Store" \
  -x "src/*" \
  -x "build.js" \
  -x "package*.json" \
  -x ".claude/*" \
  -x "PROMPTS.md" \
  -x "CLAUDE.md"

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
echo "5. Set privacy policy URL to: https://github.com/tmad4000/XFeedParadise/blob/main/PRIVACY.md"
