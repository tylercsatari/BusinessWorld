#!/usr/bin/env python3

import copy
import hashlib
import os
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from shorts_score_ledger import (  # noqa: E402
    EXPECTED_COORDINATE_IDS,
    FEATURE_CONTRACT,
    GOVERNANCE,
    feature_bundle_from_ledger,
    ledger_json_bytes,
    materialize_score_bundle,
    migrate_prior_canonical_score_ledger,
    saved_channel_manifest_row_binding_sha256,
    validate_saved_channel_manifest_row_binding,
    validate_score_ledger,
    validate_shorts_input_manifest,
)


def fixture(include_text=True):
    steer = {}
    channels = ('visual', 'text', 'together') if include_text else (
        'visual',
        'together',
    )
    for channel in channels:
        for target in ('keep', 'ret5', 'views', 'outlier', 'gt10M'):
            if target in ('keep', 'ret5'):
                value = 75.0
            elif target == 'gt10M':
                value = 0.75
            elif target == 'views':
                value = 100000
            else:
                value = 2.0
            steer[f'{channel}_{target}'] = {
                'est': value,
                'pctile': 60.0,
                'kind': 'pct',
            }
        steer[f'{channel}_realviews'] = {
            'est': 250000,
            'pctile': None,
            'kind': 'realviews',
        }
    indicators = {
        f'novelty_{target}': 0.5
        for target in ('keep', 'ret5', 'views')
    }
    registry = {
        'meta': {'version': 1},
        'indicators': [
            {
                'name': f'novelty_{target}',
                'kind': 'novelty',
                'target': target,
                'validated': True,
                'spearman': 0.2,
                'pts': [[0.1, 1.0], [0.5, 2.0], [0.9, 3.0]],
            }
            for target in ('keep', 'ret5', 'views')
        ],
    }
    return {'steer': steer, 'indicators': indicators}, registry


record, registry = fixture()
bundle = materialize_score_bundle(
    record,
    registry,
    {'sha256': 'a' * 64},
)
ledger = bundle['score_ledger']
assert FEATURE_CONTRACT['version'] == 10
assert GOVERNANCE['schemaVersion'] == 4
assert GOVERNANCE['ledgerVersion'] == 11
assert GOVERNANCE['valueUnits']['percent'][
    'minimumInclusive'
] == 0
assert GOVERNANCE['valueUnits']['percent'][
    'maximumInclusive'
] == 100
assert GOVERNANCE['valueUnits'][
    'retention_percent_rewatch_capable'
]['minimumInclusive'] == 0
assert GOVERNANCE['valueUnits'][
    'retention_percent_rewatch_capable'
]['maximumInclusive'] is None
assert all(
    definition['unit'] == 'retention_percent_rewatch_capable'
    for definition in FEATURE_CONTRACT['features']
    if definition['target'] == 'ret5'
)
assert all(
    definition['unit'] == 'percent'
    for definition in FEATURE_CONTRACT['features']
    if definition['target'] == 'keep'
)
assert ledger['schema_complete'] is True
assert ledger['all_values_available'] is True
assert ledger['available_count'] == 21
assert [entry['coordinate_id'] for entry in ledger['entries']] == list(
    EXPECTED_COORDINATE_IDS
)
assert len(set(EXPECTED_COORDINATE_IDS)) == 21
assert all(
    cell['coordinate_id'] == f"shorts.stored.{cell['feature_key']}"
    for cell in bundle['addressed_steer'].values()
)

manifest_row = {
    'id': 'fixture-video',
    'title': 'Canonical saved-channel row',
    'status': 'done',
    'views': 123456,
    'published': '2026-01-02',
    'viewsObservedAt': 456,
    'scoredAt': 123,
    'score_record_sha256': 'b' * 64,
    'record_artifact_sha256': 'c' * 64,
    'record_byte_length': 4096,
    'score_ledger': ledger,
    'input_manifest': {
        'revision_fingerprint': 'revision',
    },
    'evidence_state': 'canonical_bound',
    'canonical': True,
    'predictor_eligible': True,
    'evidence_warning': None,
}
manifest_row['manifest_row_sha256'] = (
    saved_channel_manifest_row_binding_sha256(manifest_row)
)
assert validate_saved_channel_manifest_row_binding(
    manifest_row
)['valid'] is True
for field, value in (
    ('record_artifact_sha256', 'd' * 64),
    ('record_byte_length', 4097),
):
    changed = copy.deepcopy(manifest_row)
    changed[field] = value
    assert validate_saved_channel_manifest_row_binding(
        changed
    )['valid'] is False

montage_bytes = b'canonical-five-frame-jpeg'
montage_sha256 = hashlib.sha256(montage_bytes).hexdigest()
normalized_text = 'This is the exact transcript.'
embedding_input = {
    'schema': 'shorts-embedding-input-v2',
    'montage_sha256': montage_sha256,
    'transcript': normalized_text,
    'channels': {
        'visual': '5-frame-montage',
        'text': 'normalized-transcript',
        'together': '5-frame-montage+normalized-transcript',
    },
}
embedding_input_fingerprint = hashlib.sha256(
    ledger_json_bytes(embedding_input)
).hexdigest()
score_input = {
    'schema': 'shorts-score-input-v2',
    'embedding_input_fingerprint': embedding_input_fingerprint,
    'embedding_input': embedding_input,
    'duration_ms': 4321,
    'creator_profile': 'tyler',
}
score_input_fingerprint = hashlib.sha256(
    ledger_json_bytes(score_input)
).hexdigest()
exact_input_record = {
    'input_manifest': {
        'domain': 'shorts_raw',
        'canonical_montage': {
            'montage_sha256': montage_sha256,
        },
        'transcript_used': True,
        'duration_s': 4.321,
        'creator_profile': 'tyler',
        'embedding_input_fingerprint':
            embedding_input_fingerprint,
        'score_input_fingerprint': score_input_fingerprint,
        'input_fingerprint': score_input_fingerprint,
        'channels': {
            'text': {
                'text': '  This   is the exact transcript.  ',
            },
        },
    },
}
exact_input_validation = validate_shorts_input_manifest(
    exact_input_record,
    {
        'montageBytes': montage_bytes,
        'text': normalized_text,
        'durationS': 4.321,
        'creatorProfile': 'TYLER',
    },
)
assert exact_input_validation['valid'] is True
assert (
    exact_input_validation['embeddingFingerprint']
    == embedding_input_fingerprint
)
for expected_override, error_fragment in (
    ({'montageBytes': b'different-jpeg'}, 'montage bytes'),
    ({'text': 'Different transcript'}, 'transcript text'),
    ({'durationS': 4.322}, 'different duration'),
    ({'creatorProfile': 'another'}, 'creator profile'),
):
    exact_expected = {
        'montageBytes': montage_bytes,
        'text': normalized_text,
        'durationS': 4.321,
        'creatorProfile': 'tyler',
        **expected_override,
    }
    invalid_input = validate_shorts_input_manifest(
        exact_input_record,
        exact_expected,
    )
    assert invalid_input['valid'] is False
    assert any(
        error_fragment in error
        for error in invalid_input['errors']
    )

tampered_input_record = copy.deepcopy(exact_input_record)
tampered_input_record['input_manifest'][
    'embedding_input_fingerprint'
] = 'f' * 64
tampered_input_validation = validate_shorts_input_manifest(
    tampered_input_record
)
assert tampered_input_validation['valid'] is False
assert 'Shorts embedding input fingerprint differs' in (
    tampered_input_validation['errors']
)

restored = feature_bundle_from_ledger(ledger)
assert restored['features'] == bundle['features']
assert set(restored['features']) == {
    coordinate_id.replace('shorts.stored.', '')
    for coordinate_id in EXPECTED_COORDINATE_IDS
}

visual_only_record, visual_only_registry = fixture(include_text=False)
visual_only = materialize_score_bundle(
    visual_only_record,
    visual_only_registry,
    {'sha256': 'b' * 64},
)['score_ledger']
assert visual_only['schema_complete'] is True
assert visual_only['all_values_available'] is False
assert visual_only['available_count'] == 15
assert {
    row['coordinate_id']
    for row in visual_only['unavailable']
} == {
    f'shorts.stored.text.{target}'
    for target in (
        'keep',
        'ret5',
        'views',
        'realviews',
        'outlier',
        'gt10M',
    )
}

bad_record, bad_registry = fixture()
bad_record['steer']['visual_keep']['coordinate_id'] = (
    'shorts.stored.together.keep'
)
bad = materialize_score_bundle(
    bad_record,
    bad_registry,
    {'sha256': 'c' * 64},
)['score_ledger']
bad_entry = next(
    entry
    for entry in bad['entries']
    if entry['coordinate_id'] == 'shorts.stored.visual.keep'
)
assert bad_entry['available'] is False
assert 'identity mismatch' in bad_entry['unavailable_reason']

tampered = copy.deepcopy(ledger)
tampered['entries'][0]['value'] += 1
try:
    feature_bundle_from_ledger(tampered)
    raise AssertionError('tampered ledger should fail its content hash')
except ValueError as error:
    assert 'content hash' in str(error)


def rehash(value):
    value['ledger_sha256'] = hashlib.sha256(ledger_json_bytes({
        key: item
        for key, item in value.items()
        if key != 'ledger_sha256'
    })).hexdigest()


wrong_feature_document = copy.deepcopy(ledger)
wrong_feature_document['feature_contract_document_sha256'] = 'a' * 64
rehash(wrong_feature_document)
archived_document_bundle = feature_bundle_from_ledger(
    wrong_feature_document
)
assert archived_document_bundle['features'] == bundle['features']

malformed_feature_document = copy.deepcopy(ledger)
malformed_feature_document['feature_contract_document_sha256'] = 'bad'
rehash(malformed_feature_document)
try:
    feature_bundle_from_ledger(malformed_feature_document)
    raise AssertionError(
        'a malformed feature-contract document hash should fail closed'
    )
except ValueError as error:
    assert 'feature contract document hash is missing' in str(error)


relabeled = copy.deepcopy(ledger)
relabeled['entries'][0]['group'] = 'text'
rehash(relabeled)
try:
    feature_bundle_from_ledger(relabeled)
    raise AssertionError('semantically relabeled ledger should fail')
except ValueError as error:
    assert 'identity differs' in str(error)

indexed_extra = copy.deepcopy(ledger)
indexed_extra['values_by_id']['shorts.stored.fake.keep'] = 50
rehash(indexed_extra)
try:
    feature_bundle_from_ledger(indexed_extra)
    raise AssertionError('ledger with an extra index key should fail')
except ValueError as error:
    assert 'value index is not exact' in str(error)

unavailable_percentile = copy.deepcopy(visual_only)
text_keep = next(
    entry
    for entry in unavailable_percentile['entries']
    if entry['coordinate_id'] == 'shorts.stored.text.keep'
)
text_keep['percentile'] = 99
unavailable_percentile['percentiles_by_id'][
    'shorts.stored.text.keep'
] = 99
rehash(unavailable_percentile)
try:
    feature_bundle_from_ledger(unavailable_percentile)
    raise AssertionError('unavailable coordinate percentile should fail')
except ValueError as error:
    assert 'unavailable percentile' in str(error)


def ledger_with_value(coordinate_id, value):
    candidate = copy.deepcopy(ledger)
    entry = next(
        row
        for row in candidate['entries']
        if row['coordinate_id'] == coordinate_id
    )
    entry['value'] = value
    candidate['values_by_id'][coordinate_id] = value
    rehash(candidate)
    return candidate


def ledger_with_percentile(coordinate_id, percentile):
    candidate = copy.deepcopy(ledger)
    entry = next(
        row
        for row in candidate['entries']
        if row['coordinate_id'] == coordinate_id
    )
    entry['percentile'] = percentile
    candidate['percentiles_by_id'][coordinate_id] = percentile
    rehash(candidate)
    return candidate


valid_boundaries = (
    ledger_with_value('shorts.stored.visual.keep', 0),
    ledger_with_value('shorts.stored.visual.keep', 100),
    ledger_with_value('shorts.stored.visual.ret5', 150),
    ledger_with_value('shorts.stored.visual.gt10M', 0),
    ledger_with_value('shorts.stored.visual.gt10M', 1),
    ledger_with_value('shorts.stored.visual.views', 0),
    ledger_with_value('shorts.stored.novelty.views', 0),
    ledger_with_value('shorts.stored.visual.outlier', -2.5),
    ledger_with_percentile('shorts.stored.visual.keep', 0),
    ledger_with_percentile('shorts.stored.visual.keep', 100),
)
for boundary_ledger in valid_boundaries:
    validate_score_ledger(boundary_ledger)

invalid_boundaries = (
    ledger_with_value('shorts.stored.visual.keep', -0.001),
    ledger_with_value('shorts.stored.visual.keep', 150),
    ledger_with_value('shorts.stored.visual.ret5', -0.001),
    ledger_with_value('shorts.stored.visual.gt10M', -0.001),
    ledger_with_value('shorts.stored.visual.gt10M', 1.001),
    ledger_with_value('shorts.stored.visual.views', -1),
    ledger_with_value('shorts.stored.novelty.views', -0.001),
    ledger_with_percentile('shorts.stored.visual.keep', -0.001),
    ledger_with_percentile('shorts.stored.visual.keep', 100.001),
)
for invalid_boundary_ledger in invalid_boundaries:
    try:
        validate_score_ledger(invalid_boundary_ledger)
        raise AssertionError('out-of-range canonical value should fail')
    except ValueError as error:
        assert 'outside governance range' in str(error)

realviews_entry = next(
    entry
    for entry in ledger['entries']
    if entry['coordinate_id'] == 'shorts.stored.visual.realviews'
)
assert realviews_entry['available'] is True
assert realviews_entry['percentile'] is None

for source_key, invalid_value, coordinate_id in (
    ('visual_keep', -0.001, 'shorts.stored.visual.keep'),
    ('visual_keep', 150, 'shorts.stored.visual.keep'),
    ('visual_ret5', -0.001, 'shorts.stored.visual.ret5'),
    ('visual_gt10M', -0.001, 'shorts.stored.visual.gt10M'),
    ('visual_gt10M', 1.001, 'shorts.stored.visual.gt10M'),
    ('visual_views', -1, 'shorts.stored.visual.views'),
):
    invalid_record, invalid_registry = fixture()
    invalid_record['steer'][source_key]['est'] = invalid_value
    invalid_bundle = materialize_score_bundle(
        invalid_record,
        invalid_registry,
    )
    invalid_entry = next(
        entry
        for entry in invalid_bundle['score_ledger']['entries']
        if entry['coordinate_id'] == coordinate_id
    )
    assert invalid_entry['available'] is False
    assert invalid_entry['value'] is None
    assert invalid_entry['percentile'] is None
    assert 'outside governance range' in (
        invalid_entry['unavailable_reason']
    )
    validate_score_ledger(invalid_bundle['score_ledger'])

rewatch_record, rewatch_registry = fixture()
rewatch_record['steer']['visual_ret5']['est'] = 150
rewatch_bundle = materialize_score_bundle(
    rewatch_record,
    rewatch_registry,
)
rewatch_entry = next(
    entry
    for entry in rewatch_bundle['score_ledger']['entries']
    if entry['coordinate_id'] == 'shorts.stored.visual.ret5'
)
assert rewatch_entry['available'] is True
assert rewatch_entry['value'] == 150
assert (
    rewatch_entry['unit']
    == 'retention_percent_rewatch_capable'
)
validate_score_ledger(rewatch_bundle['score_ledger'])

invalid_percentile_record, invalid_percentile_registry = fixture()
invalid_percentile_record['steer']['visual_keep']['pctile'] = 100.001
invalid_percentile_bundle = materialize_score_bundle(
    invalid_percentile_record,
    invalid_percentile_registry,
)
invalid_percentile_entry = next(
    entry
    for entry in invalid_percentile_bundle['score_ledger']['entries']
    if entry['coordinate_id'] == 'shorts.stored.visual.keep'
)
assert invalid_percentile_entry['available'] is False
assert invalid_percentile_entry['value'] is None
assert invalid_percentile_entry['percentile'] is None
assert 'outside governance range' in (
    invalid_percentile_entry['unavailable_reason']
)
validate_score_ledger(invalid_percentile_bundle['score_ledger'])

negative_novelty_record, negative_novelty_registry = fixture()
for indicator in negative_novelty_registry['indicators']:
    if indicator['target'] == 'views':
        indicator['pts'] = [
            [0.1, -3.0],
            [0.5, -2.0],
            [0.9, -1.0],
        ]
negative_novelty_bundle = materialize_score_bundle(
    negative_novelty_record,
    negative_novelty_registry,
)
negative_novelty_entry = next(
    entry
    for entry in negative_novelty_bundle['score_ledger']['entries']
    if entry['coordinate_id'] == 'shorts.stored.novelty.views'
)
assert negative_novelty_entry['available'] is False
assert negative_novelty_entry['value'] is None
assert 'outside governance range' in (
    negative_novelty_entry['unavailable_reason']
)
validate_score_ledger(negative_novelty_bundle['score_ledger'])

prior = copy.deepcopy(ledger)
approved_prior_revision = (
    GOVERNANCE['compatibility']['migratableLedgerRevisions'][0]
)
prior['ledger_version'] = approved_prior_revision['ledgerVersion']
prior['feature_contract_version'] = (
    approved_prior_revision['featureContractVersion']
)
prior['feature_contract_identity_schema_version'] = (
    approved_prior_revision['featureContractIdentitySchemaVersion']
)
prior['feature_contract_sha256'] = (
    approved_prior_revision['featureContractSha256']
)
prior['feature_contract_document_sha256'] = (
    approved_prior_revision['featureContractDocumentSha256']
)
prior['coordinate_governance_version'] = (
    approved_prior_revision['coordinateGovernanceVersion']
)
prior['coordinate_governance_sha256'] = (
    approved_prior_revision['coordinateGovernanceSha256']
)
for prior_entry in prior['entries']:
    if prior_entry['target'] == 'ret5':
        prior_entry['unit'] = (
            approved_prior_revision['scoreValueMigration']['fromUnit']
        )
rehash(prior)
out_of_range_prior = copy.deepcopy(prior)
out_of_range_prior_entry = next(
    entry
    for entry in out_of_range_prior['entries']
    if entry['coordinate_id'] == 'shorts.stored.visual.gt10M'
)
out_of_range_prior_entry['value'] = 1.001
out_of_range_prior['values_by_id'][
    out_of_range_prior_entry['coordinate_id']
] = 1.001
rehash(out_of_range_prior)
try:
    migrate_prior_canonical_score_ledger(out_of_range_prior)
    raise AssertionError('out-of-range prior value should not migrate')
except ValueError as error:
    assert 'outside governance range' in str(error)

out_of_range_prior_ret5 = copy.deepcopy(prior)
out_of_range_prior_ret5_entry = next(
    entry
    for entry in out_of_range_prior_ret5['entries']
    if entry['coordinate_id'] == 'shorts.stored.visual.ret5'
)
out_of_range_prior_ret5_entry['value'] = 150
out_of_range_prior_ret5['values_by_id'][
    out_of_range_prior_ret5_entry['coordinate_id']
] = 150
rehash(out_of_range_prior_ret5)
migrated_rewatch_capable = migrate_prior_canonical_score_ledger(
    out_of_range_prior_ret5
)
assert migrated_rewatch_capable['values_by_id'][
    out_of_range_prior_ret5_entry['coordinate_id']
] == 150

upgraded = migrate_prior_canonical_score_ledger(prior)
feature_bundle_from_ledger(upgraded)
assert upgraded['values_by_id'] == ledger['values_by_id']
assert upgraded['percentiles_by_id'] == ledger['percentiles_by_id']
assert all(
    entry['unit'] == 'retention_percent_rewatch_capable'
    for entry in upgraded['entries']
    if entry['target'] == 'ret5'
)
assert 'migration_provenance' not in upgraded
unknown_prior = copy.deepcopy(prior)
unknown_prior['coordinate_governance_sha256'] = 'c' * 64
rehash(unknown_prior)
try:
    migrate_prior_canonical_score_ledger(unknown_prior)
    raise AssertionError('invented prior revision should fail closed')
except ValueError as error:
    assert 'immutable migration allowlist' in str(error)

tampered_prior = copy.deepcopy(prior)
tampered_prior['entries'][0]['value'] += 1
try:
    migrate_prior_canonical_score_ledger(tampered_prior)
    raise AssertionError('tampered prior ledger should fail its content hash')
except ValueError as error:
    assert 'content hash' in str(error)

relabeled_prior = copy.deepcopy(prior)
relabeled_prior['entries'][0]['group'] = 'text'
rehash(relabeled_prior)
try:
    migrate_prior_canonical_score_ledger(relabeled_prior)
    raise AssertionError('relabeled prior ledger should fail')
except ValueError as error:
    assert 'identity differs' in str(error)

invalid_current = copy.deepcopy(ledger)
invalid_current['entries'][0]['group'] = 'text'
rehash(invalid_current)
try:
    migrate_prior_canonical_score_ledger(invalid_current)
    raise AssertionError('current ledger must not enter prior migration')
except ValueError as error:
    assert 'prior version' in str(error)

print({
    'ok': True,
    'coordinates': len(EXPECTED_COORDINATE_IDS),
    'visualOnlyAvailable': visual_only['available_count'],
    'identityMismatchFailsClosed': True,
    'tamperCheck': True,
    'semanticRelabelCheck': True,
    'priorMigrationCheck': True,
})
