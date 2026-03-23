#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').default;

const ROOT_DIR = path.join(__dirname, '..');
const CHAPTER_FIGURES_DIR = path.join(ROOT_DIR, 'chapter-figures');
const OUTPUT_DIRS = {
  photograph: 'photographs',
  diagram_2d: 'diagrams_2d',
  diagram_3d_candidate: 'candidates_3d',
  sketch: 'sketches',
};
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DEFAULT_MODEL = 'gpt-5.4';

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === 'your_openai_api_key_here') {
      throw new Error('OPENAI_API_KEY is not set. Add it to backend/.env before running the sorter.');
    }
    openaiClient = new OpenAI({ apiKey: key });
  }
  return openaiClient;
}

function parseArgs(argv) {
  const options = {
    chapter: null,
    dryRun: false,
    limit: null,
    model: DEFAULT_MODEL,
    secondLook: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--chapter') {
      options.chapter = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--limit') {
      const raw = argv[index + 1];
      options.limit = raw ? Number(raw) : null;
      index += 1;
    } else if (arg === '--model') {
      options.model = argv[index + 1] || DEFAULT_MODEL;
      index += 1;
    } else if (arg === '--second-look') {
      options.secondLook = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }

  return options;
}

function printHelp() {
  console.log(`Sort chapter figures into photographs / diagrams_2d / candidates_3d / sketches.

Usage:
  node backend/sort_chapter_figures.js [--chapter <chapter-name>] [--dry-run] [--limit <n>] [--model <model>] [--second-look]

Examples:
  node backend/sort_chapter_figures.js --chapter imaging
  node backend/sort_chapter_figures.js --dry-run
  node backend/sort_chapter_figures.js --chapter 2d_motion_from_3d --limit 5
  node backend/sort_chapter_figures.js --second-look

--second-look: Only reclassify images in candidates_3d and diagrams_2d folders, moving sketches to sketches/`);
}

function listChapterDirectories(rootDir, requestedChapter) {
  if (!fs.existsSync(rootDir)) {
    throw new Error(`chapter-figures directory not found at ${rootDir}`);
  }

  const chapterDirs = fs.readdirSync(rootDir)
    .filter((entry) => !entry.startsWith('.'))
    .map((entry) => path.join(rootDir, entry))
    .filter((fullPath) => fs.statSync(fullPath).isDirectory())
    .filter((fullPath) => {
      if (!requestedChapter) return true;
      return path.basename(fullPath) === requestedChapter;
    })
    .sort();

  if (requestedChapter && chapterDirs.length === 0) {
    throw new Error(`Chapter '${requestedChapter}' not found under ${rootDir}`);
  }

  return chapterDirs;
}

function ensureOutputDirectories(chapterDir) {
  for (const folderName of Object.values(OUTPUT_DIRS)) {
    fs.mkdirSync(path.join(chapterDir, folderName), { recursive: true });
  }
}

function isSupportedImage(fileName) {
  return SUPPORTED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function collectUnsortedImages(chapterDir) {
  return fs.readdirSync(chapterDir)
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => isSupportedImage(entry))
    .map((entry) => path.join(chapterDir, entry))
    .sort();
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return { chapter: path.basename(path.dirname(manifestPath)), images: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { chapter: path.basename(path.dirname(manifestPath)), images: [] };
  }
}

function upsertManifestEntry(manifest, entry) {
  const existingIndex = manifest.images.findIndex((image) => image.originalPath === entry.originalPath);
  if (existingIndex >= 0) {
    manifest.images[existingIndex] = entry;
  } else {
    manifest.images.push(entry);
  }
}

async function classifyImage(imagePath, model) {
  const mediaType = mediaTypeForPath(imagePath);
  const base64 = fs.readFileSync(imagePath).toString('base64');
  const fileName = path.basename(imagePath);

  const response = await getOpenAI().chat.completions.create({
    model,
    max_completion_tokens: 220,
    messages: [
      {
        role: 'system',
        content: `You classify textbook figures into exactly one bucket.
Return ONLY valid JSON with keys: category, confidence, rationale.
Allowed category values:
- photograph: real-world photo or natural image; not suitable for interactive figure generation
- diagram_2d: chart, schematic, graph, flat illustrative diagram; suitable for 2D interactive treatment
- diagram_3d_candidate: figure depicts 3D geometry, perspective, volumetric structure, multiview geometry, camera setup, scene layout, or spatial relationships; suitable for Three.js generation
- sketch: hand-drawn, pen, pencil, or rough illustration; not suitable for 3D or interactive generation

IMPORTANT: Do NOT classify hand-drawn, pen, or pencil sketches as 3D candidates, even if they depict 3D objects. Only select 3D if the diagram is a clean, computer-generated geometric figure.
Keep rationale under 20 words.`
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Classify this textbook figure file named '${fileName}'. Use the visual content, not just the filename.`
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${base64}` }
          }
        ]
      }
    ]
  });

  let content = response.choices[0]?.message?.content || '{}';
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Model did not return valid JSON for ${fileName}: ${content.slice(0, 200)}`);
  }

  const category = String(parsed.category || '').trim();
  if (!Object.prototype.hasOwnProperty.call(OUTPUT_DIRS, category)) {
    throw new Error(`Unexpected category '${category}' for ${fileName}`);
  }

  const confidenceRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : null;

  return {
    category,
    confidence,
    rationale: String(parsed.rationale || '').trim(),
  };
}

function mediaTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function moveFile(sourcePath, destinationDir, dryRun) {
  const destinationPath = path.join(destinationDir, path.basename(sourcePath));
  if (!dryRun) {
    fs.renameSync(sourcePath, destinationPath);
  }
  return destinationPath;
}

async function sortChapterFigures(options) {
  const chapterDirs = listChapterDirectories(CHAPTER_FIGURES_DIR, options.chapter);
  let processed = 0;
  const summary = [];

  for (const chapterDir of chapterDirs) {
    ensureOutputDirectories(chapterDir);
    const manifestPath = path.join(chapterDir, 'classification_manifest.json');
    const manifest = loadManifest(manifestPath);
    let imagePaths = [];
    let mode = 'full';
    if (options.secondLook) {
      // Only process images in candidates_3d and diagrams_2d
      mode = 'second-look';
      const candidatesDir = path.join(chapterDir, OUTPUT_DIRS['diagram_3d_candidate']);
      const diagrams2dDir = path.join(chapterDir, OUTPUT_DIRS['diagram_2d']);
      let candidates = [], diagrams2d = [];
      if (fs.existsSync(candidatesDir)) {
        candidates = fs.readdirSync(candidatesDir)
          .filter((entry) => isSupportedImage(entry))
          .map((entry) => path.join(candidatesDir, entry));
      }
      if (fs.existsSync(diagrams2dDir)) {
        diagrams2d = fs.readdirSync(diagrams2dDir)
          .filter((entry) => isSupportedImage(entry))
          .map((entry) => path.join(diagrams2dDir, entry));
      }
      imagePaths = candidates.concat(diagrams2d);
    } else {
      imagePaths = collectUnsortedImages(chapterDir);
    }
    const limitedImagePaths = options.limit ? imagePaths.slice(0, options.limit) : imagePaths;
    const chapterSummary = {
      chapter: path.basename(chapterDir),
      processed: 0,
      moved: 0,
      counts: {
        photograph: 0,
        diagram_2d: 0,
        diagram_3d_candidate: 0,
        sketch: 0,
      },
      mode,
    };

    for (const imagePath of limitedImagePaths) {
      const fileName = path.basename(imagePath);
      process.stdout.write(`Classifying ${chapterSummary.chapter}/${fileName}... `);
      const classification = await classifyImage(imagePath, options.model);
      const destinationDir = path.join(chapterDir, OUTPUT_DIRS[classification.category]);
      const destinationPath = moveFile(imagePath, destinationDir, options.dryRun);

      chapterSummary.processed += 1;
      chapterSummary.moved += 1;
      chapterSummary.counts[classification.category] += 1;
      processed += 1;

      upsertManifestEntry(manifest, {
        fileName,
        originalPath: path.join(chapterSummary.chapter, fileName),
        category: classification.category,
        confidence: classification.confidence,
        rationale: classification.rationale,
        destinationPath: path.relative(CHAPTER_FIGURES_DIR, destinationPath),
        sortedAt: new Date().toISOString(),
      });

      console.log(`${classification.category}${classification.confidence !== null ? ` (${classification.confidence})` : ''}`);
    }

    manifest.updatedAt = new Date().toISOString();
    manifest.model = options.model;
    manifest.dryRun = options.dryRun;
    manifest.mode = mode;
    if (!options.dryRun) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    summary.push(chapterSummary);
  }

  return { processed, summary };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await sortChapterFigures(options);

  console.log('\nSorting complete.');
  for (const chapter of result.summary) {
    console.log(`${chapter.chapter}: ${chapter.processed} processed | photos=${chapter.counts.photograph}, 2d=${chapter.counts.diagram_2d}, 3d=${chapter.counts.diagram_3d_candidate}`);
  }
  console.log(`Total processed: ${result.processed}`);
  if (options.dryRun) {
    console.log('Dry run only: no files were moved.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
