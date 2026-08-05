#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const ui = fs.readFileSync(
    path.join(root, 'buildings/jarvis/jarvis-retention.js'),
    'utf8'
);
const storyboard = fs.readFileSync(
    path.join(root, 'buildings/jarvis/storyboard-workbench.js'),
    'utf8'
);

assert(
    storyboard.includes('IMAGE_MODELS: PUBLIC_IMAGE_MODELS')
        && storyboard.includes('DEFAULT_IMAGE_MODEL: DEFAULT_MODEL'),
    'Storyboard must export the one shared image-model registry'
);
assert(
    ui.includes('function automaticImageModelSelect')
        && ui.includes('data-auto-image-model')
        && ui.includes('imageModel: automaticImageModel()')
        && ui.includes('strictImageModel: true'),
    'Auto and Grind must use the shared selectable image model'
);

const autoStart = server.indexOf('async function hookProcessRequest');
const autoEnd = server.indexOf('async function hookSweepOrphans', autoStart);
const auto = server.slice(autoStart, autoEnd);
assert(
    auto.includes("'same-video-idea-fine-tuned-hook-batch-v1'")
        && auto.includes('seededAutoExploration ? [] : mem')
        && auto.includes('topicalSimilarity')
        && auto.includes('requiredPriorDistance'),
    'seeded Auto must stay on the immutable video idea and diversify siblings'
);
assert(
    auto.includes('const renderBrief = seededAutoExploration')
        && auto.includes('brief: renderBrief')
        && auto.includes('providerCallBudget: 1'),
    'Auto must render one grounded 45:16 provider image per hook'
);
assert(
    server.includes('hookPlanOutput.parseHookPlans(p.output')
        && server.includes("'./buildings/jarvis/hook-plan-output'"),
    'fine-tuned output must pass through the resilient plan parser'
);
const autoRouteStart = server.indexOf(
    "if (pathname === '/api/hooks/generate' && req.method === 'POST')"
);
const autoRouteEnd = server.indexOf(
    'const storyboardMediaMatch = pathname.match(',
    autoRouteStart
);
const autoRoute = server.slice(autoRouteStart, autoRouteEnd);
assert(
    autoRoute.includes('const strictImageModel = (')
        && autoRoute.includes('strict_image_model: strictImageModel'),
    'Auto must resolve and persist strict image-model selection inside its own route scope'
);
assert(
    ui.includes('st.expGenLaunchErr = prettyGenErr')
        && ui.includes('result polling failed:'),
    'Auto launch and terminal polling failures must be visible'
);

console.log('Auto hook generation contract: ok');
