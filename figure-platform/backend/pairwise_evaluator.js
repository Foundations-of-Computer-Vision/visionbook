/**
 * pairwise_evaluator.js — head-to-head comparison of two generated figures.
 *
 * Runs 5 parallel dimension agents then a single aggregator call.
 * Position assignment (Figure 1 vs Figure 2) is randomized once per figure,
 * then held fixed across all 5 dimension agents and the aggregator.
 */

const fs = require('fs');
const path = require('path');
const { generateWithModel } = require('./models');

const PAIRWISE_DEFAULT_MODEL = 'gpt-4o';
const PAIRWISE_MAX_TOKENS = 4096;
const PAIRWISE_RESULTS_DIR = path.join(__dirname, 'pairwise_results');

// ── Pair & position helpers ────────────────────────────────────────────────────

function canonicalizePair(setupA, setupB) {
  const [s1, s2] = [setupA, setupB].sort();
  return { canonical1: s1, canonical2: s2 };
}

function pairKey(setupA, setupB) {
  const { canonical1, canonical2 } = canonicalizePair(setupA, setupB);
  return `${canonical1.replace(/\//g, '__')}_vs_${canonical2.replace(/\//g, '__')}`;
}

function randomizeOrder(setupA, setupB) {
  return Math.random() < 0.5
    ? { figure1: setupA, figure2: setupB }
    : { figure1: setupB, figure2: setupA };
}

function resolveWinner(llmWinner, figure1, figure2) {
  if (llmWinner === '1') return figure1;
  if (llmWinner === '2') return figure2;
  return 'tie';
}

function parseAgentJson(raw) {
  let content = raw;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  content = content.trim();
  return JSON.parse(content);
}

// ── Dimension agent prompts ────────────────────────────────────────────────────

const SHARED_PREAMBLE = `You are a strict evaluator comparing two Three.js 3D figure implementations (Figure 1 and Figure 2) of the same textbook figure.
Be critical and honest. Only call "tie" when both figures are genuinely indistinguishable on this dimension — default to picking the better one.
Your rationale must be comparative: explain specifically what the winner does better AND what the loser does worse — not just why the winner is good in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"rationale":"<one sentence comparing both figures>"}`;

const DIMENSION_PROMPTS = {
  geometry: `${SHARED_PREAMBLE}

DIMENSION: Geometric accuracy — which figure better reconstructs the 3D geometry of the original.
Evaluate: correct 3D shapes/primitives, spatial relationships, element counts, proportions, depth/perspective, and initial camera viewpoint matching the source.
Watch for: incorrect 3D perspective, wrong shapes for the concept, initial viewpoint differing from the source, proportions noticeably off. Take special note of 2D canvases in 3D space - this automatically loses.
Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`,

  interactivity: `${SHARED_PREAMBLE}

DIMENSION: Interactivity and usability — which figure provides better developer-built interactions.
CRITICAL: OrbitControls (mouse drag to rotate/zoom) does NOT count as a meaningful interaction. Meaningful = buttons, sliders, toggles, step-through animations, parameter controls built by the developer.
Evaluate: number of meaningful interactions, whether they are functional, and whether they are pedagogically useful.
Watch for: controls present in code but non-functional, only OrbitControls with no developer-built interactions.
Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`,

  faithfulness: `${SHARED_PREAMBLE}

DIMENSION: Visual faithfulness — which figure's rendered output more closely matches the original textbook figure.
Evaluate: color match, compositional similarity, proportions, overall visual resemblance at a glance.
Watch for: colors that don't match the original, elements present that don't appear in the original, proportions noticeably off.
You will receive the original textbook figure image, plus rendered screenshots of Figure 1 and Figure 2.`,

  labels: `${SHARED_PREAMBLE}

DIMENSION: Label quality — which figure has better text labels and annotations matching the original.
Evaluate: presence of all required labels, correctness of label text, readability, size, placement, and freedom from clutter.
Watch for: important annotations absent, labels not present in the original figure.
You will receive the original textbook figure image, plus rendered screenshots of Figure 1 and Figure 2.`,

  concept: `${SHARED_PREAMBLE}

DIMENSION: Concept accuracy — which figure better conveys the pedagogical concept to a student.
Evaluate: whether the core concept is correctly illustrated, whether interactions demonstrate correct relationships, and whether a student would learn the right thing from each figure.
Watch for: core concept misrepresented, invented elements that distort the intended meaning.
Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`,
};

const AGGREGATOR_PROMPT = `You receive pairwise preferences from five independent dimension agents that each compared Figure 1 vs Figure 2.
Synthesize a final judgment. Up-weight agents with higher confidence.
Only call "tie" if the dimension votes are genuinely split with no clear overall winner.
Your explanation must be comparative: cite specific strengths of the winner over the loser and specific weaknesses of the loser relative to the winner — not just a list of the winner's merits in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"explanation":"<two to three sentences comparing both figures>"}`;

// ── Single dimension agent call ────────────────────────────────────────────────

async function callDimensionAgent(dimension, { htmlA, htmlB, thumbA, thumbB, sourceImage }, evalModel) {
  const systemPrompt = DIMENSION_PROMPTS[dimension];
  const usesImages = dimension === 'faithfulness' || dimension === 'labels';

  const userContent = [];

  if (usesImages) {
    if (sourceImage) {
      userContent.push({ type: 'text', text: 'Reference textbook figure:' });
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${sourceImage}` } });
    }
    if (thumbA) {
      userContent.push({ type: 'text', text: 'Screenshot of Figure 1:' });
      userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumbA}` } });
    }
    if (thumbB) {
      userContent.push({ type: 'text', text: 'Screenshot of Figure 2:' });
      userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumbB}` } });
    }
  } else {
    userContent.push({ type: 'text', text: `Figure 1 source code:\n\n${htmlA}` });
    userContent.push({ type: 'text', text: `Figure 2 source code:\n\n${htmlB}` });
  }

  userContent.push({ type: 'text', text: 'Output ONLY the JSON object.' });

  const raw = await generateWithModel(evalModel, {
    systemPrompt,
    userContent,
    maxTokens: PAIRWISE_MAX_TOKENS,
  });

  return parseAgentJson(raw);
}

// ── Aggregator call ────────────────────────────────────────────────────────────

async function callAggregator(dimensionResults, evalModel) {
  const summary = Object.entries(dimensionResults).map(([dim, r]) =>
    `${dim}: winner=${r.winner}, confidence=${r.confidence}, rationale="${r.rationale}"`
  ).join('\n');

  const userContent = [
    { type: 'text', text: `Dimension agent results:\n${summary}\n\nOutput ONLY the JSON object.` },
  ];

  const raw = await generateWithModel(evalModel, {
    systemPrompt: AGGREGATOR_PROMPT,
    userContent,
    maxTokens: PAIRWISE_MAX_TOKENS,
  });

  return parseAgentJson(raw);
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Compare two figures across 5 dimensions plus an aggregator.
 * Position is randomized; all winner fields are resolved to setup names before return.
 *
 * @param {object} opts
 * @param {string} opts.htmlA       - HTML source for setup A's figure
 * @param {string} opts.setupA      - setup identifier (e.g. "01_one_line/gpt-5.2-codex")
 * @param {string} opts.htmlB       - HTML source for setup B's figure
 * @param {string} opts.setupB      - setup identifier
 * @param {string} [opts.thumbA]    - base64 JPEG screenshot for A (no data: prefix)
 * @param {string} [opts.thumbB]    - base64 JPEG screenshot for B
 * @param {string} [opts.sourceImage] - base64 PNG of original textbook figure
 * @param {string} [opts.evalModel] - model ID from MODEL_REGISTRY
 * @returns {Promise<{dimensions, aggregator, evalModel, evaluatedAt}>}
 */
async function pairwiseEvaluateFigure({ htmlA, setupA, htmlB, setupB, thumbA, thumbB, sourceImage, evalModel }) {
  const usedModel = evalModel || PAIRWISE_DEFAULT_MODEL;

  // Randomize once — same assignment used for all 5 dimensions and the aggregator
  const { figure1, figure2 } = randomizeOrder(setupA, setupB);
  const inputs = {
    htmlA:  figure1 === setupA ? htmlA  : htmlB,
    htmlB:  figure1 === setupA ? htmlB  : htmlA,
    thumbA: figure1 === setupA ? thumbA : thumbB,
    thumbB: figure1 === setupA ? thumbB : thumbA,
    sourceImage,
  };

  // 5 parallel dimension agents
  const [geometry, interactivity, faithfulness, labels, concept] = await Promise.all([
    callDimensionAgent('geometry',      inputs, usedModel),
    callDimensionAgent('interactivity', inputs, usedModel),
    callDimensionAgent('faithfulness',  inputs, usedModel),
    callDimensionAgent('labels',        inputs, usedModel),
    callDimensionAgent('concept',       inputs, usedModel),
  ]);

  // Resolve 1/2 → setup names
  const rawDimensions = { geometry, interactivity, faithfulness, labels, concept };
  const resolvedDimensions = {};
  for (const [dim, result] of Object.entries(rawDimensions)) {
    resolvedDimensions[dim] = {
      winner: resolveWinner(result.winner, figure1, figure2),
      confidence: result.confidence,
      rationale: result.rationale,
    };
  }

  // Aggregator — receives raw 1/2 labels (consistent with dimensions above)
  const aggRaw = await callAggregator(rawDimensions, usedModel);

  return {
    figure1Setup: figure1,
    figure2Setup: figure2,
    dimensions: resolvedDimensions,
    aggregator: {
      winner: resolveWinner(aggRaw.winner, figure1, figure2),
      confidence: aggRaw.confidence,
      explanation: aggRaw.explanation,
    },
    evalModel: usedModel,
    evaluatedAt: new Date().toISOString(),
  };
}

// ── Result file I/O ────────────────────────────────────────────────────────────
// One file per pair: pairwise_results/<key>.json
// Contents: { "<chapter>__<figure>": { setupA, setupB, chapter, figure, machineEval, humanEvals }, ... }

function pairFilePath(setupA, setupB) {
  return path.join(PAIRWISE_RESULTS_DIR, `${pairKey(setupA, setupB)}.json`);
}

function loadPairFile(setupA, setupB) {
  const fp = pairFilePath(setupA, setupB);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return {}; }
}

function savePairFile(setupA, setupB, dict) {
  const fp = pairFilePath(setupA, setupB);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(dict, null, 2));
}

function loadPairwiseResult(setupA, setupB, chapter, figure) {
  const dict = loadPairFile(setupA, setupB);
  return dict[`${chapter}__${figure}`] || null;
}

function savePairwiseResult(setupA, setupB, chapter, figure, data) {
  const dict = loadPairFile(setupA, setupB);
  dict[`${chapter}__${figure}`] = data;
  savePairFile(setupA, setupB, dict);
}

function loadAllPairwiseResults(setupA, setupB) {
  return Object.values(loadPairFile(setupA, setupB));
}

function loadAllPairsForRanking() {
  if (!fs.existsSync(PAIRWISE_RESULTS_DIR)) return [];
  return fs.readdirSync(PAIRWISE_RESULTS_DIR)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try { return Object.values(JSON.parse(fs.readFileSync(path.join(PAIRWISE_RESULTS_DIR, f), 'utf-8'))); }
      catch { return []; }
    });
}

function clearMachineEval(setupA, setupB, chapter, figure) {
  const dict = loadPairFile(setupA, setupB);
  const key = `${chapter}__${figure}`;
  if (dict[key]) {
    delete dict[key].machineEval;
    savePairFile(setupA, setupB, dict);
  }
}

function clearAllMachineEvals(setupA, setupB) {
  const dict = loadPairFile(setupA, setupB);
  for (const key of Object.keys(dict)) delete dict[key].machineEval;
  savePairFile(setupA, setupB, dict);
}

module.exports = {
  pairwiseEvaluateFigure,
  loadPairwiseResult,
  savePairwiseResult,
  loadAllPairwiseResults,
  loadAllPairsForRanking,
  clearMachineEval,
  clearAllMachineEvals,
  pairKey,
  canonicalizePair,
};
