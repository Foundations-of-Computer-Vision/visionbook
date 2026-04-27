const { generateWithModel } = require('./models');

// === Code Divider =============================================================
const BASE_ROLE = 'You are an expert Three.js developer who converts 2D textbook figures into interactive 3D web visualizations.';
// === Code Divider =============================================================
const BASE_OUTPUT_RULES = `OUTPUT RULES - non-negotiable:
- Your response MUST be ONLY a complete HTML file. No explanation, no markdown, no code fences.
- It MUST start with exactly: <!DOCTYPE html>
- It MUST end with exactly: </html>
- Do NOT truncate. Output every line.`;

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
const GENERATION_TASK_GUIDE = `What the scaffold already provides (do NOT re-declare or re-implement):
- THREE + OrbitControls imports via importmap
- WebGLRenderer on <canvas id="c">
- Orthographic camera - tune: d (view half-size), camera.position, camera.zoom
- Damped OrbitControls render loop
- animate() function with requestAnimationFrame + _syncLabels()
- addLabel(html, position, options?) helper -> pushes to _labels[]
- _syncLabels() called each frame inside animate()
- ResizeObserver resize handler keeping camera + renderer in sync
- White background, full-page <canvas id="c">

CRITICAL - DO NOT redefine any of these identifiers:
    addLabel, _labels, _syncLabels, animate, renderer, scene, camera, controls, d, aspect
    Redefining them causes a SyntaxError or silently breaks the scene.
    Just CALL them and ADD new objects to scene.

YOUR TASK - extend the scaffold for the uploaded figure:

STEP 1 - ANALYSE THE FIGURE
    Look carefully at every element: axes, planes, surfaces, points, lines,
    arrows, curves, labels, colours, and the geometric relationships between them.
    Identify the core concept being illustrated.

STEP 2 - PLAN GEOMETRY - map each 2D element to a Three.js primitive:
    axis/arrow    -> THREE.ArrowHelper
    line segment  -> THREE.Line with BufferGeometry
    dashed line   -> LineDashedMaterial (call .computeLineDistances())
    flat plane    -> PlaneGeometry + MeshBasicMaterial(transparent, DoubleSide)
    solid surface -> appropriate BufferGeometry + MeshBasicMaterial
    point / dot   -> SphereGeometry, radius 0.04-0.08
    curve         -> CatmullRomCurve3 -> TubeGeometry
    Set d and camera.position so the whole scene is comfortably framed.
    Match colours from the original figure. Keep background white (#ffffff).

STEP 3 - LABELS - THIS IS CRITICAL, follow exactly:

    3a. LABEL AUDIT - before writing any code:
            - List EVERY text label visible in the original figure: axis names, point
                names, variable names, coordinate labels, titles, annotations, dimensions.
            - Verify each axis label matches the correct geometric direction - if the
                figure shows "x1" pointing right, your label must also point right.
            - If the figure uses subscripted names (x1, x2, x3) instead of (x, y, z),
                reproduce the EXACT names from the figure.
            - Missing or mislabeled text is a critical failure.

    3b. USE THE SCAFFOLD'S LABEL SYSTEM - do NOT create your own.
            The scaffold already provides addLabel() and _syncLabels(). Call the
            scaffold's addLabel exactly like this:

                addLabel('x<sub>1</sub>', new THREE.Vector3(5, 0, 0), { bold: true });
                addLabel('origin',        new THREE.Vector3(0, 0, 0), { fontSize: '11px', color: '#888' });

            Signature:  addLabel(htmlString, THREE.Vector3, options?)
                options.color      - css color   (default '#111')
                options.fontSize   - css string  (default '13px')
                options.bold       - boolean     (default false)
                options.offset     - [dx,dy] px  (default [0,0])
                options.background - css string  (default 'none')

            DO NOT redefine addLabel, _syncLabels, _labels, updateLabels, or animate.
                They already exist in the scaffold. Redefining them causes fatal JS errors.
                Just CALL addLabel() in your code below the scaffold marker comment.

    3c. LABEL CONTENT RULES:
            - Use HTML entities for maths: 'x<sub>1</sub>', '&theta;', '&lambda;',
                '<i>f</i>', '&pi;', 'R<sup>2</sup>', '&#x2192;' (arrow).
            - Offset label positions 0.15-0.25 units away from their anchor point
                so text does not overlap geometry.
            - Every axis arrow MUST have a label at its tip.
            - Every named point, vector, plane, or region in the figure MUST have a label.

STEP 4 - INTERACTIVITY (unified system — interactions + demo are ONE thing):

    The plan gives you two keys: "interactions" and "demo_steps".
    They must form a single unified system — the demo drives the interactions, not a separate UI.

    4a. BUILD DISCRETE CONTROLS from plan.interactions:
        - Render each control in #ui as a styled element (slider, toggle, or button)
        - Every control has a live event listener that immediately updates the scene
        - Store each control's current value in a plain JS object: const state = { id: defaultValue, ... }
        - Example slider:
            <label>Angle <span id="angleVal">0</span>°</label>
            <input type="range" min="0" max="360" step="1" value="0" id="angleSlider"
                   oninput="state.angle=+this.value; document.getElementById('angleVal').textContent=this.value; updateScene()">
        - updateScene() reads from state and repositions / recolours geometry accordingly

    4b. BUILD GUIDED DEMO from plan.demo_steps — layered on top of 4a:
        - Add a narration card ABOVE the controls:
            <div id="narration" style="..."> step title + narration text </div>
        - Add "◀" and "▶" buttons to step through demo_steps
        - Each step calls goToStep(i) which:
            1. ANIMATES each control smoothly to the target control_values using
               requestAnimationFrame tweening (lerp over ~600ms) — NOT a hard snap
            2. Calls updateScene() every animation frame during the tween
            3. Updates the narration card with the step's title and narration text
            4. Updates the control DOM elements (slider position, toggle state) to match
        - Narration card style: position absolute, bottom of #ui, dark background
          (#1a1a1a), white text, 13px, padding 10px 14px, border-radius 8px,
          border-left 3px solid #4a9eff, max-width 260px, line-height 1.5
        - Step title: bold 13px white. Narration body: 12px #ccc, margin-top 4px.

    4c. NEVER make the demo and the interactions two separate systems.
        The demo must tween through the exact same state object that the controls use.
        goToStep() sets state values; updateScene() reads them — same path as manual control.

STEP 5 - CODE STYLE
    - Add brief JS comments explaining what each block of code teaches.
    - Prefer conceptual clarity over visual realism.`;

// === Code Divider =============================================================
function buildGenerationSystemPrompt(scaffold) {
    if (!scaffold) throw new Error('scaffold is required.');

    const header = buildPromptHeader({
        scaffold,
        scaffoldIntro: `BASE SCAFFOLD - copy this file VERBATIM, then insert your code at the marked
location: "// ADD YOUR SCENE OBJECTS, GEOMETRY, LABELS, AND INTERACTION LOGIC BELOW HERE"
Do NOT modify, remove, or re-declare anything already in the scaffold.`,
    });

    return `${header}

SCAFFOLD USAGE RULES:
- Copy the BASE SCAFFOLD below in full, then add your code where indicated.
- The scaffold already includes the importmap and imports for Three.js + OrbitControls.
  Do NOT add duplicate <script type="importmap"> or duplicate import statements.
  If you need additional Three.js addons, import them from 'three/addons/...'.

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

    const header = buildPromptHeader({
        scaffold,
        roleSuffix: 'improving a previous attempt based on critic feedback.',
        scaffoldIntro: 'The BASE SCAFFOLD must still be used as the foundation:',
        framedScaffold: false,
    });

    return `${header}

CRITIC FEEDBACK ON PREVIOUS ATTEMPT:
${issues}

PREVIOUS HTML (improve this, do not start from scratch unless it is fundamentally broken):
${prevHtml}

Fix all identified failure modes and improve every score. Maintain or improve what already works well.`;
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
        return 'Analyse this figure carefully. Then output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.';
    }
    return `${buildPlanInjection(plan)}\n\nFollow the interaction plan above. Output the complete extended HTML file — starting with <!DOCTYPE html> and ending with </html>. No explanation, no markdown, no fences.`;
}
// Strip accidental markdown fences and extract the HTML body.
function stripFences(text) {
    const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    return text
        .replace(/^```html\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
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

    let html = await generateWithModel(modelId, {
        systemPrompt: buildGenerationSystemPrompt(scaffold),
        userContent,
        maxTokens,
    });

    html = stripFences(html);
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

    let html = await generateWithModel(modelId, {
        systemPrompt: buildGenerationRefinementPrompt(scaffold, prevHtml, evaluation),
        userContent,
        maxTokens,
    });

    html = stripFences(html);
    if (applyFixes) html = fixGeneratedHtml(html);
    return html;
}

module.exports = {
    buildGenerationSystemPrompt,
    buildGenerationUserText,
    generateFigureHtml,
    generateRefinedFigureHtml,
};
