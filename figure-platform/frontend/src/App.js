import React, { useState, useCallback, useEffect } from 'react';

const FALLBACK_PROMPT = '(Loading system prompt from server…)';

export default function App() {
  const [tab, setTab] = useState('generator');
  const [image, setImage] = useState(null); // { base64, mediaType, filename, previewUrl }
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(FALLBACK_PROMPT);

  // Model selection (generator only)
  const [models, setModels] = useState([]);       // available models from backend
  const [selectedModel, setSelectedModel] = useState(''); // '' = server default

  // Fetch the real system prompt + available models from the backend on mount
  useEffect(() => {
    fetch('/api/prompt')
      .then(r => r.json())
      .then(d => { if (d.prompt) setSystemPrompt(d.prompt); })
      .catch(() => {});
    fetch('/api/models')
      .then(r => r.json())
      .then(list => {
        setModels(list);
        // Default to the first model in the list (server default)
        if (list.length > 0) setSelectedModel(prev => prev || list[0].id);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  const [currentRecord, setCurrentRecord] = useState(null); // full record from history
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [evaluation, setEvaluation] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [plan, setPlan] = useState(null);        // planner output for current figure
  const [planning, setPlanning] = useState(false); // true while planner is running

  // Called by Uploader when a file is selected
  const handleImageSelected = useCallback((imgData) => {
    setImage(imgData);
    setPlan(null);
    setError('');
  }, []);

  // Single Generate button: plan first (fast), then generate (slow) — fully automated
  const handleGenerate = useCallback(async () => {
    if (!image) return;
    setError('');

    // Step 1: Plan (fast ~2-3s)
    setPlanning(true);
    setPlan(null);
    let currentPlan = null;
    try {
      const planRes = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: image.filename }),
      });
      const planData = await planRes.json();
      if (planRes.ok) {
        currentPlan = planData;
        setPlan(planData);
      }
      // If planning fails, we still continue to generate without a plan
    } catch (_) { /* planner failure is non-fatal */ }
    setPlanning(false);

    // Step 2: Generate (slow ~30-60s)
    setLoading(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64: image.base64,
          mediaType: image.mediaType,
          filename: image.filename,
          plan: currentPlan || undefined,
          model: selectedModel || undefined,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) {
        throw new Error(text.slice(0, 200) || 'Server returned non-JSON response');
      }
      if (!res.ok) throw new Error(data.error || 'Generation failed.');
      setGeneratedHtml(data.html);
      setEvaluation(data.evaluation || null);
      setCurrentRecord({
        id: data.figureId,
        html: data.html,
        filename: image.filename,
        base64thumb: image.base64,
        mediaType: image.mediaType,
        timestamp: data.timestamp,
        evaluation: data.evaluation || null,
      });
      setTab('viewer');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [image, selectedModel]);
  const handleLoadFromHistory = useCallback((record) => {
    setCurrentRecord(record);
    setGeneratedHtml(record.html);
    setEvaluation(record.evaluation || null);
    setTab('viewer');
  }, []);

  // Delete a saved result by id
  const handleDelete = useCallback(async (id) => {
    try {
      await fetch(`/api/result/${id}`, { method: 'DELETE' });
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
    setTab('generator');
  }, [currentRecord, handleDelete]);

  // Open any result (API record by id, or experiment by htmlPath) in the Viewer
  const handleOpenResult = useCallback(async (item) => {
    if (item.type === 'api') {
      try {
        const res = await fetch(`/api/result/${item.id}`);
        const record = await res.json();
        handleLoadFromHistory(record);
      } catch (err) { alert('Failed to load: ' + err.message); }
    } else {
      try {
        const htmlRes = await fetch('/api/experiments/html?path=' + encodeURIComponent(item.htmlPath));
        const html = await htmlRes.text();
        let base64thumb = null;
        if (item.imagePath) {
          const imgRes = await fetch('/api/experiments/image?path=' + encodeURIComponent(item.imagePath));
          if (imgRes.ok) base64thumb = await imgRes.text();
        }
        const expSource = [item.experiment, item.model].filter(Boolean).join(' / ');
        setGeneratedHtml(html);
        setCurrentRecord({ html, filename: item.figure + '.html', base64thumb, mediaType: 'image/png', timestamp: new Date().toISOString(), source: expSource || item.source, htmlPath: item.htmlPath, imagePath: item.imagePath });
        setEvaluation(item.evaluation || null);
        setTab('viewer');
      } catch (err) { alert('Failed to load: ' + err.message); }
    }
  }, [handleLoadFromHistory]);

  // Evaluate: works for API records (by id) and experiment records (by htmlPath)
  const handleEvaluate = useCallback(async () => {
    if (!currentRecord) return;
    setEvaluating(true);
    try {
      let data;
      if (currentRecord.htmlPath) {
        const res = await fetch('/api/experiments/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ htmlPath: currentRecord.htmlPath, imagePath: currentRecord.imagePath }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Evaluation failed.');
      } else if (currentRecord.id) {
        const res = await fetch('/api/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: currentRecord.id }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Evaluation failed.');
      } else {
        throw new Error('Cannot evaluate: no id or htmlPath.');
      }
      setEvaluation(data);
    } catch (err) {
      alert('Evaluation failed: ' + err.message);
    } finally {
      setEvaluating(false);
    }
  }, [currentRecord]);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>3D Figure Generator</span>
        <nav style={styles.nav}>
          {['generator', 'viewer', 'results', 'dashboard'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...styles.navBtn, ...(tab === t ? styles.navBtnActive : {}) }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      <main style={styles.main}>
        {tab === 'generator' && (
          <GeneratorTab
            image={image}
            onImageSelected={handleImageSelected}
            onGenerate={handleGenerate}
            loading={loading}
            planning={planning}
            plan={plan}
            error={error}
            systemPrompt={systemPrompt}
            models={models}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
          />
        )}
        {tab === 'viewer' && (
          <ViewerTab
            record={currentRecord}
            html={generatedHtml}
            onNew={() => setTab('generator')}
            onDelete={handleDeleteCurrent}
            evaluation={evaluation}
            evaluating={evaluating}
            onEvaluate={handleEvaluate}
          />
        )}
        {tab === 'results' && (
          <ResultsTab onOpen={handleOpenResult} />
        )}
        {tab === 'dashboard' && (
          <DashboardTab />
        )}
      </main>
    </div>
  );
}

// ── Generator Tab ─────────────────────────────────────────────────────────────
function GeneratorTab({ image, onImageSelected, onGenerate, loading, planning, plan, error, systemPrompt, models, selectedModel, onModelChange }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState('figure'); // 'figure' | 'chapter'
  const [chapters, setChapters] = useState([]);
  const [selectedChapter, setSelectedChapter] = useState('');
  const [chapterCandidates, setChapterCandidates] = useState([]);
  const [loadingChapter, setLoadingChapter] = useState(false);

  // Chapter batch pipeline state
  const [chapterRunning, setChapterRunning] = useState(false);     // true while batch is active
  const [chapterProgress, setChapterProgress] = useState(null);    // { completed, total, active: [{figureStem, phase, plan}] }
  const [chapterResults, setChapterResults] = useState([]);        // accumulated { figureStem, status:'ok'|'error', figureId?, error? }
  const chapterAbortRef = React.useRef(false);

  // Inline viewer for completed figures (doesn't leave this tab)
  const [previewHtml, setPreviewHtml] = useState(null);
  const [previewName, setPreviewName] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  const handlePreview = async (figureId, name) => {
    setPreviewLoading(true);
    setPreviewName(name);
    try {
      const res = await fetch(`/api/result/${figureId}`);
      const data = await res.json();
      if (res.ok && data.html) {
        setPreviewHtml(data.html);
      }
    } catch (_) {}
    setPreviewLoading(false);
  };

  // Load chapter list on mount
  React.useEffect(() => {
    fetch('/api/chapters').then(r => r.json()).then(setChapters).catch(() => {});
  }, []);

  // When a chapter is selected, load its 3D candidates
  React.useEffect(() => {
    if (!selectedChapter) { setChapterCandidates([]); return; }
    setLoadingChapter(true);
    fetch(`/api/chapter-candidates/${encodeURIComponent(selectedChapter)}`)
      .then(r => r.json())
      .then(data => { setChapterCandidates(data); setLoadingChapter(false); })
      .catch(() => setLoadingChapter(false));
  }, [selectedChapter]);

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

  // Fully automated chapter pipeline with parallel generation (concurrency = 8)
  const CONCURRENCY = 8;

  const handleRunChapter = async () => {
    if (!selectedChapter || chapterCandidates.length === 0) return;
    setChapterRunning(true);
    setChapterResults([]);
    chapterAbortRef.current = false;

    const total = chapterCandidates.length;
    const results = [];           // shared results array
    const activeMap = new Map();   // stem → { figureStem, phase, plan }

    const updateProgress = () => {
      setChapterProgress({ completed: results.length, total, active: [...activeMap.values()] });
    };

    // Process a single candidate (plan → generate)
    const processFigure = async (candidate) => {
      if (chapterAbortRef.current) return;
      activeMap.set(candidate.stem, { figureStem: candidate.stem, phase: 'planning', plan: null });
      updateProgress();

      // Phase 1: Plan
      let figurePlan = null;
      try {
        const planRes = await fetch('/api/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: candidate.filename, chapterHint: selectedChapter }),
        });
        if (planRes.ok) figurePlan = await planRes.json();
      } catch (_) {}

      if (chapterAbortRef.current) { activeMap.delete(candidate.stem); return; }

      activeMap.set(candidate.stem, { figureStem: candidate.stem, phase: 'generating', plan: figurePlan });
      updateProgress();

      // Phase 2: Generate
      try {
        const genRes = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base64: candidate.base64,
            mediaType: candidate.mediaType,
            filename: candidate.filename,
            plan: figurePlan || undefined,
            model: selectedModel || undefined,
          }),
        });
        const genText = await genRes.text();
        let genData;
        try { genData = JSON.parse(genText); } catch (_) {
          throw new Error(genText.slice(0, 200) || 'Server returned non-JSON response');
        }
        if (!genRes.ok) throw new Error(genData.error || 'Generation failed');
        results.push({ figureStem: candidate.stem, status: 'ok', figureId: genData.figureId });
      } catch (err) {
        results.push({ figureStem: candidate.stem, status: 'error', error: err.message });
      }

      activeMap.delete(candidate.stem);
      setChapterResults([...results]);
      updateProgress();
    };

    // Run with limited concurrency — use a queue to avoid race conditions
    const queue = [...chapterCandidates];
    const runWorker = async () => {
      while (queue.length > 0 && !chapterAbortRef.current) {
        const candidate = queue.shift();
        if (candidate) await processFigure(candidate);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => runWorker()));

    setChapterProgress(null);
    setChapterRunning(false);
  };

  const handleAbortChapter = () => { chapterAbortRef.current = true; };

  // Select a chapter candidate to load it into the figure drop zone (still works for individual)
  const handleSelectCandidate = (candidate) => {
    if (chapterRunning) return; // don't interrupt batch
    onImageSelected({
      base64: candidate.base64,
      mediaType: candidate.mediaType,
      filename: candidate.filename,
      previewUrl: `data:${candidate.mediaType};base64,${candidate.base64}`,
    });
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
      </div>

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
                  <div style={styles.planHeader}>
                    <span style={styles.planTitle}>📋 Interaction Plan</span>
                    {plan.chapterName && <span style={styles.planChapter}>Chapter: {plan.chapterName}</span>}
                  </div>
                  {plan.interactionPlan ? (
                    <>
                      {plan.interactionPlan.concept && (
                        <p style={styles.planConcept}>{plan.interactionPlan.concept}</p>
                      )}
                      {plan.interactionPlan.elements?.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <span style={styles.planSubhead}>Elements:</span>
                          <span style={styles.planList}>{plan.interactionPlan.elements.join(', ')}</span>
                        </div>
                      )}
                      {plan.interactionPlan.interactions?.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <span style={styles.planSubhead}>Interactions:</span>
                          {plan.interactionPlan.interactions.map((inter, i) => (
                            <div key={i} style={styles.planInteraction}>
                              <span style={styles.planInterType}>{inter.type}</span>
                              <span style={styles.planInterLabel}>{inter.label}</span>
                              <span style={styles.planInterTeaches}>— {inter.teaches}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
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

          {/* Model selector */}
          {models.length > 0 && (
            <div style={styles.modelSelector}>
              <label style={styles.modelLabel}>Generator model:</label>
              <select
                style={styles.modelSelect}
                value={selectedModel}
                onChange={e => onModelChange(e.target.value)}
                disabled={loading || planning}
              >
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.label}  ({m.provider})
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            style={{ ...styles.generateBtn, ...(loading || planning || !image ? styles.generateBtnDisabled : {}) }}
            onClick={onGenerate}
            disabled={loading || planning || !image}
          >
            {planning ? 'Planning…' : loading ? 'Generating — this may take 30-60s…' : 'Generate 3D Figure'}
          </button>
        </>
      ) : (
        /* Chapter mode */
        <div style={styles.chapterMode}>
          <label style={styles.chapterLabel}>Select a chapter:</label>
          <select
            style={styles.chapterSelect}
            value={selectedChapter}
            onChange={e => setSelectedChapter(e.target.value)}
          >
            <option value="">— choose —</option>
            {chapters.map(ch => (
              <option key={ch.name} value={ch.name} disabled={ch.candidateCount === 0} style={ch.candidateCount === 0 ? { color: '#bbb' } : {}}>
                {ch.name} ({ch.candidateCount} candidate{ch.candidateCount !== 1 ? 's' : ''})
              </option>
            ))}
          </select>

          {loadingChapter && <p style={{ fontSize: 12, color: '#888' }}>Loading candidates…</p>}

          {selectedChapter && chapterCandidates.length > 0 && (
            <>
              {/* Model selector (chapter mode) — above the grid so it's always visible */}
              {models.length > 0 && (
                <div style={{ ...styles.modelSelector, marginBottom: 10 }}>
                  <label style={styles.modelLabel}>Generator model:</label>
                  <select
                    style={styles.modelSelect}
                    value={selectedModel}
                    onChange={e => onModelChange(e.target.value)}
                    disabled={chapterRunning}
                  >
                    {models.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.label}  ({m.provider})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Candidate thumbnail grid — clickable to go to single-figure mode */}
              <div style={styles.candidateGrid}>
                {chapterCandidates.map((c, idx) => {
                  const done = chapterResults.find(r => r.figureStem === c.stem);
                  const isCurrent = chapterProgress?.active?.some(a => a.figureStem === c.stem);
                  const borderColor = done ? (done.status === 'ok' ? '#4caf50' : '#e74c3c') : isCurrent ? '#4a90d9' : 'transparent';
                  return (
                    <div key={c.stem} style={{ ...styles.candidateCard, border: `2px solid ${borderColor}`, opacity: chapterRunning && !isCurrent && !done ? 0.4 : 1, position: 'relative' }}>
                      <img src={`data:${c.mediaType};base64,${c.base64}`} alt={c.stem} style={styles.candidateThumb}
                        onClick={() => handleSelectCandidate(c)} />
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
                  style={{ ...styles.generateBtn, marginTop: 12 }}
                  onClick={handleRunChapter}
                >
                  Generate All {chapterCandidates.length} Figures
                </button>
              ) : (
                <button
                  style={{ ...styles.generateBtn, marginTop: 12, background: '#e74c3c', borderColor: '#e74c3c' }}
                  onClick={handleAbortChapter}
                >
                  Stop After Current Figures
                </button>
              )}

              {/* Live progress: current figure's plan + context while generating */}
              {chapterProgress && (
                <div style={{ ...styles.planPanel, marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>
                      {chapterProgress.active?.length || 0} active ({chapterProgress.completed} / {chapterProgress.total} done)
                    </span>
                    <span style={{ fontSize: 11, color: '#888' }}>
                      Concurrency: {CONCURRENCY}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div style={{ height: 4, background: '#eee', borderRadius: 2, marginBottom: 10, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#4caf50', borderRadius: 2, transition: 'width 0.3s', width: `${(chapterProgress.completed / chapterProgress.total) * 100}%` }} />
                  </div>

                  {/* Show each active figure */}
                  {chapterProgress.active?.map(a => (
                    <div key={a.figureStem} style={{ marginBottom: 10, padding: '8px 10px', background: '#f8faff', borderRadius: 6, border: '1px solid #e0e8f0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>
                          {a.phase === 'planning' ? '⏳' : '🔄'} {a.figureStem} — {a.phase}
                        </span>
                        {a.plan?.chapterName && <span style={styles.planChapter}>Chapter: {a.plan.chapterName}</span>}
                      </div>
                      {a.plan?.interactionPlan?.concept && (
                        <p style={styles.planConcept}>{a.plan.interactionPlan.concept}</p>
                      )}
                      {a.plan?.interactionPlan?.elements?.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <span style={styles.planSubhead}>Elements:</span>
                          <span style={styles.planList}>{a.plan.interactionPlan.elements.join(', ')}</span>
                        </div>
                      )}
                      {a.plan?.interactionPlan?.interactions?.length > 0 && (
                        <div style={{ marginBottom: 4 }}>
                          <span style={styles.planSubhead}>Interactions:</span>
                          {a.plan.interactionPlan.interactions.map((inter, i) => (
                            <div key={i} style={styles.planInteraction}>
                              <span style={styles.planInterType}>{inter.type}</span>
                              <span style={styles.planInterLabel}>{inter.label}</span>
                              <span style={styles.planInterTeaches}>— {inter.teaches}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
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
                  {!chapterRunning && <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Also available in the Results tab.</p>}
                </div>
              )}
            </>
          )}

          {selectedChapter && chapterCandidates.length === 0 && !loadingChapter && (
            <p style={{ fontSize: 12, color: '#aaa', marginTop: 12 }}>No 3D candidates found for this chapter.</p>
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
function ViewerTab({ record, html, onNew, onDelete, evaluation, evaluating, onEvaluate }) {
  if (!html) {
    return (
      <div style={styles.empty}>
        No figure generated yet. Go to the <strong>Generator</strong> tab to create one.
      </div>
    );
  }

  const blob = new Blob([html], { type: 'text/html' });
  const downloadUrl = URL.createObjectURL(blob);
  const mediaType = record?.mediaType || 'image/png';
  const thumbSrc = record?.base64thumb
    ? `data:${mediaType};base64,${record.base64thumb}`
    : null;

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
          <span style={{ ...styles.sourceBadge,
            ...(record.source === 'chat' ? styles.sourceBadgeChat :
                record.source === 'api' ? styles.sourceBadgeApi :
                { background: '#e8f0ff', color: '#1a3a8a' })
          }}>
            {record.source}
          </span>
        )}
        <a href={downloadUrl} download={`figure_${Date.now()}.html`} style={styles.downloadBtn}>
          Download HTML
        </a>
        <button style={styles.newBtn} onClick={onNew}>
          New Figure
        </button>
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
          evaluating={evaluating}
          onEvaluate={onEvaluate}
          canEvaluate={!!(record?.id || record?.htmlPath)}
        />
      </div>

      {/* Right panel: iframe */}
      <div style={styles.viewerRight}>
        <iframe
          title="3d-figure"
          srcDoc={html}
          sandbox="allow-scripts allow-same-origin"
          style={styles.iframe}
        />
      </div>
    </div>
  );
}

// ── Evaluation Panel ─────────────────────────────────────────────────────────
function EvaluationPanel({ evaluation, evaluating, onEvaluate, canEvaluate }) {
  const [showAllFailures, setShowAllFailures] = React.useState(false);
  const scoreTextColor = (s) => { const rgb = lerpColor(s); if (!rgb) return '#888'; return `rgb(${Math.round(rgb[0]*0.6)},${Math.round(rgb[1]*0.6)},${Math.round(rgb[2]*0.5)})`; };
  const scoreBarColor  = (s) => { const rgb = lerpColor(s); if (!rgb) return '#ccc'; return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`; };
  const METRICS = [
    { key: 'geometry_accuracy',      label: 'Geometry'   },
    { key: 'interactivity_usability', label: 'Interact.'  },
    { key: 'faithfulness',           label: 'Faithful'   },
    { key: 'label_quality',          label: 'Labels'     },
    { key: 'concept_accuracy',       label: 'Concept'    },
    { key: 'visual_aesthetics',      label: 'Visual*'    },
  ];

  if (evaluating) {
    return (
      <div style={styles.evalSection}>
        <p style={{ fontSize: 11, color: '#888', margin: 0 }}>Evaluating…</p>
      </div>
    );
  }

  if (!evaluation) {
    if (!canEvaluate) return null;
    return (
      <div style={styles.evalSection}>
        <button style={styles.evalBtn} onClick={onEvaluate}>Evaluate</button>
      </div>
    );
  }

  const failures = evaluation.failure_modes || [];
  const visible = showAllFailures ? failures : failures.slice(0, 3);

  return (
    <div style={styles.evalSection}>
      <div style={styles.evalHeader}>
        <span style={styles.evalTitle}>Evaluation</span>
        <span style={{ ...styles.evalOverall, color: scoreTextColor(evaluation.overall_average) }}>
          {evaluation.overall_average}/5
        </span>
      </div>

      {METRICS.map(({ key, label }) => (
        <div key={key} style={styles.evalRow}>
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
        </div>
      )}

      {evaluation.notes && (
        <p style={styles.evalNotes}>{evaluation.notes}</p>
      )}
    </div>
  );
}

// ── LazyThumb — fetches experiment screenshot on first render ─────────────────
function LazyThumb({ htmlPath, style }) {
  const [src, setSrc] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!htmlPath) { setLoading(false); return; }
    let cancelled = false;
    fetch('/api/experiments/thumb?path=' + encodeURIComponent(htmlPath))
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!cancelled && d?.data) setSrc(`data:${d.mediaType};base64,${d.data}`);
        if (!cancelled) setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [htmlPath]);

  if (loading) return <div style={{ ...style, background: '#e8e8e8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ fontSize: 10, color: '#bbb' }}>…</span></div>;
  if (!src) return <div style={{ ...style, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ fontSize: 10, color: '#ccc' }}>no thumb</span></div>;
  return <img src={src} alt="" style={style} />;
}

function LazyApiThumb({ id, base64thumb, mediaType, style }) {
  const [src, setSrc] = React.useState(
    base64thumb ? `data:${mediaType || 'image/jpeg'};base64,${base64thumb}` : null
  );
  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch('/api/thumb/' + encodeURIComponent(id))
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.data) setSrc(`data:${d.mediaType};base64,${d.data}`); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);
  if (!src) return <div style={{ ...style, background: '#f0f0f0' }} />;
  return <img src={src} alt="" style={style} />;
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

// ── Results Tab ───────────────────────────────────────────────────────────────
// Two sub-tabs: API (manually generated) | Agent (prompt_experiments/ runs)
// Within each: experiment → model → chapters → figure cards
function ResultsTab({ onOpen }) {
  const [activeTab, setActiveTab] = React.useState('api');
  const [apiRecords, setApiRecords] = React.useState([]);
  const [expTree, setExpTree] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  // selected = { experiment: string, model: string }
  const [selected, setSelected] = React.useState(null);
  const [evaluatingKey, setEvaluatingKey] = React.useState(null);
  const [evaluatingAll, setEvaluatingAll] = React.useState(null); // chapter being batch-evaluated
  const [baseScaffold, setBaseScaffold] = React.useState(null);
  const [openChapters, setOpenChapters] = React.useState(new Set());
  const [filterChapter, setFilterChapter] = React.useState('');
  const [filterFigure, setFilterFigure] = React.useState('');
  const [collapsedGroups, setCollapsedGroups] = React.useState(new Set());
  const [hoveredGroup, setHoveredGroup] = React.useState(null);
  const hoverTimerRef = React.useRef(null);
  const [serverPrompt, setServerPrompt] = React.useState('');

  // Fetch the real system prompt for the API tab display
  React.useEffect(() => {
    fetch('/api/prompt').then(r => r.json()).then(d => { if (d.prompt) setServerPrompt(d.prompt); }).catch(() => {});
  }, []);

  // Reset chapter/figure filters when selection or active tab changes
  React.useEffect(() => {
    setFilterChapter('');
    setFilterFigure('');
  }, [selected, activeTab]);

  React.useEffect(() => {
    fetch('/api/base-scaffold').then(r => r.json()).then(d => setBaseScaffold(d.content)).catch(() => {});
  }, []);

  React.useEffect(() => {
    Promise.all([
      fetch('/api/history').then(r => r.json()),
      fetch('/api/experiments').then(r => r.json()),
    ])
      .then(([api, exp]) => {
        // Normalize: strip trailing hash so prompt iterations merge into one experiment
        const stripHash = n => n.replace(/_[0-9a-f]{6,8}$/i, '');
        api.forEach(r => { r.experiment = stripHash(r.experiment || 'base_scene_robust'); });
        // Merge agent-tree entries sharing the same base experiment name
        const merged = {};
        for (const e of exp) {
          const base = stripHash(e.experiment);
          if (!merged[base]) merged[base] = { experiment: base, models: {} };
          for (const m of e.models) {
            if (!merged[base].models[m.model]) merged[base].models[m.model] = [];
            merged[base].models[m.model].push(...m.figures);
          }
        }
        setApiRecords(api);
        setExpTree(Object.values(merged).map(e => ({
          experiment: e.experiment,
          models: Object.entries(e.models).map(([model, figs]) => ({ model, figures: figs })),
        })));
        setLoading(false);
      })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  // Build API tree: { experiment → { model → records[] } }
  const apiTree = React.useMemo(() => {
    const tree = {};
    for (const r of apiRecords) {
      const exp = r.experiment || 'base_scene_robust';
      const model = r.model || 'gpt-4o';
      if (!tree[exp]) tree[exp] = {};
      if (!tree[exp][model]) tree[exp][model] = [];
      tree[exp][model].push(r);
    }
    return tree;
  }, [apiRecords]);

  // Items for current selection
  const selectedItems = React.useMemo(() => {
    if (!selected?.experiment) return [];
    let items;
    if (activeTab === 'api') {
      const expModels = apiTree[selected.experiment] || {};
      const modelKeys = selected.model ? [selected.model] : Object.keys(expModels);
      items = modelKeys.flatMap(modelName =>
        (expModels[modelName] || []).map(r => ({
          key: `api/${r.id}`, type: 'api', id: r.id,
          figure: r.filename ? r.filename.replace(/\.[^.]+$/, '') : r.id,
          chapter: r.chapter || 'other',
          base64thumb: r.base64thumb, mediaType: r.mediaType || 'image/png',
          timestamp: r.timestamp, evaluation: r.evaluation,
          experiment: selected.experiment, model: modelName,
          imagePath: null, htmlPath: null,
        }))
      );
    } else {
      const exp = expTree.find(e => e.experiment === selected.experiment);
      if (!exp) return [];
      const models = selected.model ? exp.models.filter(m => m.model === selected.model) : exp.models;
      items = [];
      for (const m of models) {
        for (const fig of m.figures) {
          items.push({
            key: `${exp.experiment}/${m.model}/${fig.name}`, type: 'experiment',
            figure: fig.name, chapter: fig.chapter || 'other',
            experiment: exp.experiment, model: m.model,
            imagePath: fig.imagePath, htmlPath: fig.htmlPath,
            timestamp: null, evaluation: fig.evaluation,
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
  }, [selected, activeTab, apiTree, expTree]);

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
        await fetch(`/api/result/${item.id}`, { method: 'DELETE' });
        setApiRecords(prev => prev.filter(r => r.id !== item.id));
      }
    } catch (err) { console.error('Delete failed:', err); }
  };

  const handleEvalCard = async (e, item) => {
    e.stopPropagation();
    setEvaluatingKey(item.key);
    try {
      let data;
      if (item.type === 'api') {
        const res = await fetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
        data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setApiRecords(prev => prev.map(r => r.id === item.id ? { ...r, evaluation: data } : r));
      } else {
        const res = await fetch('/api/experiments/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ htmlPath: item.htmlPath, imagePath: item.imagePath }) });
        data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const [expName, modelName, figName] = item.key.split('/');
        setExpTree(prev => prev.map(exp => exp.experiment !== expName ? exp : { ...exp,
          models: exp.models.map(m => m.model !== modelName ? m : { ...m,
            figures: m.figures.map(f => f.name !== figName ? f : { ...f, evaluation: data }) }) }));
      }
    } catch (err) { alert('Evaluation failed: ' + err.message); }
    finally { setEvaluatingKey(null); }
  };

  const handleEvalAll = async (e, chapter, items) => {
    e.stopPropagation();
    const pending = items.filter(item => !item.evaluation);
    if (!pending.length) return;
    setEvaluatingAll(chapter);
    for (const item of pending) {
      setEvaluatingKey(item.key);
      try {
        let data;
        if (item.type === 'api') {
          const res = await fetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
          data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setApiRecords(prev => prev.map(r => r.id === item.id ? { ...r, evaluation: data } : r));
        } else {
          const res = await fetch('/api/experiments/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ htmlPath: item.htmlPath, imagePath: item.imagePath }) });
          data = await res.json();
          if (!res.ok) throw new Error(data.error);
          const [expName, modelName, figName] = item.key.split('/');
          setExpTree(prev => prev.map(exp => exp.experiment !== expName ? exp : { ...exp,
            models: exp.models.map(m => m.model !== modelName ? m : { ...m,
              figures: m.figures.map(f => f.name !== figName ? f : { ...f, evaluation: data }) }) }));
        }
      } catch {}
    }
    setEvaluatingAll(null);
    setEvaluatingKey(null);
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
    } else {
      if (activeTab === 'api') {
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
    }
  }, [activeTab, apiTree, expTree, selected]);

  if (loading) return <div style={styles.empty}>Loading results…</div>;
  if (error) return <div style={styles.empty}>{error}</div>;

  const selKey = selected ? `${selected.experiment}::${selected.model ?? ''}` : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* API / Agent sub-tabs */}
      <div style={styles.subTabBar}>
        {[['api', 'Agent'], ['agent', 'Copilot']].map(([key, label]) => (
          <button key={key}
            style={{ ...styles.subTabBtn, ...(activeTab === key ? styles.subTabBtnActive : {}) }}
            onClick={() => { setActiveTab(key); setSelected(null); }}
          >
            {label}
            {key === 'api' && apiRecords.length > 0 &&
              <span style={styles.subTabCount}>{apiRecords.filter(r=>r.evaluation).length}/{apiRecords.length}</span>}
            {key === 'agent' && expTree.length > 0 && (() => {
              const total = expTree.reduce((s,e)=>s+e.models.reduce((ms,m)=>ms+m.figures.length,0),0);
              const evaled = expTree.reduce((s,e)=>s+e.models.reduce((ms,m)=>ms+m.figures.filter(f=>f.evaluation).length,0),0);
              return <span style={styles.subTabCount}>{evaled}/{total}</span>;
            })()}
          </button>
        ))}
      </div>

      {/* Filter nav bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#f4f5f9', borderBottom: '1px solid #e0e2eb', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.07em', marginRight: 4 }}>Filter</span>
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
        {selected && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#aaa' }}>
            {Object.values(filteredByChapter).reduce((s, a) => s + a.length, 0)} figure{Object.values(filteredByChapter).reduce((s, a) => s + a.length, 0) !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Tree + figures panel */}
      <div style={{ ...styles.expWrap, flex: 1, borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
        {/* Left tree */}
        <div style={styles.expTree}>
          {(() => {
            const entries = activeTab === 'api'
              ? Object.entries(apiTree).map(([expName, models]) => ({
                  group: expName,
                  items: Object.entries(models).map(([modelName, recs]) => ({
                    modelName, evalCount: recs.filter(r => r.evaluation).length, total: recs.length,
                    nodeKey: `${expName}::${modelName}`,
                    onSelect: () => setSelected({ experiment: expName, model: modelName }),
                  })),
                }))
              : expTree.map(exp => ({
                  group: exp.experiment,
                  items: exp.models.map(m => ({
                    modelName: m.model, evalCount: m.figures.filter(f => f.evaluation).length, total: m.figures.length,
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
                    <span style={{ fontSize: 9, color: '#aaa', fontWeight: 400, marginLeft: 'auto' }}>{items.length}</span>
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
          })()}
        </div>

        {/* Right: prompt + chapter-grouped figure cards */}
        <div style={styles.expContent}>
          {!selected ? (
            <div style={styles.empty}>Select a model or experiment using the filter bar above</div>
          ) : !Object.keys(filteredByChapter).length ? (
            <div style={styles.empty}>{filterFigure ? `No figures matching "${filterFigure}"` : 'No figures found'}</div>
          ) : (
            <>
              {/* Breadcrumb */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 12, fontSize: 12, color: '#888' }}>
                <span
                  style={{ cursor: 'pointer', color: '#5878a0', fontWeight: 600 }}
                  onClick={() => setSelected(null)}
                >{activeTab === 'api' ? 'Agent' : 'Copilot'}</span>
                <span style={{ color: '#ccc' }}>›</span>
                <span style={{ fontWeight: 600, color: '#5878a0', cursor: 'pointer' }}
                  onClick={() => setSelected(s => ({ ...s, _reset: true }))}>
                  {selected.experiment}
                </span>
                <span style={{ color: '#ccc' }}>›</span>
                <span style={{ color: '#333', fontWeight: 600 }}>{selected.model || 'All models'}</span>
              </div>
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
              {Object.entries(filteredByChapter).map(([chapter, items]) => {
                const isOpen = openChapters.has(chapter);
                return (
                <details key={chapter} style={{ marginBottom: 16 }} open={isOpen}
                  onToggle={e => {
                    const open = e.currentTarget.open;
                    setOpenChapters(prev => { const s = new Set(prev); open ? s.add(chapter) : s.delete(chapter); return s; });
                  }}
                >
                  <summary style={{ ...styles.resultChapterHeader, cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}>
                    <span style={{ fontSize: 9, color: '#bbb', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>{chapter}
                    <span style={{ fontWeight: 400, color: '#bbb', textTransform: 'none', letterSpacing: 0 }}>({items.length})</span>
                    {items.some(i => !i.evaluation) && (
                      <button
                        style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 8px', borderRadius: 4, border: '1px solid #d0d8e8', background: '#f2f6fb', color: '#5878a0', cursor: 'pointer', fontWeight: 600 }}
                        onClick={e => handleEvalAll(e, chapter, items)}
                        disabled={evaluatingAll === chapter}
                      >
                        {evaluatingAll === chapter
                          ? `Evaluating… (${items.filter(i => i.evaluation).length}/${items.length})`
                          : `Evaluate all (${items.filter(i => !i.evaluation).length} pending)`}
                      </button>
                    )}
                  </summary>
                  <div style={{ ...styles.historyGrid, marginTop: 10 }}>
                    {items.map(item => {
                      const ev = item.evaluation;
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
                            {!selected.model && <p style={{ fontSize: 10, color: '#999', margin: '0 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.model}</p>}
                            {item.timestamp && <p style={{ ...styles.cardTs, marginBottom: 3 }}>{new Date(item.timestamp).toLocaleDateString()}</p>}
                            {ev ? (
                              <>
                                <span style={{ ...styles.sourceBadge, background: ev.overall_average >= 4 ? '#e8f5e9' : ev.overall_average >= 3 ? '#fff3e0' : '#ffebee', color: sc(ev.overall_average) }}>{ev.overall_average}/5</span>
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
              })}
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
  geometry_accuracy:       'Geom',
  interactivity_usability: 'Inter',
  faithfulness:            'Faith',
  label_quality:           'Labels',
  concept_accuracy:        'Concept',
  visual_aesthetics:       'Aesth',
};

// Continuous heatmap: dark red (0) → red (1) → orange (2) → yellow (3) → light green (4) → green (5)
const COLOR_STOPS = [
  [0,   [150,  10,  10]],
  [1,   [220,  50,  50]],
  [2,   [240, 130,  40]],
  [3,   [255, 235,  80]],
  [4,   [180, 215, 130]],
  [5,   [ 80, 170,  90]],
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
  return `rgb(${Math.round(rgb[0]*0.55)},${Math.round(rgb[1]*0.55)},${Math.round(rgb[2]*0.45)})`;
}

function modelFamily(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('claude')) return 'Claude';
  if (n.includes('gemini')) return 'Gemini';
  if (n.includes('gpt') || n.includes('codex')) return 'GPT';
  return 'Other';
}
const FAMILY_COLOR = { Claude: '#ede7f6', Gemini: '#e3f2fd', GPT: '#e8f5e9', Other: '#f0f0f0' };
const FAMILY_TEXT  = { Claude: '#5e35b1', Gemini: '#1565c0', GPT: '#2e7d32', Other: '#555' };

function computeStats(records, groupKey) {
  const byGroup = {};
  for (const r of records) {
    const key = r[groupKey];
    if (!byGroup[key]) byGroup[key] = { evals: [], total: 0, key };
    byGroup[key].total++;
    if (r.evaluation) byGroup[key].evals.push(r.evaluation);
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
    <td style={{ textAlign: 'center', padding: '7px 6px', background: scoreBg(val),
      color: scoreFg(val), fontWeight: 600, fontSize: 12 }}>
      {val !== null ? val.toFixed(1) : <span style={{ color: '#ddd' }}>—</span>}
    </td>
  );

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: '#f5f5f5' }}>
          <th style={{ textAlign: 'left', padding: '7px 12px', fontSize: 11, fontWeight: 700, color: '#555',
            borderBottom: '1px solid #e0e0e0' }}>
            {groupKey === 'model' ? 'Model' : 'Experiment'}
          </th>
          <th style={{ textAlign: 'center', padding: '7px 6px', fontSize: 11, fontWeight: 700,
            color: '#555', borderBottom: '1px solid #e0e0e0', width: 28 }}>N</th>
          <th style={{ textAlign: 'center', padding: '7px 8px', fontSize: 11, fontWeight: 700,
            color: '#333', borderBottom: '1px solid #e0e0e0', background: '#ececec', width: 60,
            borderLeft: '2px solid #999', borderRight: '2px solid #999' }}>Overall</th>
          {DASH_METRICS.map(k => (
            <th key={k} style={{ textAlign: 'center', padding: '7px 6px', fontSize: 10, fontWeight: 700,
              color: '#777', borderBottom: '1px solid #e0e0e0', width: 48 }}>
              {DASH_METRIC_SHORT[k]}
            </th>
          ))}
          <th style={{ textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 700,
            color: '#777', borderBottom: '1px solid #e0e0e0' }}>Top Failures</th>
        </tr>
      </thead>
      <tbody>
        {stats.map(({ key, family, evaluated, metricAvgs, overall, failureModes }) => (
          <tr key={key} style={{ borderBottom: '1px solid #f2f2f2' }}>
            <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
              {family && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 5,
                  background: FAMILY_COLOR[family], color: FAMILY_TEXT[family], marginRight: 7 }}>
                  {family}
                </span>
              )}
              <span style={{ color: '#222', fontWeight: 500 }}>{key}</span>
            </td>
            <td style={{ textAlign: 'center', color: '#bbb', fontSize: 11, padding: '7px 6px' }}>{evaluated}</td>
            <td style={{ textAlign: 'center', padding: '7px 8px', background: scoreBg(overall),
              color: scoreFg(overall), fontWeight: 800, fontSize: 14,
              borderLeft: '2px solid #bbb', borderRight: '2px solid #bbb' }}>
              {overall !== null ? overall.toFixed(1) : '—'}
            </td>
            {DASH_METRICS.map(k => <NUM key={k} val={metricAvgs[k]} />)}
            <td style={{ padding: '7px 10px', maxWidth: 240 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {failureModes.slice(0, 3).map(([fm]) => (
                  <span key={fm} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3,
                    background: failureModeColor(fm).bg, color: failureModeColor(fm).fg,
                    border: `1px solid ${failureModeColor(fm).border}`, fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {fm}
                  </span>
                ))}
                {failureModes.length > 3 && (
                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3,
                    background: '#f5f5f5', color: '#aaa', border: '1px solid #e8e8e8', whiteSpace: 'nowrap' }}>
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

function SourceSection({ title, color, records, groupKey }) {
  const stats = React.useMemo(() => computeStats(records, groupKey), [records, groupKey]);
  const n = records.filter(r => r.evaluation).length;
  if (!stats.length) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
          background: color === 'agent' ? '#e8f0fe' : '#f3e8ff',
          color: color === 'agent' ? '#1a56cc' : '#7c3aed' }}>
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

function DashboardTab() {
  const [apiRecords, setApiRecords] = React.useState([]);
  const [expTree, setExpTree]       = React.useState([]);
  const [loading, setLoading]       = React.useState(true);
  const [view, setView]             = React.useState('models');

  React.useEffect(() => {
    Promise.all([
      fetch('/api/history').then(r => r.json()),
      fetch('/api/experiments').then(r => r.json()),
    ])
      .then(([api, exp]) => { setApiRecords(api); setExpTree(exp); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const { agentRecords, copilotRecords } = React.useMemo(() => {
    const agent = apiRecords.map(r => ({
      source: 'agent', experiment: r.experiment || 'base_scene_robust',
      model: r.model || 'gpt-4o', evaluation: r.evaluation || null,
    }));
    const copilot = [];
    for (const exp of expTree)
      for (const m of exp.models)
        for (const fig of m.figures)
          copilot.push({ source: 'copilot', experiment: exp.experiment, model: m.model, evaluation: fig.evaluation || null });
    return { agentRecords: agent, copilotRecords: copilot };
  }, [apiRecords, expTree]);

  const totalEval = [...agentRecords, ...copilotRecords].filter(r => r.evaluation).length;

  if (loading) return <div style={styles.empty}>Loading…</div>;
  if (totalEval === 0)
    return <div style={styles.empty}>No evaluated figures yet — run evaluations in the Results tab first.</div>;

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

      <SourceSection title="Agent" color="agent" records={agentRecords} groupKey={groupKey} />
      <SourceSection title="Copilot" color="copilot" records={copilotRecords} groupKey={groupKey} />
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
  viewerWrap: { display: 'flex', gap: 0, height: 'calc(100vh - 120px)', borderRadius: 10, overflow: 'hidden', border: '1px solid #e0e0e0' },
  viewerLeft: { width: 200, minWidth: 200, background: '#fafafa', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, borderRight: '1px solid #e0e0e0', overflowY: 'auto' },
  thumbImg: { width: '100%', borderRadius: 6, objectFit: 'contain', maxHeight: 150, background: '#fff', border: '1px solid #eee' },
  viewerFilename: { fontSize: 11, color: '#666', margin: 0, wordBreak: 'break-all' },
  viewerTs: { fontSize: 10, color: '#aaa', margin: 0 },
  downloadBtn: { display: 'block', padding: '7px 0', textAlign: 'center', background: '#fff', color: '#333', borderRadius: 6, textDecoration: 'none', fontSize: 12, border: '1px solid #ddd' },
  newBtn: { padding: '7px 0', background: '#fff', border: '1px solid #ddd', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  deleteBtn: { padding: '7px 0', background: '#fff', border: '1px solid #fbb', color: '#c00', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginTop: 'auto' },
  viewerRight: { flex: 1, background: '#fff' },
  iframe: { width: '100%', height: '100%', border: 'none' },

  // History
  historyGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14 },
  card: { background: '#f0f0f0', border: 'none', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', transition: 'background .15s' },
  cardThumb: { width: '100%', height: 130, objectFit: 'cover' },
  cardInfo: { padding: '8px 10px' },
  cardFilename: { fontSize: 12, fontWeight: 600, margin: '0 0 3px', color: '#222', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
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
  evalNotes: { fontSize: 10, color: '#888', margin: '2px 0 0', lineHeight: 1.45 },
  evalBtn: { padding: '6px 0', background: '#fff', border: '1px solid #ddd', color: '#333', borderRadius: 6, cursor: 'pointer', fontSize: 11 },

  // Results tab
  resultFilterBar: { display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 16, borderBottom: '1px solid #e0e0e0', marginBottom: 20 },
  resultFilterGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  resultFilterLabel: { fontSize: 12, color: '#666' },
  resultFilterSelect: { fontSize: 12, border: '1px solid #ddd', borderRadius: 5, padding: '4px 8px', background: '#fff', color: '#333', cursor: 'pointer' },
  resultChapterHeader: { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #f0f0f0' },

  // Experiments tab (legacy)
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

  // Mode toggle
  modeBtn: { padding: '6px 16px', borderRadius: 6, border: '1px solid #ddd', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 13, fontWeight: 500 },
  modeBtnActive: { background: '#111', borderColor: '#111', color: '#fff' },

  // Chapter mode
  chapterMode: { width: '100%' },
  chapterLabel: { fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 6, display: 'block' },
  chapterSelect: { width: '100%', fontSize: 13, border: '1px solid #ddd', borderRadius: 6, padding: '8px 12px', background: '#fff', color: '#333', cursor: 'pointer' },
  candidateGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 12 },
  candidateCard: { border: '1px solid #e0e0e0', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: '#fff', transition: 'box-shadow .15s' },
  candidateThumb: { width: '100%', height: 80, objectFit: 'contain', background: '#fafafa' },
  candidateName: { fontSize: 10, color: '#555', padding: '4px 6px', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  chapterPlansWrap: { marginTop: 14, padding: '12px 14px', background: '#f8faff', border: '1px solid #d0ddf0', borderRadius: 8 },
  chapterPlanItem: { marginBottom: 4, borderBottom: '1px solid #e8ecf4' },
  chapterPlanSummary: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#333' },
};
