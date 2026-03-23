# Figure Platform

Converts 2D textbook figures into interactive 3D HTML visualizations using GPT + Three.js, with automatic planning, generation, and critique scoring.

## Quick Start

### 1. Install dependencies

```bash
# Backend
cd figure-platform/backend
npm install
cp .env.example .env        # then paste your OpenAI API key

# Frontend
cd ../frontend
npm install
```

### 2. Add your API key

Edit `backend/.env`:

```
OPENAI_API_KEY=sk-...your-key-here
```

### 3. Run

Open **two terminals**:

```bash
# Terminal 1 — backend (port 3001)
cd figure-platform/backend && node server.js

# Terminal 2 — frontend (port 3000)
cd figure-platform/frontend && npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## How It Works

1. **Pick a chapter** → see which figures are 3D candidates
2. **Generate All** → plans each figure, then generates interactive HTML (runs in parallel)
3. **Auto-evaluate** → critic scores each result on 5 rubrics (1–5) and flags failure modes
4. **Results tab** → browse by experiment, model, chapter; compare runs side-by-side

You can also drop a single figure image to plan + generate just that one.

## Project Structure

```
figure-platform/
├── backend/
│   ├── server.js              # Express API (plan, generate, evaluate, history)
│   ├── planner.js             # Analyzes figures, plans 3D interactions
│   ├── critic.js              # Evaluator: 10 failure modes, 5 score rubrics
│   ├── agent.js               # CLI batch agent with multi-round refinement
│   ├── base_scene_robust.html # Three.js scaffold injected into every prompt
│   ├── sort_chapter_figures.js# Classifies figures as 2D/3D candidates
│   ├── results/               # Generated outputs (git-ignored)
│   └── .env                   # API key (git-ignored)
├── frontend/
│   └── src/App.js             # React UI (Generator + Viewer + Results tabs)
└── chapter-figures/           # Per-chapter figure images + candidates_3d/
```

## CLI Agent (optional)

Batch-process figures from the command line:

```bash
cd backend
node agent.js --image ../../figures/imaging/pinhole.png
node agent.js --dir ../../figures/homography --rounds 3 --threshold 4.0
node agent.js --dir ../../figures/imaging --dry-run
```

## Notes

- Model is currently set to `gpt-5.4` in `server.js` (change `CURRENT_MODEL` to use a different one)
- Experiments are auto-labeled by a hash of the system prompt — changing the prompt or scaffold creates a new experiment group
- Results are saved to `backend/results/` (git-ignored) and appear in the UI immediately
- `chapter-figures/` contains the textbook figures organized by chapter
