require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { screenshotHtml, loadBaseScaffold } = require('./runtime-helpers');
const { generateFigureHtml } = require('./generation');
const {
  buildExperimentContext,
  createResultRecord,
  evaluateRecord,
  saveRecord,
} = require('./figure_pipeline');
const { planForFigure, planChapter, PLANNER_MODEL } = require('./planner');
const { listChapters, list3dCandidates } = require('./chapter-discovery');
const { getAvailableModels } = require('./models');
const { upsertEvaluation, materializeEvaluationViews, compactEvaluationStorage, upsertAttempts } = require('./result_schema');
const { getCriticContext } = require('./critic');
const { runFigureLoop } = require('./figure_loop');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3001/')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const generationJobs = new Map();

// ── Paths ─────────────────────────────────────────────────────────────────────
const EXPERIMENTS_DIR = path.join(__dirname, '..', '..', 'prompt_experiments');
const FIGURES_DIR = path.join(__dirname, '..', '..', 'figures');

// ── API generation config ──────────────────────────────────────────────────────
// CURRENT_EXPERIMENT is derived from the configured experiment base.
// Change EXPERIMENT_BASE to move future generations into a new experiment bucket.
const EXPERIMENT_BASE = 'default_base';   // human-readable prefix
const CURRENT_MODEL = 'gpt-5.5';             // model used by the generator
const CURRENT_CRITIC_MODEL = 'gpt-4o';       // model used by evaluator by default
// CURRENT_EXPERIMENT is set below, after the system prompt is built.

// ── Few-shot config — set each to false to ablate that component's examples ──
const FEW_SHOT = { planner: false, critic: false, orchestrator: false };

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));
app.use(express.json({ limit: '20mb' }));

// ── OpenAI client (imported from models.js for evaluator / planner) ──

// ── Base scaffold ─────────────────────────────────────────────────────────────
// The model extends this file instead of writing from scratch.
// It provides: renderer, scene, orthographic camera, OrbitControls,
// floating label system (addLabel), resize handler, Reset View button, CSS.
// Edit backend/base_scene_new.html to change the starting point for all generations.
let BASE_SCAFFOLD_PATH;
let BASE_SCAFFOLD;
try {
  const loaded = loadBaseScaffold(__dirname);
  BASE_SCAFFOLD_PATH = loaded.scaffoldPath;
  BASE_SCAFFOLD = loaded.scaffold;
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log('Base scaffold loaded:', BASE_SCAFFOLD_PATH);

// ── Results folder ────────────────────────────────────────────────────────────
const RESULTS_DIR = process.env.RESULTS_DIR
  ? path.resolve(process.env.RESULTS_DIR)
  : path.join(__dirname, 'results');
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

const {
  systemPrompt: SYSTEM_PROMPT,
  experiment: CURRENT_EXPERIMENT,
} = buildExperimentContext(BASE_SCAFFOLD, EXPERIMENT_BASE);
const {
  criticVersion: CURRENT_CRITIC_VERSION,
} = getCriticContext();
console.log(`Experiment: ${CURRENT_EXPERIMENT}  (model: ${CURRENT_MODEL})`);

// ── Helper: generate a simple unique id ───────────────────────────────────────
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── GET /api/prompt — return the current system prompt for UI display ──────────
app.get('/api/prompt', (req, res) => {
  res.json({
    prompt: SYSTEM_PROMPT,
    experiment: CURRENT_EXPERIMENT,
    model: CURRENT_MODEL,
    criticModel: CURRENT_CRITIC_MODEL,
    plannerModel: PLANNER_MODEL,
    criticVersion: CURRENT_CRITIC_VERSION,
  });
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
  const { filename, chapterHint, base64, mediaType, plannerModel } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename is required.' });

  const stem = filename.replace(/\.[^.]+$/, '');
  const chapter = chapterHint || null;
  const imageData = base64 && mediaType ? { base64, mediaType } : undefined;

  try {
    const plan = await planForFigure(stem, chapter, imageData, plannerModel);
    return res.json(plan);
  } catch (err) {
    console.error('Plan error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Planning failed.' });
  }
});

// ── POST /api/plan-chapter — plan all 3D candidates in a chapter ─────────────
app.post('/api/plan-chapter', async (req, res) => {
  const { chapter, plannerModel } = req.body;
  if (!chapter) return res.status(400).json({ error: 'chapter is required.' });

  try {
    const plans = await planChapter(chapter, {}, plannerModel);
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

function resolveCriticPasses(rawValue) {
  if (rawValue == null || rawValue === '') return 1;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
    const err = new Error('criticPasses must be an integer between 0 and 3.');
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

function resolveCriticPassesFromBody(body) {
  const value = body?.criticPasses ?? body?.passes;
  return resolveCriticPasses(value);
}

async function generateFigure({ base64, mediaType, filename, plan, model: requestedModel, evalModel: requestedEvalModel, criticVersion: requestedCriticVersion, experiment: requestedExperiment, evaluate = true, criticPasses: requestedCriticPasses, passes: requestedPasses }) {
  if (!base64 || !mediaType || !filename) {
    const err = new Error('base64, mediaType, and filename are required.');
    err.statusCode = 400;
    throw err;
  }

  if (typeof requestedCriticVersion !== 'string' || !requestedCriticVersion.trim()) {
    const err = new Error('criticVersion is required.');
    err.statusCode = 400;
    throw err;
  }

  if (typeof requestedExperiment !== 'string' || !requestedExperiment.trim()) {
    const err = new Error('experiment is required.');
    err.statusCode = 400;
    throw err;
  }

  const modelId = requestedModel || CURRENT_MODEL;
  const experimentName = requestedExperiment.trim();
  const resolvedCriticPasses = resolveCriticPasses(requestedCriticPasses ?? requestedPasses);
  if (!requestedModel) {
    console.warn(`[generate] no model provided by client; falling back to default "${CURRENT_MODEL}"`);
  }
  console.log(`[generate] requested="${requestedModel}" experiment="${requestedExperiment}" → using="${modelId}" | file=${filename}`);

  const html = await withRetry(() => generateFigureHtml({
    modelId,
    scaffold: BASE_SCAFFOLD,
    mediaType,
    base64,
    plan,
    maxTokens: 16384,
    applyFixes: true,
  }));

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

  const record = createResultRecord({
    id: figureId,
    filename,
    html,
    timestamp,
    source: 'api',
    model: modelId,
    experiment: experimentName,
    plan: plan || null,
    previewBase64: shot ? shot.data : null,
    previewMediaType: shot ? shot.mediaType : null,
    fallbackBase64: base64,
    fallbackMediaType: mediaType || 'image/png',
    sourceBase64: base64,
    sourceMediaType: mediaType,
  });
  const recordPath = path.join(RESULTS_DIR, `${figureId}.json`);
  saveRecord(record, recordPath);
  refreshHistoryManifestSafe();

  let evaluation = null;
  if (evaluate !== false) {
    if (resolvedCriticPasses > 0) {
      try {
        const evaluationResult = await runEvaluation(record, recordPath, requestedEvalModel, requestedCriticVersion, resolvedCriticPasses);
        evaluation = evaluationResult.evaluation;
        console.log(`Auto-eval for ${figureId}: overall=${evaluation.overall_average} (passes=${evaluationResult.passCount})`);
      } catch (evalErr) {
        console.warn('Auto-eval failed (result saved without scores):', evalErr.message);
      }
    } else {
      console.log(`Auto-eval skipped for ${figureId}: criticPasses=0`);
    }
  }

  return {
    html,
    figureId,
    timestamp,
    model: modelId,
    experiment: experimentName,
    evaluationResults: record.evaluationResults || {},
    evaluationMeta: record.evaluationMeta || {},
    evaluationVersions: record.evaluationVersions || {},
    criticPasses: resolvedCriticPasses,
    plan: plan || null,
  };
}

/**
 * Generate figure using auto-iterative loop
 * Runs plan → generate → critique → decide cycle, saving all iterations
 */
async function generateFigureWithLoop({ base64, mediaType, filename, figureStem, chapterName, model: requestedModel, plannerModel: requestedPlannerModel, evalModel: requestedEvalModel, criticVersion: requestedCriticVersion, experiment: requestedExperiment, maxAttempts = 3 }) {
  const resolvedFigureStem = figureStem || (filename ? path.parse(filename).name : null);

  if (!base64 || !mediaType || !filename || !resolvedFigureStem) {
    const err = new Error('base64, mediaType, filename, and figureStem are required.');
    err.statusCode = 400;
    throw err;
  }

  if (typeof requestedCriticVersion !== 'string' || !requestedCriticVersion.trim()) {
    const err = new Error('criticVersion is required.');
    err.statusCode = 400;
    throw err;
  }

  if (typeof requestedExperiment !== 'string' || !requestedExperiment.trim()) {
    const err = new Error('experiment is required.');
    err.statusCode = 400;
    throw err;
  }

  const modelId = requestedModel || CURRENT_MODEL;
  const plannerModelId = requestedPlannerModel || CURRENT_MODEL;
  const criticModelId = requestedEvalModel || CURRENT_CRITIC_MODEL;
  const experimentName = requestedExperiment.trim();

  if (!requestedModel) {
    console.warn(`[generate-loop] no model provided; falling back to default "${CURRENT_MODEL}"`);
  }
  console.log(`[generate-loop] figureStem="${resolvedFigureStem}" chapter="${chapterName || 'unknown'}" experiment="${experimentName}" maxAttempts=${maxAttempts}`);

  // Run the iterative loop
  const loopState = await runFigureLoop({
    figureStem: resolvedFigureStem,
    chapterName: chapterName || null,
    imageData: { base64, mediaType },
    scaffold: BASE_SCAFFOLD,
    sourceBase64: base64,
    sourceMediaType: mediaType,
    maxAttempts,
    passThreshold: 4.0,
    plannerModel: plannerModelId,
    generatorModel: modelId,
    criticModel: criticModelId,
    fewShot: FEW_SHOT,
  });

  if (loopState.status === 'failed_planning') {
    const err = new Error(`Failed to generate plan for ${resolvedFigureStem}`);
    err.statusCode = 502;
    throw err;
  }

  // Use best HTML from loop
  const html = loopState.currentHtml || '';
  if (!html.trimStart().startsWith('<')) {
    const err = new Error('Loop did not produce valid HTML output');
    err.statusCode = 502;
    throw err;
  }

  const figureId = makeId();
  const timestamp = new Date().toISOString();
  const shot = await screenshotHtml(html);

  // Create result record with attempts attached
  let record = createResultRecord({
    id: figureId,
    filename,
    html,
    timestamp,
    source: 'api',
    model: modelId,
    experiment: experimentName,
    plan: loopState.currentPlan || null,
    previewBase64: shot ? shot.data : null,
    previewMediaType: shot ? shot.mediaType : null,
    fallbackBase64: base64,
    fallbackMediaType: mediaType || 'image/png',
    sourceBase64: base64,
    sourceMediaType: mediaType,
  });

  // Attach loop iteration history
  record = upsertAttempts(record, loopState.attempts);

  // Attach best evaluation if available
  if (loopState.currentEvaluation) {
    record = upsertEvaluation(record, criticModelId, loopState.currentEvaluation, timestamp, {
      criticVersion: requestedCriticVersion,
      criticModel: criticModelId,
    });
  }

  const recordPath = path.join(RESULTS_DIR, `${figureId}.json`);
  saveRecord(record, recordPath);
  refreshHistoryManifestSafe();

  return {
    html,
    figureId,
    timestamp,
    model: modelId,
    experiment: experimentName,
    loopStatus: loopState.status,
    attempts: loopState.attempts.length,
    bestScore: loopState.bestScore,
    plan: loopState.currentPlan || null,
    evaluationResults: record.evaluationResults || {},
    evaluationMeta: record.evaluationMeta || {},
    evaluationVersions: record.evaluationVersions || {},
  };
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

// ── POST /api/generate-loop-async ────────────────────────────────────────────
// Runs iterative figure generation with full loop (plan → generate → critique → decide)
// Returns jobId immediately; results include full attempts array with all iterations
app.post('/api/generate-loop-async', (req, res) => {
  const jobId = makeId();
  generationJobs.set(jobId, {
    id: jobId,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  generateFigureWithLoop(req.body)
    .then((result) => {
      updateGenerationJob(jobId, { status: 'done', result });
    })
    .catch((err) => {
      updateGenerationJob(jobId, {
        status: 'error',
        error: err?.message || 'Loop generation failed.',
        ...(err?.raw ? { raw: err.raw } : {}),
      });
    });

  return res.status(202).json({ jobId });
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

function readHistoryRecord(fileName, { includeThumb = false } = {}) {
  const raw = fs.readFileSync(path.join(RESULTS_DIR, fileName), 'utf-8');
  const parsed = materializeEvaluationViews(JSON.parse(raw));
  const stem = parsed.filename ? parsed.filename.replace(/\.[^.]+$/, '') : '';
  const chapter = inferChapter(stem);
  const model = parsed.model || 'gpt-4o';
  const experiment = parsed.experiment || 'base_scene_robust';
  const record = {
    id: parsed.id,
    filename: parsed.filename,
    timestamp: parsed.timestamp,
    source: parsed.source || 'api',
    model,
    experiment,
    evaluationResults: parsed.evaluationResults || {},
    evaluationMeta: parsed.evaluationMeta || {},
    evaluationVersions: parsed.evaluationVersions || {},
    chapter,
    // Number of loop iterations/attempts saved for this result (0 when not applicable)
    iterations: Array.isArray(parsed.attempts) ? parsed.attempts.length : 0,
  };

  if (includeThumb) {
    record.base64thumb = parsed.base64thumb || null;
    record.mediaType = parsed.mediaType || 'image/jpeg';
  }

  return record;
}

function listHistoryRecords({ includeThumb = false } = {}) {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  return files
    .map((f) => {
      try {
        return readHistoryRecord(f, { includeThumb });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function listHistoryIndexFromManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    if (!Array.isArray(parsed?.results)) return null;
    return parsed.results
      .map((record) => ({
        id: record?.id,
        filename: record?.filename,
        timestamp: record?.timestamp,
        source: record?.source || 'api',
        model: record?.model || 'gpt-4o',
        experiment: record?.experiment || 'base_scene_robust',
        evaluationResults: record?.evaluationResults || {},
        evaluationMeta: record?.evaluationMeta || {},
        evaluationVersions: record?.evaluationVersions || {},
        chapter: record?.chapter || null,
        // Prefer explicit iterations property on manifest entry, otherwise fall back to attempts array length
        iterations: typeof record?.iterations === 'number' ? record.iterations : (Array.isArray(record?.attempts) ? record.attempts.length : 0),
      }))
      .filter(record => record.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch {
    return null;
  }
}

function rebuildHistoryManifest() {
  const results = listHistoryRecords({ includeThumb: false });

  const experimentSet = new Set(results.map(r => r.experiment || 'base_scene_robust'));
  const modelSet = new Set(results.map(r => r.model || 'gpt-4o'));
  const chapterSet = new Set(results.map(r => r.chapter).filter(Boolean));

  let experimentFigureCount = 0;
  try {
    const experiments = scanExperiments();
    experimentFigureCount = experiments.reduce(
      (sum, exp) => sum + (exp.models || []).reduce((mSum, model) => mSum + (model.figures || []).length, 0),
      0
    );
    for (const exp of experiments) {
      for (const model of exp.models || []) {
        modelSet.add(model.model || 'unknown');
        for (const fig of model.figures || []) {
          if (fig.chapter) chapterSet.add(fig.chapter);
        }
      }
    }
  } catch {
    // Keep manifest generation resilient if experiment scan fails.
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      resultCount: results.length,
      experimentCount: experimentSet.size,
      experimentFigureCount,
      modelCount: modelSet.size,
      chapterCount: chapterSet.size,
    },
    results,
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

function refreshHistoryManifestSafe() {
  try {
    rebuildHistoryManifest();
  } catch (err) {
    console.warn('Manifest refresh failed:', err?.message || err);
  }
}

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  try {
    const includeThumb = req.query.includeThumb === '1';
    return res.json(listHistoryRecords({ includeThumb }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/history-index ───────────────────────────────────────────────────
// Lightweight history list for the Results page. Intentionally excludes
// inline thumbnail base64 to keep payload small.
app.get('/api/history-index', (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    if (refresh || !fs.existsSync(MANIFEST_PATH)) {
      rebuildHistoryManifest();
    }

    const manifestRecords = listHistoryIndexFromManifest();
    if (manifestRecords) return res.json(manifestRecords);

    // If manifest exists but is malformed, rebuild and return fresh snapshot.
    const manifest = rebuildHistoryManifest();
    return res.json(manifest.results || []);
  } catch (err) {
    try {
      const liveRecords = listHistoryRecords({ includeThumb: false });
      return res.json(liveRecords);
    } catch {
      // Fall through to original error response below.
    }
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
    const record = materializeEvaluationViews(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
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
    evaluationResults: {},
    evaluationMeta: {},
    evaluationVersions: {},
  };
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${id}.json`),
    JSON.stringify(compactEvaluationStorage(record), null, 2)
  );
  refreshHistoryManifestSafe();
  return res.json({ id, timestamp });
});

// Calls the shared evaluator, persists to the record file,
// and returns the evaluation object. Throws on error.
async function runEvaluation(record, filePath, requestedEvalModel, requestedCriticVersion, criticPasses = 1) {
  const result = await evaluateRecord({
    record,
    evalModel: requestedEvalModel,
    defaultEvalModel: CURRENT_CRITIC_MODEL,
    criticVersionOverride: requestedCriticVersion,
    criticPasses,
  });
  if (!result.skipped && filePath) {
    saveRecord(result.record, filePath);
    refreshHistoryManifestSafe();
  }

  if (!result.skipped) {
    record.evaluationResults = result.record.evaluationResults;
    record.evaluationMeta = result.record.evaluationMeta;
    record.evaluationVersions = result.record.evaluationVersions;
  }

  return result;
}

const HUMAN_SCORE_KEYS = [
  'geometry_accuracy',
  'interactivity_usability',
  'faithfulness',
  'label_quality',
  'concept_accuracy',
];

function normalizeHumanRaterId(rawRaterId) {
  const fallback = 'anonymous';
  if (typeof rawRaterId !== 'string' || !rawRaterId.trim()) return fallback;
  const cleaned = rawRaterId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned || fallback;
}

function toHumanScore(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be a number from 1 to 5.`);
  }
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) {
    throw new Error(`${key} must be between 1 and 5.`);
  }
  return rounded;
}

function normalizeHumanEvaluation(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('evaluation object is required.');
  }

  const normalized = {};
  for (const key of HUMAN_SCORE_KEYS) {
    normalized[key] = toHumanScore(input[key], key);
  }

  const failureModes = Array.isArray(input.failure_modes)
    ? input.failure_modes
      .map(mode => (typeof mode === 'string' ? mode.trim() : ''))
      .filter(Boolean)
      .slice(0, 20)
    : [];
  normalized.failure_modes = Array.from(new Set(failureModes));

  normalized.notes = typeof input.notes === 'string'
    ? input.notes.trim().slice(0, 2000)
    : '';

  normalized.visual_aesthetics = Math.round(
    ((normalized.geometry_accuracy + normalized.faithfulness + normalized.label_quality) / 3) * 10
  ) / 10;
  normalized.overall_average = Math.round(
    (HUMAN_SCORE_KEYS.reduce((sum, key) => sum + normalized[key], 0) / HUMAN_SCORE_KEYS.length) * 10
  ) / 10;

  return normalized;
}

// ── POST /api/evaluate-human ─────────────────────────────────────────────────
// Persist a manual/human evaluation into the same versioned schema used by AI.
app.post('/api/evaluate-human', (req, res) => {
  const { id, htmlPath, raterId, criticVersion, evaluation } = req.body || {};
  if (!id && !htmlPath) {
    return res.status(400).json({ error: 'id or htmlPath is required.' });
  }

  let normalizedEvaluation;
  try {
    normalizedEvaluation = normalizeHumanEvaluation(evaluation);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid evaluation payload.' });
  }

  const resolvedRater = normalizeHumanRaterId(raterId);
  const evalModel = `human:${resolvedRater}`;
  const resolvedCriticVersion =
    typeof criticVersion === 'string' && criticVersion.trim()
      ? criticVersion.trim()
      : 'human_v1';
  const evaluatedAt = new Date().toISOString();

  if (id) {
    const filePath = path.join(RESULTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Result not found.' });
    }

    let record;
    try {
      record = materializeEvaluationViews(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch {
      return res.status(500).json({ error: 'Failed to read result file.' });
    }

    try {
      const updated = upsertEvaluation(record, evalModel, normalizedEvaluation, evaluatedAt, {
        criticVersion: resolvedCriticVersion,
        criticModel: evalModel,
      });
      saveRecord(updated, filePath);
      refreshHistoryManifestSafe();
      return res.json({
        evaluation: normalizedEvaluation,
        evalModel,
        criticVersion: resolvedCriticVersion,
        evaluationResults: updated.evaluationResults || {},
        evaluationMeta: updated.evaluationMeta || {},
        evaluationVersions: updated.evaluationVersions || {},
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to save human evaluation.' });
    }
  }

  const absHtml = path.resolve(htmlPath);
  if (!fs.existsSync(absHtml)) {
    return res.status(404).json({ error: 'HTML file not found.' });
  }

  try {
    const evalPath = absHtml.replace(/\.html$/, '.eval.json');
    let cached = {};
    if (fs.existsSync(evalPath)) {
      try {
        cached = materializeEvaluationViews(JSON.parse(fs.readFileSync(evalPath, 'utf-8')));
      } catch {
        cached = {};
      }
    }

    const updatedCache = upsertEvaluation(cached, evalModel, normalizedEvaluation, evaluatedAt, {
      criticVersion: resolvedCriticVersion,
      criticModel: evalModel,
    });
    saveRecord({
      evaluationResults: updatedCache.evaluationResults,
      evaluationMeta: updatedCache.evaluationMeta,
      evaluationVersions: updatedCache.evaluationVersions,
    }, evalPath);

    return res.json({
      evaluation: normalizedEvaluation,
      evalModel,
      criticVersion: resolvedCriticVersion,
      evaluationResults: updatedCache.evaluationResults || {},
      evaluationMeta: updatedCache.evaluationMeta || {},
      evaluationVersions: updatedCache.evaluationVersions || {},
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Failed to save human evaluation.' });
  }
});

// ── POST /api/evaluate ────────────────────────────────────────────────────────
// Manual re-evaluation endpoint (used for existing results without scores).
app.post('/api/evaluate', async (req, res) => {
  const { id, evalModel, criticVersion } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required.' });

  let criticPasses;
  try {
    criticPasses = resolveCriticPassesFromBody(req.body);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  const filePath = path.join(RESULTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Result not found.' });

  let record;
  try { record = materializeEvaluationViews(JSON.parse(fs.readFileSync(filePath, 'utf-8'))); }
  catch { return res.status(500).json({ error: 'Failed to read result file.' }); }

  try {
    const result = await runEvaluation(record, filePath, evalModel, criticVersion, criticPasses);
    if (result.skipped) {
      return res.json({ skipped: true, criticPasses: 0 });
    }
    return res.json({ ...result.evaluation, criticPasses: result.passCount });
  } catch (err) {
    console.error('Evaluation error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Unknown error during evaluation.' });
  }
});

// ── POST /api/evaluate-batch ──────────────────────────────────────────────────
// Accepts { ids: string[] } and evaluates them one-by-one (no concurrency).
// Returns results as they complete via streaming JSON lines.
app.post('/api/evaluate-batch', async (req, res) => {
  const { ids, evalModel, criticVersion } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids (array) is required.' });
  }

  let criticPasses;
  try {
    criticPasses = resolveCriticPassesFromBody(req.body);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
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
    try { record = materializeEvaluationViews(JSON.parse(fs.readFileSync(filePath, 'utf-8'))); }
    catch { res.write(JSON.stringify({ id, status: 'error', error: 'Failed to read result.' }) + '\n'); continue; }

    try {
      const result = await runEvaluation(record, filePath, evalModel, criticVersion, criticPasses);
      if (result.skipped) {
        res.write(JSON.stringify({ id, status: 'skipped', criticPasses: 0 }) + '\n');
      } else {
        res.write(JSON.stringify({ id, status: 'ok', evaluation: result.evaluation, criticPasses: result.passCount }) + '\n');
      }
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
    refreshHistoryManifestSafe();
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
  try {
    const parsed = materializeEvaluationViews(JSON.parse(fs.readFileSync(evalPath, 'utf-8')));
    return {
      evaluationResults: parsed.evaluationResults || {},
      evaluationMeta: parsed.evaluationMeta || {},
      evaluationVersions: parsed.evaluationVersions || {},
    };
  } catch {
    return null;
  }
}

// ── GET /api/experiments ──────────────────────────────────────────────────────
app.get('/api/experiments', (req, res) => {
  try {
    const tree = scanExperiments();
    // Attach cached evaluations
    for (const exp of tree) {
      for (const m of exp.models) {
        for (const fig of m.figures) {
          const evalData = loadExpEval(fig.htmlPath);
          fig.evaluationResults = evalData?.evaluationResults || {};
          fig.evaluationMeta = evalData?.evaluationMeta || {};
          fig.evaluationVersions = evalData?.evaluationVersions || {};
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
  const { htmlPath, imagePath, evalModel, criticVersion } = req.body;
  if (!htmlPath) return res.status(400).json({ error: 'htmlPath required.' });

  let criticPasses;
  try {
    criticPasses = resolveCriticPassesFromBody(req.body);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  const absHtml = path.resolve(htmlPath);
  if (!fs.existsSync(absHtml)) return res.status(404).json({ error: 'HTML file not found.' });

  const html = fs.readFileSync(absHtml, 'utf-8');
  let base64thumb = null;
  if (imagePath) {
    const absImg = path.resolve(imagePath);
    if (fs.existsSync(absImg)) base64thumb = fs.readFileSync(absImg).toString('base64');
  }

  try {
    const usedEvalModel = evalModel || CURRENT_CRITIC_MODEL;
    const { evaluation, criticVersion: resolvedCriticVersion, skipped, passCount } = await evaluateRecord({
      record: {
        html,
        source_base64: base64thumb,
        source_media_type: 'image/png',
      },
      evalModel: usedEvalModel,
      defaultEvalModel: CURRENT_CRITIC_MODEL,
      criticVersionOverride: criticVersion,
      criticPasses,
    });

    if (skipped) {
      return res.json({ skipped: true, criticPasses: 0 });
    }

    // Cache alongside the HTML file
    const evalPath = absHtml.replace(/\.html$/, '.eval.json');
    let cached = {};
    if (fs.existsSync(evalPath)) {
      try { cached = materializeEvaluationViews(JSON.parse(fs.readFileSync(evalPath, 'utf-8'))); } catch { cached = {}; }
    }
    const updatedCache = upsertEvaluation(cached, usedEvalModel, evaluation, new Date().toISOString(), {
      criticVersion: resolvedCriticVersion,
      criticModel: usedEvalModel,
    });
    saveRecord({
      evaluationResults: updatedCache.evaluationResults,
      evaluationMeta: updatedCache.evaluationMeta,
      evaluationVersions: updatedCache.evaluationVersions,
    }, evalPath);

    return res.json({ ...evaluation, criticPasses: passCount });
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
  console.log(`Backend running on port ${PORT}`);
  console.log('Results directory:', RESULTS_DIR);
});
