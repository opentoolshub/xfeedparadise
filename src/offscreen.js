// Offscreen document for AI processing
// This runs in its own context, avoiding CSP issues

import { pipeline } from '@xenova/transformers';

let classifier = null;
let isLoading = false;
let loadProgress = 0;

async function initModel() {
  if (classifier || isLoading) return;

  isLoading = true;
  console.log('🌴 Offscreen: Loading AI model...');

  try {
    classifier = await pipeline(
      'sentiment-analysis',
      'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
      {
        progress_callback: (progress) => {
          if (progress.status === 'progress') {
            loadProgress = Math.round(progress.progress);
            // Send progress update to background
            chrome.runtime.sendMessage({
              type: 'AI_PROGRESS',
              progress: loadProgress
            });
          }
        }
      }
    );

    console.log('🌴 Offscreen: AI model loaded!');
    chrome.runtime.sendMessage({ type: 'AI_READY' });

  } catch (error) {
    console.error('🌴 Offscreen: Failed to load model:', error);
    chrome.runtime.sendMessage({ type: 'AI_ERROR', error: error.message });
  }

  isLoading = false;
}

async function scoreTweet(text) {
  if (!classifier) return null;

  try {
    const result = await classifier(text.slice(0, 512));
    if (result && result[0]) {
      const { label, score } = result[0];
      if (label === 'POSITIVE') {
        return Math.round((score - 0.5) * 200);
      } else {
        return Math.round((0.5 - score) * 200);
      }
    }
  } catch (error) {
    console.error('🌴 Offscreen: Scoring error:', error);
  }
  return null;
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INIT_AI') {
    initModel();
    sendResponse({ status: 'initializing' });
  } else if (message.type === 'SCORE_TWEET') {
    scoreTweet(message.text).then(score => {
      sendResponse({ score });
    });
    return true; // Keep channel open for async
  } else if (message.type === 'GET_AI_STATUS') {
    sendResponse({
      ready: !!classifier,
      loading: isLoading,
      progress: loadProgress
    });
  }
  return true;
});

// Auto-init when loaded
initModel();
