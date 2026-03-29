require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { buildEvalPrompt, finaliseEval } = require('./critic');
const { planForFigure, planChapter, listChapters, list3dCandidates, inferChapterFromFilename } = require('./planner');
const { generateWithModel, getAvailableModels } = require('./models');

// ── Screenshot helper ────────────────────────────────────────────────────────────
let _browser = null;
async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return _browser;
}

async function screenshotHtml(html, waitMs = 2800) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, waitMs));
    const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 82 });
    return { data: shot, mediaType: 'image/jpeg' };
  } catch (err) {
    console.error('Screenshot failed:', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => { });
  }
}

const app = express();
const PORT = 3001;
const generationJobs = new Map();

// ── Paths ─────────────────────────────────────────────────────────────────────
const EXPERIMENTS_DIR = path.join(__dirname, '..', '..', 'prompt_experiments');
const FIGURES_DIR = path.join(__dirname, '..', '..', 'figures');

// ── API generation config ──────────────────────────────────────────────────────
// CURRENT_EXPERIMENT is derived automatically from a hash of the system prompt +
// scaffold.  Whenever you edit the prompt or base_scene_robust.html, the next
// server restart creates a brand-new experiment bucket in the dashboard.
const EXPERIMENT_BASE = 'base_scene_robust';   // human-readable prefix
const CURRENT_MODEL = 'gpt-5.4';             // model used by the generator
// CURRENT_EXPERIMENT is set below, after the system prompt is built.

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '20mb' }));

// ── OpenAI client (imported from models.js for evaluator / planner) ──

// ── Base scaffold ─────────────────────────────────────────────────────────────
// The model extends this file instead of writing from scratch.
// It provides: renderer, scene, orthographic camera, OrbitControls,
// floating label system (addLabel), resize handler, Reset View button, CSS.
// Edit backend/base_scene_robust.html to change the starting point for all generations.
const BASE_SCAFFOLD_PATH = path.join(__dirname, 'base_scene_robust.html');
if (!fs.existsSync(BASE_SCAFFOLD_PATH)) {
  console.error('ERROR: base_scene_robust.html not found in backend/.');
  process.exit(1);
}
const BASE_SCAFFOLD = fs.readFileSync(BASE_SCAFFOLD_PATH, 'utf-8');
console.log('Base scaffold loaded:', BASE_SCAFFOLD_PATH);

// ── Results folder ────────────────────────────────────────────────────────────
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// ── System prompt (built at startup so it embeds the live base scaffold) ──────
function buildSystemPrompt(scaffold) {
  return `You are an expert Three.js developer who converts 2D textbook figures into interactive 3D web visualizations.

OUTPUT RULES — non-negotiable:
• Your response MUST be ONLY a complete HTML file. No explanation, no markdown, no code fences.
• It MUST start with exactly: <!DOCTYPE html>
• It MUST end with exactly: </html>
• Do NOT truncate. Output every line.
• Copy the BASE SCAFFOLD below in full, then add your code where indicated.
• The scaffold already includes the importmap and imports for Three.js + OrbitControls.
  Do NOT add duplicate <script type="importmap"> or duplicate import statements.
  If you need additional Three.js addons, import them from 'three/addons/…'.

────────────────────────────────────────────────────────────────────────────────
BASE SCAFFOLD — copy this file VERBATIM, then insert your code at the marked
location: "// ADD YOUR SCENE OBJECTS, GEOMETRY, LABELS, AND INTERACTION LOGIC BELOW HERE"
Do NOT modify, remove, or re-declare anything already in the scaffold.
────────────────────────────────────────────────────────────────────────────────
${scaffold}
────────────────────────────────────────────────────────────────────────────────

What the scaffold already provides (do NOT re-declare or re-implement):
• THREE + OrbitControls imports via importmap
• WebGLRenderer on <canvas id="c">
• Orthographic camera — tune: d (view half-size), camera.position, camera.zoom
• Damped OrbitControls render loop
• animate() function with requestAnimationFrame + _syncLabels()
• addLabel(html, position, options?) helper → pushes to _labels[]
• _syncLabels() called each frame inside animate()
• ResizeObserver resize handler keeping camera + renderer in sync
• White background, full-page <canvas id="c">

⚠ CRITICAL — DO NOT redefine any of these identifiers:
  addLabel, _labels, _syncLabels, animate, renderer, scene, camera, controls, d, aspect
  Redefining them causes a SyntaxError or silently breaks the scene.
  Just CALL them and ADD new objects to scene.

YOUR TASK — extend the scaffold for the uploaded figure:

STEP 1 · ANALYSE THE FIGURE
  Look carefully at every element: axes, planes, surfaces, points, lines,
  arrows, curves, labels, colours, and the geometric relationships between them.
  Identify the core concept being illustrated.

STEP 2 · PLAN GEOMETRY — map each 2D element to a Three.js primitive:
  axis/arrow    → THREE.ArrowHelper
  line segment  → THREE.Line with BufferGeometry
  dashed line   → LineDashedMaterial (call .computeLineDistances())
  flat plane    → PlaneGeometry + MeshBasicMaterial(transparent, DoubleSide)
  solid surface → appropriate BufferGeometry + MeshBasicMaterial
  point / dot   → SphereGeometry, radius 0.04–0.08
  curve         → CatmullRomCurve3 → TubeGeometry
  Set d and camera.position so the whole scene is comfortably framed.
  Match colours from the original figure. Keep background white (#ffffff).

STEP 3 · LABELS — THIS IS CRITICAL, follow exactly:

  3a. LABEL AUDIT — before writing any code:
      • List EVERY text label visible in the original figure: axis names, point
        names, variable names, coordinate labels, titles, annotations, dimensions.
      • Verify each axis label matches the correct geometric direction — if the
        figure shows "x₁" pointing right, your label must also point right.
      • If the figure uses subscripted names (x₁, x₂, x₃) instead of (x, y, z),
        reproduce the EXACT names from the figure.
      • Missing or mislabeled text is a critical failure.

  3b. USE THE SCAFFOLD'S LABEL SYSTEM — do NOT create your own.
      The scaffold already provides addLabel() and _syncLabels(). Call the
      scaffold's addLabel exactly like this:

        addLabel('x<sub>1</sub>', new THREE.Vector3(5, 0, 0), { bold: true });
        addLabel('origin',        new THREE.Vector3(0, 0, 0), { fontSize: '11px', color: '#888' });

      Signature:  addLabel(htmlString, THREE.Vector3, options?)
        options.color      – css color   (default '#111')
        options.fontSize   – css string  (default '13px')
        options.bold       – boolean     (default false)
        options.offset     – [dx,dy] px  (default [0,0])
        options.background – css string  (default 'none')

      ⚠ DO NOT redefine addLabel, _syncLabels, _labels, updateLabels, or animate.
        They already exist in the scaffold. Redefining them causes fatal JS errors.
        Just CALL addLabel() in your code below the scaffold marker comment.

  3c. LABEL CONTENT RULES:
      • Use HTML entities for maths: 'x<sub>1</sub>', '&theta;', '&lambda;',
        '<i>f</i>', '&pi;', 'R<sup>2</sup>', '&#x2192;' (arrow).
      • Offset label positions 0.15–0.25 units away from their anchor point
        so text does not overlap geometry.
      • Every axis arrow MUST have a label at its tip.
      • Every named point, vector, plane, or region in the figure MUST have a label.

STEP 4 · INTERACTIVITY — add 2–5 controls in the #ui div (which already exists):
  • Step-through buttons — animate a process stage by stage
  • Parameter sliders    — let the user vary a quantity and see the effect
  • Toggle buttons       — show/hide elements
  • Animate button       — run a looping demonstration
  • The Reset View button already exists — do NOT create a second one.
  • Do NOT redefine animate(). To add per-frame logic, use a separate
    function and call it from a setInterval or from the controls 'change'
    event, or just modify objects inline — the scaffold's animate loop
    continuously re-renders.

STEP 5 · CODE STYLE
  • Add brief JS comments explaining what each block of code teaches.
  • Prefer conceptual clarity over visual realism.`;
}
const SYSTEM_PROMPT = buildSystemPrompt(BASE_SCAFFOLD);

// ── Derive experiment label from prompt content ──────────────────────────────
const PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 8);
const CURRENT_EXPERIMENT = `${EXPERIMENT_BASE}_${PROMPT_HASH}`;
console.log(`Experiment: ${CURRENT_EXPERIMENT}  (model: ${CURRENT_MODEL})`);

// ── Helper: strip accidental markdown fences and extract the HTML ────────────
function stripFences(text) {
  // If the model wrapped it in ```html ... ```, extract just the inside
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // Otherwise strip any leading/trailing fence lines
  return text
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

// ── Post-process: fix common model mistakes that cause blank scenes ──────────
function fixGeneratedHtml(html) {
  let fixed = html;
  let fixes = [];

  // 1. Remove duplicate addLabel redeclarations (model re-implements scaffold's addLabel)
  //    The scaffold's addLabel is the FIRST one; remove any subsequent re-declarations.
  const addLabelDupes = [...fixed.matchAll(/^[ \t]*(function addLabel\b[^{]*\{)/gm)];
  if (addLabelDupes.length > 1) {
    // Keep the first (scaffold), remove subsequent ones with their body
    for (let i = addLabelDupes.length - 1; i >= 1; i--) {
      const start = addLabelDupes[i].index;
      // Find matching closing brace
      let depth = 0, end = start;
      for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
        if (fixed[j] === '{') depth++;
        if (fixed[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      fixed = fixed.slice(0, start) + '// [auto-removed duplicate addLabel]\n' + fixed.slice(end);
      fixes.push('removed duplicate addLabel at char ' + start);
    }
  }

  // 2. Remove duplicate animate() redeclarations
  const animDupes = [...fixed.matchAll(/^[ \t]*(function animate\b[^{]*\{)/gm)];
  if (animDupes.length > 1) {
    for (let i = animDupes.length - 1; i >= 1; i--) {
      const start = animDupes[i].index;
      let depth = 0, end = start;
      for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
        if (fixed[j] === '{') depth++;
        if (fixed[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      fixed = fixed.slice(0, start) + '// [auto-removed duplicate animate]\n' + fixed.slice(end);
      fixes.push('removed duplicate animate at char ' + start);
    }
  }

  // 3. Remove duplicate updateLabels() that the model creates alongside _syncLabels
  const updateLabelsDupes = [...fixed.matchAll(/^[ \t]*(function updateLabels\b[^{]*\{)/gm)];
  if (updateLabelsDupes.length > 0) {
    for (let i = updateLabelsDupes.length - 1; i >= 0; i--) {
      const start = updateLabelsDupes[i].index;
      let depth = 0, end = start;
      for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
        if (fixed[j] === '{') depth++;
        if (fixed[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      fixed = fixed.slice(0, start) + '// [auto-removed conflicting updateLabels]\n' + fixed.slice(end);
      fixes.push('removed conflicting updateLabels');
    }
  }

  // 4. Fix model's label calls that use old 2-arg style: addLabel(html, pos, true)
  //    Convert to scaffold API: addLabel(html, pos, { fontSize: '11px' })
  fixed = fixed.replace(/addLabel\(([^,]+),\s*([^,]+),\s*true\s*\)/g,
    "addLabel($1, $2, { fontSize: '11px' })");

  // 5. If model created its own `const labels = [];`, remove it (scaffold uses _labels)
  fixed = fixed.replace(/^[ \t]*const labels\s*=\s*\[\s*\]\s*;?\s*$/gm, '// [auto-removed: scaffold uses _labels]');

  if (fixes.length) {
    console.log('[fixGeneratedHtml]', fixes.join('; '));
  }
  return fixed;
}

// ── Helper: generate a simple unique id ───────────────────────────────────────
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── GET /api/prompt — return the current system prompt for UI display ──────────
app.get('/api/prompt', (req, res) => {
  res.json({ prompt: SYSTEM_PROMPT, experiment: CURRENT_EXPERIMENT, model: CURRENT_MODEL });
});

// ── GET /api/models — list available generator models for the UI ──────────────
app.get('/api/models', (req, res) => {
  res.json(getAvailableModels());
});

// ── GET /api/chapters — list chapters with 3D candidate counts ────────────────
app.get('/api/chapters', (req, res) => {
  try {
    const chapters = listChapters();
    return res.json(chapters);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chapter-candidates/:chapter — list 3D candidate images in a chapter ─
app.get('/api/chapter-candidates/:chapter', (req, res) => {
  try {
    const candidates = list3dCandidates(req.params.chapter);
    // Return filename + base64 thumbnail for each
    const result = candidates.map(c => {
      const base64 = fs.readFileSync(c.fullPath).toString('base64');
      const ext = path.extname(c.filename).toLowerCase();
      const mediaType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      return { filename: c.filename, stem: c.stem, base64, mediaType };
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/plan — plan for a single figure (fast, returns before generation) ──
app.post('/api/plan', async (req, res) => {
  const { filename, chapterHint } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required.' });

  const stem = filename.replace(/\.[^.]+$/, '');
  const chapter = chapterHint || inferChapterFromFilename(filename) || inferChapter(stem);

  try {
    const plan = await planForFigure(stem, chapter);
    return res.json(plan);
  } catch (err) {
    console.error('Plan error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Planning failed.' });
  }
});

// ── POST /api/plan-chapter — plan all 3D candidates in a chapter ─────────────
app.post('/api/plan-chapter', async (req, res) => {
  const { chapter } = req.body;
  if (!chapter) return res.status(400).json({ error: 'chapter is required.' });

  try {
    const plans = await planChapter(chapter);
    return res.json(plans);
  } catch (err) {
    console.error('Plan-chapter error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Chapter planning failed.' });
  }
});

// ── Retry helper for transient provider/network errors ───────────────────────
async function withRetry(fn, { retries = 4, baseDelay = 2500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = /fetch failed|connection error|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|ENOTFOUND|429|503/i.test(err?.message || '');
      if (isRetryable && attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`Retryable error (attempt ${attempt + 1}/${retries}): ${err.message}. Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ── Build the user-message text that injects the plan into the generator ──────
function buildPlanInjection(plan) {
  const parts = [];
  if (plan.contextChunk) {
    parts.push(`CONTEXT FROM TEXTBOOK:\n${plan.contextChunk.slice(0, 3000)}`);
  }

  parts.push(`INTERACTION PLAN:\n${JSON.stringify(plan.interactionPlan || {}, null, 2)}`);
  parts.push('Follow the interaction plan above. Output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.')
  return parts.join('\n\n');
}

async function generateFigure({ base64, mediaType, filename, plan, model: requestedModel, evaluate = true }) {
  if (!base64 || !mediaType || !filename) {
    const err = new Error('base64, mediaType, and filename are required.');
    err.statusCode = 400;
    throw err;
  }

  const modelId = requestedModel || CURRENT_MODEL;
  if (!requestedModel) {
    console.warn(`[generate] no model provided by client; falling back to default "${CURRENT_MODEL}"`);
  }
  console.log(`[generate] requested="${requestedModel}" → using="${modelId}" | file=${filename}`);

  const userContent = [
    {
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${base64}` },
    },
    {
      type: 'text',
      text: plan
        ? buildPlanInjection(plan)
        : 'Analyse this figure carefully. Then output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.',
    },
  ];

  let html = await withRetry(() => generateWithModel(modelId, {
    systemPrompt: SYSTEM_PROMPT,
    userContent,
    maxTokens: 16384,
  }));
  html = stripFences(html);
  html = fixGeneratedHtml(html);

  if (!html.trimStart().startsWith('<')) {
    console.error('Model did not return HTML. Raw response:\n', html.slice(0, 500));
    const err = new Error('The model did not return a valid HTML file. Please try again.');
    err.statusCode = 502;
    err.raw = html.slice(0, 500);
    throw err;
  }

  const figureId = makeId();
  const timestamp = new Date().toISOString();
  const shot = await screenshotHtml(html);

  const record = {
    id: figureId,
    filename,
    base64thumb: shot ? shot.data : base64,
    mediaType: shot ? shot.mediaType : (mediaType || 'image/png'),
    source_base64: base64,
    source_media_type: mediaType,
    html,
    timestamp,
    source: 'api',
    model: modelId,
    experiment: CURRENT_EXPERIMENT,
    promptHash: PROMPT_HASH,
  };
  const recordPath = path.join(RESULTS_DIR, `${figureId}.json`);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

  let evaluation = null;
  if (evaluate !== false) {
    try {
      evaluation = await runEvaluation(record, recordPath);
      console.log(`Auto-eval for ${figureId}: overall=${evaluation.overall_average}`);
    } catch (evalErr) {
      console.warn('Auto-eval failed (result saved without scores):', evalErr.message);
    }
  }

  return { html, figureId, timestamp, model: modelId, evaluation };
}

function updateGenerationJob(jobId, patch) {
  const current = generationJobs.get(jobId);
  if (!current) return;
  generationJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

// ── POST /api/generate ────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const result = await generateFigure(req.body);
    return res.json(result);
  } catch (err) {
    const modelId = req.body?.model || CURRENT_MODEL;
    console.error(`Generation error (${modelId}):`, err?.message || err);
    return res.status(err.statusCode || 500).json({ error: err?.message || `Unknown error from model ${modelId}.`, ...(err.raw ? { raw: err.raw } : {}) });
  }
});

app.post('/api/generate-async', (req, res) => {
  const jobId = makeId();
  generationJobs.set(jobId, {
    id: jobId,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Run immediately — no queue, full parallelism
  generateFigure(req.body)
    .then((result) => {
      updateGenerationJob(jobId, { status: 'done', result });
    })
    .catch((err) => {
      updateGenerationJob(jobId, {
        status: 'error',
        error: err?.message || 'Generation failed.',
        ...(err?.raw ? { raw: err.raw } : {}),
      });
    });

  return res.status(202).json({ jobId });
});

app.get('/api/generate-status/:id', (req, res) => {
  const job = generationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Generation job not found.' });
  return res.json(job);
});

// ── Chapter inference ───────────────────────────────────────────────────────
// 1. File lookup: search figures/<chDir>/<stem>.<ext>
// 2. Name-based: chapter directory name appears as substring in figure stem
//    e.g. "homography_plane_geometry2" → "homography"
function inferChapter(stem) {
  if (!stem || !fs.existsSync(FIGURES_DIR)) return null;

  // Hardcoded hints for figures whose source image isn't in figures/ by exact name
  const KNOWN = {
    pinhole: 'imaging',
    brdf: 'imaging',
  };
  if (KNOWN[stem.toLowerCase()]) return KNOWN[stem.toLowerCase()];

  let chapters;
  try {
    chapters = fs.readdirSync(FIGURES_DIR).filter(d => {
      try { return fs.statSync(path.join(FIGURES_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { return null; }

  // 1. Exact file lookup
  for (const ch of chapters) {
    for (const ext of ['png', 'jpg', 'jpeg', 'PNG', 'JPG', 'eps']) {
      if (fs.existsSync(path.join(FIGURES_DIR, ch, `${stem}.${ext}`))) return ch;
    }
  }

  // 2. Chapter name is a substring of the figure stem (prefer longer chapter names)
  const byLen = [...chapters].sort((a, b) => b.length - a.length);
  for (const ch of byLen) {
    if (stem.toLowerCase().includes(ch.toLowerCase())) return ch;
  }

  return null;
}

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
    const records = files
      .map((f) => {
        try {
          const raw = fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8');
          const parsed = JSON.parse(raw);
          const { id, filename, base64thumb, timestamp, source, evaluation } = parsed;
          const stem = filename ? filename.replace(/\.[^.]+$/, '') : '';
          const chapter = inferChapter(stem);
          const model = parsed.model || 'gpt-4o';
          const experiment = parsed.experiment || 'base_scene_robust';
          return { id, filename, base64thumb, timestamp, source: source || 'api', model, experiment, evaluation: evaluation || null, chapter };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json(records);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/result/:id ───────────────────────────────────────────────────────
app.get('/api/result/:id', (req, res) => {
  const filePath = path.join(RESULTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Result not found.' });
  }
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return res.json(record);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/save ───────────────────────────────────────────────────────────
// Accepts chat-generated HTML (no image required). Source is set to 'chat'.
app.post('/api/save', (req, res) => {
  const { filename, html, base64thumb, source } = req.body;
  if (!filename || !html) {
    return res.status(400).json({ error: 'filename and html are required.' });
  }
  if (!html.trimStart().startsWith('<')) {
    return res.status(400).json({ error: 'html must start with <' });
  }
  const id = makeId();
  const timestamp = new Date().toISOString();
  const record = {
    id,
    filename,
    base64thumb: base64thumb || null,
    html,
    timestamp,
    source: source || 'chat',
    model: req.body.model || CURRENT_MODEL,
    experiment: req.body.experiment || CURRENT_EXPERIMENT,
  };
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${id}.json`),
    JSON.stringify(record, null, 2)
  );
  return res.json({ id, timestamp });
});

// ── buildEvalPrompt + finaliseEval live in critic.js ─────────────────────────
// Edit critic.js to change failure modes, score rubrics, or derived metrics.

// ── Shared evaluation runner ─────────────────────────────────────────────────
// Shared evaluator call: runs model + parses JSON + finalises rubric scores.
async function evaluateHtmlWithPrompt({ html, evalImage, evalMediaType = 'image/png' }) {
  if (!html) throw new Error('No HTML found for evaluation.');

  const userContent = [
    ...(evalImage
      ? [{ type: 'image_url', image_url: { url: `data:${evalMediaType};base64,${evalImage}` } }]
      : []),
    {
      type: 'text',
      text: `Here is the generated HTML code to evaluate:\n\n${html}\n\nOutput ONLY the JSON evaluation object.`,
    },
  ];

  let content = await generateWithModel('gpt-4o', {
    systemPrompt: buildEvalPrompt(),
    userContent,
    maxTokens: 512,
  });
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  content = content.trim();

  let evaluation;
  try { evaluation = JSON.parse(content); }
  catch { throw new Error('Evaluator did not return valid JSON: ' + content.slice(0, 200)); }

  return finaliseEval(evaluation);
}

// Calls the shared evaluator, persists to the record file,
// and returns the evaluation object. Throws on error.
async function runEvaluation(record, filePath) {
  const { html, source_base64, source_media_type, base64thumb } = record;
  if (!html) throw new Error('No HTML found for this result.');

  // Always evaluate against the original source image, not the generated screenshot
  const evalImage = source_base64 || base64thumb;
  const evalMediaType = source_media_type || 'image/png';

  const evaluation = await evaluateHtmlWithPrompt({
    html,
    evalImage,
    evalMediaType,
  });

  // Persist back to disk
  record.evaluation = evaluation;
  if (filePath) fs.writeFileSync(filePath, JSON.stringify(record, null, 2));

  return evaluation;
}

// ── POST /api/evaluate ────────────────────────────────────────────────────────
// Manual re-evaluation endpoint (used for existing results without scores).
app.post('/api/evaluate', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const filePath = path.join(RESULTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Result not found.' });

  let record;
  try { record = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return res.status(500).json({ error: 'Failed to read result file.' }); }

  try {
    const evaluation = await runEvaluation(record, filePath);
    return res.json(evaluation);
  } catch (err) {
    console.error('Evaluation error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Unknown error during evaluation.' });
  }
});

// ── POST /api/evaluate-batch ──────────────────────────────────────────────────
// Accepts { ids: string[] } and evaluates them one-by-one (no concurrency).
// Returns results as they complete via streaming JSON lines.
app.post('/api/evaluate-batch', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) is required.' });
  }

  // Stream results line-by-line so the frontend can show progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  for (const id of ids) {
    const filePath = path.join(RESULTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      res.write(JSON.stringify({ id, status: 'error', error: 'Result not found.' }) + '\n');
      continue;
    }

    let record;
    try { record = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
    catch { res.write(JSON.stringify({ id, status: 'error', error: 'Failed to read result.' }) + '\n'); continue; }

    try {
      const evaluation = await runEvaluation(record, filePath);
      res.write(JSON.stringify({ id, status: 'ok', evaluation }) + '\n');
    } catch (err) {
      console.error(`Batch eval error for ${id}:`, err?.message || err);
      res.write(JSON.stringify({ id, status: 'error', error: err?.message || 'Evaluation failed.' }) + '\n');
    }
  }

  res.end();
});

// ── DELETE /api/result/:id ────────────────────────────────────────────────────
app.delete('/api/result/:id', (req, res) => {
  const filePath = path.join(RESULTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Result not found.' });
  }
  try {
    fs.unlinkSync(filePath);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/base-scaffold ────────────────────────────────────────────────────
app.get('/api/base-scaffold', (req, res) => {
  res.json({ content: BASE_SCAFFOLD });
});

// ── GET /api/thumb/:id  — screenshot of a saved API result (cached as .thumb.b64) ─
app.get('/api/thumb/:id', async (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '');
  const jsonPath = path.join(RESULTS_DIR, `${id}.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Not found' });

  const thumbPath = path.join(RESULTS_DIR, `${id}.thumb.b64`);
  if (fs.existsSync(thumbPath)) {
    return res.json({ data: fs.readFileSync(thumbPath, 'utf-8'), mediaType: 'image/jpeg' });
  }

  try {
    const record = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (!record.html) return res.status(400).json({ error: 'No HTML in record' });
    const shot = await screenshotHtml(record.html);
    if (!shot) return res.status(500).json({ error: 'Screenshot failed' });
    fs.writeFileSync(thumbPath, shot.data);
    return res.json({ data: shot.data, mediaType: shot.mediaType });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/experiments/thumb  — lazy screenshot of an experiment HTML (cached) ────
app.get('/api/experiments/thumb', async (req, res) => {
  const p = path.resolve(req.query.path || '');
  if (!p.startsWith(EXPERIMENTS_DIR) || !fs.existsSync(p))
    return res.status(404).json({ error: 'Not found' });

  const thumbPath = p.replace(/\.html$/, '.thumb.b64');
  if (fs.existsSync(thumbPath)) {
    return res.json({ data: fs.readFileSync(thumbPath, 'utf-8'), mediaType: 'image/jpeg' });
  }

  try {
    const html = fs.readFileSync(p, 'utf-8');
    const shot = await screenshotHtml(html);
    if (!shot) return res.status(500).json({ error: 'Screenshot failed' });
    fs.writeFileSync(thumbPath, shot.data);
    return res.json({ data: shot.data, mediaType: shot.mediaType });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/experiments/html  — serve raw HTML for an experiment figure ──────
app.get('/api/experiments/html', (req, res) => {
  const p = path.resolve(req.query.path || '');
  if (!p.startsWith(EXPERIMENTS_DIR) || !fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/html');
  res.send(fs.readFileSync(p, 'utf-8'));
});

// ── GET /api/experiments/image  — return base64 of source image ───────────────
app.get('/api/experiments/image', (req, res) => {
  const p = path.resolve(req.query.path || '');
  if (!p.startsWith(FIGURES_DIR) || !fs.existsSync(p)) return res.status(404).send('');
  res.send(fs.readFileSync(p).toString('base64'));
});

// ── GET /api/experiments/imageurl  — serve source image directly ──────────────
app.get('/api/experiments/imageurl', (req, res) => {
  const p = path.resolve(req.query.path || '');
  if (!p.startsWith(FIGURES_DIR) || !fs.existsSync(p)) return res.status(404).send('');
  res.sendFile(p);
});

// ── Experiment helpers ────────────────────────────────────────────────────────

// Walk prompt_experiments/ and return structured index:
// [ { experiment, prompt, models: [ { model, figures: [ { name, htmlPath, imagePath } ] } ] } ]
function scanExperiments() {
  if (!fs.existsSync(EXPERIMENTS_DIR)) return [];
  const experiments = [];

  for (const expName of fs.readdirSync(EXPERIMENTS_DIR).sort()) {
    const expDir = path.join(EXPERIMENTS_DIR, expName);
    if (!fs.statSync(expDir).isDirectory()) continue;

    // Read prompt text (prompt.txt or prompt_with_base_code.txt)
    let prompt = '';
    for (const pf of ['prompt.txt', 'prompt_with_base_code.txt']) {
      const pPath = path.join(expDir, pf);
      if (fs.existsSync(pPath)) { prompt = fs.readFileSync(pPath, 'utf-8').trim(); break; }
    }

    const models = [];
    for (const entry of fs.readdirSync(expDir).sort()) {
      const modelDir = path.join(expDir, entry);
      if (!fs.statSync(modelDir).isDirectory()) continue;

      const figures = [];

      // Figures may be directly in modelDir or in chapter subdirs (imaging/, homographies/)
      const collectHtml = (dir, chapter) => {
        for (const f of fs.readdirSync(dir).sort()) {
          if (!f.endsWith('.html')) continue;
          const figName = f.replace(/\.html$/, '');
          const htmlPath = path.join(dir, f);

          // Find matching source image: check figures/<chapter>/<name>.png|jpg
          let imagePath = null;
          const chapterToSearch = chapter || figName;
          for (const ext of ['png', 'jpg', 'jpeg', 'PNG', 'JPG']) {
            // Try figures/<chapter>/<name>.<ext>
            if (chapter) {
              const candidate = path.join(FIGURES_DIR, chapter, `${figName}.${ext}`);
              if (fs.existsSync(candidate)) { imagePath = candidate; break; }
            }
            // Try all chapter dirs
            for (const chDir of fs.readdirSync(FIGURES_DIR)) {
              const candidate = path.join(FIGURES_DIR, chDir, `${figName}.${ext}`);
              if (fs.existsSync(candidate)) { imagePath = candidate; break; }
            }
            if (imagePath) break;
          }

          const resolvedChapter = chapter || inferChapter(figName);
          figures.push({ name: figName, chapter: resolvedChapter, htmlPath, imagePath });
        }
      };

      const modelEntries = fs.readdirSync(modelDir);
      const hasSubdirs = modelEntries.some(e => fs.statSync(path.join(modelDir, e)).isDirectory());

      if (hasSubdirs) {
        for (const sub of modelEntries.sort()) {
          const subDir = path.join(modelDir, sub);
          if (fs.statSync(subDir).isDirectory()) collectHtml(subDir, sub);
        }
      } else {
        collectHtml(modelDir, null);
      }

      if (figures.length > 0) models.push({ model: entry, figures });
    }

    if (models.length > 0) experiments.push({ experiment: expName, prompt, models });
  }

  return experiments;
}

// Load evaluation cache for experiment figures (stored alongside the html as <name>.eval.json)
function loadExpEval(htmlPath) {
  const evalPath = htmlPath.replace(/\.html$/, '.eval.json');
  if (!fs.existsSync(evalPath)) return null;
  try { return JSON.parse(fs.readFileSync(evalPath, 'utf-8')); } catch { return null; }
}

// ── GET /api/experiments ──────────────────────────────────────────────────────
app.get('/api/experiments', (req, res) => {
  try {
    const tree = scanExperiments();
    // Attach cached evaluations
    for (const exp of tree) {
      for (const m of exp.models) {
        for (const fig of m.figures) {
          fig.evaluation = loadExpEval(fig.htmlPath);
        }
      }
    }
    return res.json(tree);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/experiments/evaluate ───────────────────────────────────────────
// Evaluate a single experiment figure in-place; cache result as <name>.eval.json
app.post('/api/experiments/evaluate', async (req, res) => {
  const { htmlPath, imagePath } = req.body;
  if (!htmlPath) return res.status(400).json({ error: 'htmlPath required.' });

  const absHtml = path.resolve(htmlPath);
  if (!fs.existsSync(absHtml)) return res.status(404).json({ error: 'HTML file not found.' });

  const html = fs.readFileSync(absHtml, 'utf-8');
  let base64thumb = null;
  if (imagePath) {
    const absImg = path.resolve(imagePath);
    if (fs.existsSync(absImg)) base64thumb = fs.readFileSync(absImg).toString('base64');
  }

  try {
    const evaluation = await evaluateHtmlWithPrompt({
      html,
      evalImage: base64thumb,
      evalMediaType: 'image/png',
    });

    // Cache alongside the HTML file
    const evalPath = absHtml.replace(/\.html$/, '.eval.json');
    fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2));

    return res.json(evaluation);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Unknown error.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Chapter Preview & Editor routes
// ══════════════════════════════════════════════════════════════════════════════
const {
  listQmdFiles, listBookStructure, buildChapterHtml, getSubstitutionMap,
  saveOverride, analyzeChapterFigure, QMD_DIR,
} = require('./chapter_editor');
const { generateWithModel: genModel } = require('./models');

// ── GET /api/chapter-preview/qmds — list available qmd files ─────────────────
app.get('/api/chapter-preview/qmds', (req, res) => {
  try {
    return res.json(listQmdFiles());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chapter-preview/book-structure — full parts+chapters tree ─────────
app.get('/api/chapter-preview/book-structure', (req, res) => {
  try {
    return res.json(listBookStructure());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chapter-preview/substitutions — what figures can be swapped ──────
app.get('/api/chapter-preview/substitutions', (req, res) => {
  const { qmd } = req.query;
  if (!qmd) return res.status(400).json({ error: 'qmd param required' });
  const qmdPath = path.resolve(path.join(QMD_DIR, qmd));
  if (!qmdPath.startsWith(QMD_DIR) || !fs.existsSync(qmdPath))
    return res.status(404).json({ error: 'QMD file not found' });
  try {
    return res.json(getSubstitutionMap(qmdPath));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chapter-preview/render — return augmented chapter HTML ───────────
// Query: qmd=<filename>, selections=<JSON { figStem: { experiment, model } }>
app.get('/api/chapter-preview/render', (req, res) => {
  const { qmd, selections } = req.query;
  if (!qmd) return res.status(400).json({ error: 'qmd param required' });
  const qmdPath = path.resolve(path.join(QMD_DIR, qmd));
  if (!qmdPath.startsWith(QMD_DIR) || !fs.existsSync(qmdPath))
    return res.status(404).json({ error: 'QMD file not found' });
  try {
    const figSelections = selections ? JSON.parse(selections) : {};
    const { html, substituted } = buildChapterHtml(qmdPath, figSelections);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    return res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ── GET /api/chapter-preview/figure-html — serve a generated figure HTML ──────
// (used by the iframes inside the chapter preview; proxied so CORS works)
app.get('/api/chapter-preview/figure-html', (req, res) => {
  const p = path.resolve(req.query.path || '');
  if (!p.startsWith(path.resolve(EXPERIMENTS_DIR)) || !fs.existsSync(p))
    return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/html');
  res.send(fs.readFileSync(p, 'utf-8'));
});

// ── POST /api/chapter-preview/save-override — save a wrapper edit ─────────────
// Body: { chapter, experiment, model, figStem, wrapperHtml }
app.post('/api/chapter-preview/save-override', (req, res) => {
  const { chapter, figStem, wrapperHtml } = req.body;
  if (!chapter || !figStem || !wrapperHtml)
    return res.status(400).json({ error: 'Missing required fields: chapter, figStem, wrapperHtml' });
  try {
    saveOverride(chapter, figStem, wrapperHtml);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chapter-preview/analyze-figure — VLM reasoning about a figure ──
// Body: { qmd, figStem, question?, resultId?, modelId? }
// Sends the figure thumbnail + surrounding chapter text to GPT-4o and returns
// a reasoned analysis of quality, zoom, correctness, and improvement suggestions.
app.post('/api/chapter-preview/analyze-figure', async (req, res) => {
  const { qmd, figStem, question, resultId, modelId } = req.body;
  if (!qmd || !figStem)
    return res.status(400).json({ error: 'qmd and figStem are required' });
  const qmdPath = path.resolve(path.join(QMD_DIR, qmd));
  if (!qmdPath.startsWith(QMD_DIR) || !fs.existsSync(qmdPath))
    return res.status(404).json({ error: 'QMD file not found' });
  try {
    const result = await analyzeChapterFigure(qmdPath, figStem, { resultId, question, modelId });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chapter-preview/ai-edit — LLM chapter editor ───────────────────
// Takes a screenshot of the current render + the wrapper HTML for one figure,
// asks the LLM to improve the embed (zoom, height, hide UI panels, etc.),
// returns the revised wrapper HTML. Does NOT auto-save (UI confirms first).
app.post('/api/chapter-preview/ai-edit', async (req, res) => {
  const { figStem, currentWrapperHtml, htmlPath, width, screenshotBase64, modelId, notes } = req.body;
  if (!figStem || !htmlPath) return res.status(400).json({ error: 'figStem and htmlPath required' });

  // Read the figure HTML so the LLM can inspect it
  const absHtml = path.resolve(htmlPath);
  if (!fs.existsSync(absHtml)) return res.status(404).json({ error: 'Figure HTML not found' });
  const figHtml = fs.readFileSync(absHtml, 'utf-8');

  const wrapper = currentWrapperHtml || defaultWrapper(htmlPath, width || '100%');

  const systemPrompt = `You are a chapter integration editor for an interactive textbook.
Your job is to produce a revised HTML wrapper <div> that embeds an interactive figure (served as an iframe)
so it looks polished inside a chapter page.

You can modify:
- The iframe height (default 480px)
- The div margin, border, border-radius, background
- Add a transform:scale() on the iframe to zoom in/out if the figure has too much empty space
  (use: iframe { transform: scale(0.85); transform-origin: top left; width: calc(100%/0.85); height: calc(560px/0.85); })
- Hide distracting UI panels by injecting a <style> block into the iframe via srcdoc or postMessage
  (preferred: wrap the iframe src in a data URI that loads it and overrides CSS)

IMPORTANT RULES:
- The iframe src attribute MUST remain exactly: /api/chapter-preview/figure-html?path=<original-encoded-path>
  Do NOT change the src path.
- Output ONLY the replacement wrapper HTML snippet (the outer <div> and everything inside, including the caption <p> if present).
- Do NOT include <!DOCTYPE>, <html>, <head>, or <body> tags.
- Do NOT include any explanation — just the HTML.`;

  const userContent = [
    ...(screenshotBase64 ? [{
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
    }] : []),
    {
      type: 'text',
      text: `Figure name: ${figStem}
Desired width in chapter: ${width || '100%'}
${notes ? `Editor notes: ${notes}\n` : ''}
Current wrapper HTML:
\`\`\`html
${wrapper}
\`\`\`

Figure source HTML (first 6000 chars):
\`\`\`html
${figHtml.slice(0, 6000)}
\`\`\`

Please produce an improved wrapper that makes this figure look great in the chapter context.`,
    },
  ];

  try {
    const llmModel = modelId || 'gpt-4o';
    const result = await genModel(llmModel, {
      systemPrompt,
      userContent,
      maxTokens: 1200,
    });
    return res.json({ wrapperHtml: result.trim() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Serve React build in production ───────────────────────────────────────────
const frontendBuild = path.join(__dirname, '..', 'frontend', 'build');
if (fs.existsSync(frontendBuild)) {
  app.use(express.static(frontendBuild));
  app.get('*', (req, res) => res.sendFile(path.join(frontendBuild, 'index.html')));
  console.log('Serving React build from', frontendBuild);
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
