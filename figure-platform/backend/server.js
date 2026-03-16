require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').default;
const puppeteer = require('puppeteer');
const { buildEvalPrompt, finaliseEval } = require('./critic');

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
    if (page) await page.close().catch(() => {});
  }
}

const app = express();
const PORT = 3001;

// ── Paths ─────────────────────────────────────────────────────────────────────
const EXPERIMENTS_DIR    = path.join(__dirname, '..', '..', 'prompt_experiments');
const FIGURES_DIR        = path.join(__dirname, '..', '..', 'figures');

// ── API generation config (update when prompt or scaffold changes) ─────────────
const CURRENT_EXPERIMENT = 'base_scene_robust';  // experiment label for all API-generated figures
const CURRENT_MODEL      = 'gpt-4o';             // model used by the generator

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '20mb' }));

// ── OpenAI client (lazy – created on first request so missing key won't crash startup) ──
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === 'your_openai_api_key_here') {
      throw new Error('OPENAI_API_KEY is not set. Add it to backend/.env');
    }
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

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

────────────────────────────────────────────────────────────────────────────────
BASE SCAFFOLD — copy this file in full, then add your code inside the existing
<script type="module"> block, after the animate() call and resize handler.
Do NOT modify anything already in the scaffold.
────────────────────────────────────────────────────────────────────────────────
${scaffold}
────────────────────────────────────────────────────────────────────────────────

What the scaffold already provides (do NOT re-implement):
• THREE + OrbitControls via https://esm.sh/three
• Orthographic camera — tune: d (view half-size), camera.position, camera.zoom
• Damped OrbitControls render loop
• window resize handler keeping camera + renderer in sync
• White background, full-page #container div

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

STEP 3 · LABELS
  Add floating HTML labels using absolutely-positioned <div> elements.
  Project 3D positions to screen with vector.project(camera) in the animate loop.
  Use font-size 13px for main labels, 11px for minor annotations.
  Support HTML for maths: 'x<sub>1</sub>', '&lambda;', '<i>f</i>'.
  Offset labels slightly from their anchor to avoid overlapping geometry.

STEP 4 · INTERACTIVITY — add 2–5 controls in a fixed UI panel (position:absolute, top:10px, left:10px):
  • Step-through buttons — animate a process stage by stage
  • Parameter sliders    — let the user vary a quantity and see the effect
  • Toggle buttons       — show/hide elements
  • Animate button       — run a looping demonstration
  • Always include a Reset View button that restores the original camera position

STEP 5 · CODE STYLE
  • Add brief JS comments explaining what each block of code teaches.
  • Prefer conceptual clarity over visual realism.`;
}
const SYSTEM_PROMPT = buildSystemPrompt(BASE_SCAFFOLD);

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

// ── Helper: generate a simple unique id ───────────────────────────────────────
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── POST /api/generate ────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { base64, mediaType, filename } = req.body;

  if (!base64 || !mediaType || !filename) {
    return res.status(400).json({ error: 'base64, mediaType, and filename are required.' });
  }

  try {
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 16384,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${base64}` },
            },
            {
              type: 'text',
              text: 'Analyse this figure carefully. Then output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.',
            },
          ],
        },
      ],
    });

    let html = response.choices[0].message.content || '';
    html = stripFences(html);

    // If the model still refused to output HTML, surface a clear error
    if (!html.trimStart().startsWith('<')) {
      console.error('Model did not return HTML. Raw response:\n', html.slice(0, 500));
      return res.status(502).json({
        error: 'The model did not return a valid HTML file. Please try again.',
        raw: html.slice(0, 500),
      });
    }

    const figureId = makeId();
    const timestamp = new Date().toISOString();

    // Capture a screenshot of the generated figure as the thumbnail
    const shot = await screenshotHtml(html);

    // Save result to disk
    const record = {
      id: figureId,
      filename,
      base64thumb: shot ? shot.data : base64,        // thumbnail shown in UI (Puppeteer screenshot)
      mediaType: shot ? shot.mediaType : (mediaType || 'image/png'),
      source_base64: base64,                         // original input image — used by evaluator
      source_media_type: mediaType,
      html,
      timestamp,
      source: 'api',
      model: CURRENT_MODEL,
      experiment: CURRENT_EXPERIMENT,
    };
    const recordPath = path.join(RESULTS_DIR, `${figureId}.json`);
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

    // Auto-evaluate immediately after generation
    let evaluation = null;
    try {
      evaluation = await runEvaluation(record, recordPath);
      console.log(`Auto-eval for ${figureId}: overall=${evaluation.overall_average}`);
    } catch (evalErr) {
      console.warn('Auto-eval failed (result saved without scores):', evalErr.message);
    }

    return res.json({ html, figureId, timestamp, evaluation });
  } catch (err) {
    console.error('OpenAI error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Unknown error from OpenAI.' });
  }
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
    brdf:    'imaging',
  };
  if (KNOWN[stem.toLowerCase()]) return KNOWN[stem.toLowerCase()];

  let chapters;
  try { chapters = fs.readdirSync(FIGURES_DIR).filter(d => {
    try { return fs.statSync(path.join(FIGURES_DIR, d)).isDirectory(); } catch { return false; }
  }); } catch { return null; }

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
          const model = parsed.model || CURRENT_MODEL;
          const experiment = parsed.experiment || CURRENT_EXPERIMENT;
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
// Calls the evaluator model, finalises scores, persists to the record file,
// and returns the evaluation object. Throws on error.
async function runEvaluation(record, filePath) {
  const { html, source_base64, source_media_type, base64thumb } = record;
  if (!html) throw new Error('No HTML found for this result.');

  // Always evaluate against the original source image, not the generated screenshot
  const evalImage     = source_base64 || base64thumb;
  const evalMediaType = source_media_type || 'image/png';

  const userContent = [
    ...(evalImage
      ? [{ type: 'image_url', image_url: { url: `data:${evalMediaType};base64,${evalImage}` } }]
      : []),
    {
      type: 'text',
      text: `Here is the generated HTML code to evaluate:\n\n${html}\n\nOutput ONLY the JSON evaluation object.`,
    },
  ];

  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-5.4',
    max_completion_tokens: 512,
    messages: [
      { role: 'system', content: buildEvalPrompt() },
      { role: 'user', content: userContent },
    ],
  });

  let content = response.choices[0].message.content || '';
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();
  content = content.trim();

  let evaluation;
  try { evaluation = JSON.parse(content); }
  catch { throw new Error('Evaluator did not return valid JSON: ' + content.slice(0, 200)); }

  evaluation = finaliseEval(evaluation);

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

  // Reuse same evaluation prompt from /api/evaluate
  const evalSystemPrompt = buildEvalPrompt();

  try {
    const userContent = [
      ...(base64thumb ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64thumb}` } }] : []),
      { type: 'text', text: `Here is the generated HTML code to evaluate:\n\n${html}\n\nOutput ONLY the JSON evaluation object.` },
    ];

    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-5.4',
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: evalSystemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    let content = response.choices[0].message.content || '';
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) content = fenced[1].trim();
    content = content.trim();

    let evaluation;
    try { evaluation = JSON.parse(content); }
    catch { return res.status(502).json({ error: 'Model did not return valid JSON.', raw: content.slice(0, 300) }); }

    const scoreKeys = ['geometry_accuracy', 'interactivity_usability', 'faithfulness', 'label_quality', 'concept_accuracy'];
    for (const key of scoreKeys) evaluation[key] = Math.min(5, Math.max(1, Math.round(Number(evaluation[key]) || 3)));

    evaluation.visual_aesthetics = Math.round(((evaluation.geometry_accuracy + evaluation.faithfulness + evaluation.label_quality) / 3) * 10) / 10;
    evaluation.overall_average = Math.round(((evaluation.geometry_accuracy + evaluation.interactivity_usability + evaluation.faithfulness + evaluation.label_quality + evaluation.concept_accuracy) / 5) * 10) / 10;

    // Cache alongside the HTML file
    const evalPath = absHtml.replace(/\.html$/, '.eval.json');
    fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2));

    return res.json(evaluation);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Unknown error.' });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
