# Figure Platform

Convert 2D textbook figures into interactive 3D HTML visualisations using GPT-4o + Three.js,
with automatic critique and scoring via a separate evaluator model.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Generator (gpt-4o)                                     │
│    image → base scaffold → complete HTML figure         │
└──────────────────────┬──────────────────────────────────┘
                       │ HTML
┌──────────────────────▼──────────────────────────────────┐
│  Critic / Evaluator (gpt-5.4)          critic.js        │
│    original image + HTML → 10 failure modes + 5 scores  │
└──────────────────────┬──────────────────────────────────┘
                       │ evaluation JSON
┌──────────────────────▼──────────────────────────────────┐
│  results/<id>.json   (picked up by the web platform)    │
└─────────────────────────────────────────────────────────┘
```

The **web platform** (React + Express) is a viewer/navigator for results — it does not own
the generation loop. Results appear automatically as soon as they land in `backend/results/`.

---

## Setup

### 1. Backend

```bash
cd figure-platform/backend
npm install
```

Create `backend/.env` with your OpenAI key:

```
OPENAI_API_KEY=sk-...
```

Start the server (port 3001):

```bash
node server.js
```

### 2. Frontend

```bash
cd figure-platform/frontend
npm install
npm start
```

Opens at **http://localhost:3000** — proxies API calls to **http://localhost:3001**.

---

## Web Platform

| Tab | Description |
|---|---|
| **Generator** | Upload a figure → **Generate** → HTML is created and auto-evaluated; scores appear immediately |
| **Results** | Browse results by experiment / model / chapter; click a card to view the figure, scores, and failure modes |
| **Dashboard** | Compare models and experiments side-by-side on all 5 metrics |

---

## Agent Loop (`backend/agent.js`)

Batch-process one image or a whole directory with an optional multi-round
generator → evaluator → refiner cycle. Results land in `backend/results/` and
appear in the platform automatically.

```bash
# Single image, 1 round
node agent.js --image ../../figures/imaging/pinhole.png

# Whole chapter, up to 3 refinement rounds, stop when overall score ≥ 4.0
node agent.js --dir ../../figures/homography --rounds 3 --threshold 4.0

# Custom experiment label + models
node agent.js --dir ../../figures/homography \
  --experiment homography-v2 \
  --model gpt-4o \
  --eval-model gpt-5.4 \
  --rounds 2

# Dry run (no API calls)
node agent.js --dir ../../figures/imaging --dry-run
```

**Loop per image:**
1. **Generator** produces HTML from the image
2. **Critic** scores it (5 metrics + 10 failure modes)
3. If `overall_average < threshold` and rounds remain → **Refiner** feeds failure modes back to the generator
4. Repeat until threshold met or max rounds reached
5. Puppeteer screenshot captured; result saved to `results/<id>.json`

---

## Critic (`backend/critic.js`)

Single source of truth for the evaluation rubric — edit here to change anything about scoring.

**10 failure modes** (detected by the evaluator, shown as pills in the UI):

| Mode | Description |
|---|---|
| `Depth-Wrong` | 3D depth/perspective interpretation is incorrect |
| `Missing-Labels` | Important text annotations are absent |
| `Wrong-Primitives` | Incorrect geometric shapes used for the concept |
| `Interaction-Broken` | Interactive controls are present but non-functional |
| `Interaction-Missing` | No meaningful interactions beyond basic OrbitControls |
| `Camera-Wrong` | Poor initial viewpoint; key content not visible |
| `Scale-Wrong` | Element proportions are noticeably off |
| `Color-Wrong` | Colors don't match the original figure |
| `Hallucination` | Elements present that don't appear in the original |
| `Concept-Misunderstood` | The core concept being illustrated is misrepresented |

**5 scored metrics** (1–5 integer, shown as a heatmap in the Dashboard):

| Metric | What it measures |
|---|---|
| `geometry_accuracy` | Correct shapes, positions, topology |
| `interactivity_usability` | Meaningful developer-built interactions (OrbitControls don't count) |
| `faithfulness` | Visual match to the original 2D figure |
| `label_quality` | Correctness, clarity, and placement of text labels |
| `concept_accuracy` | Correctness of the underlying educational concept |

**Derived metrics** (computed automatically):
- `visual_aesthetics` = avg(geometry + faithfulness + label_quality)
- `overall_average` = avg of all 5 primary metrics

---

## File Structure

```
figure-platform/
├── backend/
│   ├── server.js           Express API (generate, evaluate, history, thumbnails)
│   ├── agent.js            Standalone batch agent loop (CLI)
│   ├── critic.js           Shared evaluator prompt + scoring logic
│   ├── base_scene_robust.html  Base Three.js scaffold injected into every prompt
│   ├── results/            Generated result JSON files (gitignored)
│   └── .env                OPENAI_API_KEY (gitignored)
└── frontend/
    └── src/App.js          React UI (Generator, Results, Dashboard tabs)
```

---

## Notes

- Generation + evaluation takes ~60–90 seconds per image via the web UI.
- `agent.js` processes images sequentially; multi-round runs multiply that time.
- Never commit `.env` or expose `OPENAI_API_KEY` in frontend code.
- `*.eval.json`, `*.thumb.b64`, `results/`, and `frontend/build/` are gitignored.
