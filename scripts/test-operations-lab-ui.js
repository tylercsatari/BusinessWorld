#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(
    ROOT,
    'buildings',
    'jarvis',
    'operations-lab',
    '.cache',
    'test-artifact-12.json',
);
const UI_PATH = path.join(ROOT, 'buildings', 'jarvis', 'operations-lab-ui.js');
const CSS_PATH = path.join(ROOT, 'buildings', 'jarvis', 'operations-lab.css');
const ORIGIN = 'http://operations-lab.test';

function fixtureOperationsArtifact() {
    const familyKeys = [
        'action',
        'subjects',
        'objects',
        'quantity_scale',
        'setting',
        'composition',
        'motion_progression',
        'transformation',
        'stakes_risk',
        'curiosity_gap',
        'novelty_incongruity',
        'emotion_reaction',
        'proof_result',
        'clarity_load',
        'on_screen_text',
        'hook_language',
        'combined_semantics',
        'full_visual',
    ];
    const targetKeys = ['together_keep', 'visual_keep', 'text_keep'];
    const hooks = Array.from({ length: 12 }, (_, index) => {
        const targets = Object.fromEntries(targetKeys.map((key, targetIndex) => [
            key,
            {
                estimate: 72 + index + targetIndex,
                percentile: 40 + index * 4 + targetIndex,
            },
        ]));
        return {
            id: `synthetic-hook-${index + 1}`,
            title: `Synthetic hook ${index + 1}`,
            text: `Synthetic opening text ${index + 1}`,
            savedAt: 1_700_000_000_000 + index,
            source: 'deterministic-test-fixture',
            montage: `/api/raw/saved-montage/synthetic-hook-${index + 1}`,
            validationFold: index % 5,
            targets,
            description: `Outcome-blind synthetic visual description ${index + 1}.`,
            sequence: [
                `Synthetic establishing frame ${index + 1}.`,
                `Synthetic action frame ${index + 1}.`,
            ],
            features: Object.fromEntries(familyKeys.map(key => [
                key,
                `${key.replace(/_/g, ' ')} evidence for synthetic hook ${index + 1}.`,
            ])),
        };
    });
    const outcome = (members, targetIndex) => {
        const memberValues = members.map(index => (
            hooks[index].targets[targetKeys[targetIndex]].estimate
        ));
        const outsideValues = hooks
            .filter((_, index) => !members.includes(index))
            .map(hook => hook.targets[targetKeys[targetIndex]].estimate);
        const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
        const difference = mean(memberValues) - mean(outsideValues);
        return {
            n: members.length,
            mean: mean(memberValues),
            median: memberValues[Math.floor(memberValues.length / 2)],
            difference,
            ci95: [difference - 1.5, difference + 1.5],
            effectSize: difference / 4,
            effectSizeDefined: true,
            perfectSeparation: false,
            p: 0.2,
            q: 0.7,
            qWithinFamily: 0.4,
        };
    };
    const families = familyKeys.map((key, familyIndex) => {
        const assignments = hooks.map((_, index) => (index + familyIndex) % 2);
        const clusters = [0, 1].map(clusterId => {
            const members = assignments
                .map((assignment, index) => assignment === clusterId ? index : -1)
                .filter(index => index >= 0);
            return {
                id: clusterId,
                label: `${key.replace(/_/g, ' ')} cluster ${clusterId + 1}`,
                definition: `Synthetic outcome-blind definition for ${key} cluster ${clusterId + 1}.`,
                terms: [key.replace(/_/g, ' '), `cluster ${clusterId + 1}`],
                n: members.length,
                share: members.length / hooks.length,
                medoids: members.slice(0, 3).map(index => hooks[index].id),
                outcomes: Object.fromEntries(targetKeys.map((targetKey, targetIndex) => [
                    targetKey,
                    outcome(members, targetIndex),
                ])),
            };
        });
        const validation = Object.fromEntries(targetKeys.map((targetKey, targetIndex) => [
            targetKey,
            {
                n: hooks.length,
                r2: 0.15 + familyIndex / 100,
                spearman: 0.25 + familyIndex / 100,
                mae: 2.5,
                auc80: 0.61,
                auc85: 0.58,
                oof: hooks.map(hook => hook.targets[targetKey].estimate - 0.5 + targetIndex / 10),
                protocol: 'synthetic grouped five-fold out-of-fold reconstruction',
            },
        ]));
        return {
            key,
            label: key.split('_').map(word => (
                word.charAt(0).toUpperCase() + word.slice(1)
            )).join(' '),
            definition: `Synthetic deterministic definition for ${key}.`,
            selection: {
                rule: 'synthetic stability selection',
                retainedPcaDimensions: 4,
                retainedVariance: 0.9,
                chosenK: 2,
                bestK: 2,
                cutoff: 0.02,
                candidates: [
                    {
                        k: 2,
                        silhouette: 0.31,
                        silhouetteSd: 0.02,
                        stability: 0.88,
                        minCluster: 6,
                        maxCluster: 6,
                    },
                ],
            },
            plane: {
                x: hooks.map((_, index) => (index * 83 + familyIndex * 17) % 1001),
                y: hooks.map((_, index) => (index * 137 + familyIndex * 29) % 1001),
            },
            assignments,
            clusters,
            validation,
        };
    });
    const interactions = Object.fromEntries(targetKeys.map(targetKey => [
        targetKey,
        [{
            analysisType: 'co_occurrence_enrichment',
            leftFamily: familyKeys[0],
            leftCluster: 0,
            leftLabel: families[0].clusters[0].label,
            rightFamily: familyKeys[1],
            rightCluster: 1,
            rightLabel: families[1].clusters[1].label,
            n: 4,
            mean: 84,
            difference: 3.2,
            hitRate80: 0.75,
            lift80: 1.5,
            p80: 0.04,
            hitRate85: 0.25,
            lift85: 2,
            p85: 0.08,
            q80: 0.2,
            q85: 0.3,
        }],
    ]));
    return {
        version: 1,
        productVersion: 'shorts-hook-operations-v1',
        analysisVersion: 'operations-lab-v1',
        generatedAt: 1_700_000_000_000,
        source: {
            key: 'synthetic-test-fixture',
            corpusHash: 'synthetic-corpus-hash',
            artifactInputHash: 'synthetic-input-hash',
            n: hooks.length,
            selection: 'Deterministic synthetic saved-hook bank',
            warning: 'Synthetic source warning for UI behavior only.',
        },
        provenance: {
            visionModel: 'synthetic-vision',
            visionTemperature: 0,
            promptHash: 'synthetic-prompt-hash',
            embeddingModel: 'gemini-embedding-2',
            embeddingDimensions: 1536,
            randomSeed: 20260724,
            outcomeBlindExtraction: true,
            outcomeBlindClustering: true,
            descriptorInput: 'Synthetic montage pixels only.',
            validation: 'Synthetic grouped five-fold reconstruction.',
            validationLimitations: 'Synthetic fixture for UI behavior only.',
            multipleTesting: 'Synthetic dependency-safe global BY correction.',
            interactionAnalysis: 'Synthetic descriptive co-occurrence only.',
        },
        targets: {
            together_keep: {
                label: 'Combined keep estimate',
                description: 'Existing visual + text keep-rate estimate.',
            },
            visual_keep: {
                label: 'Visual keep estimate',
                description: 'Existing image-only keep-rate estimate.',
            },
            text_keep: {
                label: 'Text keep estimate',
                description: 'Existing text-only keep-rate estimate.',
            },
        },
        summary: {
            hooks: hooks.length,
            descriptions: hooks.length,
            featureFamilies: families.length,
            targetSummaries: Object.fromEntries(targetKeys.map(targetKey => [
                targetKey,
                {
                    n: hooks.length,
                    mean: 79,
                    median: 79,
                    min: 72,
                    max: 87,
                    over80: 5,
                    over80Rate: 5 / hooks.length,
                    over85: 2,
                    over85Rate: 2 / hooks.length,
                },
            ])),
        },
        hooks,
        families,
        interactions,
        artifactHash: 'synthetic-artifact-hash',
    };
}

function fixtureStatus(overrides) {
    return {
        version: 1,
        productVersion: 'shorts-hook-operations-v1',
        stage: 'complete',
        updatedAt: Date.now(),
        message: 'Operations artifact is complete.',
        total: 12,
        described: 12,
        embeddedFeatures: 18,
        providerError: null,
        ...(overrides || {}),
    };
}

function fixturePrinciples(artifact) {
    const family = artifact.families[0];
    const effects = {
        together_keep: {
            n: 4,
            hits: 3,
            hitRate: 0.75,
            outsideHitRate: 0.25,
            baseRate: 0.25,
            lift: 3,
            riskRatio: 3,
            riskDifference: 0.5,
            keepDelta: 3.2,
            keepDeltaCi95: [1.1, 5.4],
            qBy: 0.01,
        },
        visual_keep: {
            n: 4,
            hits: 2,
            hitRate: 0.5,
            baseRate: 0.2,
            lift: 0.5,
            riskDifference: -0.3,
            keepDelta: -2.4,
            keepDeltaCi95: [-4.2, -0.4],
            qBy: 0.03,
        },
        text_keep: {
            n: 4,
            hits: 3,
            hitRate: 0.75,
            baseRate: 0.33,
            lift: 2.27,
            riskDifference: 0.42,
            keepDelta: 2.8,
            keepDeltaCi95: [0.9, 4.7],
            qBy: 0.02,
        },
    };
    Object.values(effects).forEach(effect => {
        effect.thresholdSensitivity = [82.5, 85, 87.5].map((threshold, index) => ({
            threshold,
            insideRisk: Math.max(0, effect.hitRate - index * 0.08),
            outsideRisk: Math.max(0, effect.baseRate - index * 0.03),
            riskDifference: (
                Math.max(0, effect.hitRate - index * 0.08)
                - Math.max(0, effect.baseRate - index * 0.03)
            ),
            foldValidation: { signConsistency: 0.8 },
        }));
    });
    const negativeEffects = Object.fromEntries(
        Object.entries(effects).map(([key, value]) => [key, {
            ...value,
            hits: 0,
            hitRate: 0,
            outsideHitRate: value.outsideHitRate,
            lift: 0,
            riskRatio: 0,
            riskDifference: -value.baseRate,
            keepDelta: -2.1,
            keepDeltaCi95: [-3.2, -1],
            qBy: 0.04,
        }]),
    );
    const conditionalModel = {
        status: 'ok',
        protocol: 'Synthetic grouped out-of-fold protocol for UI verification.',
        metrics: {
            n: artifact.hooks.length,
            eventRate: 0.25,
            auc: 0.72,
            prAuc: 0.48,
            brier: 0.14,
            logLoss: 0.42,
        },
        baselineMetrics: {
            n: artifact.hooks.length,
            eventRate: 0.25,
            auc: 0.5,
            prAuc: 0.25,
            brier: 0.19,
            logLoss: 0.56,
        },
        withinFoldDiscrimination: {
            protocol: 'Synthetic discrimination aggregated within held-out folds.',
            usableFolds: 5,
            totalFolds: 5,
            auc: 0.72,
            aucBaseline: 0.5,
            prAuc: 0.48,
            prAucBaseline: 0.25,
        },
        incremental: {
            auc: 0.22,
            prAuc: 0.23,
            brierImprovement: 0.05,
            logLossImprovement: 0.14,
        },
    };
    return {
        version: 1,
        artifactHash: 'synthetic-principles-hash',
        source: {
            n: artifact.hooks.length,
            threshold: 85,
            broadCorpus: {
                summary: 'Synthetic broad-corpus transport diagnostic for UI testing only.',
                n: 600,
            },
            targetSummaries: {
                together_keep: { positives85: 3, baseRate85: 0.25 },
                visual_keep: { positives85: 2, baseRate85: 0.2 },
                text_keep: { positives85: 4, baseRate85: 0.33 },
            },
        },
        measurementBoundary: {
            headline: 'Synthetic projected keep is not observed keep.',
            projected: 'Synthetic projected estimates are not observed swipe outcomes.',
            observed: 'Synthetic observed replication is intentionally low-power test data.',
        },
        method: {
            operationalDefinition: 'Synthetic outcome-blind ensemble used only to exercise the UI.',
            caveats: ['Synthetic fixture values do not represent scientific findings.'],
        },
        summary: {
            oneSentence: 'Synthetic summary: one positive and one negative principle are available for inspection.',
            together_keep: {
                oneSentence: 'Synthetic summary: one positive and one negative principle are available for inspection.',
            },
            visual_keep: {
                oneSentence: 'Synthetic visual summary changes direction with the visual effect.',
            },
            text_keep: {
                oneSentence: 'Synthetic text summary is scoped to the text target.',
            },
        },
        validation: {
            together_keep: {
                summary: 'Synthetic grouped combined validation record.',
                caveats: ['No real-world inference may be drawn from this fixture.'],
                conditionalModel,
            },
            visual_keep: {
                summary: 'Synthetic grouped visual validation record.',
                caveats: ['No real-world inference may be drawn from this fixture.'],
                conditionalModel,
            },
            text_keep: {
                summary: 'Synthetic grouped text validation record.',
                caveats: ['No real-world inference may be drawn from this fixture.'],
                conditionalModel,
            },
        },
        principles: [
            {
                id: 'synthetic-positive',
                label: 'Synthetic staged visual reveal',
                complementLabel: 'Synthetic reflected portrait',
                comparisonLabel: 'Synthetic staged visual reveal versus Synthetic reflected portrait',
                direction: 'positive',
                directions: {
                    together_keep: 'positive',
                    visual_keep: 'negative',
                    text_keep: 'positive',
                },
                familyKey: `residual__${family.key}`,
                familyLabel: `Topic-adjusted ${family.label}`,
                memberIndices: [0, 1, 2],
                effects,
                evidenceLevel: 'projected_fold_stable',
                evidenceLevels: {
                    together_keep: 'projected_fold_stable',
                    visual_keep: 'projected_associated',
                    text_keep: 'projected_fold_stable',
                },
                stability: {
                    representative: 0.91,
                    median: 0.88,
                },
                support: 4,
                algorithms: ['Synthetic spherical KMeans', 'Synthetic average linkage'],
                resolutions: [4, 6],
                supportingPartitions: [
                    {
                        algorithm: 'Synthetic spherical KMeans',
                        resolution: 'k=4',
                        support: 4,
                        stability: 0.91,
                    },
                ],
                labelEvidence: {
                    candidates: [
                        { label: 'synthetic reveal', cosine: 0.92, contrastiveCosine: 0.12 },
                        { label: 'synthetic contrast', cosine: 0.81, contrastiveCosine: 0.08 },
                    ],
                    complementCandidates: [
                        {
                            label: 'synthetic reflection',
                            cosine: 0.61,
                            complementCosine: 0.94,
                            contrastiveCosine: -0.33,
                        },
                    ],
                },
                representativeHooks: [0, 1],
                broadCorpus: {
                    status: 'ok',
                    nInside: 40,
                    nOutside: 160,
                    continuous: {
                        status: 'ok',
                        meanInside: 84,
                        meanOutside: 80,
                        meanDifference: 4,
                        ci95GroupedBootstrap: [1.5, 6.2],
                        bootstrapValidRepeats: 800,
                        bootstrapRequiredRepeats: 640,
                        foldSignConsistency: {
                            consistentFraction: 0.8,
                            foldsUsable: 5,
                        },
                    },
                    keepAtLeast85: {
                        status: 'ok',
                        rateInside: 0.30,
                        rateOutside: 0.10,
                        riskDifference: 0.20,
                        ci95RiskDifferenceGroupedBootstrap: [0.05, 0.32],
                        foldSignConsistency: {
                            consistentFraction: 0.8,
                            foldsUsable: 5,
                        },
                    },
                },
                observedDiagnostic: {
                    status: 'ok',
                    nInside: 20,
                    nOutside: 44,
                    continuous: {
                        status: 'ok',
                        meanInside: 82,
                        meanOutside: 80,
                        meanDifference: 2,
                        ci95GroupedBootstrap: [-0.4, 4.1],
                        bootstrapValidRepeats: 800,
                        bootstrapRequiredRepeats: 640,
                        foldSignConsistency: {
                            consistentFraction: 0.6,
                            foldsUsable: 5,
                        },
                    },
                    keepAtLeast85: {
                        status: 'ok',
                        rateInside: 0.15,
                        rateOutside: 0.09,
                        riskDifference: 0.06,
                        ci95RiskDifferenceGroupedBootstrap: [-0.03, 0.18],
                        foldSignConsistency: {
                            consistentFraction: 0.6,
                            foldsUsable: 5,
                        },
                    },
                },
                transport: {
                    selectedMatch: {
                        transportEligible: true,
                        jaccard: 0.78,
                        precisionOnSaved: 0.82,
                        recallOnSaved: 0.91,
                        intersectionSaved: 3,
                        principleSavedSupport: 3,
                    },
                    matchRobustness: {
                        partitionsMeetingFullMatchContract: 3,
                        partitionsMatched: 8,
                    },
                },
            },
            {
                id: 'synthetic-negative',
                label: 'Synthetic visually static setup',
                direction: 'negative',
                directions: {
                    together_keep: 'negative',
                    visual_keep: 'negative',
                    text_keep: 'negative',
                },
                familyKey: family.key,
                familyLabel: family.label,
                complementLabel: 'Synthetic active sequence',
                comparisonLabel: 'Synthetic visually static setup versus Synthetic active sequence',
                memberIndices: [3, 4],
                effects: negativeEffects,
                evidenceLevel: 'exploratory_projected',
                evidenceLevels: {
                    together_keep: 'exploratory_projected',
                    visual_keep: 'exploratory_projected',
                    text_keep: 'exploratory_projected',
                },
                stability: { score: 0.84 },
                support: 4,
                algorithms: ['Synthetic Ward'],
                resolutions: [5],
                labelEvidence: {
                    candidates: [{ label: 'synthetic static setup', cosine: 0.88 }],
                },
                representativeHooks: [3],
            },
        ],
        planes: {
            [`residual__${family.key}`]: {
                x: family.plane.x.map(value => 1000 - value),
                y: family.plane.y.slice(),
            },
        },
    };
}

async function mount(
    page,
    artifact,
    status,
    artifactStatus,
    failImages,
    principles,
    principlesStatus,
) {
    await page.route('**/api/raw/saved-montage/*', route => route.fulfill({
        status: failImages ? 503 : 200,
        contentType: failImages ? 'text/plain' : 'image/svg+xml',
        body: failImages ? 'unavailable' : [
            '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200">',
            '<rect width="200" height="200" fill="#176b87"/>',
            '<rect x="200" width="200" height="200" fill="#263d63"/>',
            '<rect x="400" width="200" height="200" fill="#406b57"/>',
            '<rect x="600" width="200" height="200" fill="#7b5942"/>',
            '<rect x="800" width="200" height="200" fill="#6b4d78"/>',
            '<text x="500" y="112" fill="white" font-size="34" text-anchor="middle">saved montage</text>',
            '</svg>',
        ].join(''),
    }));
    await page.setContent(
        `<!doctype html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <base href="${ORIGIN}/"><style>html,body{margin:0;min-height:100%;background:#07101a}#mount{min-height:100vh}</style>
        </head><body><main id="mount"></main></body></html>`,
        { waitUntil: 'domcontentloaded' },
    );
    const style = await page.addStyleTag({ path: CSS_PATH });
    await style.evaluate(element => {
        element.id = 'jarvis-operations-lab-styles';
    });
    await page.addScriptTag({
        content: `
            window.__opsFixture = ${JSON.stringify({
                artifact,
                status,
                artifactStatus: artifactStatus || 200,
                principles: principles || null,
                principlesStatus: principlesStatus || 200,
                principlesWorkerStatus: {
                    stage: principlesStatus === 202 ? 'building' : 'complete',
                    artifactHash: (
                        principles && principles.artifactHash
                    ) || '',
                    updatedAt: Date.now(),
                },
            })};
            window.__opsFetches = [];
            window.fetch = async function(url) {
                var fixture = window.__opsFixture;
                var path = String(url);
                window.__opsFetches.push(path);
                if (path.indexOf('/principles-status') >= 0) {
                    return new Response(JSON.stringify(fixture.principlesWorkerStatus), {
                        status: 200,
                        headers: {'Content-Type': 'application/json'}
                    });
                }
                if (path.indexOf('/principles') >= 0) {
                    return new Response(
                        JSON.stringify(
                            fixture.principlesStatus === 202
                                ? {version: 1, error: 'Synthetic principles artifact is building.'}
                                : (fixture.principles || {error: 'Synthetic principles artifact is absent.'})
                        ),
                        {
                            status: fixture.principlesStatus,
                            headers: {'Content-Type': 'application/json'}
                        }
                    );
                }
                if (path.indexOf('/status') >= 0) {
                    return new Response(JSON.stringify(fixture.status), {
                        status: 200,
                        headers: {'Content-Type': 'application/json'}
                    });
                }
                return new Response(
                    JSON.stringify(
                        fixture.artifactStatus === 202
                            ? {version: 1, stage: 'building', error: 'The complete Operations artifact is still building.'}
                            : fixture.artifact
                    ),
                    {
                        status: fixture.artifactStatus,
                        headers: {'Content-Type': 'application/json'}
                    }
                );
            };
        `,
    });
    await page.addScriptTag({ path: UI_PATH });
    await page.addScriptTag({
        content: `
            (function () {
                var mount = document.getElementById('mount');
                var ui;
                function repaint() {
                    mount.innerHTML = ui.render();
                    ui.afterRender();
                }
                ui = window.JarvisOperationsLab.create({
                    escapeHtml: function(value) {
                        return String(value == null ? '' : value)
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;')
                            .replace(/"/g, '&quot;')
                            .replace(/'/g, '&#39;');
                    },
                    formatNumber: function(value) {
                        var number = Math.round(Number(value) || 0);
                        return Math.abs(number) >= 1000
                            ? Math.round(number / 1000) + 'K'
                            : number.toLocaleString();
                    },
                    onRender: repaint
                });
                mount.addEventListener('click', function(event) { ui.handleClick(event); });
                mount.addEventListener('input', function(event) { ui.handleInput(event); });
                mount.addEventListener('change', function(event) { ui.handleChange(event); });
                mount.addEventListener('keydown', function(event) { ui.handleKeyDown(event); });
                repaint();
                window.__operationsUi = ui;
            }());
        `,
    });
}

async function waitForLoaded(page) {
    await page.getByRole('heading', { name: 'Opening Operations Atlas' }).waitFor();
    await page.getByText('Measurement boundary', { exact: true }).waitFor();
    await page.getByText('Keep is an existing embedding estimate, not an observed YouTube swipe ratio.', {
        exact: true,
    }).waitFor();
}

async function verifyPrinciples(page, artifact, principles) {
    await page.getByText(principles.summary.oneSentence, { exact: true }).waitFor();
    const tabs = page.locator('[data-ops-view]');
    assert.strictEqual(
        await tabs.first().getAttribute('data-ops-view'),
        'principles',
        'The fixed-85 principles tab must be first',
    );
    assert(
        await tabs.first().evaluate(element => element.classList.contains('is-active')),
        'The principles tab must be the default active view',
    );
    await expectText(tabs.first(), '85% principles');
    assert.strictEqual(
        await page.locator('[data-ops-threshold], [data-ops-threshold-number]').count(),
        0,
        'The fixed-85 view must hide the adjustable threshold controls',
    );
    await page.getByText('85% fixed', { exact: true }).waitFor();
    await page.getByText('Projected is not observed.', { exact: true }).waitFor();
    await page.getByText(
        /Synthetic projected estimates are not observed swipe outcomes/,
    ).waitFor();
    await page.getByRole('heading', {
        name: 'Patterns seen more often above 85%',
    }).waitFor();
    await page.getByRole('heading', {
        name: 'Patterns seen less often above 85%',
    }).waitFor();
    await page.getByText('Hits / N', { exact: true }).first().waitFor();
    await page.getByText('Absolute difference', { exact: true }).first().waitFor();
    await page.getByText('Mean keep delta', { exact: true }).first().waitFor();
    await page.getByText('Global BY q', { exact: true }).first().waitFor();
    await page.getByText('Evidence tier', { exact: true }).first().waitFor();
    await page.getByRole('heading', {
        name: 'Do the discovered components predict the 85% surrogate?',
    }).waitFor();
    await page.getByText('Within-fold ROC AUC', { exact: true }).waitFor();
    await page.getByText('Model 0.720 / reference 0.500', { exact: true }).waitFor();
    await page.getByText('baseline 0.1900', { exact: true }).waitFor();

    const fetches = await page.evaluate(() => window.__opsFetches.slice());
    const artifactRequest = fetches.findIndex(url => url.includes('/artifact'));
    const principlesStatusRequest = fetches.findIndex(
        url => url.includes('/principles-status'),
    );
    const principlesRequest = fetches.findIndex(
        url => /\/operations-lab\/principles(?:\?|$)/.test(url),
    );
    assert(artifactRequest >= 0, 'The canonical Operations artifact must be fetched');
    assert(
        principlesStatusRequest > artifactRequest,
        'Principles status must be fetched after the canonical artifact',
    );
    assert(principlesRequest > artifactRequest, 'Principles must be fetched lazily after the canonical artifact');

    await page.locator('[data-ops-target="visual_keep"]').click();
    await page.getByText(
        principles.summary.visual_keep.oneSentence,
        { exact: true },
    ).waitFor();
    const positiveCard = page.locator('[data-ops-principle="synthetic-positive"]');
    await positiveCard.getByText('2 / 4', { exact: true }).waitFor();
    await positiveCard.getByText('Lower 85% association', { exact: true }).waitFor();
    await positiveCard.getByText(
        'Compared with Synthetic reflected portrait',
        { exact: true },
    ).waitFor();
    await positiveCard.click();
    await page.getByRole('heading', {
        name: 'Synthetic staged visual reveal versus Synthetic reflected portrait',
        exact: true,
    }).waitFor();
    assert.strictEqual(
        await page.locator('#ops-principle-detail').evaluate(
            element => document.activeElement === element,
        ),
        true,
        'Opening a principle must move keyboard focus into its evidence detail',
    );
    const detailViewport = await page.locator('#ops-principle-detail').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, viewport: window.innerHeight };
    });
    assert(
        detailViewport.top >= -1 && detailViewport.top < detailViewport.viewport,
        `Principle detail was not brought into view: ${JSON.stringify(detailViewport)}`,
    );
    assert.strictEqual(
        await page.locator('[data-ops-principle-member="true"]').count(),
        3,
        'The persisted family plane must highlight every supplied member index',
    );
    assert.strictEqual(
        await page.locator('.ops-principle-detail .ops-plane').getAttribute('role'),
        'group',
        'Interactive semantic planes must expose their descendant point buttons',
    );
    assert.strictEqual(
        await page.locator('.ops-principle-detail [data-ops-plane-family]').getAttribute('data-ops-plane-family'),
        `residual__${artifact.families[0].key}`,
        'Residualized principles must use their exact residual plane',
    );
    await page.getByText('Algorithm / resolution ledger', { exact: true }).waitFor();
    await page.getByText('Synthetic spherical KMeans', { exact: true }).waitFor();
    await page.getByText('synthetic reveal', { exact: true }).waitFor();
    await page.getByText('synthetic reflection', { exact: true }).waitFor();
    await page.getByText('0.9200', { exact: true }).waitFor();
    await page.getByText('0.1200', { exact: true }).waitFor();
    await page.getByText('0.9400', { exact: true }).waitFor();
    await page.getByText('0.3300', { exact: true }).waitFor();
    await page.getByText('Threshold sensitivity', { exact: true }).waitFor();
    await page.getByText('82.5%', { exact: true }).waitFor();
    assert.strictEqual(
        await page.locator('.ops-principle-montage').count(),
        2,
        'Representative montage hooks must be reused from canonical hook indices',
    );
    await page.getByText('Broad-corpus diagnostic', { exact: true }).waitFor();
    await page.getByText('Observed keep diagnostic', { exact: true }).waitFor();
    const broadDiagnostic = page.locator('.ops-principle-diagnostic').first();
    await broadDiagnostic.getByText('+4.00 pts', { exact: false }).waitFor();
    await broadDiagnostic.getByText('30.0% / 10.0%', { exact: true }).waitFor();
    await broadDiagnostic.getByText('+20.0 pp', { exact: false }).waitFor();
    await page.getByText('Shared-space transport gate', { exact: true }).waitFor();
    await page.getByText('Eligible', { exact: true }).waitFor();
    await page.getByText('Exact method boundary and caveats', { exact: true }).waitFor();
    await page.getByText(
        'Synthetic fixture values do not represent scientific findings.',
        { exact: true },
    ).waitFor();

    await page.locator('[data-ops-close-principle]').click();
    const negativeCard = page.locator('[data-ops-principle="synthetic-negative"]');
    await negativeCard.focus();
    await negativeCard.press('Enter');
    await page.getByRole('heading', {
        name: 'Synthetic visually static setup versus Synthetic active sequence',
        exact: true,
    }).waitFor();
    await page.locator('[data-ops-close-principle]').click();
    await page.locator('[data-ops-target="together_keep"]').click();
    await page.getByText(principles.summary.oneSentence, { exact: true }).waitFor();
}

async function verifyDesktop(page, artifact, principles) {
    await waitForLoaded(page);
    await verifyPrinciples(page, artifact, principles);
    if (process.env.OPERATIONS_UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.OPERATIONS_UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
            path: path.join(
                process.env.OPERATIONS_UI_SCREENSHOT_DIR,
                'operations-principles-desktop.png',
            ),
            fullPage: true,
        });
    }
    await page.locator('[data-ops-view="overview"]').click();
    await page.getByText('gemini-embedding-2 / 1,536D', { exact: true }).waitFor();
    await page.getByText(`${artifact.hooks.length} hooks`, { exact: true }).waitFor();
    await page.getByRole('heading', {
        name: 'Surrogate reconstruction against existing keep estimates',
    }).waitFor();
    await page.getByText('Source contract', { exact: true }).waitFor();
    const provenanceValues = page.locator('.ops-definition-list dd');
    await provenanceValues.filter({
        hasText: 'Durable saved-hook corpus with explicit selection provenance.',
    }).waitFor();
    await provenanceValues.filter({
        hasText: 'Surrogate reconstruction of existing keep estimates, not observed swipe:',
    }).waitFor();
    await provenanceValues.filter({
        hasText: 'targetNature: Existing keep estimates; not observed swipe.',
    }).waitFor();

    await page.locator('[data-ops-view="families"]').click();
    await page.getByRole('heading', { name: artifact.families[0].label, exact: true }).waitFor();
    await page.getByText('Global BY q', { exact: true }).first().waitFor();
    assert.strictEqual(
        await page.getByText('Global BH q', { exact: true }).count(),
        0,
        'Global correction must be labeled BY, not BH',
    );
    await page.getByText('AUC at 80', { exact: true }).waitFor();
    await page.getByText('AUC at 85', { exact: true }).waitFor();
    await page.getByRole('heading', {
        name: 'Surrogate reconstruction vs existing estimate',
    }).waitFor();
    assert.strictEqual(
        await page.locator('.ops-family-list > button').count(),
        artifact.families.length,
        'Every persisted feature family must be selectable',
    );
    assert.strictEqual(
        await page.locator('.ops-plane [data-ops-plane-point]').count(),
        artifact.hooks.length,
        'The semantic plane must render every persisted hook',
    );

    await page.locator('.ops-plane [data-ops-plane-point]').first().focus();
    await page.locator('.ops-plane [data-ops-plane-point]').first().press('Enter');
    await page.getByText('Selected plane point', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Inspect hook' }).click();
    await page.getByText('Complete feature ledger', { exact: true }).waitFor();
    assert.strictEqual(
        await page.locator('.ops-membership-card').count(),
        artifact.families.length,
        'Hook detail must expose every family membership',
    );
    const detailImage = page.locator('.ops-hook-detail img').first();
    await detailImage.waitFor();
    await page.waitForFunction(
        image => image.complete && image.naturalWidth > 0,
        await detailImage.elementHandle(),
    );

    const coOccurrenceTab = page.locator('[data-ops-view="interactions"]');
    await expectText(coOccurrenceTab, 'Co-occurrence');
    await coOccurrenceTab.click();
    await page.getByRole('heading', {
        name: 'Co-occurrence across feature-family clusters',
    }).waitFor();
    await page.getByText('2,989 retained tests', { exact: true }).waitFor();
    const coOccurrenceCopy = page.locator('.ops-section-copy').filter({
        hasText: 'descriptive enrichment patterns within this saved-hook bank',
    });
    await coOccurrenceCopy.waitFor();
    const normalizedCoOccurrenceCopy = String(await coOccurrenceCopy.textContent())
        .replace(/\s+/g, ' ')
        .trim();
    assert(
        normalizedCoOccurrenceCopy.includes('not causal effects or statistical synergy'),
        'Co-occurrence copy must reject causal or statistical-synergy interpretation',
    );
    assert(
        normalizedCoOccurrenceCopy.includes(
            'one dependency-safe global family across all targets',
        ),
        'Co-occurrence copy must define the shared BY correction family',
    );
    const interactionRows = page.locator('tr[data-ops-interaction]');
    assert(await interactionRows.count() > 0, 'The interaction table must render stored combinations');
    await interactionRows.first().focus();
    await interactionRows.first().press('Enter');
    await page.getByText('Selected co-occurrence joint cell', { exact: true }).waitFor();
    await page.getByText('Global BY q80', { exact: true }).waitFor();
    await page.getByText('Global BY q85', { exact: true }).waitFor();

    await page.locator('[data-ops-target="visual_keep"]').click();
    await page.locator('[data-ops-threshold-number]').fill('85');
    await page.locator('[data-ops-threshold-number]').press('Enter');
    await page.getByText('Hit rate at 85%', { exact: false }).first().waitFor();

    const overflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        root: document.querySelector('.operations-lab').scrollWidth,
        client: document.querySelector('.operations-lab').clientWidth,
    }));
    assert(
        overflow.document <= overflow.viewport + 1,
        `Desktop document overflowed: ${JSON.stringify(overflow)}`,
    );
    assert(
        overflow.root <= overflow.client + 1,
        `Desktop Operations root overflowed: ${JSON.stringify(overflow)}`,
    );
}

async function verifyMobile(page, artifact, principles) {
    await waitForLoaded(page);
    await page.getByText(principles.summary.oneSentence, { exact: true }).waitFor();
    assert.strictEqual(
        await page.locator('[data-ops-threshold], [data-ops-threshold-number]').count(),
        0,
        'Mobile principles must retain the fixed threshold',
    );
    await page.locator('[data-ops-principle="synthetic-positive"]').click();
    await page.getByRole('heading', {
        name: 'Synthetic staged visual reveal versus Synthetic reflected portrait',
        exact: true,
    }).waitFor();
    const principlesOverflow = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        root: document.querySelector('.operations-lab').scrollWidth,
        client: document.querySelector('.operations-lab').clientWidth,
    }));
    assert(
        principlesOverflow.document <= principlesOverflow.viewport + 1,
        `Mobile principles document overflowed: ${JSON.stringify(principlesOverflow)}`,
    );
    assert(
        principlesOverflow.root <= principlesOverflow.client + 1,
        `Mobile principles root overflowed: ${JSON.stringify(principlesOverflow)}`,
    );
    if (process.env.OPERATIONS_UI_SCREENSHOT_DIR) {
        await page.screenshot({
            path: path.join(
                process.env.OPERATIONS_UI_SCREENSHOT_DIR,
                'operations-principles-mobile.png',
            ),
            fullPage: true,
        });
    }
    await page.locator('[data-ops-close-principle]').click();
    await page.locator('[data-ops-view="hooks"]').click();
    await page.getByRole('heading', { name: 'Every analyzed opening' }).waitFor();
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(50);
    const dimensions = await page.evaluate(() => ({
        before: window.scrollY,
        after: window.scrollY,
        height: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        rootWidth: document.querySelector('.operations-lab').scrollWidth,
        rootClientWidth: document.querySelector('.operations-lab').clientWidth,
    }));
    assert(
        dimensions.height > dimensions.viewportHeight,
        `Mobile hook library should have scrollable content: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.after > before,
        `Mobile page did not scroll: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.documentWidth <= dimensions.viewportWidth + 1,
        `Mobile document overflowed horizontally: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.rootWidth <= dimensions.rootClientWidth + 1,
        `Mobile Operations root overflowed: ${JSON.stringify(dimensions)}`,
    );
    assert.strictEqual(
        await page.locator('.ops-hook-card').count(),
        artifact.hooks.length,
        'The mini fixture should show every hook card on mobile',
    );
}

async function verifyCompactWidth(page) {
    await waitForLoaded(page);
    await page.locator('[data-ops-principle="synthetic-positive"]').click();
    const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        tables: Array.from(
            document.querySelectorAll(
                '#ops-principle-detail .ops-compact-table-wrap',
            ),
        ).map(element => ({
            scroll: element.scrollWidth,
            client: element.clientWidth,
        })),
    }));
    assert(
        dimensions.document <= dimensions.viewport + 1,
        `320px document overflowed: ${JSON.stringify(dimensions)}`,
    );
    assert(
        dimensions.tables.every(table => table.scroll <= table.client + 1),
        `320px evidence table hid columns: ${JSON.stringify(dimensions)}`,
    );
}

async function verifyBlockedState(page) {
    await waitForLoaded(page);
    await page.getByText('Operations artifact pending', { exact: true }).waitFor();
    const providerError = page.locator('.ops-provider-error');
    await providerError.waitFor();
    assert(
        (await providerError.textContent()).includes(
            'Gemini credits or quota are blocking description extraction.',
        ),
        'The provider error must expose the actionable credit message',
    );
    assert(
        (await providerError.textContent()).includes('credits_or_quota_exhausted'),
        'The provider error must expose its classified error kind',
    );
}

async function verifyImageFailure(page) {
    await waitForLoaded(page);
    await page.locator('[data-ops-view="hooks"]').click();
    await page.locator('.ops-image-failure').first().waitFor({ timeout: 5000 });
    await page.getByText('Image failed to load', { exact: true }).first().waitFor();
}

async function verifyPrinciplesRetry(page, principles) {
    await waitForLoaded(page);
    await page.getByRole('heading', {
        name: 'No principles artifact is available yet',
    }).waitFor();
    await page.getByText('Synthetic principles endpoint unavailable.', { exact: true }).waitFor();
    await page.evaluate(nextArtifact => {
        window.__opsFixture.principles = nextArtifact;
        window.__opsFixture.principlesStatus = 200;
    }, principles);
    await page.getByRole('button', { name: 'Retry principles' }).click();
    await page.getByText(principles.summary.oneSentence, { exact: true }).waitFor();
}

async function verifyPrinciplesStaleFallback(page, principles) {
    await waitForLoaded(page);
    await page.getByText(principles.summary.oneSentence, { exact: true }).waitFor();
    await page.evaluate(() => {
        window.__opsFixture.principlesStatus = 503;
        window.__opsFixture.principlesWorkerStatus = {
            stage: 'complete',
            artifactHash: 'newer-principles-hash',
            updatedAt: Date.now(),
        };
    });
    await page.locator('[data-ops-refresh]').click();
    await page.getByText(
        'Showing the last verified principles artifact.',
        { exact: true },
    ).waitFor();
    await page.getByText(principles.summary.oneSentence, { exact: true }).waitFor();
    await page.locator('[data-ops-principle="synthetic-positive"]').waitFor();
    const requests = await page.evaluate(() => window.__opsFetches.slice());
    assert(
        requests.some(url => (
            url.includes('/operations-lab/principles?artifactHash=newer-principles-hash')
        )),
        'A refresh must request the artifact hash declared by principles-status',
    );
}

async function expectText(locator, expected) {
    await locator.waitFor();
    assert.strictEqual(
        String(await locator.textContent()).trim(),
        expected,
        `Expected "${expected}" but found "${await locator.textContent()}"`,
    );
}

async function main() {
    const uiSource = fs.readFileSync(UI_PATH, 'utf8');
    assert(
        uiSource.includes("const STATUS_API = '/api/shortsquant/operations-lab/status'"),
        'The existing Operations status route must remain unchanged',
    );
    assert(
        uiSource.includes("const ARTIFACT_API = '/api/shortsquant/operations-lab/artifact'"),
        'The existing Operations artifact route must remain unchanged',
    );
    assert(
        uiSource.includes("const PRINCIPLES_API = '/api/shortsquant/operations-lab/principles'"),
        'The principles view must use the dedicated lazy endpoint',
    );
    assert(
        uiSource.includes("const PRINCIPLES_STATUS_API = '/api/shortsquant/operations-lab/principles-status'"),
        'The principles view must follow the dedicated artifact status/hash',
    );
    assert(
        uiSource.includes("['principles', '85% principles']"),
        'The fixed-85 principles tab must remain the first named view',
    );
    assert(
        uiSource.includes("['interactions', 'Co-occurrence']"),
        'The compatibility view key must retain the new visible Co-occurrence label',
    );
    assert(
        uiSource.includes('(artifact().interactions || {})'),
        'The persisted interactions artifact key must remain unchanged',
    );
    const artifact = fs.existsSync(ARTIFACT_PATH)
        ? JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'))
        : fixtureOperationsArtifact();
    const richerArtifact = JSON.parse(JSON.stringify(artifact));
    richerArtifact.source.description = 'Durable saved-hook corpus with explicit selection provenance.';
    richerArtifact.source.observationUnit = 'saved hook';
    richerArtifact.provenance.validation = {
        summary: 'Five-fold cross-fitted ridge by feature family.',
        targetNature: 'Existing keep estimates; not observed swipe.',
        folds: 5,
    };
    const baseInteractions = richerArtifact.interactions.together_keep;
    richerArtifact.interactions.together_keep = Array.from(
        { length: 2989 },
        (_, index) => ({ ...baseInteractions[index % baseInteractions.length] }),
    );
    const principles = fixturePrinciples(richerArtifact);
    const browser = await chromium.launch({ headless: true });
    try {
        const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const desktopErrors = [];
        desktop.on('console', message => {
            if (message.type() === 'error') desktopErrors.push(message.text());
        });
        desktop.on('pageerror', error => desktopErrors.push(error.message));
        await mount(desktop, richerArtifact, fixtureStatus({
            artifactHash: richerArtifact.artifactHash,
        }), 200, false, principles, 200);
        await verifyDesktop(desktop, richerArtifact, principles);
        assert.deepStrictEqual(desktopErrors, [], `Desktop console errors: ${desktopErrors.join('\n')}`);

        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const mobileErrors = [];
        mobile.on('console', message => {
            if (message.type() === 'error') mobileErrors.push(message.text());
        });
        mobile.on('pageerror', error => mobileErrors.push(error.message));
        await mount(mobile, artifact, fixtureStatus({
            artifactHash: artifact.artifactHash,
        }), 200, false, principles, 200);
        await verifyMobile(mobile, artifact, principles);
        assert.deepStrictEqual(mobileErrors, [], `Mobile console errors: ${mobileErrors.join('\n')}`);

        const compact = await browser.newPage({ viewport: { width: 320, height: 720 } });
        await mount(compact, artifact, fixtureStatus({
            artifactHash: artifact.artifactHash,
        }), 200, false, principles, 200);
        await verifyCompactWidth(compact);

        const blocked = await browser.newPage({ viewport: { width: 1000, height: 760 } });
        await mount(blocked, null, fixtureStatus({
            stage: 'blocked',
            total: 984,
            described: 325,
            message: 'Gemini credits or quota are blocking description extraction.',
            providerError: {
                provider: 'Gemini',
                kind: 'credits_or_quota_exhausted',
                httpStatus: 429,
                message: 'Gemini credits or quota are blocking description extraction.',
                retrySeconds: 60,
            },
        }), 202);
        await verifyBlockedState(blocked);

        const failedImages = await browser.newPage({ viewport: { width: 1000, height: 760 } });
        await mount(failedImages, artifact, fixtureStatus({
            artifactHash: artifact.artifactHash,
        }), 200, true, principles, 200);
        await verifyImageFailure(failedImages);

        const retry = await browser.newPage({ viewport: { width: 1000, height: 760 } });
        await mount(retry, artifact, fixtureStatus({
            artifactHash: artifact.artifactHash,
        }), 200, false, {
            error: 'Synthetic principles endpoint unavailable.',
        }, 404);
        await verifyPrinciplesRetry(retry, principles);

        const stale = await browser.newPage({ viewport: { width: 1000, height: 760 } });
        await mount(stale, artifact, fixtureStatus({
            artifactHash: artifact.artifactHash,
        }), 200, false, principles, 200);
        await verifyPrinciplesStaleFallback(stale, principles);

        console.log(JSON.stringify({
            ok: true,
            hooks: artifact.hooks.length,
            families: artifact.families.length,
            desktop: 'passed',
            mobile: 'passed',
            compact320: 'passed',
            blockedCredits: 'passed',
            imageFailure: 'passed',
            principlesRetry: 'passed',
            principlesStaleFallback: 'passed',
        }));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error && error.stack || error);
    process.exit(1);
});
