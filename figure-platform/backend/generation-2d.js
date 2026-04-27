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

SVG SIZING:
  <svg width="100%" height="100%" viewBox="0 0 W H"> — fill the iframe edge-to-edge.
  8px inner padding only. No empty borders. NEVER fixed px on the svg element.

WHAT MUST MATCH THE ORIGINAL — check each one:
  ✓ Every node/shape: position, size, fill color, stroke color, stroke-width
  ✓ Every edge: start point, end point, exact angle and length — use a ruler mentally
  ✓ Every arrowhead: direction, color — if the original has them you MUST reproduce them
  ✓ Every label: exact text, position, font size (10–13px sans-serif)
  ✓ Overall layout proportions — do not compress or stretch the figure

EDGES AND ARROWHEADS — non-negotiable:
  Count the edges in the original. Generate EXACTLY that many. No shortcuts.
  For diagonal edges: compute precise x1,y1,x2,y2 from the node center coordinates.
  If the original has arrowheads, define ONE marker and reuse it on every edge:
    <defs>
      <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#333"/>
      </marker>
    </defs>
    <line x1="…" y1="…" x2="…" y2="…" stroke="#333" stroke-width="1.2" marker-end="url(#arr)"/>
  Match arrow color to the edge color EXACTLY. Do NOT default to blue.

  ARROWHEAD ENDPOINT — generalized for any node size:
  The line must stop at the node's boundary, not at its center. Shorten every line endpoint
  by (nodeRadius + markerRefX) along the edge direction:
    const dx = x2-x1, dy = y2-y1, len = Math.sqrt(dx*dx+dy*dy);
    const pull = nodeRadius + 5;   // nodeRadius = actual radius of the target node in SVG units
    x2 = x2 - (dx/len)*pull;
    y2 = y2 - (dy/len)*pull;
  Use the SAME nodeRadius value you used to draw the circles — do not hardcode a pixel offset.

NODE DECORATIONS:
  Reproduce symbols inside nodes (squiggles, icons) as SVG <path>/<polyline>.
  Read fill colors from the image — never assume white or grey.

━━━ STEP 2 — ADD INTERACTIVITY (after SVG is complete) ━━━━━━━━━━━━━━━━━━━━━━
Default view must already look identical to the original. Interactivity is invisible
until the user acts.

BANNED from default view: titles, toolbars, description boxes, visible buttons, any chrome.

── HOVER ──
  Node hover: stroke +1.5px, subtle fill-opacity shift.
  Outgoing edges only: stroke:#e07b30, +1px width. (Not all edges — too noisy.)
  Tooltip (small, near cursor, 1 line label + ≤6 words):
    CSS: position:fixed; background:rgba(0,0,0,0.50); backdrop-filter:blur(8px);
         color:#fff; font:11px/1.3 sans-serif; padding:3px 8px; border-radius:4px;
         border:1px solid rgba(255,255,255,0.15); pointer-events:none; z-index:100;
         max-width:150px; white-space:nowrap;
    document.addEventListener('mousemove', e => { tt.style.left=(e.clientX+12)+'px'; tt.style.top=(e.clientY-28)+'px'; });

── CLICK → POPUP (postMessage — no inline popup) ──
  function showPopup(title, body) { window.parent.postMessage({ type:'alex-popup', title, body }, '*'); }
  function hidePopup()            { window.parent.postMessage({ type:'alex-popup', title:null  }, '*'); }
  document.addEventListener('keydown', e => { if(e.key==='Escape') hidePopup(); });
  svg.addEventListener('click', e => { if(e.target===svg||e.target.tagName==='svg') hidePopup(); });
  Call showPopup(title, body) on each node/element click.
  DO NOT create any fixed-position popup element inside the HTML.

── CLICK → SIGNAL FLOW (neural networks) ──
  Forward pass (click) = #4a7ef5, Backward (Shift+click) = #e05050.
  Animate left-to-right, layer by layer (delay 0, 650, 1300… ms).
  Node pulse — MUST set transformBox/transformOrigin first or nodes fly to (0,0):
    node.style.transformBox='fill-box'; node.style.transformOrigin='center';
    node.style.transition='transform 0.15s ease'; node.style.transform='scale(1.18)';
    setTimeout(()=>{ node.style.transform='scale(1)'; }, 200);
  Animate edges with stroke-dashoffset only. Never animate cx/cy/x/y/translate.
  After +1200ms restore all edges to original stroke.

── DRAGGABLE NODES ──
  function svgPt(svg,e){const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());}
  On mousedown: record offset = svgPt - node center. On mousemove: update cx/cy and all connected edge endpoints.

━━━ RENDERING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Diagrams, graphs, matrices, flow charts → inline SVG
  • Scatter/line/contour plots → SVG with correct data values from the figure
  • 3D geometry → see THREE.JS SECTION below (only if the blueprint specifies 3D)

━━━ SELF-CHECK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before outputting, verify:
  1. Edge count matches the original exactly? (count them)
  2. Every edge that had an arrowhead has marker-end="url(#arr)"?
  3. Diagonal edge angles look correct — not flattened or steepened?
  4. Every node in the original is present at the right position?
  5. Default view matches original figure — layout, colors, every label?
  6. html/body no margin/padding, background #fff, SVG width/height 100%?
  7. Figure fills viewBox edge-to-edge (8px padding only)?
  8. No title, toolbar, or description visible by default?
  9. All hover/click handlers reference DOM elements that exist?
Fix any NO before outputting — geometry errors (#1–4) matter most.

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
