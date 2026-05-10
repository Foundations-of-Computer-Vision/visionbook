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
 * Used by the web generation pipeline.
 */

const fs = require('fs');
const path = require('path');
const { generateWithModel } = require('./models');
const { inferChapterFromFilename, list3dCandidates } = require('./chapter-discovery');

// ── Paths ──────────────────────────────────────────────────────────────────────
const ROOT_DIR = path.join(__dirname, '..', '..');
const QMD_DIR = ROOT_DIR;                                     // .qmd files live at repo root

const PLANNER_MODEL = 'gpt-4o';
const PLANNER_MAX_TOKENS = 2048;

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

Your output drives two things that must work as ONE unified system:
  1. DISCRETE CONTROLS — sliders, toggles, and buttons the user can manipulate freely at any time.
  2. GUIDED DEMO — a narrative walkthrough that animates the controls to preset values and explains what is happening.

The demo does NOT have its own geometry or state — it drives the controls. Each demo step is a snapshot of control values plus a tutor narration sentence.

Output ONLY valid JSON (no markdown, no explanation):
{
  "elements": ["exhaustive list of every geometric element visible in the figure that must be recreated in 3D"],

  "interactions": [
    {
      "id": "unique_camelCase_id",
      "type": "slider | toggle | button",
      "label": "short UI label shown next to the control",
      "range": [min, max, step],
      "default": defaultValue,
      "teaches": "one sentence: what manipulating this control demonstrates"
    }
  ],

  "demo_steps": [
    {
      "title": "short step title (3-6 words)",
      "narration": "2-3 sentences written as a tutor speaking directly to the learner — explain what is happening and why it matters, referencing what they can see changing in the scene. Make it conversational and specific, not generic.",
      "control_values": { "unique_camelCase_id": value, ... },
      "animate": true
    }
  ],

  "camera_suggestion": "description of ideal initial viewpoint and zoom level",
  "notes": "any special Three.js or rendering considerations"
}

Rules:
- At least 3 demo steps, at most 6.
- Every interaction must appear in at least one demo step's control_values.
- Narration must be specific to THIS figure — never generic like "notice how things change". Say exactly what changes and what it means physically/mathematically.
- If the figure shows multiple views of the same object, the same scene in different versions, or repeated panels that swap between alternatives, model that as a toggleable interaction rather than separate independent geometry. The demo should use that toggle to switch between the versions and explain what changes from one view/state to the next.
- demo_steps must tell a coherent pedagogical story: start simple, build complexity, end with the key insight.`

/**
 * Call the LLM to generate a quick interaction plan for one figure.
 * Optionally includes the image for vision-based planning.
 * Returns the parsed plan object.
 */
async function generateInteractionPlan(contextChunk, figureStem, { base64, mediaType } = {}, plannerModel = PLANNER_MODEL) {
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

  let content = await generateWithModel(plannerModel || PLANNER_MODEL, {
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
async function planForFigure(figureStem, chapterName, imageData, plannerModel = PLANNER_MODEL) {
  const resolvedChapter = chapterName || inferChapterFromFilename(figureStem);

  // Try to load chapter text
  const qmdContent = resolvedChapter ? loadChapterText(resolvedChapter) : null;
  let contextChunk = '';

  if (qmdContent) {
    contextChunk = extractFigureContext(qmdContent, figureStem);
  } else {
    contextChunk = `Figure: ${figureStem}. No chapter text found — plan from filename alone.`;
  }
  const interactionPlan = await generateInteractionPlan(contextChunk, figureStem, imageData, plannerModel);

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
async function planChapter(chapterName, imageDataMap = {}, plannerModel = PLANNER_MODEL) {
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

    const interactionPlan = await generateInteractionPlan(contextChunk, candidate.stem, imageDataMap[candidate.stem], plannerModel);

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

/**
 * Refine an existing plan based on critic feedback.
 * Called when plan-level issues are detected (e.g., missing interactions, concept misunderstood).
 *
 * @param {object} previousPlan - the interaction plan that failed
 * @param {object} evaluation - critic evaluation with scores and failure modes
 * @param {object} feedback - reviewer feedback with actionItems
 * @param {string} figureStem - e.g. "brdf"
 * @param {string} plannerModel - e.g. "gpt-4o"
 * @returns {Promise<object>} - revised interactionPlan
 */
async function refinePlan(previousPlan, evaluation, feedback, figureStem, plannerModel = PLANNER_MODEL) {
  if (!previousPlan) throw new Error('previousPlan is required');
  if (!evaluation) throw new Error('evaluation is required');
  if (!feedback) throw new Error('feedback is required');
  if (!figureStem) throw new Error('figureStem is required');

  const feedbackSummary = [
    'The previous interaction plan had issues.',
    'Critic feedback:',
    ...(feedback.action_items || []).map(a => `  • ${a}`),
    '',
    'Specific scores:',
    `  • Overall: ${evaluation.overall_average}/5`,
    `  • Concept accuracy: ${evaluation.concept_accuracy}/5`,
    ...(evaluation.failure_modes || []).map(m => `  • ${m}`),
    '',
    'Revise the interaction plan to address these issues.',
    'Focus on:',
    '  • Ensuring all required interactions are explicitly specified',
    '  • Clarifying the core concept that is being illustrated',
    '  • Specifying demo steps that progressively build understanding',
    'Output ONLY valid JSON (no markdown, no explanation).',
  ].join('\n');

  const userContent = [
    {
      type: 'text',
      text: `Figure: ${figureStem}\n\nContext:\n${previousPlan.contextChunk?.slice(0, 2000) || 'N/A'}\n\n${feedbackSummary}\n\nPrevious plan (for reference):\n${JSON.stringify(previousPlan.interactionPlan, null, 2)}`,
    },
  ];

  let content = await generateWithModel(plannerModel, {
    systemPrompt: PLAN_SYSTEM_PROMPT,
    userContent,
    maxTokens: PLANNER_MAX_TOKENS,
  });

  // Strip markdown fences if present
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();

  try {
    const refinedPlan = JSON.parse(content);
    return refinedPlan;
  } catch (e) {
    throw new Error(`Failed to parse refined plan: ${e.message}\n${content.slice(0, 300)}`);
  }
}

module.exports = {
  planForFigure,
  planChapter,
  refinePlan,
  PLANNER_MODEL,
};
