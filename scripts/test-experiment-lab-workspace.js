#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    MAX_ACTIVITY,
    MAX_ACTIVITY_HISTORY,
    GENERATION_ACTIVITY_TYPES,
    accountKey,
    workspaceKey,
    isReadOnlyInspectionMutation,
    emptyWorkspace,
    bindWorkspace,
    validateWorkspace,
    validateWorkspaceForAccount,
    normalizeWorkspaceIdentity,
    readWorkspaceRevisionForAccount,
    canonicalWorkspaceBytes,
    collectionFor,
    upsertItem,
    removeItem,
    createFolder,
    moveItem,
    deleteFolder,
    addActivity,
    markArtifactSaved,
    isGenerationActivity,
    summary,
} = require('../buildings/experimentlab/experimentlab-workspace');
const {
    createR2JsonCasMutator,
} = require('../buildings/jarvis/r2-json-cas');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('../buildings/jarvis/canonical-json-artifact');

const OWNER = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
};
const CREATOR = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'creator@example.com',
    displayName: 'Creator',
    role: 'member',
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function bindingPayload(workspace) {
    return {
        schema: workspace.schema,
        schemaVersion: workspace.schemaVersion,
        account: workspace.account,
        collections: workspace.collections,
        activity: workspace.activity,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
    };
}

function rebind(workspace) {
    return bindWorkspace(clone(workspace));
}

function memoryCasStorage(initialWorkspace) {
    let body = canonicalWorkspaceBytes(initialWorkspace);
    let etagSequence = 1;
    let etag = `etag-${etagSequence}`;
    let writes = 0;
    const preconditionError = () => {
        const error = new Error('precondition failed');
        error.code = 'PreconditionFailed';
        return error;
    };
    return {
        async get(_key, options = {}) {
            if (options.ifMatch && options.ifMatch !== etag) {
                throw preconditionError();
            }
            return {
                body: Buffer.from(body),
                etag,
            };
        },
        async put(_key, nextBody, options = {}) {
            if (
                options.ifMatch && options.ifMatch !== etag
                || options.ifNoneMatch === '*'
            ) throw preconditionError();
            body = Buffer.from(nextBody);
            etag = `etag-${++etagSequence}`;
            writes += 1;
            return { etag };
        },
        isMissing: () => false,
        isPreconditionFailed: error => (
            error && error.code === 'PreconditionFailed'
        ),
        value: () => JSON.parse(body.toString('utf8')),
        writes: () => writes,
    };
}

// Account keys are stable, opaque, and account-specific.
assert.strictEqual(accountKey(OWNER.id), accountKey(OWNER.id));
assert.notStrictEqual(accountKey(OWNER.id), accountKey(CREATOR.id));
assert.strictEqual(
    workspaceKey(OWNER.id),
    `experiment-lab/workspaces/${accountKey(OWNER.id)}.json`
);
assert.notStrictEqual(workspaceKey(OWNER.id), workspaceKey(CREATOR.id));
assert(!workspaceKey(OWNER.id).includes(OWNER.id));
assert.throws(() => accountKey('bad'), /account id is invalid/);
assert.strictEqual(
    isReadOnlyInspectionMutation(
        OWNER.id,
        CREATOR.id,
        'POST'
    ),
    true
);
assert(
    GENERATION_ACTIVITY_TYPES.includes('hook-generated')
        && GENERATION_ACTIVITY_TYPES.includes('shorts-grind')
);
assert.strictEqual(
    isGenerationActivity({ type: 'storyboard-panel-generated' }),
    true
);
assert.strictEqual(
    isGenerationActivity({ type: 'hook-upload-scored' }),
    false
);
assert.strictEqual(
    isReadOnlyInspectionMutation(
        OWNER.id,
        CREATOR.id,
        'GET'
    ),
    false
);
assert.strictEqual(
    isReadOnlyInspectionMutation(
        OWNER.id,
        OWNER.id,
        'POST'
    ),
    true
);

let ownerWorkspace = emptyWorkspace(OWNER);
let creatorWorkspace = emptyWorkspace(CREATOR);
assert(validateWorkspace(ownerWorkspace).valid);
assert(validateWorkspace(creatorWorkspace).valid);
assert.notStrictEqual(
    ownerWorkspace.workspace_sha256,
    creatorWorkspace.workspace_sha256
);

// Mutating one account must not leak references or folders into another.
const ownerHooksFolder = createFolder(
    ownerWorkspace,
    'hooks',
    'High confidence'
);
upsertItem(ownerWorkspace, 'hooks', {
    id: 'hook_owner_001',
    folderId: ownerHooksFolder.id,
    savedAt: 100,
});
assert.strictEqual(ownerWorkspace.collections.hooks.items.length, 1);
assert.strictEqual(creatorWorkspace.collections.hooks.items.length, 0);
assert.strictEqual(creatorWorkspace.collections.hooks.folders.length, 0);

const creatorHooksFolder = createFolder(
    creatorWorkspace,
    'hooks',
    'High confidence'
);
upsertItem(creatorWorkspace, 'hooks', {
    id: 'hook_creator_001',
    folderId: creatorHooksFolder.id,
    savedAt: 200,
});
assert.notStrictEqual(ownerHooksFolder.id, creatorHooksFolder.id);
assert.deepStrictEqual(
    ownerWorkspace.collections.hooks.items.map(row => row.id),
    ['hook_owner_001']
);
assert.deepStrictEqual(
    creatorWorkspace.collections.hooks.items.map(row => row.id),
    ['hook_creator_001']
);

// Hooks, channels, and storyboards remain independent reference collections.
const channelFolder = createFolder(
    ownerWorkspace,
    'channels',
    'Competitors'
);
const storyboardFolder = createFolder(
    ownerWorkspace,
    'storyboards',
    'Ready to shoot'
);
upsertItem(ownerWorkspace, 'channels', {
    id: 'channel_alpha',
    folderId: channelFolder.id,
    savedAt: 300,
});
upsertItem(ownerWorkspace, 'storyboards', {
    id: 'storyboard_alpha',
    folderId: storyboardFolder.id,
    savedAt: 400,
});
assert.deepStrictEqual(
    collectionFor(ownerWorkspace, 'channels').items.map(row => row.id),
    ['channel_alpha']
);
assert.deepStrictEqual(
    collectionFor(ownerWorkspace, 'storyboards').items.map(row => row.id),
    ['storyboard_alpha']
);
assert.throws(
    () => collectionFor(ownerWorkspace, 'unknown'),
    /collection kind is invalid/
);
assert.throws(
    () => upsertItem(ownerWorkspace, 'channels', {
        id: 'channel_bad_folder',
        folderId: ownerHooksFolder.id,
    }),
    /folder does not exist/
);

// Folder names deduplicate case-insensitively, moves are scoped by collection,
// and deleting a folder preserves its references at the collection root.
const duplicateFolder = createFolder(
    ownerWorkspace,
    'hooks',
    'high CONFIDENCE'
);
assert.strictEqual(duplicateFolder.id, ownerHooksFolder.id);
assert.strictEqual(ownerWorkspace.collections.hooks.folders.length, 1);

const reviewFolder = createFolder(ownerWorkspace, 'hooks', 'Review');
moveItem(
    ownerWorkspace,
    'hooks',
    'hook_owner_001',
    reviewFolder.id
);
assert.strictEqual(
    ownerWorkspace.collections.hooks.items[0].folderId,
    reviewFolder.id
);
upsertItem(ownerWorkspace, 'hooks', {
    id: 'hook_owner_001',
    savedAt: 100,
});
assert.strictEqual(
    ownerWorkspace.collections.hooks.items[0].folderId,
    reviewFolder.id,
    're-saving a reference must preserve its folder'
);
assert.throws(
    () => moveItem(
        ownerWorkspace,
        'hooks',
        'hook_owner_001',
        channelFolder.id
    ),
    /folder does not exist/
);
assert.throws(
    () => moveItem(
        ownerWorkspace,
        'hooks',
        'hook_missing',
        null
    ),
    /not saved in this workspace/
);

deleteFolder(ownerWorkspace, 'hooks', reviewFolder.id);
assert.strictEqual(
    ownerWorkspace.collections.hooks.items[0].folderId,
    null
);
assert(
    !ownerWorkspace.collections.hooks.folders.some(
        folder => folder.id === reviewFolder.id
    )
);

removeItem(ownerWorkspace, 'channels', 'channel_alpha');
assert.strictEqual(ownerWorkspace.collections.channels.items.length, 0);
assert.strictEqual(ownerWorkspace.collections.storyboards.items.length, 1);

// Activity updates by request identity and records saved/removed state for the
// canonical artifact without duplicating the event.
const activity = addActivity(ownerWorkspace, {
    type: 'score-hook',
    status: 'started',
    title: 'Impossible spill machine',
    artifactKind: 'hooks',
    artifactId: 'hook_owner_001',
    requestId: 'request-001',
    input: {
        kind: 'youtube-link',
        url: 'https://youtube.com/shorts/example',
    },
});
const activityId = activity.id;
addActivity(ownerWorkspace, {
    type: 'score-hook',
    status: 'complete',
    title: 'Impossible spill machine',
    artifactKind: 'hooks',
    artifactId: 'hook_owner_001',
    requestId: 'request-001',
    detail: 'Scoring complete',
    input: {
        creatorProfile: 'tyler',
    },
    inputEvidence: {
        scoreInputFingerprint: 'a'.repeat(64),
    },
    output: {
        kind: 'canonical-shorts-score',
        coordinateCount: 21,
        availableCoordinateCount: 21,
    },
});
assert.strictEqual(ownerWorkspace.activity.length, 1);
assert.strictEqual(ownerWorkspace.activity[0].id, activityId);
assert.strictEqual(ownerWorkspace.activity[0].status, 'complete');
assert.deepStrictEqual(ownerWorkspace.activity[0].input, {
    kind: 'youtube-link',
    url: 'https://youtube.com/shorts/example',
    creatorProfile: 'tyler',
});
assert.strictEqual(ownerWorkspace.activity[0].output.coordinateCount, 21);
assert.strictEqual(
    ownerWorkspace.activity[0].inputEvidence.scoreInputFingerprint,
    'a'.repeat(64)
);
assert.deepStrictEqual(
    ownerWorkspace.activity[0].history.map(entry => entry.status),
    ['started', 'complete'],
    'an activity must retain its lifecycle rather than replacing the prior state'
);

markArtifactSaved(
    ownerWorkspace,
    'hooks',
    'hook_owner_001',
    true
);
assert.strictEqual(ownerWorkspace.activity[0].saved, true);
assert.strictEqual(ownerWorkspace.activity[0].status, 'saved');
assert.deepStrictEqual(
    ownerWorkspace.activity[0].history.map(entry => entry.status),
    ['started', 'complete', 'saved']
);
markArtifactSaved(
    ownerWorkspace,
    'hooks',
    'hook_owner_001',
    false
);
assert.strictEqual(ownerWorkspace.activity[0].saved, false);
assert.strictEqual(ownerWorkspace.activity[0].status, 'removed');
assert.strictEqual(
    ownerWorkspace.activity[0].history.at(-1).status,
    'removed'
);

for (let index = 0; index < MAX_ACTIVITY_HISTORY + 5; index += 1) {
    addActivity(ownerWorkspace, {
        type: 'score-hook',
        status: `phase-${index}`,
        requestId: 'bounded-history-request',
        detail: `phase ${index}`,
    });
}
assert.strictEqual(
    ownerWorkspace.activity[0].history.length,
    MAX_ACTIVITY_HISTORY,
    'one operation lifecycle must remain bounded'
);
assert.strictEqual(
    ownerWorkspace.activity[0].history.at(-1).status,
    `phase-${MAX_ACTIVITY_HISTORY + 4}`
);

// Activity history is newest-first and strictly bounded.
for (let index = 0; index < MAX_ACTIVITY + 25; index += 1) {
    addActivity(ownerWorkspace, {
        type: 'generate-hook',
        status: 'complete',
        title: `Generated hook ${index}`,
        requestId: `bounded-request-${index}`,
    });
}
assert.strictEqual(ownerWorkspace.activity.length, MAX_ACTIVITY);
assert.strictEqual(
    ownerWorkspace.activity[0].requestId,
    `bounded-request-${MAX_ACTIVITY + 24}`
);
assert.strictEqual(
    ownerWorkspace.activity[MAX_ACTIVITY - 1].requestId,
    'bounded-request-25'
);

// Binding is deterministic and independently reproducible from canonical
// bytes. Persisted mutations validate only after the persistence rebind.
assert(
    !validateWorkspace(ownerWorkspace).valid,
    'in-memory mutations must invalidate the prior persistence binding'
);
ownerWorkspace = rebind(ownerWorkspace);
creatorWorkspace = rebind(creatorWorkspace);
assert(validateWorkspace(ownerWorkspace).valid);
assert(validateWorkspace(creatorWorkspace).valid);

// Canonical JSON object identity is independent of insertion order. R2 may
// parse the same bound account fields in an order different from the producer.
const reorderedPersistedAccount = clone(ownerWorkspace);
reorderedPersistedAccount.account = {
    email: ownerWorkspace.account.email,
    id: ownerWorkspace.account.id,
    name: ownerWorkspace.account.name,
    role: ownerWorkspace.account.role,
};
assert.deepStrictEqual(
    validateWorkspace(reorderedPersistedAccount),
    { valid: true, errors: [] }
);

// A historical account snapshot can carry legacy fields or stale mutable
// metadata. It is repairable only when the immutable account id still matches
// the workspace's storage scope and every non-identity integrity check passes.
const legacyIdentityWorkspace = clone(ownerWorkspace);
legacyIdentityWorkspace.account = {
    ...legacyIdentityWorkspace.account,
    displayName: 'Historical owner display name',
};
legacyIdentityWorkspace.workspace_sha256 = sha256Bytes(
    canonicalJsonBytes(bindingPayload(legacyIdentityWorkspace))
);
assert.strictEqual(
    validateWorkspace(legacyIdentityWorkspace).valid,
    false
);
assert.deepStrictEqual(
    validateWorkspace(legacyIdentityWorkspace).errors,
    ['workspace account identity is invalid']
);
assert.strictEqual(
    validateWorkspaceForAccount(
        legacyIdentityWorkspace,
        OWNER,
        { allowIdentityNormalization: true }
    ).valid,
    true
);
const normalizedLegacyWorkspace = normalizeWorkspaceIdentity(
    legacyIdentityWorkspace,
    OWNER
);
assert.strictEqual(
    validateWorkspaceForAccount(
        normalizedLegacyWorkspace,
        OWNER
    ).valid,
    true
);
assert.deepStrictEqual(
    normalizedLegacyWorkspace.account,
    {
        id: OWNER.id,
        email: OWNER.email,
        name: OWNER.displayName,
        role: OWNER.role,
    }
);
assert.deepStrictEqual(
    normalizedLegacyWorkspace.collections,
    ownerWorkspace.collections
);
assert.deepStrictEqual(
    normalizedLegacyWorkspace.activity,
    ownerWorkspace.activity
);

const staleIdentityWorkspace = clone(ownerWorkspace);
staleIdentityWorkspace.account.name = 'Old account name';
staleIdentityWorkspace.workspace_sha256 = sha256Bytes(
    canonicalJsonBytes(bindingPayload(staleIdentityWorkspace))
);
assert.strictEqual(validateWorkspace(staleIdentityWorkspace).valid, true);
assert.strictEqual(
    validateWorkspaceForAccount(staleIdentityWorkspace, OWNER).valid,
    false
);
assert.strictEqual(
    validateWorkspaceForAccount(
        staleIdentityWorkspace,
        OWNER,
        { allowIdentityNormalization: true }
    ).valid,
    true
);

const wrongAccountWorkspace = clone(legacyIdentityWorkspace);
wrongAccountWorkspace.account.id = CREATOR.id;
wrongAccountWorkspace.workspace_sha256 = sha256Bytes(
    canonicalJsonBytes(bindingPayload(wrongAccountWorkspace))
);
assert.strictEqual(
    validateWorkspaceForAccount(
        wrongAccountWorkspace,
        OWNER,
        { allowIdentityNormalization: true }
    ).valid,
    false
);
assert.throws(
    () => normalizeWorkspaceIdentity(wrongAccountWorkspace, OWNER),
    /differs from its storage key/
);

const corruptLegacyWorkspace = clone(legacyIdentityWorkspace);
corruptLegacyWorkspace.workspace_sha256 = '0'.repeat(64);
assert.strictEqual(
    validateWorkspaceForAccount(
        corruptLegacyWorkspace,
        OWNER,
        { allowIdentityNormalization: true }
    ).valid,
    false
);

const expectedSha = sha256Bytes(
    canonicalJsonBytes(bindingPayload(ownerWorkspace))
);
assert.strictEqual(ownerWorkspace.workspace_sha256, expectedSha);

const reordered = bindWorkspace({
    updatedAt: ownerWorkspace.updatedAt,
    activity: clone(ownerWorkspace.activity),
    collections: clone(ownerWorkspace.collections),
    account: {
        role: ownerWorkspace.account.role,
        name: ownerWorkspace.account.name,
        email: ownerWorkspace.account.email,
        id: ownerWorkspace.account.id,
    },
    createdAt: ownerWorkspace.createdAt,
    schemaVersion: ownerWorkspace.schemaVersion,
    schema: ownerWorkspace.schema,
});
assert.strictEqual(
    reordered.workspace_sha256,
    ownerWorkspace.workspace_sha256
);
assert.deepStrictEqual(
    canonicalWorkspaceBytes(reordered),
    canonicalWorkspaceBytes(ownerWorkspace)
);

// Any persisted content change without a rebind is detected.
const tamperedItem = clone(ownerWorkspace);
tamperedItem.collections.hooks.items[0].id = 'hook_tampered';
assert.strictEqual(validateWorkspace(tamperedItem).valid, false);
assert(
    validateWorkspace(tamperedItem).errors.includes(
        'workspace SHA binding differs'
    )
);

const tamperedAccount = clone(ownerWorkspace);
tamperedAccount.account.email = 'attacker@example.com';
assert.strictEqual(validateWorkspace(tamperedAccount).valid, false);
assert(
    validateWorkspace(tamperedAccount).errors.includes(
        'workspace SHA binding differs'
    )
);

const tamperedSha = clone(ownerWorkspace);
tamperedSha.workspace_sha256 = '0'.repeat(64);
assert.strictEqual(validateWorkspace(tamperedSha).valid, false);
assert(
    validateWorkspace(tamperedSha).errors.includes(
        'workspace SHA binding differs'
    )
);

const ownerSummary = summary(ownerWorkspace);
assert.deepStrictEqual(ownerSummary.counts, {
    hooks: 1,
    channels: 0,
    storyboards: 1,
});
assert.deepStrictEqual(ownerSummary.folderCounts, {
    hooks: 1,
    channels: 1,
    storyboards: 1,
});
assert.strictEqual(ownerSummary.activityCount, MAX_ACTIVITY);
assert.strictEqual(ownerSummary.generationCount, MAX_ACTIVITY);
assert.strictEqual(
    ownerSummary.workspace_sha256,
    ownerWorkspace.workspace_sha256
);

async function runIdentityMigrationRegression() {
    const storage = memoryCasStorage(legacyIdentityWorkspace);
    const cas = createR2JsonCasMutator({
        key: workspaceKey(OWNER.id),
        storage,
        emptyValue: () => emptyWorkspace(OWNER),
        validate: value => validateWorkspaceForAccount(
            value,
            OWNER,
            { allowIdentityNormalization: true }
        ),
        bind: value => normalizeWorkspaceIdentity(value, OWNER),
        label: 'Experiment Lab identity migration test',
    });
    const migrated = await readWorkspaceRevisionForAccount(
        cas,
        OWNER
    );
    assert.strictEqual(migrated.exists, true);
    assert.strictEqual(storage.writes(), 1);
    assert.strictEqual(
        validateWorkspaceForAccount(
            migrated.workspace,
            OWNER
        ).valid,
        true
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            migrated.workspace.account,
            'displayName'
        ),
        false
    );
    assert.deepStrictEqual(
        migrated.workspace.collections,
        legacyIdentityWorkspace.collections
    );
    assert.deepStrictEqual(
        migrated.workspace.activity,
        legacyIdentityWorkspace.activity
    );

    const secondRead = await readWorkspaceRevisionForAccount(
        cas,
        OWNER
    );
    assert.strictEqual(secondRead.workspace.workspace_sha256,
        migrated.workspace.workspace_sha256);
    assert.strictEqual(
        storage.writes(),
        1,
        'a repaired workspace must not rewrite on every load'
    );

    const wrongStorage = memoryCasStorage(wrongAccountWorkspace);
    const wrongCas = createR2JsonCasMutator({
        key: workspaceKey(OWNER.id),
        storage: wrongStorage,
        emptyValue: () => emptyWorkspace(OWNER),
        validate: value => validateWorkspaceForAccount(
            value,
            OWNER,
            { allowIdentityNormalization: true }
        ),
        bind: value => normalizeWorkspaceIdentity(value, OWNER),
        label: 'Experiment Lab cross-account rejection test',
    });
    await assert.rejects(
        () => readWorkspaceRevisionForAccount(
            wrongCas,
            OWNER
        ),
        /differs from its storage key/
    );
    assert.strictEqual(wrongStorage.writes(), 0);
}

runIdentityMigrationRegression()
    .then(() => {
        console.log(JSON.stringify({
            ok: true,
            accounts: 2,
            accountKeysIsolated: true,
            identityMigration: true,
            crossAccountRejection: true,
            canonicalSha256: ownerWorkspace.workspace_sha256,
            references: ownerSummary.counts,
            activityCount: ownerSummary.activityCount,
            activityBound: MAX_ACTIVITY,
            tamperDetection: true,
        }, null, 2));
    })
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
