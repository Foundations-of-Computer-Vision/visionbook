import React, { useState, useCallback } from 'react';

const SYSTEM_PROMPT = `Convert this 2D textbook figure into an interactive 3D visualization that clearly teaches the concept shown.
Return ONLY a single self-contained HTML file that runs in a modern browser and uses Three.js (ES modules) with OrbitControls.

Core requirements:
1. Faithful 3D Geometry
- Recreate the key geometric elements in 3D (not a textured copy of the image).
- Preserve the relationships implied by the figure (e.g., intersections, parallelism, coplanarity, alignment, proportions).
- Match the relative sizes, orientations, and colors as closely as reasonably possible.

2. Educational Interactivity
- Add 2-6 meaningful interactive elements (buttons, toggles, step-through controls, draggable handles, or animation).
- The interaction must demonstrate the main conceptual idea of the figure.
- Include a Reset to textbook view control.
- Include a short guided demo or step-through sequence that illustrates the concept.

3. Concept Clarity
- Add labels corresponding to the original figure.
- Include brief code comments explaining:
  * how each 2D element maps to a 3D object
  * what each interaction is meant to teach

Prefer geometric clarity and conceptual correctness over visual realism.
Output only the complete HTML file without truncation. No markdown, no code fences, no explanation. Start directly with <!DOCTYPE html>`;

export default function App() {
  const [tab, setTab] = useState('generator');
  const [image, setImage] = useState(null); // { base64, mediaType, filename, previewUrl }
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [currentRecord, setCurrentRecord] = useState(null); // full record from history
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Called by Uploader when a file is selected
  const handleImageSelected = useCallback((imgData) => {
    setImage(imgData);
    setError('');
  }, []);

  // Called by Uploader's Generate button
  const handleGenerate = useCallback(async () => {
    if (!image) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64: image.base64,
          mediaType: image.mediaType,
          filename: image.filename,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed.');
      setGeneratedHtml(data.html);
      setCurrentRecord({
        html: data.html,
        filename: image.filename,
        base64thumb: image.base64,
        mediaType: image.mediaType,
        timestamp: data.timestamp,
      });
      setTab('viewer');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [image]);

  // Called from History when a card is clicked
  const handleLoadFromHistory = useCallback((record) => {
    setCurrentRecord(record);
    setGeneratedHtml(record.html);
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
    setTab('generator');
  }, [currentRecord, handleDelete]);

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.logo}>🔮 3D Figure Generator</span>
        <nav style={styles.nav}>
          {['generator', 'viewer', 'history'].map((t) => (
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
            error={error}
            systemPrompt={SYSTEM_PROMPT}
          />
        )}
        {tab === 'viewer' && (
          <ViewerTab
            record={currentRecord}
            html={generatedHtml}
            onNew={() => setTab('generator')}
            onDelete={handleDeleteCurrent}
          />
        )}
        {tab === 'history' && (
          <HistoryTab onLoad={handleLoadFromHistory} onDelete={handleDelete} />
        )}
      </main>
    </div>
  );
}

// ── Generator Tab ─────────────────────────────────────────────────────────────
function GeneratorTab({ image, onImageSelected, onGenerate, loading, error, systemPrompt }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

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

  return (
    <div style={styles.genWrap}>
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
            <span style={{ fontSize: 48 }}>📂</span>
            <p>Drag & drop a PNG/JPG here, or click to select</p>
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

      {/* Collapsible system prompt */}
      <div style={styles.promptSection}>
        <button style={styles.promptToggle} onClick={() => setPromptOpen((v) => !v)}>
          {promptOpen ? '▾' : '▸'} System Prompt (read-only)
        </button>
        {promptOpen && (
          <pre style={styles.promptBox}>{systemPrompt}</pre>
        )}
      </div>

      {error && <p style={styles.errorMsg}>⚠ {error}</p>}

      <button
        style={{ ...styles.generateBtn, ...(loading || !image ? styles.generateBtnDisabled : {}) }}
        onClick={onGenerate}
        disabled={loading || !image}
      >
        {loading ? '⏳ Generating — this may take 30-60s…' : '✨ Generate 3D Figure'}
      </button>
    </div>
  );
}

// ── Viewer Tab ────────────────────────────────────────────────────────────────
function ViewerTab({ record, html, onNew, onDelete }) {
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
          <span style={{ ...styles.sourceBadge, ...(record.source === 'chat' ? styles.sourceBadgeChat : styles.sourceBadgeApi) }}>
            {record.source === 'chat' ? '💬 Chat' : '🤖 API'}
          </span>
        )}
        <a href={downloadUrl} download={`figure_${Date.now()}.html`} style={styles.downloadBtn}>
          ⬇ Download HTML
        </a>
        <button style={styles.newBtn} onClick={onNew}>
          ＋ New Figure
        </button>
        {record?.id && (
          <button
            style={styles.deleteBtn}
            onClick={() => { if (window.confirm('Delete this figure?')) onDelete(); }}
          >
            🗑 Delete
          </button>
        )}
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

// ── History Tab ───────────────────────────────────────────────────────────────
function HistoryTab({ onLoad, onDelete }) {
  const [records, setRecords] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    fetch('/api/history')
      .then((r) => r.json())
      .then((data) => { setRecords(data); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, []);

  const handleCardClick = async (id) => {
    try {
      const res = await fetch(`/api/result/${id}`);
      const record = await res.json();
      onLoad(record);
    } catch (err) {
      alert('Failed to load result: ' + err.message);
    }
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation(); // prevent card click / load
    if (!window.confirm('Delete this figure?')) return;
    await onDelete(id);
    setRecords((prev) => prev.filter((r) => r.id !== id));
  };

  if (loading) return <div style={styles.empty}>Loading history…</div>;
  if (error) return <div style={styles.empty}>⚠ {error}</div>;
  if (!records.length) return <div style={styles.empty}>No figures generated yet.</div>;

  return (
    <div style={styles.historyGrid}>
      {records.map((r) => (
        <div key={r.id} style={styles.card} onClick={() => handleCardClick(r.id)}>
          <div style={{ position: 'relative' }}>
            <img
              src={`data:image/png;base64,${r.base64thumb}`}
              alt={r.filename}
              style={styles.cardThumb}
            />
            <button
              style={styles.cardDeleteBtn}
              onClick={(e) => handleDelete(e, r.id)}
              title="Delete"
            >
              ✕
            </button>
          </div>
          <div style={styles.cardInfo}>
            <p style={styles.cardFilename}>{r.filename}</p>
            <p style={styles.cardTs}>{new Date(r.timestamp).toLocaleString()}</p>
            <span style={{ ...styles.sourceBadge, ...(r.source === 'chat' ? styles.sourceBadgeChat : styles.sourceBadgeApi) }}>
              {r.source === 'chat' ? '💬 Chat' : '🤖 API'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  root: { fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#0f1117', color: '#e8eaf6' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 28px', background: '#1a1d2e', borderBottom: '1px solid #2e3250' },
  logo: { fontSize: 20, fontWeight: 700, letterSpacing: 0.5 },
  nav: { display: 'flex', gap: 8 },
  navBtn: { padding: '7px 18px', borderRadius: 8, border: '1px solid #2e3250', background: 'transparent', color: '#9fa8da', cursor: 'pointer', fontSize: 14, fontWeight: 500 },
  navBtnActive: { background: '#3949ab', borderColor: '#3949ab', color: '#fff' },
  main: { padding: '32px 28px', maxWidth: 1200, margin: '0 auto' },

  // Generator
  genWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, maxWidth: 680, margin: '0 auto' },
  dropZone: { width: '100%', minHeight: 280, border: '2px dashed #3949ab', borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: '#12152a', transition: 'border-color .2s, background .2s', overflow: 'hidden' },
  dropZoneActive: { borderColor: '#7986cb', background: '#1a1f3a' },
  dropHint: { textAlign: 'center', color: '#5c6bc0', userSelect: 'none' },
  preview: { maxWidth: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 12 },
  filename: { fontSize: 13, color: '#7986cb', margin: 0 },
  promptSection: { width: '100%' },
  promptToggle: { background: 'none', border: '1px solid #2e3250', color: '#9fa8da', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13 },
  promptBox: { marginTop: 8, padding: 16, background: '#12152a', borderRadius: 10, border: '1px solid #2e3250', fontSize: 12, color: '#7986cb', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' },
  errorMsg: { color: '#ef9a9a', fontSize: 14, margin: 0 },
  generateBtn: { padding: '14px 36px', fontSize: 15, fontWeight: 600, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#3949ab,#5c6bc0)', color: '#fff', cursor: 'pointer', width: '100%', transition: 'opacity .2s' },
  generateBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },

  // Viewer
  viewerWrap: { display: 'flex', gap: 0, height: 'calc(100vh - 140px)', borderRadius: 14, overflow: 'hidden', border: '1px solid #2e3250' },
  viewerLeft: { width: 220, minWidth: 220, background: '#1a1d2e', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, borderRight: '1px solid #2e3250' },
  thumbImg: { width: '100%', borderRadius: 8, objectFit: 'contain', maxHeight: 160, background: '#0f1117' },
  viewerFilename: { fontSize: 12, color: '#7986cb', margin: 0, wordBreak: 'break-all' },
  viewerTs: { fontSize: 11, color: '#455a8a', margin: 0 },
  downloadBtn: { display: 'block', padding: '9px 0', textAlign: 'center', background: '#283593', color: '#c5cae9', borderRadius: 8, textDecoration: 'none', fontSize: 13, fontWeight: 500 },
  newBtn: { padding: '9px 0', background: 'transparent', border: '1px solid #2e3250', color: '#9fa8da', borderRadius: 8, cursor: 'pointer', fontSize: 13 },
  deleteBtn: { padding: '9px 0', background: 'transparent', border: '1px solid #4a1f1f', color: '#ef9a9a', borderRadius: 8, cursor: 'pointer', fontSize: 13, marginTop: 'auto' },
  viewerRight: { flex: 1, background: '#fff' },
  iframe: { width: '100%', height: '100%', border: 'none' },

  // History
  historyGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 18 },
  card: { background: '#1a1d2e', border: '1px solid #2e3250', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', transition: 'border-color .2s, transform .15s' },
  cardThumb: { width: '100%', height: 140, objectFit: 'cover' },
  cardInfo: { padding: '10px 12px' },
  cardFilename: { fontSize: 13, fontWeight: 600, margin: '0 0 4px', color: '#c5cae9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardTs: { fontSize: 11, color: '#5c6bc0', margin: 0 },
  cardDeleteBtn: { position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 },

  empty: { textAlign: 'center', color: '#5c6bc0', marginTop: 80, fontSize: 16 },
  sourceBadge: { display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, letterSpacing: 0.3 },
  sourceBadgeApi: { background: '#1a237e', color: '#9fa8da' },
  sourceBadgeChat: { background: '#1b5e20', color: '#a5d6a7' },
};
