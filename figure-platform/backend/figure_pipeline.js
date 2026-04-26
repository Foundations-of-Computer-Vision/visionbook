const fs = require('fs');
const { evaluateHtmlWithCritic, getCriticContext } = require('./critic');
const { buildGenerationSystemPrompt } = require('./generation');
const { upsertEvaluation, compactEvaluationStorage } = require('./result_schema');

function buildExperimentContext(scaffold, experimentBase = 'base_scene_robust') {
  if (!scaffold) throw new Error('scaffold is required.');
  const systemPrompt = buildGenerationSystemPrompt(scaffold);
  const experiment = experimentBase;
  return { systemPrompt, experiment };
}

function buildPlanInjection(plan) {
  if (!plan) return '';
  const parts = [];
  if (plan.contextChunk) {
    parts.push(`CONTEXT FROM TEXTBOOK:\n${plan.contextChunk.slice(0, 3000)}`);
  }
  if (plan.interactionPlan) {
    parts.push(`INTERACTION PLAN:\n${JSON.stringify(plan.interactionPlan, null, 2)}`);
  }
  return parts.join('\n\n');
}

const CRITIC_SCORE_KEYS = [
  'geometry_accuracy',
  'interactivity_usability',
  'faithfulness',
  'label_quality',
  'concept_accuracy',
];

function clampCriticPasses(value) {
  if (value == null) return 1;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const rounded = Math.round(n);
  if (rounded < 0) return 0;
  if (rounded > 3) return 3;
  return rounded;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateEvaluations(evaluations) {
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    return null;
  }

  if (evaluations.length === 1) {
    return { ...evaluations[0] };
  }

  const aggregated = {};
  for (const key of CRITIC_SCORE_KEYS) {
    const values = evaluations
      .map(ev => Number(ev?.[key]))
      .filter(v => Number.isFinite(v));
    const score = values.length > 0 ? median(values) : 3;
    aggregated[key] = Math.min(5, Math.max(1, Math.round(score)));
  }

  const minVotes = Math.ceil(evaluations.length / 2);
  const counts = new Map();
  for (const ev of evaluations) {
    const modes = Array.isArray(ev?.failure_modes) ? ev.failure_modes : [];
    for (const mode of modes) {
      if (typeof mode !== 'string' || !mode.trim()) continue;
      counts.set(mode, (counts.get(mode) || 0) + 1);
    }
  }
  aggregated.failure_modes = [...counts.entries()]
    .filter(([, count]) => count >= minVotes)
    .map(([mode]) => mode)
    .sort();

  const notes = evaluations
    .map(ev => (typeof ev?.notes === 'string' ? ev.notes.trim() : ''))
    .filter(Boolean);
  aggregated.notes = `Aggregated from ${evaluations.length} critic passes.${notes.length ? ` ${notes[0]}` : ''}`;

  aggregated.visual_aesthetics = Math.round(
    ((aggregated.geometry_accuracy + aggregated.faithfulness + aggregated.label_quality) / 3) * 10
  ) / 10;
  aggregated.overall_average = Math.round(
    (CRITIC_SCORE_KEYS.reduce((sum, key) => sum + aggregated[key], 0) / CRITIC_SCORE_KEYS.length) * 10
  ) / 10;

  return aggregated;
}

function createResultRecord({
  id,
  filename,
  html,
  timestamp,
  source,
  model,
  experiment,
  plan = null,
  previewBase64,
  previewMediaType,
  fallbackBase64,
  fallbackMediaType,
  sourceBase64,
  sourceMediaType,
  extra = {},
}) {
  const record = {
    id,
    filename,
    base64thumb: previewBase64 || fallbackBase64 || null,
    mediaType: previewMediaType || fallbackMediaType || 'image/png',
    html,
    timestamp,
    source,
    model,
    experiment,
    plan,
    ...extra,
  };

  if (sourceBase64) record.source_base64 = sourceBase64;
  if (sourceMediaType) record.source_media_type = sourceMediaType;

  return record;
}

async function evaluateRecord({ record, evalModel, defaultEvalModel, criticVersionOverride, criticPasses }) {
  if (!record?.html) throw new Error('No HTML found for evaluation.');

  const usedEvalModel = evalModel || defaultEvalModel;
  if (!usedEvalModel) throw new Error('No evaluation model configured.');
  const criticContext = getCriticContext();
  const resolvedCriticPasses = clampCriticPasses(criticPasses);

  if (resolvedCriticPasses === 0) {
    return {
      evaluation: null,
      evaluations: [],
      passCount: 0,
      skipped: true,
      evalModel: usedEvalModel,
      evaluatedAt: null,
      criticVersion:
        (typeof criticVersionOverride === 'string' && criticVersionOverride.trim())
          ? criticVersionOverride.trim()
          : criticContext.criticVersion,
      record,
    };
  }

  const evalImage = record.source_base64 || record.base64thumb;
  const evalMediaType = record.source_media_type || record.mediaType || 'image/png';

  const evaluations = [];
  for (let i = 0; i < resolvedCriticPasses; i++) {
    const evaluationPass = await evaluateHtmlWithCritic({
      html: record.html,
      evalImage,
      evalMediaType,
      model: usedEvalModel,
    });
    evaluations.push(evaluationPass);
  }

  const evaluation = aggregateEvaluations(evaluations);

  const evaluatedAt = new Date().toISOString();
  const resolvedCriticVersion =
    (typeof criticVersionOverride === 'string' && criticVersionOverride.trim())
      ? criticVersionOverride.trim()
      : criticContext.criticVersion;
  const updatedRecord = upsertEvaluation(record, usedEvalModel, evaluation, evaluatedAt, {
    criticVersion: resolvedCriticVersion,
    criticModel: usedEvalModel,
  });

  return {
    evaluation,
    evaluations,
    passCount: resolvedCriticPasses,
    skipped: false,
    evalModel: usedEvalModel,
    evaluatedAt,
    criticVersion: resolvedCriticVersion,
    record: updatedRecord,
  };
}

function saveRecord(record, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(compactEvaluationStorage(record), null, 2));
}

module.exports = {
  buildExperimentContext,
  buildPlanInjection,
  createResultRecord,
  evaluateRecord,
  saveRecord,
};
