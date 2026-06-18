/**
 * evaluator.js — user-triggered external evaluations.
 * Called by /api/evaluate and /api/experiments/evaluate.
 * Self-contained: owns its own prompt and makes direct model API calls.
 */

const { generateWithModel } = require('./models');
const { screenshotHtml } = require('./runtime-helpers');
const { upsertEvaluation } = require('./result_schema');

const EVALUATOR_DEFAULT_MODEL = 'gpt-4o';
const EVALUATOR_MAX_TOKENS = 4096;
const SCORE_KEYS = ['geometry_accuracy', 'interactivity_usability', 'faithfulness', 'label_quality', 'concept_accuracy'];

// ── One-shot calibration example (mpkqucxkwn9z1 — epipolar geometry figure) ──
const EXAMPLE_PAYLOAD = "<!-- @FIGURE_UI_BEGIN -->\n<label title=\"Rotating Camera 2 changes its image plane orientation and therefore where the red ray projects as an epipolar line.\">\n  Rotate Camera 2: <span id=\"rotationCamera2Value\">0°</span>\n  <input id=\"rotationCamera2\" type=\"range\" min=\"0\" max=\"360\" step=\"1\" value=\"0\">\n</label>\n<label title=\"Translating Camera 2 changes the stereo baseline T and shifts the epipole and epipolar line.\">\n  Translate Camera 2: <span id=\"translationCamera2Value\">0h.0</span>\n  <input id=\"translationCamera2\" type=\"range\" min=\"-10\" max=\"10\" step=\"0.1\" value=\"0\">\n</label>\n<div style=\"display:flex;gap:4px;flex-wrap:wrap;width:230px;\">\n  <button id=\"step0\">Initial Setup</button>\n  <button id=\"step1\">Rotate Camera 2</button>\n  <button id=\"step2\">Translate Camera 2</button>\n</div>\n<div id=\"stepNarration\" style=\"max-width:245px;line-height:1.28;background:rgba(255,255,255,0.9);border:1px solid #d8d8d8;border-radius:6px;padding:7px 9px;\">\n  Here, you see the red ray from Camera 1 and its red epipolar-line projection on image plane 2.\n</div>\n<!-- @FIGURE_UI_END -->\n// @FIGURE_CODE_BEGIN\n[...code omitted for brevity...]\n// @FIGURE_CODE_END";

const GOLD_EVAL = {
  failure_modes: ['Wrong-Primitives', 'Depth-Wrong', 'Interaction-Broken'],
  geometry_accuracy: 2,
  interactivity_usability: 2,
  faithfulness: 4,
  label_quality: 1,
  concept_accuracy: 5,
};

// ── 10 canonical failure modes ─────────────────────────────────────────────────
const FAILURE_MODES = [
  { id: 'Depth-Wrong', desc: '3D depth/perspective interpretation is incorrect' },
  { id: 'Missing-Labels', desc: 'important text annotations are absent' },
  { id: 'Wrong-Primitives', desc: 'incorrect geometric shapes used for the concept' },
  { id: 'Interaction-Broken', desc: 'interactive controls are present but non-functional' },
  { id: 'Interaction-Missing', desc: 'no meaningful interactions beyond basic OrbitControls rotation' },
  { id: 'Camera-Wrong', desc: 'initial viewpoint differs from the source figure — wrong angle/orientation/rotation, even if all content remains visible' },
  { id: 'Scale-Wrong', desc: 'element proportions are noticeably off' },
  { id: 'Color-Wrong', desc: "colors don't match the original figure" },
  { id: 'Hallucination', desc: 'elements present that do not appear in the original' },
  { id: 'Concept-Misunderstood', desc: 'the core concept being illustrated is    misrepresented' },
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
      '5 – 3+ meaningful interactions all functional and pedagogically useful; reset button works; guided step-through demo present',
      '4 – 2 meaningful interactions functional and pedagogically useful; reset button present; minor usability issues',
      '3 – 1 meaningful interaction functional and pedagogically useful; no guided demo',
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

function buildEvalPrompt(useFewShot = true) {
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
    ]),
    null,
    2
  );

  return `You are a strict evaluator of generated interactive Three.js 3D figures against original 2D textbook figure images.
You will receive the original source figure image, the generated HTML/JavaScript code, and a rendered screenshot of the generated HTML (if screenshot capture succeeds).
Score the generated figure using the rubric. Be critical and honest — err toward lower scores when in doubt. Do not give credit for things that are absent or barely present. Output ONLY a valid JSON object — no explanation, no markdown, no fences.

FAILURE MODES — list any that apply (use empty array [] if none):
${failureModeLines}

SCORES — integer 1–5 for each field:
${metricLines}

Output this exact JSON structure and nothing else:
${exampleOutput}

${useFewShot ? `Here is an example output - study this before scoring. Do not copy these scores; only use them as a reference example for judgement.
Generated code:
${EXAMPLE_PAYLOAD}

Correct evaluation for the above code:
${JSON.stringify(GOLD_EVAL, null, 2)}` : ''}`;
}

function finaliseEval(evaluation) {
  for (const key of SCORE_KEYS) {
    evaluation[key] = Math.min(5, Math.max(1, Math.round(Number(evaluation[key]) || 3)));
  }
  evaluation.visual_aesthetics = Math.round(
    ((evaluation.geometry_accuracy + evaluation.faithfulness + evaluation.label_quality) / 3) * 10
  ) / 10;
  evaluation.overall_average = Math.round(
    (SCORE_KEYS.reduce((s, k) => s + evaluation[k], 0) / SCORE_KEYS.length) * 10
  ) / 10;
  return evaluation;
}

async function evaluateFigure({ record, evalModel, useFewShot = true }) {
  if (!record?.html) {
    return { skipped: true, passCount: 0 };
  }

  const usedEvalModel = evalModel || EVALUATOR_DEFAULT_MODEL;
  const systemPrompt = buildEvalPrompt(useFewShot);

  const sourceImage = record.source_base64 || null;
  const sourceMediaType = record.source_media_type || 'image/png';

  let thumbBase64 = record.base64thumb || null;
  let thumbMediaType = record.mediaType || 'image/jpeg';
  if (!thumbBase64) {
    const shot = await screenshotHtml(record.html);
    if (shot?.data) {
      thumbBase64 = shot.data;
      thumbMediaType = shot.mediaType || 'image/jpeg';
    }
  }

  const userContent = [
    ...(sourceImage ? [
      { type: 'text', text: 'Reference source figure image:' },
      { type: 'image_url', image_url: { url: `data:${sourceMediaType};base64,${sourceImage}` } },
    ] : []),
    ...(thumbBase64 ? [
      { type: 'text', text: 'Rendered screenshot of the generated HTML output:' },
      { type: 'image_url', image_url: { url: `data:${thumbMediaType};base64,${thumbBase64}` } },
    ] : []),
    {
      type: 'text',
      text: `Here is the generated code to evaluate:\n\n${record.html}\n\nOutput ONLY the JSON evaluation object.`,
    },
  ];

  let content = await generateWithModel(usedEvalModel, {
    systemPrompt,
    userContent,
    maxTokens: EVALUATOR_MAX_TOKENS,
  });

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  content = content.trim();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Evaluator did not return valid JSON: ' + content.slice(0, 200));
  }

  const evaluation = finaliseEval(parsed);
  const evaluatedAt = new Date().toISOString();
  const updatedRecord = upsertEvaluation(record, usedEvalModel, evaluation, evaluatedAt, {
    source: 'external',
  });

  return {
    evaluation,
    skipped: false,
    evalModel: usedEvalModel,
    evaluatedAt,
    record: updatedRecord,
  };
}

module.exports = { evaluateFigure };
