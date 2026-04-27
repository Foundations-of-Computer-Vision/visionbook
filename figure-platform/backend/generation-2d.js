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
  Choose a viewBox that preserves the original aspect ratio, e.g. viewBox="0 0 400 220".
  <svg width="100%" height="100%" viewBox="0 0 W H"> — fills the iframe edge-to-edge.
  8px inner padding only. NEVER fixed px width/height on the svg element.

  DERIVE ALL COORDINATES FROM THE IMAGE PROPORTIONS:
  Before placing any element, estimate the figure's coordinate grid:
    • Divide the figure visually into a W×H grid (e.g. 400×220 units)
    • Express every node center, edge endpoint, and label as (x/W, y/H) fractions
      then multiply back: cx = fraction_x * W, cy = fraction_y * H
    • Node radius r = (node_diameter_as_fraction_of_W) * W / 2
  This ensures every element is proportionally correct — not guessed in isolation.
  Example for a 3-layer network spanning the full width:
    Input nodes at x=60, hidden at x=180, output at x=320 (for W=400)
    Node radius r=18 if nodes appear to be ~9% of figure width

WHAT MUST MATCH THE ORIGINAL:
  ✓ Node positions: use fraction-based coordinates, not arbitrary guesses
  ✓ Node sizes: radius/width as a fraction of the figure's total width
  ✓ Edge angles: compute from the ACTUAL node center coordinates — never eyeball
  ✓ Every arrowhead: direction, color — reproduce ALL of them
  ✓ Every label: exact text, 10–13px sans-serif, positioned near its element
  ✓ Stroke widths, fill colors: read from the image, do not substitute

EDGES AND ARROWHEADS — non-negotiable:
  Count edges in the original. Generate EXACTLY that many.
  Define ONE reusable marker:
    <defs>
      <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#333"/>
      </marker>
    </defs>
    <line x1="…" y1="…" x2="…" y2="…" stroke="#333" stroke-width="1.2" marker-end="url(#arr)"/>
  Match arrow color to edge color EXACTLY. Never default to blue.

  ARROWHEAD ENDPOINT — stop line at node boundary, not center:
    const dx=x2-x1, dy=y2-y1, len=Math.sqrt(dx*dx+dy*dy);
    const pull = r + 5;  // r = the same nodeRadius variable used to draw the circles
    x2 = x2-(dx/len)*pull;  y2 = y2-(dy/len)*pull;

NODE DECORATIONS:
  Reproduce symbols inside nodes (squiggles, icons) as SVG <path>/<polyline>.
  Read fill colors from the image — never assume white or grey.

━━━ STEP 2 — ADD CONCEPT-DRIVEN INTERACTIVITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Default view looks identical to the original. Interactions reveal on user action only.
BANNED from default view: titles, toolbars, description boxes, visible buttons, any chrome.

THE GOAL OF EVERY INTERACTION IS TO EXPLAIN THE CONCEPT — not to look impressive.
Ask: "does this animation help a student understand what this figure is showing?"
If the answer is no, remove it. No decorative pops, flashes, or bounces.

── HOVER ──
  Node/element hover: stroke +1.5px only — subtle, no fill change.
  Tooltip: small, near cursor, label + one short explanation phrase (≤8 words).
    CSS: position:fixed; background:rgba(0,0,0,0.55); color:#fff; font:11px/1.4 sans-serif;
         padding:3px 8px; border-radius:4px; pointer-events:none; z-index:100; white-space:nowrap;
    document.addEventListener('mousemove', e => { tt.style.left=(e.clientX+12)+'px'; tt.style.top=(e.clientY-28)+'px'; });
  On hover of an edge: briefly highlight that edge only (stroke color, +1px). Nothing else.

── CLICK → POPUP (postMessage) ──
  function showPopup(title, body) { window.parent.postMessage({ type:'alex-popup', title, body }, '*'); }
  function hidePopup()            { window.parent.postMessage({ type:'alex-popup', title:null  }, '*'); }
  document.addEventListener('keydown', e => { if(e.key==='Escape') hidePopup(); });
  svg.addEventListener('click', e => { if(e.target===svg||e.target.tagName==='svg') hidePopup(); });
  Popup body should explain what the clicked element MEANS conceptually — 2–3 sentences.
  DO NOT create any fixed-position popup element inside the HTML.

── CLICK → CONCEPTUAL STATE ANIMATION ──
  Animation must show the concept the figure illustrates, not just look active.
  Use COLOR STATE CHANGES only — no scale transforms, no bouncing, no popping.
  NEVER use: transform scale, translate, or any position change on elements.

  For neural networks / graphs (forward pass on click):
    • Activate nodes layer-by-layer left→right with a fill color change:
        inactive node: original fill (e.g. white)
        active node:   fill → '#c8e0ff' (soft blue — visually shows "receiving signal")
        active edge:   stroke → '#4a7ef5', stroke-width +1
      Transition: node.style.transition = 'fill 0.35s ease'; node.style.fill = '#c8e0ff';
    • Timing: layer 0 at 0ms, layer 1 at 700ms, layer 2 at 1400ms, etc.
    • After +1200ms past last layer, reset all nodes and edges to original colors.
    • Shift+click = backward pass: active color → '#ffc8c8' (soft red).
    This directly shows how information flows through the network — the concept itself.

  For flow charts / pipelines:
    • Click a step → that step's fill brightens, all others dim to 0.4 opacity.
    • No movement, no scale change. Just opacity + fill to show "this is the active step."

  For scatter/line plots:
    • Hover a data point → highlight it + show (x, y) values in tooltip.
    • No animation on load or click — data speaks for itself.

  For matrices / tables:
    • Hover row/column → highlight that row or column with a soft background tint.
    • Click cell → popup explains the value's meaning in context.

── DRAGGABLE NODES (graphs only, when it helps exploration) ──
  function svgPt(s,e){const p=s.createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(s.getScreenCTM().inverse());}
  mousedown: record offset. mousemove: update cx/cy AND all connected edge x1/y1/x2/y2.

━━━ RENDERING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Diagrams, graphs, matrices, flow charts → inline SVG
  • Scatter/line/contour plots → SVG with correct data values from the figure
  • 3D geometry → see THREE.JS SECTION below (only if the blueprint specifies 3D)

━━━ SELF-CHECK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before outputting, verify:
  1. Are node sizes proportionally correct relative to the figure's total width?
  2. Edge count matches the original exactly? (count them)
  3. Every edge that had an arrowhead has marker-end="url(#arr)"?
  4. Diagonal edge angles correct — computed from actual node center coords?
  5. Default view matches original — layout, colors, every label, proportions?
  6. html/body no margin/padding, background #fff, SVG width/height 100%?
  7. Figure fills viewBox edge-to-edge (8px padding only)?
  8. No title, toolbar, or description visible by default?
  9. Does each animation explain the concept, or is it just decorative? Remove decorative ones.
  10. No scale transforms, bounces, or position changes on elements?
Fix any NO before outputting. Proportions (#1) and geometry (#2–4) matter most.

━━━ JAVASCRIPT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Vanilla JS only (no libraries except Three.js when explicitly needed for 3D).
Wrap all JS in try-catch so a runtime error never leaves a blank white page.`;

// ── Three.js boilerplate — injected into user message for 3D figures ────────
const THREEJS_BOILERPLATE = `
━━━ THREE.JS SECTION (3D figures only) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use Three.js r128 from unpkg CDN. Load from:
  https://unpkg.com/three@0.128.0/build/three.min.js
  https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js

NEVER fake 3D with CSS perspective/transform. Build real Three.js meshes.

MANDATORY SETUP — use this verbatim (do not change renderer background or lighting):

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setClearColor(0xffffff, 1);  // WHITE — never change this
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Orthographic camera for isometric academic diagrams:
  const aspect = window.innerWidth / window.innerHeight;
  const d = 8;  // adjust scale to fit the scene
  const camera = new THREE.OrthographicCamera(-d*aspect, d*aspect, d, -d, 0.1, 1000);
  camera.position.set(10, 8, 10);  // standard isometric — tune to match original angle
  camera.lookAt(0, 0, 0);

  // Ambient light ONLY — no directional/spot/point lights (flat academic style):
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));

  // Resize handler (orthographic):
  window.addEventListener('resize', () => {
    const a = window.innerWidth / window.innerHeight;
    camera.left=-d*a; camera.right=d*a; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

MATERIALS — use MeshBasicMaterial (unlit = matches flat diagram style):
  Colored sphere:    new THREE.MeshBasicMaterial({ color:0xcc4444, transparent:true, opacity:0.82 })
  Outline (larger):  new THREE.MeshBasicMaterial({ color:0x222222 })  // placed behind colored sphere
  White/gray node:   new THREE.MeshBasicMaterial({ color:0xeeeeee, transparent:true, opacity:0.90 })
  Box face:          new THREE.MeshBasicMaterial({ color:0xbb7744 })
  Box edges:         new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({color:0x333333}))

NEVER USE: MeshPhongMaterial, MeshStandardMaterial, DirectionalLight, PointLight, SpotLight.
  These produce shiny plastic balls, dark shadows, and look nothing like the original.

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
async function generate2dFigureHtml({ modelId, base64, mediaType, plan, userText, iframeWidth, iframeHeight, maxTokens = 16000 }) {
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

  const planSection = plan
    ? `\n\nFIGURE BLUEPRINT:\n${JSON.stringify(plan, null, 2)}${renderingHint}`
    : renderingHint;

  // Inject Three.js boilerplate into user message only when needed
  const threeSection = has3d ? THREEJS_BOILERPLATE : '';

  const dimHint = (iframeWidth && iframeHeight)
    ? `\nIFRAME SIZE: ${iframeWidth}×${iframeHeight}px — set viewBox="0 0 ${iframeWidth} ${iframeHeight}" and fill ALL of it (8px padding only, no empty borders).`
    : '';

  const message = userText
    ? `${userText}${planSection}${threeSection}`
    : `Reconstruct this figure as an interactive HTML page.${dimHint}${planSection}${threeSection}

STEP 1 — Build the SVG geometry: every node, every edge, every arrowhead, exact angles. Count edges in the original and match exactly.
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
