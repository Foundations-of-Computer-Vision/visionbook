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