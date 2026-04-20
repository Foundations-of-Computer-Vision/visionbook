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

async function evaluateRecord({ record, evalModel, defaultEvalModel, criticVersionOverride }) {
  if (!record?.html) throw new Error('No HTML found for evaluation.');

  const usedEvalModel = evalModel || defaultEvalModel;
  if (!usedEvalModel) throw new Error('No evaluation model configured.');
  const criticContext = getCriticContext();

  const evalImage = record.source_base64 || record.base64thumb;
  const evalMediaType = record.source_media_type || record.mediaType || 'image/png';

  const evaluation = await evaluateHtmlWithCritic({
    html: record.html,
    evalImage,
    evalMediaType,
    model: usedEvalModel,
  });

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
