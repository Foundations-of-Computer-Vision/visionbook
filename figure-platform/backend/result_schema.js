const LEGACY_EVAL_KEYS = ['evaluation', 'evaluationModel', 'evaluatedAt', 'eval_model'];

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEvaluationMaps(record) {
    const next = isPlainObject(record) ? { ...record } : {};
    next.evaluationResults = isPlainObject(next.evaluationResults) ? { ...next.evaluationResults } : {};
    next.evaluationMeta = isPlainObject(next.evaluationMeta) ? { ...next.evaluationMeta } : {};
    return next;
}

function upsertEvaluation(record, evalModel, evaluation, evaluatedAt = new Date().toISOString()) {
    if (!evalModel) throw new Error('evalModel is required.');
    if (!evaluation || typeof evaluation !== 'object') throw new Error('evaluation is required.');

    const normalized = normalizeEvaluationMaps(record);

    // Enforce the model-keyed schema so server/CLI writes stay consistent.
    for (const key of LEGACY_EVAL_KEYS) delete normalized[key];

    normalized.evaluationResults[evalModel] = evaluation;
    normalized.evaluationMeta[evalModel] = { evaluatedAt };

    return normalized;
}

module.exports = {
    normalizeEvaluationMaps,
    upsertEvaluation,
};
