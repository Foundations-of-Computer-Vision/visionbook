# Figure Platform

Convert 2D textbook figures into interactive 3D HTML visualisations (GPT-4o + Three.js), with automatic critique and scoring.

## Setup

```bash
# backend
cd figure-platform/backend && npm install
echo "OPENAI_API_KEY=sk-..." > .env
node server.js          # port 3001

# frontend (separate terminal)
cd figure-platform/frontend && npm install && npm start   # port 3000
```

## Usage

**Web UI** — upload a figure → Generate → scores appear automatically (generator + critic run in sequence).

**Agent loop** — batch-process a directory with optional multi-round refinement:

```bash
node agent.js --image ../../figures/imaging/pinhole.png
node agent.js --dir ../../figures/homography --rounds 3 --threshold 4.0
node agent.js --dir ../../figures/imaging --dry-run
```

Results land in `backend/results/` and appear in the platform immediately.

## Key files

| File | Role |
|---|---|
| `server.js` | Express API |
| `agent.js` | Batch CLI agent loop |
| `critic.js` | Evaluator prompt, 10 failure modes, 5 score rubrics |
| `base_scene_robust.html` | Base Three.js scaffold injected into every generation prompt |
