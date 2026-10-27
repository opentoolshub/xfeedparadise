'use strict';

// Seven levels, ordered from the low end of the vibe scale to the high end.
// A backend returns an expected level index (0..6); toVibe maps it to -100..100.
const LEVELS = [
  'Outrage-bait: hostile, insulting or inflammatory; written to provoke anger, fear or tribal conflict',
  'Divisive: contemptuous, mocking or us-versus-them, without open hostility',
  'Negative: cynical, complaining or alarmist',
  'Neutral: plain information, announcements or everyday chatter',
  'Pleasant: friendly, light or mildly positive',
  'Constructive: helpful, encouraging or generous',
  'Uplifting: kind, insightful, educational or inspiring; leaves the reader better off'
];

const INSTRUCTIONS = 'How uplifting versus outrage-inducing is this social media post?';

function clampScore(n) {
  return Math.max(-100, Math.min(100, Math.round(Number(n))));
}

// Expected level from a probability distribution. Accepts the Decisions array
// form [{value, probability}] and the System One object form {"0": p, ...}.
function expectedLevel(probabilities) {
  if (!probabilities || typeof probabilities !== 'object') return null;
  const pairs = Array.isArray(probabilities)
    ? probabilities.map(p => [p && p.value, p && p.probability])
    : Object.entries(probabilities);
  let total = 0;
  let weighted = 0;
  for (const [level, p] of pairs) {
    const lv = Number(level);
    const pv = Number(p);
    if (Number.isFinite(lv) && Number.isFinite(pv) && pv >= 0) {
      total += pv;
      weighted += lv * pv;
    }
  }
  return total > 0 ? weighted / total : null;
}

// Map a score answer to -100..100. Prefers the returned expected score, then
// the probability distribution. Returns null when neither is usable.
function toVibe(answer, levels = LEVELS.length) {
  if (!answer || typeof answer !== 'object') return null;
  let position = null;
  if (answer.score !== null && answer.score !== undefined && Number.isFinite(Number(answer.score))) {
    position = Number(answer.score);
  } else {
    position = expectedLevel(answer.probabilities);
  }
  if (position === null) return null;
  position = Math.max(0, Math.min(levels - 1, position));
  return clampScore(-100 + (200 * position) / (levels - 1));
}

module.exports = { LEVELS, INSTRUCTIONS, clampScore, expectedLevel, toVibe };
