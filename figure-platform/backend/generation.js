const { generateWithModel } = require('./models');

// === Code Divider =============================================================
const BASE_ROLE = 'You are an expert Three.js developer who converts 2D textbook figures into interactive 3D web visualizations.';

// Scaffold insertion markers (must match backend/base_scene_new.html)
const UI_BEGIN_MARKER = '<!-- @FIGURE_UI_BEGIN -->';
const UI_END_MARKER = '<!-- @FIGURE_UI_END -->';
const CODE_BEGIN_MARKER = '// @FIGURE_CODE_BEGIN';
const CODE_END_MARKER = '// @FIGURE_CODE_END';
// === Code Divider =============================================================
const BASE_OUTPUT_RULES = `OUTPUT RULES - non-negotiable:
- Your response must be only the scaffold fill-in payload, not a full HTML file.
- It must contain these exact markers (even if sections are empty):
        ${UI_BEGIN_MARKER} ... ${UI_END_MARKER}
        ${CODE_BEGIN_MARKER} ... ${CODE_END_MARKER}
- Between the UI markers: output only HTML that belongs inside <div id="ui"> (no <html>, <head>, <body>, <script>, or <style>).
- Between the code markers: output only JavaScript that runs inside the existing <script type="module">. Do NOT add imports, importmaps, or re-declare scaffold globals.
- Do not include any other text. No explanation, no markdown, no code fences.`;

// === Code Divider =============================================================
function buildPromptHeader({ scaffold, roleSuffix = '', scaffoldIntro, framedScaffold = true }) {
    const roleLine = roleSuffix ? `${BASE_ROLE} ${roleSuffix}` : BASE_ROLE;
    const scaffoldSection = framedScaffold
        ? `--------------------------------------------------------------------------------
${scaffoldIntro}
--------------------------------------------------------------------------------
${scaffold}
--------------------------------------------------------------------------------`
        : `${scaffoldIntro}
${scaffold}`;

    return `${roleLine}

${BASE_OUTPUT_RULES}

${scaffoldSection}`;
}

// === Code Divider =============================================================
const GENERATION_TASK_GUIDE = `SCAFFOLD MARKERS (fill these only):
- UI HTML: between ${UI_BEGIN_MARKER} and ${UI_END_MARKER}
- Module JS: between ${CODE_BEGIN_MARKER} and ${CODE_END_MARKER}

What the scaffold already provides (do NOT re-declare):
- THREE + OrbitControls imports via importmap
- renderer + <canvas id="c">, scene, orthographic camera (d, aspect), OrbitControls
- animate() render loop and ResizeObserver
- setCameraView({ projection, azimuthDeg, elevationDeg, rollDeg, zoom, target, heightFraction, distanceScale }) for source-matched camera setup
- addLabel(...) + _syncLabels() floating label system
- showPopup(title, body), hidePopup(), showTooltip(text, event), hideTooltip()
- registerInteractive(object, { title, body, tooltip, onClick? }) with built-in raycast hover/click handling

Hard constraints:
- Do not redeclare: addLabel, _labels, _syncLabels, animate, renderer, scene, camera, controls, d, aspect, setCameraView, setStandardView, showPopup, hidePopup, showTooltip, hideTooltip, registerInteractive
- Do not add any import statements or importmaps.
- You may change camera.zoom, camera position, controls.target, object scale, and projection parameters only to match the source figure's first-frame crop and perspective. If you change camera.zoom or camera bounds, call camera.updateProjectionMatrix().
- Keep background white (#ffffff).
- Do NOT reproduce the figure as a texture, canvas drawing, or flat PlaneGeometry with a drawn image.
  Every visible element must be constructed as Three.js geometry (meshes, lines, points, sprites).
  Pasting the original image onto a plane is not a valid solution.
- INLINE AUGMENTATION MODE: default output must look like a same-size replacement for the original PDF figure.
- Do NOT put bulky controls, toolbars, step buttons, legends, title cards, or description panels in the UI marker block.
- UI marker block should usually be empty. If controls are genuinely needed, add at most 2 compact sliders/toggles with very short labels; no buttons except hidden/internal triggers. Controls must be visible near an edge, with no filled box over the figure.
- Do not rely on the PDF reader to fix composition after generation. The generated HTML itself must have the right default camera, framing, label scale, and minimal UI.
- CAMERA / VIEW MATCHING REQUIREMENTS:
  - The first rendered frame must be a drop-in visual replacement for the source image.
  - Match the original figure's camera angle, crop, zoom, object scale, and apparent perspective. The scaffold camera is orthographic; simulate weak perspective through azimuth, elevation, object scale, and line/face geometry rather than switching camera classes.
  - If CAMERA VIEW PARAMETERS are provided below, call setCameraView(...) with those values AFTER adding all geometry and labels. Tune only if the source image clearly demands it.
    Convert keys exactly:
      azimuth_deg -> azimuthDeg
      elevation_deg -> elevationDeg
      roll_deg -> rollDeg
      height_fraction -> heightFraction
  - Estimate the source view from visible cues: parallel lines imply orthographic or weak perspective; converging lines imply perspective; apparent ellipse/face shapes imply camera elevation and azimuth.
  - Align key visual anchors (main object center, axes, vanishing directions, horizon/ground plane, labels, arrow endpoints, and panel boundaries) to the same relative positions in the iframe.
  - Frame the scene so it matches the original figure crop. Do not force-fill if the original has whitespace; preserve the source figure's margins, aspect, and label density.
- Explanations must use the scaffold helpers: registerInteractive(object, { title, body, tooltip }) for meaningful objects, or showPopup(title, body) for custom click flows. Do not create visible explanation panels inside the figure.
- Interactions should be intuitive direct manipulation: OrbitControls drag/rotate, click a meaningful part, hover a label/vector/surface. No decorative animations.

Your task:
1) Consider the given plan and what the figure is conceptually intended to illustrate.
2) Before writing any code, decide the Three.js primitive for every element in the plan.
   Ask: is this a line, a mesh, a point, an arrow? What geometry class? What approximate size and color?
   Express this as brief inline comments at the top of your JS block, one line per element, e.g.:
     // pinhole → SphereGeometry(0.07)  black
     // ray     → Line  dashed  grey
     // plane   → PlaneGeometry(4,3)  blue opacity 0.3
   Then build exactly those primitives — do not deviate from your own spec.
3) Remember that you are converting a 2D image into a 3D, interactive figure. First infer the camera location and angle, then reason about how that viewpoint changes the shapes you should draw: where the viewer is, how high the eye point is, and whether the view is tilted, rotated, or centered.
4) Build the static geometry first. Count the visible primitives and line segments, preserve relative scale and spacing, and take note of depth ordering and occlusion. Use projection logic to decide which edges should converge, which faces should be foreshortened, and which dimensions should compress in depth.
5) Set camera view/zoom/crop to match the source view before adding interactions. Tune azimuth, elevation, distance, target, and object scale until the first frame overlays the source image's shape and composition. Use setCameraView(...) instead of manually positioning camera whenever camera_view is present in the plan. Example:
   setCameraView({
     projection: 'orthographic',
     azimuthDeg: 35,
     elevationDeg: 18,
     rollDeg: 0,
     zoom: 1.05,
     target: [0, 0, 0],
     heightFraction: 0.62
   });
6) Add ALL visible text labels using addLabel(htmlString, THREE.Vector3, options?).
    Missing or incorrect labels are a critical failure.  Make sure to match the font size with the original image. Treat labels and annotations as spatial cues so their placement reinforces the geometry and depth.
7) Render a source-matching first frame. Only after that, add interactivity:
   - Use direct manipulation first: OrbitControls, hover highlight, click-to-explain.
   - Every direct manipulation interaction must explain the concept on hover/click without adding a visible explainer panel.
   - Register every major explanatory mesh/line/group with registerInteractive(object, { title, body, tooltip }).
   - At least one meaningful object MUST produce a click popup with 2-3 sentences explaining the concept.
   - Use showPopup(title, body) only for custom click flows; otherwise prefer registerInteractive.
   - Add compact sliders/toggles only for real figure parameters (e.g. wavelength, angle, sharpness); place them near an edge without a filled panel so they do not cover geometry, labels, or equations.
   - Keep one state object + updateScene() if hidden states are needed.
   - If demo_steps are provided, make them callable from clicks on meaningful scene elements, not visible toolbar buttons.

Output format (return ONLY this, nothing else):
${UI_BEGIN_MARKER}
...UI HTML...
${UI_END_MARKER}
${CODE_BEGIN_MARKER}
...JavaScript...
${CODE_END_MARKER}`;

// === Code Divider =============================================================
function buildGenerationSystemPrompt(scaffold) {
    if (!scaffold) throw new Error('scaffold is required.');

    const header = buildPromptHeader({
        scaffold,
        scaffoldIntro: `BASE SCAFFOLD - DO NOT copy this file into your response.
The backend will keep this scaffold and insert your payload at the markers:
- UI:   ${UI_BEGIN_MARKER} ... ${UI_END_MARKER}
- CODE: ${CODE_BEGIN_MARKER} ... ${CODE_END_MARKER}
Only output the marker blocks. Do NOT modify, remove, or re-declare anything already in the scaffold.`,
    });

    return `${header}

SCAFFOLD USAGE RULES:
- Do NOT output the scaffold.
- Output ONLY the marker-wrapped payload (UI + JS).
- The scaffold already includes the importmap and imports for Three.js + OrbitControls.
    Do NOT add another <script type="importmap"> or any import statements.
- Do NOT re-declare scaffold globals; only add objects to scene and wire UI to state.

${GENERATION_TASK_GUIDE}`;
}
// === Code Divider =============================================================
function buildGenerationRefinementPrompt(scaffold, prevHtml, evaluation) {
    if (!scaffold) throw new Error('scaffold is required.');
    if (!prevHtml) throw new Error('prevHtml is required.');
    if (!evaluation) throw new Error('evaluation is required.');

    const issues = [
        ...(evaluation.failure_modes || []).map(m => `- ${m}`),
        `- geometry_accuracy: ${evaluation.geometry_accuracy}/5`,
        `- interactivity_usability: ${evaluation.interactivity_usability}/5`,
        `- faithfulness: ${evaluation.faithfulness}/5`,
        `- label_quality: ${evaluation.label_quality}/5`,
        `- concept_accuracy: ${evaluation.concept_accuracy}/5`,
        `- notes: ${evaluation.notes || ''}`,
    ].join('\n');

    const prevPayload = extractPayloadFromHtml(prevHtml);
    const prevPayloadText = prevPayload
        ? formatPayload(prevPayload)
        : '(Could not find scaffold markers in previous HTML. Output a fresh payload using the required markers.)';

    const header = buildPromptHeader({
        scaffold,
        roleSuffix: 'improving a previous attempt based on critic feedback.',
        scaffoldIntro: `The BASE SCAFFOLD is fixed and will be used at runtime. Do NOT output it.
Only output an improved payload for these markers:
- UI:   ${UI_BEGIN_MARKER} ... ${UI_END_MARKER}
- CODE: ${CODE_BEGIN_MARKER} ... ${CODE_END_MARKER}`,
        framedScaffold: false,
    });

    return `${header}

CRITIC FEEDBACK ON PREVIOUS ATTEMPT:
${issues}

PREVIOUS GENERATED PAYLOAD (edit this; do NOT output full HTML):
${prevPayloadText}

Fix all identified failure modes and improve every score. Maintain or improve what already works well.
Return ONLY the updated marker-wrapped payload.`;
}

function buildPlanInjection(plan) {
    if (!plan) return '';
    const parts = [];
    if (plan.contextChunk) {
        parts.push(`CONTEXT FROM TEXTBOOK:\n${plan.contextChunk.slice(0, 3000)}`);
    }
    if (plan.interactionPlan) {
        const ip = plan.interactionPlan;
        // Spell out each section explicitly so the generator doesn't conflate them
        const sections = [];
        if (ip.elements?.length) {
            sections.push(`ELEMENTS TO RECREATE IN 3D:\n${ip.elements.map(e => `  - ${e}`).join('\n')}`);
        }
        if (ip.interactions?.length) {
            sections.push(`DISCRETE CONTROLS (implement every one of these in #ui, each must work independently):\n${JSON.stringify(ip.interactions, null, 2)}`);
        }
        if (ip.demo_steps?.length) {
            sections.push(`DEMO STEPS (tween through these using goToStep(); each step drives the controls above):\n${JSON.stringify(ip.demo_steps, null, 2)}`);
        }
        if (ip.camera_view) {
            sections.push(`CAMERA VIEW PARAMETERS (source-image estimate; call setCameraView with these after building geometry):\n${JSON.stringify(ip.camera_view, null, 2)}`);
        }
        if (ip.camera_suggestion) {
            sections.push(`CAMERA: ${ip.camera_suggestion}`);
        }
        if (ip.notes) {
            sections.push(`NOTES: ${ip.notes}`);
        }
        parts.push(sections.join('\n\n'));
    }
    return parts.join('\n\n');
}

function buildGenerationUserText(plan) {
    if (!plan) {
        return 'Analyse this figure carefully. Then output ONLY the scaffold fill-in payload using the required markers. No explanation, no markdown, no fences.';
    }
    return `${buildPlanInjection(plan)}\n\nFollow the interaction plan above. Output ONLY the scaffold fill-in payload using the required markers. No explanation, no markdown, no fences.`;
}
// Strip accidental markdown fences and return raw content.
function stripFences(text) {
    if (typeof text !== 'string') return '';

    // Full fenced block
    const fullFence = text.match(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
    if (fullFence) return fullFence[1].trim();

    // Any fenced block (fallback)
    const anyFence = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
    if (anyFence) return anyFence[1].trim();

    return text.trim();
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBetweenMarkers(text, beginMarker, endMarker) {
    if (!text) return null;
    const re = new RegExp(`${escapeRegExp(beginMarker)}([\\s\\S]*?)${escapeRegExp(endMarker)}`, 'm');
    const match = String(text).match(re);
    if (!match) return null;
    return match[1].trim();
}

function extractPayloadFromText(text) {
    const uiHtml = extractBetweenMarkers(text, UI_BEGIN_MARKER, UI_END_MARKER);
    const codeJs = extractBetweenMarkers(text, CODE_BEGIN_MARKER, CODE_END_MARKER);
    if (uiHtml == null && codeJs == null) return null;
    return { uiHtml: uiHtml ?? '', codeJs: codeJs ?? '' };
}

function extractPayloadFromHtml(html) {
    const payload = extractPayloadFromText(html);
    if (!payload) return null;
    return payload;
}

function formatPayload({ uiHtml = '', codeJs = '' } = {}) {
    return `${UI_BEGIN_MARKER}\n${uiHtml || ''}\n${UI_END_MARKER}\n${CODE_BEGIN_MARKER}\n${codeJs || ''}\n${CODE_END_MARKER}`;
}

function replaceBetweenMarkers(source, beginMarker, endMarker, replacement) {
    const re = new RegExp(`(${escapeRegExp(beginMarker)})([\\s\\S]*?)(${escapeRegExp(endMarker)})`, 'm');
    if (!re.test(source)) {
        throw new Error(`Scaffold is missing required markers: ${beginMarker} ... ${endMarker}`);
    }
    const body = (replacement || '').trim();
    const middle = body ? `\n${body}\n` : `\n`;
    return String(source).replace(re, `$1${middle}$3`);
}

function mergePayloadIntoScaffold(scaffold, payload) {
    let merged = scaffold;
    merged = replaceBetweenMarkers(merged, UI_BEGIN_MARKER, UI_END_MARKER, payload?.uiHtml ?? '');
    merged = replaceBetweenMarkers(merged, CODE_BEGIN_MARKER, CODE_END_MARKER, payload?.codeJs ?? '');
    return merged;
}

function looksLikeFullHtmlDocument(text) {
    const prefix = String(text || '').trimStart().slice(0, 300).toLowerCase();
    return prefix.includes('<!doctype html') || prefix.includes('<html');
}

// Fix common model mistakes that can break generated scenes.
function fixGeneratedHtml(html) {
    let fixed = html;

    // Remove duplicate addLabel redeclarations (keep first occurrence from scaffold).
    const addLabelDupes = [...fixed.matchAll(/^[ \t]*(function addLabel\b[^{]*\{)/gm)];
    if (addLabelDupes.length > 1) {
        for (let i = addLabelDupes.length - 1; i >= 1; i--) {
            const start = addLabelDupes[i].index;
            let depth = 0;
            let end = start;
            for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
                if (fixed[j] === '{') depth++;
                if (fixed[j] === '}') {
                    depth--;
                    if (depth === 0) {
                        end = j + 1;
                        break;
                    }
                }
            }
            fixed = fixed.slice(0, start) + '// [auto-removed duplicate addLabel]\n' + fixed.slice(end);
        }
    }

    // Remove duplicate animate redeclarations.
    const animDupes = [...fixed.matchAll(/^[ \t]*(function animate\b[^{]*\{)/gm)];
    if (animDupes.length > 1) {
        for (let i = animDupes.length - 1; i >= 1; i--) {
            const start = animDupes[i].index;
            let depth = 0;
            let end = start;
            for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
                if (fixed[j] === '{') depth++;
                if (fixed[j] === '}') {
                    depth--;
                    if (depth === 0) {
                        end = j + 1;
                        break;
                    }
                }
            }
            fixed = fixed.slice(0, start) + '// [auto-removed duplicate animate]\n' + fixed.slice(end);
        }
    }

    // Remove conflicting updateLabels helpers.
    const updateLabelsDupes = [...fixed.matchAll(/^[ \t]*(function updateLabels\b[^{]*\{)/gm)];
    if (updateLabelsDupes.length > 0) {
        for (let i = updateLabelsDupes.length - 1; i >= 0; i--) {
            const start = updateLabelsDupes[i].index;
            let depth = 0;
            let end = start;
            for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
                if (fixed[j] === '{') depth++;
                if (fixed[j] === '}') {
                    depth--;
                    if (depth === 0) {
                        end = j + 1;
                        break;
                    }
                }
            }
            fixed = fixed.slice(0, start) + '// [auto-removed conflicting updateLabels]\n' + fixed.slice(end);
        }
    }

    // Remove duplicate scaffold interaction helpers if the model redefines them.
    for (const helperName of ['setCameraView', 'setStandardView', 'showPopup', 'hidePopup', 'showTooltip', 'hideTooltip', 'registerInteractive']) {
        const helperDupes = [...fixed.matchAll(new RegExp(`^[ \t]*(function ${helperName}\\b[^{]*\\{)`, 'gm'))];
        if (helperDupes.length > 1) {
            for (let i = helperDupes.length - 1; i >= 1; i--) {
                const start = helperDupes[i].index;
                let depth = 0;
                let end = start;
                for (let j = fixed.indexOf('{', start); j < fixed.length; j++) {
                    if (fixed[j] === '{') depth++;
                    if (fixed[j] === '}') {
                        depth--;
                        if (depth === 0) {
                            end = j + 1;
                            break;
                        }
                    }
                }
                fixed = fixed.slice(0, start) + `// [auto-removed duplicate ${helperName}]\n` + fixed.slice(end);
            }
        }
    }

    fixed = fixed.replace(
        /addLabel\(([^,]+),\s*([^,]+),\s*true\s*\)/g,
        "addLabel($1, $2, { fontSize: '11px' })"
    );

    fixed = fixed.replace(
        /^[ \t]*const labels\s*=\s*\[\s*\]\s*;?\s*$/gm,
        '// [auto-removed: scaffold uses _labels]'
    );

    return fixed;
}

async function generateFigureHtml({
    modelId,
    scaffold,
    mediaType,
    base64,
    plan,
    userText,
    maxTokens = 16384,
    applyFixes = true,
}) {
    if (!modelId) throw new Error('modelId is required.');
    if (!scaffold) throw new Error('scaffold is required.');
    if (!mediaType || !base64) throw new Error('mediaType and base64 are required.');
    const resolvedUserText = userText || buildGenerationUserText(plan);

    if (!resolvedUserText) throw new Error('Could not resolve userText for generation.');

    const userContent = [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text: resolvedUserText },
    ];

    let out = await generateWithModel(modelId, {
        systemPrompt: buildGenerationSystemPrompt(scaffold),
        userContent,
        maxTokens,
    });

    out = stripFences(out);

    let html;
    if (looksLikeFullHtmlDocument(out)) {
        // Backwards-compatible: sometimes models still return a full HTML document.
        html = out;
    } else {
        const payload = extractPayloadFromText(out) || { uiHtml: '', codeJs: out };
        html = mergePayloadIntoScaffold(scaffold, payload);
    }

    if (applyFixes) html = fixGeneratedHtml(html);
    return html;
}

async function generateRefinedFigureHtml({
    modelId,
    scaffold,
    prevHtml,
    evaluation,
    mediaType,
    base64,
    userText,
    maxTokens = 16384,
    applyFixes = true,
}) {
    if (!modelId) throw new Error('modelId is required.');
    if (!scaffold) throw new Error('scaffold is required.');
    if (!prevHtml) throw new Error('prevHtml is required.');
    if (!evaluation) throw new Error('evaluation is required.');
    if (!mediaType || !base64) throw new Error('mediaType and base64 are required.');
    if (!userText) throw new Error('userText is required.');

    const userContent = [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text: userText },
    ];

    let out = await generateWithModel(modelId, {
        systemPrompt: buildGenerationRefinementPrompt(scaffold, prevHtml, evaluation),
        userContent,
        maxTokens,
    });

    out = stripFences(out);

    let html;
    if (looksLikeFullHtmlDocument(out)) {
        html = out;
    } else {
        const payload = extractPayloadFromText(out) || { uiHtml: '', codeJs: out };
        html = mergePayloadIntoScaffold(scaffold, payload);
    }

    if (applyFixes) html = fixGeneratedHtml(html);
    return html;
}

/**
 * Unified generation function that handles both fresh generation and refinement.
 * Routes to the appropriate path based on whether prevHtml and evaluation are provided.
 *
 * @param {{
 *   scaffold: string,
 *   plan?: object,
 *   prevHtml?: string,
 *   evaluation?: object,
 *   modelId?: string,
 *   mediaType?: string,
 *   base64?: string,
 *   userText?: string,
 *   maxTokens?: number,
 *   applyFixes?: boolean,
 * }} opts
 * @returns {Promise<string>} - merged HTML with injected payload
 */
async function generateCode(opts) {
    const {
        scaffold,
        plan,
        prevHtml,
        evaluation,
        modelId,
        mediaType,
        base64,
        userText,
        maxTokens = 16384,
        applyFixes = true,
    } = opts;

    if (!scaffold) throw new Error('scaffold is required');
    if (!modelId) throw new Error('modelId is required');
    if (!mediaType || !base64) throw new Error('mediaType and base64 are required');

    // REFINEMENT MODE: previous generation + evaluation feedback
    if (prevHtml && evaluation) {
        const refinementUserText = userText || buildGenerationUserText(plan);
        return generateRefinedFigureHtml({
            modelId,
            scaffold,
            prevHtml,
            evaluation,
            mediaType,
            base64,
            userText: refinementUserText,
            maxTokens,
            applyFixes,
        });
    }

    // FRESH GENERATION MODE
    const generationUserText = userText || buildGenerationUserText(plan);
    return generateFigureHtml({
        modelId,
        scaffold,
        mediaType,
        base64,
        plan,
        userText: generationUserText,
        maxTokens,
        applyFixes,
    });
}

module.exports = {
    buildGenerationSystemPrompt,
    buildGenerationUserText,
    generateFigureHtml,
    generateRefinedFigureHtml,
    generateCode,
    extractPayloadFromHtml,
    formatPayload,
};
