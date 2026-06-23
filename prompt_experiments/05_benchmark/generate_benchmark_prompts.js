/**
 * generate_benchmark_prompts.js
 *
 * Generates a single file with all 30 benchmark prompts, each with the
 * relevant QMD textbook context pre-filled. Paste each section into a
 * chatbot and attach the corresponding figure image.
 *
 * Usage (from repo root or figure-platform/backend/):
 *   node figure-platform/backend/generate_benchmark_prompts.js
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const QMD_DIR = ROOT_DIR;
const PROMPT_TEMPLATE = path.join(__dirname, 'generation_prompt.txt');
const OUTPUT_FILE = path.join(ROOT_DIR, 'prompt_experiments', '05_benchmark', 'benchmark_prompts.txt');
const OUTPUT_HTML = path.join(ROOT_DIR, 'prompt_experiments', '05_benchmark', 'benchmark_prompts.html');

const BENCHMARK_FIGURES = [
  { chapter: '2d_Motion_From_3D', stem: 'basic_motion_point' },
  { chapter: '2d_Motion_From_3D', stem: 'flying_bird' },
  { chapter: '2d_Motion_From_3D', stem: 'yaw_pitch_roll' },
  { chapter: '3d_Learning', stem: 'geometry_reconstruction_12' },
  { chapter: '3d_Scene_Understanding_Stereo', stem: 'epipolar_geometry' },
  { chapter: 'Blurring_2', stem: 'bin2' },
  { chapter: 'Blurring_2', stem: 'box' },
  { chapter: 'Derivatives', stem: 'DFTderivativeoperators' },
  { chapter: 'Derivatives', stem: 'DFTlaplacians' },
  { chapter: 'Generative_Modeling_and_Rep_Learning', stem: 'rep_gen_schematic' },
  { chapter: 'Graphical_Models', stem: 'mrf' },
  { chapter: 'Homogeneous_Coordinates', stem: 'homogeneousAndHeteregeneous_VS3' },
  { chapter: 'Image_Processing_Fourier', stem: 'complexexponential' },
  { chapter: 'Imaging', stem: 'brdf' },
  { chapter: 'Imaging', stem: 'no_picture_on_a_wall_aina' },
  { chapter: 'Imaging', stem: 'orthogonal_projection' },
  { chapter: 'Imaging', stem: 'pinhole_geometry2' },
  { chapter: 'Imaging', stem: 'pinhole_names2' },
  { chapter: 'Imaging', stem: 'similar_triangles2' },
  { chapter: 'Neural_Nets_As_Distribution_Transformers', stem: '2D_mapping_diagrams' },
  { chapter: 'Neural_Nets_As_Distribution_Transformers', stem: 'nn_training_viz' },
  { chapter: 'Neural_Nets_As_Distribution_Transformers', stem: 'vit_mapping_plot' },
  { chapter: 'Homography', stem: 'homography_plane_geometry2' },
  { chapter: 'Imaging_Geometry', stem: 'pinhole_and_sensor' },
  { chapter: 'Imaging_Geometry', stem: 'reprojection_error' },
  { chapter: 'Optical_Flow', stem: 'barber_pole' },
  { chapter: 'VLMs', stem: 'clip_mapping_diagram_two_branch' },
  { chapter: 'Spatial_Filter_Sets', stem: 'gabor_spacetime_tiles' },
  { chapter: 'Spatial_Filter_Sets', stem: 'gabors' },
  { chapter: 'Upsamplig_downsampling_2', stem: 'bilinear_interp2' },
];

// ── Context extraction (mirrored from planner.js) ──────────────────────────

function findQmdFile(chapterName) {
  if (!chapterName) return null;

  const direct = path.join(QMD_DIR, `${chapterName}.qmd`);
  if (fs.existsSync(direct)) return direct;

  const candidates = fs.readdirSync(QMD_DIR).filter(f => f.endsWith('.qmd'));
  const normalised = chapterName.toLowerCase().replace(/[-_ ]/g, '');
  for (const c of candidates) {
    const stem = c.replace(/\.qmd$/, '').toLowerCase().replace(/[-_ ]/g, '');
    if (stem === normalised) return path.join(QMD_DIR, c);
  }

  for (const c of candidates) {
    const stem = c.replace(/\.qmd$/, '').toLowerCase();
    if (stem.includes(chapterName.toLowerCase()) || chapterName.toLowerCase().includes(stem)) {
      return path.join(QMD_DIR, c);
    }
  }

  return null;
}

function extractFigureContext(qmdContent, figureStem) {
  const lines = qmdContent.split('\n');
  const stemLower = figureStem.toLowerCase().replace(/\.[^.]+$/, '');
  const contextRadius = 15;
  const collected = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes(stemLower) || line.includes(`/${stemLower}.`) || line.includes(`/${stemLower})`)) {
      const start = Math.max(0, i - contextRadius);
      const end = Math.min(lines.length - 1, i + contextRadius);
      for (let j = start; j <= end; j++) collected.add(j);
    }
  }

  if (collected.size === 0) {
    return lines.slice(0, 40).join('\n');
  }

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

// ── HTML generation ────────────────────────────────────────────────────────

function buildHtml(figures) {
  const rows = figures.map((f, i) => `
    <li class="row">
      <span class="num">${i + 1}</span>
      <div class="info">
        <span class="stem">${f.stem}</span>
        <span class="chapter">${f.chapter}</span>
      </div>
      <button class="copy-btn" onclick="copyPrompt(${i})">Copy</button>
    </li>`).join('');

  const promptsJson = JSON.stringify(figures.map(f => f.prompt));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Benchmark Prompts</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #1e1e2e; color: #cdd6f4; min-height: 100vh; padding: 24px; }
  h1 { font-size: 13px; font-weight: 600; color: #89b4fa; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 16px; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #313244; border-radius: 6px; }
  .num { font-size: 11px; color: #6c7086; width: 24px; flex-shrink: 0; text-align: right; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .stem { font-size: 13px; font-weight: 500; color: #cdd6f4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chapter { font-size: 11px; color: #6c7086; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .copy-btn {
    flex-shrink: 0;
    background: #3b82f6; color: #fff; border: none; border-radius: 5px;
    padding: 5px 14px; font-size: 13px; font-weight: 500; cursor: pointer;
    transition: background 0.15s;
  }
  .copy-btn:hover { background: #2563eb; }
  .copy-btn.copied { background: #16a34a; }
</style>
</head>
<body>
<h1>Benchmark Prompts — attach the figure image when pasting</h1>
<ul>${rows}
</ul>
<script>
const PROMPTS = ${promptsJson};
function copyPrompt(i) {
  navigator.clipboard.writeText(PROMPTS[i]).then(() => {
    const btn = document.querySelectorAll('.copy-btn')[i];
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}
</script>
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const template = fs.readFileSync(PROMPT_TEMPLATE, 'utf-8');
  const SEPARATOR = '='.repeat(80);
  const sections = [];
  const figureData = [];

  for (let i = 0; i < BENCHMARK_FIGURES.length; i++) {
    const { chapter, stem } = BENCHMARK_FIGURES[i];
    const imagePath = `figure-platform/chapter-figures/${chapter}/candidates_3d/${stem}.png`;

    const qmdPath = findQmdFile(chapter);
    let context;
    if (qmdPath) {
      const qmdContent = fs.readFileSync(qmdPath, 'utf-8');
      context = extractFigureContext(qmdContent, stem);
    } else {
      context = `(No QMD file found for chapter "${chapter}" — add context manually)`;
      console.warn(`  WARNING: no QMD found for ${chapter}`);
    }

    const prompt = template
      .replace('[paste nearby .qmd context here]', context)
      .replace('<insert figure name>', `${chapter}/${stem}`);

    const header = [
      SEPARATOR,
      `FIGURE ${i + 1}/${BENCHMARK_FIGURES.length} — ${chapter} / ${stem}`,
      `Image to attach: ${imagePath}`,
      SEPARATOR,
    ].join('\n');

    sections.push(`${header}\n\n${prompt}`);
    figureData.push({ chapter, stem, imagePath, prompt });
    console.log(`  [${i + 1}/${BENCHMARK_FIGURES.length}] ${chapter}/${stem}`);
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  fs.writeFileSync(OUTPUT_FILE, sections.join('\n\n\n'), 'utf-8');
  console.log(`\nWrote .txt  → ${OUTPUT_FILE}`);

  fs.writeFileSync(OUTPUT_HTML, buildHtml(figureData), 'utf-8');
  console.log(`Wrote .html → ${OUTPUT_HTML}`);
}

main();
