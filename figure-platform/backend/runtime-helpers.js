const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

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
        console.warn('Screenshot failed:', err.message);
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
    const scaffoldPath = path.join(backendDir, 'base_scene_robust.html');
    if (!fs.existsSync(scaffoldPath)) {
        throw new Error('ERROR: base_scene_robust.html not found in backend/.');
    }
    const scaffold = fs.readFileSync(scaffoldPath, 'utf-8');
    return { scaffoldPath, scaffold };
}

module.exports = {
    screenshotHtml,
    closeScreenshotBrowser,
    loadBaseScaffold,
};
