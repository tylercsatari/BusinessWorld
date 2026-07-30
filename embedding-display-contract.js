'use strict';

const SAVED_HOOK_INDEX_VERSION = 2;
const SHORTS_DISPLAY_PREFERENCE = Object.freeze(['together', 'text', 'visual']);
const LONGQUANT_DISPLAY_PREFERENCE = Object.freeze(['visual', 'together', 'text']);
const SAVED_HOOK_METRICS = Object.freeze(['keep', 'ret5', 'views', 'realviews', 'gt10M', 'outlier']);

function embeddingDisplayPreference(record, fallbackDomain) {
    const manifest = record && record.input_manifest && typeof record.input_manifest === 'object'
        ? record.input_manifest
        : {};
    const requested = Array.isArray(manifest.display_preference) ? manifest.display_preference : [];
    const domain = String(manifest.domain || fallbackDomain || 'shorts_raw').toLowerCase();
    const defaults = domain.includes('longquant') ? LONGQUANT_DISPLAY_PREFERENCE : SHORTS_DISPLAY_PREFERENCE;
    const valid = [];
    for (const channel of requested.concat(defaults)) {
        if (!['visual', 'text', 'together'].includes(channel) || valid.includes(channel)) continue;
        valid.push(channel);
    }
    return valid;
}

function embeddingSteerSelection(record, target, fallbackDomain) {
    const steer = record && record.steer && typeof record.steer === 'object' ? record.steer : {};
    for (const channel of embeddingDisplayPreference(record, fallbackDomain)) {
        const sourceKey = `${channel}_${target}`;
        const metric = steer[sourceKey];
        if (!metric || metric.est == null || !isFinite(Number(metric.est))) continue;
        return {
            domain: String((record.input_manifest && record.input_manifest.domain) || fallbackDomain || 'shorts_raw'),
            origin: 'stored-production',
            channel,
            target,
            sourceKey,
            est: Number(metric.est),
            pctile: metric.pctile == null || !isFinite(Number(metric.pctile)) ? null : Number(metric.pctile),
            kind: metric.kind || null,
            scorer: (record.input_manifest && record.input_manifest.scorer) || null,
            embeddingModel: (record.input_manifest && record.input_manifest.embedding_model) || null,
        };
    }
    return null;
}

function compactSavedHookRecord(record) {
    const selected = {};
    for (const target of SAVED_HOOK_METRICS) selected[target] = embeddingSteerSelection(record, target, 'shorts_raw');
    const metric = target => selected[target];
    const manifest = record && record.input_manifest && typeof record.input_manifest === 'object'
        ? record.input_manifest
        : {};
    const visualForecast = record && record.visual_keep_forecast && typeof record.visual_keep_forecast === 'object'
        ? record.visual_keep_forecast
        : null;
    const creatorForecast = record && record.creator_adaptive_keep_forecast && typeof record.creator_adaptive_keep_forecast === 'object'
        ? record.creator_adaptive_keep_forecast
        : null;
    return {
        id: record.id,
        title: record.title,
        kind: record.kind,
        hasMontage: !!record.hasMontage,
        savedAt: record.savedAt,
        folder: record.folder || null,
        input_manifest: record.input_manifest || null,
        score_revision_fingerprint: manifest.revision_fingerprint || null,
        embedding_input_fingerprint: manifest.embedding_input_fingerprint || null,
        score_input_fingerprint: manifest.score_input_fingerprint || manifest.input_fingerprint || null,
        creator_profile: manifest.creator_profile || null,
        keep: metric('keep') && metric('keep').pctile,
        m: {
            keep: metric('keep') && metric('keep').pctile,
            keep_est: metric('keep') && metric('keep').est,
            ret5: metric('ret5') && metric('ret5').pctile,
            views: metric('views') && metric('views').est,
            sviews: metric('realviews') && metric('realviews').est,
            gt10M: metric('gt10M') && metric('gt10M').est,
            outlier: metric('outlier') && metric('outlier').pctile,
            visual_keep_forecast: visualForecast && isFinite(Number(visualForecast.raw)) ? Number(visualForecast.raw) : null,
            creator_adaptive_keep: creatorForecast && isFinite(Number(creatorForecast.raw)) ? Number(creatorForecast.raw) : null,
        },
        m_identity: selected,
        derived_identity: {
            visual_keep_forecast: visualForecast ? {
                coordinateId: visualForecast.coordinate_id || 'shorts.visual-keep-forecast.v1',
                raw: visualForecast.raw == null ? null : Number(visualForecast.raw),
                artifactSha256: visualForecast.model_artifact_sha256 || null,
            } : null,
            creator_adaptive_keep: creatorForecast ? {
                coordinateId: creatorForecast.coordinate_id || 'shorts.creator-adaptive-keep.v1',
                raw: creatorForecast.raw == null ? null : Number(creatorForecast.raw),
                profile: creatorForecast.profile_account || manifest.creator_profile || null,
                modelArtifactSha256: creatorForecast.model_artifact_sha256 || null,
                servingArtifactSha256: creatorForecast.serving_artifact_sha256 || null,
            } : null,
        },
    };
}

module.exports = {
    SAVED_HOOK_INDEX_VERSION,
    SHORTS_DISPLAY_PREFERENCE,
    LONGQUANT_DISPLAY_PREFERENCE,
    SAVED_HOOK_METRICS,
    embeddingDisplayPreference,
    embeddingSteerSelection,
    compactSavedHookRecord,
};
