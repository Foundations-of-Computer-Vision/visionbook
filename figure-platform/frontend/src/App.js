import React, { useState, useCallback, useEffect } from 'react';
import BENCHMARK_FIGURES from './benchmarkFigures';

const FALLBACK_PROMPT = '(Loading system prompt from server…)';
const MODEL_STORAGE_KEY = 'figure-platform:selectedModel';
const PLANNER_MODEL_STORAGE_KEY = 'figure-platform:selectedPlannerModel';
const CRITIC_MODEL_STORAGE_KEY = 'figure-platform:selectedCriticModel';
const EVALUATOR_MODEL_STORAGE_KEY = 'figure-platform:selectedEvaluatorModel';
const EXPERIMENT_STORAGE_KEY = 'figure-platform:selectedExperiment';
const FIGURE_TYPE_STORAGE_KEY = 'figure-platform:selectedFigureType';
const CHAPTERS_STORAGE_KEY = 'figure-platform:selectedChapters';
const BATCH_GEN_TYPE_STORAGE_KEY = 'figure-platform:batchGenType';
const FEW_SHOT_STORAGE_KEY = 'figure-platform:fewShot';
const HUMAN_EVAL_MODEL = 'human:manual';
const DEFAULT_GENERATION_MODEL = 'gpt-5.5';
const DEFAULT_EVALUATION_MODEL = 'claude-opus-4.7';
const HUMAN_FAILURE_MODES = [
  'Depth-Wrong',
  'Missing-Labels',
  'Wrong-Primitives',
  'Interaction-Broken',
  'Interaction-Missing',
  'Camera-Wrong',
  'Scale-Wrong',
  'Color-Wrong',
  'Hallucination',
  'Concept-Misunderstood',
];

function isExternalEval(metaEntry) {
  return metaEntry?.source === 'external';
}

function filterExternalEvals(results, meta) {
  const r = {}, m = {};
  for (const id of Object.keys(results || {})) {
    if (isExternalEval((meta || {})[id])) { r[id] = results[id]; m[id] = (meta || {})[id]; }
  }
  return { results: r, meta: m };
}

function pickEvaluationModel(record, preferredModel) {
  const meta = record?.evaluationMeta || {};
  const { results } = filterExternalEvals(record?.evaluationResults, meta);
  const keys = Object.keys(results);
  if (!keys.length) return null;
  if (preferredModel && results[preferredModel]) return preferredModel;
  // Prefer the most recently evaluated model when metadata is available.
  const sorted = [...keys].sort((a, b) => {
    const aTime = meta[a]?.evaluatedAt ? new Date(meta[a].evaluatedAt).getTime() : 0;
    const bTime = meta[b]?.evaluatedAt ? new Date(meta[b].evaluatedAt).getTime() : 0;
    return bTime - aTime;
  });
  return sorted[0] || keys[0];
}

function getRecordEvaluation(record, modelId) {
  const results = record?.evaluationResults || {};
  const meta = record?.evaluationMeta || {};
  if (!modelId) return null;
  if (!isExternalEval(meta[modelId])) return null;
  return results[modelId] || null;
}

function hasAnyEvaluation(record) {
  const meta = record?.evaluationMeta || {};
  return Object.keys(record?.evaluationResults || {}).some(id => isExternalEval(meta[id]));
}

function normalizeEvaluationHistory(record) {
  return {
    ...record,
    evaluationResults: record?.evaluationResults || {},
    evaluationMeta: record?.evaluationMeta || {},
    evaluationVersions: record?.evaluationVersions || {},
  };
}

function getVersionedEvaluationState(record, criticVersion) {
  const normalized = normalizeEvaluationHistory(record);
  if (!criticVersion) {
    const { results, meta } = filterExternalEvals(normalized.evaluationResults, normalized.evaluationMeta);
    return { ...normalized, evaluationResults: results, evaluationMeta: meta };
  }
  const bucket = normalized.evaluationVersions?.[criticVersion];
  if (!bucket) {
    return { ...normalized, evaluationResults: {}, evaluationMeta: {} };
  }
  const { results, meta } = filterExternalEvals(bucket.evaluationResults, bucket.evaluationMeta);
  return { ...normalized, evaluationResults: results, evaluationMeta: meta };
}

function upsertVersionedEvaluation(record, modelId, evaluation, { criticVersion, evaluatedAt } = {}) {
  const normalized = normalizeEvaluationHistory(record);
  const versionKey = criticVersion;
  const metaEntry = {
    evaluatedAt: evaluatedAt || new Date().toISOString(),
    criticVersion: versionKey,
    source: 'external',
  };

  normalized.evaluationResults = {
    ...normalized.evaluationResults,
    [modelId]: evaluation,
  };
  normalized.evaluationMeta = {
    ...normalized.evaluationMeta,
    [modelId]: metaEntry,
  };

  const versionBucket = normalized.evaluationVersions[versionKey] || {};
  normalized.evaluationVersions = {
    ...normalized.evaluationVersions,
    [versionKey]: {
      ...versionBucket,
      criticVersion: versionKey,
      evaluationResults: {
        ...(versionBucket.evaluationResults || {}),
        [modelId]: evaluation,
      },
      evaluationMeta: {
        ...(versionBucket.evaluationMeta || {}),
        [modelId]: metaEntry,
      },
    },
  };

  return normalized;
}


function apiFetch(input, init = {}) {
  return fetch(input, {
    ...init,
    headers: {
      'ngrok-skip-browser-warning': 'true',
      ...(init.headers || {}),
    },
  });
}

async function runGenerationJob2d(payload, { pollMs = 2000, maxPolls = 600 } = {}) {
  const createRes = await apiFetch('/api/generate-2d-async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.error || 'Failed to start 2D generation.');

  let transientPollFailures = 0;
  for (let pollCount = 0; pollCount < maxPolls; pollCount += 1) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    try {
      const statusRes = await apiFetch(`/api/generate-status/${encodeURIComponent(createData.jobId)}`);
      const statusData = await statusRes.json();
      if (!statusRes.ok) throw new Error(statusData.error || 'Failed to check status.');
      transientPollFailures = 0;
      if (statusData.status === 'done') return statusData.result;
      if (statusData.status === 'error') throw new Error(statusData.error || '2D generation failed.');
    } catch (err) {
      transientPollFailures += 1;
      if (transientPollFailures >= 5) throw new Error(err.message || 'Connection error while checking status.');
    }
  }
  throw new Error('2D generation timed out.');
}

// Run iterative loop-based generation (3D). Polls the async job until completion.
async function runGenerationLoop(payload, { pollMs = 2000, maxPolls = 600 } = {}) {
  const createRes = await apiFetch('/api/generate-loop-async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.error || 'Failed to start loop generation.');

  let transientPollFailures = 0;
  for (let pollCount = 0; pollCount < maxPolls; pollCount += 1) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    try {
      const statusRes = await apiFetch(`/api/generate-status/${encodeURIComponent(createData.jobId)}`);
      const statusData = await statusRes.json();
      if (!statusRes.ok) throw new Error(statusData.error || 'Failed to check generation status.');
      transientPollFailures = 0;
      if (statusData.status === 'done') return statusData.result;
      if (statusData.status === 'error') throw new Error(statusData.error || 'Loop generation failed.');
    } catch (err) {
      transientPollFailures += 1;
      if (transientPollFailures >= 5) throw new Error(err.message || 'Connection error while checking generation status.');
    }
  }

  throw new Error('Loop generation timed out while waiting for completion.');
}

const VALID_TABS = ['generator', 'viewer', 'results', 'dashboard', 'preview'];
const tabFromHash = () => {
  const h = window.location.hash.slice(1);
  return VALID_TABS.includes(h) ? h : 'generator';
};

export default function App() {
  const [tab, setTab] = useState(tabFromHash);
  const [viewerBackTab, setViewerBackTab] = useState('generator');
  const [image, setImage] = useState(null); // { base64, mediaType, filename, previewUrl }
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(FALLBACK_PROMPT);
  const [currentCriticVersion, setCurrentCriticVersion] = useState('');
  // Model selection
  const [models, setModels] = useState([]);       // available models from backend
  const [selectedModel, setSelectedModel] = useState(''); // '' = server default
  const [selectedPlannerModel, setSelectedPlannerModel] = useState('');
  const [selectedCriticModel, setSelectedCriticModel] = useState('');
  const [selectedEvaluatorModel, setSelectedEvaluatorModel] = useState('');
  const [experimentOptions, setExperimentOptions] = useState([]);
  const [selectedExperiment, setSelectedExperiment] = useState('');
  const [fewShot, setFewShot] = useState({ planner: true, critic: true, orchestrator: true });

  // Sync URL hash when tab changes
  useEffect(() => {
    if (window.location.hash.slice(1) !== tab) {
      window.history.pushState(null, '', `#${tab}`);
    }
  }, [tab]);

  // Handle browser back/forward
  useEffect(() => {
    const onPop = () => setTab(tabFromHash());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Fetch the real system prompt + available models + past API/history experiment names on mount
  useEffect(() => {
    Promise.all([
      apiFetch('/api/prompt').then(r => r.json()).catch(() => ({})),
      apiFetch('/api/models').then(r => r.json()).catch(() => ([])),
      apiFetch('/api/history-index').then(r => r.json()).catch(() => ([])),
    ]).then(([promptData, list, historyRecords]) => {
      if (promptData.prompt) setSystemPrompt(promptData.prompt);
      if (promptData.criticVersion) setCurrentCriticVersion(promptData.criticVersion);
      setModels(list);

      const storedExperiment = window.localStorage.getItem(EXPERIMENT_STORAGE_KEY);
      const newestExperiment = historyRecords?.[0]?.experiment || '';
      if (storedExperiment) setSelectedExperiment(storedExperiment);
      else if (newestExperiment) setSelectedExperiment(newestExperiment);

      const storedFigureType = window.localStorage.getItem(FIGURE_TYPE_STORAGE_KEY);
      if (storedFigureType === '2d' || storedFigureType === '3d') setFigureType(storedFigureType);

      const storedFewShot = window.localStorage.getItem(FEW_SHOT_STORAGE_KEY);
      if (storedFewShot) { try { setFewShot(JSON.parse(storedFewShot)); } catch { } }

      const experimentSet = new Set();
      for (const record of historyRecords || []) {
        if (record?.experiment) experimentSet.add(record.experiment);
      }
      const mergedExperiments = Array.from(experimentSet).sort();
      setExperimentOptions(mergedExperiments);

      if (list.length === 0) return;

      const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
      const preferredModel = [storedModel, promptData.model, list[0]?.id]
        .find(modelId => modelId && list.some(m => m.id === modelId));

      if (preferredModel) setSelectedModel(preferredModel);

      const storedPlannerModel = window.localStorage.getItem(PLANNER_MODEL_STORAGE_KEY);
      const preferredPlannerModel = [storedPlannerModel, promptData.plannerModel, list[0]?.id]
        .find(modelId => modelId && list.some(m => m.id === modelId));

      if (preferredPlannerModel) setSelectedPlannerModel(preferredPlannerModel);

      const storedCriticModel = window.localStorage.getItem(CRITIC_MODEL_STORAGE_KEY);
      const preferredCriticModel = [storedCriticModel, promptData.criticModel, list[0]?.id]
        .find(modelId => modelId && list.some(m => m.id === modelId));

      if (preferredCriticModel) setSelectedCriticModel(preferredCriticModel);

      const storedEvaluatorModel = window.localStorage.getItem(EVALUATOR_MODEL_STORAGE_KEY);
      const preferredEvaluatorModel = [storedEvaluatorModel, promptData.criticModel, list[0]?.id]
        .find(modelId => modelId && list.some(m => m.id === modelId));
      if (preferredEvaluatorModel) setSelectedEvaluatorModel(preferredEvaluatorModel);

    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [currentRecord, setCurrentRecord] = useState(null); // full record from history
  const [viewerEvaluationModel, setViewerEvaluationModel] = useState(null);
  useEffect(() => {
    if (selectedModel) window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
  }, [selectedModel]);
  useEffect(() => {
    if (selectedPlannerModel) window.localStorage.setItem(PLANNER_MODEL_STORAGE_KEY, selectedPlannerModel);
  }, [selectedPlannerModel]);
  useEffect(() => {
    if (selectedCriticModel) window.localStorage.setItem(CRITIC_MODEL_STORAGE_KEY, selectedCriticModel);
  }, [selectedCriticModel]);
  useEffect(() => {
    if (selectedEvaluatorModel) window.localStorage.setItem(EVALUATOR_MODEL_STORAGE_KEY, selectedEvaluatorModel);
  }, [selectedEvaluatorModel]);
  useEffect(() => {
    if (selectedExperiment) window.localStorage.setItem(EXPERIMENT_STORAGE_KEY, selectedExperiment);
  }, [selectedExperiment]);

  const [loading, setLoading] = useState(false);
  const [figureType, setFigureType] = useState('3d'); // '3d' | '2d'
  const [error, setError] = useState('');
  const [evaluation, setEvaluation] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [plan, setPlan] = useState(null);        // planner output for current figure
  const [planning] = useState(false); // true while planner is running

  useEffect(() => {
    if (figureType) window.localStorage.setItem(FIGURE_TYPE_STORAGE_KEY, figureType);
  }, [figureType]);
  useEffect(() => {
    window.localStorage.setItem(FEW_SHOT_STORAGE_KEY, JSON.stringify(fewShot));
  }, [fewShot]);

  const syncViewerSelection = useCallback((record, preferredModel = null) => {
    if (!record) {
      setViewerEvaluationModel(null);
      setEvaluation(null);
      return;
    }
    const normalizedRecord = {
      ...record,
      evaluationResults: record.evaluationResults || {},
      evaluationMeta: record.evaluationMeta || {},
      evaluationVersions: record.evaluationVersions || {},
    };
    const selectedModel = pickEvaluationModel(normalizedRecord, preferredModel);
    setCurrentRecord(normalizedRecord);
    setViewerEvaluationModel(selectedModel);
    setEvaluation(getRecordEvaluation(normalizedRecord, selectedModel));
  }, []);

  // Called by Uploader when a file is selected
  const handleImageSelected = useCallback((imgData) => {
    setImage(imgData);
    setPlan(null);
    setError('');
  }, []);

  // Single Generate button: plan first (fast), then generate (slow) — fully automated
  const handleGenerate = useCallback(async () => {
    if (!image) return;
    if (!selectedModel) {
      setError('Set a generator model in the Generator tab first.');
      return;
    }
    if (!selectedExperiment || !selectedExperiment.trim()) {
      setError('Select or type an experiment name before generating.');
      return;
    }
    setError('');

    // Step 1: Generate (slow ~30-60s, includes planning internally)
    setLoading(true);
    try {
      const is2d = figureType === '2d';
      // For 3D (non-2d) generations use the iterative loop endpoint to preserve attempts
      const jobFn = is2d ? runGenerationJob2d : runGenerationLoop;
      const payload = is2d
        ? { base64: image.base64, mediaType: image.mediaType, filename: image.filename, model: selectedModel || undefined, plannerModel: selectedPlannerModel || undefined }
        : { base64: image.base64, mediaType: image.mediaType, filename: image.filename, model: selectedModel || undefined, plannerModel: selectedPlannerModel || undefined, evalModel: selectedCriticModel || undefined, criticVersion: 'benchmark', criticPasses: 1, experiment: selectedExperiment || undefined, fewShot };
      const data = await jobFn(payload);
      const generatedEvaluationResults = data.evaluationResults || {};
      const generatedEvaluationMeta = data.evaluationMeta || {};
      const generatedModel = pickEvaluationModel({
        evaluationResults: generatedEvaluationResults,
        evaluationMeta: generatedEvaluationMeta,
      }, null);
      setGeneratedHtml(data.html);
      setPlan(data.plan || null);
      setEvaluation(getRecordEvaluation({ evaluationResults: generatedEvaluationResults }, generatedModel));
      setCurrentRecord({
        id: data.figureId,
        html: data.html,
        filename: image.filename,
        base64thumb: image.base64,
        mediaType: image.mediaType,
        timestamp: data.timestamp,
        model: data.model,
        experiment: data.experiment || selectedExperiment || null,
        evaluationResults: generatedEvaluationResults,
        evaluationMeta: generatedEvaluationMeta,
        evaluationVersions: data.evaluationVersions || {},
        plan: data.plan || null,
      });
      setViewerEvaluationModel(generatedModel);
      setViewerBackTab(tab);
      setTab('viewer');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [image, selectedCriticModel, selectedExperiment, selectedModel, selectedPlannerModel, tab, figureType, fewShot]);
  const handleLoadFromHistory = useCallback((record) => {
    const normalizedRecord = {
      ...record,
      evaluationResults: record.evaluationResults || {},
      evaluationMeta: record.evaluationMeta || {},
      evaluationVersions: record.evaluationVersions || {},
    };
    const selectedModel = pickEvaluationModel(normalizedRecord, null);
    setGeneratedHtml(record.html);
    syncViewerSelection(normalizedRecord, selectedModel);
    setViewerBackTab(tab);
    setTab('viewer');
  }, [syncViewerSelection, tab]);

  // Delete a saved result by id
  const handleDelete = useCallback(async (id) => {
    try {
      await apiFetch(`/api/result/${id}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }, []);

  // Clear viewer after deleting current record
  const handleDeleteCurrent = useCallback(async () => {
    if (!currentRecord?.id) return;
    await handleDelete(currentRecord.id);
    setCurrentRecord(null);
    setGeneratedHtml('');
    setEvaluation(null);
    setViewerEvaluationModel(null);
    setTab('generator');
  }, [currentRecord, handleDelete]);

  // Open any result (API record by id, or experiment by htmlPath) in the Viewer
  const handleOpenResult = useCallback(async (item) => {
    if (item.type === 'api') {
      try {
        const res = await apiFetch(`/api/result/${item.id}`);
        const record = await res.json();
        handleLoadFromHistory(record);
      } catch (err) { alert('Failed to load: ' + err.message); }
    } else {
      try {
        const htmlRes = await apiFetch('/api/experiments/html?path=' + encodeURIComponent(item.htmlPath));
        const html = await htmlRes.text();
        let base64thumb = null;
        if (item.imagePath) {
          const imgRes = await apiFetch('/api/experiments/image?path=' + encodeURIComponent(item.imagePath));
          if (imgRes.ok) base64thumb = await imgRes.text();
        }
        const expSource = [item.experiment, item.model].filter(Boolean).join(' / ');
        const viewerRecord = {
          html,
          filename: item.figure + '.html',
          base64thumb,
          mediaType: 'image/png',
          timestamp: new Date().toISOString(),
          source: expSource || item.source,
          model: item.model || null,
          htmlPath: item.htmlPath,
          imagePath: item.imagePath,
          evaluationResults: item.evaluationResults || {},
          evaluationMeta: item.evaluationMeta || {},
          evaluationVersions: item.evaluationVersions || {},
        };
        const selectedEvalModel = pickEvaluationModel(viewerRecord, null);
        setGeneratedHtml(html);
        syncViewerSelection(viewerRecord, selectedEvalModel);
        setViewerBackTab(tab);
        setTab('viewer');
      } catch (err) { alert('Failed to load: ' + err.message); }
    }
  }, [handleLoadFromHistory, syncViewerSelection, tab]);

  // Evaluate: works for API records (by id) and experiment records (by htmlPath)
  const handleEvaluate = useCallback(async (requestedEvalModel = viewerEvaluationModel) => {
    if (!currentRecord) return;
    setEvaluating(true);
    try {
      const modelId = requestedEvalModel || selectedEvaluatorModel || pickEvaluationModel(currentRecord, null) || DEFAULT_EVALUATION_MODEL;
      const evalModelToUse = modelId;
      let data;
      if (currentRecord.htmlPath) {
        const res = await apiFetch('/api/experiments/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            htmlPath: currentRecord.htmlPath,
            imagePath: currentRecord.imagePath,
            evalModel: evalModelToUse,
            criticVersion: 'benchmark',
          }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Evaluation failed.');
      } else if (currentRecord.id) {
        const res = await apiFetch('/api/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: currentRecord.id,
            evalModel: evalModelToUse,
            criticVersion: 'benchmark',
          }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Evaluation failed.');
      } else {
        throw new Error('Cannot evaluate: no id or htmlPath.');
      }
      if (data.skipped) return;
      setEvaluation(data);
      setViewerEvaluationModel(modelId);
      setCurrentRecord(prev => prev ? {
        ...prev,
        ...upsertVersionedEvaluation(prev, modelId || 'unknown', data, {
          criticVersion: 'benchmark',
        }),
      } : prev);
    } catch (err) {
      alert('Evaluation failed: ' + err.message);
    } finally {
      setEvaluating(false);
    }
  }, [currentRecord, selectedEvaluatorModel, viewerEvaluationModel]);

  const handleSaveHumanEvaluation = useCallback(async ({ evaluation: humanEvaluation }) => {
    if (!currentRecord) return;
    const modelId = HUMAN_EVAL_MODEL;

    const payload = {
      raterId: 'manual',
      evaluation: humanEvaluation,
    };

    if (currentRecord.id) payload.id = currentRecord.id;
    else if (currentRecord.htmlPath) payload.htmlPath = currentRecord.htmlPath;
    else throw new Error('Cannot save human evaluation: no id or htmlPath.');

    const res = await apiFetch('/api/evaluate-human', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save human evaluation.');

    const savedEvaluation = data.evaluation || humanEvaluation;
    const savedModelId = data.evalModel || modelId;
    const savedCriticVersion = data.criticVersion || 'human_v1';

    setViewerEvaluationModel(savedModelId);
    setEvaluation(savedEvaluation);
    setCurrentRecord(prev => prev ? {
      ...prev,
      ...upsertVersionedEvaluation(prev, savedModelId, savedEvaluation, {
        criticVersion: savedCriticVersion,
      }),
    } : prev);
  }, [currentRecord]);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>3D Figure Generator</span>
        <nav style={styles.nav}>
          {['generator', 'viewer', 'results', 'dashboard', 'preview'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...styles.navBtn, ...(tab === t ? styles.navBtnActive : {}) }}
            >
              {({ 'preview': 'Chapter Preview' }[t] || (t.charAt(0).toUpperCase() + t.slice(1)))}
            </button>
          ))}
        </nav>
      </header>

      <main style={{ ...styles.main, ...(tab === 'viewer' ? styles.mainViewer : {}) }}>
        {tab === 'generator' && (
          <GeneratorTab
            image={image}
            onImageSelected={handleImageSelected}
            onGenerate={handleGenerate}
            onError={setError}
            loading={loading}
            planning={planning}
            plan={plan}
            error={error}
            systemPrompt={systemPrompt}
            models={models}
            experimentOptions={experimentOptions}
            selectedExperiment={selectedExperiment}
            selectedModel={selectedModel}
            selectedPlannerModel={selectedPlannerModel}
            selectedCriticModel={selectedCriticModel}
            onExperimentChange={setSelectedExperiment}
            onGeneratorModelChange={setSelectedModel}
            onPlannerModelChange={setSelectedPlannerModel}
            onCriticModelChange={setSelectedCriticModel}
            figureType={figureType}
            onFigureTypeChange={setFigureType}
            fewShot={fewShot}
            onFewShotChange={setFewShot}
          />
        )}
        {tab === 'viewer' && (
          <ViewerTab
            record={currentRecord}
            html={generatedHtml}
            onBack={() => setTab(viewerBackTab || 'generator')}
            backLabel={viewerBackTab === 'results' ? 'Back to Results' : viewerBackTab === 'dashboard' ? 'Back to Dashboard' : viewerBackTab === 'preview' ? 'Back to Chapter Preview' : 'Back'}
            onNew={() => setTab('generator')}
            onDelete={handleDeleteCurrent}
            evaluation={evaluation}
            evaluationModel={viewerEvaluationModel}
            availableEvaluationModels={models}
            evaluating={evaluating}
            onEvaluate={handleEvaluate}
            onSaveHumanEvaluation={handleSaveHumanEvaluation}
            onSelectEvaluationModel={(modelId) => {
              setViewerEvaluationModel(modelId);
              setSelectedEvaluatorModel(modelId);
              setEvaluation(getRecordEvaluation(currentRecord, modelId));
            }}
            defaultEvaluationModel={selectedEvaluatorModel || DEFAULT_EVALUATION_MODEL}
          />
        )}
        {tab === 'results' && (
          <ResultsTab
            onOpen={handleOpenResult}
            evaluatorModel={selectedEvaluatorModel}
            onEvaluatorModelChange={setSelectedEvaluatorModel}
            availableModels={models}
            currentCriticVersion={currentCriticVersion}
          />
        )}
        {tab === 'dashboard' && (
          <DashboardTab currentCriticVersion={currentCriticVersion} />
        )}
        {tab === 'preview' && (
          <ChapterPreviewTab />
        )}
      </main>
    </div>
  );
}


// ── Generator Tab ─────────────────────────────────────────────────────────────
function GeneratorTab({ image, onImageSelected, onGenerate, onError, loading, planning, plan, error, systemPrompt, models, experimentOptions, selectedExperiment, selectedModel, selectedPlannerModel, selectedCriticModel, onExperimentChange, onGeneratorModelChange, onPlannerModelChange, onCriticModelChange, figureType, onFigureTypeChange, fewShot = { planner: true, critic: true, orchestrator: true }, onFewShotChange }) {
  const chapterGenerationConcurrency = 10;
  const [promptOpen, setPromptOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState('figure'); // 'figure' | 'chapter' | 'book'
  const [chapters, setChapters] = useState([]);
  const [selectedChapters, setSelectedChapters] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(CHAPTERS_STORAGE_KEY)) || []; } catch { return []; }
  });
  const [chapterCandidates, setChapterCandidates] = useState([]);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [batchGenType, setBatchGenType] = useState(() => {
    const v = window.localStorage.getItem(BATCH_GEN_TYPE_STORAGE_KEY);
    return v === '3d' || v === '2d' ? v : 'both';
  });

  // Chapter batch pipeline state
  const [chapterRunning, setChapterRunning] = useState(false);     // true while batch is active
  const [chapterProgress, setChapterProgress] = useState(null);    // { completed, total, active: [{figureStem, phase, plan}] }
  const [chapterResults, setChapterResults] = useState([]);        // accumulated { figureStem, status:'ok'|'error', figureId?, error? }
  const chapterAbortRef = React.useRef(false);

  // Book-wide batch pipeline state
  const [bookRunning, setBookRunning] = useState(false);
  const [bookProgress, setBookProgress] = useState(null); // { completed, total, active: [{figureStem, chapterName, phase}] }
  const [bookResults, setBookResults] = useState([]);     // [{figureStem, chapter, status:'ok'|'error', figureId?, error?}]
  const [bookSummary, setBookSummary] = useState(null);   // set on completion
  const [bookResumeState, setBookResumeState] = useState(null); // { completedStems: [] } when resume prompt is showing
  const bookAbortRef = React.useRef(false);

  // Benchmark batch pipeline state
  const benchmarkAbortRef = React.useRef(false);
  const [benchmarkCandidates, setBenchmarkCandidates] = useState([]);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkProgress, setBenchmarkProgress] = useState(null);
  const [benchmarkResults, setBenchmarkResults] = useState([]);

  // Deferred batch evaluation state
  const [batchEvalRunning, setBatchEvalRunning] = useState(false);
  const [batchEvalProgress, setBatchEvalProgress] = useState(null); // { completed, total, current }
  const [batchEvalResults, setBatchEvalResults] = useState({});     // { [figureId]: { status, evaluation?, error? } }

  // Inline viewer for completed figures (doesn't leave this tab)
  const [previewHtml, setPreviewHtml] = useState(null);
  const [previewName, setPreviewName] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  const handlePreview = async (figureId, name) => {
    setPreviewLoading(true);
    setPreviewName(name);
    try {
      const res = await apiFetch(`/api/result/${figureId}`);
      const data = await res.json();
      if (res.ok && data.html) {
        setPreviewHtml(data.html);
      }
    } catch (_) { }
    setPreviewLoading(false);
  };

  // Load chapter list on mount
  React.useEffect(() => {
    apiFetch('/api/chapters').then(r => r.json()).then(setChapters).catch(() => { });
  }, []);

  // Persist chapter selection and batch gen type
  React.useEffect(() => {
    window.localStorage.setItem(CHAPTERS_STORAGE_KEY, JSON.stringify(selectedChapters));
  }, [selectedChapters]);
  React.useEffect(() => {
    window.localStorage.setItem(BATCH_GEN_TYPE_STORAGE_KEY, batchGenType);
  }, [batchGenType]);

  // Load candidates for all selected chapters
  React.useEffect(() => {
    if (selectedChapters.length === 0) { setChapterCandidates([]); return; }
    setLoadingChapter(true);
    Promise.all(
      selectedChapters.map(ch =>
        apiFetch(`/api/chapter-candidates/${encodeURIComponent(ch)}`)
          .then(r => r.json())
          .then(data => data.map(c => ({ ...c, chapterName: ch })))
      )
    )
      .then(arrays => { setChapterCandidates(arrays.flat()); setLoadingChapter(false); })
      .catch(() => setLoadingChapter(false));
  }, [selectedChapters]);

  const processFile = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      onImageSelected({
        base64,
        mediaType: file.type,
        filename: file.name,
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    processFile(e.dataTransfer.files[0]);
  };

  const handleRunChapter = async () => {
    if (selectedChapters.length === 0 || chapterCandidates.length === 0) return;
    if (!selectedModel) {
      onError?.('Set a generator model in the Generator tab first.');
      return;
    }
    const filteredCandidates = batchGenType === 'both' ? chapterCandidates
      : chapterCandidates.filter(c => batchGenType === '2d' ? c.type === '2d' : c.type !== '2d');
    if (filteredCandidates.length === 0) {
      onError?.(`No ${batchGenType.toUpperCase()} candidates in the selected chapters.`);
      return;
    }
    if (!selectedExperiment || !selectedExperiment.trim()) {
      onError?.('Select or type an experiment name before generating.');
      return;
    }
    setChapterRunning(true);
    setChapterResults([]);
    setBatchEvalRunning(false);
    setBatchEvalProgress(null);
    setBatchEvalResults({});
    chapterAbortRef.current = false;

    const total = filteredCandidates.length;
    const results = [];
    const activeMap = new Map();

    const updateProgress = () => {
      setChapterProgress({ completed: results.length, total, active: [...activeMap.values()] });
    };

    const processFigure = async (candidate) => {
      if (chapterAbortRef.current) return;
      activeMap.set(candidate.stem, { figureStem: candidate.stem, phase: 'looping' });
      updateProgress();

      try {
        const is2dCandidate = candidate.type === '2d';
        const loopResult = is2dCandidate
          ? await runGenerationJob2d({
            base64: candidate.base64,
            mediaType: candidate.mediaType,
            filename: candidate.filename,
            model: selectedModel || undefined,
            plannerModel: selectedPlannerModel || undefined,
            experiment: selectedExperiment || undefined,
          })
          : await runGenerationLoop({
            base64: candidate.base64,
            mediaType: candidate.mediaType,
            filename: candidate.filename,
            figureStem: candidate.stem,
            chapterName: candidate.chapterName,
            model: selectedModel || undefined,
            plannerModel: selectedPlannerModel || undefined,
            evalModel: selectedCriticModel || undefined,
            criticVersion: 'benchmark',
            experiment: selectedExperiment || undefined,
            fewShot,
          });

        if (chapterAbortRef.current) { activeMap.delete(candidate.stem); return; }

        results.push({
          figureStem: candidate.stem,
          status: 'ok',
          figureId: loopResult.figureId,
        });
      } catch (err) {
        results.push({ figureStem: candidate.stem, status: 'error', error: err.message });
      }

      activeMap.delete(candidate.stem);
      setChapterResults([...results]);
      updateProgress();
    };

    const queue = [...filteredCandidates];
    const runWorker = async () => {
      while (queue.length > 0 && !chapterAbortRef.current) {
        const candidate = queue.shift();
        if (candidate) await processFigure(candidate);
      }
    };
    await Promise.all(Array.from({ length: Math.min(chapterGenerationConcurrency, total) }, () => runWorker()));

    setChapterProgress(null);
    setChapterRunning(false);
  };

  const handleAbortChapter = () => { chapterAbortRef.current = true; };

  const handleRunBook = async () => {
    if (!selectedModel) { onError?.('Set a generator model in the Settings first.'); return; }
    if (!selectedExperiment || !selectedExperiment.trim()) {
      onError?.('Select or type an experiment name before generating.');
      return;
    }

    // Check for an existing checkpoint and prompt to resume if found
    try {
      const cpRes = await apiFetch(`/api/book-checkpoint/${encodeURIComponent(selectedExperiment)}`);
      const cpData = await cpRes.json();
      if (cpData.completedStems?.length > 0) {
        setBookResumeState({ completedStems: cpData.completedStems });
        return;
      }
    } catch { }

    await startBookGeneration([]);
  };

  const handleResumeBook = async () => {
    const skipStems = bookResumeState?.completedStems || [];
    setBookResumeState(null);
    await startBookGeneration(skipStems);
  };

  const handleFreshBook = async () => {
    setBookResumeState(null);
    try {
      await apiFetch(`/api/book-checkpoint/${encodeURIComponent(selectedExperiment)}`, { method: 'DELETE' });
    } catch { }
    await startBookGeneration([]);
  };

  const startBookGeneration = async (skipStems) => {
    setBookRunning(true);
    setBookResults([]);
    setBookSummary(null);
    bookAbortRef.current = false;

    // Fetch all chapters + their candidates in chapter order
    let allCandidates = [];
    try {
      const chaptersRes = await apiFetch('/api/chapters');
      const chaptersData = await chaptersRes.json();
      for (const ch of chaptersData) {
        if (bookAbortRef.current) break;
        if ((ch.candidateCount || 0) + (ch.candidateCount2d || 0) === 0) continue;
        const candidatesRes = await apiFetch(`/api/chapter-candidates/${encodeURIComponent(ch.name)}`);
        const candidates = await candidatesRes.json();
        for (const c of candidates) allCandidates.push({ ...c, chapterName: ch.name });
      }
    } catch (err) {
      onError?.(`Failed to load book candidates: ${err.message}`);
      setBookRunning(false);
      return;
    }

    // Filter by batch gen type
    if (batchGenType !== 'both') {
      allCandidates = allCandidates.filter(c => batchGenType === '2d' ? c.type === '2d' : c.type !== '2d');
    }

    // Separate skipped (already done) from candidates to actually run
    const skipSet = new Set(skipStems);
    const skippedCandidates = skipSet.size > 0 ? allCandidates.filter(c => skipSet.has(c.stem)) : [];
    const candidatesToRun = skipSet.size > 0 ? allCandidates.filter(c => !skipSet.has(c.stem)) : allCandidates;

    const total = allCandidates.length; // full book total including skipped
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    // Pre-populate results with skipped entries so they show immediately in the list
    const results = skippedCandidates.map(c => ({ figureStem: c.stem, chapter: c.chapterName, status: 'ok', skipped: true }));
    const activeMap = new Map();

    const updateBookProgress = () => {
      setBookProgress({ completed: results.length, total, active: [...activeMap.values()] });
    };
    updateBookProgress();
    setBookResults([...results]);

    const processBookItem = async (item) => {
      if (bookAbortRef.current) return;
      activeMap.set(item.stem, { figureStem: item.stem, chapterName: item.chapterName, phase: 'looping' });
      updateBookProgress();
      try {
        const is2d = item.type === '2d';
        const loopResult = is2d
          ? await runGenerationJob2d({
            base64: item.base64,
            mediaType: item.mediaType,
            filename: item.filename,
            model: selectedModel || undefined,
            plannerModel: selectedPlannerModel || undefined,
            experiment: selectedExperiment || undefined,
          })
          : await runGenerationLoop({
            base64: item.base64,
            mediaType: item.mediaType,
            filename: item.filename,
            figureStem: item.stem,
            chapterName: item.chapterName,
            model: selectedModel || undefined,
            plannerModel: selectedPlannerModel || undefined,
            evalModel: selectedCriticModel || undefined,
            criticVersion: 'benchmark',
            experiment: selectedExperiment || undefined,
            fewShot,
          });
        if (bookAbortRef.current) { activeMap.delete(item.stem); return; }
        results.push({ figureStem: item.stem, chapter: item.chapterName, status: 'ok', figureId: loopResult.figureId });
        // Checkpoint successful figures so generation can be resumed if interrupted
        try {
          await apiFetch(`/api/book-checkpoint/${encodeURIComponent(selectedExperiment)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stem: item.stem }),
          });
        } catch { }
      } catch (err) {
        results.push({ figureStem: item.stem, chapter: item.chapterName, status: 'error', error: err.message });
      }
      activeMap.delete(item.stem);
      setBookResults([...results]);
      updateBookProgress();
    };

    const queue = [...candidatesToRun];
    const runWorker = async () => {
      while (queue.length > 0 && !bookAbortRef.current) {
        const item = queue.shift();
        if (item) await processBookItem(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(chapterGenerationConcurrency, total) }, () => runWorker()));

    const completedAt = new Date().toISOString();
    const totalTimeMs = Date.now() - startMs;
    const errorList = results.filter(r => r.status === 'error').map(r => ({ figureStem: r.figureStem, chapter: r.chapter, error: r.error }));
    const summary = {
      experiment: selectedExperiment,
      startedAt,
      completedAt,
      totalTimeMs,
      totalFigures: results.length,
      successCount: results.filter(r => r.status === 'ok').length,
      errorCount: errorList.length,
      errors: errorList,
    };

    try {
      await apiFetch('/api/book-generation-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summary),
      });
    } catch (_) { }

    // Delete checkpoint — run is complete, next run should start fresh
    if (!bookAbortRef.current) {
      try {
        await apiFetch(`/api/book-checkpoint/${encodeURIComponent(selectedExperiment)}`, { method: 'DELETE' });
      } catch { }
    }

    setBookSummary(summary);
    setBookProgress(null);
    setBookRunning(false);
  };

  const handleAbortBook = () => { bookAbortRef.current = true; };

  // Load benchmark candidates when switching to benchmark mode
  React.useEffect(() => {
    if (mode !== 'benchmark') return;
    setBenchmarkLoading(true);
    const byChapter = {};
    for (const { chapter, stem } of BENCHMARK_FIGURES) {
      if (!byChapter[chapter]) byChapter[chapter] = new Set();
      byChapter[chapter].add(stem);
    }
    Promise.all(
      Object.entries(byChapter).map(([ch, stems]) =>
        apiFetch(`/api/chapter-candidates/${encodeURIComponent(ch)}`)
          .then(r => r.json())
          .then(data => data.filter(c => stems.has(c.stem)).map(c => ({ ...c, chapterName: ch })))
          .catch(() => [])
      )
    ).then(arrays => {
      const stemOrder = BENCHMARK_FIGURES.map(f => f.stem);
      const flat = arrays.flat();
      flat.sort((a, b) => stemOrder.indexOf(a.stem) - stemOrder.indexOf(b.stem));
      setBenchmarkCandidates(flat);
      setBenchmarkLoading(false);
    });
  }, [mode]);

  const handleRunBenchmark = async () => {
    if (benchmarkCandidates.length === 0) return;
    if (!selectedModel) { onError?.('Set a generator model in Settings first.'); return; }
    if (!selectedExperiment?.trim()) { onError?.('Select or type an experiment name before generating.'); return; }

    setBenchmarkRunning(true);
    setBenchmarkResults([]);
    benchmarkAbortRef.current = false;

    const total = benchmarkCandidates.length;
    const results = [];
    const activeMap = new Map();

    const updateProgress = () => {
      setBenchmarkProgress({ completed: results.length, total, active: [...activeMap.values()] });
    };

    const processFigure = async (candidate) => {
      if (benchmarkAbortRef.current) return;
      activeMap.set(candidate.stem, { figureStem: candidate.stem, phase: 'looping' });
      updateProgress();
      try {
        const loopResult = await runGenerationLoop({
          base64: candidate.base64,
          mediaType: candidate.mediaType,
          filename: candidate.filename,
          figureStem: candidate.stem,
          chapterName: candidate.chapterName,
          model: selectedModel || undefined,
          plannerModel: selectedPlannerModel || undefined,
          evalModel: selectedCriticModel || undefined,
          criticVersion: 'benchmark',
          experiment: selectedExperiment || undefined,
          fewShot,
        });
        if (benchmarkAbortRef.current) { activeMap.delete(candidate.stem); return; }
        results.push({ figureStem: candidate.stem, status: 'ok', figureId: loopResult.figureId });
      } catch (err) {
        results.push({ figureStem: candidate.stem, status: 'error', error: err.message });
      }
      activeMap.delete(candidate.stem);
      setBenchmarkResults([...results]);
      updateProgress();
    };

    const queue = [...benchmarkCandidates];
    const runWorker = async () => {
      while (queue.length > 0 && !benchmarkAbortRef.current) {
        const candidate = queue.shift();
        if (candidate) await processFigure(candidate);
      }
    };
    await Promise.all(Array.from({ length: Math.min(chapterGenerationConcurrency, total) }, () => runWorker()));

    setBenchmarkProgress(null);
    setBenchmarkRunning(false);
  };

  const handleAbortBenchmark = () => { benchmarkAbortRef.current = true; };

  // Select a chapter candidate to load it into the figure drop zone (still works for individual)
  const handleSelectCandidate = (candidate) => {
    if (chapterRunning) return; // don't interrupt batch
    onImageSelected({
      base64: candidate.base64,
      mediaType: candidate.mediaType,
      filename: candidate.filename,
      previewUrl: `data:${candidate.mediaType};base64,${candidate.base64}`,
    });
    onFigureTypeChange?.(candidate.type === '2d' ? '2d' : '3d');
    setMode('figure');
  };

  return (
    <div style={styles.genWrap}>
      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          style={{ ...styles.modeBtn, ...(mode === 'figure' ? styles.modeBtnActive : {}) }}
          onClick={() => setMode('figure')}
        >Drop a Figure</button>
        <button
          style={{ ...styles.modeBtn, ...(mode === 'chapter' ? styles.modeBtnActive : {}) }}
          onClick={() => setMode('chapter')}
        >Select Chapter</button>
        <button
          style={{ ...styles.modeBtn, ...(mode === 'book' ? styles.modeBtnActive : {}) }}
          onClick={() => setMode('book')}
        >Generate Entire Book</button>
        <button
          style={{ ...styles.modeBtn, ...(mode === 'benchmark' ? styles.modeBtnActive : {}) }}
          onClick={() => setMode('benchmark')}
        >Benchmark (30)</button>
      </div>
      <details style={styles.generatorSettingsDetails}>
        <summary style={styles.generatorSettingsSummary}>Settings</summary>
        <div style={styles.generatorSettingsBody}>
          <div style={styles.generatorControlRow}>
            <div style={styles.generatorModelStack}>
              <div style={styles.generatorExperimentCard}>
                <label style={styles.generatorModelLabel}>Experiment Name</label>
                <div style={styles.generatorExperimentControls}>
                  <select
                    style={styles.generatorModelSelect}
                    value={experimentOptions.includes(selectedExperiment) ? selectedExperiment : ''}
                    onChange={e => onExperimentChange?.(e.target.value)}
                    disabled={experimentOptions.length === 0}
                  >
                    <option value="">Select a past experiment...</option>
                    {experimentOptions.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <input
                    style={styles.generatorTextInput}
                    value={selectedExperiment}
                    onChange={e => onExperimentChange?.(e.target.value)}
                    placeholder="Or type a new experiment name"
                  />
                </div>
                <p style={styles.generatorHint}>
                  Pick an existing name from the dropdown, or type a new one to create a fresh experiment bucket.
                </p>
              </div>
              <div style={styles.generatorControlCard}>
                <label style={styles.generatorModelLabel}>Generator Model</label>
                <select
                  style={styles.generatorModelSelect}
                  value={selectedModel}
                  onChange={e => onGeneratorModelChange?.(e.target.value)}
                  disabled={models.length === 0}
                >
                  {models.map(m => (
                    <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>
                  ))}
                </select>
              </div>
              <div style={styles.generatorControlCard}>
                <label style={styles.generatorModelLabel}>Planner Model</label>
                <select
                  style={styles.generatorModelSelect}
                  value={selectedPlannerModel}
                  onChange={e => onPlannerModelChange?.(e.target.value)}
                  disabled={models.length === 0}
                >
                  {models.map(m => (
                    <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={styles.generatorModelStack}>
              <div style={styles.generatorControlCard}>
                <label style={styles.generatorModelLabel}>Critic Model</label>
                <select
                  style={styles.generatorModelSelect}
                  value={selectedCriticModel}
                  onChange={e => onCriticModelChange?.(e.target.value)}
                  disabled={models.length === 0}
                >
                  {models.map(m => (
                    <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>
                  ))}
                </select>
              </div>
              <div style={styles.generatorControlCard}>
                <label style={styles.generatorModelLabel}>Few-shot Prompts</label>
                {['planner', 'critic', 'orchestrator'].map(key => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer', padding: '2px 0' }}>
                    <input
                      type="checkbox"
                      checked={fewShot[key] !== false}
                      onChange={e => onFewShotChange?.({ ...fewShot, [key]: e.target.checked })}
                      style={{ width: 14, height: 14, cursor: 'pointer' }}
                    />
                    {key.charAt(0).toUpperCase() + key.slice(1)}
                  </label>
                ))}
                <p style={styles.generatorHint}>Uncheck to ablate few-shot examples from that component's prompt.</p>
              </div>
            </div>
          </div>
        </div>
      </details>

      {mode === 'figure' ? (
        <>
          {/* Drop zone */}
          <div
            style={{ ...styles.dropZone, ...(dragging ? styles.dropZoneActive : {}) }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById('fileInput').click()}
          >
            {image ? (
              <img src={image.previewUrl} alt="preview" style={styles.preview} />
            ) : (
              <div style={styles.dropHint}>
                <p>Drag &amp; drop a PNG/JPG here, or click to select</p>
              </div>
            )}
            <input
              id="fileInput"
              type="file"
              accept="image/png,image/jpeg"
              style={{ display: 'none' }}
              onChange={(e) => processFile(e.target.files[0])}
            />
          </div>

          {image && <p style={styles.filename}>{image.filename}</p>}

          {/* Plan preview panel — shown automatically once planning completes */}
          {(planning || plan) && (
            <div style={styles.planPanel}>
              {planning && !plan && (
                <p style={{ fontSize: 12, color: '#4a90d9', margin: 0 }}>⏳ Planning interactions…</p>
              )}
              {plan && (
                <>
                  {(() => {
                    const planPayload = plan.interactionPlan || plan;
                    return (
                      <>
                        <div style={styles.planHeader}>
                          <span style={styles.planTitle}>📋 Interaction Plan</span>
                          {plan.chapterName && <span style={styles.planChapter}>Chapter: {plan.chapterName}</span>}
                        </div>
                        {planPayload ? (
                          <details open style={styles.planFieldsDetails}>
                            <summary style={styles.planFieldsSummary}>Plan details</summary>
                            <PlanFields data={planPayload} excludeKeys={['contextChunk', 'chapterName']} />
                          </details>
                        ) : (
                          <p style={{ fontSize: 12, color: '#c60', margin: '4px 0' }}>⚠ No interaction plan returned — generating from image only.</p>
                        )}
                        {plan.contextChunk && (
                          <details style={{ marginTop: 8 }}>
                            <summary style={{ fontSize: 11, color: '#aaa', cursor: 'pointer', userSelect: 'none' }}>Show textbook context</summary>
                            <pre style={styles.planContext}>{plan.contextChunk.slice(0, 1500)}</pre>
                          </details>
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {/* Collapsible system prompt */}
          <div style={styles.promptSection}>
            <button style={styles.promptToggle} onClick={() => setPromptOpen((v) => !v)}>
              {promptOpen ? '▾' : '▸'} System Prompt (read-only)
            </button>
            {promptOpen && (
              <pre style={styles.promptBox}>{systemPrompt}</pre>
            )}
          </div>

          {error && <p style={styles.errorMsg}>{error}</p>}

          <button
            style={{ ...styles.generateBtn, ...(loading || planning || !image || !selectedModel ? styles.generateBtnDisabled : {}) }}
            onClick={onGenerate}
            disabled={loading || planning || !image || !selectedModel}
          >
            {planning ? 'Planning…' : loading ? 'Generating — this may take 1-2min…' : figureType === '2d' ? 'Generate 2D Figure' : 'Generate 3D Figure'}
          </button>
        </>
      ) : mode === 'chapter' ? (
        /* Chapter mode */
        <div style={styles.chapterMode}>
          <label style={styles.chapterLabel}>Select chapters:</label>
          <div style={{ border: '1px solid #ddd', borderRadius: 6, maxHeight: 180, overflowY: 'auto', background: '#fff' }}>
            {chapters.map(ch => {
              const count = (ch.candidateCount || 0) + (ch.candidateCount2d || 0);
              const checked = selectedChapters.includes(ch.name);
              return (
                <label key={ch.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', cursor: count > 0 ? 'pointer' : 'default', opacity: count > 0 ? 1 : 0.4, borderBottom: '1px solid #f0f0f0' }}>
                  <input type="checkbox" checked={checked} disabled={count === 0}
                    onChange={e => setSelectedChapters(prev => e.target.checked ? [...prev, ch.name] : prev.filter(c => c !== ch.name))}
                  />
                  <span style={{ fontSize: 13, flex: 1 }}>{ch.name}</span>
                  {count > 0 && (() => { const parts = []; if (ch.candidateCount) parts.push(`${ch.candidateCount} 3D`); if (ch.candidateCount2d) parts.push(`${ch.candidateCount2d} 2D`); return <span style={{ fontSize: 11, color: '#888' }}>({parts.join(' · ')})</span>; })()}
                </label>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, marginBottom: 4 }}>
            <button style={styles.smallBtn} onClick={() => setSelectedChapters([])}>Clear</button>
          </div>

          {/* Generation type filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: '#555', fontWeight: 600 }}>Generate:</span>
            {[['both', '3D + 2D'], ['3d', '3D only'], ['2d', '2D only']].map(([v, label]) => (
              <button key={v} style={{ ...styles.smallBtn, background: batchGenType === v ? '#4a90d9' : '#fff', color: batchGenType === v ? '#fff' : '#555', borderColor: batchGenType === v ? '#4a90d9' : '#ddd', fontWeight: batchGenType === v ? 700 : 400 }} onClick={() => setBatchGenType(v)}>{label}</button>
            ))}
          </div>

          {loadingChapter && <p style={{ fontSize: 12, color: '#888' }}>Loading candidates…</p>}

          {selectedChapters.length > 0 && chapterCandidates.length > 0 && (() => {
            const filteredForRender = batchGenType === 'both' ? chapterCandidates
              : chapterCandidates.filter(c => batchGenType === '2d' ? c.type === '2d' : c.type !== '2d');
            return (
              <>
                {/* Candidate thumbnail grid — clickable to go to single-figure mode */}
                <div style={styles.candidateGrid}>
                  {chapterCandidates.map((c) => {
                    const excluded = batchGenType !== 'both' && (batchGenType === '2d' ? c.type !== '2d' : c.type === '2d');
                    const done = chapterResults.find(r => r.figureStem === c.stem);
                    const isCurrent = chapterProgress?.active?.some(a => a.figureStem === c.stem);
                    const borderColor = done ? (done.status === 'ok' ? '#4caf50' : '#e74c3c') : isCurrent ? '#4a90d9' : 'transparent';
                    return (
                      <div key={`${c.chapterName}/${c.stem}`} style={{ ...styles.candidateCard, border: `2px solid ${borderColor}`, opacity: excluded ? 0.25 : (chapterRunning && !isCurrent && !done ? 0.4 : 1), position: 'relative' }}>
                        <img src={`data:${c.mediaType};base64,${c.base64}`} alt={c.stem} style={styles.candidateThumb}
                          onClick={() => handleSelectCandidate(c)} />
                        <div style={{ position: 'absolute', top: 4, left: 4, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: c.type === '2d' ? '#a855f7' : '#4a90d9', color: '#fff', letterSpacing: '0.5px' }}>
                          {c.type === '2d' ? '2D' : '3D'}
                        </div>
                        <p style={styles.candidateName}>
                          {done ? (done.status === 'ok' ? '✓ ' : '✗ ') : isCurrent ? '⏳ ' : ''}
                          {c.stem}
                        </p>
                        {done && done.status === 'ok' && done.figureId && (
                          <button
                            style={{ position: 'absolute', top: 4, right: 4, fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #4caf50', background: '#fff', color: '#4caf50', cursor: 'pointer', fontWeight: 600 }}
                            onClick={(e) => { e.stopPropagation(); handlePreview(done.figureId, c.stem); }}
                          >👁 View</button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Generate All / Stop button */}
                {!chapterRunning ? (
                  <button
                    style={{ ...styles.generateBtn, marginTop: 12, ...(!selectedModel ? styles.generateBtnDisabled : {}) }}
                    onClick={handleRunChapter}
                    disabled={!selectedModel}
                  >
                    Generate {filteredForRender.length} Figure{filteredForRender.length !== 1 ? 's' : ''}
                  </button>
                ) : (
                  <button
                    style={{ ...styles.generateBtn, marginTop: 12, background: '#e74c3c', borderColor: '#e74c3c' }}
                    onClick={handleAbortChapter}
                  >
                    Stop After Current Figures
                  </button>
                )}

                {/* Live progress: figures currently running through the iterative loop */}
                {chapterProgress && (
                  <div style={{ ...styles.planPanel, marginTop: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>
                        {chapterProgress.active?.length || 0} active ({chapterProgress.completed} / {chapterProgress.total} done)
                      </span>
                      <span style={{ fontSize: 11, color: '#888' }}>
                        Concurrency: {chapterGenerationConcurrency}
                      </span>
                    </div>

                    {/* Progress bar */}
                    <div style={{ height: 4, background: '#eee', borderRadius: 2, marginBottom: 10, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#4caf50', borderRadius: 2, transition: 'width 0.3s', width: `${(chapterProgress.completed / chapterProgress.total) * 100}%` }} />
                    </div>

                    {/* Show each active figure */}
                    {chapterProgress.active?.map(a => {
                      const planPayload = a.plan?.interactionPlan || a.plan;
                      return (
                        <div key={a.figureStem} style={{ marginBottom: 10, padding: '8px 10px', background: '#f8faff', borderRadius: 6, border: '1px solid #e0e8f0' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>
                              🔄 {a.figureStem} — {a.phase}
                            </span>
                          </div>
                          {planPayload?.concept && (
                            <p style={styles.planConcept}>{planPayload.concept}</p>
                          )}
                          {planPayload?.elements?.length > 0 && (
                            <div style={{ marginBottom: 6 }}>
                              <span style={styles.planSubhead}>Elements:</span>
                              <span style={styles.planList}>{planPayload.elements.join(', ')}</span>
                            </div>
                          )}
                          {planPayload?.interactions?.length > 0 && (
                            <div style={{ marginBottom: 4 }}>
                              <span style={styles.planSubhead}>Interactions:</span>
                              {planPayload.interactions.map((inter, i) => (
                                <div key={i} style={styles.planInteraction}>
                                  <span style={styles.planInterType}>{inter.type}</span>
                                  <span style={styles.planInterLabel}>{inter.label}</span>
                                  <span style={styles.planInterTeaches}>— {inter.teaches}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {planPayload?.demo_steps?.length > 0 && (
                            <p style={styles.planList}>Demo steps: {planPayload.demo_steps.length}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Completed results summary — shown during AND after generation */}
                {chapterResults.length > 0 && (
                  <div style={{ ...styles.chapterPlansWrap, marginTop: 12 }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#333' }}>
                      Results: {chapterResults.filter(r => r.status === 'ok').length}/{chapterResults.length} {chapterRunning ? 'so far' : 'succeeded'}
                    </h4>
                    {chapterResults.map((r, i) => (
                      <div key={r.figureStem} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12, borderBottom: '1px solid #f0f0f0' }}>
                        <span style={{ color: r.status === 'ok' ? '#4caf50' : '#e74c3c', fontWeight: 700 }}>
                          {r.status === 'ok' ? '✓' : '✗'}
                        </span>
                        <span style={{ flex: 1 }}>{r.figureStem}</span>
                        {r.status === 'ok' && r.figureId && (
                          <button
                            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #4caf50', background: '#fff', color: '#4caf50', cursor: 'pointer', fontWeight: 600 }}
                            onClick={() => handlePreview(r.figureId, r.figureStem)}
                          >👁 View</button>
                        )}
                        {r.error && <span style={{ color: '#e74c3c', fontSize: 11 }}>{r.error}</span>}
                      </div>
                    ))}
                    {/* Auto-evaluation progress — shown while evaluating */}
                    {batchEvalRunning && (
                      <div style={{ marginTop: 10, padding: '8px 0' }}>
                        <div style={{ fontSize: 12, color: '#6c5ce7', fontWeight: 600, marginBottom: 4 }}>
                          🧪 Evaluating… {batchEvalProgress?.completed || 0}/{batchEvalProgress?.total || '?'}
                          {batchEvalProgress?.current && <span style={{ fontWeight: 400, color: '#888' }}> — {batchEvalProgress.current}</span>}
                        </div>
                        <div style={{ height: 4, background: '#eee', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: '#6c5ce7', borderRadius: 2, transition: 'width 0.3s', width: `${((batchEvalProgress?.completed || 0) / (batchEvalProgress?.total || 1)) * 100}%` }} />
                        </div>
                      </div>
                    )}

                    {/* Show eval scores inline */}
                    {Object.keys(batchEvalResults).length > 0 && (
                      <div style={{ marginTop: 8, padding: '6px 0', borderTop: '1px solid #e0e0e0' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#6c5ce7' }}>Evaluation Scores:</span>
                        {chapterResults.filter(r => r.status === 'ok' && batchEvalResults[r.figureId]).map(r => {
                          const ev = batchEvalResults[r.figureId];
                          return (
                            <div key={r.figureId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 11, color: '#555' }}>
                              <span style={{ color: ev.status === 'ok' ? '#4caf50' : '#e74c3c', fontWeight: 700 }}>
                                {ev.status === 'ok' ? '✓' : '✗'}
                              </span>
                              <span style={{ flex: 1 }}>{r.figureStem}</span>
                              {ev.evaluation?.overall_average != null && (
                                <span style={{ fontWeight: 700, color: ev.evaluation.overall_average >= 4 ? '#4caf50' : ev.evaluation.overall_average >= 3 ? '#f39c12' : '#e74c3c' }}>
                                  {ev.evaluation.overall_average.toFixed(1)}/5
                                </span>
                              )}
                              {ev.error && <span style={{ color: '#e74c3c' }}>{ev.error}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!chapterRunning && <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Also available in the Results tab.</p>}
                  </div>
                )}
              </>
            );
          })()}

          {selectedChapters.length > 0 && chapterCandidates.length === 0 && !loadingChapter && (
            <p style={{ fontSize: 12, color: '#aaa', marginTop: 12 }}>No candidates found for the selected chapters.</p>
          )}
        </div>
      ) : mode === 'book' ? (
        /* Book mode */
        <div style={styles.bookMode}>
          <p style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
            Generates figures for every chapter in the book concurrently (up to {chapterGenerationConcurrency} at a time), in chapter order. A summary report is written to <code>results/</code> when done.
          </p>

          {/* Generation type filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: '#555', fontWeight: 600 }}>Generate:</span>
            {[['both', '3D + 2D'], ['3d', '3D only'], ['2d', '2D only']].map(([v, label]) => (
              <button key={v} style={{ ...styles.smallBtn, background: batchGenType === v ? '#4a90d9' : '#fff', color: batchGenType === v ? '#fff' : '#555', borderColor: batchGenType === v ? '#4a90d9' : '#ddd', fontWeight: batchGenType === v ? 700 : 400 }} onClick={() => setBatchGenType(v)}>{label}</button>
            ))}
          </div>

          {bookResumeState ? (
            <div style={{ padding: '12px 14px', background: '#fffbf0', border: '1px solid #f39c12', borderRadius: 8, marginBottom: 8 }}>
              <p style={{ fontSize: 13, color: '#555', margin: '0 0 10px' }}>
                <strong>{bookResumeState.completedStems.length}</strong> figures already completed for experiment &ldquo;{selectedExperiment}&rdquo;. Resume where you left off, or start over?
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={styles.generateBtn} onClick={handleResumeBook}>
                  Resume (skip {bookResumeState.completedStems.length} done)
                </button>
                <button style={{ ...styles.generateBtn, background: '#888', borderColor: '#888' }} onClick={handleFreshBook}>
                  Start Fresh
                </button>
              </div>
            </div>
          ) : !bookRunning ? (
            <button
              style={{ ...styles.generateBtn, ...(!selectedModel ? styles.generateBtnDisabled : {}) }}
              onClick={handleRunBook}
              disabled={!selectedModel}
            >
              Generate Entire Book
            </button>
          ) : (
            <button
              style={{ ...styles.generateBtn, background: '#e74c3c', borderColor: '#e74c3c' }}
              onClick={handleAbortBook}
            >
              Stop After Current Figures
            </button>
          )}

          {/* Live progress */}
          {bookProgress && (
            <div style={{ ...styles.planPanel, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>
                  {bookProgress.active?.length || 0} active ({bookProgress.completed} / {bookProgress.total} done)
                </span>
                <span style={{ fontSize: 11, color: '#888' }}>Concurrency: {chapterGenerationConcurrency}</span>
              </div>
              <div style={{ height: 4, background: '#eee', borderRadius: 2, marginBottom: 10, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: '#4caf50', borderRadius: 2, transition: 'width 0.3s', width: `${bookProgress.total > 0 ? (bookProgress.completed / bookProgress.total) * 100 : 0}%` }} />
              </div>
              {bookProgress.active?.map(a => (
                <div key={a.figureStem} style={{ marginBottom: 6, padding: '6px 10px', background: '#f8faff', borderRadius: 6, border: '1px solid #e0e8f0', fontSize: 12 }}>
                  <span style={{ fontWeight: 600, color: '#333' }}>🔄 {a.figureStem}</span>
                  <span style={{ color: '#888', marginLeft: 8 }}>{a.chapterName}</span>
                </div>
              ))}
            </div>
          )}

          {/* Results list */}
          {bookResults.length > 0 && (
            <div style={{ ...styles.chapterPlansWrap, marginTop: 12 }}>
              <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#333' }}>
                Results: {bookResults.filter(r => r.status === 'ok').length}/{bookResults.length} {bookRunning ? 'so far' : 'succeeded'}
              </h4>
              {bookResults.map(r => (
                <div key={`${r.chapter}/${r.figureStem}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12, borderBottom: '1px solid #f0f0f0', opacity: r.skipped ? 0.5 : 1 }}>
                  <span style={{ color: r.skipped ? '#aaa' : r.status === 'ok' ? '#4caf50' : '#e74c3c', fontWeight: 700 }}>{r.status === 'ok' ? '✓' : '✗'}</span>
                  <span style={{ color: '#888', minWidth: 120 }}>{r.chapter}</span>
                  <span style={{ flex: 1 }}>{r.figureStem}</span>
                  {r.skipped && <span style={{ color: '#aaa', fontSize: 11 }}>skipped</span>}
                  {!r.skipped && r.status === 'ok' && r.figureId && (
                    <button style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #4caf50', background: '#fff', color: '#4caf50', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => handlePreview(r.figureId, r.figureStem)}>👁 View</button>
                  )}
                  {r.error && <span style={{ color: '#e74c3c', fontSize: 11 }}>{r.error}</span>}
                </div>
              ))}
              {!bookRunning && <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Also available in the Results tab.</p>}
            </div>
          )}

          {/* Completion summary */}
          {bookSummary && !bookRunning && (
            <div style={{ marginTop: 12, padding: '12px 14px', background: bookSummary.errorCount === 0 ? '#f0faf0' : '#fff8f0', border: `1px solid ${bookSummary.errorCount === 0 ? '#4caf50' : '#f39c12'}`, borderRadius: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: '#333' }}>Book generation complete</div>
              <div style={{ fontSize: 12, color: '#555', lineHeight: 1.7 }}>
                <div>Figures: {bookSummary.successCount} succeeded, {bookSummary.errorCount} failed (of {bookSummary.totalFigures} total)</div>
                <div>Total time: {(bookSummary.totalTimeMs / 1000 / 60).toFixed(1)} min</div>
                <div>Report saved to <code>results/book_run_{bookSummary.experiment}_….json</code></div>
              </div>
              {bookSummary.errors.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#e74c3c', marginBottom: 4 }}>Failed figures:</div>
                  {bookSummary.errors.map(e => (
                    <div key={`${e.chapter}/${e.figureStem}`} style={{ fontSize: 11, color: '#e74c3c', padding: '2px 0' }}>
                      {e.chapter}/{e.figureStem} — {e.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Benchmark mode */
        <div style={styles.chapterMode}>
          <p style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
            Runs the fixed benchmark set of {BENCHMARK_FIGURES.length} figures concurrently (up to {chapterGenerationConcurrency} at a time). Edit <code>src/benchmarkFigures.js</code> to change the list.
          </p>

          {benchmarkLoading && <p style={{ fontSize: 12, color: '#888' }}>Loading benchmark candidates…</p>}

          {!benchmarkLoading && benchmarkCandidates.length > 0 && (
            <>
              <div style={styles.candidateGrid}>
                {benchmarkCandidates.map((c) => {
                  const done = benchmarkResults.find(r => r.figureStem === c.stem);
                  const isCurrent = benchmarkProgress?.active?.some(a => a.figureStem === c.stem);
                  const borderColor = done ? (done.status === 'ok' ? '#4caf50' : '#e74c3c') : isCurrent ? '#4a90d9' : 'transparent';
                  return (
                    <div key={`${c.chapterName}/${c.stem}`} style={{ ...styles.candidateCard, border: `2px solid ${borderColor}`, opacity: benchmarkRunning && !isCurrent && !done ? 0.4 : 1, position: 'relative' }}>
                      <img src={`data:${c.mediaType};base64,${c.base64}`} alt={c.stem} style={styles.candidateThumb}
                        onClick={() => handleSelectCandidate(c)} />
                      <p style={styles.candidateName}>
                        {done ? (done.status === 'ok' ? '✓ ' : '✗ ') : isCurrent ? '⏳ ' : ''}
                        {c.stem}
                      </p>
                      <p style={{ fontSize: 9, color: '#aaa', margin: '-4px 0 0', padding: '0 4px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.chapterName}</p>
                      {done && done.status === 'ok' && done.figureId && (
                        <button
                          style={{ position: 'absolute', top: 4, right: 4, fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid #4caf50', background: '#fff', color: '#4caf50', cursor: 'pointer', fontWeight: 600 }}
                          onClick={(e) => { e.stopPropagation(); handlePreview(done.figureId, c.stem); }}
                        >👁 View</button>
                      )}
                    </div>
                  );
                })}
              </div>

              {!benchmarkRunning ? (
                <button
                  style={{ ...styles.generateBtn, marginTop: 12, ...(!selectedModel ? styles.generateBtnDisabled : {}) }}
                  onClick={handleRunBenchmark}
                  disabled={!selectedModel}
                >
                  Run Benchmark ({benchmarkCandidates.length} figures)
                </button>
              ) : (
                <button
                  style={{ ...styles.generateBtn, marginTop: 12, background: '#e74c3c', borderColor: '#e74c3c' }}
                  onClick={handleAbortBenchmark}
                >
                  Stop After Current Figures
                </button>
              )}

              {benchmarkProgress && (
                <div style={{ ...styles.planPanel, marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>
                      {benchmarkProgress.active?.length || 0} active ({benchmarkProgress.completed} / {benchmarkProgress.total} done)
                    </span>
                    <span style={{ fontSize: 11, color: '#888' }}>Concurrency: {chapterGenerationConcurrency}</span>
                  </div>
                  <div style={{ height: 4, background: '#eee', borderRadius: 2, marginBottom: 8, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#4caf50', borderRadius: 2, transition: 'width 0.3s', width: `${(benchmarkProgress.completed / benchmarkProgress.total) * 100}%` }} />
                  </div>
                  {benchmarkProgress.active?.map(a => (
                    <div key={a.figureStem} style={{ marginBottom: 4, padding: '4px 8px', background: '#f8faff', borderRadius: 4, border: '1px solid #e0e8f0', fontSize: 12 }}>
                      <span style={{ fontWeight: 600 }}>⏳ {a.figureStem}</span>
                    </div>
                  ))}
                </div>
              )}

              {benchmarkResults.length > 0 && (
                <div style={{ ...styles.chapterPlansWrap, marginTop: 12 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#333' }}>
                    Results: {benchmarkResults.filter(r => r.status === 'ok').length}/{benchmarkResults.length} {benchmarkRunning ? 'so far' : 'succeeded'}
                  </h4>
                  {benchmarkResults.map((r) => (
                    <div key={r.figureStem} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12, borderBottom: '1px solid #f0f0f0' }}>
                      <span style={{ color: r.status === 'ok' ? '#4caf50' : '#e74c3c', fontWeight: 700 }}>
                        {r.status === 'ok' ? '✓' : '✗'}
                      </span>
                      <span style={{ flex: 1 }}>{r.figureStem}</span>
                      {r.status === 'ok' && r.figureId && (
                        <button
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #4caf50', background: '#fff', color: '#4caf50', cursor: 'pointer', fontWeight: 600 }}
                          onClick={() => handlePreview(r.figureId, r.figureStem)}
                        >👁 View</button>
                      )}
                      {r.error && <span style={{ color: '#e74c3c', fontSize: 11 }}>{r.error}</span>}
                    </div>
                  ))}
                  {!benchmarkRunning && <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Also available in the Results tab.</p>}
                </div>
              )}

              {benchmarkCandidates.length < BENCHMARK_FIGURES.length && (() => {
                const foundStems = new Set(benchmarkCandidates.map(c => c.stem));
                const missing = BENCHMARK_FIGURES.filter(f => !foundStems.has(f.stem));
                return (
                  <div style={{ fontSize: 11, color: '#c60', marginTop: 8 }}>
                    <span style={{ fontWeight: 700 }}>Warning: {missing.length} figure(s) not found in chapter candidates:</span>
                    {missing.map(f => (
                      <div key={`${f.chapter}/${f.stem}`} style={{ paddingLeft: 8, marginTop: 2 }}>
                        {f.chapter} / {f.stem}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          )}

          {!benchmarkLoading && benchmarkCandidates.length === 0 && (
            <p style={{ fontSize: 12, color: '#aaa', marginTop: 12 }}>No benchmark candidates loaded. Check that chapter candidates are available on the server.</p>
          )}
        </div>
      )}

      {/* Inline preview modal — overlays on top without leaving Generator tab */}
      {(previewHtml || previewLoading) && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { setPreviewHtml(null); setPreviewName(''); }}>
          <div style={{ width: '90vw', height: '85vh', background: '#fff', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.3)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #eee', background: '#fafafa' }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: '#333' }}>Preview: {previewName}</span>
              <button
                style={{ fontSize: 18, background: 'none', border: 'none', cursor: 'pointer', color: '#888', padding: '0 4px' }}
                onClick={() => { setPreviewHtml(null); setPreviewName(''); }}
              >✕</button>
            </div>
            {previewLoading && !previewHtml ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>Loading…</div>
            ) : (
              <iframe
                title="preview"
                srcDoc={previewHtml}
                style={{ flex: 1, border: 'none', width: '100%' }}
                sandbox="allow-scripts allow-same-origin"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Viewer Tab ────────────────────────────────────────────────────────────────
function ViewerTab({ record, html, onBack, backLabel, onNew, onDelete, evaluation, evaluationModel, availableEvaluationModels, evaluating, onEvaluate, onSaveHumanEvaluation, onSelectEvaluationModel, defaultEvaluationModel }) {
  const scoreTextColor = (score) => {
    if (!Number.isFinite(score)) return '#888';
    if (score >= 4) return '#2e7d32';
    if (score >= 3) return '#c77800';
    return '#c62828';
  };
  const { evaluationResults, evaluationMetaFiltered } = React.useMemo(() => {
    const { results, meta } = filterExternalEvals(record?.evaluationResults, record?.evaluationMeta);
    return { evaluationResults: results, evaluationMetaFiltered: meta };
  }, [record?.evaluationResults, record?.evaluationMeta]);
  const attempts = React.useMemo(
    () => (Array.isArray(record?.attempts) ? record.attempts.filter(Boolean) : []),
    [record?.attempts]
  );
  const [selectedAttemptIndex, setSelectedAttemptIndex] = React.useState(-1);
  const evaluationModelOptions = React.useMemo(() => {
    const byId = new Map();
    for (const model of availableEvaluationModels || []) {
      if (model?.id) byId.set(model.id, model);
    }
    for (const modelId of Object.keys(evaluationResults)) {
      if (!byId.has(modelId)) byId.set(modelId, { id: modelId, label: modelId });
    }
    return Array.from(byId.values());
  }, [availableEvaluationModels, evaluationResults]);

  // When no eval has been run yet, fall back to the persisted preferred model
  const effectiveEvalModel = evaluationModel || defaultEvaluationModel || DEFAULT_EVALUATION_MODEL;

  React.useEffect(() => {
    setSelectedAttemptIndex(attempts.length > 0 ? attempts.length - 1 : -1);
  }, [record?.id, attempts.length]);

  if (!html) {
    return (
      <div style={styles.empty}>
        No figure generated yet. Go to the <strong>Generator</strong> tab to create one.
      </div>
    );
  }

  const blob = new Blob([html], { type: 'text/html' });
  const downloadUrl = URL.createObjectURL(blob);
  const sourceMediaType = record?.source_media_type || 'image/png';
  const mediaType = record?.mediaType || 'image/png';
  const thumbSrc = record?.source_base64
    ? `data:${sourceMediaType};base64,${record.source_base64}`
    : (record?.base64thumb
      ? `data:${mediaType};base64,${record.base64thumb}`
      : null);
  const viewerPlan = record?.plan || null;
  const hasAttemptHistory = attempts.length > 0;
  const selectedAttempt = hasAttemptHistory
    ? attempts[Math.min(Math.max(selectedAttemptIndex, 0), attempts.length - 1)]
    : null;
  const selectedIterationLabel = selectedAttempt
    ? `Iteration ${typeof selectedAttempt.iteration === 'number' ? Math.max(0, selectedAttempt.iteration - 1) : (selectedAttemptIndex + 1)}`
    : 'Final result';
  const previewHtml = selectedAttempt?.html || html;
  const selectedFeedback = selectedAttempt?.feedback || null;
  const selectedEvaluation = selectedAttempt?.evaluation || null;
  const selectedPlan = selectedAttempt?.plan || viewerPlan;
  return (
    <div style={styles.viewerWrap}>
      {/* Left panel */}
      <div style={styles.viewerLeft}>
        {thumbSrc && (
          <img src={thumbSrc} alt="original" style={styles.thumbImg} />
        )}
        {record?.filename && <p style={styles.viewerFilename}>{record.filename}</p>}
        {record?.timestamp && (
          <p style={styles.viewerTs}>{new Date(record.timestamp).toLocaleString()}</p>
        )}
        {record?.source && (
          <span style={{
            ...styles.sourceBadge,
            ...(record.source === 'chat' ? styles.sourceBadgeChat :
              record.source === 'api' ? styles.sourceBadgeApi :
                { background: '#e8f0ff', color: '#1a3a8a' })
          }}>
            {record.source}
          </span>
        )}
        <p style={styles.viewerMeta}>Generated by: {record?.model || 'unknown'}</p>
        {record?.generationDurationMs != null && (
          <p style={styles.viewerMeta}>Generation time: {formatDuration(record.generationDurationMs)}</p>
        )}
        {selectedPlan ? (
          <div style={styles.viewerPlanWrap}>
            {(() => {
              const planPayload = selectedPlan.interactionPlan || selectedPlan;
              return (
                <>
                  <p style={styles.viewerPlanTitle}>Planner Output</p>
                  {selectedPlan.chapterName && <p style={styles.viewerPlanMeta}>Chapter: {selectedPlan.chapterName}</p>}
                  <details open style={styles.planFieldsDetails}>
                    <summary style={styles.planFieldsSummary}>Plan details</summary>
                    <PlanFields data={planPayload} excludeKeys={['contextChunk', 'chapterName']} />
                  </details>
                  <details>
                    <summary style={styles.viewerPlanSummary}>Show raw plan JSON</summary>
                    <pre style={styles.viewerPlanRaw}>{JSON.stringify(selectedPlan, null, 2)}</pre>
                  </details>
                </>
              );
            })()}
          </div>
        ) : (
          <div style={styles.viewerPlanPlaceholder}>
            No planner output available for this figure.
          </div>
        )}

        <div style={styles.viewerHistoryWrap}>
          <div style={styles.viewerHistoryHeader}>
            <span style={styles.viewerPlanTitle}>Iterations</span>
            {hasAttemptHistory && (
              <span style={styles.viewerHistoryCount}>{attempts.length} stored</span>
            )}
          </div>

          {hasAttemptHistory ? (
            <>
              <div style={styles.viewerHistoryRail}>
                {attempts.map((attempt, index) => {
                  const isActive = index === selectedAttemptIndex;
                  const score = attempt?.evaluation?.overall_average;
                  const attemptLabel = typeof attempt?.iteration === 'number' ? Math.max(0, attempt.iteration - 1) : index + 1;
                  return (
                    <button
                      key={`${record?.id || 'record'}-${attemptLabel}-${index}`}
                      type="button"
                      onClick={() => setSelectedAttemptIndex(index)}
                      style={{
                        ...styles.viewerHistoryButton,
                        ...(isActive ? styles.viewerHistoryButtonActive : {}),
                      }}
                    >
                      <span style={styles.viewerHistoryButtonLabel}>{attemptLabel}</span>
                      <span style={styles.viewerHistoryButtonMeta}>
                        {attempt?.status || attempt?.step || 'attempt'}
                      </span>
                      {Number.isFinite(score) && (
                        <span style={{ ...styles.viewerHistoryScore, color: scoreTextColor(score) }}>
                          {score.toFixed(1)}/5
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div style={styles.viewerHistoryDetail}>
                <div style={styles.viewerHistoryDetailHeader}>
                  <span style={styles.viewerHistoryDetailTitle}>{selectedIterationLabel}</span>
                  {selectedEvaluation?.overall_average != null && (
                    <span style={{ ...styles.viewerHistoryDetailScore, color: scoreTextColor(selectedEvaluation.overall_average) }}>
                      {selectedEvaluation.overall_average}/5
                    </span>
                  )}
                </div>
                {selectedEvaluation && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
                    {[
                      { key: 'geometry_accuracy', label: 'Geo' },
                      { key: 'interactivity_usability', label: 'Inter' },
                      { key: 'faithfulness', label: 'Faith' },
                      { key: 'label_quality', label: 'Lbls' },
                      { key: 'concept_accuracy', label: 'Conc' },
                    ].map(({ key, label }) => {
                      const score = selectedEvaluation[key];
                      if (!Number.isFinite(score)) return null;
                      return (
                        <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <span style={{ fontSize: 8, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: scoreTextColor(score), lineHeight: 1 }}>{score}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {selectedAttempt?.refinement_type && (
                  <p style={styles.viewerHistoryMeta}>Refinement: {selectedAttempt.refinement_type}</p>
                )}
                {selectedFeedback?.next_step && (
                  <p style={styles.viewerHistoryMeta}>Orchestrator decision: {selectedFeedback.next_step}</p>
                )}
                {selectedFeedback?.rationale && (
                  <p style={styles.viewerHistoryNotes}>{selectedFeedback.rationale}</p>
                )}
                {selectedEvaluation?.discrepancies?.length > 0 && (
                  <>
                    <p style={{ ...styles.viewerHistoryMeta, fontWeight: 700, color: '#555' }}>Discrepancies</p>
                    <div style={styles.viewerHistoryList}>
                      {selectedEvaluation.discrepancies.map((item, index) => (
                        <div key={`discrepancy-${index}`} style={styles.viewerHistoryItem}>
                          {item}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {selectedFeedback?.action_items?.length > 0 ? (
                  <>
                    <p style={{ ...styles.viewerHistoryMeta, fontWeight: 700, color: '#555' }}>Action items</p>
                    <div style={styles.viewerHistoryList}>
                      {selectedFeedback.action_items.map((item, index) => (
                        <div key={index} style={styles.viewerHistoryItem}>
                          {item}
                        </div>
                      ))}
                    </div>
                  </>
                ) : selectedEvaluation?.notes ? (
                  <p style={styles.viewerHistoryNotes}>{selectedEvaluation.notes}</p>
                ) : (
                  <p style={styles.viewerHistoryEmpty}>No feedback stored for this iteration.</p>
                )}
              </div>
            </>
          ) : (
            <div style={styles.viewerHistoryEmptyBox}>
              No iteration history stored for this figure.
              <br />
              Older results and direct generations may only include the final output and feedback.
            </div>
          )}
        </div>

        <a href={downloadUrl} download={`figure_${Date.now()}.html`} style={styles.downloadBtn}>
          Download HTML
        </a>
        {record?.id && (
          <button
            style={styles.deleteBtn}
            onClick={() => { if (window.confirm('Delete this figure?')) onDelete(); }}
          >
            Delete
          </button>
        )}
        <EvaluationPanel
          evaluation={evaluation}
          evaluationModel={effectiveEvalModel}
          evaluationModels={evaluationModelOptions}
          evaluationResults={evaluationResults}
          evaluationMeta={evaluationMetaFiltered}
          evaluating={evaluating}
          onEvaluate={onEvaluate}
          onSaveHumanEvaluation={onSaveHumanEvaluation}
          onSelectEvaluationModel={onSelectEvaluationModel}
          canEvaluate={!!(record?.id || record?.htmlPath)}
        />
      </div>

      {/* Right panel: iframe */}
      <div style={styles.viewerRight}>
        <iframe
          title="3d-figure"
          srcDoc={previewHtml}
          sandbox="allow-scripts allow-same-origin"
          style={styles.iframe}
        />
      </div>
    </div>
  );
}

// ── Evaluation Panel ─────────────────────────────────────────────────────────
function EvaluationPanel({ evaluation, evaluationModel, evaluationModels, evaluationResults, evaluationMeta, evaluating, onEvaluate, onSaveHumanEvaluation, onSelectEvaluationModel, canEvaluate }) {
  const [showAllFailures, setShowAllFailures] = React.useState(false);
  const [mode, setMode] = React.useState('ai');
  const [humanScores, setHumanScores] = React.useState({
    geometry_accuracy: 3,
    interactivity_usability: 3,
    faithfulness: 3,
    label_quality: 3,
    concept_accuracy: 3,
  });
  const [humanFailureModes, setHumanFailureModes] = React.useState([]);
  const [humanNotes, setHumanNotes] = React.useState('');
  const [savingHuman, setSavingHuman] = React.useState(false);
  const scoreTextColor = (s) => { const rgb = lerpColor(s); if (!rgb) return '#888'; return `rgb(${Math.round(rgb[0] * 0.6)},${Math.round(rgb[1] * 0.6)},${Math.round(rgb[2] * 0.5)})`; };
  const scoreBarColor = (s) => { const rgb = lerpColor(s); if (!rgb) return '#ccc'; return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`; };
  const selectedModelLabel = evaluationModels?.find(m => m.id === evaluationModel)?.label || evaluationModel || 'unknown';
  const METRICS = [
    { key: 'geometry_accuracy', label: 'Geometry' },
    { key: 'interactivity_usability', label: 'Interact.' },
    { key: 'faithfulness', label: 'Faithful' },
    { key: 'label_quality', label: 'Labels' },
    { key: 'concept_accuracy', label: 'Concept' },
    { key: 'visual_aesthetics', label: 'Visual*' },
  ];
  const humanModelId = React.useMemo(() => {
    const keys = Object.keys(evaluationResults || {});
    if (keys.includes(HUMAN_EVAL_MODEL)) return HUMAN_EVAL_MODEL;
    return keys.find(key => key.startsWith('human:')) || HUMAN_EVAL_MODEL;
  }, [evaluationResults]);
  const existingHumanEvaluation = (evaluationResults || {})[humanModelId] || null;

  React.useEffect(() => {
    if (mode !== 'human') return;
    if (!existingHumanEvaluation) {
      setHumanScores({
        geometry_accuracy: 3,
        interactivity_usability: 3,
        faithfulness: 3,
        label_quality: 3,
        concept_accuracy: 3,
      });
      setHumanFailureModes([]);
      setHumanNotes('');
      return;
    }

    setHumanScores({
      geometry_accuracy: Math.max(1, Math.min(5, Number(existingHumanEvaluation.geometry_accuracy) || 3)),
      interactivity_usability: Math.max(1, Math.min(5, Number(existingHumanEvaluation.interactivity_usability) || 3)),
      faithfulness: Math.max(1, Math.min(5, Number(existingHumanEvaluation.faithfulness) || 3)),
      label_quality: Math.max(1, Math.min(5, Number(existingHumanEvaluation.label_quality) || 3)),
      concept_accuracy: Math.max(1, Math.min(5, Number(existingHumanEvaluation.concept_accuracy) || 3)),
    });
    setHumanFailureModes(Array.isArray(existingHumanEvaluation.failure_modes) ? existingHumanEvaluation.failure_modes : []);
    setHumanNotes(typeof existingHumanEvaluation.notes === 'string' ? existingHumanEvaluation.notes : '');
  }, [mode, existingHumanEvaluation]);

  const modeToggle = (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
      <button
        style={{ ...styles.evalBtn, background: mode === 'ai' ? '#111' : '#fff', color: mode === 'ai' ? '#fff' : '#333', borderColor: mode === 'ai' ? '#111' : '#ddd' }}
        onClick={() => setMode('ai')}
      >
        AI review
      </button>
      <button
        style={{ ...styles.evalBtn, background: mode === 'human' ? '#111' : '#fff', color: mode === 'human' ? '#fff' : '#333', borderColor: mode === 'human' ? '#111' : '#ddd' }}
        onClick={() => setMode('human')}
      >
        Human review
      </button>
    </div>
  );

  const handleToggleFailureMode = (modeName) => {
    setHumanFailureModes(prev => prev.includes(modeName)
      ? prev.filter(m => m !== modeName)
      : [...prev, modeName]
    );
  };

  const handleSubmitHuman = async () => {
    if (!onSaveHumanEvaluation) return;
    setSavingHuman(true);
    try {
      await onSaveHumanEvaluation({
        evaluation: {
          ...humanScores,
          failure_modes: humanFailureModes,
          notes: humanNotes,
        },
      });
    } catch (err) {
      alert('Saving human evaluation failed: ' + (err?.message || 'Unknown error'));
    } finally {
      setSavingHuman(false);
    }
  };

  if (mode === 'human') {
    if (!canEvaluate) return null;
    return (
      <div style={styles.evalSection}>
        {modeToggle}
        <p style={{ fontSize: 10, color: '#666', margin: 0, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Manual review form</p>

        {METRICS.filter(m => m.key !== 'visual_aesthetics').map(({ key, label }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 11, color: '#555' }}>{label}</span>
            <input
              type="number"
              min={1}
              max={5}
              step={1}
              value={humanScores[key]}
              onChange={e => {
                const parsed = Number(e.target.value);
                const clamped = Number.isFinite(parsed) ? Math.max(1, Math.min(5, Math.round(parsed))) : 3;
                setHumanScores(prev => ({ ...prev, [key]: clamped }));
              }}
              style={{ width: 56, ...styles.resultFilterSelect, cursor: 'text' }}
            />
          </label>
        ))}

        <div>
          <p style={{ fontSize: 10, color: '#777', margin: '2px 0 6px' }}>Failure modes (optional)</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {HUMAN_FAILURE_MODES.map(modeName => {
              const active = humanFailureModes.includes(modeName);
              return (
                <button
                  key={modeName}
                  onClick={() => handleToggleFailureMode(modeName)}
                  style={{
                    ...styles.evalFailureTag,
                    cursor: 'pointer',
                    background: active ? failureModeColor(modeName).bg : '#f7f7f7',
                    color: active ? failureModeColor(modeName).fg : '#666',
                    borderColor: active ? failureModeColor(modeName).border : '#ddd',
                  }}
                >
                  {modeName}
                </button>
              );
            })}
          </div>
        </div>

        <label style={{ display: 'block' }}>
          <span style={{ fontSize: 10, color: '#777', display: 'block', marginBottom: 4 }}>Notes (optional)</span>
          <textarea
            value={humanNotes}
            onChange={e => setHumanNotes(e.target.value)}
            rows={3}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', ...styles.resultFilterSelect, cursor: 'text' }}
          />
        </label>

        <button
          style={{ ...styles.evalBtn, background: savingHuman ? '#f5f5f5' : '#fff', opacity: savingHuman ? 0.8 : 1 }}
          onClick={handleSubmitHuman}
          disabled={savingHuman}
        >
          {savingHuman ? 'Saving…' : 'Save human changes'}
        </button>
      </div>
    );
  }

  if (evaluating) {
    return (
      <div style={styles.evalSection}>
        {modeToggle}
        <p style={{ fontSize: 11, color: '#888', margin: 0 }}>Evaluating {selectedModelLabel}…</p>
      </div>
    );
  }

  const selector = evaluationModels?.length > 0 ? (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <span style={{ fontSize: 10, color: '#777', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Evaluator model</span>
      <select
        style={{ ...styles.resultFilterSelect, width: '100%' }}
        value={evaluationModel || ''}
        onChange={e => onSelectEvaluationModel?.(e.target.value || null)}
      >
        {evaluationModels.map(model => (
          <option key={model.id} value={model.id}>{model.label || model.id}</option>
        ))}
      </select>
    </label>
  ) : null;

  if (!evaluation) {
    if (!canEvaluate) return null;
    return (
      <div style={styles.evalSection}>
        {modeToggle}
        {selector}
        <p style={{ fontSize: 11, color: '#888', margin: '0 0 8px' }}>No evaluation exists for {selectedModelLabel}.</p>
        <button style={styles.evalBtn} onClick={() => onEvaluate(evaluationModel)}>Generate evaluation</button>
      </div>
    );
  }

  const failures = evaluation.failure_modes || [];
  const visible = showAllFailures ? failures : failures.slice(0, 3);

  return (
    <div style={styles.evalSection}>
      {modeToggle}
      {selector}
      <div style={styles.evalHeader}>
        <span style={styles.evalTitle}>Critic feedback</span>
        <span style={{ ...styles.evalOverall, color: scoreTextColor(evaluation.overall_average) }}>
          {evaluation.overall_average}/5
        </span>
      </div>
      <p style={styles.evalMeta}>Model: {selectedModelLabel}</p>

      {METRICS.map(({ key, label }) => (
        <div key={key}>
          <div style={styles.evalRow}>
            <span style={styles.evalLabel}>{label}</span>
            <div style={styles.evalBarBg}>
              <div
                style={{
                  ...styles.evalBar,
                  width: `${((evaluation[key] ?? 0) / 5) * 100}%`,
                  background: scoreBarColor(evaluation[key] ?? 0),
                }}
              />
            </div>
            <span style={{ ...styles.evalScore, color: scoreTextColor(evaluation[key] ?? 0) }}>
              {evaluation[key]}
            </span>
          </div>
          {evaluation[`${key}_reasoning`] && (
            <p style={{ fontSize: 10, color: '#777', margin: '1px 0 2px', fontStyle: 'italic', lineHeight: 1.4 }}>
              {evaluation[`${key}_reasoning`]}
            </p>
          )}
          {evaluation[`${key}_analysis`] && (
            <details style={{ margin: '0 0 6px' }}>
              <summary style={{ fontSize: 9, color: '#aaa', cursor: 'pointer', userSelect: 'none', listStyle: 'none' }}>▸ analysis</summary>
              <p style={{ fontSize: 10, color: '#888', margin: '3px 0 0', lineHeight: 1.5 }}>
                {evaluation[`${key}_analysis`]}
              </p>
            </details>
          )}
        </div>
      ))}

      {failures.length > 0 && (
        <div style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid #e0e0e0' }}>
          <p style={{ fontSize: 10, color: '#555', margin: '0 0 8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Top 3 failure modes</p>
          <div style={styles.evalFailures}>
            {visible.map((f) => (
              <span key={f} style={{ ...styles.evalFailureTag, background: failureModeColor(f).bg, color: failureModeColor(f).fg, borderColor: failureModeColor(f).border }}>{f}</span>
            ))}
            {!showAllFailures && failures.length > 3 && (
              <span
                style={{ ...styles.evalFailureTag, background: '#f5f5f5', color: '#666', border: '1px solid #ddd', cursor: 'pointer' }}
                onClick={() => setShowAllFailures(true)}
              >+{failures.length - 3} more</span>
            )}
            {showAllFailures && failures.length > 3 && (
              <span
                style={{ ...styles.evalFailureTag, background: '#f5f5f5', color: '#666', border: '1px solid #ddd', cursor: 'pointer' }}
                onClick={() => setShowAllFailures(false)}
              >show less</span>
            )}
          </div>
          {evaluation.failure_modes_reasoning && (
            <p style={{ fontSize: 10, color: '#777', margin: '6px 0 2px', fontStyle: 'italic', lineHeight: 1.4 }}>
              {evaluation.failure_modes_reasoning}
            </p>
          )}
          {evaluation.failure_modes_analysis && (
            <details style={{ margin: '0' }}>
              <summary style={{ fontSize: 9, color: '#aaa', cursor: 'pointer', userSelect: 'none', listStyle: 'none' }}>▸ analysis</summary>
              <p style={{ fontSize: 10, color: '#888', margin: '3px 0 0', lineHeight: 1.5 }}>
                {evaluation.failure_modes_analysis}
              </p>
            </details>
          )}
        </div>
      )}

      {evaluation.notes && (
        <p style={styles.evalNotes}>{evaluation.notes}</p>
      )}

      <details open style={styles.planFieldsDetails}>
        <summary style={styles.planFieldsSummary}>Full evaluation details</summary>
        <PlanFields
          data={evaluation}
          excludeKeys={['geometry_accuracy', 'interactivity_usability', 'faithfulness', 'label_quality', 'concept_accuracy', 'visual_aesthetics', 'overall_average', 'failure_modes', 'failure_modes_reasoning', 'failure_modes_analysis', 'notes', 'geometry_accuracy_reasoning', 'geometry_accuracy_analysis', 'interactivity_usability_reasoning', 'interactivity_usability_analysis', 'faithfulness_reasoning', 'faithfulness_analysis', 'label_quality_reasoning', 'label_quality_analysis', 'concept_accuracy_reasoning', 'concept_accuracy_analysis']}
        />
      </details>

    </div>
  );
}

// ── LazyThumb — fetches experiment screenshot only when scrolled into view ─────
function LazyThumb({ htmlPath, style }) {
  const [src, setSrc] = React.useState(null);
  const containerRef = React.useRef(null);

  React.useEffect(() => {
    if (!htmlPath) return;
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      apiFetch('/api/experiments/thumb?path=' + encodeURIComponent(htmlPath))
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (!cancelled && d?.data) setSrc(`data:${d.mediaType};base64,${d.data}`); })
        .catch(() => { });
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); };
  }, [htmlPath]);

  return (
    <div ref={containerRef} style={style}>
      {src
        ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <div style={{ width: '100%', height: '100%', background: '#e8e8e8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 10, color: '#bbb' }}>…</span>
        </div>
      }
    </div>
  );
}

function LazyApiThumb({ id, base64thumb, mediaType, style }) {
  const [src, setSrc] = React.useState(
    base64thumb ? `data:${mediaType || 'image/jpeg'};base64,${base64thumb}` : null
  );
  const containerRef = React.useRef(null);

  React.useEffect(() => {
    if (!id || base64thumb || src) return;
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      apiFetch('/api/thumb/' + encodeURIComponent(id))
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (!cancelled && d?.data) setSrc(`data:${d.mediaType};base64,${d.data}`); })
        .catch(() => { });
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); };
  }, [id, base64thumb, src]);

  return (
    <div ref={containerRef} style={style}>
      {src
        ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <div style={{ width: '100%', height: '100%', background: '#f0f0f0' }} />
      }
    </div>
  );
}

// ── Shared card failure-modes widget ─────────────────────────────────────────
function CardFailureModes({ modes }) {
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded ? modes : modes.slice(0, 3);
  return (
    <div style={{ marginTop: 5 }}>
      <p style={{ fontSize: 10, color: '#555', margin: '0 0 8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Top 3 failure modes</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {visible.map(f => <span key={f} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, background: failureModeColor(f).bg, color: failureModeColor(f).fg, border: `1px solid ${failureModeColor(f).border}`, fontWeight: 500 }}>{f}</span>)}
        {!expanded && modes.length > 3 && (
          <span
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, background: '#f0f0f0', color: '#999', cursor: 'pointer' }}
            onClick={e => { e.stopPropagation(); setExpanded(true); }}
          >+{modes.length - 3} more</span>
        )}
        {expanded && modes.length > 3 && (
          <span
            style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, background: '#f0f0f0', color: '#999', cursor: 'pointer' }}
            onClick={e => { e.stopPropagation(); setExpanded(false); }}
          >show less</span>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function humanTitle(stem) {
  return stem.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Turns any object key (snake_case, camelCase, or plain) into a readable label.
function formatPlanKey(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isEmptyPlanValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

// Renders a single plan value (string/number/bool/array/object) without assuming its shape.
function PlanValue({ value, depth = 0 }) {
  if (isEmptyPlanValue(value)) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span style={styles.planFieldValue}>{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    const allPrimitive = value.every(v => v == null || typeof v !== 'object');
    if (allPrimitive) {
      return <span style={styles.planFieldValue}>{value.filter(v => v != null).join(', ')}</span>;
    }
    return (
      <div style={styles.planNestedList}>
        {value.map((item, i) => (
          <div key={i} style={styles.planNestedItem}>
            {item != null && typeof item === 'object'
              ? <PlanFields data={item} depth={depth + 1} />
              : <span style={styles.planFieldValue}>{String(item)}</span>}
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === 'object') {
    return <PlanFields data={value} depth={depth + 1} />;
  }

  return null;
}

// Renders every key in a plan-shaped object as a labeled row, recursing into nested
// objects/arrays so the UI never has to know the plan's schema ahead of time.
function PlanFields({ data, depth = 0, excludeKeys = [] }) {
  if (!data || typeof data !== 'object') return null;
  const entries = Object.entries(data).filter(
    ([key, value]) => !excludeKeys.includes(key) && !isEmptyPlanValue(value)
  );
  if (entries.length === 0) return null;

  return (
    <div style={depth === 0 ? styles.planFieldsRoot : styles.planFieldsNested}>
      {entries.map(([key, value]) => (
        <div key={key} style={styles.planFieldRow}>
          <span style={styles.planFieldLabel}>{formatPlanKey(key)}:</span>
          <PlanValue value={value} depth={depth} />
        </div>
      ))}
    </div>
  );
}

function formatDuration(ms) {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function normalizeExperimentName(experimentName) {
  return (experimentName || '').replace(/_[a-f0-9]{8,}$/i, '');
}

// ── Results Tab ───────────────────────────────────────────────────────────────
// Two sub-tabs: API (manually generated) | Agent (prompt_experiments/ runs)
// Within each: experiment → model → chapters → figure cards
function ResultsTab({ onOpen, evaluatorModel, onEvaluatorModelChange, availableModels, currentCriticVersion }) {
  const [activeTab, setActiveTab] = React.useState('api');
  const [apiRecords, setApiRecords] = React.useState([]);
  const [expTree, setExpTree] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  // selected = { experiment: string, model: string }
  const [selected, setSelected] = React.useState(null);
  const [evaluatingKey, setEvaluatingKey] = React.useState(null);
  const [evaluatingAll, setEvaluatingAll] = React.useState(null); // chapter being batch-evaluated
  const [evaluatingExperiment, setEvaluatingExperiment] = React.useState(null); // experiment being batch-evaluated
  const [baseScaffold, setBaseScaffold] = React.useState(null);
  const [openChapters, setOpenChapters] = React.useState(new Set());
  const [filterChapter, setFilterChapter] = React.useState('');
  const [filterFigure, setFilterFigure] = React.useState('');
  const [collapsedGroups, setCollapsedGroups] = React.useState(new Set());
  const [hoveredGroup, setHoveredGroup] = React.useState(null);
  const hoverTimerRef = React.useRef(null);
  const [sidebarGroupBy, setSidebarGroupBy] = React.useState('experiment'); // 'experiment' | 'chapter'
  const [serverPrompt, setServerPrompt] = React.useState('');
  const [loadingApi, setLoadingApi] = React.useState(true);
  const [loadingAgent, setLoadingAgent] = React.useState(false);
  const [loadedApi, setLoadedApi] = React.useState(false);
  const [loadedAgent, setLoadedAgent] = React.useState(false);
  const loadApiRecords = React.useCallback(async ({ force = false } = {}) => {
    if (loadedApi && !force) return;
    setLoadingApi(true);
    try {
      const endpoint = force ? '/api/history-index?refresh=1' : '/api/history-index';
      const api = await apiFetch(endpoint).then(r => r.json());
      setApiRecords(api);
      setLoadedApi(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingApi(false);
    }
  }, [loadedApi]);

  const loadAgentTree = React.useCallback(async ({ force = false } = {}) => {
    if (loadedAgent && !force) return;
    setLoadingAgent(true);
    try {
      const exp = await apiFetch('/api/experiments').then(r => r.json());
      const merged = new Map();
      for (const entry of exp) {
        const experimentName = normalizeExperimentName(entry.experiment);
        if (!merged.has(experimentName)) {
          merged.set(experimentName, {
            experiment: experimentName,
            prompt: entry.prompt,
            models: [],
          });
        }
        const target = merged.get(experimentName);
        if (!target.prompt && entry.prompt) target.prompt = entry.prompt;
        for (const modelEntry of entry.models || []) {
          let targetModel = target.models.find(model => model.model === modelEntry.model);
          if (!targetModel) {
            targetModel = { model: modelEntry.model, figures: [] };
            target.models.push(targetModel);
          }
          for (const figure of modelEntry.figures || []) {
            if (!targetModel.figures.some(existing => existing.name === figure.name && existing.htmlPath === figure.htmlPath)) {
              targetModel.figures.push(figure);
            }
          }
        }
      }
      setExpTree(Array.from(merged.values()));
      setLoadedAgent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingAgent(false);
    }
  }, [loadedAgent]);

  const handleRefreshResults = React.useCallback(async () => {
    setError('');
    await Promise.all([
      loadApiRecords({ force: true }),
      loadAgentTree({ force: true }),
    ]);
  }, [loadApiRecords, loadAgentTree]);

  // Fetch the real system prompt for the API tab display
  React.useEffect(() => {
    apiFetch('/api/prompt').then(r => r.json()).then(d => { if (d.prompt) setServerPrompt(d.prompt); }).catch(() => { });
  }, []);

  // Reset chapter/figure filters when selection or active tab changes
  React.useEffect(() => {
    setFilterChapter('');
    setFilterFigure('');
  }, [selected, activeTab]);

  React.useEffect(() => {
    apiFetch('/api/base-scaffold').then(r => r.json()).then(d => setBaseScaffold(d.content)).catch(() => { });
  }, []);

  React.useEffect(() => {
    loadApiRecords();
  }, [loadApiRecords]);

  React.useEffect(() => {
    if (activeTab === 'agent' && !loadedAgent) {
      loadAgentTree();
    }
  }, [activeTab, loadedAgent, loadAgentTree]);

  React.useEffect(() => {
    if (loadedApi && !loadedAgent) {
      loadAgentTree();
    }
  }, [loadedApi, loadedAgent, loadAgentTree]);

  React.useEffect(() => {
    setLoading(activeTab === 'api' ? loadingApi : loadingAgent);
  }, [activeTab, loadingApi, loadingAgent]);

  const evaluationCriticVersion = React.useMemo(() => {
    return (currentCriticVersion || '').trim();
  }, [currentCriticVersion]);

  const selectedRecordView = React.useCallback(
    (record) => getVersionedEvaluationState(record, ''),
    []
  );

  const hasSelectedEvaluation = React.useCallback(
    (record) => Object.keys(selectedRecordView(record)?.evaluationResults || {}).length > 0,
    [selectedRecordView]
  );

  // Build API tree: { experiment → { model → records[] } }
  const apiTree = React.useMemo(() => {
    const tree = {};
    for (const r of apiRecords) {
      const exp = normalizeExperimentName(r.experiment || 'base_scene_robust');
      const model = r.model || DEFAULT_GENERATION_MODEL;
      if (!tree[exp]) tree[exp] = {};
      if (!tree[exp][model]) tree[exp][model] = [];
      tree[exp][model].push(r);
    }
    return tree;
  }, [apiRecords]);

  // Items for current selection
  const selectedItems = React.useMemo(() => {
    if (!selected?.experiment) {
      // In chapter-sidebar mode with no experiment selected, return ALL items flat
      if (sidebarGroupBy !== 'chapter') return [];
      const all = [];
      if (activeTab === 'api') {
        for (const [expName, expModels] of Object.entries(apiTree)) {
          for (const [modelName, recs] of Object.entries(expModels)) {
            for (const r of recs) {
              const view = selectedRecordView(r);
              all.push({
                key: `api/${r.id}`, type: 'api', id: r.id,
                figure: r.filename ? r.filename.replace(/\.[^.]+$/, '') : r.id,
                chapter: r.chapter || 'other',
                base64thumb: r.base64thumb, mediaType: r.mediaType || 'image/png',
                timestamp: r.timestamp,
                evaluationResults: view.evaluationResults || {}, evaluationMeta: view.evaluationMeta || {},
                evaluationVersions: r.evaluationVersions || {},
                experiment: expName, model: modelName,
                imagePath: null, htmlPath: null,
                iterations: r.iterations || 0,
              });
            }
          }
        }
      } else {
        for (const exp of expTree) {
          for (const m of exp.models) {
            for (const fig of m.figures) {
              const view = selectedRecordView(fig);
              all.push({
                key: `${exp.experiment}/${m.model}/${fig.name}`, type: 'experiment',
                figure: fig.name, chapter: fig.chapter || 'other',
                experiment: exp.experiment, model: m.model,
                imagePath: fig.imagePath, htmlPath: fig.htmlPath,
                timestamp: null,
                evaluationResults: view.evaluationResults || {}, evaluationMeta: view.evaluationMeta || {},
                evaluationVersions: fig.evaluationVersions || {},
              });
            }
          }
        }
      }
      return all;
    }
    let items;
    if (activeTab === 'api') {
      const expModels = apiTree[selected.experiment] || {};
      const modelKeys = selected.model ? [selected.model] : Object.keys(expModels);
      items = modelKeys.flatMap(modelName =>
        (expModels[modelName] || []).map(r => {
          const view = selectedRecordView(r);
          return {
            key: `api/${r.id}`, type: 'api', id: r.id,
            figure: r.filename ? r.filename.replace(/\.[^.]+$/, '') : r.id,
            chapter: r.chapter || 'other',
            base64thumb: r.base64thumb, mediaType: r.mediaType || 'image/png',
            timestamp: r.timestamp,
            evaluationResults: view.evaluationResults || {}, evaluationMeta: view.evaluationMeta || {},
            evaluationVersions: r.evaluationVersions || {},
            experiment: selected.experiment, model: modelName,
            imagePath: null, htmlPath: null,
            iterations: r.iterations || 0,
          };
        })
      );
    } else {
      const exp = expTree.find(e => e.experiment === selected.experiment);
      if (!exp) return [];
      const models = selected.model ? exp.models.filter(m => m.model === selected.model) : exp.models;
      items = [];
      for (const m of models) {
        for (const fig of m.figures) {
          const view = selectedRecordView(fig);
          items.push({
            key: `${exp.experiment}/${m.model}/${fig.name}`, type: 'experiment',
            figure: fig.name, chapter: fig.chapter || 'other',
            experiment: exp.experiment, model: m.model,
            imagePath: fig.imagePath, htmlPath: fig.htmlPath,
            timestamp: null,
            evaluationResults: view.evaluationResults || {}, evaluationMeta: view.evaluationMeta || {},
            evaluationVersions: fig.evaluationVersions || {},
            iterations: fig.iterations || 0,
          });
        }
      }
    }
    // Assign per-figure generation index (g1, g2, …) when same figure name appears multiple times
    const figMap = {};
    for (const it of items) {
      if (!figMap[it.figure]) figMap[it.figure] = [];
      figMap[it.figure].push(it);
    }
    for (const group of Object.values(figMap)) {
      if (group.length > 1) {
        group.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        group.forEach((it, i) => { it.genIndex = i + 1; it.genTotal = group.length; });
      }
    }
    return items;
  }, [selected, sidebarGroupBy, activeTab, apiTree, expTree, selectedRecordView]);

  // Group selected items by chapter
  const byChapter = React.useMemo(() => {
    const groups = {};
    for (const item of selectedItems) {
      const ch = item.chapter || 'other';
      if (!groups[ch]) groups[ch] = [];
      groups[ch].push(item);
    }
    return Object.fromEntries(
      Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
        .map(([ch, its]) => [ch, its.sort((a, b) => a.figure.localeCompare(b.figure) || (a.genIndex || 0) - (b.genIndex || 0))])
    );
  }, [selectedItems]);

  // Reset open chapters whenever selection changes
  React.useEffect(() => {
    const keys = Object.keys(byChapter);
    setOpenChapters(new Set(keys));
  }, [selected, byChapter]);

  const handleDeleteCard = async (e, item) => {
    e.stopPropagation();
    if (!window.confirm('Delete this figure?')) return;
    try {
      if (item.type === 'api') {
        await apiFetch(`/api/result/${item.id}`, { method: 'DELETE' });
        setApiRecords(prev => prev.filter(r => r.id !== item.id));
      }
    } catch (err) { console.error('Delete failed:', err); }
  };

  const handleEvalCard = async (e, item) => {
    e.stopPropagation();
    setEvaluatingKey(item.key);
    try {
      let data;
      const evalModelId = evaluatorModel || DEFAULT_EVALUATION_MODEL;
      const versionId = evaluationCriticVersion || currentCriticVersion || 'legacy_unknown';
      if (item.type === 'api') {
        const res = await apiFetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, evalModel: evalModelId, criticVersion: evaluationCriticVersion || undefined }) });
        data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setApiRecords(prev => prev.map(r => r.id === item.id ? {
          ...upsertVersionedEvaluation(r, evalModelId, data, {
            criticVersion: versionId,
          }),
        } : r));
      } else {
        const res = await apiFetch('/api/experiments/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ htmlPath: item.htmlPath, imagePath: item.imagePath, evalModel: evalModelId, criticVersion: evaluationCriticVersion || undefined }) });
        data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const [expName, modelName, figName] = item.key.split('/');
        setExpTree(prev => prev.map(exp => exp.experiment !== expName ? exp : {
          ...exp,
          models: exp.models.map(m => m.model !== modelName ? m : {
            ...m,
            figures: m.figures.map(f => f.name !== figName ? f : {
              ...upsertVersionedEvaluation(f, evalModelId, data, {
                criticVersion: versionId,
              }),
            })
          })
        }));
      }
    } catch (err) { alert('Evaluation failed: ' + err.message); }
    finally { setEvaluatingKey(null); }
  };

  const handleEvalAll = async (e, chapter, items) => {
    e.stopPropagation();
    const evalModelId = evaluatorModel || DEFAULT_EVALUATION_MODEL;
    const pending = items.filter(item => !filterExternalEvals(item.evaluationResults || {}, item.evaluationMeta || {}).results[evalModelId]);
    if (!pending.length) return;
    setEvaluatingAll(chapter);
    const versionId = evaluationCriticVersion || currentCriticVersion || 'legacy_unknown';
    for (const item of pending) {
      setEvaluatingKey(item.key);
      try {
        let data;
        if (item.type === 'api') {
          const res = await apiFetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, evalModel: evalModelId, criticVersion: evaluationCriticVersion || undefined }) });
          data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setApiRecords(prev => prev.map(r => r.id === item.id ? {
            ...upsertVersionedEvaluation(r, evalModelId, data, {
              criticVersion: versionId,
            }),
          } : r));
        } else {
          const res = await apiFetch('/api/experiments/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ htmlPath: item.htmlPath, imagePath: item.imagePath, evalModel: evalModelId, criticVersion: evaluationCriticVersion || undefined }) });
          data = await res.json();
          if (!res.ok) throw new Error(data.error);
          const [expName, modelName, figName] = item.key.split('/');
          setExpTree(prev => prev.map(exp => exp.experiment !== expName ? exp : {
            ...exp,
            models: exp.models.map(m => m.model !== modelName ? m : {
              ...m,
              figures: m.figures.map(f => f.name !== figName ? f : {
                ...upsertVersionedEvaluation(f, evalModelId, data, {
                  criticVersion: versionId,
                }),
              })
            })
          }));
        }
      } catch { }
    }
    setEvaluatingAll(null);
    setEvaluatingKey(null);
  };

  const handleEvalExperiment = async (expName) => {
    const evalModelId = evaluatorModel || DEFAULT_EVALUATION_MODEL;
    const versionId = evaluationCriticVersion || currentCriticVersion || 'legacy_unknown';
    const allItems = activeTab === 'api'
      ? Object.entries(apiTree[expName] || {}).flatMap(([modelName, recs]) =>
          recs.map(r => {
            const view = selectedRecordView(r);
            return { key: `api/${r.id}`, type: 'api', id: r.id, evaluationResults: view.evaluationResults || {}, evaluationMeta: view.evaluationMeta || {} };
          })
        )
      : expTree.flatMap(e => e.experiment !== expName ? [] : e.models.flatMap(m => m.figures.map(f => ({ ...f, type: 'experiment', key: `${e.experiment}/${m.model}/${f.name}`, model: m.model }))));
    const pending = allItems.filter(item => !filterExternalEvals(item.evaluationResults || {}, item.evaluationMeta || {}).results[evalModelId]);
    if (!pending.length) return;
    setEvaluatingExperiment(expName);
    for (const item of pending) {
      setEvaluatingKey(item.key);
      try {
        if (item.type === 'api') {
          const res = await apiFetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, evalModel: evalModelId, criticVersion: evaluationCriticVersion || undefined }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setApiRecords(prev => prev.map(r => r.id === item.id ? { ...upsertVersionedEvaluation(r, evalModelId, data, { criticVersion: versionId }) } : r));
        } else {
          const res = await apiFetch('/api/experiments/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ htmlPath: item.htmlPath, imagePath: item.imagePath, evalModel: evalModelId, criticVersion: evaluationCriticVersion || undefined }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          const [eN, mN, fN] = item.key.split('/');
          setExpTree(prev => prev.map(exp => exp.experiment !== eN ? exp : {
            ...exp,
            models: exp.models.map(m => m.model !== mN ? m : {
              ...m,
              figures: m.figures.map(f => f.name !== fN ? f : { ...upsertVersionedEvaluation(f, evalModelId, data, { criticVersion: versionId }) })
            })
          }));
        }
      } catch { }
    }
    setEvaluatingExperiment(null);
    setEvaluatingKey(null);
  };

  const handleClearFigureEval = async (e, item) => {
    e.stopPropagation();
    if (!window.confirm(`Clear evaluation for '${item.figure}'?`)) return;
    try {
      if (item.type === 'api') {
        await apiFetch(`/api/result/${item.id}/evaluation`, { method: 'DELETE' });
        setApiRecords(prev => prev.map(r => r.id === item.id ? { ...r, evaluationResults: {}, evaluationMeta: {}, evaluationVersions: {} } : r));
      } else {
        await apiFetch('/api/experiment-figure/evaluation', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ htmlPath: item.htmlPath }) });
        const [eN, mN, fN] = item.key.split('/');
        setExpTree(prev => prev.map(exp => exp.experiment !== eN ? exp : {
          ...exp,
          models: exp.models.map(m => m.model !== mN ? m : {
            ...m,
            figures: m.figures.map(f => f.name !== fN ? f : { ...f, evaluationResults: {}, evaluationMeta: {}, evaluationVersions: {} })
          })
        }));
      }
    } catch (err) { console.error('Clear eval failed:', err); }
  };

  const handleClearChapterEvals = async (e, groupKey, items) => {
    e.stopPropagation();
    if (!window.confirm(`Clear all evaluations in '${groupKey}'?`)) return;
    const evalModelId = evaluatorModel || DEFAULT_EVALUATION_MODEL;
    const withEvals = items.filter(i => filterExternalEvals(i.evaluationResults || {}, i.evaluationMeta || {}).results[evalModelId]);
    if (!withEvals.length) return;
    try {
      if (activeTab === 'api') {
        for (const item of withEvals) {
          await apiFetch(`/api/result/${item.id}/evaluation`, { method: 'DELETE' });
        }
        const itemIds = new Set(withEvals.map(i => i.id));
        setApiRecords(prev => prev.map(r => itemIds.has(r.id) ? { ...r, evaluationResults: {}, evaluationMeta: {}, evaluationVersions: {} } : r));
      } else {
        const combos = [...new Map(withEvals.map(i => {
          const [eN, mN] = i.key.split('/');
          return [`${eN}/${mN}/${i.chapter || ''}`, { experiment: eN, model: mN, chapter: i.chapter || null }];
        })).values()];
        for (const combo of combos) {
          await apiFetch('/api/experiment-chapter/evaluations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(combo) });
        }
        const figKeys = new Set(withEvals.map(i => i.key));
        setExpTree(prev => prev.map(exp => ({
          ...exp,
          models: exp.models.map(m => ({
            ...m,
            figures: m.figures.map(f => figKeys.has(`${exp.experiment}/${m.model}/${f.name}`) ? { ...f, evaluationResults: {}, evaluationMeta: {}, evaluationVersions: {} } : f)
          }))
        })));
      }
    } catch (err) { console.error('Clear chapter evals failed:', err); }
  };

  const handleClearExperimentEvals = async (expName) => {
    if (!window.confirm(`Clear all evaluations in experiment '${expName}'?`)) return;
    try {
      if (activeTab === 'api') {
        await apiFetch(`/api/results/evaluations?experiment=${encodeURIComponent(expName)}`, { method: 'DELETE' });
        setApiRecords(prev => prev.map(r => r.experiment === expName ? { ...r, evaluationResults: {}, evaluationMeta: {}, evaluationVersions: {} } : r));
      } else {
        await apiFetch('/api/experiment-entry/evaluations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experiment: expName }) });
        setExpTree(prev => prev.map(exp => exp.experiment !== expName ? exp : {
          ...exp,
          models: exp.models.map(m => ({
            ...m,
            figures: m.figures.map(f => ({ ...f, evaluationResults: {}, evaluationMeta: {}, evaluationVersions: {} }))
          }))
        }));
      }
    } catch (err) { console.error('Clear experiment evals failed:', err); }
  };

  const sc = s => s >= 4 ? '#2e7d32' : s >= 3 ? '#e65100' : '#c00';

  // Prompt to show when a model row is selected
  const selectedPrompt = React.useMemo(() => {
    if (!selected) return null;
    if (activeTab === 'api') return serverPrompt;
    const exp = expTree.find(e => e.experiment === selected.experiment);
    return exp?.prompt || null;
  }, [selected, activeTab, expTree, serverPrompt]);

  // Experiment / model lists for filter dropdowns
  const allExperiments = React.useMemo(() => {
    if (activeTab === 'api') return Object.keys(apiTree).sort();
    return expTree.map(e => e.experiment).sort();
  }, [activeTab, apiTree, expTree]);

  const allModels = React.useMemo(() => {
    if (activeTab === 'api') {
      return selected?.experiment
        ? Object.keys(apiTree[selected.experiment] || {}).sort()
        : [...new Set(Object.values(apiTree).flatMap(m => Object.keys(m)))].sort();
    }
    const exp = selected?.experiment ? expTree.find(e => e.experiment === selected.experiment) : null;
    return exp
      ? exp.models.map(m => m.model).sort()
      : [...new Set(expTree.flatMap(e => e.models.map(m => m.model)))].sort();
  }, [activeTab, apiTree, expTree, selected]);

  // All figure names in current selection for dropdown / autocomplete
  const allFigures = React.useMemo(() => {
    // scope to selected chapter when one is active
    const source = filterChapter
      ? (byChapter[filterChapter] || [])
      : selectedItems;
    return [...new Set(source.map(i => i.figure))].sort((a, b) => a.localeCompare(b));
  }, [selectedItems, byChapter, filterChapter]);

  // Apply chapter + figure-name filters on top of the current selection
  const filteredByChapter = React.useMemo(() => {
    const q = filterFigure.trim().toLowerCase();
    const result = {};
    for (const [ch, items] of Object.entries(byChapter)) {
      if (filterChapter && ch !== filterChapter) continue;
      const filtered = q ? items.filter(i => i.figure.toLowerCase().includes(q)) : items;
      if (filtered.length) result[ch] = filtered;
    }
    return result;
  }, [byChapter, filterChapter, filterFigure]);

  // Group items by model (used in chapter-sidebar mode)
  const filteredByModel = React.useMemo(() => {
    if (sidebarGroupBy !== 'chapter' || !filterChapter) return {};
    const allItems = Object.values(filteredByChapter).flat();
    const groups = {};
    for (const item of allItems) {
      const m = item.model || 'unknown';
      if (!groups[m]) groups[m] = [];
      groups[m].push(item);
    }
    return Object.fromEntries(
      Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
        .map(([m, its]) => [m, its.sort((a, b) => a.figure.localeCompare(b.figure))])
    );
  }, [sidebarGroupBy, filterChapter, filteredByChapter]);

  const handleFilterExp = React.useCallback((expName) => {
    if (!expName) { setSelected(null); return; }
    setSelected({ experiment: expName, model: null });
  }, []);

  const handleFilterModel = React.useCallback((modelName) => {
    if (!modelName) {
      // 'All' selected — keep experiment but clear model
      if (selected?.experiment) { setSelected({ experiment: selected.experiment, model: null }); }
      return;
    }
    if (selected?.experiment) {
      setSelected({ experiment: selected.experiment, model: modelName });
    } else if (activeTab === 'api') {
      for (const [exp, models] of Object.entries(apiTree)) {
        if (models[modelName]) { setSelected({ experiment: exp, model: modelName }); return; }
      }
    } else {
      for (const exp of expTree) {
        if (exp.models.find(m => m.model === modelName)) {
          setSelected({ experiment: exp.experiment, model: modelName }); return;
        }
      }
    }
  }, [activeTab, apiTree, expTree, selected]);

  if (loading) return <div style={styles.empty}>Loading results…</div>;
  if (error) return <div style={styles.empty}>{error}</div>;

  const selKey = selected ? `${selected.experiment}::${selected.model ?? ''}` : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* Evaluator model selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: '1px solid #e8e8e8', background: '#fafafa' }}>
        <span style={{ fontSize: 10, color: '#888', whiteSpace: 'nowrap', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Eval model</span>
        <select
          value={evaluatorModel || ''}
          onChange={e => onEvaluatorModelChange?.(e.target.value)}
          style={{ ...styles.resultFilterSelect, minWidth: 160 }}
        >
          {(availableModels || []).map(m => (
            <option key={m.id} value={m.id}>{m.label || m.id}</option>
          ))}
        </select>
      </div>

      {/* API / Agent sub-tabs */}
      <div style={styles.subTabBar}>
        {[['api', 'Agent'], ['agent', 'Copilot']].map(([key, label]) => (
          <button key={key}
            style={{ ...styles.subTabBtn, ...(activeTab === key ? styles.subTabBtnActive : {}) }}
            onClick={() => { setActiveTab(key); setSelected(null); }}
          >
            {label}
            {key === 'api' && apiRecords.length > 0 &&
              <span style={styles.subTabCount}>{apiRecords.filter(r => hasSelectedEvaluation(r)).length}/{apiRecords.length}</span>}
            {key === 'agent' && expTree.length > 0 && (() => {
              const total = expTree.reduce((s, e) => s + e.models.reduce((ms, m) => ms + m.figures.length, 0), 0);
              const evaled = expTree.reduce((s, e) => s + e.models.reduce((ms, m) => ms + m.figures.filter(f => hasSelectedEvaluation(f)).length, 0), 0);
              return <span style={styles.subTabCount}>{evaled}/{total}</span>;
            })()}
          </button>
        ))}
      </div>

      {/* Filter nav bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#f4f5f9', borderBottom: '1px solid #e0e2eb', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.07em', marginRight: 4 }}>Filter</span>
        <button
          style={{ fontSize: 11, color: '#5878a0', background: '#fff', border: '1px solid #d6dce9', borderRadius: 4, cursor: 'pointer', padding: '2px 8px' }}
          onClick={handleRefreshResults}
          disabled={loadingApi || loadingAgent}
          title="Refresh results"
        >
          {loadingApi || loadingAgent ? 'Refreshing…' : '↻ refresh'}
        </button>
        <span style={{ fontSize: 11, color: '#aaa' }}>Experiment</span>
        <select style={styles.resultFilterSelect} value={selected?.experiment || ''} onChange={e => handleFilterExp(e.target.value)}>
          <option value=''>All</option>
          {allExperiments.map(exp => <option key={exp} value={exp}>{exp}</option>)}
        </select>
        <span style={{ color: '#ddd', margin: '0 2px' }}>·</span>
        <span style={{ fontSize: 11, color: '#aaa' }}>Model</span>
        <select style={styles.resultFilterSelect} value={selected?.model || ''} onChange={e => handleFilterModel(e.target.value)}>
          <option value=''>All</option>
          {allModels.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <span style={{ color: '#ddd', margin: '0 2px' }}>·</span>
        <span style={{ fontSize: 11, color: '#aaa' }}>Chapter</span>
        <select style={styles.resultFilterSelect} value={filterChapter} onChange={e => { setFilterChapter(e.target.value); setFilterFigure(''); }}>
          <option value=''>All</option>
          {Object.keys(byChapter).sort().map(ch => <option key={ch} value={ch}>{ch}</option>)}
        </select>
        <span style={{ color: '#ddd', margin: '0 2px' }}>·</span>
        <span style={{ fontSize: 11, color: '#aaa' }}>Figure</span>
        <select
          style={{ ...styles.resultFilterSelect, maxWidth: 180 }}
          value={allFigures.includes(filterFigure) ? filterFigure : ''}
          onChange={e => setFilterFigure(e.target.value)}
        >
          <option value=''>All</option>
          {allFigures.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <input
          list='fig-names-list'
          style={{ ...styles.resultFilterSelect, width: 128, padding: '3px 8px', outline: 'none', fontFamily: 'inherit' }}
          placeholder='🔍 search…'
          value={filterFigure}
          onChange={e => setFilterFigure(e.target.value)}
        />
        <datalist id='fig-names-list'>
          {allFigures.map(f => <option key={f} value={f} />)}
        </datalist>
        {(selected || filterChapter || filterFigure) && (
          <button
            style={{ fontSize: 11, color: '#aaa', background: 'none', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer', padding: '2px 8px', marginLeft: 4 }}
            onClick={() => { setSelected(null); setFilterChapter(''); setFilterFigure(''); }}
          >✕ clear</button>
        )}
        {(selected || (sidebarGroupBy === 'chapter' && filterChapter)) && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#aaa' }}>
            {Object.values(filteredByChapter).reduce((s, a) => s + a.length, 0)} figure{Object.values(filteredByChapter).reduce((s, a) => s + a.length, 0) !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Tree + figures panel */}
      <div style={{ ...styles.expWrap, flex: 1, borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
        {/* Left tree */}
        <div style={styles.expTree}>
          {/* Group-by toggle */}
          <div style={{ display: 'flex', borderBottom: '1px solid #e8e8e8', flexShrink: 0 }}>
            {[['experiment', 'Experiments'], ['chapter', 'Chapters']].map(([val, label]) => (
              <button key={val}
                style={{
                  flex: 1, fontSize: 11, padding: '8px 4px', border: 'none', borderBottom: sidebarGroupBy === val ? '2px solid #5878a0' : '2px solid transparent',
                  cursor: 'pointer', fontWeight: sidebarGroupBy === val ? 600 : 400,
                  background: 'transparent',
                  color: sidebarGroupBy === val ? '#5878a0' : '#999',
                  marginBottom: -1
                }}
                onClick={() => { setSidebarGroupBy(val); setSelected(null); setFilterChapter(''); }}
              >{label}</button>
            ))}
          </div>
          {sidebarGroupBy === 'chapter' ? (
            /* Chapter list */
            (() => {
              const chapterCounts = {};
              const evalCounts = {};
              for (const item of selectedItems) {
                const ch = item.chapter || 'other';
                chapterCounts[ch] = (chapterCounts[ch] || 0) + 1;
                if (hasSelectedEvaluation(item)) evalCounts[ch] = (evalCounts[ch] || 0) + 1;
              }
              return Object.entries(chapterCounts).sort(([a], [b]) => a.localeCompare(b)).map(([ch, count]) => {
                const isActive = filterChapter === ch;
                return (
                  <div key={ch}
                    style={{
                      ...styles.expTreeItem, paddingLeft: 12,
                      background: isActive ? '#f0f0f0' : 'transparent',
                      borderLeftColor: isActive ? '#111' : 'transparent',
                      color: isActive ? '#111' : '#444',
                      fontWeight: isActive ? 600 : 400
                    }}
                    onClick={() => { setFilterChapter(ch); setSelected(null); }}
                  >
                    <span style={{ flex: 1, fontSize: 11 }}>{ch}</span>
                    <span style={{ fontSize: 10, color: '#aaa' }}>{evalCounts[ch] || 0}/{count}</span>
                  </div>
                );
              });
            })()
          ) : (
            /* Experiment → model tree */
            (() => {
              const entries = activeTab === 'api'
                ? Object.entries(apiTree).map(([expName, models]) => ({
                  group: expName,
                  items: Object.entries(models).map(([modelName, recs]) => ({
                    modelName, evalCount: recs.filter(r => hasSelectedEvaluation(r)).length, total: recs.length,
                    nodeKey: `${expName}::${modelName}`,
                    onSelect: () => setSelected({ experiment: expName, model: modelName }),
                  })),
                }))
                : [...expTree].reverse().map(exp => ({
                  group: exp.experiment,
                  items: exp.models.map(m => ({
                    modelName: m.model, evalCount: m.figures.filter(f => hasSelectedEvaluation(f)).length, total: m.figures.length,
                    nodeKey: `${exp.experiment}::${m.model}`,
                    onSelect: () => setSelected({ experiment: exp.experiment, model: m.model }),
                  })),
                }));
              return entries.map(({ group, items }) => {
                const isCollapsed = collapsedGroups.has(group);
                const isOpen = !isCollapsed || hoveredGroup === group;
                return (
                  <div key={group}
                    onMouseEnter={() => {
                      if (isCollapsed) hoverTimerRef.current = setTimeout(() => setHoveredGroup(group), 250);
                    }}
                    onMouseLeave={() => {
                      clearTimeout(hoverTimerRef.current);
                      setHoveredGroup(null);
                    }}
                  >
                    <div
                      style={{ ...styles.expTreeGroup, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' }}
                      onClick={() => setCollapsedGroups(prev => {
                        const next = new Set(prev);
                        next.has(group) ? next.delete(group) : next.add(group);
                        return next;
                      })}
                    >
                      <span style={{ fontSize: 8, color: '#888' }}>{isOpen ? '▾' : '▸'}</span>
                      {group}
                      <span style={{ fontSize: 9, color: '#aaa', fontWeight: 400, marginLeft: 'auto' }}>
                        {items.reduce((sum, item) => sum + (item.evalCount || 0), 0)}/{items.reduce((sum, item) => sum + (item.total || 0), 0)}
                      </span>
                    </div>
                    {isOpen && items.map(({ modelName, evalCount, total, nodeKey, onSelect }) => {
                      const isActive = selKey === nodeKey;
                      return (
                        <div key={modelName}
                          style={isActive
                            ? { ...styles.expTreeItem, background: '#f0f0f0', borderLeftColor: '#111', color: '#111', fontWeight: 600 }
                            : { ...styles.expTreeItem, background: 'transparent', borderLeftColor: 'transparent', color: '#444', fontWeight: 400 }
                          }
                          onClick={onSelect}
                        >
                          <span style={{ flex: 1, fontSize: 11 }}>{modelName}</span>
                          <span style={{ fontSize: 10, color: '#aaa' }}>{evalCount}/{total}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              });
            })()
          )}
        </div>

        {/* Right: prompt + chapter-grouped figure cards */}
        <div style={styles.expContent}>
          {(!selected && !(sidebarGroupBy === 'chapter' && filterChapter)) ? (
            <div style={styles.empty}>{sidebarGroupBy === 'chapter' ? 'Select a chapter from the sidebar' : 'Select a model or experiment using the filter bar above'}</div>
          ) : !Object.keys(filteredByChapter).length ? (
            <div style={styles.empty}>{filterFigure ? `No figures matching "${filterFigure}"` : 'No figures found'}</div>
          ) : (
            <>
              {/* Breadcrumb */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 12, fontSize: 12, color: '#888' }}>
                {sidebarGroupBy === 'chapter' && !selected ? (
                  <>
                    <span style={{ cursor: 'pointer', color: '#5878a0', fontWeight: 600 }}
                      onClick={() => setFilterChapter('')}>All experiments</span>
                    <span style={{ color: '#ccc' }}>›</span>
                    <span style={{ color: '#333', fontWeight: 600 }}>{filterChapter}</span>
                  </>
                ) : (
                  <>
                    <span
                      style={{ cursor: 'pointer', color: '#5878a0', fontWeight: 600 }}
                      onClick={() => setSelected(null)}
                    >{activeTab === 'api' ? 'Agent' : 'Copilot'}</span>
                    <span style={{ color: '#ccc' }}>›</span>
                    <span style={{ fontWeight: 600, color: '#5878a0', cursor: 'pointer' }}
                      onClick={() => setSelected(s => ({ ...s, _reset: true }))}>
                      {selected?.experiment}
                    </span>
                    <span style={{ color: '#ccc' }}>›</span>
                    <span style={{ color: '#333', fontWeight: 600 }}>{selected?.model || 'All models'}</span>
                  </>
                )}
              </div>
              {selected?.experiment && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <button
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid #d0d8e8', background: '#f2f6fb', color: '#5878a0', cursor: 'pointer', fontWeight: 600 }}
                    disabled={evaluatingExperiment === selected.experiment}
                    onClick={() => handleEvalExperiment(selected.experiment)}
                  >{evaluatingExperiment === selected.experiment ? `Evaluating…` : 'Evaluate all'}</button>
                  <button
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid #e8c8c8', background: '#fbedf0', color: '#a05878', cursor: 'pointer', fontWeight: 600 }}
                    onClick={() => handleClearExperimentEvals(selected.experiment)}
                  >Clear all evals</button>
                </div>
              )}
              {selectedPrompt && (
                <details style={{ marginBottom: 8 }}>
                  <summary style={{ fontSize: 11, color: '#888', cursor: 'pointer', fontWeight: 600 }}>Prompt</summary>
                  <pre style={styles.expPromptBox}>{selectedPrompt}</pre>
                </details>
              )}
              {baseScaffold && selected?.model?.includes('with-base-code') && (
                <details style={{ marginBottom: 14 }}>
                  <summary style={{ fontSize: 11, color: '#888', cursor: 'pointer', fontWeight: 600 }}>Base Code</summary>
                  <pre style={styles.expPromptBox}>{baseScaffold}</pre>
                </details>
              )}
              {(() => {
                const isModelView = sidebarGroupBy === 'chapter' && !selected;
                const displayGroups = isModelView ? filteredByModel : filteredByChapter;
                return Object.entries(displayGroups).map(([groupKey, items]) => {
                  const isOpen = isModelView
                    ? !collapsedGroups.has(groupKey)
                    : openChapters.has(groupKey);
                  return (
                    <details key={groupKey} style={{ marginBottom: 16 }} open={isOpen}
                      onToggle={e => {
                        const open = e.currentTarget.open;
                        if (isModelView) {
                          setCollapsedGroups(prev => { const n = new Set(prev); open ? n.delete(groupKey) : n.add(groupKey); return n; });
                        } else {
                          setOpenChapters(prev => { const s = new Set(prev); open ? s.add(groupKey) : s.delete(groupKey); return s; });
                        }
                      }}
                    >
                      <summary style={{ ...styles.resultChapterHeader, cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
                        <span style={{ fontSize: 9, color: '#bbb', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>{groupKey}
                        <span style={{ fontWeight: 400, color: '#bbb', textTransform: 'none', letterSpacing: 0 }}>({items.length})</span>
                        {items.some(i => !filterExternalEvals(i.evaluationResults || {}, i.evaluationMeta || {}).results[evaluatorModel || DEFAULT_EVALUATION_MODEL]) && (
                          <button
                            style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 8px', borderRadius: 4, border: '1px solid #d0d8e8', background: '#f2f6fb', color: '#5878a0', cursor: 'pointer', fontWeight: 600 }}
                            onClick={e => handleEvalAll(e, groupKey, items)}
                            disabled={evaluatingAll === groupKey}
                          >
                            {evaluatingAll === groupKey
                              ? `Evaluating… (${items.filter(i => filterExternalEvals(i.evaluationResults || {}, i.evaluationMeta || {}).results[evaluatorModel || DEFAULT_EVALUATION_MODEL]).length}/${items.length})`
                              : `Evaluate all (${items.filter(i => !filterExternalEvals(i.evaluationResults || {}, i.evaluationMeta || {}).results[evaluatorModel || DEFAULT_EVALUATION_MODEL]).length} pending)`}
                          </button>
                        )}
                        {items.some(i => Object.keys(i.evaluationResults || {}).length > 0) && (
                          <button
                            style={{ marginLeft: items.some(i => !filterExternalEvals(i.evaluationResults || {}, i.evaluationMeta || {}).results[evaluatorModel || DEFAULT_EVALUATION_MODEL]) ? 0 : 'auto', fontSize: 10, padding: '1px 8px', borderRadius: 4, border: '1px solid #e8c8c8', background: '#fbedf0', color: '#a05878', cursor: 'pointer', fontWeight: 600 }}
                            onClick={e => handleClearChapterEvals(e, groupKey, items)}
                            title="Clear all evaluations in this chapter"
                          >✕ evals</button>
                        )}
                      </summary>
                      <div style={{ ...styles.historyGrid, marginTop: 10 }}>
                        {items.map(item => {
                          const evalEntries = Object.entries(item.evaluationResults || {})
                            .filter(([modelId]) => isExternalEval(item.evaluationMeta?.[modelId]))
                            .map(([modelId, result]) => ({
                              modelId,
                              result,
                              modelLabel: modelId,
                              evaluatedAt: item.evaluationMeta?.[modelId]?.evaluatedAt || null,
                            }))
                            .sort((a, b) => {
                              const aTime = a.evaluatedAt ? new Date(a.evaluatedAt).getTime() : 0;
                              const bTime = b.evaluatedAt ? new Date(b.evaluatedAt).getTime() : 0;
                              return bTime - aTime;
                            });
                          const ev = evalEntries.length ? evalEntries[0].result : null;
                          return (
                            <div key={item.key} style={styles.card} onClick={() => onOpen(item)}>
                              <div style={{ position: 'relative' }}>
                                {item.type === 'api'
                                  ? <LazyApiThumb id={item.id} base64thumb={item.base64thumb} mediaType={item.mediaType} style={styles.cardThumb} />
                                  : <LazyThumb htmlPath={item.htmlPath} style={styles.cardThumb} />
                                }
                                {item.type === 'api' && (
                                  <button
                                    style={styles.cardDeleteBtn}
                                    onClick={e => handleDeleteCard(e, item)}
                                    title="Delete"
                                  >✕</button>
                                )}
                              </div>
                              <div style={styles.cardInfo}>
                                <p style={styles.cardFilename}>{item.figure}{item.genTotal > 1 && <span style={{ marginLeft: 5, fontSize: 9, background: '#e3e8f0', color: '#556', borderRadius: 6, padding: '1px 5px', fontWeight: 500 }}>g{item.genIndex}</span>}</p>
                                <p style={styles.cardGenModel}>Gen model: {item.model || 'unknown'}</p>
                                {item.timestamp && <p style={{ ...styles.cardTs, marginBottom: 3 }}>{new Date(item.timestamp).toLocaleDateString()}</p>}
                                {item.iterations != null && <p style={{ ...styles.cardTs, marginBottom: 3 }}>Iterations: {item.iterations}</p>}
                                {item.generationDurationMs != null && <p style={{ ...styles.cardTs, marginBottom: 3 }}>Time: {formatDuration(item.generationDurationMs)}</p>}
                                {evalEntries.length ? (
                                  <>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <span style={{ ...styles.sourceBadge, background: ev.overall_average >= 4 ? '#e8f5e9' : ev.overall_average >= 3 ? '#fff3e0' : '#ffebee', color: sc(ev.overall_average) }}>{ev.overall_average}/5</span>
                                      <button
                                        style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, border: '1px solid #e8c8c8', background: '#fbedf0', color: '#a05878', cursor: 'pointer', lineHeight: 1.4 }}
                                        onClick={e => handleClearFigureEval(e, item)}
                                        title="Clear evaluation"
                                      >✕</button>
                                    </div>
                                    <p style={styles.cardEvalModel}>Latest eval: {evalEntries[0].modelLabel}</p>
                                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                      {evalEntries.map(({ modelId, modelLabel, result }) => (
                                        <div key={modelId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#666' }}>
                                          <span>{modelLabel}</span>
                                          <span style={{ fontWeight: 700, color: sc(result?.overall_average ?? 0) }}>
                                            {result?.overall_average != null ? `${result.overall_average.toFixed(1)}/5` : '—'}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                    {ev.failure_modes?.length > 0 && (
                                      <CardFailureModes modes={ev.failure_modes} />
                                    )}
                                  </>
                                ) : (
                                  <button
                                    style={{ ...styles.evalBtn, padding: '3px 0', fontSize: 10, marginTop: 4 }}
                                    onClick={e => handleEvalCard(e, item)}
                                    disabled={evaluatingKey === item.key}
                                  >
                                    {evaluatingKey === item.key ? '…' : 'Evaluate'}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  );
                });
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Failure mode color palette (stable per mode name) ───────────────────────
const FAILURE_MODE_PALETTE = [
  { bg: '#f2f6fb', fg: '#5878a0', border: '#ccd8ec' },  // sky blue
  { bg: '#f5f2fa', fg: '#7060a0', border: '#d0c4e8' },  // purple
  { bg: '#f0f8f9', fg: '#407888', border: '#b8d8e0' },  // teal
  { bg: '#f1f2fb', fg: '#5060a8', border: '#c4c8e8' },  // periwinkle
  { bg: '#fbf0f7', fg: '#906080', border: '#e0c4d8' },  // mauve
  { bg: '#f1f4f8', fg: '#506080', border: '#c0ccd8' },  // steel blue
  { bg: '#f4f0fa', fg: '#7058a0', border: '#ccc0e0' },  // violet
  { bg: '#f0f7fb', fg: '#307890', border: '#b0d0e0' },  // cyan
  { bg: '#f4f1f8', fg: '#806090', border: '#ccc0d8' },  // lavender
  { bg: '#f2f3f8', fg: '#586070', border: '#c4c8d4' },  // slate
];
function failureModeColor(name) {
  if (!name) return FAILURE_MODE_PALETTE[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return FAILURE_MODE_PALETTE[Math.abs(h) % FAILURE_MODE_PALETTE.length];
}

// ── Dashboard Tab ─────────────────────────────────────────────────────────────
const DASH_METRICS = [
  'geometry_accuracy', 'interactivity_usability', 'faithfulness',
  'label_quality', 'concept_accuracy', 'visual_aesthetics',
];
const DASH_METRIC_SHORT = {
  geometry_accuracy: 'Geom',
  interactivity_usability: 'Inter',
  faithfulness: 'Faith',
  label_quality: 'Labels',
  concept_accuracy: 'Concept',
  visual_aesthetics: 'Aesth',
};

// Continuous heatmap: dark red (0) → red (1) → orange (2) → yellow (3) → light green (4) → green (5)
const COLOR_STOPS = [
  [0, [150, 10, 10]],
  [1, [220, 50, 50]],
  [2, [240, 130, 40]],
  [3, [255, 235, 80]],
  [4, [180, 215, 130]],
  [5, [80, 170, 90]],
];
function lerpColor(s) {
  if (s === null) return null;
  const clamped = Math.max(0, Math.min(5, s));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [s0, c0] = COLOR_STOPS[i];
    const [s1, c1] = COLOR_STOPS[i + 1];
    if (clamped <= s1) {
      const t = (clamped - s0) / (s1 - s0);
      const r = Math.round(c0[0] + t * (c1[0] - c0[0]));
      const g = Math.round(c0[1] + t * (c1[1] - c0[1]));
      const b = Math.round(c0[2] + t * (c1[2] - c0[2]));
      return [r, g, b];
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1];
}
function scoreBg(s) {
  const rgb = lerpColor(s);
  if (!rgb) return 'transparent';
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`;
}
function scoreFg(s) {
  const rgb = lerpColor(s);
  if (!rgb) return '#bbb';
  // darken for text
  return `rgb(${Math.round(rgb[0] * 0.55)},${Math.round(rgb[1] * 0.55)},${Math.round(rgb[2] * 0.45)})`;
}

function modelFamily(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('claude')) return 'Claude';
  if (n.includes('gemini')) return 'Gemini';
  if (n.includes('gpt') || n.includes('codex')) return 'GPT';
  return 'Other';
}
const FAMILY_COLOR = { Claude: '#ede7f6', Gemini: '#e3f2fd', GPT: '#e8f5e9', Other: '#f0f0f0' };
const FAMILY_TEXT = { Claude: '#5e35b1', Gemini: '#1565c0', GPT: '#2e7d32', Other: '#555' };

function computeStats(records, groupKey, criticVersion) {
  const byGroup = {};
  for (const r of records) {
    const key = r[groupKey];
    if (!byGroup[key]) byGroup[key] = { evals: [], total: 0, key };
    byGroup[key].total++;
    const versionedRecord = getVersionedEvaluationState(r, criticVersion);
    const modelId = pickEvaluationModel(versionedRecord, null);
    const evaluation = getRecordEvaluation(versionedRecord, modelId);
    if (evaluation) byGroup[key].evals.push(evaluation);
  }
  return Object.values(byGroup).map(({ key, evals, total }) => {
    const avg = (field) => {
      const vals = evals.map(e => e[field]).filter(v => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const metricAvgs = Object.fromEntries(DASH_METRICS.map(k => [k, avg(k)]));
    const overall = avg('overall_average');
    const fmCounts = {};
    for (const e of evals) for (const fm of (e.failure_modes || [])) fmCounts[fm] = (fmCounts[fm] || 0) + 1;
    const failureModes = Object.entries(fmCounts).sort((a, b) => b[1] - a[1]);
    const family = groupKey === 'model' ? modelFamily(key) : null;
    return { key, family, total, evaluated: evals.length, metricAvgs, overall, failureModes };
  }).sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
}

function DashTable({ stats, groupKey }) {
  if (!stats.length) return <div style={{ color: '#bbb', fontSize: 12, padding: '10px 0' }}>No evaluated figures.</div>;

  const NUM = ({ val }) => (
    <td style={{
      textAlign: 'center', padding: '7px 6px', background: scoreBg(val),
      color: scoreFg(val), fontWeight: 600, fontSize: 12
    }}>
      {val !== null ? val.toFixed(1) : <span style={{ color: '#ddd' }}>—</span>}
    </td>
  );

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: '#f5f5f5' }}>
          <th style={{
            textAlign: 'left', padding: '7px 12px', fontSize: 11, fontWeight: 700, color: '#555',
            borderBottom: '1px solid #e0e0e0'
          }}>
            {groupKey === 'model' ? 'Model' : 'Experiment'}
          </th>
          <th style={{
            textAlign: 'center', padding: '7px 6px', fontSize: 11, fontWeight: 700,
            color: '#555', borderBottom: '1px solid #e0e0e0', width: 28
          }}>N</th>
          <th style={{
            textAlign: 'center', padding: '7px 8px', fontSize: 11, fontWeight: 700,
            color: '#333', borderBottom: '1px solid #e0e0e0', background: '#ececec', width: 60,
            borderLeft: '2px solid #999', borderRight: '2px solid #999'
          }}>Overall</th>
          {DASH_METRICS.map(k => (
            <th key={k} style={{
              textAlign: 'center', padding: '7px 6px', fontSize: 10, fontWeight: 700,
              color: '#777', borderBottom: '1px solid #e0e0e0', width: 48
            }}>
              {DASH_METRIC_SHORT[k]}
            </th>
          ))}
          <th style={{
            textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 700,
            color: '#777', borderBottom: '1px solid #e0e0e0'
          }}>Top Failures</th>
        </tr>
      </thead>
      <tbody>
        {stats.map(({ key, family, evaluated, metricAvgs, overall, failureModes }) => (
          <tr key={key} style={{ borderBottom: '1px solid #f2f2f2' }}>
            <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
              {family && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 5,
                  background: FAMILY_COLOR[family], color: FAMILY_TEXT[family], marginRight: 7
                }}>
                  {family}
                </span>
              )}
              <span style={{ color: '#222', fontWeight: 500 }}>{key}</span>
            </td>
            <td style={{ textAlign: 'center', color: '#bbb', fontSize: 11, padding: '7px 6px' }}>{evaluated}</td>
            <td style={{
              textAlign: 'center', padding: '7px 8px', background: scoreBg(overall),
              color: scoreFg(overall), fontWeight: 800, fontSize: 14,
              borderLeft: '2px solid #bbb', borderRight: '2px solid #bbb'
            }}>
              {overall !== null ? overall.toFixed(1) : '—'}
            </td>
            {DASH_METRICS.map(k => <NUM key={k} val={metricAvgs[k]} />)}
            <td style={{ padding: '7px 10px', maxWidth: 240 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {failureModes.slice(0, 3).map(([fm]) => (
                  <span key={fm} style={{
                    fontSize: 11, padding: '2px 6px', borderRadius: 3,
                    background: failureModeColor(fm).bg, color: failureModeColor(fm).fg,
                    border: `1px solid ${failureModeColor(fm).border}`, fontWeight: 500, whiteSpace: 'nowrap'
                  }}>
                    {fm}
                  </span>
                ))}
                {failureModes.length > 3 && (
                  <span style={{
                    fontSize: 11, padding: '2px 6px', borderRadius: 3,
                    background: '#f5f5f5', color: '#aaa', border: '1px solid #e8e8e8', whiteSpace: 'nowrap'
                  }}>
                    +{failureModes.length - 3}
                  </span>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SourceSection({ title, color, records, groupKey, criticVersion }) {
  const stats = React.useMemo(() => computeStats(records, groupKey, criticVersion), [records, groupKey, criticVersion]);
  const n = records.filter(r => hasAnyEvaluation(getVersionedEvaluationState(r, criticVersion))).length;
  if (!stats.length) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
          background: color === 'agent' ? '#e8f0fe' : '#f3e8ff',
          color: color === 'agent' ? '#1a56cc' : '#7c3aed'
        }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: '#bbb' }}>{n} evaluated</span>
      </div>
      <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}>
        <DashTable stats={stats} groupKey={groupKey} />
      </div>
    </div>
  );
}

function DashboardTab({ currentCriticVersion }) {
  const [apiRecords, setApiRecords] = React.useState([]);
  const [expTree, setExpTree] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [view, setView] = React.useState('models');
  React.useEffect(() => {
    Promise.all([
      apiFetch('/api/history-index').then(r => r.json()),
      apiFetch('/api/experiments').then(r => r.json()),
    ])
      .then(([api, exp]) => { setApiRecords(api); setExpTree(exp); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const { agentRecords, copilotRecords } = React.useMemo(() => {
    const agent = apiRecords.map(r => ({
      source: 'agent', experiment: r.experiment || 'base_scene_robust',
      model: r.model || DEFAULT_GENERATION_MODEL,
      evaluationResults: r.evaluationResults || {},
      evaluationMeta: r.evaluationMeta || {},
      evaluationVersions: r.evaluationVersions || {},
    }));
    const copilot = [];
    for (const exp of expTree)
      for (const m of exp.models)
        for (const fig of m.figures)
          copilot.push({
            source: 'copilot',
            experiment: exp.experiment,
            model: m.model,
            evaluationResults: fig.evaluationResults || {},
            evaluationMeta: fig.evaluationMeta || {},
            evaluationVersions: fig.evaluationVersions || {},
          });
    return { agentRecords: agent, copilotRecords: copilot };
  }, [apiRecords, expTree]);

  const totalEval = [...agentRecords, ...copilotRecords]
    .filter(r => hasAnyEvaluation(getVersionedEvaluationState(r, ''))).length;

  if (loading) return <div style={styles.empty}>Loading…</div>;
  if (totalEval === 0)
    return <div style={styles.empty}>No evaluated figures yet.</div>;

  const groupKey = view === 'models' ? 'model' : 'experiment';

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18, borderBottom: '1px solid #e8e8e8' }}>
        {[['models', 'Compare Models'], ['experiments', 'Compare Experiments']].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)} style={{
            padding: '8px 18px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: view === id ? 700 : 400,
            color: view === id ? '#111' : '#999',
            borderBottom: `2px solid ${view === id ? '#111' : 'transparent'}`,
            marginBottom: -1,
          }}>{label}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#ccc', paddingBottom: 4 }}>
          {totalEval} evaluated
        </span>
      </div>

      <SourceSection title="Agent" color="agent" records={agentRecords} groupKey={groupKey} criticVersion="" />
      <SourceSection title="Copilot" color="copilot" records={copilotRecords} groupKey={groupKey} criticVersion="" />
    </div>
  );
}

// ── Chapter Preview Tab ──────────────────────────────────────────────────────
function ChapterPreviewTab() {
  const [bookStructure, setBookStructure] = React.useState([]);
  const [selectedQmd, setSelectedQmd] = React.useState(null);
  const [previewHtml, setPreviewHtml] = React.useState('');
  const [previewLoading, setPreviewLoading] = React.useState(false);

  // Load book structure (parts + chapters with matchCounts)
  React.useEffect(() => {
    apiFetch('/api/chapter-preview/book-structure')
      .then(r => r.json())
      .then(data => {
        setBookStructure(data);
        // Auto-select first chapter that has interactive figures
        for (const entry of data) {
          if (entry.type === 'chapter' && entry.matchCount > 0) { setSelectedQmd(entry); return; }
          if (entry.type === 'part') {
            const first = (entry.chapters || []).find(c => c.matchCount > 0);
            if (first) { setSelectedQmd(first); return; }
          }
        }
      }).catch(() => { });
  }, []);

  // Fetch rendered chapter HTML whenever selection changes
  React.useEffect(() => {
    if (!selectedQmd) { setPreviewHtml(''); return; }
    setPreviewLoading(true);
    apiFetch(`/api/chapter-preview/render?qmd=${encodeURIComponent(selectedQmd.file)}`)
      .then(r => r.text())
      .then(html => { setPreviewHtml(html); setPreviewLoading(false); })
      .catch(() => setPreviewLoading(false));
  }, [selectedQmd]);

  const chapterBtn = (q, indent) => {
    const active = selectedQmd?.file === q.file;
    const hasHTML = q.matchCount > 0;
    return (
      <button
        key={q.file}
        disabled={!hasHTML}
        onClick={() => setSelectedQmd(q)}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          padding: `4px 18px 4px ${indent}px`,
          fontSize: 12.5,
          fontFamily: 'Georgia, serif',
          border: 'none',
          cursor: hasHTML ? 'pointer' : 'default',
          background: 'transparent',
          color: hasHTML ? '#222' : '#bdbdbd',
          fontWeight: active ? 600 : 400,
          lineHeight: 1.35,
        }}
      >
        {q.title || humanTitle(q.stem)}
        {hasHTML && !active && (
          <span style={{ float: 'right', fontSize: 9, color: '#6f86b4', background: '#f4f6fb', borderRadius: 3, padding: '1px 4px', marginTop: 1 }}>
            ✦ {q.matchCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)', overflow: 'hidden' }}>

      {/* Left: book-structured chapter list */}
      <div style={{ width: 270, minWidth: 270, borderRight: '1px solid #e7e7e7', overflowY: 'auto', background: '#fff', padding: '18px 0 40px' }}>
        <div style={{ padding: '0 18px 16px', fontSize: 15, fontWeight: 500, color: '#222', fontFamily: 'Georgia, serif', lineHeight: 1.15 }}>
          Foundations of Computer Vision
        </div>
        {bookStructure.map((entry, i) => {
          if (entry.type === 'chapter') return chapterBtn(entry, 16);
          if (entry.type === 'part') return (
            <div key={`part-${i}`}>
              <div style={{
                padding: '12px 18px 6px', fontSize: 10, fontWeight: 700, color: '#aaa',
                textTransform: 'uppercase', letterSpacing: '0.07em',
                borderTop: i > 0 ? '1px solid #ededed' : 'none', marginTop: i > 0 ? 8 : 0,
              }}>
                {entry.title || humanTitle(entry.stem)}
              </div>
              {(entry.chapters || []).map(q => chapterBtn(q, 26))}
            </div>
          );
          return null;
        })}
      </div>

      {/* Right: chapter preview */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!selectedQmd ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: 14 }}>
            Select a chapter from the list
          </div>
        ) : previewLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: 13 }}>
            Rendering chapter…
          </div>
        ) : (
          <iframe
            key={selectedQmd.file}
            srcdoc={previewHtml}
            style={{ flex: 1, border: 'none', width: '100%' }}
            title="Chapter Preview"
          />
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  root: { fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#fff', color: '#111' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px', background: '#fff', borderBottom: '1px solid #e0e0e0' },
  logo: { fontSize: 16, fontWeight: 600 },
  nav: { display: 'flex', gap: 4 },
  navBtn: { padding: '6px 16px', borderRadius: 6, border: '1px solid #ddd', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 13 },
  navBtnActive: { background: '#111', borderColor: '#111', color: '#fff' },
  main: { padding: '28px 24px', maxWidth: 1200, margin: '0 auto' },
  mainViewer: { maxWidth: 'min(1800px, 98vw)', padding: '18px 12px' },

  // Results sub-tabs
  subTabBar: { display: 'flex', gap: 2, padding: '10px 16px 0', background: '#fafafa', borderBottom: '1px solid #e0e0e0', borderRadius: '10px 10px 0 0' },
  subTabBtn: { padding: '7px 18px', borderRadius: '6px 6px 0 0', border: '1px solid #e0e0e0', borderBottom: 'none', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: -1 },
  subTabBtnActive: { background: '#fff', borderColor: '#e0e0e0', color: '#111', fontWeight: 600 },
  subTabCount: { fontSize: 10, color: '#aaa', background: '#f0f0f0', borderRadius: 10, padding: '1px 6px' },

  // Generator
  genWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, maxWidth: 640, margin: '0 auto' },
  dropZone: { width: '100%', minHeight: 240, border: '1.5px dashed #bbb', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: '#fafafa', transition: 'border-color .2s', overflow: 'hidden' },
  dropZoneActive: { borderColor: '#555', background: '#f0f0f0' },
  dropHint: { textAlign: 'center', color: '#999', userSelect: 'none', fontSize: 14 },
  preview: { maxWidth: '100%', maxHeight: 380, objectFit: 'contain', borderRadius: 8 },
  filename: { fontSize: 12, color: '#888', margin: 0 },
  promptSection: { width: '100%' },
  promptToggle: { background: 'none', border: '1px solid #ddd', color: '#666', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 },
  promptBox: { marginTop: 6, padding: 12, background: '#fafafa', borderRadius: 6, border: '1px solid #e0e0e0', fontSize: 11, color: '#888', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflowY: 'auto' },
  errorMsg: { color: '#c00', fontSize: 13, margin: 0 },
  modelSelector: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  modelLabel: { fontSize: 13, fontWeight: 600, color: '#333', whiteSpace: 'nowrap' },
  modelSelect: { flex: 1, fontSize: 13, border: '1px solid #ddd', borderRadius: 6, padding: '7px 12px', background: '#fff', color: '#333', cursor: 'pointer' },
  generateBtn: { padding: '11px 0', fontSize: 14, fontWeight: 600, borderRadius: 8, border: 'none', background: '#111', color: '#fff', cursor: 'pointer', width: '100%', transition: 'opacity .2s' },
  generateBtnDisabled: { opacity: 0.35, cursor: 'not-allowed' },

  // Viewer
  viewerWrap: { display: 'flex', gap: 0, height: 'calc(100vh - 95px)', borderRadius: 10, overflow: 'hidden', border: '1px solid #e0e0e0' },
  viewerLeft: { width: 'clamp(360px, 36vw, 560px)', minWidth: 300, background: '#fafafa', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, borderRight: '1px solid #e0e0e0', overflowY: 'auto' },
  thumbImg: { width: '100%', borderRadius: 6, objectFit: 'contain', maxHeight: 150, background: '#fff', border: '1px solid #eee' },
  viewerFilename: { fontSize: 11, color: '#666', margin: 0, wordBreak: 'break-all' },
  viewerTs: { fontSize: 10, color: '#aaa', margin: 0 },
  viewerMeta: { fontSize: 10, color: '#777', margin: '-4px 0 0' },
  viewerPlanWrap: { border: '1px solid #e0e0e0', borderRadius: 6, background: '#fff', padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 4 },
  viewerPlanTitle: { fontSize: 10, fontWeight: 700, color: '#444', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' },
  viewerPlanMeta: { fontSize: 10, color: '#666', margin: 0 },
  viewerPlanConcept: { fontSize: 10, color: '#333', margin: 0, lineHeight: 1.35 },
  viewerPlanLine: { fontSize: 10, color: '#555', margin: 0, lineHeight: 1.35 },
  viewerPlanSummary: { fontSize: 10, color: '#777', cursor: 'pointer', userSelect: 'none' },
  viewerPlanRaw: { marginTop: 6, maxHeight: 160, overflowY: 'auto', fontSize: 10, lineHeight: 1.35, color: '#666', background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  viewerPlanPlaceholder: { border: '1px dashed #d7d7d7', borderRadius: 6, background: '#fff', color: '#8a8a8a', fontSize: 10, lineHeight: 1.35, padding: '8px 9px' },
  viewerHistoryWrap: { border: '1px solid #e0e0e0', borderRadius: 6, background: '#fff', padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 8 },
  viewerHistoryHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  viewerHistoryCount: { fontSize: 10, color: '#8a8a8a', background: '#f5f5f5', borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap' },
  viewerHistoryRail: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  viewerHistoryButton: { minWidth: 62, display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '6px 8px', borderRadius: 6, border: '1px solid #d8d8d8', background: '#fafafa', color: '#555', cursor: 'pointer', textAlign: 'left' },
  viewerHistoryButtonActive: { borderColor: '#111', background: '#111', color: '#fff' },
  viewerHistoryButtonLabel: { fontSize: 12, fontWeight: 700, lineHeight: 1 },
  viewerHistoryButtonMeta: { fontSize: 9, opacity: 0.78, lineHeight: 1.1, textTransform: 'uppercase', letterSpacing: '0.05em' },
  viewerHistoryScore: { fontSize: 10, fontWeight: 700, lineHeight: 1.1 },
  viewerHistoryDetail: { borderTop: '1px solid #eee', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 },
  viewerHistoryDetailHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  viewerHistoryDetailTitle: { fontSize: 11, fontWeight: 700, color: '#333', textTransform: 'uppercase', letterSpacing: '0.05em' },
  viewerHistoryDetailScore: { fontSize: 16, fontWeight: 700, lineHeight: 1 },
  viewerHistoryMeta: { fontSize: 10, color: '#777', margin: 0 },
  viewerHistoryList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 },
  viewerHistoryItem: { fontSize: 10, color: '#444', lineHeight: 1.35, background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: '5px 6px' },
  viewerHistoryNotes: { margin: 0, fontSize: 10, color: '#666', lineHeight: 1.4 },
  viewerHistoryEmpty: { margin: 0, fontSize: 10, color: '#8a8a8a', lineHeight: 1.4 },
  viewerHistoryEmptyBox: { border: '1px dashed #d7d7d7', borderRadius: 6, background: '#fff', color: '#8a8a8a', fontSize: 10, lineHeight: 1.35, padding: '8px 9px' },
  downloadBtn: { display: 'block', padding: '7px 0', textAlign: 'center', background: '#fff', color: '#333', borderRadius: 6, textDecoration: 'none', fontSize: 12, border: '1px solid #ddd' },
  backBtn: { padding: '7px 0', background: '#fff', border: '1px solid #ddd', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  newBtn: { padding: '7px 0', background: '#fff', border: '1px solid #ddd', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  deleteBtn: { padding: '7px 0', background: '#fff', border: '1px solid #fbb', color: '#c00', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginTop: 'auto' },
  viewerRight: { flex: 1, minWidth: 0, background: '#fff' },
  iframe: { width: '100%', height: '100%', border: 'none' },

  // History
  historyGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14 },
  card: { background: '#f0f0f0', border: 'none', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', transition: 'background .15s' },
  cardThumb: { width: '100%', height: 130, objectFit: 'cover' },
  cardInfo: { padding: '8px 10px' },
  cardFilename: { fontSize: 12, fontWeight: 600, margin: '0 0 3px', color: '#222', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardGenModel: { fontSize: 10, color: '#777', margin: '0 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardEvalModel: { fontSize: 10, color: '#777', margin: '4px 0 2px' },
  cardTs: { fontSize: 10, color: '#aaa', margin: 0 },
  cardDeleteBtn: { position: 'absolute', top: 4, right: 6, background: 'none', border: 'none', color: '#999', fontSize: 13, cursor: 'pointer', padding: 0, lineHeight: 1 },

  empty: { textAlign: 'center', color: '#aaa', marginTop: 80, fontSize: 15 },
  sourceBadge: { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 8 },
  sourceBadgeApi: { background: '#f0f0f0', color: '#555' },
  sourceBadgeChat: { background: '#e8f5e9', color: '#2e7d32' },

  // Evaluation panel
  evalSection: { borderTop: '1px solid #e0e0e0', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 },
  evalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  evalTitle: { fontSize: 10, fontWeight: 700, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em' },
  evalOverall: { fontSize: 17, fontWeight: 700, lineHeight: 1 },
  evalRow: { display: 'flex', alignItems: 'center', gap: 5 },
  evalLabel: { width: 56, fontSize: 10, color: '#666', flexShrink: 0 },
  evalBarBg: { flex: 1, height: 4, background: '#e8e8e8', borderRadius: 2, overflow: 'hidden' },
  evalBar: { height: '100%', borderRadius: 2, transition: 'width .35s ease' },
  evalScore: { width: 16, textAlign: 'right', fontSize: 10, fontWeight: 700 },
  evalFailures: { display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 2 },
  evalFailureTag: { fontSize: 11, borderRadius: 3, padding: '2px 6px', lineHeight: 1.6, border: '1px solid transparent' },
  evalMeta: { fontSize: 10, color: '#777', margin: '-2px 0 4px' },
  evalNotes: { fontSize: 10, color: '#888', margin: '2px 0 0', lineHeight: 1.45 },
  evalBtn: { padding: '6px 0', background: '#fff', border: '1px solid #ddd', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 11 },

  // Results tab
  criticVersionBar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: '#eef2f7', borderBottom: '1px solid #d9e0ea', overflowX: 'auto' },
  criticVersionBarLabel: { fontSize: 10, fontWeight: 700, color: '#5a6c86', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 },
  criticVersionRail: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', minWidth: 0, paddingBottom: 2 },
  criticVersionPill: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', border: '1px solid #ccd5e3', borderRadius: 999, background: '#fff', color: '#445', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' },
  criticVersionPillActive: { background: '#1f2937', borderColor: '#1f2937', color: '#fff' },
  criticVersionCount: { fontSize: 10, padding: '1px 5px', borderRadius: 999, background: 'rgba(0,0,0,0.06)' },
  criticVersionInput: { fontSize: 11, border: '1px solid #ccd5e3', borderRadius: 999, padding: '4px 10px', background: '#fff', color: '#445', minWidth: 190, maxWidth: 240 },
  criticVersionMeta: { marginLeft: 'auto', fontSize: 11, color: '#7c8aa0', whiteSpace: 'nowrap', flexShrink: 0 },
  criticVersionEmpty: { fontSize: 11, color: '#99a3b2' },
  resultFilterBar: { display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 16, borderBottom: '1px solid #e0e0e0', marginBottom: 20 },
  resultFilterGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  resultFilterLabel: { fontSize: 12, color: '#666' },
  resultFilterSelect: { fontSize: 12, border: '1px solid #ddd', borderRadius: 5, padding: '4px 8px', background: '#fff', color: '#333', cursor: 'pointer' },
  resultChapterHeader: { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f0f0f0' },

  expWrap: { display: 'flex', height: 'calc(100vh - 120px)', gap: 0, border: '1px solid #e0e0e0', borderRadius: 10, overflow: 'hidden' },
  expTree: { width: 200, minWidth: 200, background: '#fafafa', borderRight: '1px solid #e0e0e0', overflowY: 'auto', padding: '8px 0' },
  expTreeGroup: { fontSize: 10, fontWeight: 700, color: '#222', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '10px 14px 4px' },
  expTreeItem: { padding: '6px 14px', cursor: 'pointer', fontSize: 11, color: '#444', display: 'flex', alignItems: 'center', gap: 4, borderLeft: '3px solid transparent' },
  expTreeItemActive: { background: '#f0f0f0', borderLeftColor: '#111', color: '#111', fontWeight: 600 },
  expContent: { flex: 1, overflowY: 'auto', padding: 16 },
  expHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12 },
  expHeaderTitle: { fontSize: 13, fontWeight: 600, color: '#111' },
  expPromptBox: { fontSize: 10, color: '#888', background: '#fafafa', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto', marginTop: 6 },
  expGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 },
  expCard: { border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden', background: '#fff' },
  expThumb: { width: '100%', height: 90, objectFit: 'cover', background: '#f5f5f5' },
  expCardBody: { padding: '8px 10px' },
  expCardName: { fontSize: 11, fontWeight: 600, color: '#222', margin: '0 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  expCardChapter: { fontSize: 10, color: '#aaa', margin: 0 },

  // Planner styles
  planBtn: { padding: '9px 0', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '2px solid #4a90d9', background: '#fff', color: '#4a90d9', cursor: 'pointer', width: '100%', transition: 'opacity .2s' },
  planBtnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  planPanel: { width: '100%', background: '#f8faff', border: '1px solid #d0ddf0', borderRadius: 8, padding: '12px 14px' },
  planHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  planTitle: { fontSize: 13, fontWeight: 700, color: '#333' },
  planChapter: { fontSize: 11, color: '#4a90d9', fontWeight: 600 },
  planConcept: { fontSize: 12, color: '#555', fontStyle: 'italic', margin: '0 0 8px', lineHeight: 1.4 },
  planSubhead: { fontSize: 10, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 6 },
  planList: { fontSize: 12, color: '#444' },
  planInteraction: { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 3, flexWrap: 'wrap' },
  planInterType: { fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3, background: '#e3ecf7', color: '#2a5a94' },
  planInterLabel: { fontSize: 12, color: '#333', fontWeight: 500 },
  planInterTeaches: { fontSize: 11, color: '#888' },
  planContext: { fontSize: 10, color: '#999', background: '#fff', border: '1px solid #e8e8e8', borderRadius: 4, padding: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 150, overflowY: 'auto', marginTop: 4 },

  // Generic plan field renderer (shows every key in a plan payload, regardless of schema)
  planFieldsRoot: { display: 'flex', flexDirection: 'column', gap: 5 },
  planFieldsNested: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2, marginLeft: 10, paddingLeft: 8, borderLeft: '2px solid #e3ecf7' },
  planFieldRow: { display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' },
  planFieldLabel: { fontSize: 10, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' },
  planFieldValue: { fontSize: 12, color: '#333', lineHeight: 1.4, wordBreak: 'break-word' },
  planNestedList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2, width: '100%' },
  planNestedItem: { background: '#fff', border: '1px solid #e8e8e8', borderRadius: 6, padding: '6px 8px' },
  planFieldsDetails: { width: '100%' },
  planFieldsSummary: { fontSize: 11, color: '#888', cursor: 'pointer', userSelect: 'none', marginBottom: 4 },

  // Mode toggle
  modeBtn: { padding: '6px 16px', borderRadius: 6, border: '1px solid #ddd', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  modeBtnActive: { background: '#111', borderColor: '#111', color: '#fff' },

  // Chapter / Book mode
  chapterMode: { width: '100%' },
  bookMode: { width: '100%' },
  chapterLabel: { fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 6, display: 'block' },
  chapterSelect: { width: '100%', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, padding: '8px 12px', background: '#fff', color: '#333', cursor: 'pointer' },
  smallBtn: { fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px solid #ddd', background: '#fff', color: '#555', cursor: 'pointer' },
  candidateGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 12 },
  candidateCard: { border: '1px solid #e0e0e0', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#fff', transition: 'box-shadow .15s' },
  candidateThumb: { width: '100%', height: 80, objectFit: 'contain', background: '#fafafa' },
  candidateName: { fontSize: 10, color: '#555', padding: '4px 6px', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  chapterPlansWrap: { marginTop: 14, padding: '12px 14px', background: '#f8faff', border: '1px solid #d0ddf0', borderRadius: 8 },
  chapterPlanItem: { marginBottom: 4, borderBottom: '1px solid #e8ecf4' },
  chapterPlanSummary: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#333' },

  generatorModelCard: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, padding: '12px 14px', border: '1px solid #e0e0e0', borderRadius: 10, background: '#fff' },
  criticPassCard: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: 10, background: '#fff' },
  criticPassCardCompact: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, padding: '4px 8px', border: '1px solid #ccd5e3', borderRadius: 999, background: '#fff', flexShrink: 0 },
  criticPassLabelCompact: { fontSize: 10, fontWeight: 700, color: '#5a6c86', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' },
  criticPassSelectCompact: { fontSize: 11, border: '1px solid #ccd5e3', borderRadius: 999, padding: '2px 8px', background: '#eef2f7', color: '#445', cursor: 'pointer', minWidth: 88, height: 26 },
  generatorSettingsDetails: { width: '100%', boxSizing: 'border-box', marginBottom: 14, border: '1px solid #e0e0e0', borderRadius: 10, background: '#fafafa', overflow: 'hidden' },
  generatorSettingsSummary: { listStyle: 'none', cursor: 'pointer', padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#445', textTransform: 'uppercase', letterSpacing: '0.06em', userSelect: 'none' },
  generatorSettingsBody: { padding: '0 14px 14px', boxSizing: 'border-box' },
  generatorControlRow: { display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap' },
  generatorExperimentCard: { width: '100%', display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: 10, background: '#fff', boxSizing: 'border-box' },
  generatorControlCard: { width: '100%', display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', border: '1px solid #e0e0e0', borderRadius: 10, background: '#fff', boxSizing: 'border-box' },
  generatorModelStack: { flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  generatorModelLabel: { fontSize: 12, fontWeight: 700, color: '#444', textTransform: 'uppercase', letterSpacing: '0.04em' },
  generatorModelSelect: { width: '100%', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, padding: '9px 12px', background: '#fff', color: '#333', cursor: 'pointer' },
  generatorTextInput: { width: '100%', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, padding: '9px 12px', background: '#fff', color: '#333' },
  generatorExperimentControls: { display: 'flex', flexDirection: 'column', gap: 8 },
  generatorHint: { fontSize: 12, color: '#6b7280', margin: '2px 0 0' },
};
