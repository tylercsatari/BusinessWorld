'use strict';

const SCHEMA = 'shorts-grind-exploration-v3';
const STRATEGY = 'same-idea-hook-directional-frontier-v3';
const PROMPT_SCHEMA = 'same-idea-hook-direction-lattice-v1';
const LEGACY_SCHEMA = 'shorts-grind-exploration-v2';
const LEGACY_STRATEGY = 'same-idea-hook-proportional-outward-v2';

const DEFAULTS = Object.freeze({
    // Existing Gemini calibration places unrelated concepts around 0.40+
    // cosine distance. The extra 0.10 margin keeps exploration inside the
    // same video idea while still allowing materially different hook
    // phrasing, sequencing, reveals, and visual treatments.
    topicalSimilarityFloor: 0.70,
    // Only near-identical semantic vectors are rejected. The wider spacing
    // target is deliberately soft so a nearby hook in a new direction can be
    // rendered instead of getting trapped behind an expanding scalar shell.
    duplicateDistanceFloor: 0.02,
    initialPriorTarget: 0.12,
    initialSeedTarget: 0.04,
    priorStepBase: 0.012,
    priorStepFromDeficit: 0.06,
    seedStepBase: 0.006,
    seedStepFromDeficit: 0.025,
});

// Prompt controls are generation-only search coordinates. They are not
// learned clusters, quality labels, or ledger coordinates. The exhaustive
// mixed-radix lattice guides the planner into a new presentation structure;
// measured embedding geometry still decides whether it actually got there.
const PROMPT_AXES = Object.freeze([
    Object.freeze({
        id: 'entry',
        label: 'entry point',
        values: Object.freeze([
            ['consequence', 'open on an observable consequence before explaining its cause'],
            ['action', 'open on an unresolved physical action already in progress'],
            ['claim', 'open with one concrete falsifiable claim and immediate visual evidence'],
            ['anomaly', 'open on the one visible detail that violates the normal pattern'],
            ['constraint', 'open with the rule, deadline, handicap, or point of no return'],
            ['reaction', 'open on a real observer reaction before revealing its trigger'],
            ['scale', 'open by making the physical scale, force, quantity, or limit legible'],
            ['demonstration', 'open with direct proof rather than an introductory explanation'],
            ['aftermath', 'open after the decisive event and work backward toward its cause'],
            ['baseline', 'open with a normal control and immediately expose the changed condition'],
            ['failure', 'open on a concrete failure mode or flaw that threatens the exact goal'],
            ['behavior', 'open on the central object doing something unexplained but relevant'],
        ]),
    }),
    Object.freeze({
        id: 'order',
        label: 'information order',
        values: Object.freeze([
            ['proof-cause', 'order the beats as proof, cause, test'],
            ['obstacle-goal', 'order the beats as obstacle, goal, attempted solution'],
            ['test-claim', 'order the beats as test, claim, unresolved verdict'],
            ['result-method', 'order the beats as partial result, method, harder test'],
            ['baseline-anomaly', 'order the beats as baseline, anomaly, investigation'],
            ['reaction-trigger', 'order the beats as reaction, hidden trigger, consequence'],
            ['limit-escalation', 'order the beats as current limit, escalation, next limit'],
            ['rule-attempt', 'order the beats as governing rule, attempt, apparent violation'],
            ['detail-whole', 'order the beats as diagnostic detail, wider system, unresolved effect'],
            ['consequence-choice', 'order the beats as consequence, irreversible choice, test'],
        ]),
    }),
    Object.freeze({
        id: 'tension',
        label: 'tension mechanism',
        values: Object.freeze([
            ['falsification', 'make the viewer wait for a clean pass-or-fail falsification'],
            ['escalation', 'increase the test severity visibly from beat to beat'],
            ['reversal', 'establish one expectation and overturn it with visible evidence'],
            ['countdown', 'create a concrete shrinking time or attempt window'],
            ['physical-risk', 'make the relevant physical failure consequence legible without inventing danger'],
            ['hidden-flaw', 'surface a specific hidden flaw that could invalidate the attempt'],
            ['public-verdict', 'let an observer, judge, or comparison supply the unresolved verdict'],
            ['resource-limit', 'make a finite material, energy, money, or attempt budget visible'],
            ['competing-outcomes', 'keep two plausible, mutually exclusive outcomes alive'],
            ['commitment', 'show an irreversible commitment to completing the exact test'],
        ]),
    }),
    Object.freeze({
        id: 'camera',
        label: 'visual evidence',
        values: Object.freeze([
            ['macro', 'use close diagnostic evidence that can be understood without narration'],
            ['wide', 'use a wide physical test with subject, object, and consequence in one frame'],
            ['pov', 'use participant point of view to make the interaction immediate'],
            ['split', 'use a direct control-versus-test comparison'],
            ['reaction', 'use an observer reaction only when its visible trigger remains in context'],
            ['instrument', 'use a real counter, gauge, scale, timer, or measurement as evidence'],
            ['continuous', 'make all five beats read as one continuous causal action'],
            ['cause-effect', 'alternate clear cause and effect without decorative cutaways'],
            ['scale-reference', 'keep a familiar reference object visible to communicate scale'],
            ['state-change', 'make the before state and changed state unmistakably comparable'],
        ]),
    }),
    Object.freeze({
        id: 'speech',
        label: 'opening speech act',
        values: Object.freeze([
            ['declaration', 'use a precise declarative opening with no generic hype'],
            ['question', 'ask one concrete question whose answer is visibly testable'],
            ['challenge', 'frame a specific skeptical challenge to the central claim'],
            ['warning', 'state one relevant warning tied to a visible failure mode'],
            ['prediction', 'make a concrete prediction that the five beats can test'],
            ['confession', 'admit one consequential mistake or uncertainty after identifying its subject'],
            ['wager', 'state a clear success condition and what is being risked'],
            ['command', 'begin with a short procedural command that launches the test immediately'],
        ]),
    }),
    Object.freeze({
        id: 'reveal',
        label: 'reveal policy',
        values: Object.freeze([
            ['method-late', 'withhold the method while showing enough evidence to understand the goal'],
            ['limit-late', 'withhold the final limit while making the measurement scale clear'],
            ['result-late', 'withhold the verdict while showing genuine partial progress'],
            ['partial-proof', 'show one piece of proof and reserve the decisive proof'],
            ['cause-late', 'show the consequence first and reveal its relevant cause later'],
            ['rule-late', 'show an apparent impossibility before revealing the governing rule'],
            ['failure-late', 'foreshadow a real failure mode without revealing whether it occurs'],
            ['scale-late', 'establish the test before revealing its full scale or force'],
        ]),
    }),
]);

const PROMPT_LATTICE_SIZE = PROMPT_AXES.reduce(
    (product, axis) => product * axis.values.length,
    1
);
// A golden-ratio-sized stride, coprime with the lattice size, prevents early
// searches from walking adjacent low-order controls while still visiting each
// complete recipe exactly once before the lattice repeats.
const PROMPT_LATTICE_STRIDE = 474701;
const PROMPT_LATTICE_OFFSET = 104729;

function promptDirection(index = 0) {
    const ordinal = Math.max(0, Math.floor(Number(index) || 0));
    let position = (
        ordinal * PROMPT_LATTICE_STRIDE
        + PROMPT_LATTICE_OFFSET
    ) % PROMPT_LATTICE_SIZE;
    const latticePosition = position;
    const choices = {};
    PROMPT_AXES.forEach(axis => {
        const choice = axis.values[position % axis.values.length];
        choices[axis.id] = Object.freeze({
            id: choice[0],
            label: axis.label,
            instruction: choice[1],
        });
        position = Math.floor(position / axis.values.length);
    });
    const id = `D-${String(ordinal + 1).padStart(6, '0')}`;
    return Object.freeze({
        schema: PROMPT_SCHEMA,
        id,
        ordinal,
        lattice_position: latticePosition,
        lattice_size: PROMPT_LATTICE_SIZE,
        choices: Object.freeze(choices),
        summary: PROMPT_AXES.map(axis => (
            choices[axis.id].id
        )).join(' / '),
    });
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

function directionFromSeed(vector, seedVector) {
    const candidate = normalizedVector(vector);
    const seed = normalizedVector(seedVector);
    if (!candidate || !seed || candidate.length !== seed.length) {
        return null;
    }
    let projection = 0;
    for (let index = 0; index < candidate.length; index++) {
        projection += candidate[index] * seed[index];
    }
    projection = clamp(projection, -1, 1);
    const residual = candidate.map((value, index) => (
        value - projection * seed[index]
    ));
    const residualNorm = Math.sqrt(residual.reduce(
        (total, value) => total + value * value,
        0
    ));
    if (residualNorm <= 1e-10) return null;
    return residual.map(value => value / residualNorm);
}

function directionSignature(direction, bitCount = 12) {
    const vector = normalizedVector(direction);
    if (!vector) return null;
    const bits = clamp(
        Math.floor(finiteNumber(bitCount, 12)),
        4,
        24
    );
    let signature = 0;
    for (let bit = 0; bit < bits; bit++) {
        let projection = 0;
        for (let index = 0; index < vector.length; index++) {
            let hash = (
                Math.imul(bit + 1, 0x9e3779b1)
                ^ Math.imul(index + 1, 0x85ebca6b)
            ) >>> 0;
            hash ^= hash >>> 16;
            hash = Math.imul(hash, 0x7feb352d) >>> 0;
            hash ^= hash >>> 15;
            projection += vector[index] * (
                hash & 1 ? 1 : -1
            );
        }
        if (projection >= 0) signature |= 1 << bit;
    }
    return signature.toString(16).padStart(
        Math.ceil(bits / 4),
        '0'
    );
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
        duplicateDistanceFloor: Math.max(0, finiteNumber(
            input.duplicateDistanceFloor,
            DEFAULTS.duplicateDistanceFloor
        )),
        initialPriorTarget: Math.max(0, finiteNumber(
            input.initialPriorTarget ?? input.initialPriorDistance,
            DEFAULTS.initialPriorTarget
        )),
        initialSeedTarget: Math.max(0, finiteNumber(
            input.initialSeedTarget ?? input.initialSeedDistance,
            DEFAULTS.initialSeedTarget
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
        promptSearchCursor: 0,
        rejectionReasons: Object.freeze({}),
        bestScore: null,
        scoreDeficit: target,
        targetPriorDistance: 0,
        targetSeedDistance: 0,
        duplicateDistanceFloor: resolvedConfig.duplicateDistanceFloor,
        explorationPressure: 1,
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
    const current = snapshot
        && snapshot.schema === SCHEMA
        && snapshot.strategy === STRATEGY;
    const legacy = snapshot
        && snapshot.schema === LEGACY_SCHEMA
        && snapshot.strategy === LEGACY_STRATEGY;
    if (!current && !legacy) return base;
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
        promptSearchCursor: Math.max(
            acceptedCount,
            Math.floor(Number(snapshot.prompt_search_cursor) || 0)
        ),
        rejectionReasons: Object.freeze(reasons),
        bestScore,
        scoreDeficit: round(Math.max(
            0,
            base.threshold - (bestScore == null ? 0 : bestScore)
        )),
        targetPriorDistance: round(clamp(
            finiteNumber(
                snapshot.target_prior_distance
                    ?? snapshot.required_prior_distance,
                0
            ),
            0,
            base.topicalGeometryPriorLimit
        )),
        targetSeedDistance: round(clamp(
            finiteNumber(
                snapshot.target_seed_distance
                    ?? snapshot.required_seed_distance,
                0
            ),
            0,
            base.topicalGeometrySeedLimit
        )),
        duplicateDistanceFloor: round(Math.max(
            0,
            finiteNumber(
                snapshot.duplicate_distance_floor,
                base.duplicateDistanceFloor
            )
        )),
        explorationPressure: round(clamp(
            finiteNumber(
                snapshot.exploration_pressure,
                Math.max(
                    0,
                    base.threshold - (bestScore == null ? 0 : bestScore)
                ) / Math.max(1, base.threshold)
            ),
            0,
            1
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

function advancePromptSearch(state, amount = 1) {
    if (!state) return state;
    return Object.freeze({
        ...state,
        promptSearchCursor: Math.max(
            0,
            state.promptSearchCursor
                + Math.max(1, Math.floor(Number(amount) || 1))
        ),
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
    const seedDirection = directionFromSeed(candidate, seed);
    const seedAngleRadians = Math.acos(clamp(topicalSimilarity, -1, 1));
    let nearestPriorDistance = null;
    let nearestPriorIndex = null;
    let nearestPriorDirectionalDistance = null;
    let nearestPriorDirectionalIndex = null;
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
        const priorDirection = directionFromSeed(prior, seed);
        if (seedDirection && priorDirection) {
            const directionalSimilarity = cosine(
                seedDirection,
                priorDirection
            );
            const directionalDistance = Math.acos(
                clamp(directionalSimilarity, -1, 1)
            ) / Math.PI;
            if (
                nearestPriorDirectionalDistance == null
                || directionalDistance
                    < nearestPriorDirectionalDistance
            ) {
                nearestPriorDirectionalDistance = directionalDistance;
                nearestPriorDirectionalIndex = index;
            }
        }
    });
    return Object.freeze({
        available: true,
        topicalSimilarity: round(topicalSimilarity, 6),
        seedDistance: round(1 - topicalSimilarity, 6),
        seedAngleDegrees: round(seedAngleRadians * 180 / Math.PI, 2),
        directionAvailable: !!seedDirection,
        directionSignature: directionSignature(seedDirection),
        nearestPriorDistance:
            nearestPriorDistance == null
                ? null
                : round(nearestPriorDistance, 6),
        nearestPriorIndex,
        nearestPriorDirectionalDistance:
            nearestPriorDirectionalDistance == null
                ? null
                : round(nearestPriorDirectionalDistance, 6),
        nearestPriorDirectionalAngleDegrees:
            nearestPriorDirectionalDistance == null
                ? null
                : round(nearestPriorDirectionalDistance * 180, 2),
        nearestPriorDirectionalIndex,
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
    if (
        measurement.nearestPriorDistance == null
    ) {
        return Object.freeze({
            accepted: false,
            reason: 'prior_geometry_unavailable',
        });
    }
    if (
        measurement.nearestPriorDistance
            < state.duplicateDistanceFloor
    ) {
        return Object.freeze({
            accepted: false,
            reason: 'semantic_duplicate',
        });
    }
    return Object.freeze({
        accepted: true,
        reason: 'directional_frontier_candidate',
    });
}

function candidateRank(state, candidate) {
    const measurement = candidate.measurement;
    if (state.acceptedCount === 0) {
        return Object.freeze({
            total: 1,
            radial: 1,
            directional: 1,
            pairwise: 1,
            radialWeight: 0,
            directionalWeight: 0,
            pairwiseWeight: 0,
        });
    }
    const pressure = clamp(state.explorationPressure, 0, 1);
    const radialLimit = Math.max(
        1e-9,
        state.topicalGeometrySeedLimit
    );
    const radialFit = 1 - clamp(
        Math.abs(
            measurement.seedDistance - state.targetSeedDistance
        ) / radialLimit,
        0,
        1
    );
    const radialReach = clamp(
        measurement.seedDistance / radialLimit,
        0,
        1
    );
    const radial = 0.7 * radialFit + 0.3 * radialReach;
    const directional = measurement.nearestPriorDirectionalDistance == null
        ? 1
        : clamp(measurement.nearestPriorDirectionalDistance, 0, 1);
    const priorTarget = Math.max(
        state.duplicateDistanceFloor,
        state.targetPriorDistance
    );
    const pairwise = measurement.nearestPriorDistance == null
        ? 1
        : priorTarget <= state.duplicateDistanceFloor
            ? 1
            : clamp(
                (
                    measurement.nearestPriorDistance
                    - state.duplicateDistanceFloor
                ) / (
                    priorTarget - state.duplicateDistanceFloor
                ),
                0,
                1
            );
    // A larger score miss shifts weight toward unexplored azimuths. The
    // proportional radial target still moves outward, but it is an objective,
    // never a gate. Weights sum to one for every pressure value.
    const directionalWeight = 0.45 + 0.20 * pressure;
    const radialWeight = 0.40 - 0.10 * pressure;
    const pairwiseWeight = 0.15 - 0.10 * pressure;
    return Object.freeze({
        total: round(
            directionalWeight * directional
            + radialWeight * radial
            + pairwiseWeight * pairwise,
            6
        ),
        radial: round(radial, 6),
        directional: round(directional, 6),
        pairwise: round(pairwise, 6),
        radialWeight: round(radialWeight, 6),
        directionalWeight: round(directionalWeight, 6),
        pairwiseWeight: round(pairwiseWeight, 6),
    });
}

function selectCandidate(state, candidates) {
    const evaluated = (Array.isArray(candidates) ? candidates : [])
        .map((candidate, index) => {
            const decision = candidateDecision(
                state,
                candidate && candidate.measurement
            );
            const rankComponents = decision.accepted
                ? candidateRank(state, candidate)
                : null;
            return {
                ...candidate,
                sourceIndex: index,
                decision,
                rankComponents,
                rank: rankComponents
                    ? rankComponents.total
                    : Number.NEGATIVE_INFINITY,
            };
        });
    const selected = evaluated
        .filter(candidate => candidate.decision.accepted)
        .sort((left, right) => (
            right.rank - left.rank
            || finiteNumber(
                right.measurement.nearestPriorDirectionalDistance,
                -1
            ) - finiteNumber(
                left.measurement.nearestPriorDirectionalDistance,
                -1
            )
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
            explorationPressure: 0,
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
    const targetPriorDistance = Math.min(
        state.topicalGeometryPriorLimit,
        state.acceptedCount === 0
            ? state.config.initialPriorTarget + priorExpansion
            : state.targetPriorDistance + priorExpansion
    );
    const targetSeedDistance = Math.min(
        state.topicalGeometrySeedLimit,
        Math.max(
            state.targetSeedDistance,
            maxObservedSeedDistance,
            state.acceptedCount === 0
                ? state.config.initialSeedTarget
                : 0
        ) + seedExpansion
    );
    return Object.freeze({
        ...state,
        acceptedCount: nextAcceptedCount,
        bestScore,
        scoreDeficit: round(scoreDeficit),
        explorationPressure: round(deficitRatio),
        maxObservedSeedDistance: round(maxObservedSeedDistance),
        targetPriorDistance: round(targetPriorDistance),
        targetSeedDistance: round(targetSeedDistance),
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
        prompt_search_cursor: state.promptSearchCursor,
        prompt_search_schema: PROMPT_SCHEMA,
        prompt_lattice_size: PROMPT_LATTICE_SIZE,
        rejection_reasons: { ...state.rejectionReasons },
        best_score: state.bestScore,
        score_deficit: state.scoreDeficit,
        target_prior_distance: state.targetPriorDistance,
        target_seed_distance: state.targetSeedDistance,
        duplicate_distance_floor: state.duplicateDistanceFloor,
        exploration_pressure: state.explorationPressure,
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
    promptRecipe = null,
} = {}) {
    const seed = String(seedPremise || '').trim();
    if (!state) return seed;
    const prior = priorPremises
        .slice(-4)
        .map((value, index) => `${index + 1}. ${String(value).slice(0, 150)}`);
    const rejected = rejectedPremises
        .slice(-4)
        .map((value, index) => `${index + 1}. ${String(value).slice(0, 100)}`);
    const localSearchRound = Math.max(
        1,
        Number.parseInt(selectionRound, 10) || 1
    );
    const direction = promptRecipe || (
        state.acceptedCount > 0
            ? promptDirection(state.promptSearchCursor)
            : null
    );
    const seedTreatment = state.acceptedCount === 0 && !direction;
    const pressurePercent = Math.round(
        clamp(finiteNumber(state.explorationPressure, 0), 0, 1) * 100
    );
    const directionInstructions = !direction
        ? []
        : PROMPT_AXES.map(axis => {
            const choice = direction.choices[axis.id];
            return `- ${axis.label.toUpperCase()} [${choice.id}]: ${choice.instruction}.`;
        });
    return [
        `IMMUTABLE VIDEO IDEA: ${seed}`,
        'Write a materially different opening hook for this exact same video idea.',
        'The subject, objects, event, experiment, goal, and factual outcome implied by the original idea are invariants. Do not invent a different video concept, challenge, product, or outcome.',
        'Vary only the hook treatment: opening question, information order, tension, framing, reveal timing, spoken phrasing, camera perspective, and five-beat visual progression.',
        'Do not merely paraphrase an earlier hook.',
        direction
            ? `DIRECTED SEARCH ${direction.id} · screening round ${localSearchRound} · novelty pressure ${pressurePercent}%. This is a generation instruction, not a learned cluster or score.`
            : '',
        direction
            ? 'Treat novelty pressure continuously: near 100% requires a radical change to presentation structure across every assigned axis; near 0% permits a subtler treatment change. Never satisfy novelty by changing the topic or inventing unrelated stakes.'
            : '',
        direction
            ? 'Obey every independent control below. Do not blend it back into the previous treatment:'
            : '',
        ...directionInstructions,
        direction
            ? 'The provider samples several drafts from this direction. Each draft must find a genuinely different concrete execution within these controls rather than reuse the same first beat, sentence skeleton, unresolved question, reveal target, or camera progression.'
            : '',
        direction
            ? 'Every beat must add new visible information or causal progress. Avoid generic hype, decorative cutaways, and mystery that cannot be understood from the exact idea.'
            : '',
        direction
            ? 'Before returning JSON, silently compare the draft with the rendered and rejected treatments below. If its first visual event or information sequence matches one, redesign it while preserving the immutable facts.'
            : '',
        seedTreatment
            ? 'This is the first hook treatment. Establish the exact supplied idea clearly before optimizing its presentation.'
            : state.acceptedCount === 0
                ? 'No hook has rendered yet. This directed recovery must establish the exact supplied idea while avoiding the failed seed draft.'
                : `This is rendered hook attempt ${state.acceptedCount + 1}. Move into a different presentation region while preserving every invariant of the video idea.`,
        state.acceptedCount === 0
            ? `The selection system will retain only a hook with at least ${state.topicalSimilarityFloor.toFixed(3)} similarity to the immutable video idea.`
            : `Selection will favor an underexplored semantic direction and use ${state.targetSeedDistance.toFixed(3)} seed distance plus ${state.targetPriorDistance.toFixed(3)} prior spacing as soft targets. Missing either target does not discard a topical new direction. Only drafts below ${state.topicalSimilarityFloor.toFixed(3)} topical similarity or within ${state.duplicateDistanceFloor.toFixed(3)} duplicate distance of a rendered hook are rejected.`,
        prior.length ? 'DO NOT REPEAT THESE RENDERED HOOK TREATMENTS:' : '',
        ...prior,
        rejected.length ? 'RECENT DRAFTS NOT SELECTED FOR RENDER:' : '',
        ...rejected,
        'Return the normal five-beat JSON hook plan. Do not discuss these instructions.',
    ].filter(Boolean).join('\n').slice(0, 4000);
}

module.exports = Object.freeze({
    SCHEMA,
    STRATEGY,
    PROMPT_SCHEMA,
    PROMPT_LATTICE_SIZE,
    DEFAULTS,
    cosine,
    cosineDistance,
    directionFromSeed,
    directionSignature,
    createState,
    restoreState,
    measureCandidate,
    candidateDecision,
    selectCandidate,
    recordRejections,
    recordScore,
    publicState,
    promptDirection,
    advancePromptSearch,
    generationPrompt,
});
