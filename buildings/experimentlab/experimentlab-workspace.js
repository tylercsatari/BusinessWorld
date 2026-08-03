'use strict';

const crypto = require('crypto');
const {
    canonicalJsonBytes,
    sha256Bytes,
} = require('../jarvis/canonical-json-artifact');

const SCHEMA = 'experiment-lab-workspace-v1';
const SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze([
    'hooks',
    'channels',
    'storyboards',
]);
const MAX_ACTIVITY = 500;
const MAX_ACTIVITY_HISTORY = 24;
const ACCOUNT_ID_PATTERN =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ITEM_ID_PATTERN = /^[a-z0-9_-]{2,96}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_SHAPE_ERROR =
    'workspace account identity is invalid';
const IDENTITY_SCOPE_ERROR =
    'workspace account differs from its storage key';
const IDENTITY_STALE_ERROR =
    'workspace account identity differs from the current account';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function accountKey(accountId) {
    const id = String(accountId || '').trim().toLowerCase();
    if (!ACCOUNT_ID_PATTERN.test(id)) {
        throw new TypeError('Experiment Lab account id is invalid');
    }
    return crypto
        .createHash('sha256')
        .update(`experiment-lab:${id}`)
        .digest('hex')
        .slice(0, 32);
}

function workspaceKey(accountId) {
    return `experiment-lab/workspaces/${accountKey(accountId)}.json`;
}

function accountIdentity(account) {
    if (!account || typeof account !== 'object') {
        throw new TypeError('Experiment Lab account is missing');
    }
    const id = String(account.id || '').trim().toLowerCase();
    accountKey(id);
    return {
        id,
        email: String(account.email || '').trim().toLowerCase(),
        name: String(
            account.name || account.displayName || ''
        ).trim().slice(0, 160),
        role: String(account.role || 'pending').trim().slice(0, 80),
    };
}

function isReadOnlyInspectionMutation(
    viewerAccountId,
    targetAccountId,
    method
) {
    const viewer = String(viewerAccountId || '').trim();
    const target = String(targetAccountId || '').trim();
    const verb = String(method || 'GET').toUpperCase();
    return !!(
        viewer
        && target
        && !['GET', 'HEAD', 'OPTIONS'].includes(verb)
    );
}

function emptyCollection() {
    return {
        folders: [],
        items: [],
    };
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

function bindWorkspace(workspace) {
    const now = Date.now();
    const source = workspace && typeof workspace === 'object'
        ? workspace
        : {};
    const bound = {
        schema: SCHEMA,
        schemaVersion: SCHEMA_VERSION,
        account: accountIdentity(source.account),
        collections: {},
        activity: Array.isArray(source.activity)
            ? clone(source.activity).slice(0, MAX_ACTIVITY)
            : [],
        createdAt: Number.isSafeInteger(source.createdAt)
            ? source.createdAt
            : now,
        updatedAt: Number.isSafeInteger(source.updatedAt)
            ? source.updatedAt
            : now,
    };
    for (const kind of COLLECTIONS) {
        const collection =
            source.collections && source.collections[kind];
        bound.collections[kind] = {
            folders: Array.isArray(collection && collection.folders)
                ? clone(collection.folders)
                : [],
            items: Array.isArray(collection && collection.items)
                ? clone(collection.items)
                : [],
        };
    }
    bound.workspace_sha256 = sha256Bytes(
        canonicalJsonBytes(bindingPayload(bound))
    );
    return bound;
}

function emptyWorkspace(account) {
    const now = Date.now();
    return bindWorkspace({
        account: accountIdentity(account),
        collections: Object.fromEntries(
            COLLECTIONS.map(kind => [kind, emptyCollection()])
        ),
        activity: [],
        createdAt: now,
        updatedAt: now,
    });
}

function canonicalWorkspaceBytes(workspace) {
    return canonicalJsonBytes(workspace);
}

function collectionFor(workspace, kind) {
    if (!COLLECTIONS.includes(kind)) {
        throw new TypeError('Experiment Lab collection kind is invalid');
    }
    if (
        !workspace
        || !workspace.collections
        || !workspace.collections[kind]
    ) {
        throw new TypeError('Experiment Lab workspace collection is missing');
    }
    return workspace.collections[kind];
}

function touch(workspace) {
    workspace.updatedAt = Date.now();
    return workspace;
}

function normalizedItemId(id) {
    const value = String(id || '').trim();
    if (!ITEM_ID_PATTERN.test(value)) {
        throw new TypeError('Experiment Lab item id is invalid');
    }
    return value;
}

function folderFor(collection, folderId) {
    if (folderId == null || folderId === '') return null;
    const folder = collection.folders.find(
        candidate => candidate.id === folderId
    );
    if (!folder) {
        throw new Error('Experiment Lab folder does not exist');
    }
    return folder;
}

function upsertItem(workspace, kind, input) {
    const collection = collectionFor(workspace, kind);
    const value = input && typeof input === 'object' ? input : {};
    const id = normalizedItemId(value.id);
    const folderWasSupplied =
        Object.prototype.hasOwnProperty.call(value, 'folderId');
    const folder = folderWasSupplied
        ? folderFor(collection, value.folderId)
        : null;
    const now = Date.now();
    let item = collection.items.find(candidate => candidate.id === id);
    if (item) {
        Object.assign(item, clone(value), {
            id,
            folderId: folderWasSupplied
                ? folder && folder.id || null
                : item.folderId || null,
            updatedAt: now,
        });
    } else {
        item = {
            ...clone(value),
            id,
            folderId: folder ? folder.id : null,
            savedAt: Number.isFinite(value.savedAt)
                ? value.savedAt
                : now,
            updatedAt: now,
        };
        collection.items.push(item);
    }
    touch(workspace);
    return item;
}

function removeItem(workspace, kind, id) {
    const collection = collectionFor(workspace, kind);
    const itemId = normalizedItemId(id);
    const index = collection.items.findIndex(
        candidate => candidate.id === itemId
    );
    if (index < 0) return null;
    const removed = collection.items.splice(index, 1)[0];
    touch(workspace);
    return removed;
}

function createFolder(workspace, kind, name) {
    const collection = collectionFor(workspace, kind);
    const normalizedName = String(name || '').trim().replace(/\s+/g, ' ');
    if (!normalizedName) {
        throw new TypeError('Experiment Lab folder name is required');
    }
    const existing = collection.folders.find(
        folder => folder.name.toLowerCase() === normalizedName.toLowerCase()
    );
    if (existing) return existing;
    const seed = [
        workspace.account.id,
        kind,
        normalizedName.toLowerCase(),
    ].join(':');
    const baseId = `elf${crypto.createHash('sha256')
        .update(seed)
        .digest('hex')
        .slice(0, 20)}`;
    let id = baseId;
    let suffix = 1;
    while (collection.folders.some(folder => folder.id === id)) {
        id = `${baseId.slice(0, 18)}${suffix++}`;
    }
    const folder = {
        id,
        name: normalizedName.slice(0, 120),
        createdAt: Date.now(),
    };
    collection.folders.push(folder);
    touch(workspace);
    return folder;
}

function moveItem(workspace, kind, id, folderId) {
    const collection = collectionFor(workspace, kind);
    const itemId = normalizedItemId(id);
    const item = collection.items.find(
        candidate => candidate.id === itemId
    );
    if (!item) {
        throw new Error('Item is not saved in this workspace');
    }
    const folder = folderFor(collection, folderId);
    item.folderId = folder ? folder.id : null;
    item.updatedAt = Date.now();
    touch(workspace);
    return item;
}

function deleteFolder(workspace, kind, folderId) {
    const collection = collectionFor(workspace, kind);
    const folder = folderFor(collection, folderId);
    collection.folders = collection.folders.filter(
        candidate => candidate.id !== folder.id
    );
    for (const item of collection.items) {
        if (item.folderId === folder.id) {
            item.folderId = null;
            item.updatedAt = Date.now();
        }
    }
    touch(workspace);
    return folder;
}

function activityId(workspace, activity) {
    const seed = [
        workspace.account.id,
        activity.requestId || '',
        activity.type || '',
        Date.now(),
        crypto.randomBytes(8).toString('hex'),
    ].join(':');
    return `ela${crypto.createHash('sha256')
        .update(seed)
        .digest('hex')
        .slice(0, 20)}`;
}

function activityHistoryEntry(value, at) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        status: String(source.status || 'recorded').slice(0, 80),
        detail: source.detail == null
            ? null
            : String(source.detail).slice(0, 500),
        saved: source.saved === true,
        artifactKind: source.artifactKind == null
            ? null
            : String(source.artifactKind).slice(0, 40),
        artifactId: source.artifactId == null
            ? null
            : String(source.artifactId).slice(0, 160),
        at,
    };
}

function activityHistoryChanged(previous, next) {
    if (!previous) return true;
    return [
        'status',
        'detail',
        'saved',
        'artifactKind',
        'artifactId',
    ].some(key => previous[key] !== next[key]);
}

function addActivity(workspace, input) {
    const value = input && typeof input === 'object' ? input : {};
    const requestId = String(value.requestId || '').trim().slice(0, 160);
    let activity = requestId
        ? workspace.activity.find(
            candidate => candidate.requestId === requestId
        )
        : null;
    const now = Date.now();
    if (activity) {
        const clonedValue = clone(value);
        const next = {
            ...activity,
            ...clonedValue,
            ...(activity.input || clonedValue.input
                ? {
                    input: {
                        ...(activity.input || {}),
                        ...(clonedValue.input || {}),
                    },
                }
                : {}),
            ...(activity.output || clonedValue.output
                ? {
                    output: {
                        ...(activity.output || {}),
                        ...(clonedValue.output || {}),
                    },
                }
                : {}),
        };
        const history = Array.isArray(activity.history)
            ? clone(activity.history)
            : [activityHistoryEntry(
                activity,
                activity.updatedAt || activity.createdAt || now
            )];
        const historyEntry = activityHistoryEntry(next, now);
        if (activityHistoryChanged(history[history.length - 1], historyEntry)) {
            history.push(historyEntry);
        }
        Object.assign(activity, next, {
            id: activity.id,
            requestId,
            createdAt: activity.createdAt,
            updatedAt: now,
            history: history.slice(-MAX_ACTIVITY_HISTORY),
        });
        workspace.activity = [
            activity,
            ...workspace.activity.filter(
                candidate => candidate !== activity
            ),
        ];
    } else {
        activity = {
            ...clone(value),
            id: activityId(workspace, value),
            requestId: requestId || null,
            createdAt: now,
            updatedAt: now,
        };
        activity.history = [activityHistoryEntry(activity, now)];
        workspace.activity.unshift(activity);
    }
    workspace.activity = workspace.activity.slice(0, MAX_ACTIVITY);
    touch(workspace);
    return activity;
}

function markArtifactSaved(workspace, kind, artifactId, saved) {
    if (!COLLECTIONS.includes(kind)) {
        throw new TypeError('Experiment Lab collection kind is invalid');
    }
    const id = normalizedItemId(artifactId);
    let changed = 0;
    for (const activity of workspace.activity) {
        if (
            activity.artifactKind === kind
            && activity.artifactId === id
        ) {
            const now = Date.now();
            activity.saved = !!saved;
            activity.status = saved ? 'saved' : 'removed';
            activity.updatedAt = now;
            const history = Array.isArray(activity.history)
                ? activity.history
                : [];
            const entry = activityHistoryEntry(activity, now);
            if (activityHistoryChanged(history[history.length - 1], entry)) {
                history.push(entry);
            }
            activity.history = history.slice(-MAX_ACTIVITY_HISTORY);
            changed += 1;
        }
    }
    if (changed) touch(workspace);
    return changed;
}

function validateWorkspace(workspace) {
    const errors = [];
    if (!workspace || typeof workspace !== 'object') {
        return {
            valid: false,
            errors: ['workspace is missing'],
        };
    }
    if (workspace.schema !== SCHEMA) {
        errors.push('workspace schema differs');
    }
    if (workspace.schemaVersion !== SCHEMA_VERSION) {
        errors.push('workspace schema version differs');
    }
    try {
        const identity = accountIdentity(workspace.account);
        if (
            !canonicalJsonBytes(identity).equals(
                canonicalJsonBytes(workspace.account)
            )
        ) errors.push(IDENTITY_SHAPE_ERROR);
    } catch (error) {
        errors.push(error.message);
    }
    if (!Number.isSafeInteger(workspace.createdAt)) {
        errors.push('workspace createdAt is invalid');
    }
    if (!Number.isSafeInteger(workspace.updatedAt)) {
        errors.push('workspace updatedAt is invalid');
    }
    for (const kind of COLLECTIONS) {
        const collection =
            workspace.collections && workspace.collections[kind];
        if (
            !collection
            || !Array.isArray(collection.folders)
            || !Array.isArray(collection.items)
        ) {
            errors.push(`${kind} collection is invalid`);
            continue;
        }
        const folderIds = new Set();
        for (const folder of collection.folders) {
            if (
                !folder
                || !ITEM_ID_PATTERN.test(String(folder.id || ''))
                || !String(folder.name || '').trim()
                || folderIds.has(folder.id)
            ) {
                errors.push(`${kind} folder is invalid`);
                continue;
            }
            folderIds.add(folder.id);
        }
        const itemIds = new Set();
        for (const item of collection.items) {
            if (
                !item
                || !ITEM_ID_PATTERN.test(String(item.id || ''))
                || itemIds.has(item.id)
            ) {
                errors.push(`${kind} item is invalid`);
                continue;
            }
            itemIds.add(item.id);
            if (
                item.folderId != null
                && !folderIds.has(item.folderId)
            ) errors.push(`${kind} item folder is invalid`);
        }
    }
    if (
        !Array.isArray(workspace.activity)
        || workspace.activity.length > MAX_ACTIVITY
    ) errors.push('workspace activity is invalid');
    const expectedSha = sha256Bytes(
        canonicalJsonBytes(bindingPayload(workspace))
    );
    if (
        !SHA256_PATTERN.test(String(workspace.workspace_sha256 || ''))
        || workspace.workspace_sha256 !== expectedSha
    ) errors.push('workspace SHA binding differs');
    return {
        valid: errors.length === 0,
        errors: [...new Set(errors)],
    };
}

function validateWorkspaceForAccount(
    workspace,
    account,
    { allowIdentityNormalization = false } = {}
) {
    const validation = validateWorkspace(workspace);
    let errors = [...validation.errors];
    let identity = null;
    try {
        identity = accountIdentity(account);
    } catch (error) {
        errors.push(error.message);
    }
    const storedId = String(
        workspace
        && workspace.account
        && workspace.account.id
        || ''
    ).trim().toLowerCase();
    const sameAccount = !!(
        identity
        && storedId
        && storedId === identity.id
    );
    if (identity && !sameAccount) {
        errors.push(IDENTITY_SCOPE_ERROR);
    } else if (
        sameAccount
        && !canonicalJsonBytes(workspace.account).equals(
            canonicalJsonBytes(identity)
        )
    ) {
        errors.push(IDENTITY_STALE_ERROR);
    }
    if (allowIdentityNormalization && sameAccount) {
        errors = errors.filter(error => ![
            IDENTITY_SHAPE_ERROR,
            IDENTITY_STALE_ERROR,
        ].includes(error));
    }
    errors = [...new Set(errors)];
    return {
        valid: errors.length === 0,
        errors,
        identity,
        sameAccount,
    };
}

function normalizeWorkspaceIdentity(workspace, account) {
    const validation = validateWorkspaceForAccount(
        workspace,
        account,
        { allowIdentityNormalization: true }
    );
    if (!validation.valid) {
        throw new Error(
            'Experiment Lab workspace cannot normalize identity: '
            + validation.errors.join('; ')
        );
    }
    return bindWorkspace({
        ...clone(workspace),
        account: validation.identity,
        updatedAt: Date.now(),
    });
}

async function readWorkspaceRevisionForAccount(cas, account) {
    if (
        !cas
        || typeof cas.readRevision !== 'function'
        || typeof cas.mutate !== 'function'
    ) {
        throw new TypeError(
            'Experiment Lab workspace CAS is invalid'
        );
    }
    const revision = await cas.readRevision();
    let workspace = revision.value;
    let validation = validateWorkspaceForAccount(
        workspace,
        account
    );
    if (!validation.valid && revision.revision) {
        const repairable = validateWorkspaceForAccount(
            workspace,
            account,
            { allowIdentityNormalization: true }
        );
        if (repairable.valid) {
            workspace = await cas.mutate(current => {
                const currentValidation =
                    validateWorkspaceForAccount(
                        current,
                        account
                    );
                if (currentValidation.valid) return null;
                const currentRepairable =
                    validateWorkspaceForAccount(
                        current,
                        account,
                        { allowIdentityNormalization: true }
                    );
                if (!currentRepairable.valid) {
                    throw new Error(
                        'Experiment Lab workspace failed validation: '
                        + currentRepairable.errors.join('; ')
                    );
                }
                return current;
            });
            validation = validateWorkspaceForAccount(
                workspace,
                account
            );
        }
    }
    if (!validation.valid) {
        throw new Error(
            'Experiment Lab workspace failed validation: '
            + validation.errors.join('; ')
        );
    }
    return {
        workspace,
        exists: !!revision.revision,
    };
}

function summary(workspace) {
    const counts = {};
    const folderCounts = {};
    for (const kind of COLLECTIONS) {
        const collection = collectionFor(workspace, kind);
        counts[kind] = collection.items.length;
        folderCounts[kind] = collection.folders.length;
    }
    return {
        account: clone(workspace.account),
        counts,
        folderCounts,
        activityCount: workspace.activity.length,
        updatedAt: workspace.updatedAt,
        workspace_sha256: workspace.workspace_sha256,
    };
}

module.exports = {
    SCHEMA,
    SCHEMA_VERSION,
    COLLECTIONS,
    MAX_ACTIVITY,
    MAX_ACTIVITY_HISTORY,
    accountKey,
    workspaceKey,
    accountIdentity,
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
    summary,
};
