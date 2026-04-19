/**
 * critic.js — shared critic (evaluator) definition
 *
 * Used by both server.js (single-pass web generation) and agent.js (multi-round loop).
 * Edit this file to change what the critic looks for, how it scores, or what it outputs.
 */

const { generateWithModel } = require('./models');
const { screenshotHtml } = require('./runtime-helpers');
const fs = require('fs');
const path = require('path');

const CRITIC_DEFAULT_MODEL = 'gpt-4o';
const CRITIC_MAX_TOKENS = 512;
// Change this value to start a new evaluation experiment namespace.
const CRITIC_EXPERIMENT_BASE = 'default_critic';

// ── 10 canonical failure modes ─────────────────────────────────────────────────
const FAILURE_MODES = [
  { id: 'Depth-Wrong', desc: '3D depth/perspective interpretation is incorrect' },
  { id: 'Missing-Labels', desc: 'important text annotations are absent' },
  { id: 'Wrong-Primitives', desc: 'incorrect geometric shapes used for the concept' },
  { id: 'Interaction-Broken', desc: 'interactive controls are present but non-functional' },
  { id: 'Interaction-Missing', desc: 'no meaningful interactions beyond basic OrbitControls rotation' },
  { id: 'Camera-Wrong', desc: 'poor initial viewpoint; key content not visible' },
  { id: 'Scale-Wrong', desc: 'element proportions are noticeably off' },
  { id: 'Color-Wrong', desc: "colors don't match the original figure" },
  { id: 'Hallucination', desc: 'elements present that do not appear in the original' },
  { id: 'Concept-Misunderstood', desc: 'the core concept being illustrated is misrepresented' },
];

// ── 5 primary scored metrics (each 1–5) ────────────────────────────────────────
const SCORE_METRICS = [
  {
    id: 'geometry_accuracy',
    rubric: [
      '5 – All elements represented; plausible positions, connections, proportions',
      '4 – All major elements present; minor position/alignment issues',
      '3 – 1-2 elements missing OR noticeable spatial errors; concept still recognizable',
      '2 – Multiple missing elements OR major spatial errors',
      '1 – Unrecognizable or completely wrong topology',
    ],
  },
  {
    id: 'interactivity_usability',
    note: 'CRITICAL: OrbitControls (mouse drag to rotate/zoom) does NOT count as an interaction. Meaningful interactions = buttons, sliders, toggles, step-through animations, parameter controls built by the developer.',
    rubric: [
      '5 – 3+ meaningful interactions all functional; reset button works; guided step-through demo present',
      '4 – 2 meaningful interactions functional; reset button present; minor usability issues',
      '3 – 1 meaningful interaction functional; no guided demo',
      '2 – Interactions exist in code but are broken or have no visible effect',
      '1 – Only OrbitControls present, or no interactions at all — score MUST be 1',
    ],
  },
  {
    id: 'faithfulness',
    rubric: [
      '5 – Matches original ≥95% (colors, proportions, composition)',
      '4 – Matches ≥85%; recognizable at a glance',
      '3 – Matches ≥65%; general idea clear',
      '2 – Matches <65%; hard to recognize',
      '1 – Completely different or fabricated',
    ],
  },
  {
    id: 'label_quality',
    rubric: [
      '5 – All labels correct, clear, well-sized, well-placed, not cluttered',
      '4 – 1-2 labels have minor issues; rest perfect',
      '3 – Half of labels have issues (size/placement/clarity/clutter)',
      '2 – Most labels problematic or missing',
      '1 – No labels or all wrong/unreadable/severely cluttered',
    ],
  },
  {
    id: 'concept_accuracy',
    rubric: [
      '5 – All concepts accurate; interactions demonstrate correct relationships; no misinformation',
      '4 – Main concept correct; ≤1 minor detail wrong or missing',
      '3 – Main concept present; 2-3 details wrong or missing',
      '2 – Significant errors or fabrications; would mislead students',
      '1 – Completely incorrect or misleading',
    ],
  },
];

// ── Build the system prompt sent to the critic model ─────────────────────────
function buildEvalPrompt() {
  const failureModeLines = FAILURE_MODES
    .map(f => `"${f.id}"${' '.repeat(Math.max(1, 24 - f.id.length))}— ${f.desc}`)
    .join('\n');

  const metricLines = SCORE_METRICS.map(m => {
    const header = m.note ? `${m.id} — ${m.note}` : m.id + ':';
    return `${header}\n${m.rubric.map(r => `  ${r}`).join('\n')}`;
  }).join('\n\n');

  const exampleOutput = JSON.stringify(
    Object.fromEntries([
      ['failure_modes', []],
      ...SCORE_METRICS.map(m => [m.id, 3]),
      ['notes', 'one concise sentence summarizing the main strengths and weaknesses'],
    ]),
    null,
    2
  );

  return `You are a strict evaluator of generated interactive Three.js 3D figures against original 2D textbook figure images.
You will receive the original source figure image, the generated HTML/JavaScript code, and a rendered screenshot of the generated HTML (if screenshot capture succeeds). If the screenshot was not received, mention this in the notes. Otherwise, use the screenshot to help evaluate the faithfulness of the generated figure to the original figure.
Be critical and honest — err toward lower scores when in doubt. Do not give credit for things that are absent or barely present.
Output ONLY a valid JSON object — no explanation, no markdown, no fences.

FAILURE MODES — list any that apply (use empty array [] if none):
${failureModeLines}

SCORES — integer 1–5 for each field:

${metricLines}

Output this exact JSON structure and nothing else:
${exampleOutput}`;
}

function getCriticContext() {
  const systemPrompt = buildEvalPrompt();
  return {
    systemPrompt,
    criticVersion: CRITIC_EXPERIMENT_BASE,
  };
}

// ── Finalise raw evaluator output: clamp, derive visual_aesthetics + overall ──
function finaliseEval(evaluation) {
  const scoreKeys = SCORE_METRICS.map(m => m.id);
  for (const key of scoreKeys) {
    evaluation[key] = Math.min(5, Math.max(1, Math.round(Number(evaluation[key]) || 3)));
  }
  // Derived: visual quality proxy
  evaluation.visual_aesthetics = Math.round(
    ((evaluation.geometry_accuracy + evaluation.faithfulness + evaluation.label_quality) / 3) * 10
  ) / 10;
  // Derived: overall average of the 5 primary metrics
  evaluation.overall_average = Math.round(
    (scoreKeys.reduce((s, k) => s + evaluation[k], 0) / scoreKeys.length) * 10
  ) / 10;
  return evaluation;
}

/**
 * Run evaluator model and return finalised rubric scores.
 *
 * @param {{
 *   html: string,
 *   evalImage?: string,
 *   evalMediaType?: string,
 *   model?: string,
 *   maxTokens?: number,
 * }} opts
 */
async function evaluateHtmlWithCritic(opts) {
  const {
    html,
    evalImage,
    evalMediaType = 'image/png',
    model = CRITIC_DEFAULT_MODEL,
    maxTokens = CRITIC_MAX_TOKENS,
  } = opts || {};

  if (!html) throw new Error('No HTML found for evaluation.');

  // Try to render the generated HTML so the critic can see the actual output.
  // If rendering fails, continue evaluation with available inputs.
  const rendered = await screenshotHtml(html);

  const userContent = [
    ...(evalImage
      ? [
        { type: 'text', text: 'Reference source figure image:' },
        { type: 'image_url', image_url: { url: `data:${evalMediaType};base64,${evalImage}` } },
      ]
      : []),
    ...(rendered?.data
      ? [
        { type: 'text', text: 'Rendered screenshot of the generated HTML output:' },
        { type: 'image_url', image_url: { url: `data:${rendered.mediaType || 'image/jpeg'};base64,${rendered.data}` } },
      ]
      : []),
    {
      type: 'text',
      text: `Here is the generated HTML code to evaluate:\n\n${html}\n\nOutput ONLY the JSON evaluation object.`,
    },
  ];

  const { systemPrompt } = getCriticContext();

  let content = await generateWithModel(model, {
    systemPrompt,
    userContent,
    maxTokens,
  });
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  content = content.trim();

  let evaluation;
  try {
    evaluation = JSON.parse(content);
  } catch {
    throw new Error('Evaluator did not return valid JSON: ' + content.slice(0, 200));
  }

  return finaliseEval(evaluation);
}

module.exports = {
  CRITIC_EXPERIMENT_BASE,
  getCriticContext,
  evaluateHtmlWithCritic,
};
