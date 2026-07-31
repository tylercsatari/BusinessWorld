#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'buildings/jarvis/jarvis-retention.js');
const displayContract = require('../embedding-display-contract');
const scoreLedgerContract = require(
    '../buildings/jarvis/shorts-score-ledger'
);
const featureContract = require(
    '../buildings/jarvis/saved-channel-feature-contract.json'
);
const {
    scoreLedgerFromFeatures,
} = require('./fixtures/score-ledger-fixture');

function canonicalSavedHookFixture() {
    const neighbors = [
        { id: 'video-a', sim: 0.93 },
        { id: 'video-b', sim: 0.87 },
    ];
    const values = {
        keep: [81, 84],
        ret5: [74, 77],
        views: [12_000_000, 89],
        realviews: [8_000_000, null],
        outlier: [4.1, 75],
        gt10M: [0.63, 88],
    };
    const offsets = {
        visual: -8,
        text: -3,
        together: 0,
        novelty: 0,
    };
    const features = Object.fromEntries(
        scoreLedgerContract.FEATURE_DEFINITIONS.map(
            definition => {
                const base = values[definition.target];
                const offset = offsets[definition.group] || 0;
                return [
                    definition.key,
                    [
                        base[0] + (
                            definition.target === 'views'
                            || definition.target === 'realviews'
                                ? offset * 100_000
                                : definition.target === 'gt10M'
                                    ? offset / 100
                                : offset
                        ),
                        base[1] == null
                            ? null
                            : base[1] + offset,
                    ],
                ];
            }
        )
    );
    const scoreLedger = scoreLedgerFromFeatures(features);
    const steer = Object.fromEntries(
        scoreLedger.entries
            .filter(entry => entry.source === 'steer')
            .map(entry => [
                entry.source_key,
                {
                    coordinate_id: entry.coordinate_id,
                    feature_key: entry.feature_key,
                    group: entry.group,
                    target: entry.target,
                    est: entry.value,
                    pctile: entry.percentile,
                    kind: 'fixture',
                },
            ])
    );
    const revisionFingerprint = '1'.repeat(64);
    const record = {
        id: 'saved123',
        title: 'A complete saved hook',
        kind: 'scored',
        score_domain: 'shorts',
        savedAt: 123456789,
        text: 'This machine does something impossible.',
        transcript: 'This machine does something impossible.',
        hasMontage: true,
        silent: false,
        indicators: {
            nov_vis_global: 0.1,
            nov_txt_global: 0.2,
            nov_tog_global: 0.3,
        },
        steer,
        features,
        score_ledger: scoreLedger,
        emb_preview: {
            visual: Array(48).fill(0.1),
            text: Array(48).fill(0.3),
            together: Array(48).fill(0.5),
        },
        channels: {
            visual: { neighbors },
            text: { neighbors },
            together: { neighbors },
        },
        visual_keep_forecast: {
            coordinate_id:
                scoreLedgerContract.GOVERNANCE.coordinates
                    .visualKeepForecast.id,
            est: 76.4,
            raw: 76.4,
            pctile: null,
            kind: 'keep_rate_percent',
            unit: 'percent',
            calibration_scope: 'pooled_global',
            account_model: null,
            source: 'live_frozen_model_score',
            model_artifact_sha256: 'a'.repeat(64),
            model_manifest_sha256: 'b'.repeat(64),
            model_artifact_key:
                'raw/predictor-lab/visual-keep-model/by-sha256/'
                + `${'a'.repeat(64)}.json`,
            model_artifact_canonical_key:
                'raw/predictor-lab/visual-keep-model-v1.json',
            model_manifest_key:
                'raw/predictor-lab/visual-keep-model-v1.manifest.json',
            producer_source_sha256: 'd'.repeat(64),
            feature_contract_version: featureContract.version,
            feature_contract_sha256:
                scoreLedgerContract.FEATURE_CONTRACT_SHA256,
            input: 'first-five-second five-frame montage embedding only',
        },
        creator_adaptive_keep_forecast: {
            coordinate_id:
                scoreLedgerContract.GOVERNANCE.coordinates
                    .creatorAdaptiveKeepForecast.id,
            profile_account: 'tyler',
            raw: 77.1,
            model_artifact_sha256: 'c'.repeat(64),
        },
        input_manifest: {
            domain: 'shorts_raw',
            scorer: 'raw_upload.py',
            embedding_model: 'gemini-embedding-2',
            display_contract_version: featureContract.version,
            display_preference: ['together', 'text', 'visual'],
            transcript_used: true,
            creator_profile: 'tyler',
            revision_fingerprint: revisionFingerprint,
            embedding_input_fingerprint: '2'.repeat(64),
            score_input_fingerprint: '3'.repeat(64),
            feature_contract_sha256:
                scoreLedgerContract.FEATURE_CONTRACT_SHA256,
            coordinate_governance_sha256:
                scoreLedgerContract.GOVERNANCE_SHA256,
            scorer_revisions: {
                artifacts: {
                    'raw/predictor-lab/visual-keep-model-v1.manifest.json': {
                        sha256: 'b'.repeat(64),
                    },
                },
            },
            channels: {
                visual: {
                    present: true,
                    input: '5-frame montage only',
                    image: 'five frames',
                    text: '',
                },
                text: {
                    present: true,
                    input: 'first-5-second transcript only',
                    image: '',
                    text: 'This machine does something impossible.',
                },
                together: {
                    present: true,
                    input: '5-frame montage plus first-5-second transcript',
                    image: 'five frames',
                    text: 'This machine does something impossible.',
                },
            },
        },
    };
    record.score_record_sha256 =
        scoreLedgerContract.scoreRecordBindingSha256(record);
    record.score_record_validation = {
        state: 'verified',
        valid: true,
        recorded_sha256: record.score_record_sha256,
        calculated_sha256: record.score_record_sha256,
    };
    record.score_ledger_validation = {
        state: 'canonical-valid',
        valid: true,
        ledger_sha256: scoreLedger.ledger_sha256,
        errors: [],
    };
    const compact = displayContract.compactSavedHookRecord(
        record
    );
    if (
        !displayContract.validateCompactSavedHookRecord(compact)
        || !displayContract.validateCompactSavedHookSource(
            compact,
            record
        )
    ) {
        throw new Error(
            'mobile saved-hook fixture is not canonically bound'
        );
    }
    return {
        compact,
        featureContract,
        liveContract: {
            revision_fingerprint: revisionFingerprint,
            feature_contract_sha256:
                scoreLedgerContract.FEATURE_CONTRACT_SHA256,
            coordinate_governance_sha256:
                scoreLedgerContract.GOVERNANCE_SHA256,
            creator_profiles: ['tyler'],
            coordinates: {
                visual_keep_forecast:
                    scoreLedgerContract.GOVERNANCE.coordinates
                        .visualKeepForecast.id,
            },
            visual_keep_model_artifact_sha256: 'a'.repeat(64),
            visual_keep_model_manifest_sha256: 'b'.repeat(64),
        },
        record,
    };
}

function plotBundle(channel) {
    const names = ['keep', 'ret5', 'views', 'realviews', 'outlier', 'hi10m'];
    return {
        version: 1,
        channel,
        n: 66157,
        missing: [],
        plot_artifact: {
            manifest_sha256: '8'.repeat(64),
            pointer_sha256: '9'.repeat(64),
            artifact_sha256: {
                visual: 'a',
                text: 'b',
                together: 'c',
            }[channel].repeat(64),
        },
        plots: Object.fromEntries(names.map((name, projectionIndex) => [name, {
            points: Array.from({ length: 96 }, (_, index) => [
                10 + index * 10,
                930 - ((index * 71 + projectionIndex * 29) % 860),
                name === 'hi10m' ? Number(index % 4 === 0) : 20 + index * 3,
            ]),
            zMin: name === 'hi10m' ? 0 : 20,
            zMax: name === 'hi10m' ? 1 : 89,
            colorKind: name === 'hi10m' ? 'binary' : name.includes('views') ? 'views' : 'metric',
            marker: { x: 710, y: 340, percentile: 84.2 },
        }])),
    };
}

async function main() {
    const fixture = canonicalSavedHookFixture();
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
        await page.route('http://quant.test/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname.startsWith('/api/raw/saved-montage/')) {
                return route.fulfill({
                    status: 200,
                    contentType: 'image/gif',
                    body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'),
                });
            }
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main id="root"></main>' });
        });
        await page.goto('http://quant.test/');
        await page.evaluate(({
            compact,
            featureContract: contractFixture,
            liveContract,
            record,
        }) => {
            window.__quantCalls = [];
            window.fetch = async (input, options) => {
                const url = new URL(String(input), location.href);
                window.__quantCalls.push({ path: url.pathname, search: url.search, method: String(options && options.method || 'GET') });
                let body;
                if (url.pathname === '/api/indicators/registry') body = { indicators: [], meta: { targets: [] } };
                else if (url.pathname === '/buildings/jarvis/saved-channel-feature-contract.json') body = contractFixture;
                else if (url.pathname === '/api/raw/scorer-contract') body = liveContract;
                else if (url.pathname === '/api/raw/saved-hooks') body = { hooks: [compact], folders: [] };
                else if (url.pathname === '/api/raw/saved-hook/saved123') body = record;
                else if (url.pathname === '/api/raw/plot') body = window[`__${url.searchParams.get('channel')}Plot`];
                else if (url.pathname === '/api/hooks/grind/runs') body = { runs: [] };
                else if (url.pathname === '/api/hooks/warmup') body = { ok: true, fired: false };
                else body = {};
                return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };
        }, fixture);
        await page.evaluate(({ visual, text, together }) => {
            window.__visualPlot = visual;
            window.__textPlot = text;
            window.__togetherPlot = together;
        }, {
            visual: plotBundle('visual'),
            text: plotBundle('text'),
            together: plotBundle('together'),
        });
        await page.addScriptTag({ path: MODULE });
        await page.evaluate(() => window.JarvisRetention.mountExperiment(document.getElementById('root')));
        await page.locator('[data-savedopen="saved123"]').waitFor();
        await page.locator('[data-savedopen="saved123"]').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-compact-quant-plot]').length === 18);

        const result = await page.evaluate(() => ({
            calls: window.__quantCalls,
            compactPlots: document.querySelectorAll('[data-compact-quant-plot]').length,
            circles: document.querySelectorAll('[data-compact-quant-plot] circle').length,
            domNodes: document.querySelectorAll('*').length,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            scoreText: document.body.innerText.includes('A complete saved hook') && document.body.innerText.toLowerCase().includes('keep rate'),
            frozenForecastText: document.querySelector('[data-visual-keep-forecast]')?.textContent || '',
            parity: window.BusinessWorldEmbeddingParityAudit(document),
        }));
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/map').length, 0, 'score details must never request a complete Raw map');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/plot').length, 3, 'one compact request per embedded input channel');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/saved-hook/saved123').length, 1, 'saved score should hydrate once');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/scorer-contract').length, 2, 'saved score must use the mount-time contract load plus one forced revision check before opening');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/embed-montage').length, 0, 'a current canonical saved score must not be re-scored');
        assert.strictEqual(result.calls.filter(call => call.path === '/api/raw/saved-montage/saved123').length, 0, 'image delivery must not block saved statistics');
        assert.strictEqual(result.compactPlots, 18);
        assert(result.circles < 2000, `compact plots created too many circles (${result.circles})`);
        assert(result.domNodes < 10000, `mobile detail DOM is unbounded (${result.domNodes})`);
        assert(result.scrollWidth <= result.clientWidth, 'mobile score detail introduced horizontal overflow');
        assert(result.scoreText, 'the complete score read-out did not render');
        assert(
            result.frozenForecastText.includes('76.4%'),
            'the frozen visual keep raw value is missing from the normal '
                + `score detail: ${result.frozenForecastText}`
        );
        assert(result.parity.ok, `saved-hook card/detail embedding parity failed: ${JSON.stringify(result.parity.conflicts)}`);
        assert(result.parity.nodes >= 18, `saved-hook detail exposed only ${result.parity.nodes} machine-readable embedding identities`);
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
