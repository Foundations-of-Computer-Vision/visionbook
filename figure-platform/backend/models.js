/**
 * models.js — Unified multi-provider model router
 *
 * Abstracts OpenAI, Anthropic (Claude), and Google (Gemini) behind a single
 * `generateWithModel(modelId, { systemPrompt, userContent, maxTokens })` call.
 *
 * The generator sends vision messages; this module handles the per-provider
 * image format differences so the rest of the server stays clean.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const OpenAI = require('openai').default;
const Anthropic = require('@anthropic-ai/sdk').default;
const sharp = require('sharp');

// ── URL-routed fetch patch — Gemini-only dispatcher ─────────────────────────
// The @google/genai SDK's ApiClient calls bare `fetch()` (globalThis.fetch)
// directly, ignoring any `fetch` option passed to the GoogleGenAI constructor.
// We therefore patch globalThis.fetch with URL-based routing:
//   • requests to generativelanguage.googleapis.com → undici dispatcher with
//     keepAlive=false (fresh TCP per call, avoids stale-socket UND_ERR_SOCKET)
//     and generous timeouts for long streaming generations.
//   • all other requests (OpenAI, Anthropic, etc.) → original fetch unchanged.
try {
  const undici = require('undici');
  const _geminiDispatcher = new undici.Agent({
    connect: { keepAlive: false },  // fresh TCP per request
    headersTimeout: 300_000,        // 5 min — time to first byte
    bodyTimeout: 0,                 // unlimited — stream large HTML responses
  });
  const _origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
    if (urlStr.includes('generativelanguage.googleapis.com') ||
      urlStr.includes('aiplatform.googleapis.com')) {
      return undici.fetch(url, { ...opts, dispatcher: _geminiDispatcher });
    }
    return _origFetch(url, opts);
  };
  console.log('[models] fetch patched: Gemini URLs → undici (keepAlive=false, headersTimeout=5min), others → native');
} catch (_) {
  // undici not available — rely on default fetch with streaming as fallback
}

// ── Lazy-init clients ────────────────────────────────────────────────────────
let _openai = null;
let _anthropic = null;
let _gemini = null;
let _googleGenAIClass = null;
let _geminiQueue = Promise.resolve();
let _lastGeminiRequestAt = 0;

const GEMINI_MAX_IMAGE_DIMENSION = 2048;
const GEMINI_JPEG_QUALITY = 82;
const GEMINI_MIN_REQUEST_INTERVAL_MS = 1200;

function enqueueGemini(task) {
  const run = _geminiQueue.then(task, task);
  _geminiQueue = run.catch(() => { });
  return run;
}

async function prepareGeminiImage(url) {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Gemini adapter: invalid data URL for image');

  const [, mimeType, data] = match;
  const input = Buffer.from(data, 'base64');

  const output = await sharp(input)
    .rotate()
    .resize({
      width: GEMINI_MAX_IMAGE_DIMENSION,
      height: GEMINI_MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: GEMINI_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  return {
    inlineData: {
      mimeType: 'image/jpeg',
      data: output.toString('base64'),
    },
  };
}

function getOpenAI() {
  if (!_openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === 'your_openai_api_key_here')
      throw new Error('OPENAI_API_KEY is not set. Add it to backend/.env');
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

function getAnthropic() {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === 'your_anthropic_api_key_here')
      throw new Error('ANTHROPIC_API_KEY is not set. Add it to backend/.env');
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

async function getGemini() {
  if (!_gemini) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key || key === 'your_google_api_key_here')
      throw new Error('GOOGLE_API_KEY is not set. Add it to backend/.env');
    if (!_googleGenAIClass) {
      ({ GoogleGenAI: _googleGenAIClass } = await import('@google/genai'));
    }
    // fetch option is NOT forwarded by @google/genai's ApiClient — it uses
    // globalThis.fetch directly. The URL-based fetch patch at module load time
    // handles the dispatcher routing without needing a custom fetch here.
    _gemini = new _googleGenAIClass({ apiKey: key });
  }
  return _gemini;
}

// ── Model registry ───────────────────────────────────────────────────────────
// Each entry: { provider, apiModel, label }
//   provider  — 'openai' | 'anthropic' | 'google'
//   apiModel  — the exact string sent to the provider's API
//   label     — human-readable name shown in the UI
const MODEL_REGISTRY = {
  // OpenAI
  'gpt-5.4': { provider: 'openai', apiModel: 'gpt-5.4', label: 'GPT-5.4' },
  'gpt-4o': { provider: 'openai', apiModel: 'gpt-4o', label: 'GPT-4o' },
  'o4-mini': { provider: 'openai', apiModel: 'o4-mini', label: 'o4-mini' },

  // Anthropic (Claude)
  'claude-sonnet-4.6': { provider: 'anthropic', apiModel: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  'claude-opus-4.6':   { provider: 'anthropic', apiModel: 'claude-opus-4-6',   label: 'Claude Opus 4.6'   },
  'claude-opus-4.6':   { provider: 'anthropic', apiModel: 'claude-opus-4-20250514', label: 'Claude Opus 4 (old)' },
  'claude-sonnet-4':   { provider: 'anthropic', apiModel: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (old)' },

  // Google (Gemini)
  'gemini-3.1-pro': { provider: 'google', apiModel: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  'gemini-2.5-pro': { provider: 'google', apiModel: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash': { provider: 'google', apiModel: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
};

// The list the frontend will render in its dropdown
function getAvailableModels() {
  return Object.entries(MODEL_REGISTRY).map(([id, { label, provider }]) => ({
    id, label, provider,
  }));
}

// ── Provider-specific call implementations ───────────────────────────────────

/**
 * OpenAI chat-completions call.
 * userContent is an array of { type:'image_url'|'text', … } objects — already
 * in OpenAI format, so we pass through directly.
 */
async function callOpenAI(apiModel, systemPrompt, userContent, maxTokens) {
  const response = await getOpenAI().chat.completions.create({
    model: apiModel,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });
  return response.choices[0].message.content || '';
}

/**
 * Anthropic messages call.
 * Converts OpenAI-style userContent → Anthropic format:
 *   image_url { url: "data:mime;base64,…" }  →  image { source: { type:'base64', media_type, data } }
 *   text { text }                              →  text { text }
 */
async function callAnthropic(apiModel, systemPrompt, userContent, maxTokens) {
  const convertedContent = userContent.map(block => {
    if (block.type === 'image_url') {
      // Parse the data URL
      const url = block.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Anthropic adapter: invalid data URL for image');
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      };
    }
    // text block — pass through
    return { type: 'text', text: block.text };
  });

  // Use streaming to avoid Anthropic's 10-minute timeout on large max_tokens
  const stream = getAnthropic().messages.stream({
    model: apiModel,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: convertedContent }],
  });

  const finalMessage = await stream.finalMessage();

  // Anthropic returns content as an array of blocks
  return finalMessage.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Google Gemini call — uses streaming to avoid the ~60 s HTTP connection
 * timeout that Google imposes on non-streaming generateContent requests.
 * With generateContentStream, tokens arrive immediately and we accumulate them.
 */
async function callGemini(apiModel, systemPrompt, userContent, maxTokens) {
  return enqueueGemini(async () => {
    const waitMs = Math.max(0, GEMINI_MIN_REQUEST_INTERVAL_MS - (Date.now() - _lastGeminiRequestAt));
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const client = await getGemini();

    const parts = await Promise.all(userContent.map(async block => {
      if (block.type === 'image_url') {
        return prepareGeminiImage(block.image_url.url);
      }
      return { text: block.text };
    }));

    try {
      // Use streaming to avoid Google's ~60 s HTTP connection timeout.
      // generateContent (non-streaming) waits for full output before sending
      // the first byte, which exceeds the timeout for large HTML generations.
      const stream = await client.models.generateContentStream({
        model: apiModel,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: maxTokens,
        },
      });

      let text = '';
      for await (const chunk of stream) {
        text += chunk.text ?? '';
      }
      return text;
    } catch (err) {
      const cause = err.cause;
      console.error(`[Gemini] ${apiModel} call failed: ${err.message}` +
        (cause ? ` | cause: ${cause.code || ''} ${cause.message || ''}` : ''));
      throw err;
    } finally {
      _lastGeminiRequestAt = Date.now();
    }
  });
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * generateWithModel — unified generation call.
 *
 * @param {string}   modelId      — key in MODEL_REGISTRY (e.g. 'gpt-5.4', 'claude-sonnet-4')
 * @param {string}   systemPrompt — the full system prompt
 * @param {Array}    userContent  — OpenAI-format content array
 *                                  [{ type:'image_url', image_url:{url} }, { type:'text', text }]
 * @param {number}   maxTokens    — max completion tokens (default 16384)
 * @returns {Promise<string>}     — raw text from the model
 */
async function generateWithModel(modelId, { systemPrompt, userContent, maxTokens = 16384 }) {
  const entry = MODEL_REGISTRY[modelId];
  if (!entry) throw new Error(`Unknown model: "${modelId}". Available: ${Object.keys(MODEL_REGISTRY).join(', ')}`);

  const { provider, apiModel } = entry;

  switch (provider) {
    case 'openai':
      return callOpenAI(apiModel, systemPrompt, userContent, maxTokens);
    case 'anthropic':
      return callAnthropic(apiModel, systemPrompt, userContent, maxTokens);
    case 'google':
      return callGemini(apiModel, systemPrompt, userContent, maxTokens);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

module.exports = { generateWithModel, getAvailableModels, MODEL_REGISTRY };
