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

━━━ THE PRIME DIRECTIVE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The default view MUST look like the original figure — same layout, same proportions,
same colors, same labels. A reader glancing at the page should see the figure, not
an app. The interactivity is invisible until they interact.

BANNED from the default view:
  ✗ Title text (the PDF caption already has a title)
  ✗ Subtitle or instruction text ("Click to explore…")
  ✗ Description boxes or lesson panels
  ✗ Toolbars, sidebars, or control panels
  ✗ Buttons visible by default
  ✗ Any UI chrome that wasn't in the original figure

━━━ SIZING — MANDATORY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The iframe dimensions are provided in the prompt. Your HTML MUST fill every pixel of it.

  html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:#fff; }

SVG SIZING:
  Use the exact viewBox told to you in the prompt: <svg width="100%" height="100%" viewBox="0 0 W H">
  Lay out elements so they span edge-to-edge with only 8px padding — no empty space around the content.
  NEVER use fixed pixel width/height on the <svg> element itself.

For canvas/Three.js: renderer.setSize(window.innerWidth, window.innerHeight)
  + resize listener that updates renderer and camera on window resize.
For multi-panel: outer container width:100%; height:100%; display:grid — no fixed px sizes.

━━━ WHAT THE DEFAULT VIEW MUST REPRODUCE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Exact spatial layout and proportions of the original
  • Same colors, line weights, fill patterns, node sizes
  • Every label, axis tick, node number, legend item — nothing missing
  • Font: small sans-serif, 10–13px, matching the textbook style
  • 8px inner padding inside the SVG viewBox (not on html/body)

EDGES AND ARROWS — critical:
  • If the original has arrowheads on edges, you MUST define SVG <marker> elements and apply
    marker-end (or marker-start) to every edge line/path. Example:
      <defs>
        <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="#999"/>
        </marker>
      </defs>
      <line ... marker-end="url(#arr)" stroke="#999" stroke-width="1"/>
  • Match arrowhead color and edge color EXACTLY to what you see in the original image
  • Do NOT default to blue — read the actual edge color from the figure

NODE DECORATIONS — critical:
  • If nodes have symbols inside them (activation squiggles, checkmarks, icons), reproduce
    them as SVG <path> or <polyline> elements centered inside the node circle
  • Read node fill colors directly from the image — do not assume or substitute
  • Read every text label character-for-character from the original — do NOT invent or paraphrase

━━━ INTERACTIVITY & ANIMATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Default view looks exactly like the original. Interactivity reveals on hover/click only.

Store connectivity as a JS object — required for all graph interactions:
  const graph = {
    'x':  { out:['h1','h2'], in:[],           label:'x',  role:'Input — raw data' },
    'h1': { out:['y1'],      in:['x'],         label:'h₁', role:'Hidden unit 1' },
    'y1': { out:[],          in:['h1','h2'],   label:'y₁', role:'Output' },
  }

── HOVER ───────────────────────────────────────────────────────────────────────
  • Node hover: stroke-width +1.5px, subtle fill-opacity change.
  • Only highlight OUTGOING edges from hovered node — NOT all connected edges.
    Use stroke:#e07b30, stroke-width +1px on outgoing edges only.
    (Highlighting all edges makes dense networks unreadable.)
  • Edge hover: highlight that one edge only.
  • Tooltip — SMALL, near cursor, label + one short phrase only (max 6 words of description):

  Tooltip CSS (copy verbatim — ~50% transparent, small, single line):
    position:fixed; background:rgba(0,0,0,0.50); backdrop-filter:blur(8px);
    -webkit-backdrop-filter:blur(8px); color:#fff; font:11px/1.3 sans-serif;
    padding:3px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.15);
    pointer-events:none; z-index:100; max-width:150px; white-space:nowrap;
    box-shadow:0 2px 6px rgba(0,0,0,0.25);

  Tooltip positioning — follow cursor exactly:
    document.addEventListener('mousemove', e => {
      tt.style.left = (e.clientX + 12) + 'px';
      tt.style.top  = (e.clientY - 28) + 'px';
    });
  Tooltip content: just the short label, e.g. "h₁ — hidden unit" (not a paragraph).

── CLICK → POPUP ────────────────────────────────────────────────────────────────
  DO NOT build a popup inside the iframe — it would obstruct the figure.
  Instead, use postMessage to send the data to the parent window, which renders
  the popup OUTSIDE the iframe below the figure.

  Use this exact pattern (copy verbatim):

    // Show popup — fires on node/element click:
    function showPopup(title, body) {
      window.parent.postMessage({ type: 'alex-popup', title, body }, '*');
    }
    // Hide popup — fires on Escape or SVG background click:
    function hidePopup() {
      window.parent.postMessage({ type: 'alex-popup', title: null }, '*');
    }

    // Wire up dismiss:
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hidePopup(); });
    svg.addEventListener('click', e => { if (e.target === svg || e.target.tagName === 'svg') hidePopup(); });

  Call showPopup(title, body) on each node/element click.
  DO NOT create any #pop, .popup, or fixed-position panel element inside the HTML.

── CLICK → SIGNAL FLOW ANIMATION ────────────────────────────────────────────────
  On click, animate edges left-to-right, one layer at a time using stroke-dashoffset.
  Forward pass (click) = blue #4a7ef5. Backward pass (Shift+click) = red #e05050.

  STRICT ORDERING — left to right only, never jump layers:
    Layer 0 = edges from input nodes  → delay 0ms
    Layer 1 = edges from 1st hidden   → delay 650ms
    Layer 2 = edges from 2nd hidden   → delay 1300ms
    ... and so on. Never animate layer N before layer N-1 finishes.

  Pulse destination node ONLY after its incoming edges finish (i.e. at delay + 350ms).
  NEVER pulse a node before its signal arrives — this is what causes visual jumping.

  CRITICAL — node pulse must NEVER displace circles from their positions:
  Apply these properties BEFORE changing transform, or nodes will fly to (0,0):
    node.style.transformBox    = 'fill-box';
    node.style.transformOrigin = 'center';
    node.style.transition      = 'transform 0.15s ease';
    node.style.transform       = 'scale(1.18)';
    setTimeout(() => { node.style.transform = 'scale(1)'; }, 200);

  NEVER animate cx, cy, x, y, translate, or any position attribute.
  ONLY animate: stroke-dashoffset (edges) and CSS scale transform (nodes).

  Edge dash animation pattern (call per layer, pass delay in ms):
    function animateEdges(edgeEls, color, delay) {
      setTimeout(() => {
        edgeEls.forEach(e => {
          const len = e.getTotalLength ? e.getTotalLength() : 200;
          e.style.transition = 'none';
          e.style.strokeDasharray = len;
          e.style.strokeDashoffset = len;
          e.style.stroke = color;
          requestAnimationFrame(() => {
            e.style.transition = 'stroke-dashoffset 0.6s ease';
            e.style.strokeDashoffset = '0';
          });
        });
      }, delay);
    }
  After full cascade (+1200ms), restore all edges to original stroke color/width.

── DRAGGABLE NODES ───────────────────────────────────────────────────────────────
  Nodes in network diagrams should be draggable. Use this coordinate pattern exactly
  to avoid nodes flying to wrong positions:

    let dragNode = null, dragOffX = 0, dragOffY = 0;
    // Get SVG coordinate from mouse event:
    function svgPt(svg, e) {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }
    nodeEl.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      const p = svgPt(svg, e);
      dragOffX = p.x - parseFloat(nodeEl.getAttribute('cx'));
      dragOffY = p.y - parseFloat(nodeEl.getAttribute('cy'));
      dragNode = nodeEl; nodeEl.style.cursor = 'grabbing';
    });
    svg.addEventListener('mousemove', e => {
      if (!dragNode) return;
      const p = svgPt(svg, e);
      const nx = p.x - dragOffX, ny = p.y - dragOffY;
      dragNode.setAttribute('cx', nx); dragNode.setAttribute('cy', ny);
      // Update label position and all connected edges here
    });
    svg.addEventListener('mouseup', () => { dragNode = null; });

── FIGURE-TYPE SPECIFIC ─────────────────────────────────────────────────────────
  Neural network / computational graph:
    • Click → forward pass cascade (blue #4a7ef5), Shift+click → backward (red #e05050)
    • Pulse destination nodes as signal arrives (use transformBox/transformOrigin pattern above)

  Flow chart / pipeline:
    • Click any step → dim all others to 0.5 opacity, highlight that step + its outgoing arrow

  Scatter / line plot:
    • On first hover, draw lines with stroke-dashoffset animation
    • Hover point → tooltip with x,y values

━━━ RENDERING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Diagrams, graphs, matrices, flow charts → inline SVG
  • Scatter/line/contour plots → SVG with correct data values from the figure
  • 3D geometry → see THREE.JS SECTION below (only if the blueprint specifies 3D)

━━━ SELF-CHECK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before outputting, verify:
  1. Default view matches original figure — layout, colors, every label?
  2. html/body have no margin/padding and background is #fff?
  3. SVG uses width="100%" height="100%" — no fixed pixel dimensions?
  4. Figure content fills the viewBox edge-to-edge (only 8px padding)? No empty whitespace borders?
  5. No title, toolbar, or description visible by default?
  6. All hover/click handlers reference elements that exist in the DOM?
If any answer is NO — fix it first, especially #4 (empty space = figure looks tiny in the iframe).

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

REMEMBER: Fill the entire viewBox edge-to-edge (only 8px padding). No title, no description text, no buttons visible by default. Interactivity on elements only (hover highlights connected edges, click shows bottom popup). Do NOT embed the image.`;

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
