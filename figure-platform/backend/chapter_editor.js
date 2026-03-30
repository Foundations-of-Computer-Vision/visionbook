'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const QMD_DIR = path.join(__dirname, '..', '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const OVERRIDES_DIR = path.join(__dirname, 'chapter_editor_overrides');
const EXPERIMENTS_DIR = path.join(__dirname, '..', '..', 'prompt_experiments');
const QUARTO_YML = path.join(QMD_DIR, '_quarto.yml');

function resolvePandocInvocation() {
  // Highest priority: explicit override from environment.
  if (process.env.PANDOC_PATH) {
    return { command: process.env.PANDOC_PATH, prefixArgs: [] };
  }

  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/quarto/bin/tools/pandoc');
  }
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Quarto', 'bin', 'tools', 'pandoc.exe'));
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'Quarto', 'bin', 'tools', 'pandoc.exe'));
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: candidate, prefixArgs: [] };
    }
  }

  // Fallback: rely on Quarto in PATH to provide Pandoc.
  return { command: 'quarto', prefixArgs: ['pandoc'] };
}

function scoreOf(evaluation) {
  return (evaluation && evaluation.overall_average != null) ? evaluation.overall_average : null;
}

function pushIndexEntry(index, stem, entry) {
  if (!stem) return;
  if (!index[stem]) index[stem] = [];
  index[stem].push(entry);
}

function parseBookStructure() {
  const raw = yaml.load(fs.readFileSync(QUARTO_YML, 'utf-8'));
  const chaptersList = (raw && raw.book && raw.book.chapters) ? raw.book.chapters : [];
  const result = [];
  for (const entry of chaptersList) {
    if (typeof entry === 'string') {
      result.push({
        type: 'chapter',
        file: entry,
        stem: entry.replace(/\.qmd$/, ''),
        title: extractQmdTitle(entry),
      });
    } else if (entry && entry.part) {
      const chapters = (entry.chapters || []).map(c => ({
        type: 'chapter',
        file: typeof c === 'string' ? c : (c.file || ''),
        stem: (typeof c === 'string' ? c : (c.file || '')).replace(/\.qmd$/, ''),
        title: extractQmdTitle(typeof c === 'string' ? c : (c.file || '')),
      }));
      result.push({
        type: 'part',
        file: entry.part,
        stem: entry.part.replace(/\.qmd$/, ''),
        title: extractQmdTitle(entry.part),
        chapters,
      });
    }
  }
  return result;
}

function extractQmdTitle(relPath) {
  if (!relPath) return '';
  const absPath = path.join(QMD_DIR, relPath);
  if (!fs.existsSync(absPath)) return '';
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^#\s+(.+)$/);
      if (!m) continue;
      return m[1]
        .replace(/\s*\{[^}]*\}\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  } catch (_) { }
  return path.basename(relPath, '.qmd').replace(/_/g, ' ');
}

function buildFigureIndex() {
  const index = {};
  if (fs.existsSync(RESULTS_DIR)) {
    for (const file of fs.readdirSync(RESULTS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf-8'));
        const stem = path.basename(record.filename || '', path.extname(record.filename || ''));
        if (!stem || !record.html) continue;
        pushIndexEntry(index, stem, {
          sourceType: 'agent',
          sourceKey: `agent:${record.id}`,
          resultId: record.id,
          model: record.model || 'unknown',
          experiment: record.experiment || '',
          html: record.html,
          score: scoreOf(record.evaluation),
          timestamp: record.timestamp || '',
          _file: path.join(RESULTS_DIR, file),
        });
      } catch (e) { /* skip bad records */ }
    }
  }

  if (fs.existsSync(EXPERIMENTS_DIR)) {
    for (const expName of fs.readdirSync(EXPERIMENTS_DIR)) {
      const expDir = path.join(EXPERIMENTS_DIR, expName);
      if (!fs.statSync(expDir).isDirectory()) continue;

      for (const modelName of fs.readdirSync(expDir)) {
        const modelDir = path.join(expDir, modelName);
        if (!fs.statSync(modelDir).isDirectory()) continue;

        const collectHtml = (dir) => {
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.html')) continue;
            const htmlPath = path.join(dir, file);
            const stem = path.basename(file, '.html');
            const evalPath = htmlPath.replace(/\.html$/, '.eval.json');
            let evaluation = null;
            if (fs.existsSync(evalPath)) {
              try { evaluation = JSON.parse(fs.readFileSync(evalPath, 'utf-8')); } catch (_) { }
            }
            pushIndexEntry(index, stem, {
              sourceType: 'copilot',
              sourceKey: `copilot:${expName}:${modelName}:${path.relative(modelDir, htmlPath)}`,
              resultId: null,
              model: modelName,
              experiment: expName,
              htmlPath,
              score: scoreOf(evaluation),
              timestamp: fs.statSync(htmlPath).mtime.toISOString(),
              evaluation,
            });
          }
        };

        const entries = fs.readdirSync(modelDir);
        const hasSubdirs = entries.some(entry => {
          try { return fs.statSync(path.join(modelDir, entry)).isDirectory(); } catch (_) { return false; }
        });

        if (hasSubdirs) {
          for (const sub of entries) {
            const subDir = path.join(modelDir, sub);
            if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) collectHtml(subDir);
          }
        } else {
          collectHtml(modelDir);
        }
      }
    }
  }
  for (const stem of Object.keys(index)) {
    index[stem].sort((a, b) => {
      const scoreDiff = (b.score !== null ? b.score : -1) - (a.score !== null ? a.score : -1);
      if (scoreDiff !== 0) return scoreDiff;
      return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
    });
  }
  return index;
}

function parseFigureStems(qmdPath) {
  const lines = fs.readFileSync(qmdPath, 'utf-8').split('\n');
  const stems = new Set();
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const line of lines) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const p = m[1];
      if (p.indexOf('figures/') !== -1) stems.add(path.basename(p, path.extname(p)));
    }
  }
  return stems;
}

function _withCount(ch, figIndex) {
  if (!ch.file || ch.file.indexOf('part_') === 0) return null;
  const qmdPath = path.join(QMD_DIR, ch.file);
  if (!fs.existsSync(qmdPath)) return null;
  let matchCount = 0;
  try {
    for (const stem of parseFigureStems(qmdPath)) {
      if (figIndex[stem] && figIndex[stem].length) matchCount++;
    }
  } catch (e) { }
  return { file: ch.file, stem: ch.stem, title: ch.title || extractQmdTitle(ch.file), matchCount };
}

function listQmdFiles() {
  const figIndex = buildFigureIndex();
  const entries = [];
  for (const entry of parseBookStructure()) {
    if (entry.type === 'chapter') {
      const c = _withCount(entry, figIndex);
      if (c) entries.push(c);
    } else if (entry.type === 'part') {
      for (const ch of (entry.chapters || [])) {
        const c = _withCount(ch, figIndex);
        if (c) entries.push(c);
      }
    }
  }
  return entries;
}

function listBookStructure() {
  const figIndex = buildFigureIndex();
  const result = [];
  for (const entry of parseBookStructure()) {
    if (entry.type === 'chapter') {
      const c = _withCount(entry, figIndex);
      if (c) result.push(Object.assign({ type: 'chapter' }, c));
    } else if (entry.type === 'part') {
      const chapters = (entry.chapters || []).map(ch => _withCount(ch, figIndex)).filter(Boolean);
      result.push({ type: 'part', stem: entry.stem, title: entry.title || extractQmdTitle(entry.file), file: entry.file, chapters });
    }
  }
  return result;
}

function loadOverride(chapter, figStem) {
  const p = path.join(OVERRIDES_DIR, chapter, figStem + '.html');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function saveOverride(chapter, figStem, htmlContent) {
  const dir = path.join(OVERRIDES_DIR, chapter);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, figStem + '.html'), htmlContent, 'utf-8');
}

/**
 * analyzeChapterFigure — send a figure thumbnail + chapter context to a VLM
 * (default: GPT-4o) and return reasoning about the figure's quality/zoom/fit.
 *
 * @param {string} qmdPath   — absolute path to the .qmd file
 * @param {string} figStem   — bare filename stem, e.g. 'pinhole'
 * @param {object} opts
 *   resultId  {string}  — pick a specific result; omit to use best-scored
 *   question  {string}  — custom question; omit for default comprehensive analysis
 *   modelId   {string}  — model key in MODEL_REGISTRY (default 'gpt-4o')
 * @returns {Promise<{ analysis, figStem, model, resultId }>}
 */
async function analyzeChapterFigure(qmdPath, figStem, { resultId, question, modelId } = {}) {
  const figIndex = buildFigureIndex();
  const matches = figIndex[figStem] || [];
  if (!matches.length) throw new Error(`No results found for figure: ${figStem}`);

  const entry = (resultId ? matches.find(m => m.resultId === resultId) : null) || matches[0];
  if (!entry) throw new Error(`Result not found for figure: ${figStem}`);

  // Read thumbnail from the stored result JSON
  let base64thumb = null;
  try {
    const record = JSON.parse(fs.readFileSync(entry._file, 'utf-8'));
    base64thumb = record.base64thumb || null;
  } catch (_) { /* non-fatal — analysis still runs without image */ }

  // Extract ±30 lines of chapter text around the figure reference
  const lines = fs.readFileSync(qmdPath, 'utf-8').split('\n');
  const escapedStem = figStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const figPattern = new RegExp(`figures/[^)]*${escapedStem}`, 'i');
  const figLine = lines.findIndex(l => figPattern.test(l));
  const CONTEXT = 30;
  const ctxStart = Math.max(0, (figLine < 0 ? 0 : figLine) - CONTEXT);
  const ctxEnd = Math.min(lines.length, (figLine < 0 ? 60 : figLine) + CONTEXT + 1);
  const context = lines.slice(ctxStart, ctxEnd).join('\n');

  const chapterName = path.basename(qmdPath, '.qmd').replace(/_/g, ' ');

  const systemPrompt =
    'You are a visual reasoning expert analyzing figures for a computer vision textbook. ' +
    'Given a rendered figure image and its surrounding chapter text, provide clear, actionable analysis.';

  const defaultQuestion =
    `Analyze this figure from the "${chapterName}" chapter:\n` +
    '1. Does it correctly illustrate the concept described in the surrounding text?\n' +
    '2. Is the zoom/composition of the implemented interactive figures good? — no excess whitespace, key elements fully visible?\n' +
    '3. What are the strengths and any weaknesses?\n' +
    '4. Suggest specific improvements if needed.\n' +
    'Be concise and practical.';

  const scoreStr = entry.score != null ? `Quality score: ${entry.score.toFixed(2)}` : '';
  const textBlock = [
    `Chapter: ${chapterName}`,
    `Figure: ${figStem}`,
    `Generated by model: ${entry.model || 'unknown'}`,
    scoreStr,
    '',
    'Surrounding chapter context:',
    '```markdown',
    context,
    '```',
    '',
    question || defaultQuestion,
  ].filter(l => l !== null).join('\n');

  const userContent = [
    ...(base64thumb ? [{
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${base64thumb}` },
    }] : []),
    { type: 'text', text: textBlock },
  ];

  // Lazy-require models.js to avoid top-level circular dependency issues
  const { generateWithModel } = require('./models');
  const usedModel = modelId || 'gpt-4o';
  const analysis = await generateWithModel(usedModel, { systemPrompt, userContent, maxTokens: 1024 });

  return { analysis, figStem, model: usedModel, resultId: entry.resultId };
}

function buildChapterHtml(qmdPath, figSelections) {
  const figIndex = buildFigureIndex();
  const qmdStem = path.basename(qmdPath, '.qmd');
  const substituted = [];

  let bodyHtml;
  const { command, prefixArgs } = resolvePandocInvocation();
  try {
    bodyHtml = execFileSync(
      command,
      [
        ...prefixArgs,
        '--from=markdown+tex_math_dollars+raw_html',
        '--to=html5',
        '--mathjax',
        qmdPath,
      ],
      { maxBuffer: 20 * 1024 * 1024, encoding: 'utf-8' }
    );
  } catch (err) {
    const stderr = (err && err.stderr) ? String(err.stderr).trim() : '';
    throw new Error('Pandoc failed (' + command + '): ' + (stderr || err.message || String(err)));
  }

  bodyHtml = bodyHtml.replace(
    /<img(\s[^>]*)src="(?:\.\/)?(figures\/[^/]+\/([^"]+))"([^>]*)\/>/g,
    (match, pre, fullPath, filename, post) => {
      const stem = path.basename(filename, path.extname(filename));
      const matches = figIndex[stem] || [];
      const sel = figSelections && figSelections[stem];
      const entry = (sel
        ? matches.find(m => (sel.sourceKey && m.sourceKey === sel.sourceKey) || (sel.resultId && m.resultId === sel.resultId))
        : null) || matches[0];
      if (!entry) return match;

      const htmlContent = loadOverride(qmdStem, stem) || entry.html || (entry.htmlPath ? fs.readFileSync(entry.htmlPath, 'utf-8') : '');
      if (!htmlContent) return match;
      const allAttrs = pre + post;
      const wMatch = allAttrs.match(/width:\s*([\d.]+)%/);
      const wPct = wMatch ? parseFloat(wMatch[1]) : 65;
      const height = wPct >= 80 ? '560px' : wPct >= 50 ? '500px' : '460px';

      substituted.push({
        stem,
        sourceType: entry.sourceType,
        sourceKey: entry.sourceKey,
        resultId: entry.resultId,
        model: entry.model,
        experiment: entry.experiment,
        score: entry.score,
      });
      const src = 'data:text/html;charset=utf-8;base64,' + Buffer.from(htmlContent).toString('base64');
      return '<iframe class="fig-iframe" src="' + src + '" style="width:100%;height:' + height + ';border:none;display:block;margin:0 auto;" scrolling="no" allowfullscreen loading="lazy"></iframe>';
    }
  );

  // Unwrap <p><iframe…></iframe></p> left by the substitution above.
  // The regex replaces <img/> but leaves the surrounding <p> intact, which
  // breaks flex layout (block <p> overrides the flex-cell sizing).
  bodyHtml = bodyHtml.replace(/<p>\s*(<iframe[^>]*>.*?<\/iframe>)\s*<\/p>/gs, '$1');

  // Strip raw Quarto cross-reference labels that pandoc doesn't process
  // (e.g. {#eq-directedjoint}, {#fig-foo}, {#sec-bar})
  bodyHtml = bodyHtml.replace(/\s*\{#(?:eq|fig|tbl|sec|thm|lem|cor|prp|cnj|def|exm|exr|alg|hyp)-[^}]+\}/g, '');

  // Second pass: inline remaining static PNGs as base64 data URIs so they
  // resolve inside a srcdoc iframe (which has no base URL).
  const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp'
  };
  bodyHtml = bodyHtml.replace(
    /<img(\s[^>]*)src="((?:\.\/)?figures\/[^"]+)"([^>]*)\/>/g,
    (match, pre, relPath, post) => {
      const absPath = path.join(QMD_DIR, relPath.replace(/^\.\//, ''));
      const ext = path.extname(absPath).toLowerCase();
      const mime = MIME[ext];
      if (!mime || !fs.existsSync(absPath)) return match;
      const b64 = fs.readFileSync(absPath).toString('base64');
      return '<img' + pre + 'src="data:' + mime + ';base64,' + b64 + '"' + post + '/>';
    }
  );

  return { html: wrapPage(bodyHtml, qmdStem), substituted };
}

function getSubstitutionMap(qmdPath) {
  const figIndex = buildFigureIndex();
  return Array.from(parseFigureStems(qmdPath))
    .filter(stem => figIndex[stem] && figIndex[stem].length)
    .map(stem => ({
      figStem: stem,
      matches: figIndex[stem].map(r => ({
        sourceType: r.sourceType,
        sourceKey: r.sourceKey,
        resultId: r.resultId,
        experiment: r.experiment,
        model: r.model,
        score: r.score,
        timestamp: r.timestamp,
      })),
    }));
}

function wrapPage(body, title) {
  const safeTitle = title.replace(/_/g, ' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeTitle}</title>
<script>
MathJax = {
  tex: { inlineMath: [['\\\\(','\\\\)']], displayMath: [['\\\\[','\\\\]']] },
  options: { skipHtmlTags: ['script','noscript','style','textarea','pre'] }
};
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js" async></script>
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:"Source Serif 4","Georgia",serif;font-size:16px;line-height:1.65;color:#1a1a1a;background:#fff;max-width:860px;margin:0 auto;padding:2em 250px 5em 2.5em}
h1{font-size:2.1em;font-weight:700;margin:0 0 .15em;line-height:1.2}
h2{font-size:1.35em;font-weight:700;margin:2em 0 .4em;padding-bottom:.25em;border-bottom:1px solid #e8e8e8}
h3{font-size:1.1em;font-weight:700;margin:1.6em 0 .3em}
h4{font-size:1em;font-weight:700;margin:1.2em 0 .2em}
p{margin:0 0 .85em}
a{color:#4a72a8}
code{font-family:"Fira Mono","IBM Plex Mono",monospace;font-size:.87em;background:#f5f5f5;padding:1px 5px;border-radius:3px}
pre code{display:block;padding:1em;border-radius:6px;line-height:1.5}
figure{margin:1.8em auto;text-align:center}
figcaption{font-size:.83em;color:#555;margin-top:.5em;line-height:1.4}
img{max-width:100%;height:auto}
.fig-iframe{border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
blockquote{border-left:3px solid #ddd;margin:1em 0;padding:.1em 1em;color:#555}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #e0e0e0;padding:6px 12px}
th{background:#f8f8f8;font-weight:600}
/* layout divs — handled by JS below for any ncol/nrow value */
[data-layout-ncol],[data-layout-nrow]{margin:1.8em 0}
[data-layout-ncol] > figure,[data-layout-nrow] > figure{margin:0;text-align:center}
[data-layout-ncol] > figure img,[data-layout-nrow] > figure img{width:100%;height:auto}
[data-layout-ncol] > figure iframe,[data-layout-nrow] > figure iframe{width:100%}
/* overall caption sits below the row */
[data-layout-ncol] > figcaption,[data-layout-nrow] > figcaption{
  text-align:center;font-size:.83em;color:#555;margin-top:.4em;width:100%}
/* Column-margin: use a true right-side margin column, closer to the original book */
.column-margin{float:right;clear:right;width:210px;max-width:210px;margin:0 -230px 1.1em 1.6em;padding:0;background:none;border:none;border-radius:0;font-size:.8em;line-height:1.5;color:#333;box-sizing:border-box}
.column-margin img{width:100%!important;max-width:100%;height:auto;display:block;margin:.2em 0}
.column-margin figure{margin:.2em 0 .5em;text-align:left}
.column-margin figcaption{font-size:.92em;color:#666;text-align:left;margin-top:.3em}
.column-margin p{margin:0 0 .7em}
.column-margin > :last-child{margin-bottom:0}
@media (max-width: 720px){
  body{max-width:860px;padding:2em 2.5em 5em}
  .column-margin{float:none;width:auto;max-width:none;margin:1em 0;padding:0;font-size:.9em;color:#555}
}
</style>
</head>
<body>
${body}
<script>
(function() {
  // Apply flex layout for all data-layout-ncol divs
  document.querySelectorAll('[data-layout-ncol]').forEach(function(div) {
    var n = parseInt(div.getAttribute('data-layout-ncol'), 10);
    if (!n || n < 1) return;
    var gap = 12; // px
    div.style.display = 'flex';
    div.style.flexWrap = 'wrap';
    div.style.gap = gap + 'px';
    div.style.alignItems = 'flex-start';
    div.style.margin = '1.8em 0';
    // Cells can be <figure> (img/iframe with caption) or <p> (img/iframe without caption)
    var cells = Array.from(div.children).filter(function(el) {
      return el.tagName === 'FIGURE' ||
             (el.tagName === 'P' && (el.querySelector('img') || el.querySelector('iframe')));
    });
    cells.forEach(function(cell) {
      var w = 'calc(' + (100 / n).toFixed(4) + '% - ' + (gap * (n-1) / n).toFixed(1) + 'px)';
      cell.style.flex = '0 0 ' + w;
      cell.style.maxWidth = w;
      cell.style.minWidth = '0';
      cell.style.margin = '0';
      if (cell.tagName === 'P') { cell.style.padding = '0'; cell.style.lineHeight = '0'; }
      // Force images/iframes inside to fill cell width
      cell.querySelectorAll('img').forEach(function(img) {
        img.removeAttribute('style'); // strip any pandoc width% — cell handles sizing
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
      });
      cell.querySelectorAll('iframe').forEach(function(fr) {
        fr.style.width = '100%';
      });
    });
  });

  // Apply flex layout for data-layout-nrow divs
  document.querySelectorAll('[data-layout-nrow]').forEach(function(div) {
    var nrow = parseInt(div.getAttribute('data-layout-nrow'), 10);
    var cells = Array.from(div.children).filter(function(el) {
      return el.tagName === 'FIGURE' ||
             (el.tagName === 'P' && (el.querySelector('img') || el.querySelector('iframe')));
    });
    var total = cells.length;
    if (!nrow || !total) return;
    var ncol = Math.ceil(total / nrow);
    var gap = 12;
    div.style.display = 'flex';
    div.style.flexWrap = 'wrap';
    div.style.gap = gap + 'px';
    div.style.alignItems = 'flex-start';
    div.style.margin = '1.8em 0';
    cells.forEach(function(cell) {
      var w = 'calc(' + (100 / ncol).toFixed(4) + '% - ' + (gap * (ncol-1) / ncol).toFixed(1) + 'px)';
      cell.style.flex = '0 0 ' + w;
      cell.style.maxWidth = w;
      cell.style.minWidth = '0';
      cell.style.margin = '0';
      if (cell.tagName === 'P') { cell.style.padding = '0'; cell.style.lineHeight = '0'; }
      cell.querySelectorAll('img').forEach(function(img) {
        img.removeAttribute('style');
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
      });
      cell.querySelectorAll('iframe').forEach(function(fr) {
        fr.style.width = '100%';
      });
    });
  });
})();
</script>
</body>
</html>`;
}

module.exports = {
  listQmdFiles,
  listBookStructure,
  buildFigureIndex,
  buildChapterHtml,
  getSubstitutionMap,
  saveOverride,
  analyzeChapterFigure,
  QMD_DIR,
  RESULTS_DIR,
};
