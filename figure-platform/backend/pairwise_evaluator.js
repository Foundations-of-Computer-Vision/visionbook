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
const { loadQmdForChapter, numberLines } = require('./qmd_utils');

const PAIRWISE_DEFAULT_MODEL = 'gpt-4o';
const PAIRWISE_MAX_TOKENS = 8192;
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

// Inverse of resolveWinner — converts a resolved setup-name winner back to "1"/"2"/"tie"
function resolvedToRaw(resolvedWinner, figure1, figure2) {
  if (resolvedWinner === figure1) return '1';
  if (resolvedWinner === figure2) return '2';
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

1. EXTRACT: list the key concepts taught by this textbook section (1-4 concepts)
2. FOR EACH CONCEPT: find the book lines that define it; assess how well Figure 1 and Figure 2 each teach it via their labels, tooltips, interactions, and geometry
3. IDENTIFY MISMATCHES: claims in either figure that contradict or ignore the textbook
4. DECIDE: which figure better grounds its interactions and labels in the textbook in a clear manner.
The numbered textbook lines as well as Figure 1 and Figure 2 are provided as HTML/JavaScript source code.`
};

const AGGREGATOR_PROMPT = `You receive pairwise preferences from five independent dimension agents that each compared Figure 1 vs Figure 2.
Synthesize a final judgment. Up-weight agents with higher confidence.
Only call "tie" if the dimension votes are genuinely split with no clear overall winner.
Your explanation must be comparative: cite specific strengths of the winner over the loser and specific weaknesses of the loser relative to the winner — not just a list of the winner's merits in isolation.
Respond ONLY with valid JSON — no explanation, no markdown:
{"winner":"1"|"2"|"tie","confidence":0.0-1.0,"explanation":"<two to three sentences comparing both figures>"}`;

// ── Single dimension agent call ────────────────────────────────────────────────

async function callDimensionAgent(dimension, { htmlA, htmlB, thumbA, thumbB, sourceImage }, evalModel, numberedQmd = null) {
  const systemPrompt = DIMENSION_PROMPTS[dimension];
  const usesImages = dimension === 'faithfulness' || dimension === 'labels';

  const userContent = [];

  if (dimension === 'concept') {
    if (!numberedQmd) throw new Error('callDimensionAgent(concept): numberedQmd is required');
    userContent.push({ type: 'text', text: `Numbered textbook QMD:\n\n${numberedQmd}` });
    userContent.push({ type: 'text', text: `Figure 1 source code:\n\n${htmlA}` });
    userContent.push({ type: 'text', text: `Figure 2 source code:\n\n${htmlB}` });
  } else if (usesImages) {
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
async function pairwiseEvaluateFigure({ htmlA, setupA, htmlB, setupB, thumbA, thumbB, sourceImage, evalModel, qmdContent = null, chapterName = null }) {
  const usedModel = evalModel || PAIRWISE_DEFAULT_MODEL;

  let resolvedQmd = qmdContent;
  if (!resolvedQmd && chapterName) resolvedQmd = loadQmdForChapter(chapterName);
  if (!resolvedQmd) throw new Error('pairwiseEvaluateFigure: qmdContent or chapterName is required');
  const numberedQmd = numberLines(resolvedQmd);

  // Randomize once — same assignment used for all 5 dimensions and the aggregator
  const { figure1, figure2 } = randomizeOrder(setupA, setupB);
  const inputs = {
    htmlA: figure1 === setupA ? htmlA : htmlB,
    htmlB: figure1 === setupA ? htmlB : htmlA,
    thumbA: figure1 === setupA ? thumbA : thumbB,
    thumbB: figure1 === setupA ? thumbB : thumbA,
    sourceImage,
  };

  // 5 parallel dimension agents
  const [geometry, interactivity, faithfulness, labels, concept] = await Promise.all([
    callDimensionAgent('geometry', inputs, usedModel),
    callDimensionAgent('interactivity', inputs, usedModel),
    callDimensionAgent('faithfulness', inputs, usedModel),
    callDimensionAgent('labels', inputs, usedModel),
    callDimensionAgent('concept', inputs, usedModel, numberedQmd),
  ]);

  // Resolve 1/2 → setup names; remap figure_1/figure_2 fields in concept richer output
  const aIsOne = figure1 === setupA;
  const rawDimensions = { geometry, interactivity, faithfulness, labels, concept };
  const resolvedDimensions = {};
  for (const [dim, result] of Object.entries(rawDimensions)) {
    if (dim === 'concept') {
      resolvedDimensions.concept = {
        winner: resolveWinner(result.winner, figure1, figure2),
        confidence: result.confidence,
        rationale: result.rationale,
        concepts_tested: (result.concepts_tested || []).map(ct => ({
          concept: ct.concept,
          book_lines: ct.book_lines,
          source_claim: ct.source_claim,
          figure_a_match: aIsOne ? ct.figure_1_match : ct.figure_2_match,
          figure_b_match: aIsOne ? ct.figure_2_match : ct.figure_1_match,
          verdict: resolveWinner(ct.verdict, figure1, figure2),
        })),
        mismatches: (result.mismatches || []).map(m => ({
          figure: resolveWinner(m.figure, figure1, figure2),
          book_lines: m.book_lines,
          issue: m.issue,
        })),
      };
    } else {
      resolvedDimensions[dim] = {
        winner: resolveWinner(result.winner, figure1, figure2),
        confidence: result.confidence,
        rationale: result.rationale,
      };
    }
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

/**
 * Re-evaluate only the concept dimension (and re-run the aggregator) for an existing eval.
 * All other dimensions are preserved from existingMachineEval. The figure1/figure2 position
 * assignment is restored from the existing eval so results are comparable.
 *
 * @param {object} opts
 * @param {string} opts.htmlA / opts.htmlB / opts.setupA / opts.setupB / opts.thumbA / opts.thumbB / opts.sourceImage
 * @param {object} opts.existingMachineEval - the saved machineEval object from the pair file
 * @param {string} [opts.evalModel]
 * @param {string} [opts.qmdContent] / [opts.chapterName]
 */
async function pairwiseEvaluateConceptOnly({ htmlA, setupA, htmlB, setupB, thumbA, thumbB, sourceImage, evalModel, qmdContent = null, chapterName = null, existingMachineEval }) {
  if (!existingMachineEval) throw new Error('pairwiseEvaluateConceptOnly: existingMachineEval is required');

  const usedModel = evalModel || PAIRWISE_DEFAULT_MODEL;
  let resolvedQmd = qmdContent;
  if (!resolvedQmd && chapterName) resolvedQmd = loadQmdForChapter(chapterName);
  if (!resolvedQmd) throw new Error('pairwiseEvaluateConceptOnly: qmdContent or chapterName is required');
  const numberedQmd = numberLines(resolvedQmd);

  // Restore original figure1/figure2 assignment so position is consistent with existing dims
  const { figure1Setup, figure2Setup } = existingMachineEval;
  if (!figure1Setup || !figure2Setup) throw new Error('pairwiseEvaluateConceptOnly: existingMachineEval is missing figure1Setup/figure2Setup — cannot restore position mapping');
  const figure1 = figure1Setup;
  const figure2 = figure2Setup;
  const aIsOne = figure1 === setupA;
  const inputs = {
    htmlA: aIsOne ? htmlA : htmlB,
    htmlB: aIsOne ? htmlB : htmlA,
    thumbA: aIsOne ? thumbA : thumbB,
    thumbB: aIsOne ? thumbB : thumbA,
    sourceImage,
  };

  // Run only the concept agent
  const conceptRaw = await callDimensionAgent('concept', inputs, usedModel, numberedQmd);

  // Resolve concept result to setup names
  const resolvedConcept = {
    winner: resolveWinner(conceptRaw.winner, figure1, figure2),
    confidence: conceptRaw.confidence,
    rationale: conceptRaw.rationale,
    concepts_tested: (conceptRaw.concepts_tested || []).map(ct => ({
      concept: ct.concept,
      book_lines: ct.book_lines,
      source_claim: ct.source_claim,
      figure_a_match: aIsOne ? ct.figure_1_match : ct.figure_2_match,
      figure_b_match: aIsOne ? ct.figure_2_match : ct.figure_1_match,
      verdict: resolveWinner(ct.verdict, figure1, figure2),
    })),
    mismatches: (conceptRaw.mismatches || []).map(m => ({
      figure: resolveWinner(m.figure, figure1, figure2),
      book_lines: m.book_lines,
      issue: m.issue,
    })),
  };

  // Build raw (1/2-label) versions of all 5 dims for the aggregator
  // — existing 4 dimensions are stored resolved; convert them back
  const existingDims = existingMachineEval.dimensions || {};
  const rawForAgg = {
    geometry: { winner: resolvedToRaw(existingDims.geometry?.winner, figure1, figure2), confidence: existingDims.geometry?.confidence, rationale: existingDims.geometry?.rationale },
    interactivity: { winner: resolvedToRaw(existingDims.interactivity?.winner, figure1, figure2), confidence: existingDims.interactivity?.confidence, rationale: existingDims.interactivity?.rationale },
    faithfulness: { winner: resolvedToRaw(existingDims.faithfulness?.winner, figure1, figure2), confidence: existingDims.faithfulness?.confidence, rationale: existingDims.faithfulness?.rationale },
    labels: { winner: resolvedToRaw(existingDims.labels?.winner, figure1, figure2), confidence: existingDims.labels?.confidence, rationale: existingDims.labels?.rationale },
    concept: conceptRaw,
  };

  const aggRaw = await callAggregator(rawForAgg, usedModel);

  return {
    figure1Setup: figure1,
    figure2Setup: figure2,
    dimensions: {
      ...existingDims,
      concept: resolvedConcept,
    },
    aggregator: {
      winner: resolveWinner(aggRaw.winner, figure1, figure2),
      confidence: aggRaw.confidence,
      explanation: aggRaw.explanation,
    },
    evalModel: usedModel,
    evaluatedAt: new Date().toISOString(),
    conceptRedoneAt: new Date().toISOString(),
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
  pairwiseEvaluateConceptOnly,
  loadPairwiseResult,
  savePairwiseResult,
  loadAllPairwiseResults,
  loadAllPairsForRanking,
  clearMachineEval,
  clearAllMachineEvals,
  pairKey,
  canonicalizePair,
};
