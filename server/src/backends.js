'use strict';

// Scoring backends. Each takes post texts and returns
//   { scores: number[] (-100..100), usage: { inputTokens, outputTokens } }
// or throws a BackendError. Post text is sent only to the backend API and is
// never logged; error objects carry codes and HTTP statuses only.

const { LEVELS, INSTRUCTIONS, clampScore, toVibe } = require('./rubric');

class BackendError extends Error {
  constructor(code, httpStatus = null) {
    super(code);
    this.code = code; // 'http_error' | 'network_error' | 'invalid_response' | 'timeout'
    this.httpStatus = httpStatus;
  }
}

async function postJson(fetchImpl, url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw new BackendError(error && error.name === 'AbortError' ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // Drain the body without keeping it: provider errors can echo the input.
    try { await response.text(); } catch (e) { /* ignore */ }
    throw new BackendError('http_error', response.status);
  }
  try {
    return await response.json();
  } catch (e) {
    throw new BackendError('invalid_response', response.status);
  }
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ------------------------------------------------------------- OpenAI Decisions

// One call scores the whole batch: the posts are numbered in a single input
// and each gets its own named score question. Verified to return one answer
// per question, in order, with the requested names.
function decisionsRequest(texts, model) {
  const levels = LEVELS.map(label => ({ label }));
  if (texts.length === 1) {
    return { model, input: texts[0], questions: [{ type: 'score', instructions: INSTRUCTIONS, levels }] };
  }
  return {
    model,
    input: texts.map((t, i) => `Post ${i + 1}:\n${t}`).join('\n\n'),
    questions: texts.map((_, i) => ({
      type: 'score',
      name: `post_${i + 1}`,
      instructions: `${INSTRUCTIONS} Rate only Post ${i + 1}.`,
      levels
    }))
  };
}

function decisionsScores(data, count) {
  const answers = data && Array.isArray(data.answers) ? data.answers : null;
  if (!answers || answers.length !== count) return null;
  const byName = new Map(answers.filter(a => a && a.name).map(a => [a.name, a]));
  const scores = [];
  for (let i = 0; i < count; i++) {
    const answer = count === 1 ? answers[0] : (byName.get(`post_${i + 1}`) || answers[i]);
    const vibe = toVibe(answer);
    if (vibe === null) return null;
    scores.push(vibe);
  }
  return scores;
}

const decisions = {
  id: 'decisions',
  keyEnv: 'OPENAI_API_KEY',
  async score(texts, { fetch: fetchImpl, apiKey, env = {}, timeoutMs = 15000 }) {
    const model = env.XFEED_DECISIONS_MODEL || 'gpt-6-luna';
    const data = await postJson(fetchImpl, 'https://api.openai.com/v1/decisions', apiKey,
      decisionsRequest(texts, model), timeoutMs);
    const scores = decisionsScores(data, texts.length);
    if (!scores) throw new BackendError('invalid_response', 200);
    const usage = (data && data.usage) || {};
    return { scores, usage: { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) } };
  }
};

// ------------------------------------------------------------- TypeSafe Jev

function jevRequest(text, model) {
  return {
    model,
    state: text,
    questions: { vibe: { type: 'score', instructions: INSTRUCTIONS, criteria: LEVELS } }
  };
}

const jev = {
  id: 'jev',
  keyEnv: 'TYPESAFE_API_KEY',
  concurrency: 5,
  async score(texts, { fetch: fetchImpl, apiKey, env = {}, timeoutMs = 15000 }) {
    const model = env.XFEED_JEV_MODEL || 'jev-latest';
    const scores = new Array(texts.length).fill(null);
    const usage = { inputTokens: 0, outputTokens: 0, reported: true };
    let next = 0;
    let failed = null;
    async function worker() {
      while (!failed && next < texts.length) {
        const index = next++;
        try {
          const data = await postJson(fetchImpl, 'https://api.typesafe.ai/v1/systemone', apiKey,
            jevRequest(texts[index], model), timeoutMs);
          const vibe = toVibe(data && data.answers && data.answers.vibe);
          if (vibe === null) throw new BackendError('invalid_response', 200);
          scores[index] = vibe;
          const u = data.usage || {};
          if (u.input_tokens === undefined && u.prompt_tokens === undefined) usage.reported = false;
          usage.inputTokens += num(u.input_tokens ?? u.prompt_tokens);
          usage.outputTokens += num(u.output_tokens ?? u.completion_tokens);
        } catch (error) {
          if (!failed) failed = error;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, texts.length) }, worker));
    if (failed) throw failed instanceof BackendError ? failed : new BackendError('network_error');
    if (!usage.reported) { usage.inputTokens = 0; usage.outputTokens = 0; }
    return { scores, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
  }
};

// ------------------------------------------------------------- gpt-5.4-nano (chat completions)

// Same batch prompt as the extension's default (providers.js buildBatchPrompt).
function batchPrompt(texts) {
  const list = texts.map((t, i) => `${i + 1}. "${String(t).slice(0, 200)}"`).join('\n');
  return `Rate the sentiment/vibe of each tweet from -100 (very negative, toxic, outrage-bait) to +100 (very positive, uplifting, enlightening).

Consider for each: Is it angry/divisive? Inflammatory? Spreading fear/hate? Or kind, helpful, educational, inspiring?

Reply with ONLY the scores as a JSON array of integers, like: [25, -30, 50, -10, ...]
One number per tweet, in the same order. No other text.

Tweets to rate:
${list}`;
}

function parseScoreArray(content, count) {
  if (typeof content !== 'string') return null;
  const match = content.match(/\[[\d\s,.\-]+\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    if (Array.isArray(arr) && arr.length === count && arr.every(s => Number.isFinite(Number(s)))) {
      return arr.map(clampScore);
    }
  } catch (e) { /* fall through */ }
  return null;
}

const nano = {
  id: 'nano',
  keyEnv: 'OPENAI_API_KEY',
  async score(texts, { fetch: fetchImpl, apiKey, env = {}, timeoutMs = 20000 }) {
    const model = env.XFEED_NANO_MODEL || 'gpt-5.4-nano';
    const data = await postJson(fetchImpl, 'https://api.openai.com/v1/chat/completions', apiKey, {
      model,
      messages: [{ role: 'user', content: batchPrompt(texts) }],
      max_completion_tokens: 1024,
      reasoning_effort: 'low'
    }, timeoutMs);
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    const scores = parseScoreArray(content, texts.length);
    if (!scores) throw new BackendError('invalid_response', 200);
    const usage = (data && data.usage) || {};
    return { scores, usage: { inputTokens: num(usage.prompt_tokens), outputTokens: num(usage.completion_tokens) } };
  }
};

const BACKENDS = { decisions, jev, nano };

module.exports = { BACKENDS, BackendError, decisionsRequest, decisionsScores, jevRequest, batchPrompt, parseScoreArray };
