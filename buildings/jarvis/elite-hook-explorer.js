'use strict';

const {
    canonicalJsonBytes,
    exactSha256,
    sha256Bytes,
} = require('./canonical-json-artifact');

const INDEX_SCHEMA = 'elite-hook-corpus-index-v1';
const INDEX_VERSION = 1;
const INDEX_KEY = 'hooks/elite-corpus/index-v1.json';
const MAP_MANIFEST_KEY = 'raw/together/map.manifest.json';
const SAVED_CHANNEL_INDEX_KEY = 'raw/saved-channels/index.json';
const MIN_INDEX_PERCENTILE = 80;
const DEFAULT_METRIC = 'together_keep_geometry';

const SOURCE_METRICS = Object.freeze([
    Object.freeze({
        id: 'together_keep_geometry',
        label: 'Together keep geometry',
        projection: 'keep',
        sourceField: 'x',
        unit: 'corpus_percentile',
        evidenceRole: 'descriptive_retrieval_only',
        description:
            'Empirical rank of the frozen Together keep-axis map coordinate. '
            + 'It selects source examples; it is not a canonical keep forecast.',
    }),
    Object.freeze({
        id: 'together_ret5_geometry',
        label: 'Together past-5s geometry',
        projection: 'ret5',
        sourceField: 'x',
        unit: 'corpus_percentile',
        evidenceRole: 'descriptive_retrieval_only',
        description:
            'Empirical rank of the frozen Together past-five-second map coordinate. '
            + 'It selects source examples; it is not a canonical retention forecast.',
    }),
    Object.freeze({
        id: 'together_views_geometry',
        label: 'Together views geometry',
        projection: 'views',
        sourceField: 'x',
        unit: 'corpus_percentile',
        evidenceRole: 'descriptive_retrieval_only',
        description:
            'Empirical rank of the frozen Together views-axis map coordinate. '
            + 'It is source-selection geometry, not a promise of future views.',
    }),
    Object.freeze({
        id: 'together_gt10m_geometry',
        label: 'Together >10M geometry',
        projection: 'hi10m',
        sourceField: 'x',
        unit: 'corpus_percentile',
        evidenceRole: 'descriptive_retrieval_only',
        description:
            'Empirical rank of the frozen Together greater-than-10M class geometry. '
            + 'It is source-selection geometry, not a calibrated probability.',
    }),
    Object.freeze({
        id: 'observed_views',
        label: 'Observed views',
        sourceColumn: 'views',
        unit: 'corpus_percentile',
        evidenceRole: 'retrospective_retrieval_only',
        description:
            'Empirical rank of observed snapshot views. This is retrospective '
            + 'inspiration and is never supplied to the final scorer.',
    }),
]);

const METRIC_BY_ID = Object.freeze(Object.fromEntries(
    SOURCE_METRICS.map(metric => [metric.id, metric])
));

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
    const scale = 10 ** digits;
    return Math.round(Number(value) * scale) / scale;
}

function stringValue(value, maximum = 280) {
    return String(value == null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum);
}

function metricValues(map, metric) {
    if (metric.sourceColumn) {
        return Array.isArray(map[metric.sourceColumn])
            ? map[metric.sourceColumn].map(finite)
            : [];
    }
    const projection = map.proj
        && map.proj[metric.projection];
    const values = projection
        && projection[metric.sourceField];
    return Array.isArray(values) ? values.map(finite) : [];
}

function empiricalPercentiles(values) {
    const indexed = values
        .map((value, index) => ({ value: finite(value), index }))
        .filter(item => item.value != null)
        .sort((left, right) => (
            left.value - right.value
            || left.index - right.index
        ));
    const output = Array(values.length).fill(null);
    if (!indexed.length) return output;
    let start = 0;
    while (start < indexed.length) {
        let end = start + 1;
        while (
            end < indexed.length
            && indexed[end].value === indexed[start].value
        ) end += 1;
        const averageRank = (start + end - 1) / 2;
        const percentile = indexed.length === 1
            ? 100
            : 100 * averageRank / (indexed.length - 1);
        for (let cursor = start; cursor < end; cursor += 1) {
            output[indexed[cursor].index] = round(percentile, 2);
        }
        start = end;
    }
    return output;
}

function channelMembership(savedChannelIndex, manifests) {
    const channelById = new Map();
    const videoChannels = new Map();
    const indexChannels = Array.isArray(savedChannelIndex && savedChannelIndex.channels)
        ? savedChannelIndex.channels
        : [];
    indexChannels.forEach(channel => {
        if (!channel || !channel.id) return;
        channelById.set(channel.id, {
            id: String(channel.id),
            name: stringValue(channel.name || channel.id, 100),
            url: stringValue(channel.url, 300),
            manifest_key: stringValue(channel.manifestKey, 300),
            manifest_sha256: exactSha256(channel.manifestSha256)
                ? channel.manifestSha256
                : null,
            completed: Math.max(0, Number(channel.completed) || 0),
        });
    });
    Object.entries(manifests || {}).forEach(([channelId, manifest]) => {
        const rows = Array.isArray(manifest && manifest.videos)
            ? manifest.videos
            : [];
        rows.forEach(video => {
            const id = stringValue(video && video.id, 80);
            if (!id) return;
            if (!videoChannels.has(id)) videoChannels.set(id, new Set());
            videoChannels.get(id).add(channelId);
        });
    });
    return {
        channels: [...channelById.values()].sort((left, right) => (
            left.name.localeCompare(right.name)
        )),
        videoChannels,
        manifests: manifests || {},
    };
}

function ledgerPercentile(video, coordinateId) {
    const entries = video
        && video.score_ledger
        && Array.isArray(video.score_ledger.entries)
        ? video.score_ledger.entries
        : [];
    const entry = entries.find(candidate => (
        candidate
        && candidate.coordinate_id === coordinateId
        && candidate.available === true
    ));
    return entry ? finite(entry.percentile) : null;
}

function percentileInSorted(sorted, value) {
    const numeric = finite(value);
    if (numeric == null || !sorted.length) return null;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle] <= numeric) low = middle + 1;
        else high = middle;
    }
    return round(100 * Math.max(0, low - 1) / Math.max(1, sorted.length - 1), 2);
}

function savedVideoScores(video, observedViewsSorted) {
    return {
        together_keep_geometry: ledgerPercentile(
            video,
            'shorts.stored.together.keep'
        ),
        together_ret5_geometry: ledgerPercentile(
            video,
            'shorts.stored.together.ret5'
        ),
        together_views_geometry: ledgerPercentile(
            video,
            'shorts.stored.together.views'
        ),
        together_gt10m_geometry: ledgerPercentile(
            video,
            'shorts.stored.together.gt10M'
        ),
        observed_views: percentileInSorted(
            observedViewsSorted,
            video && video.views
        ),
    };
}

function deterministicGeneratedAt(explicitValue, savedChannelIndex) {
    const explicit = Date.parse(String(explicitValue || ''));
    if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
    const sourceUpdatedAt = Number(
        savedChannelIndex && savedChannelIndex.updatedAt
    );
    if (Number.isFinite(sourceUpdatedAt) && sourceUpdatedAt >= 0) {
        return new Date(sourceUpdatedAt).toISOString();
    }
    return '1970-01-01T00:00:00.000Z';
}

function buildIndex({
    map,
    mapManifest,
    mapBytesSha256,
    savedChannelIndex,
    savedChannelIndexBytesSha256,
    savedChannelManifests,
    generatedAt,
} = {}) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        throw new Error('Together map must be a columnar object');
    }
    const rowCount = Number(map.n);
    if (!Number.isSafeInteger(rowCount) || rowCount < 1) {
        throw new Error('Together map row count is invalid');
    }
    if (!Array.isArray(map.id) || map.id.length !== rowCount) {
        throw new Error('Together map IDs do not match its row count');
    }
    const published = mapManifest && mapManifest.publishedMap;
    if (
        !published
        || published.rowCount !== rowCount
        || !exactSha256(published.artifactSha256)
        || published.artifactSha256 !== mapBytesSha256
    ) {
        throw new Error('Together map bytes do not match the published map manifest');
    }
    const membership = channelMembership(
        savedChannelIndex,
        savedChannelManifests
    );
    const percentileArrays = Object.fromEntries(SOURCE_METRICS.map(metric => [
        metric.id,
        empiricalPercentiles(metricValues(map, metric)),
    ]));
    const sourceArrays = Object.fromEntries(SOURCE_METRICS.map(metric => [
        metric.id,
        metricValues(map, metric),
    ]));
    const rows = [];
    const metricCounts = Object.fromEntries(
        SOURCE_METRICS.map(metric => [metric.id, 0])
    );
    const channelCounts = Object.fromEntries(
        membership.channels.map(channel => [channel.id, 0])
    );
    const indexedIds = new Set();
    for (let index = 0; index < rowCount; index += 1) {
        const scores = Object.fromEntries(SOURCE_METRICS.map(metric => [
            metric.id,
            percentileArrays[metric.id][index],
        ]));
        const channels = [
            ...(membership.videoChannels.get(String(map.id[index])) || []),
        ];
        const elite = Object.values(scores).some(value => (
            value != null && value >= MIN_INDEX_PERCENTILE
        ));
        if (!elite && !channels.length) continue;
        SOURCE_METRICS.forEach(metric => {
            if (scores[metric.id] >= MIN_INDEX_PERCENTILE) {
                metricCounts[metric.id] += 1;
            }
        });
        channels.forEach(channelId => {
            channelCounts[channelId] = (channelCounts[channelId] || 0) + 1;
        });
        const id = String(map.id[index]);
        rows.push({
            id,
            title: stringValue(map.title && map.title[index], 220),
            opening: stringValue(map.txt && map.txt[index], 360),
            views: Math.max(0, Math.round(finite(
                map.views && map.views[index]
            ) || 0)),
            owner: stringValue(map.owner && map.owner[index], 100) || null,
            channels,
            cluster_24: finite(
                map.clusters
                && map.clusters['24']
                && map.clusters['24'][index]
            ),
            metrics: scores,
            source_values: Object.fromEntries(SOURCE_METRICS.map(metric => [
                metric.id,
                sourceArrays[metric.id][index],
            ])),
            embedding_available: true,
            source_evidence_state: 'published_together_map',
        });
        indexedIds.add(id);
    }
    const observedViewsSorted = (map.views || [])
        .map(finite)
        .filter(value => value != null)
        .sort((left, right) => left - right);
    Object.entries(membership.manifests).forEach(([channelId, manifest]) => {
        const videos = Array.isArray(manifest && manifest.videos)
            ? manifest.videos
            : [];
        videos.forEach(video => {
            const id = stringValue(video && video.id, 80);
            if (!id || indexedIds.has(id)) return;
            const scores = savedVideoScores(video, observedViewsSorted);
            SOURCE_METRICS.forEach(metric => {
                if (scores[metric.id] >= MIN_INDEX_PERCENTILE) {
                    metricCounts[metric.id] += 1;
                }
            });
            channelCounts[channelId] = (channelCounts[channelId] || 0) + 1;
            rows.push({
                id,
                title: stringValue(video.title, 220),
                opening: stringValue(video.transcript, 360),
                views: Math.max(0, Math.round(finite(video.views) || 0)),
                owner: stringValue(video.sourceChannel, 100) || null,
                channels: [channelId],
                cluster_24: null,
                metrics: scores,
                source_values: {
                    together_keep_geometry: ledgerPercentile(
                        video,
                        'shorts.stored.together.keep'
                    ),
                    together_ret5_geometry: ledgerPercentile(
                        video,
                        'shorts.stored.together.ret5'
                    ),
                    together_views_geometry: ledgerPercentile(
                        video,
                        'shorts.stored.together.views'
                    ),
                    together_gt10m_geometry: ledgerPercentile(
                        video,
                        'shorts.stored.together.gt10M'
                    ),
                    observed_views: finite(video.views),
                },
                embedding_available: false,
                source_evidence_state:
                    video.canonical === true
                        ? 'canonical_saved_channel_ledger'
                        : 'historical_saved_channel_ledger_retrieval_only',
            });
            indexedIds.add(id);
        });
    });
    const payload = {
        schema: INDEX_SCHEMA,
        schema_version: INDEX_VERSION,
        generated_at: deterministicGeneratedAt(
            generatedAt,
            savedChannelIndex
        ),
        minimum_index_percentile: MIN_INDEX_PERCENTILE,
        corpus: {
            modality: 'together',
            row_count: rowCount,
            indexed_row_count: rows.length,
            embedding_model: mapManifest.embeddingModel || null,
            embedding_dimensions: mapManifest.embeddingDimensions || null,
            map_manifest_key: MAP_MANIFEST_KEY,
            map_key: published.archiveKey,
            map_sha256: published.artifactSha256,
            map_video_id_sha256: published.videoIdSha256 || null,
        },
        saved_channels_source: {
            index_key: SAVED_CHANNEL_INDEX_KEY,
            index_sha256: exactSha256(savedChannelIndexBytesSha256)
                ? savedChannelIndexBytesSha256
                : null,
            navigation_payload_sha256:
                savedChannelIndex && savedChannelIndex.payloadSha256 || null,
        },
        metric_definitions: SOURCE_METRICS,
        metric_counts: metricCounts,
        channel_counts: channelCounts,
        channels: membership.channels,
        rows,
        governance: {
            retrieval_scores_are_canonical_outputs: false,
            final_generated_score_source:
                'persisted canonical Shorts score ledger only',
            causal_claim: false,
            note:
                'Corpus geometry and observed views select diverse source evidence only. '
                + 'They never clear a generated hook threshold.',
        },
    };
    return bindIndex(payload);
}

function bindIndex(payload) {
    const clean = { ...(payload || {}) };
    delete clean.content_sha256;
    return {
        ...clean,
        content_sha256: sha256Bytes(canonicalJsonBytes(clean)),
    };
}

function validateIndex(index) {
    const errors = [];
    if (!index || typeof index !== 'object' || Array.isArray(index)) {
        return { valid: false, errors: ['elite index is missing'] };
    }
    if (index.schema !== INDEX_SCHEMA || index.schema_version !== INDEX_VERSION) {
        errors.push('elite index schema is invalid');
    }
    if (!exactSha256(index.content_sha256)) {
        errors.push('elite index content SHA-256 is invalid');
    } else {
        const clean = { ...index };
        delete clean.content_sha256;
        if (sha256Bytes(canonicalJsonBytes(clean)) !== index.content_sha256) {
            errors.push('elite index content hash does not match');
        }
    }
    if (!index.corpus || !exactSha256(index.corpus.map_sha256)) {
        errors.push('elite index corpus lineage is invalid');
    }
    if (!Array.isArray(index.rows) || !index.rows.length) {
        errors.push('elite index has no rows');
    }
    const ids = new Set();
    (index.rows || []).forEach(row => {
        if (!row || !row.id || ids.has(row.id)) {
            errors.push('elite index video IDs are invalid or duplicated');
            return;
        }
        ids.add(row.id);
    });
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
        content_sha256: errors.length ? null : index.content_sha256,
    };
}

function metricId(value) {
    return METRIC_BY_ID[value] ? value : DEFAULT_METRIC;
}

function publicSummary(index) {
    const validation = validateIndex(index);
    if (!validation.valid) {
        throw new Error(validation.errors.join('; '));
    }
    return {
        schema: index.schema,
        content_sha256: index.content_sha256,
        generated_at: index.generated_at,
        minimum_index_percentile: index.minimum_index_percentile,
        corpus: index.corpus,
        metrics: SOURCE_METRICS.map(metric => ({
            ...metric,
            indexed_elite_count: index.metric_counts[metric.id] || 0,
        })),
        channels: index.channels.map(channel => ({
            ...channel,
            corpus_match_count: index.channel_counts[channel.id] || 0,
        })),
        governance: index.governance,
    };
}

function eligibleRows(index, options = {}) {
    const selectedMetric = metricId(options.metric);
    const cutoff = Math.max(
        MIN_INDEX_PERCENTILE,
        Math.min(99.9, finite(options.cutoff) || 95)
    );
    const channelId = stringValue(options.channelId, 100);
    const channelOriented = options.channelOriented === true;
    return index.rows.filter(row => (
        finite(row.metrics && row.metrics[selectedMetric]) >= cutoff
        && (
            !channelOriented
            || !channelId
            || (row.channels || []).includes(channelId)
        )
    ));
}

function tokens(value) {
    return new Set(String(value || '')
        .toLowerCase()
        .match(/[a-z0-9]{2,}/g) || []);
}

function lexicalSimilarity(query, row) {
    const left = tokens(query);
    const right = tokens(`${row.title || ''} ${row.opening || ''}`);
    if (!left.size || !right.size) return 0;
    let overlap = 0;
    left.forEach(token => { if (right.has(token)) overlap += 1; });
    return overlap / Math.sqrt(left.size * right.size);
}

function deterministicNoise(value) {
    const hex = sha256Bytes(Buffer.from(String(value))).slice(0, 8);
    return Number.parseInt(hex, 16) / 0xffffffff;
}

const MECHANISM_PATTERNS = Object.freeze([
    ['open_question', /\b(?:what|why|how|can|could|does|will|is it|are they)\b|\?/i],
    ['contrast_or_turn', /\b(?:but|yet|however|until|except|instead)\b/i],
    ['testable_outcome', /\b(?:test|see if|find out|what happens|can it|could it|does it)\b/i],
    ['stakes_or_risk', /\b(?:danger|terr|wrong|mistake|survive|save my life|bullet|fire|explode|illegal|problem)\w*/i],
    ['quantified_constraint', /\b(?:\d+|world(?:'s|s)? most|world(?:'s|s)? first|only|every|longest|highest|fastest|smallest|biggest)\b/i],
    ['visible_transformation', /\b(?:build|make|turn|transform|break|destroy|disappear|grow|lift|jump|run|protect)\w*/i],
    ['social_reaction', /\b(?:reaction|stranger|people|friend|sister|brother|party|public|guess who)\w*/i],
    ['concealed_reveal', /\b(?:inside|discover|reveal|secret|actually|apparently|unexpected|believe)\w*/i],
    ['escalation', /\b(?:impossible|superhuman|more powerful|stronger|faster|higher|way better|insane|crazy)\b/i],
]);

function sourceMechanisms(row) {
    const text = `${row && row.title || ''} ${row && row.opening || ''}`;
    const matches = MECHANISM_PATTERNS
        .filter(([, pattern]) => pattern.test(text))
        .map(([id]) => id);
    return matches.length ? matches : ['unclassified_structure'];
}

function selectSources({
    rows,
    metric,
    semanticResults,
    query,
    limit = 4,
    attemptIndex = 0,
    usedIds = [],
} = {}) {
    const selectedMetric = metricId(metric);
    const semantic = new Map(
        (semanticResults || []).map(result => [String(result.id), result])
    );
    const used = new Set(usedIds || []);
    const pool = (rows || []).map(row => {
        const result = semantic.get(String(row.id)) || {};
        const querySimilarity = finite(result.query_similarity)
            ?? finite(result.similarity)
            ?? lexicalSimilarity(query, row);
        const centroidSimilarity = finite(result.centroid_similarity);
        const score = finite(row.metrics && row.metrics[selectedMetric]) || 0;
        return {
            row,
            querySimilarity,
            centroidSimilarity,
            eliteScore: score,
            baseRank:
                0.56 * Math.max(-1, querySimilarity)
                + 0.16 * Math.max(-1, centroidSimilarity == null ? 0 : centroidSimilarity)
                + 0.24 * score / 100
                + 0.04 * deterministicNoise(`${attemptIndex}:${row.id}`),
        };
    });
    const chosen = [];
    const clusterCounts = new Map();
    const mechanismCounts = new Map();
    while (chosen.length < Math.max(1, Math.min(8, limit)) && pool.length) {
        let bestIndex = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        pool.forEach((candidate, index) => {
            const cluster = candidate.row.cluster_24;
            const clusterUse = clusterCounts.get(cluster) || 0;
            const repeatPenalty = used.has(candidate.row.id) ? 0.22 : 0;
            const clusterPenalty = 0.10 * clusterUse;
            const mechanismPenalty = sourceMechanisms(candidate.row)
                .reduce((total, mechanism) => (
                    total + 0.025 * (mechanismCounts.get(mechanism) || 0)
                ), 0);
            const score = candidate.baseRank
                - repeatPenalty
                - clusterPenalty
                - mechanismPenalty;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = index;
            }
        });
        if (bestIndex < 0) break;
        const candidate = pool.splice(bestIndex, 1)[0];
        const cluster = candidate.row.cluster_24;
        clusterCounts.set(cluster, (clusterCounts.get(cluster) || 0) + 1);
        const mechanisms = sourceMechanisms(candidate.row);
        mechanisms.forEach(mechanism => {
            mechanismCounts.set(
                mechanism,
                (mechanismCounts.get(mechanism) || 0) + 1
            );
        });
        chosen.push({
            id: candidate.row.id,
            title: candidate.row.title,
            opening: candidate.row.opening,
            views: candidate.row.views,
            owner: candidate.row.owner,
            channels: candidate.row.channels,
            cluster_24: candidate.row.cluster_24,
            source_metric: selectedMetric,
            source_percentile: candidate.eliteScore,
            semantic_similarity: round(candidate.querySimilarity, 4),
            channel_centroid_similarity:
                candidate.centroidSimilarity == null
                    ? null
                    : round(candidate.centroidSimilarity, 4),
            evidence_role:
                METRIC_BY_ID[selectedMetric].evidenceRole,
            embedding_available:
                candidate.row.embedding_available === true,
            source_evidence_state:
                candidate.row.source_evidence_state || null,
            mechanism_hypotheses: mechanisms,
        });
    }
    return chosen;
}

function mechanismHypothesis(sources) {
    const sourceList = Array.isArray(sources) ? sources : [];
    const clusters = [...new Set(sourceList
        .map(source => source.cluster_24)
        .filter(value => value != null))];
    const mechanismCounts = new Map();
    sourceList.forEach(source => {
        (source.mechanism_hypotheses || []).forEach(mechanism => {
            mechanismCounts.set(
                mechanism,
                (mechanismCounts.get(mechanism) || 0) + 1
            );
        });
    });
    const mechanisms = [...mechanismCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 4)
        .map(([mechanism]) => mechanism);
    return {
        claim_type: 'generation_hypothesis_not_causal_result',
        text: sourceList.length > 1
            ? `Test whether a new opening can combine ${mechanisms.join(', ').replace(/_/g, ' ') || 'transferable presentation cues'} from ${sourceList.length} elite examples across ${clusters.length || 1} corpus cluster${clusters.length === 1 ? '' : 's'} without copying their subjects or claims.`
            : 'Test whether the selected elite opening contains a transferable presentation cue that survives a new subject and a fresh canonical score.',
        validation:
            'The hypothesis is accepted only if the newly rendered hook clears the selected canonical ledger coordinate.',
    };
}

function generationPrompt({
    seedPremise,
    sources,
    channelName,
    channelOriented,
    attemptIndex,
} = {}) {
    const sourceList = (sources || []).slice(0, 6);
    const evidence = sourceList.map((source, index) => [
        `SOURCE ${index + 1} · video ${source.id}`,
        `title: ${source.title || '(untitled)'}`,
        `opening: ${source.opening || '(no opening transcript)'}`,
        `${source.source_metric}: ${round(source.source_percentile, 1)}th corpus percentile`,
        `corpus cluster: ${source.cluster_24 == null ? 'unavailable' : source.cluster_24}`,
        `candidate mechanism hypotheses: ${(source.mechanism_hypotheses || []).join(', ') || 'unclassified'}`,
    ].join('\n')).join('\n\n');
    const seed = stringValue(seedPremise, 500);
    return [
        'ELITE CORPUS EXPLORATION MODE.',
        seed
            ? `IMMUTABLE VIDEO REALM: ${seed}`
            : 'No video realm was supplied. Invent a broad, filmable short-form premise.',
        channelOriented && channelName
            ? `CHANNEL ORIENTATION: Favor semantic patterns near the high-performing corpus examples linked to ${channelName}, while still inventing a new hook.`
            : 'GLOBAL ORIENTATION: Search across all available corpus families, not one creator style.',
        `EXPLORATION ROUND: ${Math.max(1, Number(attemptIndex) + 1)}.`,
        'The source examples below are retrieval evidence, not templates and not causal truths.',
        'Abstract transferable mechanisms such as information order, visual escalation, contrast, unresolved question, reveal timing, and legibility. Combine compatible mechanisms from multiple sources.',
        'Do not copy a source subject, object, wording, factual claim, person, or outcome. Do not mention source videos or analytics.',
        seed
            ? 'The new hook must remain inside the immutable video realm, even as its treatment moves outward.'
            : 'Synthesize one coherent new premise, then commit to it for all five beats.',
        'Return the normal fine-tuned five-beat hook plan only.',
        evidence ? `RETRIEVED EVIDENCE:\n${evidence}` : '',
    ].filter(Boolean).join('\n').slice(0, 6500);
}

module.exports = Object.freeze({
    INDEX_SCHEMA,
    INDEX_VERSION,
    INDEX_KEY,
    MAP_MANIFEST_KEY,
    SAVED_CHANNEL_INDEX_KEY,
    MIN_INDEX_PERCENTILE,
    DEFAULT_METRIC,
    SOURCE_METRICS,
    buildIndex,
    bindIndex,
    validateIndex,
    metricId,
    publicSummary,
    eligibleRows,
    selectSources,
    mechanismHypothesis,
    sourceMechanisms,
    generationPrompt,
    empiricalPercentiles,
});
