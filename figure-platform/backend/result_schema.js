function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resolveCriticVersion(record, extraMeta) {
    if (typeof extraMeta?.criticVersion === 'string' && extraMeta.criticVersion.trim()) {
        return extraMeta.criticVersion.trim();
    }

    return 'legacy_unknown';
}

function normalizeEvaluationMaps(record) {
    const next = isPlainObject(record) ? { ...record } : {};
    next.evaluationResults = isPlainObject(next.evaluationResults) ? { ...next.evaluationResults } : {};
    next.evaluationMeta = isPlainObject(next.evaluationMeta) ? { ...next.evaluationMeta } : {};
    next.evaluationVersions = isPlainObject(next.evaluationVersions) ? { ...next.evaluationVersions } : {};
    return next;
}

function toMillis(iso) {
    if (!iso) return 0;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : 0;
}

function materializeEvaluationViews(record) {
    const normalized = normalizeEvaluationMaps(record);

    const mergedResults = {};
    const mergedMeta = {};

    // Versioned data is canonical when present. Merge by most recent evaluatedAt per model.
    for (const [versionKey, bucket] of Object.entries(normalized.evaluationVersions)) {
        if (!isPlainObject(bucket)) continue;
        const bucketResults = isPlainObject(bucket.evaluationResults) ? bucket.evaluationResults : {};
        const bucketMeta = isPlainObject(bucket.evaluationMeta) ? bucket.evaluationMeta : {};

        for (const [modelId, evaluation] of Object.entries(bucketResults)) {
            if (!isPlainObject(evaluation)) continue;
            const candidateMeta = isPlainObject(bucketMeta[modelId]) ? { ...bucketMeta[modelId] } : {};
            if (!candidateMeta.criticVersion) {
                candidateMeta.criticVersion = bucket.criticVersion || versionKey || 'legacy_unknown';
            }
            const currentMeta = mergedMeta[modelId] || {};
            if (!mergedResults[modelId] || toMillis(candidateMeta.evaluatedAt) >= toMillis(currentMeta.evaluatedAt)) {
                mergedResults[modelId] = evaluation;
                mergedMeta[modelId] = candidateMeta;
            }
        }
    }

    normalized.evaluationResults = mergedResults;
    normalized.evaluationMeta = mergedMeta;
    return normalized;
}

function compactEvaluationStorage(record) {
    const normalized = materializeEvaluationViews(record);
    const compacted = { ...normalized };
    delete compacted.evaluationResults;
    delete compacted.evaluationMeta;
    return compacted;
}

function upsertEvaluation(record, evalModel, evaluation, evaluatedAt = new Date().toISOString(), extraMeta = {}) {
    if (!evalModel) throw new Error('evalModel is required.');
    if (!evaluation || typeof evaluation !== 'object') throw new Error('evaluation is required.');

    const normalized = materializeEvaluationViews(record);
    const criticVersion = resolveCriticVersion(normalized, extraMeta);
    const metaEntry = {
        evaluatedAt,
        criticVersion,
    };

    if (extraMeta.criticModel) metaEntry.criticModel = extraMeta.criticModel;
    if (extraMeta.criticPromptLabel) metaEntry.criticPromptLabel = extraMeta.criticPromptLabel;

    normalized.evaluationResults[evalModel] = evaluation;
    normalized.evaluationMeta[evalModel] = metaEntry;

    const versionBucket = isPlainObject(normalized.evaluationVersions[criticVersion])
        ? { ...normalized.evaluationVersions[criticVersion] }
        : { criticVersion, evaluationResults: {}, evaluationMeta: {} };
    versionBucket.criticVersion = criticVersion;
    versionBucket.evaluationResults = isPlainObject(versionBucket.evaluationResults) ? { ...versionBucket.evaluationResults } : {};
    versionBucket.evaluationMeta = isPlainObject(versionBucket.evaluationMeta) ? { ...versionBucket.evaluationMeta } : {};
    if (extraMeta.criticModel) versionBucket.criticModel = extraMeta.criticModel;
    if (extraMeta.criticPromptLabel) versionBucket.criticPromptLabel = extraMeta.criticPromptLabel;
    versionBucket.evaluationResults[evalModel] = evaluation;
    versionBucket.evaluationMeta[evalModel] = metaEntry;
    normalized.evaluationVersions[criticVersion] = versionBucket;

    return normalized;
}

/**
 * Normalize attempts array: ensure it's a valid array of attempt objects
 * @param {object} record - result record
 * @returns {object} - record with normalized attempts
 */
function normalizeAttempts(record) {
    const next = isPlainObject(record) ? { ...record } : {};
    // Convert attempts to array if missing or invalid
    if (!Array.isArray(next.attempts)) {
        next.attempts = [];
    } else {
        // Validate each attempt has required fields
        next.attempts = next.attempts.map(a =>
            isPlainObject(a) ? a : {}
        );
    }
    return next;
}

/**
 * Add or update loop attempts in a result record
 * Preserves all other fields; idempotent
 * @param {object} record - existing result record
 * @param {array} attempts - loop attempts from runFigureLoop
 * @returns {object} - updated record with attempts
 */
function upsertAttempts(record, attempts) {
    const normalized = normalizeAttempts(record);
    if (Array.isArray(attempts)) {
        normalized.attempts = attempts;
    }
    return normalized;
}

module.exports = {
    normalizeEvaluationMaps,
    materializeEvaluationViews,
    compactEvaluationStorage,
    upsertEvaluation,
    normalizeAttempts,
    upsertAttempts,
};
