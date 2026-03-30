#!/usr/bin/env node
/**
 * figure-agent — planner → generator → evaluator loop
 *
 * Processes one image or a whole directory, saving results to backend/results/
 * so the web platform picks them up automatically.
 *
 * Usage:
 *   node agent.js --image ../../figures/imaging/pinhole.png
 *   node agent.js --dir   ../../figures/homography  --ext png,jpg
 *   node agent.js --image ../../figures/imaging/pinhole.png --rounds 3 --threshold 3.5
 *   node agent.js --image pinhole.png --chapter imaging
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
 *   --no-plan            skip the planner stage (generate from image alone)
 *   --chapter <name>     hint the chapter name for planner context extraction
 *   --dry-run            print what would be processed without calling the API
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { screenshotHtml, closeScreenshotBrowser, loadBaseScaffold } = require('./runtime-helpers');

const { evaluateHtmlWithCritic } = require('./critic');
const {
  generateFigureHtml,
  generateRefinedFigureHtml,
  buildGenerationSystemPrompt,
} = require('./generation');
const { planForFigure } = require('./planner');
const { inferChapterFromFilename } = require('./chapter-discovery');

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
function hasFlag(name) { return args.includes(name); }

const IMAGE_PATH = flag('--image');
const DIR_PATH = flag('--dir');
const EXTS = (flag('--ext') || 'png,jpg,jpeg').split(',').map(e => e.toLowerCase().replace(/^\./, ''));
const MAX_ROUNDS = parseInt(flag('--rounds') || '1', 10);
const THRESHOLD = parseFloat(flag('--threshold') || '4.0');
const GEN_MODEL = flag('--model') || 'gpt-5.4';
const EVAL_MODEL = flag('--eval-model') || 'gpt-5.4';
const EXPERIMENT_OVERRIDE = flag('--experiment');  // manual override, else auto-derived from prompt hash
const DO_SCREENSHOT = !hasFlag('--no-screenshot');
const SKIP_PLAN = hasFlag('--no-plan');
const CHAPTER_HINT = flag('--chapter');
const DRY_RUN = hasFlag('--dry-run');

if (!IMAGE_PATH && !DIR_PATH) {
  console.error('Usage: node agent.js --image <path>  OR  --dir <path>');
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────────────
const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

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

const SYSTEM_PROMPT = buildGenerationSystemPrompt(BASE_SCAFFOLD);

// ── Derive experiment label from prompt hash (matches server.js logic) ────────
const PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 8);
const EXPERIMENT = EXPERIMENT_OVERRIDE || `base_scene_robust_${PROMPT_HASH}`;

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

  // ── PLANNER (optional) ──────────────────────────────────────────────────
  let plan = null;
  if (!SKIP_PLAN) {
    const stem = filename.replace(/\.[^.]+$/, '');
    const chapter = CHAPTER_HINT || inferChapterFromFilename(filename);
    console.log(`  [planner] figure="${stem}" chapter=${chapter || '(unknown)'}`);
    try {
      plan = await planForFigure(stem, chapter);
      if (plan.interactionPlan) {
        const labelCount = (plan.interactionPlan.labels || []).length;
        console.log(`  ✓ Plan: ${plan.interactionPlan.concept || 'ok'} — ${(plan.interactionPlan.interactions || []).length} interactions, ${labelCount} labels`);
      } else {
        console.log('  ⚠ Planner returned no interaction plan (proceeding without)');
      }
    } catch (err) {
      console.warn(`  ⚠ Planner failed: ${err.message} (proceeding without plan)`);
    }
  }

  let html = null;
  let evaluation = null;
  let round = 0;

  // Build plan-injection text for the generator
  let planInjection = '';
  if (plan && plan.contextChunk) {
    planInjection += `\n\nTEXTBOOK CONTEXT (from "${plan.chapterName || 'unknown'}" chapter):\n${plan.contextChunk}`;
  }
  if (plan && plan.interactionPlan) {
    planInjection += `\n\nINTERACTION PLAN (follow this closely):\n${JSON.stringify(plan.interactionPlan, null, 2)}`;
  }

  while (round < MAX_ROUNDS) {
    round++;
    console.log(`  [round ${round}/${MAX_ROUNDS}] generating...`);

    // ── GENERATOR ────────────────────────────────────────────────────────────
    const baseUserText = 'Analyse this figure carefully. Then output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.';
    const userText = round === 1
      ? baseUserText + planInjection
      : 'Here is the same original figure. Apply the critic feedback and output the improved complete HTML file. No explanation, no markdown, no fences.' + planInjection;

    html = round === 1
      ? await generateFigureHtml({
        modelId: GEN_MODEL,
        scaffold: BASE_SCAFFOLD,
        mediaType,
        base64: imageBase64,
        userText,
        maxTokens: 16384,
        applyFixes: true,
      })
      : await generateRefinedFigureHtml({
        modelId: GEN_MODEL,
        scaffold: BASE_SCAFFOLD,
        prevHtml: html,
        evaluation,
        mediaType,
        base64: imageBase64,
        userText,
        maxTokens: 16384,
        applyFixes: true,
      });

    if (!html.trimStart().startsWith('<')) {
      console.error(`  ✗ Generator did not return HTML (round ${round}). Aborting.`);
      console.error('  Raw:', html.slice(0, 200));
      return;
    }
    console.log(`  ✓ HTML generated (${html.length} chars)`);

    // ── EVALUATOR ─────────────────────────────────────────────────────────────
    console.log(`  [round ${round}/${MAX_ROUNDS}] evaluating...`);
    try {
      evaluation = await evaluateHtmlWithCritic({
        html,
        evalImage: imageBase64,
        evalMediaType: mediaType,
        model: EVAL_MODEL,
        maxTokens: 512,
      });
    } catch (err) {
      console.warn(`  ✗ Evaluator failed (round ${round}): ${err.message}. Skipping eval.`);
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
    id: figureId,
    filename,
    base64thumb: thumb ? thumb.data : imageBase64,
    mediaType: thumb ? thumb.mediaType : mediaType,
    html,
    timestamp: new Date().toISOString(),
    source: 'agent',
    model: GEN_MODEL,
    eval_model: EVAL_MODEL,
    experiment: EXPERIMENT,
    promptHash: PROMPT_HASH,
    rounds: round,
    evaluation: evaluation || null,
    plan: plan || null,
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
  console.log(`  planner: ${SKIP_PLAN ? 'OFF' : 'ON'}${CHAPTER_HINT ? ` (chapter: ${CHAPTER_HINT})` : ''}`);
  console.log(`  images: ${imagePaths.length}`);
  if (DRY_RUN) console.log('  mode: DRY RUN');

  for (const imgPath of imagePaths) {
    try {
      await processImage(imgPath);
    } catch (err) {
      console.error(`  ✗ Error processing ${path.basename(imgPath)}:`, err.message);
    }
  }

  await closeScreenshotBrowser();
  console.log(`\n✓ Done — ${imagePaths.length} image(s) processed`);
  process.exit(0);
})();
