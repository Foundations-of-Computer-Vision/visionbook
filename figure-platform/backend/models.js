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
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Lazy-init clients ────────────────────────────────────────────────────────
let _openai = null;
let _anthropic = null;
let _gemini = null;

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

function getGemini() {
  if (!_gemini) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key || key === 'your_google_api_key_here')
      throw new Error('GOOGLE_API_KEY is not set. Add it to backend/.env');
    _gemini = new GoogleGenerativeAI(key);
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
  'gpt-5.4':            { provider: 'openai',    apiModel: 'gpt-5.4',                      label: 'GPT-5.4' },
  'gpt-4o':             { provider: 'openai',    apiModel: 'gpt-4o',                       label: 'GPT-4o' },
  'o4-mini':            { provider: 'openai',    apiModel: 'o4-mini',                      label: 'o4-mini' },

  // Anthropic (Claude)
  'claude-opus-4.6':    { provider: 'anthropic', apiModel: 'claude-opus-4-20250514',       label: 'Claude Opus 4.6' },
  'claude-sonnet-4':    { provider: 'anthropic', apiModel: 'claude-sonnet-4-20250514',     label: 'Claude Sonnet 4' },

  // Google (Gemini)
  'gemini-3.1-pro':     { provider: 'google',    apiModel: 'gemini-3.1-pro-preview',       label: 'Gemini 3.1 Pro' },
  'gemini-2.5-pro':     { provider: 'google',    apiModel: 'gemini-2.5-pro',               label: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash':   { provider: 'google',    apiModel: 'gemini-2.5-flash',             label: 'Gemini 2.5 Flash' },
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
 * Google Gemini call.
 * Converts OpenAI-style userContent → Gemini format:
 *   image_url { url: "data:mime;base64,…" }  →  inlineData { mimeType, data }
 *   text { text }                              →  text string
 */
async function callGemini(apiModel, systemPrompt, userContent, maxTokens) {
  const model = getGemini().getGenerativeModel({
    model: apiModel,
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: maxTokens },
  });

  const parts = userContent.map(block => {
    if (block.type === 'image_url') {
      const url = block.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Gemini adapter: invalid data URL for image');
      return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    return { text: block.text };
  });

  const result = await model.generateContent(parts);
  return result.response.text();
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

module.exports = { generateWithModel, getAvailableModels, MODEL_REGISTRY, getOpenAI };
