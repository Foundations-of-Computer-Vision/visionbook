require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').default;

const app = express();
const PORT = 3001;

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

    // Save result to disk
    const record = {
      id: figureId,
      filename,
      base64thumb: base64,
      html,
      timestamp,
      source: 'api',
    };
    fs.writeFileSync(
      path.join(RESULTS_DIR, `${figureId}.json`),
      JSON.stringify(record, null, 2)
    );

    return res.json({ html, figureId, timestamp });
  } catch (err) {
    console.error('OpenAI error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Unknown error from OpenAI.' });
  }
});

// ── GET /api/history ──────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
    const records = files
      .map((f) => {
        try {
          const raw = fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8');
          const { id, filename, base64thumb, timestamp, source } = JSON.parse(raw);
          return { id, filename, base64thumb, timestamp, source: source || 'api' };
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
  };
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${id}.json`),
    JSON.stringify(record, null, 2)
  );
  return res.json({ id, timestamp });
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

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
