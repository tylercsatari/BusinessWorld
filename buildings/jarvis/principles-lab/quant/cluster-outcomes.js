#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
    finite,
    mean,
    correlation,
    spearman,
    rSquared,
    mae,
    deterministicFold,
    gunzipJson,
    hash,
    round,
} = require('./core');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PANEL_PATH = path.join(__dirname, '.cache', 'unified-panel.json.gz');
const TARGET_PATH = path.join(__dirname, '.cache', 'opportunity-targets.json.gz');
const GEOMETRY_SUMMARY_PATH = path.join(__dirname, 'reconstructed-geometry-summary.json');
const OUTPUT_PATH = path.join(__dirname, 'cluster-outcomes-adjusted.json');
const PERMUTATIONS = 250;

function etaSquared(labels, values) {
    if (labels.length !== values.length || values.length < 3) return null;
    const center = mean(values);
    let total = 0;
    const groups = new Map();
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        total += (value - center) ** 2;
        const key = String(labels[index]);
        const current = groups.get(key) || { sum: 0, count: 0 };
        current.sum += value;
        current.count += 1;
        groups.set(key, current);
    }
    let between = 0;
    for (const group of groups.values()) {
        between += group.count * ((group.sum / group.count) - center) ** 2;
    }
    return total > 0 ? between / total : null;
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffledWithinSource(rows, seed) {
    const output = rows.map(row => row.target);
    const groups = new Map();
    rows.forEach((row, index) => {
        if (!groups.has(row.sourceId)) groups.set(row.sourceId, []);
        groups.get(row.sourceId).push(index);
    });
    const random = seededRandom(seed);
    for (const indices of groups.values()) {
        const values = indices.map(index => output[index]);
        for (let index = values.length - 1; index > 0; index -= 1) {
            const replacement = Math.floor(random() * (index + 1));
            [values[index], values[replacement]] = [values[replacement], values[index]];
        }
        indices.forEach((rowIndex, index) => { output[rowIndex] = values[index]; });
    }
    return output;
}

function clusterPrediction(trainRows, testRows) {
    const testFamilies = new Set(testRows.map(row => row.contentFamilyId));
    const familySafeTrainRows = trainRows.filter(
        row => !testFamilies.has(row.contentFamilyId)
    );
    const groups = new Map();
    for (const row of familySafeTrainRows) {
        const current = groups.get(row.cluster) || { sum: 0, count: 0 };
        current.sum += row.target;
        current.count += 1;
        groups.set(row.cluster, current);
    }
    const globalMean = mean(familySafeTrainRows.map(row => row.target)) || 0;
    const predictions = testRows.map(row => {
        const group = groups.get(row.cluster);
        return group && group.count >= 5 ? group.sum / group.count : globalMean;
    });
    return {
        predictions,
        trainingRowsAfterFamilyExclusion: familySafeTrainRows.length,
    };
}

function validationMetrics(rows) {
    const unseenActual = [];
    const unseenPredicted = [];
    const unseenTrainingRows = [];
    for (let fold = 0; fold < 5; fold += 1) {
        const train = rows.filter(row => deterministicFold(row.sourceId, 5) !== fold);
        const test = rows.filter(row => deterministicFold(row.sourceId, 5) === fold);
        unseenActual.push(...test.map(row => row.target));
        const foldPrediction = clusterPrediction(train, test);
        unseenPredicted.push(...foldPrediction.predictions);
        unseenTrainingRows.push(foldPrediction.trainingRowsAfterFamilyExclusion);
    }

    const bySource = new Map();
    for (const row of rows) {
        if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, []);
        bySource.get(row.sourceId).push(row);
    }
    const early = [];
    const late = [];
    for (const sourceRows of bySource.values()) {
        sourceRows.sort((left, right) => left.publishedSeconds - right.publishedSeconds);
        const split = Math.max(1, Math.floor(sourceRows.length * 0.7));
        early.push(...sourceRows.slice(0, split));
        late.push(...sourceRows.slice(split));
    }
    const latePrediction = clusterPrediction(early, late);
    const latePredicted = latePrediction.predictions;
    const lateActual = late.map(row => row.target);
    const zeroMae = mae(lateActual, lateActual.map(() => 0));

    return {
        unseenCreator: {
            n: unseenActual.length,
            meanTrainingRowsAfterFamilyExclusion: round(mean(unseenTrainingRows), 1),
            r2: round(rSquared(unseenActual, unseenPredicted)),
            pearson: round(correlation(unseenActual, unseenPredicted)),
            spearman: round(spearman(unseenActual, unseenPredicted)),
            maeLog10Lift: round(mae(unseenActual, unseenPredicted)),
        },
        laterVideo: {
            n: lateActual.length,
            trainingRowsBeforeFamilyExclusion: early.length,
            trainingRowsAfterFamilyExclusion: latePrediction.trainingRowsAfterFamilyExclusion,
            r2: round(rSquared(lateActual, latePredicted)),
            pearson: round(correlation(lateActual, latePredicted)),
            spearman: round(spearman(lateActual, latePredicted)),
            maeLog10Lift: round(mae(lateActual, latePredicted)),
            zeroBaselineMae: round(zeroMae),
            maeImprovement: round(zeroMae - mae(lateActual, latePredicted)),
        },
    };
}

function sourceMacroEta(rows) {
    const bySource = new Map();
    for (const row of rows) {
        if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, []);
        bySource.get(row.sourceId).push(row);
    }
    const values = [];
    for (const sourceRows of bySource.values()) {
        if (sourceRows.length < 5 || new Set(sourceRows.map(row => row.cluster)).size < 2) continue;
        values.push(etaSquared(
            sourceRows.map(row => row.cluster),
            sourceRows.map(row => row.target)
        ));
    }
    return {
        sources: values.length,
        meanEtaSquared: round(mean(values)),
    };
}

function continuousDiagnostics(rows, modality) {
    const output = [];
    const names = new Set();
    for (const row of rows) {
        for (const name of Object.keys(row.panel.modalities[modality]?.projections || {})) names.add(name);
    }
    for (const name of [...names].sort()) {
        for (const coordinate of ['x', 'y', 'estimate']) {
            const paired = rows
                .map(row => ({
                    score: finite(row.panel.modalities[modality]?.projections?.[name]?.[coordinate]),
                    target: row.target,
                }))
                .filter(row => row.score != null);
            if (paired.length < 100) continue;
            output.push({
                projection: name,
                coordinate,
                observations: paired.length,
                outcomeBlind: ['pca', 'umap'].includes(name),
                pearson: round(correlation(
                    paired.map(row => row.score),
                    paired.map(row => row.target)
                )),
                spearman: round(spearman(
                    paired.map(row => row.score),
                    paired.map(row => row.target)
                )),
                boundary: ['pca', 'umap'].includes(name)
                    ? 'Descriptive association of an outcome-blind coordinate.'
                    : 'Exploratory only: this supervised axis was fit against outcomes before the creator-relative target existed.',
            });
        }
    }
    return output;
}

function analyzeFormat(format, panelRows, targetRows) {
    const targetByObservation = new Map(
        targetRows.filter(row => row.format === format).map(row => [row.observationId, row])
    );
    const joined = panelRows
        .filter(row => row.format === format && targetByObservation.has(row.observationId))
        .map(panel => ({
            panel,
            ...targetByObservation.get(panel.observationId),
            target: targetByObservation.get(panel.observationId).creatorRelativeLift,
        }));
    const tests = [];
    for (const modality of ['visual', 'text', 'together']) {
        const modalityRows = joined.filter(row => row.panel.modalities[modality]?.available);
        for (const clusterCount of [6, 10, 16, 24]) {
            const rows = modalityRows
                .map(row => ({
                    ...row,
                    cluster: finite(row.panel.modalities[modality]?.clusters?.[String(clusterCount)]),
                }))
                .filter(row => row.cluster != null);
            tests.push({
                id: `${format}:${modality}:k${clusterCount}`,
                format,
                modality,
                clusterCount,
                observations: rows.length,
                sources: new Set(rows.map(row => row.sourceId)).size,
                etaSquared: round(etaSquared(
                    rows.map(row => row.cluster),
                    rows.map(row => row.target)
                )),
                sourceMacro: sourceMacroEta(rows),
                validation: validationMetrics(rows),
                _rows: rows,
            });
        }
    }

    const permutationMaxima = [];
    for (let permutation = 0; permutation < PERMUTATIONS; permutation += 1) {
        let maximum = 0;
        for (let testIndex = 0; testIndex < tests.length; testIndex += 1) {
            const test = tests[testIndex];
            const shuffled = shuffledWithinSource(test._rows, 17_000 + (permutation * 101) + testIndex);
            maximum = Math.max(maximum, etaSquared(
                test._rows.map(row => row.cluster),
                shuffled
            ) || 0);
        }
        permutationMaxima.push(maximum);
    }
    for (const test of tests) {
        test.familyWiseP = round(
            (1 + permutationMaxima.filter(value => value >= test.etaSquared).length)
            / (PERMUTATIONS + 1)
        );
        test.familyWiseSignificant = test.familyWiseP <= 0.05;
        delete test._rows;
    }

    return {
        format,
        eligibleTargetRows: joined.length,
        tests,
        familyNull: {
            permutations: PERMUTATIONS,
            shuffleUnit: 'creator',
            method: 'Outcomes are shuffled only within creator. The maximum eta-squared across all 12 modality/resolution tests defines the family-wise null.',
            p95MaximumEtaSquared: round(
                permutationMaxima.slice().sort((left, right) => left - right)[
                    Math.floor(permutationMaxima.length * 0.95)
                ]
            ),
        },
        continuousDiagnostics: Object.fromEntries(['visual', 'text', 'together'].map(modality => [
            modality,
            continuousDiagnostics(
                joined.filter(row => row.panel.modalities[modality]?.available),
                modality
            ),
        ])),
    };
}

async function main() {
    if (!fs.existsSync(PANEL_PATH) || !fs.existsSync(TARGET_PATH)) {
        throw new Error('Run quant/build-panel.js and quant/derive-outcomes.js first.');
    }
    const panelBytes = fs.readFileSync(PANEL_PATH);
    const targetBytes = fs.readFileSync(TARGET_PATH);
    const panel = gunzipJson(panelBytes);
    const targets = gunzipJson(targetBytes);
    const formats = ['shorts', 'long'].map(format => (
        analyzeFormat(format, panel.rows, targets.rows)
    ));
    const allTests = formats.flatMap(format => format.tests);
    const output = {
        schema: 'opportunity-adjusted-cluster-outcomes-v2',
        generatedAt: new Date().toISOString(),
        target: 'creatorRelativeLift',
        tests: allTests.length,
        familyWiseSignificantTests: allTests.filter(test => test.familyWiseSignificant).length,
        bestLaterVideo: allTests
            .slice()
            .sort((left, right) => (
                (right.validation.laterVideo.spearman || -Infinity)
                - (left.validation.laterVideo.spearman || -Infinity)
            ))[0],
        bestUnseenCreator: allTests
            .slice()
            .sort((left, right) => (
                (right.validation.unseenCreator.spearman || -Infinity)
                - (left.validation.unseenCreator.spearman || -Infinity)
            ))[0],
        formats,
        evidenceBoundary: [
            'Cluster geometry is reconstructed from frozen raw vectors without outcomes, but remains transductive because unlabeled test inputs enter PCA and KMeans.',
            'The adjusted outcome uses unrechecked views observed near each video storedAt time and only creator history observed before target publication.',
            'Native supervised map axes are excluded from this analysis.',
            'Outcome-free semantic near-copy families are removed from training when present in evaluation.',
            'Family-wise p-values protect the 12 cluster tests within each format, not every historical Jarvis search.',
        ],
        snapshotRunId: panel.snapshotRunId,
        snapshotIdentityHash: panel.snapshotIdentityHash,
        targetContentHash: targets.contentHash,
        semanticFamilyHash: targets.semanticFamilyHash,
        reconstructedGeometryHash: fs.existsSync(GEOMETRY_SUMMARY_PATH)
            ? hash(fs.readFileSync(GEOMETRY_SUMMARY_PATH))
            : null,
        sourcePanelHash: hash(panelBytes),
        sourceTargetHash: hash(targetBytes),
    };
    output.contentHash = hash(JSON.stringify(output));
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify({
        output: path.relative(ROOT, OUTPUT_PATH),
        tests: output.tests,
        familyWiseSignificantTests: output.familyWiseSignificantTests,
        bestLaterVideo: {
            id: output.bestLaterVideo.id,
            ...output.bestLaterVideo.validation.laterVideo,
            familyWiseP: output.bestLaterVideo.familyWiseP,
        },
        bestUnseenCreator: {
            id: output.bestUnseenCreator.id,
            ...output.bestUnseenCreator.validation.unseenCreator,
            familyWiseP: output.bestUnseenCreator.familyWiseP,
        },
        formatNulls: formats.map(row => ({ format: row.format, ...row.familyNull })),
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
