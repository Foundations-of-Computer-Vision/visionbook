#!/usr/bin/env node
/**
 * save_result.js — save a chat-generated HTML file into the platform results folder
 *
 * Usage:
 *   node save_result.js <html-file> [<image-file>] [<display-name>]
 *
 * Examples:
 *   node save_result.js output.html
 *   node save_result.js output.html ../chapter-figures/imaging/pinhole_geometry2.png
 *   node save_result.js output.html ../chapter-figures/imaging/pinhole_geometry2.png "Pinhole Camera"
 */

const fs   = require('fs');
const path = require('path');
const { normalizeHtmlSource } = require('./html_source');

const [,, htmlFile, imageFile, displayName] = process.argv;

if (!htmlFile) {
  console.error('Usage: node save_result.js <html-file> [<image-file>] [<display-name>]');
  process.exit(1);
}

if (!fs.existsSync(htmlFile)) {
  console.error(`ERROR: HTML file not found: ${htmlFile}`);
  process.exit(1);
}

const html = normalizeHtmlSource(fs.readFileSync(htmlFile, 'utf-8'));
if (!html.trimStart().startsWith('<')) {
  console.error('ERROR: File does not appear to be HTML or escaped HTML.');
  process.exit(1);
}

// Generate unique id
const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const timestamp = new Date().toISOString();

// Optional thumbnail from image file
let base64thumb = null;
if (imageFile && fs.existsSync(imageFile)) {
  base64thumb = fs.readFileSync(imageFile).toString('base64');
  console.log(`Thumbnail: ${imageFile}`);
} else if (imageFile) {
  console.warn(`WARNING: Image file not found (skipping thumbnail): ${imageFile}`);
}

const name = displayName || path.basename(htmlFile, '.html');

const record = {
  id,
  filename: name,
  base64thumb,
  html,
  timestamp,
  source: 'chat',
};

const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

const outPath = path.join(resultsDir, `${id}.json`);
fs.writeFileSync(outPath, JSON.stringify(record, null, 2));

console.log(`✅ Saved to results/`);
console.log(`   ID:   ${id}`);
console.log(`   Name: ${name}`);
console.log(`   Time: ${timestamp}`);
console.log(`\nRefresh the History tab to see it.`);
