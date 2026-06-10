const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

let _browser = null;
let _screenshotQueue = Promise.resolve();

async function getBrowser() {
    if (!_browser || !_browser.connected) {
        _browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        _browser.on('disconnected', () => {
            _browser = null;
        });
    }
    return _browser;
}

async function screenshotHtml(html, waitMs = 3500) {
    const run = () => screenshotHtmlOnce(html, waitMs);
    const queued = _screenshotQueue.then(run, run);
    _screenshotQueue = queued.catch(() => { });
    return queued;
}

async function screenshotHtmlOnce(html, waitMs = 3500) {
    // Detect if the figure uses ES module imports (Three.js CDN) — needs longer wait
    const isModule = html.includes('type="module"') || html.includes("type='module'");
    const effectiveWait = isModule ? Math.max(waitMs, 5000) : waitMs;

    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: 900, height: 600 });
        // 'networkidle2' waits for CDN scripts to finish loading (critical for Three.js modules)
        await page.setContent(html, { waitUntil: isModule ? 'networkidle2' : 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, effectiveWait));
        const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 82 });
        return { data: shot, mediaType: 'image/jpeg' };
    } catch (err) {
        console.warn('Screenshot failed:', err.message);
        if (/Target closed|Session closed|Protocol error|browser has disconnected/i.test(err.message || '')) {
            await closeScreenshotBrowser();
        }
        return null;
    } finally {
        if (page) await page.close().catch(() => { });
    }
}

async function closeScreenshotBrowser() {
    if (_browser) {
        await _browser.close().catch(() => { });
        _browser = null;
    }
}

function loadBaseScaffold(backendDir) {
    const scaffoldPath = path.join(backendDir, 'base_scene_new.html');
    if (!fs.existsSync(scaffoldPath)) {
        throw new Error('ERROR: base_scene_new.html not found in backend/.');
    }
    const scaffold = fs.readFileSync(scaffoldPath, 'utf-8');
    return { scaffoldPath, scaffold };
}

module.exports = {
    screenshotHtml,
    closeScreenshotBrowser,
    loadBaseScaffold,
};
