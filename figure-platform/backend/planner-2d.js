/**
 * planner-2d.js — deep vision analysis for 2D interactive figure reconstruction
 *
 * The planner reads the figure image and produces a detailed blueprint that the
 * generator uses to RECREATE the figure from scratch as an interactive web page.
 * No image embedding — the output is entirely SVG / HTML / CSS / JS.
 */

const { generateWithModel } = require('./models');

const PLANNER_2D_MODEL = 'gemini-3.5-flash';
const PLANNER_2D_MAX_TOKENS = 4096;

const PLAN_2D_SYSTEM_PROMPT = `You are a precision visual analyst preparing a reconstruction blueprint for an interactive web figure.

Your job: look at the figure VERY carefully and extract every piece of information a developer needs to recreate it exactly — data values, axis ranges, colors, layout, labels — without ever seeing the original image.

Output this exact JSON structure:
{
  "concept": "One sentence: what concept does this figure teach?",
  "figureType": "One of: network_diagram | matrix | flow_chart | multi_panel | scatter_plot | line_plot | contour_plot | 3d_surface | equation_visual | architecture | other",
  "layout": "Describe the spatial arrangement precisely (e.g. '2×2 grid of panels labeled a-d', 'single 3D surface', 'left-right flow')",
  "aspectRatio": 2.4,
  "elementSizes": {
    "nodeRadiusFraction": 0.045,
    "strokeWidth": 1.5,
    "fontSize": 11,
    "arrowheadSize": 6
  },
  "panels": [
    {
      "id": "a",
      "label": "a)",
      "type": "scatter_plot | line_plot | contour_plot | 3d_surface | bar_chart | diagram | other",
      "renderingMode": "2d | 3d",
      "position": "top-left | top-right | bottom-left | bottom-right | full",
      "axes": {
        "x": { "label": "exact axis label text", "min": 0, "max": 2, "ticks": [0, 0.5, 1.0, 1.5, 2.0] },
        "y": { "label": "exact axis label text", "min": 0, "max": 2, "ticks": [0, 0.5, 1.0, 1.5, 2.0] },
        "z": { "label": "for 3D only", "min": 0, "max": 70 }
      },
      "series": [
        {
          "type": "scatter | line | contour | surface | path | network_edges | network_nodes",
          "color": "#hex — read the exact color from the image, e.g. '#999999'",
          "opacity": 1.0,
          "label": "series label if any",
          "points": [[x1,y1],[x2,y2]],
          "note": "describe if too many points to list — give distribution pattern"
        }
      ],
      "edgeStyle": {
        "directed": true,
        "arrowhead": "triangle | open | none",
        "arrowColor": "#999",
        "strokeColor": "#999",
        "strokeWidth": 1
      },
      "nodeDecorations": "describe any symbols inside nodes (e.g. 'teal squiggle activation symbol', 'gray fill for dropped nodes', 'white fill with black border for active')",
      "annotations": ["list any text annotations, arrows, numbered labels visible in this panel"],
      "cameraAnalysis": "For 3D panels only: axis directions, elevation ~Xdeg, azimuth ~Ydeg, camera.position.set(x,y,z)"
    }
  ],
  "colorScheme": "Describe the full palette: background, axis color, data series colors with hex codes if possible",
  "renderingMode": "2d | mixed | 3d — 'mixed' if some panels are 3D and others 2D",
  "reconstructionNotes": "Critical notes: exact data values to reproduce, tricky layout details, which panels MUST use Three.js vs SVG"
}

MEASUREMENT RULES — required for geometry faithfulness:
- aspectRatio: measure the figure's width divided by its height as a decimal (e.g. a landscape figure ~2× wider than tall = 2.0). This is mandatory.
- elementSizes.nodeRadiusFraction: for diagrams with circular nodes, measure node radius as a fraction of total figure width (e.g. if node diameter is ~9% of figure width, nodeRadiusFraction = 0.045). If no circular nodes, omit.
- elementSizes.strokeWidth: the edge/border stroke width in pixels as it appears at ~600px figure width.
- elementSizes.fontSize: the dominant label font size in pixels as it appears at ~600px figure width.
- elementSizes.arrowheadSize: the arrowhead length in pixels as it appears at ~600px figure width.
These measurements let the generator set the correct viewBox and element scale without guessing.

EXTRACTION RULES:
- For each scatter plot: list every visible data point's approximate (x, y) by reading coordinates against the axes
- For gradient descent paths: list each numbered node's (φ₀, φ₁) position AND the loss value if readable
- For contour plots: describe the shape (elliptical/circular), spacing, and orientation of contours
- For 3D surfaces: describe the surface equation if inferrable (e.g. paraboloid), the viewing angle
- For line plots: give the equation or start/end points for each line
- panels array: include ALL panels — even if only one panel has 3D, mark it renderingMode:'3d'
- renderingMode '3d' should be used for ANY figure containing genuine 3D geometry: grids of spheres/neurons in 3D space, volumetric cubes, 3D coordinate frames, loss surfaces, point clouds, 3D architectural diagrams with depth. "Looks 3D" = IS 3D for this purpose.
- renderingMode '2d' is ONLY for flat diagrams with no depth: flow charts, matrices, flat network graphs, 2D plots
- Output ONLY valid JSON — no markdown, no explanation`;

/**
 * Analyze a 2D figure and produce a reconstruction blueprint.
 *
 * @param {string} figureStem   - filename without extension
 * @param {string} chapterName  - chapter hint (optional)
 * @param {string} base64       - base64-encoded image
 * @param {string} mediaType    - e.g. 'image/png'
 * @returns {Promise<object>}   - parsed plan JSON
 */
async function plan2dFigure(figureStem, chapterName, base64, mediaType) {
  const userContent = [
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
    {
      type: 'text',
      text: `Figure: "${figureStem}"${chapterName ? ` (chapter: ${chapterName})` : ''}

Analyze this figure carefully. Pay special attention to:
1. Whether it has multiple panels (a, b, c, d) and what type each panel is
2. The EXACT data point coordinates — read each scatter/path point against the axis scale
3. Which panels contain true 3D content (loss surfaces, coordinate frames) vs 2D plots
4. The viewing angle of any 3D panel (elevation, azimuth, camera position)
5. Axis ranges, tick values, and labels for every panel

Return the full reconstruction blueprint as JSON. The developer cannot see this image — your coordinates and descriptions are the only guide they have.`,
    },
  ];

  let content = await generateWithModel(PLANNER_2D_MODEL, {
    systemPrompt: PLAN_2D_SYSTEM_PROMPT,
    userContent,
    maxTokens: PLANNER_2D_MAX_TOKENS,
  });

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) content = fenced[1].trim();

  try {
    return JSON.parse(content);
  } catch {
    return {
      concept: figureStem.replace(/_/g, ' '),
      figureType: 'other',
      layout: 'Unknown layout',
      elements: [],
      interactions: [],
      steps: [{ label: 'Overview', description: 'Explore this figure interactively.', highlight: 'all' }],
      colorScheme: 'neutral',
      reconstructionNotes: '',
      raw: content.slice(0, 500),
    };
  }
}

module.exports = { plan2dFigure };
