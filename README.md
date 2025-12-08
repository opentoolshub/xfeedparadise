# 🌴 XFeed Paradise

A Chrome extension that transforms your X/Twitter feed into a paradise of uplifting, enlightening content by filtering out outrage-bait and negativity.

## Features

### MVP (Current Version)
- **Vibe-based filtering**: Automatically scores tweets based on whether they're uplifting vs. outrage-inducing
- **Multiple filter modes**:
  - **Hide**: Completely hides low-vibe tweets
  - **Dim**: Fades out negative content (hover to reveal)
  - **Collapse**: Shows a label with option to expand
- **Adjustable threshold**: Set your own vibe score cutoff
- **Debug mode**: Optionally show vibe scores on tweets
- **Local database**: Stores all tweets you see in IndexedDB for future features

### Scoring System
The algorithm scores tweets from -100 (pure outrage) to +100 (enlightening) based on:

**Positive signals (+points):**
- Learning & growth language (discover, insight, wisdom)
- Gratitude & appreciation (grateful, thankful, blessed)
- Connection & community (together, support, kindness)
- Achievement & progress (accomplished, milestone, launched)
- Mindfulness & wellness (peaceful, healing, growth)
- Intellectual content (research, nuanced, evidence)

**Negative signals (-points):**
- Outrage language (furious, disgusting, unacceptable)
- Divisiveness (enemy, us vs them, wake up sheeple)
- Fear-mongering (terrifying, crisis, warning)
- Contempt & insults (stupid, idiot, pathetic)
- Manipulation tactics (obviously, exposed, ratio)
- Engagement bait (ALL CAPS, excessive punctuation, "retweet if")

## Installation

### From Source (Developer Mode)

1. **Clone or download this repository**
   ```bash
   git clone https://github.com/yourusername/XFeedParadise.git
   cd XFeedParadise
   ```

2. **Generate icons** (optional but recommended)
   - Open `generate-icons.html` in a browser
   - Right-click each canvas and save as `icon16.png`, `icon48.png`, `icon128.png`
   - Move them to the `icons/` folder

   Or run: `cd icons && node create-icons.js` for placeholder icons

3. **Load in Chrome**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `XFeedParadise` folder

4. **Visit X/Twitter**
   - Go to https://x.com or https://twitter.com
   - The extension will start filtering your feed automatically

## Usage

### Popup Controls
Click the extension icon to access:

- **Filter Active**: Toggle filtering on/off
- **Vibe Threshold**: Slider to set minimum score (-50 to +50)
  - 0: Hide negative content
  - -20: Only hide very negative content
  - +20: Only show genuinely positive content
- **Filter Mode**: Choose how to handle low-vibe tweets
- **Show vibe scores**: Debug mode to see scores on each tweet
- **Stats**: View how many tweets have been collected

### Customization
Edit `filter.js` to customize the scoring algorithm:
- Add words to `positivePatterns` or `negativePatterns`
- Adjust weights for different categories
- Add structural pattern detection

## Data Storage

All tweets are stored locally in your browser using IndexedDB:
- Tweet text and metadata
- Author information
- Engagement metrics
- Vibe scores
- Timestamp when collected
- Which feed it came from

This data never leaves your browser and can be cleared via the popup.

## Future Roadmap

### Phase 1.5: Enhanced Filtering
- [ ] Custom word lists (add your own positive/negative triggers)
- [ ] Per-user vibe settings (always show/hide specific accounts)
- [ ] Time-based filtering (more lenient during certain hours)

### Phase 2: Shared Database
- [ ] Optional sync to shared database
- [ ] Browse high-vibe tweets from all users
- [ ] Custom feed algorithm based on aggregated data
- [ ] "Paradise Mode" - completely replace feed with curated content

### Phase 3: AI Enhancement
- [ ] LLM-based content analysis for better scoring
- [ ] Personalized vibe models
- [ ] Topic-based filtering

## Development

### Project Structure
```
XFeedParadise/
├── manifest.json       # Extension configuration
├── content.js          # Main content script (runs on X/Twitter)
├── filter.js           # Vibe scoring algorithm
├── db.js              # IndexedDB wrapper
├── background.js      # Service worker
├── popup.html/js      # Extension popup UI
├── styles.css         # Injected styles
└── icons/             # Extension icons
```

### Testing Changes
1. Make your edits
2. Go to `chrome://extensions/`
3. Click the refresh icon on the XFeed Paradise card
4. Reload X/Twitter

## Contributing

PRs welcome! Some ideas:
- Improve the scoring algorithm
- Add support for different languages
- Create better pattern detection
- Build the shared database backend

## License

MIT

---

*Transform your timeline. Raise your vibe.* 🌴
