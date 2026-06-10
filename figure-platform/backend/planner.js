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

const PLANNER_MODEL = 'gemini-3.5-flash';
const PLANNER_MAX_TOKENS = 8192;

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

function buildPlannerPrompt(useFewShot = true) { return `You are an expert at planning interactive 3D visualizations for textbook figures.

PRIMARY CONTEXT:
The generated figure will usually be embedded INLINE on top of the original figure inside a PDF reader. It must behave as a same-size replacement, not as a standalone demo app.

Your output drives these interactions as ONE unified system:
  1. DIRECT MANIPULATION — drag/rotate/orbit, hover, and click interactions on the figure itself.
  2. EDGE-PLACED COMPACT CONTROLS — at most 2 small sliders/toggles, only when the original figure has a parameter worth manipulating. They should be visible but unobtrusive, with no filled panel over the figure.
  3. OPTIONAL GUIDED DEMO — hidden-by-default state transitions that can be triggered by clicking meaningful elements.

Do NOT plan bulky panels, toolbars, large buttons, legends, title cards, or explainer cards in the default view. Do not place a translucent/opaque control box over important geometry or labels. Any explanations should be hover/click popups posted to the parent reader, not fixed panels inside the figure.

Output ONLY valid JSON (no markdown, no explanation):
{
  "elements": ["exhaustive list of every geometric element visible in the figure that must be recreated in 3D"],

  "interactions": [
    {
      "id": "unique_camelCase_id",
      "type": "hover | click | drag | orbit | compact_slider | compact_toggle | hidden_state",
      "label": "very short label; visible only for compact sliders/toggles",
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
  "inline_constraints": {
    "default_view": "must match the original image silhouette, size, label scale, and crop",
    "visible_ui": "at most 2 compact sliders/toggles, visible near an edge with no filled panel, and must not cover important geometry",
    "explainers": "hover tooltips and click popups only",
    "framing": "match the source crop and whitespace; do not force-fill the iframe if the original has margins",
    "camera": "infer the source camera angle/projection/zoom so the first rendered frame is a drop-in visual replacement"
  },
  "notes": "any special Three.js or rendering considerations"
}

Rules:
- At least 3 demo steps, at most 6.
- Prefer direct manipulation or hidden state. Use compact sliders/toggles only when they directly control a meaningful figure variable, and assume they live near an edge without a filled panel.
- Never plan visible buttons for Next/Reset/Animate; if a sequence is needed, trigger it by clicking a meaningful part of the figure.
- Treat the initial camera/view as part of the plan. The generator should not invent a prettier or more dramatic 3D view; it should preserve the original apparent viewpoint, crop, label density, and whitespace.
- Narration must be specific to THIS figure — never generic like "notice how things change". Say exactly what changes and what it means physically/mathematically.
- demo_steps must tell a coherent pedagogical story: start simple, build complexity, end with the key insight.

${useFewShot ? `Here are two examples of good plans:

=== EXAMPLE 1: Geometric 3D scene with sliders driving continuous object motion ===

Textbook context:
Perspective projection equations derived geometrically. A 3D point P at world coordinates (X, Y, Z) projects through the pinhole (at the origin) onto the projection plane at distance f. From similar triangles: x = f * X/Z and y = f * Y/Z. Under perspective projection, distant objects become smaller through the inverse scaling by Z. The focal length f is the distance from the pinhole to the sensing plane.

{
  "elements": [
    "pinhole/aperture point at the origin",
    "3D point P floating in space at coordinates (X, Y, Z)",
    "projection plane perpendicular to the Z-axis at distance f",
    "projected point p = (x, y) on the projection plane",
    "light ray from P through the pinhole continuing to p",
    "Z-axis (optical axis) running through the pinhole",
    "X-axis horizontal through the pinhole",
    "similar-triangle annotations: one triangle in the XZ plane, one in the xf plane",
    "dimension labels: Z, X, f, x"
  ],
  "interactions": [
    {
      "id": "pointZ",
      "type": "slider",
      "label": "Depth Z",
      "range": [2, 12, 0.5],
      "default": 5,
      "teaches": "Moving P farther from the pinhole compresses its projected position toward the optical axis, demonstrating the 1/Z scaling in x = fX/Z"
    },
    {
      "id": "pointX",
      "type": "slider",
      "label": "Lateral position X",
      "range": [-4, 4, 0.5],
      "default": 2,
      "teaches": "Shifting P sideways moves the projected point proportionally, showing that x scales linearly with X for a fixed depth"
    },
    {
      "id": "focalLength",
      "type": "slider",
      "label": "Focal length f",
      "range": [1, 5, 0.5],
      "default": 2,
      "teaches": "Increasing f moves the projection plane farther from the pinhole, magnifying the projected image — a longer focal length is like zooming in"
    }
  ],
  "demo_steps": [
    {
      "title": "Basic pinhole setup",
      "narration": "A 3D point P sits at depth Z=5 and lateral offset X=2. A light ray travels from P straight through the pinhole and hits the projection plane at distance f=2. The projected position is x = f*X/Z = 0.8 — similar triangles make this exact.",
      "control_values": { "pointZ": 5, "pointX": 2, "focalLength": 2 },
      "animate": false
    },
    {
      "title": "Depth doubles, image halves",
      "narration": "Move P to depth Z=10 — twice as far away. The projected x shrinks to 0.4, exactly half. This is the 1/Z law: every doubling of depth halves the projected size, which is why objects look smaller when they are farther away.",
      "control_values": { "pointZ": 10, "pointX": 2, "focalLength": 2 },
      "animate": true
    },
    {
      "title": "Focal length zooms in",
      "narration": "Restore Z to 5 and increase the focal length to f=4. The projection plane moves farther out and the projected point x doubles to 1.6 — the scene is magnified. A longer focal length is a zoom lens: same 3D scene, bigger image.",
      "control_values": { "pointZ": 5, "pointX": 2, "focalLength": 4 },
      "animate": true
    },
    {
      "title": "Lateral shift scales linearly",
      "narration": "Now move P sideways from X=2 to X=4, keeping Z and f fixed. The projected x doubles to 3.2. Unlike the depth direction, lateral position scales linearly — the similar triangles on the left and right side of the optical axis are identical in shape.",
      "control_values": { "pointZ": 5, "pointX": 4, "focalLength": 4 },
      "animate": true
    }
  ],
  "camera_suggestion": "Side view looking along the Y-axis, slightly elevated, showing the full XZ plane with the pinhole at center-left and the projection plane to the right",
  "notes": "Update the ray endpoint, projected point position, and both similar-triangle overlays reactively on every slider change. Use orthographic camera so the similar-triangle proportions remain visually accurate. Render the ray as a solid line from P through the origin and on to the projection plane; use a dashed extension beyond the plane to hint at the virtual camera plane."
}

=== END EXAMPLE 1 ===

=== EXAMPLE 2: Mathematical function figure with sliders driving continuous curve shape ===

Textbook context:
The parameter sigma adjusts the spatial extent of the Gaussian g(x; sigma) = (1 / sqrt(2*pi*sigma^2)) * exp(-x^2 / (2*sigma^2)). The normalization constant is set so that the function integrates to 1. The Gaussian kernel is positive and symmetric (a zero-phase filter). In practice only samples within three standard deviations are needed — at 3*sigma the amplitude is around 1% of its central value. The Fourier transform of a Gaussian is also a Gaussian with width inversely proportional to sigma.

{
  "elements": [
    "x-axis with tick marks spanning -4 to +4",
    "y-axis with tick marks from 0 to 1",
    "smooth continuous Gaussian bell curve",
    "vertical stem markers at each integer sample position (discrete version)",
    "sigma annotation bracket from 0 to sigma on the x-axis",
    "3*sigma cutoff boundary markers (dashed vertical lines)",
    "baseline y=0"
  ],
  "interactions": [
    {
      "id": "sigma",
      "type": "slider",
      "label": "sigma",
      "range": [0.5, 3, 0.5],
      "default": 1,
      "teaches": "Controls the spatial width of the Gaussian — a wider sigma averages over more neighboring pixels, producing stronger blurring"
    },
    {
      "id": "showDiscrete",
      "type": "toggle",
      "label": "Show discrete samples",
      "default": false,
      "teaches": "Overlays the sampled integer-position values to show how the continuous kernel is approximated in practice and why truncating at 3*sigma loses almost nothing"
    },
    {
      "id": "domain",
      "type": "toggle",
      "label": "Domain",
      "options": ["Spatial", "Frequency"],
      "default": "Spatial",
      "teaches": "Switches between the spatial kernel and its Fourier transform, revealing that a wider spatial Gaussian produces a narrower frequency response"
    }
  ],
  "demo_steps": [
    {
      "title": "The Gaussian kernel, sigma=1",
      "narration": "This bell curve is the 1D Gaussian filter with sigma=1. It is centered at zero, symmetric, and normalized to integrate to 1 — meaning it computes a weighted average of neighboring pixels without changing the overall image brightness.",
      "control_values": { "sigma": 1, "showDiscrete": false, "domain": "Spatial" },
      "animate": false
    },
    {
      "title": "Wider sigma, stronger blur",
      "narration": "Increase sigma and the bell flattens and spreads. Pixels farther from the center now carry significant weight, so the filter averages over a larger neighborhood and produces stronger blurring. Sigma is the single knob that controls how much detail is removed.",
      "control_values": { "sigma": 2.5, "showDiscrete": false, "domain": "Spatial" },
      "animate": true
    },
    {
      "title": "Discretizing: truncate at 3*sigma",
      "narration": "Enable discrete samples. The continuous bell is sampled at integer pixel positions. Notice that beyond 3*sigma the value is already around 1% of the peak — truncating the kernel there loses almost nothing while keeping the filter small enough to be practical.",
      "control_values": { "sigma": 1, "showDiscrete": true, "domain": "Spatial" },
      "animate": true
    },
    {
      "title": "Frequency domain: wide kernel, narrow pass",
      "narration": "Switch to the frequency domain. With sigma=2.5, the Fourier transform is a narrow bell — the filter strongly attenuates high spatial frequencies, which is exactly what blurring does. Only low-frequency structure, the gradual changes, passes through.",
      "control_values": { "sigma": 2.5, "showDiscrete": false, "domain": "Frequency" },
      "animate": true
    },
    {
      "title": "The sigma trade-off: space vs. frequency",
      "narration": "Reduce sigma to 0.5. The spatial kernel shrinks but the frequency response widens — the filter now passes more high-frequency content and blurs less. This inverse relationship between spatial width and frequency width is a fundamental property of the Fourier transform.",
      "control_values": { "sigma": 0.5, "showDiscrete": false, "domain": "Frequency" },
      "animate": true
    }
  ],
  "camera_suggestion": "Front-facing 2D orthographic view centered on the origin, x-axis spanning -4 to +4, y-axis from 0 to 1.1",
  "notes": "Render the Gaussian curve as a smooth THREE.Line sampled at 200 points. For discrete stems use LineSegments from each integer sample down to y=0. Recompute all curve points reactively whenever sigma changes. For the domain toggle, keep both curves in the scene and show/hide rather than destroying geometry. The frequency-domain Gaussian has sigma_freq = 1 / (2 * pi * sigma_spatial) — for sigma in [0.5, 3] this gives sigma_freq in [0.053, 0.318], so the frequency axis must use x range [-0.5, 0.5] (Nyquist range) rather than the spatial domain's [-4, 4], otherwise the curve will be an invisible spike."
}

=== END EXAMPLE 2 ===` : ''}`; }

/**
 * Call the LLM to generate a quick interaction plan for one figure.
 * Optionally includes the image for vision-based planning.
 * Returns the parsed plan object.
 */
async function generateInteractionPlan(contextChunk, figureStem, { base64, mediaType } = {}, plannerModel = PLANNER_MODEL, useFewShot = true) {
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
    systemPrompt: buildPlannerPrompt(useFewShot),
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
async function planForFigure(figureStem, chapterName, imageData, plannerModel = PLANNER_MODEL, useFewShot = true) {
  const resolvedChapter = chapterName || inferChapterFromFilename(figureStem);

  // Try to load chapter text
  const qmdContent = resolvedChapter ? loadChapterText(resolvedChapter) : null;
  let contextChunk = '';

  if (qmdContent) {
    contextChunk = extractFigureContext(qmdContent, figureStem);
  } else {
    contextChunk = `Figure: ${figureStem}. No chapter text found — plan from filename alone.`;
  }
  const interactionPlan = await generateInteractionPlan(contextChunk, figureStem, imageData, plannerModel, useFewShot);

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
async function planChapter(chapterName, imageDataMap = {}, plannerModel = PLANNER_MODEL, useFewShot = true) {
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

    const interactionPlan = await generateInteractionPlan(contextChunk, candidate.stem, imageDataMap[candidate.stem], plannerModel, useFewShot);

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
async function refinePlan(previousPlan, evaluation, feedback, figureStem, plannerModel = PLANNER_MODEL, useFewShot = true) {
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
    systemPrompt: buildPlannerPrompt(useFewShot),
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
