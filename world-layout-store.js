'use strict';

const {
    createR2JsonCasMutator,
} = require('./buildings/jarvis/r2-json-cas');

const WORLD_LAYOUT_KEY = 'layout/layout.json';
const WORLD_LAYOUT_SCHEMA = 'business-world-layout-v2';
const WORLD_LAYOUT_SAVE_SCHEMA = 'business-world-layout-save-v2';

const BUILDING_NAMES = Object.freeze([
    'Workshop',
    'Storage',
    'Money Pit',
    'The Pen',
    'Employee Island',
    'Science Center',
    'Jarvis',
    'Experiment Lab',
    'Library',
    'Finance',
    'The House',
    'Movie Theatre',
    'Gym',
    'Chocolate Bar',
    'Casino',
    'Video Lab',
]);

const MISSING_BUILDING_DEFAULTS = Object.freeze({
    'Chocolate Bar': Object.freeze({ x: 42, z: 12 }),
    Gym: Object.freeze({ x: 15, z: 30 }),
    Casino: Object.freeze({ x: 30, z: -18 }),
});

class WorldLayoutConflictError extends Error {
    constructor(current, message = 'The world layout changed after this editor loaded it.') {
        super(message);
        this.name = 'WorldLayoutConflictError';
        this.code = 'world_layout_conflict';
        this.current = layoutRevisionMetadata(current);
    }
}

function finiteInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0
        ? number
        : fallback;
}

function cleanIdentifier(value, maximumLength = 160) {
    return String(value || '').trim().slice(0, maximumLength);
}

function isPosition(value) {
    return !!value
        && typeof value === 'object'
        && Number.isFinite(Number(value.x))
        && Number.isFinite(Number(value.z));
}

function emptyWorldLayout() {
    return {
        _layoutSchema: WORLD_LAYOUT_SCHEMA,
        _revision: 0,
        _savedAt: null,
        _writer: '',
        _writerSequence: 0,
        _lastMutationId: '',
        buildings: {},
    };
}

function normalizeStoredLayout(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
    return {
        ...source,
        _layoutSchema: WORLD_LAYOUT_SCHEMA,
        _revision: finiteInteger(source._revision),
        _savedAt: typeof source._savedAt === 'string'
            ? source._savedAt
            : null,
        _writer: cleanIdentifier(source._writer),
        _writerSequence: finiteInteger(source._writerSequence),
        _lastMutationId: cleanIdentifier(source._lastMutationId, 240),
        buildings: source.buildings
            && typeof source.buildings === 'object'
            && !Array.isArray(source.buildings)
            ? source.buildings
            : {},
    };
}

function layoutRevisionMetadata(value) {
    const layout = normalizeStoredLayout(value);
    return {
        schema: layout._layoutSchema,
        revision: layout._revision,
        savedAt: layout._savedAt,
        writer: layout._writer,
        writerSequence: layout._writerSequence,
        mutationId: layout._lastMutationId,
    };
}

function validateSaveCommand(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new TypeError('World layout save command must be an object.');
    }
    if (command.schema !== WORLD_LAYOUT_SAVE_SCHEMA) {
        const error = new TypeError('World layout save command schema is missing or unsupported.');
        error.code = 'world_layout_save_schema_required';
        throw error;
    }
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
        const error = new TypeError('World layout save requires a non-negative expectedRevision.');
        error.code = 'world_layout_revision_required';
        throw error;
    }
    if (!command.layout || typeof command.layout !== 'object' || Array.isArray(command.layout)) {
        throw new TypeError('World layout save requires a layout object.');
    }
    const writer = cleanIdentifier(command.writer);
    const mutationId = cleanIdentifier(command.mutationId, 240);
    const writerSequence = finiteInteger(command.writerSequence, -1);
    if (!writer || !mutationId || writerSequence < 1) {
        const error = new TypeError('World layout save requires writer, writerSequence, and mutationId.');
        error.code = 'world_layout_writer_required';
        throw error;
    }
    return {
        expectedRevision: command.expectedRevision,
        writer,
        writerSequence,
        mutationId,
        layout: command.layout,
    };
}

function mergeBuildings(current, incoming) {
    const existingBuildings = current.buildings || {};
    const incomingBuildings = incoming.buildings
        && typeof incoming.buildings === 'object'
        && !Array.isArray(incoming.buildings)
        ? incoming.buildings
        : {};
    const merged = {};
    const allNames = new Set([
        ...BUILDING_NAMES,
        ...Object.keys(existingBuildings),
        ...Object.keys(incomingBuildings),
    ]);

    for (const name of allNames) {
        const next = incomingBuildings[name];
        const previous = existingBuildings[name];
        if (
            isPosition(next)
            && !(Number(next.x) === 0 && Number(next.z) === 0)
        ) {
            merged[name] = { x: Number(next.x), z: Number(next.z) };
        } else if (isPosition(previous)) {
            merged[name] = { x: Number(previous.x), z: Number(previous.z) };
        } else if (MISSING_BUILDING_DEFAULTS[name]) {
            merged[name] = { ...MISSING_BUILDING_DEFAULTS[name] };
        }
    }
    return merged;
}

function nextLayout(currentValue, command, now) {
    const current = normalizeStoredLayout(currentValue);
    if (
        current._writer === command.writer
        && current._lastMutationId === command.mutationId
    ) {
        return current;
    }
    if (current._revision !== command.expectedRevision) {
        throw new WorldLayoutConflictError(current);
    }
    if (
        current._writer === command.writer
        && command.writerSequence <= current._writerSequence
    ) {
        throw new WorldLayoutConflictError(
            current,
            'An older edit from this browser cannot replace its newer saved layout.'
        );
    }

    const incoming = command.layout;
    const layout = {
        ...incoming,
        buildings: mergeBuildings(current, incoming),
        _layoutSchema: WORLD_LAYOUT_SCHEMA,
        _revision: current._revision + 1,
        _savedAt: now().toISOString(),
        _writer: command.writer,
        _writerSequence: command.writerSequence,
        _lastMutationId: command.mutationId,
    };
    delete layout._basedOn;
    return layout;
}

function createWorldLayoutStore({ storage, now = () => new Date() } = {}) {
    const cas = createR2JsonCasMutator({
        key: WORLD_LAYOUT_KEY,
        storage,
        emptyValue: emptyWorldLayout,
        bind: normalizeStoredLayout,
        label: 'Business World layout',
    });

    return Object.freeze({
        async read() {
            const revision = await cas.readRevision();
            return normalizeStoredLayout(revision.value);
        },
        async save(rawCommand) {
            const command = validateSaveCommand(rawCommand);
            return cas.mutate(current => nextLayout(current, command, now));
        },
    });
}

module.exports = {
    WORLD_LAYOUT_KEY,
    WORLD_LAYOUT_SCHEMA,
    WORLD_LAYOUT_SAVE_SCHEMA,
    WorldLayoutConflictError,
    createWorldLayoutStore,
    emptyWorldLayout,
    layoutRevisionMetadata,
    mergeBuildings,
    normalizeStoredLayout,
    validateSaveCommand,
};
