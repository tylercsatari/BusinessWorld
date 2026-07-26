#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
    loadUnifiedPanel,
    gzipJson,
    finite,
    median,
    quantile,
    hash,
} = require('./core');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const PANEL_PATH = path.join(CACHE_DIR, 'unified-panel.json.gz');
const SUMMARY_PATH = path.join(__dirname, 'panel-summary.json');

function formatSummary(format, rows) {
    const sourceCounts = new Map();
    const familyCounts = new Map();
    const ages = [];
    let stableSourceMissing = 0;
    for (const row of rows) {
        if (row.sourceId) sourceCounts.set(row.sourceId, (sourceCounts.get(row.sourceId) || 0) + 1);
        else stableSourceMissing += 1;
        familyCounts.set(row.contentFamilyId, (familyCounts.get(row.contentFamilyId) || 0) + 1);
        if (finite(row.ageDays) != null) ages.push(row.ageDays);
    }
    const sourceSizes = [...sourceCounts.values()];
    const duplicateFamilies = [...familyCounts.values()].filter(count => count > 1);
    const rowsBySource = new Map();
    for (const row of rows) {
        if (!rowsBySource.has(row.sourceId)) rowsBySource.set(row.sourceId, []);
        rowsBySource.get(row.sourceId).push(row);
    }
    let targetsWithObservableHistory = 0;
    let targetsWithAllModalitiesAndObservableHistory = 0;
    const observableHistoryCounts = [];
    for (const sourceRows of rowsBySource.values()) {
        sourceRows.sort((left, right) => (
            left.publishedSeconds - right.publishedSeconds
            || left.videoId.localeCompare(right.videoId)
        ));
        const history = [];
        for (const row of sourceRows) {
            const observable = history.filter(previous => (
                previous.observationSeconds <= row.publishedSeconds
                && previous.contentFamilyId !== row.contentFamilyId
            ));
            if (observable.length) {
                targetsWithObservableHistory += 1;
                observableHistoryCounts.push(observable.length);
                if (['visual', 'text', 'together'].every(
                    modality => row.modalities[modality]?.available
                )) targetsWithAllModalitiesAndObservableHistory += 1;
            }
            history.push(row);
        }
    }
    return {
        format,
        observations: rows.length,
        sources: sourceCounts.size,
        stableSourceMissing,
        sourcesWithAtLeast5Videos: sourceSizes.filter(count => count >= 5).length,
        sourcesWithAtLeast20Videos: sourceSizes.filter(count => count >= 20).length,
        sourceSize: {
            median: median(sourceSizes),
            p90: quantile(sourceSizes, 0.9),
            maximum: Math.max(...sourceSizes),
        },
        exactContentFamilies: familyCounts.size,
        duplicateFamilies: duplicateFamilies.length,
        observationsInDuplicateFamilies: duplicateFamilies.reduce((sum, count) => sum + count, 0),
        ageDays: {
            median: median(ages),
            p10: quantile(ages, 0.1),
            p90: quantile(ages, 0.9),
        },
        modalityCoverage: Object.fromEntries(['visual', 'text', 'together'].map(modality => [
            modality,
            rows.filter(row => row.modalities[modality]?.available).length,
        ])),
        historicallyObservableSupport: {
            targetsWithAtLeastOnePriorObservation: targetsWithObservableHistory,
            targetsWithAllModalities: targetsWithAllModalitiesAndObservableHistory,
            medianPriorObservations: median(observableHistoryCounts),
            rule: 'same creator, prior publication, prior outcome observed no later than target publication, different exact content family',
        },
    };
}

async function main() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const panel = await loadUnifiedPanel();
    fs.writeFileSync(PANEL_PATH, gzipJson(panel));
    const formats = ['shorts', 'long'].map(format => (
        formatSummary(format, panel.rows.filter(row => row.format === format))
    ));
    const summary = {
        schema: 'principles-unified-observation-panel-v2',
        generatedAt: new Date().toISOString(),
        panelPath: path.relative(ROOT, PANEL_PATH),
        panelBytesGzip: fs.statSync(PANEL_PATH).size,
        observationIdentity: 'format:youtube_video_id',
        sourceIdentity: 'exact stable channelId; rows without channelId are excluded',
        contentFamilyIdentity: 'exact normalized opening transcript plus duration; title plus duration when transcript is unavailable',
        rowGates: [
            'stored and not removed',
            'never rechecked',
            'exact channelId, timestamp, storedAt, and positive views',
            'views observation age is positive and no greater than 366 days',
            'Shorts are vertical and at most 180 seconds; Long videos are horizontal',
        ],
        formats,
        evidenceKinds: {
            inputs: ['title', 'opening transcript', 'thumbnail/opening representations', 'duration'],
            outcomes: ['unrechecked public views observed near the per-video storedAt timestamp'],
            postOutcome: ['likes', 'comments', 'current subscribers'],
            projected: ['outcome-blind reconstructed PCA coordinates', 'outcome-blind reconstructed cluster memberships'],
        },
        primaryLimitation: 'The selected corpus contains one historically timed public view observation per eligible video, not impressions or a randomized intervention. Age/opportunity adjustment supports observational relative-performance claims, not causal package lift or YouTube-wide hit probabilities.',
        provenance: panel.provenance,
        reconstructedGeometry: panel.reconstructedGeometry,
        snapshotRunId: panel.snapshotRunId,
        snapshotIdentityHash: panel.snapshotIdentityHash,
    };
    summary.contentHash = hash(JSON.stringify(summary));
    fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
