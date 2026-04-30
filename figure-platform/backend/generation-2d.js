/**
 * generation-2d.js — generates inline-interactive HTML figures
 *
 * The figure is reconstructed from scratch and embedded inside a PDF reader.
 * Default state = looks exactly like the original figure.
 * Interactivity = hover/click reveals tooltips and popups. No app chrome.
 *
 * 2D figures  → clean SVG system prompt (no Three.js noise)
 * 3D figures  → 2D prompt + Three.js boilerplate injected into user message
 * mixed       → 2D prompt + Three.js panel section injected
 */

const { generateWithModel } = require('./models');

const OUTPUT_RULES = `OUTPUT RULES — non-negotiable:
- Your response MUST be ONLY a complete, self-contained HTML file. No explanation, no markdown, no code fences.
- It MUST start with exactly: <!DOCTYPE html>
- It MUST end with exactly: </html>
- Do NOT truncate. Output every single line.
- Do NOT embed the original image. Rebuild every element in code.`;

// ── Core 2D system prompt (clean — no Three.js) ────────────────────────────
const SYSTEM_2D = `You are building an interactive figure that lives inline inside a PDF textbook page.

${OUTPUT_RULES}

━━━ STEP 1 — REPRODUCE THE FIGURE EXACTLY (do this before any JS) ━━━━━━━━━━━━
This is the most important step. Build the complete, pixel-accurate SVG first.
Interactivity is layered on top AFTER the geometry is correct.

  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:#fff; }

SVG SIZING AND PROPORTIONS:
  STEP 1A — SET THE VIEWBOX FROM THE BLUEPRINT (non-negotiable):
  The blueprint includes aspectRatio = originalWidth / originalHeight.
  Use it to compute H:
    const W = 600;
    const H = Math.round(W / plan.aspectRatio);  // e.g. AR=2.0 → H=300, AR=1.5 → H=400
  Set: <svg width="100%" height="100%" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet">
  NEVER invent your own viewBox numbers. The blueprint's aspectRatio is the ground truth.
  If no blueprint is provided, estimate the ratio by looking at the image carefully, then set W=600.

  STEP 1B — SET ELEMENT SIZES FROM THE BLUEPRINT:
  The blueprint includes elementSizes with fractions measured from the original.
  Use them — do NOT re-estimate from the image:
    const r = (plan.elementSizes.nodeRadiusFraction || 0.045) * W;
    const strokeW = plan.elementSizes.strokeWidth || 1.5;
    const fontSize = plan.elementSizes.fontSize || 11;
    const arrSize = plan.elementSizes.arrowheadSize || 6;
  These variables must be used for EVERY node, edge, and label — no hardcoding.

  STEP 1C — DERIVE ALL ELEMENT POSITIONS AS FRACTIONS OF W×H:
  Before placing any element, express its center as (fx, fy) fractions of the figure:
    cx = fx * W,  cy = fy * H
  Read fractional positions by looking at the image:
    "this node center is ~15% from the left and ~50% from top" → cx=0.15*W, cy=0.5*H
  This ensures correct layout regardless of the chosen viewBox scale.

WHAT MUST MATCH THE ORIGINAL:
  ✓ ViewBox aspect ratio: set from plan.aspectRatio — matches original figure proportions
  ✓ Node sizes: set from plan.elementSizes.nodeRadiusFraction * W — never guessed
  ✓ Node positions: fraction-based (fx*W, fy*H) from the image
  ✓ Edge angles: computed from ACTUAL node center coordinates
  ✓ Every arrowhead: direction, color — reproduce ALL of them
  ✓ Every label: exact text, font-size in SVG USER UNITS (NOT px) — see TEXT SIZING below
  ✓ Stroke widths, fill colors: read from the image, do not substitute

TEXT SIZING — critical for readability at all zoom levels:
  SVG font-size in "px" units does NOT scale with the viewBox — it will appear tiny when the
  overlay is small. Always use raw user-unit numbers (no "px" suffix):
    <text font-size="11" font-family="sans-serif">   ← CORRECT (scales with viewBox)
    <text font-size="11px" font-family="sans-serif"> ← WRONG (stays fixed, becomes tiny)
  Scale based on W=600: use fontSize from plan.elementSizes.fontSize (default 11).
  If labels look crowded, reduce to 9. If sparse, use 12. Never below 9 or above 14.

EDGES AND ARROWHEADS — non-negotiable:
  Count edges in the original. Generate EXACTLY that many.
  Define ONE reusable marker, sized from arrSize:
    <defs>
      <marker id="arr" markerWidth="{arrSize}" markerHeight="{arrSize}" refX="{arrSize-1}" refY="{arrSize/2}" orient="auto">
        <path d="M0,0 L0,{arrSize} L{arrSize},{arrSize/2} z" fill="#333"/>
      </marker>
    </defs>
    <line x1="…" y1="…" x2="…" y2="…" stroke="#333" stroke-width="{strokeW}" marker-end="url(#arr)"/>
  Match arrow color to edge color EXACTLY. Never default to blue.

  ARROWHEAD ENDPOINT — stop line at node boundary, not center:
    const dx=x2-x1, dy=y2-y1, len=Math.sqrt(dx*dx+dy*dy);
    const pull = r + arrSize;  // r = nodeRadius, arrSize from blueprint
    x2 = x2-(dx/len)*pull;  y2 = y2-(dy/len)*pull;

NODE DECORATIONS:
  Reproduce symbols inside nodes (squiggles, icons) as SVG <path>/<polyline>.
  Read fill colors from the image — never assume white or grey.

━━━ STEP 2 — ADD CONCEPT-DRIVEN INTERACTIVITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Default view looks identical to the original. Interactions reveal on user action only.
BANNED from default view: titles, toolbars, description boxes, visible buttons, any chrome.

PRINCIPLE: every interaction must help a student understand what the figure is showing.
Before writing any JS, ask for each element: "what does interacting with this teach?"
If the answer is nothing, skip it. Never add animation for visual effect alone.

── HOVER — label and context ──
  Any hoverable element: stroke or opacity shift only (+1.5px stroke, or opacity 0.7→1).
  No fill changes, no movement, no scale on hover.
  Tooltip near cursor — name of the element + one short phrase explaining its role:
    CSS: position:fixed; background:rgba(0,0,0,0.55); color:#fff; font:11px/1.4 sans-serif;
         padding:3px 8px; border-radius:4px; pointer-events:none; z-index:100; white-space:nowrap;
    document.addEventListener('mousemove', e => { tt.style.left=(e.clientX+12)+'px'; tt.style.top=(e.clientY-28)+'px'; });

── CLICK → POPUP (postMessage) ──
  function showPopup(title, body) { window.parent.postMessage({ type:'alex-popup', title, body }, '*'); }
  function hidePopup()            { window.parent.postMessage({ type:'alex-popup', title:null  }, '*'); }
  document.addEventListener('keydown', e => { if(e.key==='Escape') hidePopup(); });
  svg.addEventListener('click', e => { if(e.target===svg||e.target.tagName==='svg') hidePopup(); });
  Click popup body: 2–3 sentences explaining what the element means conceptually.
  DO NOT create any fixed-position popup element inside the HTML.

── CLICK → STATE / SEQUENCE ANIMATION ──
  Only add this if the figure shows a PROCESS, FLOW, or SEQUENCE that can be stepped through.
  The animation should reveal the concept — what happens when something in this system activates.

  HOW TO DESIGN IT FOR ANY FIGURE TYPE:
  1. Look at the figure and identify: what is the thing that changes or propagates?
     (signal flowing, a step executing, a region activating, a path being traced, etc.)
  2. Show ONLY that change — use fill or stroke color transitions.
     active state: soft highlight color (e.g. '#c8e0ff' blue or '#c8f0c8' green)
     inactive state: original colors
     Transition: element.style.transition = 'fill 0.35s ease, stroke 0.35s ease';
  3. If there is a natural sequence (step 1 → step 2 → step 3), reveal it with timed delays.
     Each step should wait for the previous to complete before highlighting the next.
  4. After the full sequence, reset everything to original colors.

  NEVER USE: scale transform, translate, bounce, pop, or any position/size change.
  NEVER animate just because it looks active — only animate what the concept requires.

── CLICK → POPUP (postMessage) ──
  Already defined above — call showPopup(title, body) on meaningful element clicks.

━━━ RENDERING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Diagrams, graphs, matrices, flow charts → inline SVG
  • Scatter/line/contour plots → SVG with correct data values from the figure
  • 3D geometry → see THREE.JS SECTION below (only if the blueprint specifies 3D)

━━━ SELF-CHECK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before outputting, verify:
  1. ViewBox set from plan.aspectRatio? (W=600, H=600/AR) — not an invented number?
  2. Node radius = plan.elementSizes.nodeRadiusFraction * 600? Not a hardcoded guess?
  3. Edge count matches the original exactly? (count them)
  4. Every edge that had an arrowhead has marker-end="url(#arr)"?
  5. Diagonal edge angles correct — computed from actual node center coords?
  6. Default view matches original — layout, colors, every label, proportions?
  7. html/body no margin/padding, background #fff, SVG width/height 100%?
  8. SVG has preserveAspectRatio="xMidYMid meet"?
  9. No title, toolbar, or description visible by default?
  10. Does each animation explain the concept, or is it just decorative? Remove decorative ones.
  11. No scale transforms, bounces, or position changes on elements?
Fix any NO before outputting. ViewBox (#1) and element sizes (#2) are the most critical — wrong here = wrong everywhere.

━━━ JAVASCRIPT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Vanilla JS only (no libraries except Three.js when explicitly needed for 3D).
Wrap all JS in try-catch so a runtime error never leaves a blank white page.`;

// ── Three.js boilerplate — injected into user message for 3D figures ────────
const THREEJS_BOILERPLATE = `
━━━ THREE.JS SECTION (3D figures only) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use Three.js r171 via importmap (ESM). This version uses pointer-event capture
so drag-to-rotate works even when the cursor leaves the iframe boundary.

NEVER fake 3D with CSS perspective/transform. Build real Three.js meshes.
NEVER use <script src="...three.min.js">. Always use the importmap below.

MANDATORY HTML STRUCTURE — copy this verbatim into <head>:

  <script type="importmap">
  {"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.171.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.171.0/examples/jsm/"}}
  </script>

MANDATORY SCRIPT — use <script type="module"> and this exact setup:

  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

  // Canvas fills the entire iframe — required for rotation to work
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0xffffff, 1);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  // Orthographic camera for isometric academic diagrams:
  let d = 8;  // adjust to fit your scene
  let aspect = canvas.clientWidth / canvas.clientHeight;
  const camera = new THREE.OrthographicCamera(-d*aspect, d*aspect, d, -d, 0.1, 1000);
  camera.position.set(10, 8, 10);
  camera.lookAt(0, 0, 0);

  // OrbitControls — ALWAYS include for rotation. enableDamping = smooth inertia.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  // Ambient light ONLY (flat academic style — no shadows):
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));

  // Render loop — controls.update() required for damping:
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize handler:
  new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    aspect = w / h;
    camera.left=-d*aspect; camera.right=d*aspect; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }).observe(canvas);

REQUIRED CSS (add to <style>):
  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:#fff; }
  #c { width:100%; height:100%; display:block; }

MATERIALS — use MeshBasicMaterial (unlit = matches flat diagram style):
  Colored sphere:    new THREE.MeshBasicMaterial({ color:0xcc4444, transparent:true, opacity:0.82 })
  White/gray node:   new THREE.MeshBasicMaterial({ color:0xeeeeee, transparent:true, opacity:0.90 })
  Box face:          new THREE.MeshBasicMaterial({ color:0xbb7744 })
  Box edges:         new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({color:0x333333}))

NEVER USE: MeshPhongMaterial, MeshStandardMaterial, DirectionalLight, PointLight, SpotLight.

CAMERA ANALYSIS — before writing any code, output this comment:
  // x-axis→[dir], y-axis→[dir], z-axis→[dir]
  // elevation ~[N]°, azimuth ~[N]°
  // camera.position.set([x],[y],[z])

For loss surface / paraboloid:  L = a*(φ₀-opt₀)² + b*(φ₁-opt₁)²
  Build as BufferGeometry 60×60 grid. Color: dark rust ~#8b2a1a.
  Gradient path: small MeshBasicMaterial spheres placed ON the surface.

For multi-panel with mixed 2D+3D:
  Each panel = a <div> in a CSS grid. 3D panels get their own <canvas>.
  new THREE.WebGLRenderer({ canvas: panelCanvas }) — render into that canvas only.`;

/**
 * Generate a figure-faithful interactive HTML page.
 */
async function generate2dFigureHtml({ modelId, base64, mediaType, plan, userText, maxTokens = 16000 }) {
  if (!modelId) throw new Error('modelId is required.');
  if (!base64 || !mediaType) throw new Error('base64 and mediaType are required.');

  // Determine if Three.js is needed
  const renderingMode = plan?.renderingMode || 'auto';
  const has3d = renderingMode === '3d' || renderingMode === 'mixed' ||
    plan?.panels?.some(p => p.renderingMode === '3d');

  // Build rendering hint for user message
  let renderingHint = '';
  if (renderingMode === '3d') {
    const cam = plan?.cameraAnalysis || '';
    renderingHint = `\nRENDERING MODE: 3D — use Three.js (see THREE.JS SECTION above).${cam ? '\nCAMERA HINT: ' + cam : ''}`;
  } else if (renderingMode === 'mixed') {
    const panels3d = (plan?.panels || []).filter(p => p.renderingMode === '3d');
    renderingHint = `\nRENDERING MODE: Mixed — panels ${panels3d.map(p => p.id).join(',')} need Three.js canvas; others use SVG.` +
      panels3d.filter(p => p.cameraAnalysis).map(p => `\nPanel ${p.id} camera: ${p.cameraAnalysis}`).join('');
  } else if (renderingMode === '2d') {
    renderingHint = '\nRENDERING MODE: 2D — use inline SVG. Do NOT use Three.js.';
  }

  // Extract concrete geometry constraints from plan to inject as hard numbers
  const aspectRatio = plan?.aspectRatio;
  const H_from_ar = aspectRatio ? Math.round(600 / aspectRatio) : null;
  const nodeR = plan?.elementSizes?.nodeRadiusFraction
    ? Math.round(plan.elementSizes.nodeRadiusFraction * 600)
    : null;
  const strokeW = plan?.elementSizes?.strokeWidth || null;
  const fontSize = plan?.elementSizes?.fontSize || null;
  const arrSize = plan?.elementSizes?.arrowheadSize || null;

  const geometryConstraints = (aspectRatio || nodeR)
    ? `\nGEOMETRY CONSTRAINTS (from blueprint measurements — use these exact values):` +
      (H_from_ar ? `\n  viewBox="0 0 600 ${H_from_ar}"  ← from aspectRatio=${aspectRatio}` : '') +
      (nodeR    ? `\n  nodeRadius = ${nodeR}px  ← from nodeRadiusFraction=${plan.elementSizes.nodeRadiusFraction}` : '') +
      (strokeW  ? `\n  strokeWidth = ${strokeW}` : '') +
      (fontSize ? `\n  fontSize = ${fontSize}px` : '') +
      (arrSize  ? `\n  arrowheadSize = ${arrSize}` : '')
    : '';

  const planSection = plan
    ? `\n\nFIGURE BLUEPRINT:\n${JSON.stringify(plan, null, 2)}${renderingHint}${geometryConstraints}`
    : renderingHint;

  // Inject Three.js boilerplate into user message only when needed
  const threeSection = has3d ? THREEJS_BOILERPLATE : '';

  const message = userText
    ? `${userText}${planSection}${threeSection}`
    : `Reconstruct this figure as an interactive HTML page.${planSection}${threeSection}

STEP 1 — Build the SVG geometry using the viewBox and element sizes from GEOMETRY CONSTRAINTS above. Every node, every edge, every arrowhead, exact angles.
STEP 2 — Add hover tooltips, click postMessage popup, and signal-flow animation on top.
No title, no description, no buttons by default. Do NOT embed the image.`;

  const userContent = [
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
    { type: 'text', text: message },
  ];

  let html = await generateWithModel(modelId, {
    systemPrompt: SYSTEM_2D,
    userContent,
    maxTokens,
  });

  // Strip accidental markdown fences
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) html = fenced[1].trim();
  html = html
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  return html;
}

module.exports = { generate2dFigureHtml };
