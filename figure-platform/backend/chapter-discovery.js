/**
 * chapter-discovery.js — utilities for discovering chapters and their 3D candidates
 *
 * Handles:
 * - Listing all available chapters with candidate counts
 * - Finding 3D candidate images in a chapter
 * - Inferring chapter from a figure filename
 *
 * Used by server.js and planner.js.
 */

const fs = require('fs');
const path = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────────
const ROOT_DIR = path.join(__dirname, '..', '..');
const CHAPTER_FIGURES_DIR = path.join(__dirname, '..', 'chapter-figures');

// ── List 3D candidate images for a chapter ──────────────────────────────────
/**
 * List all 3D candidate image files for a given chapter.
 * @param {string} chapterName
 * @returns {Array<{ filename, stem, fullPath }>}
 */
function list3dCandidates(chapterName) {
    const dir = path.join(CHAPTER_FIGURES_DIR, chapterName, 'candidates_3d');
    if (!fs.existsSync(dir)) return [];
    const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    return fs.readdirSync(dir)
        .filter(f => exts.has(path.extname(f).toLowerCase()))
        .map(f => ({
            filename: f,
            stem: f.replace(/\.[^.]+$/, ''),
            fullPath: path.join(dir, f),
        }))
        .sort((a, b) => a.stem.localeCompare(b.stem));
}

// ── List all chapters with their 3D candidate counts ──────────────────────────
/**
 * List all chapters with their 3D candidate image counts.
 * @returns {Array<{ name, candidateCount }>}
 */
function listChapters() {
    if (!fs.existsSync(CHAPTER_FIGURES_DIR)) return [];
    return fs.readdirSync(CHAPTER_FIGURES_DIR)
        .filter(d => {
            try { return fs.statSync(path.join(CHAPTER_FIGURES_DIR, d)).isDirectory(); } catch { return false; }
        })
        .map(d => {
            const candidates = list3dCandidates(d);
            return { name: d, candidateCount: candidates.length };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Infer chapter from filename ──────────────────────────────────────────────
/**
 * Infer the chapter name from a figure filename using chapter-figures/ folder structure.
 * Tries exact match in candidates_3d folders, then substring match on chapter names.
 * @param {string} filename
 * @returns {string|null} - chapter name or null if not found
 */
function inferChapterFromFilename(filename) {
    const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
    if (!fs.existsSync(CHAPTER_FIGURES_DIR)) return null;

    const chapters = fs.readdirSync(CHAPTER_FIGURES_DIR).filter(d => {
        try { return fs.statSync(path.join(CHAPTER_FIGURES_DIR, d)).isDirectory(); } catch { return false; }
    });

    // Check candidates_3d folders for exact match
    for (const ch of chapters) {
        const dir = path.join(CHAPTER_FIGURES_DIR, ch, 'candidates_3d');
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (f.replace(/\.[^.]+$/, '').toLowerCase() === stem) return ch;
        }
    }

    // Substring match on chapter name
    const byLen = [...chapters].sort((a, b) => b.length - a.length);
    for (const ch of byLen) {
        if (stem.includes(ch.toLowerCase())) return ch;
    }

    return null;
}

module.exports = {
    listChapters,
    list3dCandidates,
    inferChapterFromFilename,
};
