# 3D Figure Generator

Auto-generate interactive 3D HTML figures from textbook images using GPT-4o + Three.js.

## Setup

### 1. Backend

```bash
cd figure-platform/backend
npm install
```

Create a `.env` file in `backend/` with your OpenAI key:

```
OPENAI_API_KEY=sk-...
```

Start the backend (port 3001):

```bash
npm start
```

### 2. Frontend

```bash
cd figure-platform/frontend
npm install
npm start
```

The React app opens at **http://localhost:3000** and proxies API calls to **http://localhost:3001**.

---

## Usage

| Tab | Description |
|---|---|
| **Generator** | Upload a PNG/JPG textbook figure → click **Generate 3D Figure** |
| **Viewer** | Interact with the generated Three.js scene; download the HTML file |
| **History** | Browse all previously generated figures; click any card to reload it |

Generated results are saved as JSON files in `backend/results/`.

---

## Notes

- Generation typically takes 30–60 seconds.
- The system prompt instructs GPT-4o to return a fully self-contained HTML file with Three.js (ES modules) and OrbitControls.
- Never commit your `.env` file or expose `OPENAI_API_KEY` in frontend code.
