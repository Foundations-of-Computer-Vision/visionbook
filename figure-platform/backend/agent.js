#!/usr/bin/env node
/**
 * figure-agent — generator → evaluator loop
 *
 * Processes one image or a whole directory, saving results to backend/results/
 * so the web platform picks them up automatically.
 *
 * Usage:
 *   node agent.js --image ../../figures/imaging/pinhole.png
 *   node agent.js --dir   ../../figures/homography  --ext png,jpg
 *   node agent.js --image ../../figures/imaging/pinhole.png --rounds 3 --threshold 3.5
 *
 * Options:
 *   --image <path>       single image to process
 *   --dir   <path>       directory of images (processes all matching --ext)
 *   --ext   <list>       comma-separated extensions to match (default: png,jpg,jpeg)
 *   --rounds <n>         max generator-evaluator rounds (default: 1)
 *   --threshold <score>  stop refining when overall_average >= this (default: 4.0)
 *   --model <name>       generator model (default: gpt-4o)
 *   --eval-model <name>  evaluator model (default: gpt-5.4)
 *   --experiment <label> experiment label written to result (default: agent-v1)
 *   --screenshot         take a Puppeteer screenshot after generation (default: true)
 *   --no-screenshot      skip screenshots (faster)
 *   --dry-run            print what would be processed without calling the API
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const OpenAI  = require('openai').default;
const puppeteer = require('puppeteer');

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
function hasFlag(name) { return args.includes(name); }

const IMAGE_PATH   = flag('--image');
const DIR_PATH     = flag('--dir');
const EXTS         = (flag('--ext') || 'png,jpg,jpeg').split(',').map(e => e.toLowerCase().replace(/^\./, ''));
const MAX_ROUNDS   = parseInt(flag('--rounds')    || '1',   10);
const THRESHOLD    = parseFloat(flag('--threshold') || '4.0');
const GEN_MODEL    = flag('--model')       || 'gpt-4o';
const EVAL_MODEL   = flag('--eval-model')  || 'gpt-5.4';
const EXPERIMENT   = flag('--experiment')  || 'agent-v1';
const DO_SCREENSHOT = !hasFlag('--no-screenshot');
const DRY_RUN      = hasFlag('--dry-run');

if (!IMAGE_PATH && !DIR_PATH) {
  console.error('Usage: node agent.js --image <path>  OR  --dir <path>');
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────────────
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const BASE_SCAFFOLD_PATH = path.join(__dirname, 'base_scene_robust.html');
if (!fs.existsSync(BASE_SCAFFOLD_PATH)) {
  console.error('ERROR: base_scene_robust.html not found in backend/.');
  process.exit(1);
}
const BASE_SCAFFOLD = fs.readFileSync(BASE_SCAFFOLD_PATH, 'utf-8');

// ── OpenAI ─────────────────────────────────────────────────────────────────────
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === 'your_openai_api_key_here') throw new Error('OPENAI_API_KEY not set in backend/.env');
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

// ── Puppeteer ──────────────────────────────────────────────────────────────────
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
    console.warn('  Screenshot failed:', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── System prompt ──────────────────────────────────────────────────────────────
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
  • Add brief JS comments explaining what what each block of code teaches.
  • Prefer conceptual clarity over visual realism.`;
}
const SYSTEM_PROMPT = buildSystemPrompt(BASE_SCAFFOLD);

// ── Refinement prompt (used in round 2+) ─────────────────────────────────────
function buildRefinementPrompt(scaffold, prevHtml, evaluation) {
  const issues = [
    ...(evaluation.failure_modes || []).map(m => `• ${m}`),
    `• geometry_accuracy: ${evaluation.geometry_accuracy}/5`,
    `• interactivity_usability: ${evaluation.interactivity_usability}/5`,
    `• faithfulness: ${evaluation.faithfulness}/5`,
    `• label_quality: ${evaluation.label_quality}/5`,
    `• concept_accuracy: ${evaluation.concept_accuracy}/5`,
    `• notes: ${evaluation.notes || ''}`,
  ].join('\n');

  return `You are an expert Three.js developer improving a previous attempt based on critic feedback.

OUTPUT RULES — non-negotiable:
• Your response MUST be ONLY a complete HTML file. No explanation, no markdown, no code fences.
• It MUST start with exactly: <!DOCTYPE html>
• It MUST end with exactly: </html>
• Do NOT truncate. Output every line.

The BASE SCAFFOLD must still be used as the foundation:
${scaffold}

CRITIC FEEDBACK ON PREVIOUS ATTEMPT:
${issues}

PREVIOUS HTML (improve this, do not start from scratch unless it is fundamentally broken):
${prevHtml}

Fix all identified failure modes and improve every score. Maintain or improve what already works well.`;
}

// ── buildEvalPrompt + finaliseEval imported from critic.js ───────────────────

// ── Strip markdown fences ─────────────────────────────────────────────────────
function stripFences(text) {
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return text.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

// ── Unique id ──────────────────────────────────────────────────────────────────
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Core: process one image ────────────────────────────────────────────────────
async function processImage(imagePath) {
  const filename = path.basename(imagePath);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ ${filename}`);

  if (DRY_RUN) {
    console.log('  [dry-run] would process this image');
    return;
  }

  // Load image as base64
  const ext = path.extname(filename).toLowerCase().slice(1);
  const mediaTypeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const mediaType = mediaTypeMap[ext] || 'image/png';
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');

  let html = null;
  let evaluation = null;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    console.log(`  [round ${round}/${MAX_ROUNDS}] generating...`);

    // ── GENERATOR ────────────────────────────────────────────────────────────
    const genMessages = round === 1
      ? [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
              { type: 'text', text: 'Analyse this figure carefully. Then output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.' },
            ],
          },
        ]
      : [
          { role: 'system', content: buildRefinementPrompt(BASE_SCAFFOLD, html, evaluation) },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
              { type: 'text', text: 'Here is the same original figure. Apply the critic feedback and output the improved complete HTML file. No explanation, no markdown, no fences.' },
            ],
          },
        ];

    const genResp = await getOpenAI().chat.completions.create({
      model: GEN_MODEL,
      max_tokens: 16384,
      messages: genMessages,
    });

    html = stripFences(genResp.choices[0].message.content || '');

    if (!html.trimStart().startsWith('<')) {
      console.error(`  ✗ Generator did not return HTML (round ${round}). Aborting.`);
      console.error('  Raw:', html.slice(0, 200));
      return;
    }
    console.log(`  ✓ HTML generated (${html.length} chars)`);

    // ── EVALUATOR ─────────────────────────────────────────────────────────────
    console.log(`  [round ${round}/${MAX_ROUNDS}] evaluating...`);
    const evalResp = await getOpenAI().chat.completions.create({
      model: EVAL_MODEL,
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: buildEvalPrompt() },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
            { type: 'text', text: `Here is the generated HTML code to evaluate:\n\n${html}\n\nOutput ONLY the JSON evaluation object.` },
          ],
        },
      ],
    });

    let evalContent = evalResp.choices[0].message.content || '';
    const fenced = evalContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) evalContent = fenced[1].trim();
    evalContent = evalContent.trim();

    try {
      evaluation = finaliseEval(JSON.parse(evalContent));
    } catch {
      console.warn(`  ✗ Evaluator returned invalid JSON (round ${round}). Skipping eval.`);
      evaluation = null;
      break;
    }

    const overall = evaluation.overall_average;
    const modes = evaluation.failure_modes?.length ? evaluation.failure_modes.join(', ') : 'none';
    console.log(`  ✓ Score: ${overall}/5  |  Failures: ${modes}`);
    console.log(`     notes: ${evaluation.notes}`);

    // Stop if threshold met or no more rounds
    if (overall >= THRESHOLD || round >= MAX_ROUNDS) break;
    console.log(`  ↺ Score ${overall} < threshold ${THRESHOLD}, refining...`);
  }

  // ── SCREENSHOT ──────────────────────────────────────────────────────────────
  let thumb = null;
  if (DO_SCREENSHOT && html) {
    console.log('  [screenshot] rendering...');
    const shot = await screenshotHtml(html);
    if (shot) {
      thumb = shot;
      console.log('  ✓ Screenshot captured');
    }
  }

  // ── SAVE RESULT ─────────────────────────────────────────────────────────────
  const figureId = makeId();
  const record = {
    id:          figureId,
    filename,
    base64thumb: thumb ? thumb.data : imageBase64,
    mediaType:   thumb ? thumb.mediaType : mediaType,
    html,
    timestamp:   new Date().toISOString(),
    source:      'agent',
    model:       GEN_MODEL,
    eval_model:  EVAL_MODEL,
    experiment:  EXPERIMENT,
    rounds:      round,
    evaluation:  evaluation || null,
  };

  const outPath = path.join(RESULTS_DIR, `${figureId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`  ✓ Saved → results/${figureId}.json`);
}

// ── Collect images ─────────────────────────────────────────────────────────────
let imagePaths = [];

if (IMAGE_PATH) {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`Image not found: ${IMAGE_PATH}`);
    process.exit(1);
  }
  imagePaths = [path.resolve(IMAGE_PATH)];
} else if (DIR_PATH) {
  if (!fs.existsSync(DIR_PATH)) {
    console.error(`Directory not found: ${DIR_PATH}`);
    process.exit(1);
  }
  imagePaths = fs.readdirSync(DIR_PATH)
    .filter(f => EXTS.includes(path.extname(f).toLowerCase().slice(1)))
    .map(f => path.resolve(path.join(DIR_PATH, f)));
  if (imagePaths.length === 0) {
    console.error(`No images with extensions [${EXTS.join(', ')}] found in ${DIR_PATH}`);
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`figure-agent`);
  console.log(`  generator: ${GEN_MODEL}  |  evaluator: ${EVAL_MODEL}`);
  console.log(`  experiment: ${EXPERIMENT}  |  rounds: ${MAX_ROUNDS}  |  threshold: ${THRESHOLD}`);
  console.log(`  images: ${imagePaths.length}`);
  if (DRY_RUN) console.log('  mode: DRY RUN');

  for (const imgPath of imagePaths) {
    try {
      await processImage(imgPath);
    } catch (err) {
      console.error(`  ✗ Error processing ${path.basename(imgPath)}:`, err.message);
    }
  }

  if (_browser) await _browser.close().catch(() => {});
  console.log(`\n✓ Done — ${imagePaths.length} image(s) processed`);
  process.exit(0);
})();
