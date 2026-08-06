'use strict';

const SCHEMA = 'shorts-grind-exploration-v2';
const STRATEGY = 'same-idea-hook-proportional-outward-v2';

const DEFAULTS = Object.freeze({
    // Existing Gemini calibration places unrelated concepts around 0.40+
    // cosine distance. The extra 0.10 margin keeps exploration inside the
    // same video idea while still allowing materially different hook
    // phrasing, sequencing, reveals, and visual treatments.
    topicalSimilarityFloor: 0.70,
    initialPriorDistance: 0.12,
    initialSeedDistance: 0.04,
    priorStepBase: 0.012,
    priorStepFromDeficit: 0.06,
    seedStepBase: 0.006,
    seedStepFromDeficit: 0.025,
});

// The embedding gate remains the authority. These assignments only make the
// fine-tuned planner search different information orders instead of repeatedly
// paraphrasing the seed while waiting for the gate to reject it.
const OUTWARD_ASSIGNMENTS = Object.freeze([
    'result first: open on the visible consequence or proof, then withhold how it happened',
    'failure first: begin at the near-failure or flaw, then reveal the goal and attempted solution',
    'measurement first: lead with a concrete escalating test, number, limit, or comparison',
    'skeptic first: frame the opening through a doubtful observer, challenge, or public reaction',
    'contradiction first: show two facts that appear unable to coexist, then create the unresolved question',
    'constraint first: lead with the rule, deadline, handicap, or point of no return',
    'reversal first: state the expected result, then immediately overturn it with evidence',
    'demonstration first: use a direct declarative proof with no opening question and delay the explanation',
    'stakes first: begin with what is physically, socially, or financially at risk before naming the method',
    'control first: contrast the normal baseline with the unusual test before revealing the result',
    'process mystery first: show one unexplained step or object in action before identifying its purpose',
    'aftermath first: open after the decisive event, then rewind to the experiment that caused it',
]);

function outwardAssignments(selectionRound, count = 4) {
    const round = Math.max(
        1,
        Number.parseInt(selectionRound, 10) || 1
    );
    const amount = Math.max(1, Math.min(
        OUTWARD_ASSIGNMENTS.length,
        Number.parseInt(count, 10) || 4
    ));
    const offset = ((round - 1) * amount)
        % OUTWARD_ASSIGNMENTS.length;
    return Array.from({ length: amount }, (_, index) => (
        OUTWARD_ASSIGNMENTS[
            (offset + index) % OUTWARD_ASSIGNMENTS.length
        ]
    ));
}

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function round(value, digits = 4) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function normalizedVector(vector) {
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return null;
    const values = Array.from(vector, Number);
    if (!values.length || values.some(value => !Number.isFinite(value))) {
        return null;
    }
    const norm = Math.sqrt(values.reduce(
        (total, value) => total + value * value,
        0
    ));
    if (!norm) return null;
    return values.map(value => value / norm);
}

function cosine(left, right) {
    const a = normalizedVector(left);
    const b = normalizedVector(right);
    if (!a || !b || a.length !== b.length) return null;
    let dot = 0;
    for (let index = 0; index < a.length; index++) {
        dot += a[index] * b[index];
    }
    return clamp(dot, -1, 1);
}

function cosineDistance(left, right) {
    const similarity = cosine(left, right);
    return similarity == null ? null : 1 - similarity;
}

function configOf(input = {}) {
    const topicalSimilarityFloor = clamp(
        finiteNumber(
            input.topicalSimilarityFloor,
            DEFAULTS.topicalSimilarityFloor
        ),
        -0.95,
        0.95
    );
    return Object.freeze({
        topicalSimilarityFloor,
        initialPriorDistance: Math.max(0, finiteNumber(
            input.initialPriorDistance,
            DEFAULTS.initialPriorDistance
        )),
        initialSeedDistance: Math.max(0, finiteNumber(
            input.initialSeedDistance,
            DEFAULTS.initialSeedDistance
        )),
        priorStepBase: Math.max(0, finiteNumber(
            input.priorStepBase,
            DEFAULTS.priorStepBase
        )),
        priorStepFromDeficit: Math.max(0, finiteNumber(
            input.priorStepFromDeficit,
            DEFAULTS.priorStepFromDeficit
        )),
        seedStepBase: Math.max(0, finiteNumber(
            input.seedStepBase,
            DEFAULTS.seedStepBase
        )),
        seedStepFromDeficit: Math.max(0, finiteNumber(
            input.seedStepFromDeficit,
            DEFAULTS.seedStepFromDeficit
        )),
    });
}

function geometryLimits(config) {
    // Unit vectors that remain at least `floor` similar to the seed occupy a
    // spherical cap. These are mathematical limits of that topical cap, not
    // arbitrary exploration limits.
    return Object.freeze({
        seedDistance: Math.max(
            0,
            1 - config.topicalSimilarityFloor
        ),
        priorDistance: Math.max(
            0,
            2 * (1 - config.topicalSimilarityFloor ** 2)
        ),
    });
}

function createState({ threshold, config } = {}) {
    const resolvedConfig = configOf(config);
    const limits = geometryLimits(resolvedConfig);
    const target = clamp(finiteNumber(threshold, 82), 0, 100);
    return Object.freeze({
        schema: SCHEMA,
        strategy: STRATEGY,
        threshold: target,
        acceptedCount: 0,
        rejectedCount: 0,
        rejectionReasons: Object.freeze({}),
        bestScore: null,
        scoreDeficit: target,
        requiredPriorDistance: 0,
        requiredSeedDistance: 0,
        maxObservedSeedDistance: 0,
        lastPriorExpansion: 0,
        lastSeedExpansion: 0,
        topicalSimilarityFloor:
            resolvedConfig.topicalSimilarityFloor,
        topicalGeometrySeedLimit: round(limits.seedDistance),
        topicalGeometryPriorLimit: round(limits.priorDistance),
        config: resolvedConfig,
    });
}

function restoreState(snapshot, { threshold, config } = {}) {
    const base = createState({ threshold, config });
    if (
        !snapshot
        || snapshot.schema !== SCHEMA
        || snapshot.strategy !== STRATEGY
    ) return base;
    const reasons = {};
    Object.entries(snapshot.rejection_reasons || {}).forEach(
        ([reason, count]) => {
            const value = Math.max(0, Math.floor(Number(count) || 0));
            if (value) reasons[String(reason)] = value;
        }
    );
    const acceptedCount = Math.max(
        0,
        Math.floor(Number(snapshot.accepted_count) || 0)
    );
    const rejectedCount = Math.max(
        Object.values(reasons).reduce((sum, value) => sum + value, 0),
        Math.max(0, Math.floor(Number(snapshot.rejected_count) || 0))
    );
    const numericBest = Number(snapshot.best_score);
    const bestScore = snapshot.best_score == null
        || !Number.isFinite(numericBest)
        ? null
        : clamp(numericBest, 0, 100);
    return Object.freeze({
        ...base,
        acceptedCount,
        rejectedCount,
        rejectionReasons: Object.freeze(reasons),
        bestScore,
        scoreDeficit: round(Math.max(
            0,
            base.threshold - (bestScore == null ? 0 : bestScore)
        )),
        requiredPriorDistance: round(clamp(
            finiteNumber(snapshot.required_prior_distance, 0),
            0,
            base.topicalGeometryPriorLimit
        )),
        requiredSeedDistance: round(clamp(
            finiteNumber(snapshot.required_seed_distance, 0),
            0,
            base.topicalGeometrySeedLimit
        )),
        maxObservedSeedDistance: round(clamp(
            finiteNumber(
                snapshot.farthest_rendered_seed_distance,
                0
            ),
            0,
            base.topicalGeometrySeedLimit
        )),
        lastPriorExpansion: round(Math.max(
            0,
            finiteNumber(snapshot.prior_expansion_step, 0)
        )),
        lastSeedExpansion: round(Math.max(
            0,
            finiteNumber(snapshot.seed_expansion_step, 0)
        )),
    });
}

function measureCandidate({
    candidateEmbedding,
    seedEmbedding,
    priorEmbeddings = [],
} = {}) {
    const candidate = normalizedVector(candidateEmbedding);
    const seed = normalizedVector(seedEmbedding);
    if (!candidate || !seed || candidate.length !== seed.length) {
        return Object.freeze({
            available: false,
            topicalSimilarity: null,
            seedDistance: null,
            nearestPriorDistance: null,
            nearestPriorIndex: null,
        });
    }
    const topicalSimilarity = cosine(candidate, seed);
    let nearestPriorDistance = null;
    let nearestPriorIndex = null;
    priorEmbeddings.forEach((prior, index) => {
        const distance = cosineDistance(candidate, prior);
        if (
            distance != null
            && (
                nearestPriorDistance == null
                || distance < nearestPriorDistance
            )
        ) {
            nearestPriorDistance = distance;
            nearestPriorIndex = index;
        }
    });
    return Object.freeze({
        available: true,
        topicalSimilarity: round(topicalSimilarity),
        seedDistance: round(1 - topicalSimilarity),
        nearestPriorDistance:
            nearestPriorDistance == null
                ? null
                : round(nearestPriorDistance),
        nearestPriorIndex,
    });
}

function candidateDecision(state, measurement) {
    if (!measurement || measurement.available !== true) {
        return Object.freeze({
            accepted: false,
            reason: 'embedding_unavailable',
        });
    }
    if (
        measurement.topicalSimilarity
        < state.topicalSimilarityFloor
    ) {
        return Object.freeze({
            accepted: false,
            reason: 'outside_topic',
        });
    }
    if (state.acceptedCount === 0) {
        return Object.freeze({ accepted: true, reason: 'seed_attempt' });
    }
    if (measurement.seedDistance < state.requiredSeedDistance) {
        return Object.freeze({
            accepted: false,
            reason: 'not_far_enough_from_seed',
        });
    }
    if (
        measurement.nearestPriorDistance == null
        || measurement.nearestPriorDistance
            < state.requiredPriorDistance
    ) {
        return Object.freeze({
            accepted: false,
            reason: 'too_close_to_rendered_idea',
        });
    }
    return Object.freeze({ accepted: true, reason: 'outward_candidate' });
}

function candidateRank(state, candidate) {
    const measurement = candidate.measurement;
    const seedOvershoot = Math.max(
        0,
        measurement.seedDistance - state.requiredSeedDistance
    );
    const priorMargin = measurement.nearestPriorDistance == null
        ? 0
        : measurement.nearestPriorDistance
            - state.requiredPriorDistance;
    // Stay near the requested outward shell instead of leaping off-topic, then
    // prefer more separation from prior hook treatments and more topicality.
    return (
        -seedOvershoot
        + 0.2 * priorMargin
        + 0.05 * (
            measurement.topicalSimilarity
            - state.topicalSimilarityFloor
        )
    );
}

function selectCandidate(state, candidates) {
    const evaluated = (Array.isArray(candidates) ? candidates : [])
        .map((candidate, index) => {
            const decision = candidateDecision(
                state,
                candidate && candidate.measurement
            );
            return {
                ...candidate,
                sourceIndex: index,
                decision,
                rank: decision.accepted
                    ? candidateRank(state, candidate)
                    : Number.NEGATIVE_INFINITY,
            };
        });
    const selected = evaluated
        .filter(candidate => candidate.decision.accepted)
        .sort((left, right) => (
            right.rank - left.rank
            || left.sourceIndex - right.sourceIndex
        ))[0] || null;
    return Object.freeze({
        selected,
        evaluated: Object.freeze(evaluated),
    });
}

function recordRejections(state, rejected) {
    const reasons = Array.isArray(rejected)
        ? rejected.map(value => String(value || 'unknown'))
        : Array.from(
            { length: Math.max(0, Number.parseInt(rejected, 10) || 0) },
            () => 'unspecified'
        );
    const rejectionReasons = { ...state.rejectionReasons };
    reasons.forEach(reason => {
        rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    });
    return Object.freeze({
        ...state,
        rejectedCount: state.rejectedCount + reasons.length,
        rejectionReasons: Object.freeze(rejectionReasons),
    });
}

function recordScore(state, score, evidence = {}) {
    const numericScore = Number(score);
    const scored = score !== null
        && score !== ''
        && Number.isFinite(numericScore);
    const bestScore = scored
        ? state.bestScore == null
            ? numericScore
            : Math.max(state.bestScore, numericScore)
        : state.bestScore;
    const scoreDeficit = Math.max(
        0,
        state.threshold - (
            bestScore == null ? 0 : bestScore
        )
    );
    const deficitRatio = clamp(
        scoreDeficit / Math.max(1, state.threshold),
        0,
        1
    );
    const nextAcceptedCount = state.acceptedCount + 1;
    const observedSeedDistance = Math.max(
        0,
        finiteNumber(evidence.observedSeedDistance, 0)
    );
    const maxObservedSeedDistance = Math.max(
        state.maxObservedSeedDistance,
        observedSeedDistance
    );
    if (!scoreDeficit) {
        return Object.freeze({
            ...state,
            acceptedCount: nextAcceptedCount,
            bestScore,
            scoreDeficit: 0,
            maxObservedSeedDistance,
            lastPriorExpansion: 0,
            lastSeedExpansion: 0,
        });
    }
    const priorExpansion = (
        state.config.priorStepBase
        + state.config.priorStepFromDeficit * deficitRatio
    );
    const seedExpansion = (
        state.config.seedStepBase
        + state.config.seedStepFromDeficit * deficitRatio
    );
    const requiredPriorDistance = Math.min(
        state.topicalGeometryPriorLimit,
        state.acceptedCount === 0
            ? state.config.initialPriorDistance + priorExpansion
            : state.requiredPriorDistance + priorExpansion
    );
    const requiredSeedDistance = Math.min(
        state.topicalGeometrySeedLimit,
        Math.max(
            state.requiredSeedDistance,
            maxObservedSeedDistance,
            state.acceptedCount === 0
                ? state.config.initialSeedDistance
                : 0
        ) + seedExpansion
    );
    return Object.freeze({
        ...state,
        acceptedCount: nextAcceptedCount,
        bestScore,
        scoreDeficit: round(scoreDeficit),
        maxObservedSeedDistance: round(maxObservedSeedDistance),
        requiredPriorDistance: round(requiredPriorDistance),
        requiredSeedDistance: round(requiredSeedDistance),
        lastPriorExpansion: round(priorExpansion),
        lastSeedExpansion: round(seedExpansion),
    });
}

function publicState(state) {
    return Object.freeze({
        schema: state.schema,
        strategy: state.strategy,
        accepted_count: state.acceptedCount,
        rejected_count: state.rejectedCount,
        rejection_reasons: { ...state.rejectionReasons },
        best_score: state.bestScore,
        score_deficit: state.scoreDeficit,
        required_prior_distance: state.requiredPriorDistance,
        required_seed_distance: state.requiredSeedDistance,
        farthest_rendered_seed_distance:
            state.maxObservedSeedDistance,
        prior_expansion_step: state.lastPriorExpansion,
        seed_expansion_step: state.lastSeedExpansion,
        topical_similarity_floor: state.topicalSimilarityFloor,
        topical_geometry_seed_limit:
            round(state.topicalGeometrySeedLimit),
        topical_geometry_prior_limit:
            round(state.topicalGeometryPriorLimit),
    });
}

function generationPrompt({
    seedPremise,
    state,
    priorPremises = [],
    rejectedPremises = [],
    selectionRound = 1,
} = {}) {
    const seed = String(seedPremise || '').trim();
    if (!state) return seed;
    const prior = priorPremises
        .slice(-6)
        .map((value, index) => `${index + 1}. ${String(value).slice(0, 180)}`);
    const rejected = rejectedPremises
        .slice(-8)
        .map((value, index) => `${index + 1}. ${String(value).slice(0, 120)}`);
    const assignment = outwardAssignments(selectionRound, 1)[0];
    return [
        `IMMUTABLE VIDEO IDEA: ${seed}`,
        'Write a materially different opening hook for this exact same video idea.',
        'The subject, objects, event, experiment, goal, and factual outcome implied by the original idea are invariants. Do not invent a different video concept, challenge, product, or outcome.',
        'Vary only the hook treatment: opening question, information order, tension, framing, reveal timing, spoken phrasing, camera perspective, and five-beat visual progression.',
        'Do not merely paraphrase an earlier hook.',
        state.acceptedCount > 0
            ? `OUTWARD SEARCH ROUND ${Math.max(1, Number.parseInt(selectionRound, 10) || 1)} STRUCTURAL ASSIGNMENT: ${assignment}. Return exactly one normal five-beat plan; the provider independently samples the other candidates.`
            : '',
        state.acceptedCount > 0
            ? 'Keep only nouns required to identify the immutable subject, object, event, goal, and outcome. Change the sentence skeleton, opening speech act, information order, and visual causality. Do not reuse the prior hook question or reveal.'
            : '',
        state.acceptedCount === 0
            ? 'This is the first hook treatment. Establish the exact supplied idea clearly before optimizing its presentation.'
            : `This is outward hook-exploration round ${state.acceptedCount + 1}. Move into a different presentation region while preserving every invariant of the video idea.`,
        state.acceptedCount === 0
            ? `The selection system will retain only a hook with at least ${state.topicalSimilarityFloor.toFixed(3)} similarity to the immutable video idea.`
            : `The selection system will require at least ${state.requiredSeedDistance.toFixed(3)} cosine distance from the original wording and ${state.requiredPriorDistance.toFixed(3)} from every rendered hook, while retaining at least ${state.topicalSimilarityFloor.toFixed(3)} similarity to the immutable video idea.`,
        prior.length ? 'DO NOT REPEAT THESE RENDERED HOOK TREATMENTS:' : '',
        ...prior,
        rejected.length ? 'THESE RECENT DRAFTS WERE TOO CLOSE OR OFF-TOPIC:' : '',
        ...rejected,
        'Return the normal fine-tuned five-beat hook plan. Do not discuss these instructions.',
    ].filter(Boolean).join('\n').slice(0, 3500);
}

module.exports = Object.freeze({
    SCHEMA,
    STRATEGY,
    DEFAULTS,
    cosine,
    cosineDistance,
    createState,
    restoreState,
    measureCandidate,
    candidateDecision,
    selectCandidate,
    recordRejections,
    recordScore,
    publicState,
    outwardAssignments,
    generationPrompt,
});
