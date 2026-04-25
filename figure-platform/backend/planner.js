/**
 * planner.js — extracts relevant chapter context for a figure and plans interactions
 *
 * Two modes:
 *   1. Single-figure:  planForFigure(figureStem, chapterName)
 *      → targeted extraction around that figure's references in the .qmd
 *   2. Chapter mode:    planChapter(chapterName)
 *      → identifies all 3D candidates, returns an array of plans (one per figure)
 *
 * Each plan = { figureStem, contextChunk, interactionPlan }
 *   - contextChunk:    the paragraphs around the figure reference in the .qmd
 *   - interactionPlan: LLM-generated interaction blueprint (fast, ~200 tokens)
 *
 * Used by both server.js (web) and agent.js (CLI).
 */

const fs = require('fs');
const path = require('path');
const { generateWithModel } = require('./models');
const { inferChapterFromFilename, list3dCandidates } = require('./chapter-discovery');

// ── Paths ──────────────────────────────────────────────────────────────────────
const ROOT_DIR = path.join(__dirname, '..', '..');
const QMD_DIR = ROOT_DIR;                                     // .qmd files live at repo root

const PLANNER_MODEL = 'gpt-4o';
// gpt-4o is fast and non-reasoning — no hidden thinking tokens.
const PLANNER_MAX_TOKENS = 1024;

// ── Context extraction ─────────────────────────────────────────────────────────

/**
 * Find the .qmd file for a given chapter name.
 * Chapter names may differ slightly from filenames, so we try several matches.
 */
function findQmdFile(chapterName) {
  if (!chapterName) return null;

  // Direct match
  const direct = path.join(QMD_DIR, `${chapterName}.qmd`);
  if (fs.existsSync(direct)) return direct;

  // Try common variations: underscores → hyphens, etc.
  const candidates = fs.readdirSync(QMD_DIR).filter(f => f.endsWith('.qmd'));
  const normalised = chapterName.toLowerCase().replace(/[-_ ]/g, '');
  for (const c of candidates) {
    const stem = c.replace(/\.qmd$/, '').toLowerCase().replace(/[-_ ]/g, '');
    if (stem === normalised) return path.join(QMD_DIR, c);
  }

  // Substring match (e.g. "blurring_2" matches "blurring_2.qmd")
  for (const c of candidates) {
    const stem = c.replace(/\.qmd$/, '').toLowerCase();
    if (stem.includes(chapterName.toLowerCase()) || chapterName.toLowerCase().includes(stem)) {
      return path.join(QMD_DIR, c);
    }
  }

  return null;
}

/**
 * Extract a focused chunk of text around references to a specific figure.
 * Returns ~3-5 paragraphs surrounding each reference to the figure stem.
 */
function extractFigureContext(qmdContent, figureStem) {
  const lines = qmdContent.split('\n');
  const stemLower = figureStem.toLowerCase().replace(/\.[^.]+$/, ''); // strip extension
  const contextRadius = 15; // lines before/after a reference to include
  const collected = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    // Match figure image paths like figures/imaging/brdf.png or @fig-lightSpray references
    if (line.includes(stemLower) || line.includes(`/${stemLower}.`) || line.includes(`/${stemLower})`)) {
      const start = Math.max(0, i - contextRadius);
      const end = Math.min(lines.length - 1, i + contextRadius);
      for (let j = start; j <= end; j++) collected.add(j);
    }
  }

  if (collected.size === 0) {
    // Fallback: return first ~40 lines (chapter intro) as minimal context
    return lines.slice(0, 40).join('\n');
  }

  // Build contiguous chunks
  const sortedIndices = [...collected].sort((a, b) => a - b);
  const chunks = [];
  let chunkStart = sortedIndices[0];
  let chunkEnd = sortedIndices[0];

  for (let k = 1; k < sortedIndices.length; k++) {
    if (sortedIndices[k] <= chunkEnd + 3) {
      chunkEnd = sortedIndices[k];
    } else {
      chunks.push(lines.slice(chunkStart, chunkEnd + 1).join('\n'));
      chunkStart = sortedIndices[k];
      chunkEnd = sortedIndices[k];
    }
  }
  chunks.push(lines.slice(chunkStart, chunkEnd + 1).join('\n'));

  return chunks.join('\n\n[...]\n\n');
}

/**
 * Extract full text for a chapter (used in chapter mode to parse all figure refs).
 */
function loadChapterText(chapterName) {
  const qmdPath = findQmdFile(chapterName);
  if (!qmdPath) return null;
  return fs.readFileSync(qmdPath, 'utf-8');
}



// ── LLM interaction planner (fast, small-token call) ────────────────────────

const PLAN_SYSTEM_PROMPT = `You are an expert at planning interactive 3D visualizations for textbook figures.

Given a textbook excerpt and figure, your goal is to come up with a pedagogically useful guided demonstration that walks through the figure in various states as the user clips next/previous buttons. Accompanying this demonstration is a series of interactions that you will design - toggling between steps of the guided demo will change the states of the interactions (toggles on/off, sliders at different values). Output the description of each step of the guided demonstration and the required ineractions in a concise JSON with no markdown and explanation:
{
  "concept": "multiple sentences explaining the specific implementation of each step of the guided demonstration to implement, at least 3 steps,
  "elements": ["list of geometric elements to recreate in 3D"],
  "interactions": [
    { "type": "slider|toggle|step|animate|drag", "label": "UI label", "teaches": "what this interaction demonstrates" }
  ],
  "camera_suggestion": "description of ideal initial viewpoint",
  "notes": "any special considerations"
}`

/**
 * Call the LLM to generate a quick interaction plan for one figure.
 * Optionally includes the image for vision-based planning.
 * Returns the parsed plan object.
 */
async function generateInteractionPlan(contextChunk, figureStem, { base64, mediaType } = {}) {
  const userContent = [];

  // Include image if provided
  if (base64 && mediaType) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${base64}` },
    });
  }

  // Always include text
  userContent.push({
    type: 'text',
    text: `Figure: ${figureStem}\n\nTextbook context:\n${contextChunk.slice(0, 3000)}`,
  });

  let content = await generateWithModel(PLANNER_MODEL, {
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userContent,
    maxTokens: PLANNER_MAX_TOKENS,
  });
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();

  try {
    return JSON.parse(content);
  } catch {
    return { concept: 'Could not parse plan', elements: [], interactions: [], labels: [], raw: content.slice(0, 500) };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Plan for a single figure (fast path — used when user drops an image).
 *
 * @param {string} figureStem  - e.g. "brdf" or "pinhole_geometry2"
 * @param {string} chapterName - e.g. "imaging" (optional, will be inferred)
 * @param {object} imageData   - optional { base64, mediaType }
 * @returns {{ figureStem, chapterName, contextChunk, interactionPlan }}
 */
async function planForFigure(figureStem, chapterName, imageData) {
  const resolvedChapter = chapterName || inferChapterFromFilename(figureStem);

  // Try to load chapter text
  const qmdContent = resolvedChapter ? loadChapterText(resolvedChapter) : null;
  let contextChunk = '';

  if (qmdContent) {
    contextChunk = extractFigureContext(qmdContent, figureStem);
  } else {
    contextChunk = `Figure: ${figureStem}. No chapter text found — plan from filename alone.`;
  }

  const interactionPlan = await generateInteractionPlan(contextChunk, figureStem, imageData);

  return {
    figureStem,
    chapterName: resolvedChapter || null,
    contextChunk,
    interactionPlan,
  };
}

/**
 * Plan for an entire chapter (batch path — used when user selects a chapter).
 * Returns plans for all 3D candidates, one at a time (async generator for streaming).
 *
 * @param {string} chapterName
 * @param {object} imageDataMap - optional map of figureStem -> { base64, mediaType }
 * @returns {Array<{ figureStem, chapterName, contextChunk, interactionPlan, imagePath }>}
 */
async function planChapter(chapterName, imageDataMap = {}) {
  const candidates = list3dCandidates(chapterName);
  if (!candidates.length) return [];

  const qmdContent = loadChapterText(chapterName);
  const plans = [];

  for (const candidate of candidates) {
    let contextChunk = '';
    if (qmdContent) {
      contextChunk = extractFigureContext(qmdContent, candidate.stem);
    } else {
      contextChunk = `Figure: ${candidate.stem} from chapter "${chapterName}". No chapter text found.`;
    }

    const interactionPlan = await generateInteractionPlan(contextChunk, candidate.stem, imageDataMap[candidate.stem]);

    plans.push({
      figureStem: candidate.stem,
      filename: candidate.filename,
      chapterName,
      contextChunk,
      interactionPlan,
      imagePath: candidate.fullPath,
    });
  }

  return plans;
}

module.exports = {
  planForFigure,
  planChapter,
};
