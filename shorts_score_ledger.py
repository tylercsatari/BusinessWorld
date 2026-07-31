#!/usr/bin/env python3
"""Canonical materialization of the 21 stored Shorts score coordinates."""

import copy
import hashlib
import json
import math
import os
import re
import unicodedata


HERE = os.path.dirname(os.path.abspath(__file__))
FEATURE_CONTRACT_PATH = os.path.join(
    HERE,
    'buildings',
    'jarvis',
    'saved-channel-feature-contract.json',
)
GOVERNANCE_PATH = os.path.join(
    HERE,
    'buildings',
    'jarvis',
    'quant-coordinate-governance.json',
)


def _read_json(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


FEATURE_CONTRACT = _read_json(FEATURE_CONTRACT_PATH)
GOVERNANCE = _read_json(GOVERNANCE_PATH)
FEATURE_CONTRACT_DOCUMENT_SHA256 = hashlib.sha256(
    open(FEATURE_CONTRACT_PATH, 'rb').read()
).hexdigest()
GOVERNANCE_SHA256 = hashlib.sha256(
    open(GOVERNANCE_PATH, 'rb').read()
).hexdigest()
STORED_PATTERN = GOVERNANCE['coordinates']['storedPattern']
FEATURES = tuple(FEATURE_CONTRACT.get('features') or ())
FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION = 1
FEATURE_CONTRACT_IDENTITY = {
    'schema': 'shorts-stored-score-contract-identity-v1',
    'schema_version': FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    'pipeline': {
        key: (FEATURE_CONTRACT.get('pipeline') or {}).get(key)
        for key in (
            'sourceWindow',
            'embeddingModel',
            'embeddingDimensions',
            'scorer',
        )
    },
    'features': [
        {
            key: definition.get(key)
            for key in (
                'key',
                'group',
                'target',
                'unit',
                'displayUnit',
                'source',
                'sourceKey',
            )
        }
        for definition in FEATURES
    ],
}
FEATURE_CONTRACT_SHA256 = hashlib.sha256(json.dumps(
    FEATURE_CONTRACT_IDENTITY,
    sort_keys=True,
    separators=(',', ':'),
    ensure_ascii=False,
).encode('utf-8')).hexdigest()


def stable_json_bytes(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(',', ':'),
        ensure_ascii=False,
    ).encode('utf-8')


def _ledger_json_value(value):
    if isinstance(value, float):
        if value == 0:
            return 0
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, list):
        return [_ledger_json_value(item) for item in value]
    if isinstance(value, tuple):
        return [_ledger_json_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _ledger_json_value(item)
            for key, item in value.items()
        }
    return value


def ledger_json_bytes(value):
    return stable_json_bytes(_ledger_json_value(value))


def saved_channel_manifest_row_binding_payload(row):
    row = row if isinstance(row, dict) else {}
    ledger = row.get('score_ledger')
    input_manifest = row.get('input_manifest')
    return {
        'schema': 'saved-channel-manifest-row-binding-v3',
        'id': row.get('id'),
        'title': row.get('title'),
        'status': row.get('status'),
        'views': row.get('views'),
        'published': row.get('published'),
        'viewsObservedAt': row.get('viewsObservedAt'),
        'scoredAt': row.get('scoredAt'),
        'score_record_sha256': row.get('score_record_sha256'),
        'record_artifact_sha256':
            row.get('record_artifact_sha256'),
        'record_byte_length': row.get('record_byte_length'),
        'score_ledger': {
            'ledger_sha256': (
                ledger.get('ledger_sha256')
                if isinstance(ledger, dict)
                else None
            ),
        },
        'input_manifest': {
            'revision_fingerprint': (
                input_manifest.get('revision_fingerprint')
                if isinstance(input_manifest, dict)
                else None
            ),
        },
        'evidence': {
            'state': row.get('evidence_state'),
            'canonical': row.get('canonical') is True,
            'predictor_eligible':
                row.get('predictor_eligible') is True,
            'warning': row.get('evidence_warning'),
        },
    }


def saved_channel_manifest_row_binding_sha256(row):
    return hashlib.sha256(ledger_json_bytes(
        saved_channel_manifest_row_binding_payload(row)
    )).hexdigest()


def validate_saved_channel_manifest_row_binding(row):
    row = row if isinstance(row, dict) else {}
    errors = []
    recorded = row.get('manifest_row_sha256')
    score_record_sha256 = row.get('score_record_sha256')
    record_artifact_sha256 = row.get(
        'record_artifact_sha256'
    )
    record_byte_length = row.get('record_byte_length')
    ledger = row.get('score_ledger')
    ledger_sha256 = (
        ledger.get('ledger_sha256')
        if isinstance(ledger, dict)
        else None
    )
    for label, value in (
        ('manifest-row', recorded),
        ('score-record', score_record_sha256),
        ('record-artifact', record_artifact_sha256),
        ('score-ledger', ledger_sha256),
    ):
        if (
            not isinstance(value, str)
            or re.fullmatch(r'[a-f0-9]{64}', value) is None
        ):
            errors.append(
                f'saved-channel {label} SHA-256 is invalid'
            )
    if (
        not isinstance(record_byte_length, int)
        or isinstance(record_byte_length, bool)
        or record_byte_length <= 0
    ):
        errors.append(
            'saved-channel record byte length is invalid'
        )
    evidence_state = row.get('evidence_state')
    if evidence_state == 'canonical_bound':
        if row.get('canonical') is not True:
            errors.append(
                'canonical saved-channel evidence must set canonical=true'
            )
        if not isinstance(row.get('predictor_eligible'), bool):
            errors.append(
                'canonical saved-channel predictor eligibility is missing'
            )
        if row.get('evidence_warning') is not None:
            errors.append(
                'canonical saved-channel evidence cannot carry a warning'
            )
    elif evidence_state == 'historical_unbound_input':
        if (
            row.get('canonical') is not False
            or row.get('predictor_eligible') is not False
        ):
            errors.append(
                'historical saved-channel evidence must be '
                'non-canonical and non-predictive'
            )
        if not str(row.get('evidence_warning') or '').strip():
            errors.append(
                'historical saved-channel evidence warning is missing'
            )
    else:
        errors.append(
            'saved-channel evidence state is missing or invalid'
        )
    calculated = saved_channel_manifest_row_binding_sha256(
        row
    )
    if recorded != calculated:
        errors.append(
            'saved-channel manifest row binding does not match'
        )
    return {
        'valid': not errors,
        'recorded_sha256': (
            recorded if isinstance(recorded, str) else None
        ),
        'calculated_sha256': calculated,
        'errors': errors,
    }


def score_input_manifest_binding_payload(manifest):
    if not isinstance(manifest, dict):
        return None
    canonical_montage = manifest.get('canonical_montage') or {}

    def channel(name):
        value = (manifest.get('channels') or {}).get(name) or {}
        return {
            'present': value.get('present') is True,
            'text': str(value.get('text') or ''),
        }

    return {
        'schema': 'score-input-manifest-binding-v1',
        'domain': manifest.get('domain'),
        'scorer': manifest.get('scorer'),
        'embedding_model': manifest.get('embedding_model'),
        'embedding_dimensions': manifest.get('embedding_dimensions'),
        'feature_contract_identity_schema_version':
            manifest.get('feature_contract_identity_schema_version'),
        'feature_contract_sha256':
            manifest.get('feature_contract_sha256'),
        'feature_contract_document_sha256':
            manifest.get('feature_contract_document_sha256'),
        'coordinate_governance_version':
            manifest.get('coordinate_governance_version'),
        'coordinate_governance_sha256':
            manifest.get('coordinate_governance_sha256'),
        'steer_artifact_sha256':
            manifest.get('steer_artifact_sha256'),
        'steer_artifact_archive_key':
            manifest.get('steer_artifact_archive_key'),
        'steer_lineage_manifest_sha256':
            manifest.get('steer_lineage_manifest_sha256'),
        'steer_lineage_schema_version':
            manifest.get('steer_lineage_schema_version'),
        'source_window': manifest.get('source_window'),
        'canonical_montage': {
            'width': canonical_montage.get('width'),
            'height': canonical_montage.get('height'),
            'format': canonical_montage.get('format'),
            'quality': canonical_montage.get('quality'),
            'subsampling': canonical_montage.get('subsampling'),
            'montage_sha256':
                canonical_montage.get('montage_sha256'),
        },
        'transcript_used': manifest.get('transcript_used') is True,
        'duration_s': manifest.get('duration_s'),
        'creator_profile': manifest.get('creator_profile'),
        'input_fingerprint': manifest.get('input_fingerprint'),
        'score_input_fingerprint':
            manifest.get('score_input_fingerprint'),
        'embedding_input_fingerprint':
            manifest.get('embedding_input_fingerprint'),
        'revision_fingerprint':
            manifest.get('revision_fingerprint'),
        'output_fingerprint': manifest.get('output_fingerprint'),
        'scorer_revisions': manifest.get('scorer_revisions'),
        'query_input_fingerprint':
            manifest.get('query_input_fingerprint'),
        'thumbnail_sha256': manifest.get('thumbnail_sha256'),
        'score_text_sha256': manifest.get('score_text_sha256'),
        'query_input': manifest.get('query_input'),
        'channels': {
            'visual': channel('visual'),
            'text': channel('text'),
            'together': channel('together'),
        },
    }


def score_record_binding_payload(record):
    record = record or {}
    score = (record or {}).get('score')
    score = score if isinstance(score, dict) else {}
    input_manifest = (
        (record or {}).get('input_manifest')
        or score.get('input_manifest')
    )

    def long_field(name):
        if name in (record or {}):
            return (record or {}).get(name)
        return score.get(name)

    long_score_ledger = (
        (record or {}).get('long_score_ledger')
        or score.get('long_score_ledger')
    )
    score_domain = (
        (record or {}).get('score_domain')
        or (
            'longquant'
            if (
                long_score_ledger
                or 'longquant' in str(
                    (input_manifest or {}).get('domain', '')
                ).lower()
            )
            else 'shorts'
        )
    )
    payload = {
        'schema': 'shorts-score-record-binding-v3',
        'id': (
            (record or {}).get('id')
            or (record or {}).get('savedChannelVideoId')
            or (record or {}).get('sourceVideoId')
        ),
        'kind': (record or {}).get('kind'),
        'title': (record or {}).get('title'),
        'text': (
            record.get('text')
            if 'text' in record
            else record.get('transcript')
        ) or None,
        'duration_s': (
            record.get('dur_s')
            if 'dur_s' in record
            else record.get('duration_s')
        ) or None,
        'score_ledger': (record or {}).get('score_ledger'),
        'long_score_ledger': long_score_ledger,
        'visual_keep_forecast':
            (record or {}).get('visual_keep_forecast'),
        'creator_adaptive_keep_forecast':
            (record or {}).get('creator_adaptive_keep_forecast'),
        'input_manifest':
            score_input_manifest_binding_payload(input_manifest),
        'canonical_montage_ref': record.get('montage_ref'),
        'scored_evidence': {
            'indicators': (record or {}).get('indicators'),
            'channels': (record or {}).get('channels'),
            'emb_preview': (record or {}).get('emb_preview'),
            'novelty_provenance':
                (record or {}).get('novelty_provenance'),
        },
        'input_identity': {
            'revision_fingerprint':
                input_manifest.get('revision_fingerprint'),
            'embedding_input_fingerprint':
                input_manifest.get('embedding_input_fingerprint'),
            'score_input_fingerprint': (
                input_manifest.get('score_input_fingerprint')
                or input_manifest.get('input_fingerprint')
            ),
            'query_input_fingerprint':
                input_manifest.get('query_input_fingerprint'),
            'thumbnail_sha256':
                input_manifest.get('thumbnail_sha256'),
            'score_text_sha256':
                input_manifest.get('score_text_sha256'),
            'query_input': input_manifest.get('query_input'),
        } if isinstance(input_manifest, dict) else None,
    }
    if score_domain == 'longquant':
        payload.update({
            'schema': 'score-record-binding-v6',
            'score_domain': 'longquant',
            'output_contract': long_field('output_contract'),
            'decision_trace': long_field('decision_trace'),
            'non_authoritative_geometry':
                long_field('non_authoritative_geometry'),
        })
    return payload


def prior_score_record_binding_payload_v2_v4(record):
    payload = score_record_binding_payload(record)
    score = (record or {}).get('score')
    score = score if isinstance(score, dict) else {}
    input_manifest = (
        (record or {}).get('input_manifest')
        or score.get('input_manifest')
    )
    payload['schema'] = (
        'score-record-binding-v4'
        if payload.get('score_domain') == 'longquant'
        else 'shorts-score-record-binding-v2'
    )
    if payload.get('score_domain') == 'longquant':
        payload.pop('decision_trace', None)
        payload.pop('non_authoritative_geometry', None)

        def long_field(name):
            if name in (record or {}):
                return (record or {}).get(name)
            return score.get(name)

        payload['score_alias_contract'] = long_field(
            'score_alias_contract'
        )
        payload['reward_contract'] = {
            'reward': long_field('reward'),
            'training_reward': long_field('training_reward'),
            'thumbnail_model_reward':
                long_field('thumbnail_model_reward'),
            'idea_model_reward':
                long_field('idea_model_reward'),
            'relevance': long_field('relevance'),
            'nn_cos': long_field('nn_cos'),
            'reward_trace': long_field('reward_trace'),
        }
        payload['long_channel_evidence'] = long_field(
            'channels'
        )
        payload['embedding_preview'] = long_field(
            'emb_preview'
        )
    payload['legacy_steer_cache'] = (record or {}).get('steer')
    payload['legacy_feature_cache'] = (record or {}).get('features')
    payload['input_manifest'] = input_manifest
    return payload


def prior_score_record_binding_sha256_v2_v4(record):
    return hashlib.sha256(
        ledger_json_bytes(prior_score_record_binding_payload_v2_v4(record))
    ).hexdigest()


def prior_score_record_binding_payload_v1(record):
    record = record or {}
    input_manifest = record.get('input_manifest')
    score = record.get('score')
    score = score if isinstance(score, dict) else {}
    return {
        'schema': 'shorts-score-record-binding-v1',
        'id': (
            record.get('id')
            or record.get('savedChannelVideoId')
            or record.get('sourceVideoId')
        ),
        'kind': record.get('kind'),
        'title': record.get('title'),
        'score_ledger': record.get('score_ledger'),
        'long_score_ledger': (
            record.get('long_score_ledger')
            or score.get('long_score_ledger')
        ),
        'legacy_steer_cache': record.get('steer'),
        'legacy_feature_cache': record.get('features'),
        'visual_keep_forecast': record.get('visual_keep_forecast'),
        'creator_adaptive_keep_forecast':
            record.get('creator_adaptive_keep_forecast'),
        'input_identity': {
            'revision_fingerprint':
                input_manifest.get('revision_fingerprint'),
            'embedding_input_fingerprint':
                input_manifest.get('embedding_input_fingerprint'),
            'score_input_fingerprint': (
                input_manifest.get('score_input_fingerprint')
                or input_manifest.get('input_fingerprint')
            ),
        } if isinstance(input_manifest, dict) else None,
    }


def prior_score_record_binding_sha256_v1(record):
    return hashlib.sha256(
        ledger_json_bytes(prior_score_record_binding_payload_v1(record))
    ).hexdigest()


def score_record_binding_sha256(record):
    return hashlib.sha256(
        ledger_json_bytes(score_record_binding_payload(record))
    ).hexdigest()


def _normalized_transcript(value):
    return re.sub(
        r'\s+',
        ' ',
        unicodedata.normalize('NFKC', str(value or '')),
    ).strip()


def validate_shorts_input_manifest(record, expected=None):
    expected = expected or {}
    record = record if isinstance(record, dict) else {}
    manifest = record.get('input_manifest')
    errors = []
    if not isinstance(manifest, dict):
        return {
            'valid': False,
            'errors': ['Shorts score input manifest is missing'],
        }
    canonical_montage = manifest.get('canonical_montage')
    canonical_montage = (
        canonical_montage
        if isinstance(canonical_montage, dict)
        else {}
    )
    montage_sha256 = canonical_montage.get('montage_sha256')
    if (
        manifest.get('domain') != 'shorts_raw'
        or not isinstance(montage_sha256, str)
        or re.fullmatch(r'[a-f0-9]{64}', montage_sha256) is None
    ):
        errors.append('Shorts canonical montage identity is missing')
    transcript_used = manifest.get('transcript_used') is True
    channels = manifest.get('channels')
    channels = channels if isinstance(channels, dict) else {}
    text_channel = channels.get('text')
    text_channel = (
        text_channel if isinstance(text_channel, dict) else {}
    )
    transcript = _normalized_transcript(text_channel.get('text'))
    if 'text' in expected:
        expected_text = _normalized_transcript(expected.get('text'))
        if transcript != (expected_text if transcript_used else ''):
            errors.append(
                'Shorts score is bound to different transcript text'
            )
    expected_montage_sha256 = expected.get('montage_sha256')
    if (
        expected_montage_sha256 is None
        and expected.get('montageBytes') is not None
    ):
        expected_montage_sha256 = hashlib.sha256(
            bytes(expected['montageBytes'])
        ).hexdigest()
    if (
        expected_montage_sha256 is not None
        and montage_sha256 != expected_montage_sha256
    ):
        errors.append(
            'Shorts score is bound to different montage bytes'
        )
    embedding_input = {
        'schema': 'shorts-embedding-input-v2',
        'montage_sha256': montage_sha256,
        'transcript': transcript,
        'channels': {
            'visual': '5-frame-montage',
            'text': (
                'normalized-transcript'
                if transcript_used
                else 'absent'
            ),
            'together': (
                '5-frame-montage+normalized-transcript'
                if transcript_used
                else '5-frame-montage'
            ),
        },
    }
    embedding_fingerprint = hashlib.sha256(
        ledger_json_bytes(embedding_input)
    ).hexdigest()
    if (
        manifest.get('embedding_input_fingerprint')
        != embedding_fingerprint
    ):
        errors.append('Shorts embedding input fingerprint differs')
    duration = _finite(manifest.get('duration_s'))
    duration_ms = (
        round(duration * 1000)
        if duration is not None and duration > 0
        else None
    )
    creator_profile = (
        str(manifest.get('creator_profile') or '')
        .strip()
        .lower()
        or None
    )
    score_input = {
        'schema': 'shorts-score-input-v2',
        'embedding_input_fingerprint': embedding_fingerprint,
        'embedding_input': embedding_input,
        'duration_ms': duration_ms,
        'creator_profile': creator_profile,
    }
    score_input_fingerprint = hashlib.sha256(
        ledger_json_bytes(score_input)
    ).hexdigest()
    if (
        manifest.get('score_input_fingerprint')
            != score_input_fingerprint
        or manifest.get('input_fingerprint')
            != manifest.get('score_input_fingerprint')
    ):
        errors.append('Shorts score input fingerprint differs')
    if 'durationS' in expected:
        expected_duration = _finite(expected.get('durationS'))
        expected_duration_ms = (
            round(expected_duration * 1000)
            if expected_duration is not None
            and expected_duration > 0
            else None
        )
        if expected_duration_ms != duration_ms:
            errors.append(
                'Shorts score is bound to different duration'
            )
    if 'creatorProfile' in expected:
        expected_profile = (
            str(expected.get('creatorProfile') or '')
            .strip()
            .lower()
            or None
        )
        if expected_profile != creator_profile:
            errors.append(
                'Shorts score is bound to different creator profile'
            )
    return {
        'valid': not errors,
        'errors': list(dict.fromkeys(errors)),
        'montageSha256': montage_sha256,
        'normalizedTranscript': transcript,
        'embeddingFingerprint': embedding_fingerprint,
        'scoreInputFingerprint':
            manifest.get('score_input_fingerprint'),
    }


def feature_coordinate_id(definition):
    return STORED_PATTERN.replace(
        '{featureKey}',
        str(definition['key']),
    )


EXPECTED_COORDINATE_IDS = tuple(
    feature_coordinate_id(definition)
    for definition in FEATURES
)


def _finite(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


UNIT_VALUE_BOUNDS = {}
for _unit, _unit_definition in (
    GOVERNANCE.get('valueUnits') or {}
).items():
    if (
        not isinstance(_unit_definition, dict)
        or 'minimumInclusive' not in _unit_definition
        or 'maximumInclusive' not in _unit_definition
    ):
        raise RuntimeError(f'invalid governed value unit: {_unit}')
    _minimum = _unit_definition.get('minimumInclusive')
    _maximum = _unit_definition.get('maximumInclusive')
    if (
        (_minimum is not None and _finite(_minimum) is None)
        or (_maximum is not None and _finite(_maximum) is None)
        or (
            _minimum is not None
            and _maximum is not None
            and float(_minimum) > float(_maximum)
        )
    ):
        raise RuntimeError(f'invalid governed value unit: {_unit}')
    UNIT_VALUE_BOUNDS[_unit] = (_minimum, _maximum)

if GOVERNANCE.get('percentileStorageUnit') != 'percentile_0_100':
    raise RuntimeError('unsupported canonical percentile storage unit')
if UNIT_VALUE_BOUNDS.get('percent') != (0, 100):
    raise RuntimeError('canonical percent must be governed on [0, 100]')
if UNIT_VALUE_BOUNDS.get(
    'retention_percent_rewatch_capable'
) != (0, None):
    raise RuntimeError(
        'rewatch-capable retention must be governed on [0, +infinity)'
    )
for _definition in FEATURES:
    if _definition.get('unit') not in UNIT_VALUE_BOUNDS:
        raise RuntimeError(
            'unsupported canonical Shorts unit: '
            + str(_definition.get('unit'))
        )


def _within_closed_bounds(value, bounds):
    numeric = _finite(value)
    if numeric is None:
        return False
    minimum, maximum = bounds
    return (
        (minimum is None or numeric >= minimum)
        and (maximum is None or numeric <= maximum)
    )


def _value_within_unit_bounds(value, unit):
    bounds = UNIT_VALUE_BOUNDS.get(unit)
    return (
        bounds is not None
        and _within_closed_bounds(value, bounds)
    )


def _percentile_within_bounds(value):
    return _within_closed_bounds(value, (0.0, 100.0))


def indicator_strength(indicator):
    auc = _finite(indicator.get('auc'))
    if auc is not None:
        return abs(auc - 0.5) * 2
    return abs(_finite(indicator.get('spearman')) or 0)


def select_novelty_feature(record, registry, target):
    values = record.get('indicators') or {}
    candidates = [
        indicator
        for indicator in (registry or {}).get('indicators') or []
        if indicator.get('kind') == 'novelty'
        and indicator.get('target') == target
        and _finite(values.get(indicator.get('name'))) is not None
    ]
    if not candidates:
        return {
            'value': None,
            'percentile': None,
            'provenance': {
                'status': 'unavailable',
                'target': target,
                'reason': 'no matching novelty indicator with a finite scored value',
                'candidateIndicatorCount': 0,
                'validatedCandidateCount': 0,
            },
        }

    validated = sorted(
        [
            indicator
            for indicator in candidates
            if indicator.get('validated')
        ],
        key=indicator_strength,
        reverse=True,
    )
    indicator = (
        validated
        or sorted(candidates, key=indicator_strength, reverse=True)
    )[0]
    score = _finite(values.get(indicator['name']))
    points = [
        point
        for point in (indicator.get('pts') or [])
        if isinstance(point, (list, tuple))
        and len(point) >= 2
        and _finite(point[0]) is not None
        and _finite(point[1]) is not None
    ]
    sign = -1 if (_finite(indicator.get('spearman')) or 0) < 0 else 1
    point_hash = hashlib.sha256(stable_json_bytes(points)).hexdigest()
    provenance = {
        'status': 'selected',
        'target': target,
        'selectedIndicatorKey': indicator['name'],
        'selectedFrom': 'validated' if validated else 'all matching',
        'candidateIndicatorCount': len(candidates),
        'validatedCandidateCount': len(validated),
        'selectionStrengthKind': (
            'aucDistanceFromHalf'
            if _finite(indicator.get('auc')) is not None
            else 'absoluteSpearman'
        ),
        'selectionStrength': round(indicator_strength(indicator), 6),
        'sign': sign,
        'signRule': (
            'invert empirical percentile when registered Spearman is negative'
        ),
        'registered': {
            key: indicator[key]
            for key in (
                'kind',
                'modality',
                'target',
                'target_label',
                'validated',
                'strong',
                'spearman',
                'auc',
                'effect',
                'p',
                'fdr',
                'n',
                'n_owned',
            )
            if key in indicator
        },
        'calibration': {
            'method': (
                'empirical percentile over registered indicator points, '
                'then target-order lookup'
            ),
            'calibrationPointCount': len(points),
            'calibrationPointsSha256': point_hash,
            'calibrationPopulationHash': point_hash,
            'calibrationPopulationHashBasis': (
                'canonical JSON of the selected registry indicator pts array'
            ),
            'registeredPopulationCount': indicator.get('n'),
            'registeredOwnedPopulationCount': indicator.get('n_owned'),
        },
        'rawIndicatorValue': score,
    }
    if not points:
        provenance.update({
            'status': 'unavailable',
            'reason': 'selected indicator has no finite calibration points',
        })
        return {
            'value': None,
            'percentile': None,
            'provenance': provenance,
        }

    percentile = (
        sum(1 for point in points if float(point[0]) <= score)
        / float(len(points))
    )
    if sign < 0:
        percentile = 1 - percentile
    actual = sorted(float(point[1]) for point in points)
    index = max(
        0,
        min(
            len(actual) - 1,
            int(round(percentile * (len(actual) - 1))),
        ),
    )
    value = round(actual[index], 4)
    percentile_value = round(percentile * 100, 2)
    provenance['output'] = {
        'estimatedTarget': value,
        'percentile': percentile_value,
    }
    return {
        'value': value,
        'percentile': percentile_value,
        'provenance': provenance,
    }


def address_steer_outputs(record):
    """Return a copy whose stored steer cells carry their canonical identity."""
    output = {}
    source_definitions = {
        definition.get('sourceKey'): definition
        for definition in FEATURES
        if definition.get('source') == 'steer'
    }
    for source_key, raw_cell in (record.get('steer') or {}).items():
        cell = dict(raw_cell) if isinstance(raw_cell, dict) else {}
        definition = source_definitions.get(source_key)
        if definition:
            expected_id = feature_coordinate_id(definition)
            emitted_id = cell.get('coordinate_id') or cell.get(
                'coordinateId'
            )
            cell['coordinate_id'] = emitted_id or expected_id
            cell['feature_key'] = cell.get('feature_key') or definition['key']
            cell['group'] = cell.get('group') or definition['group']
            cell['target'] = cell.get('target') or definition['target']
        output[source_key] = cell
    return output


def materialize_score_bundle(record, registry=None, registry_revision=None):
    """Resolve every registered stored coordinate exactly once."""
    addressed = {
        **(record or {}),
        'steer': address_steer_outputs(record or {}),
    }
    entries = []
    features = {}
    novelty_targets = {}
    for definition in FEATURES:
        coordinate_id = feature_coordinate_id(definition)
        source = definition.get('source')
        source_key = definition.get('sourceKey') or definition['key']
        value = None
        percentile = None
        provenance = None
        unavailable_reason = None

        if source == 'steer':
            cell = (addressed.get('steer') or {}).get(source_key) or {}
            emitted_id = cell.get('coordinate_id')
            emitted_identity = (
                emitted_id,
                cell.get('feature_key'),
                cell.get('group'),
                cell.get('target'),
            )
            expected_identity = (
                coordinate_id,
                definition['key'],
                definition['group'],
                definition['target'],
            )
            if emitted_identity != expected_identity:
                unavailable_reason = (
                    'producer coordinate identity mismatch: '
                    + repr(emitted_identity)
                )
            else:
                value = _finite(cell.get('est'))
                percentile = _finite(cell.get('pctile'))
                if value is None:
                    unavailable_reason = 'stored steer output is unavailable'
                provenance = {
                    'kind': cell.get('kind'),
                    'durationSeconds': cell.get('dur_s'),
                    'durationAssumed': cell.get('dur_assumed'),
                }
        elif source == 'novelty':
            selected = select_novelty_feature(
                addressed,
                registry or {},
                definition.get('target'),
            )
            value = selected['value']
            percentile = selected['percentile']
            provenance = selected['provenance']
            novelty_targets[definition.get('target')] = provenance
            if value is None:
                unavailable_reason = (
                    provenance.get('reason')
                    or 'novelty coordinate is unavailable'
                )
        else:
            unavailable_reason = f'unsupported source type: {source}'

        if (
            value is not None
            and not _value_within_unit_bounds(
                value,
                definition.get('unit'),
            )
        ):
            unavailable_reason = (
                'stored score is outside governance range for unit '
                + str(definition.get('unit'))
            )
            value = None
            percentile = None
        elif (
            percentile is not None
            and not _percentile_within_bounds(percentile)
        ):
            unavailable_reason = (
                'stored percentile is outside governance range [0, 100]'
            )
            value = None
            percentile = None

        available = value is not None
        entry = {
            'coordinate_id': coordinate_id,
            'feature_key': definition['key'],
            'group': definition['group'],
            'target': definition['target'],
            'source': source,
            'source_key': source_key,
            'unit': definition.get('unit'),
            'display_unit': definition.get('displayUnit'),
            'value': value,
            'percentile': percentile,
            'available': available,
            'unavailable_reason': None if available else unavailable_reason,
            'provenance': provenance,
        }
        entries.append(entry)
        if available:
            features[definition['key']] = [value, percentile]

    ids = [entry['coordinate_id'] for entry in entries]
    schema_complete = (
        len(entries) == len(EXPECTED_COORDINATE_IDS)
        and ids == list(EXPECTED_COORDINATE_IDS)
        and len(set(ids)) == len(ids)
    )
    ledger = {
        'schema': 'shorts-stored-score-ledger-v1',
        'schema_version': 1,
        'ledger_version': GOVERNANCE['ledgerVersion'],
        'feature_contract_version': FEATURE_CONTRACT['version'],
        'feature_contract_identity_schema_version':
            FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        'feature_contract_sha256': FEATURE_CONTRACT_SHA256,
        'feature_contract_document_sha256':
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        'coordinate_governance_version': GOVERNANCE['schemaVersion'],
        'coordinate_governance_sha256': GOVERNANCE_SHA256,
        'expected_coordinate_ids': list(EXPECTED_COORDINATE_IDS),
        'entries': entries,
        'values_by_id': {
            entry['coordinate_id']: entry['value']
            for entry in entries
        },
        'percentiles_by_id': {
            entry['coordinate_id']: entry['percentile']
            for entry in entries
        },
        'schema_complete': schema_complete,
        'all_values_available': all(
            entry['available']
            for entry in entries
        ),
        'available_count': sum(
            1
            for entry in entries
            if entry['available']
        ),
        'unavailable': [
            {
                'coordinate_id': entry['coordinate_id'],
                'reason': entry['unavailable_reason'],
            }
            for entry in entries
            if not entry['available']
        ],
        'registry_revision': registry_revision,
        'registry_meta': (
            registry.get('meta')
            if isinstance((registry or {}).get('meta'), dict)
            else None
        ),
    }
    ledger['ledger_sha256'] = hashlib.sha256(
        ledger_json_bytes({
            key: value
            for key, value in ledger.items()
            if key != 'ledger_sha256'
        })
    ).hexdigest()
    return {
        'addressed_steer': addressed['steer'],
        'features': features,
        'novelty_provenance': {
            'schemaVersion': 1,
            'registryRevision': registry_revision,
            'registryMeta': (
                registry.get('meta')
                if isinstance((registry or {}).get('meta'), dict)
                else None
            ),
            'targets': novelty_targets,
        },
        'score_ledger': ledger,
    }


def validate_score_ledger(ledger):
    """Validate the complete semantic identity and indexes of a stored ledger."""
    if not isinstance(ledger, dict):
        raise ValueError('score ledger is missing')
    if ledger.get('schema') != 'shorts-stored-score-ledger-v1':
        raise ValueError('score ledger schema is not canonical')
    if ledger.get('schema_version') != 1:
        raise ValueError('score ledger schema version is not supported')
    if 'migration_provenance' in ledger:
        raise ValueError(
            'score ledger migration history must remain outside canonical score identity'
        )
    if ledger.get('ledger_version') != GOVERNANCE['ledgerVersion']:
        raise ValueError('score ledger version does not match governance')
    if ledger.get('feature_contract_sha256') != FEATURE_CONTRACT_SHA256:
        raise ValueError('score ledger feature contract hash does not match')
    if (
        ledger.get('feature_contract_identity_schema_version')
        != FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION
    ):
        raise ValueError('score ledger feature contract identity is unsupported')
    document_hash = ledger.get('feature_contract_document_sha256')
    if (
        not isinstance(document_hash, str)
        or len(document_hash) != 64
        or any(character not in '0123456789abcdef' for character in document_hash)
    ):
        raise ValueError('score ledger feature contract document hash is missing')
    if document_hash != FEATURE_CONTRACT_DOCUMENT_SHA256:
        raise ValueError('score ledger feature contract document hash does not match')
    if (
        ledger.get('coordinate_governance_version')
        != GOVERNANCE['schemaVersion']
        or ledger.get('coordinate_governance_sha256') != GOVERNANCE_SHA256
    ):
        raise ValueError('score ledger governance hash does not match')
    if ledger.get('expected_coordinate_ids') != list(EXPECTED_COORDINATE_IDS):
        raise ValueError('score ledger expected-coordinate inventory differs')
    entries = ledger.get('entries') or []
    if not isinstance(entries, list):
        raise ValueError('score ledger entries are not an array')
    ids = [
        entry.get('coordinate_id')
        for entry in entries
        if isinstance(entry, dict)
    ]
    if ids != list(EXPECTED_COORDINATE_IDS) or len(set(ids)) != len(ids):
        raise ValueError('score ledger coordinate order or identity is invalid')
    values_by_id = ledger.get('values_by_id')
    percentiles_by_id = ledger.get('percentiles_by_id')
    expected_keys = set(EXPECTED_COORDINATE_IDS)
    if (
        not isinstance(values_by_id, dict)
        or len(values_by_id) != len(EXPECTED_COORDINATE_IDS)
        or set(values_by_id) != expected_keys
    ):
        raise ValueError('score ledger value index is not exact')
    if (
        not isinstance(percentiles_by_id, dict)
        or len(percentiles_by_id) != len(EXPECTED_COORDINATE_IDS)
        or set(percentiles_by_id) != expected_keys
    ):
        raise ValueError('score ledger percentile index is not exact')
    expected_hash = hashlib.sha256(
        ledger_json_bytes({
            key: value
            for key, value in ledger.items()
            if key != 'ledger_sha256'
        })
    ).hexdigest()
    if ledger.get('ledger_sha256') != expected_hash:
        raise ValueError('score ledger content hash does not match')

    available_count = 0
    expected_unavailable = []
    for definition, entry in zip(FEATURES, entries):
        if not isinstance(entry, dict):
            raise ValueError('score ledger entry is not an object')
        coordinate_id = feature_coordinate_id(definition)
        expected_identity = {
            'coordinate_id': coordinate_id,
            'feature_key': definition['key'],
            'group': definition['group'],
            'target': definition['target'],
            'source': definition['source'],
            'source_key': definition.get('sourceKey') or definition['key'],
            'unit': definition.get('unit'),
            'display_unit': definition.get('displayUnit'),
        }
        if any(entry.get(key) != value for key, value in expected_identity.items()):
            raise ValueError(
                f'score ledger coordinate identity differs: {coordinate_id}'
            )
        value = _finite(entry.get('value'))
        raw_percentile = entry.get('percentile')
        percentile = _finite(raw_percentile)
        if entry.get('available') is not (value is not None):
            raise ValueError(
                f'score ledger availability mismatch: {coordinate_id}'
            )
        if (
            value is not None
            and not _value_within_unit_bounds(
                value,
                definition.get('unit'),
            )
        ):
            raise ValueError(
                'score ledger value is outside governance range for unit '
                f"{definition.get('unit')}: {coordinate_id}"
            )
        if (
            raw_percentile is not None
            and not _percentile_within_bounds(raw_percentile)
        ):
            raise ValueError(
                'score ledger percentile is outside governance range '
                f'[0, 100]: {coordinate_id}'
            )
        indexed_value = _finite(values_by_id.get(coordinate_id))
        indexed_raw_percentile = percentiles_by_id.get(coordinate_id)
        indexed_percentile = _finite(indexed_raw_percentile)
        if value is not None:
            available_count += 1
            if indexed_value != value:
                raise ValueError(
                    f'score ledger value index differs: {coordinate_id}'
                )
            if (
                (raw_percentile is None) != (indexed_raw_percentile is None)
                or percentile != indexed_percentile
            ):
                raise ValueError(
                    f'score ledger percentile index differs: {coordinate_id}'
                )
            if entry.get('unavailable_reason') is not None:
                raise ValueError(
                    f'score ledger available coordinate has a reason: {coordinate_id}'
                )
        else:
            if entry.get('value') is not None or indexed_value is not None:
                raise ValueError(
                    f'score ledger unavailable value is indexed: {coordinate_id}'
                )
            if raw_percentile is not None or indexed_raw_percentile is not None:
                raise ValueError(
                    f'score ledger unavailable percentile is indexed: {coordinate_id}'
                )
            reason = entry.get('unavailable_reason')
            if not isinstance(reason, str) or not reason:
                raise ValueError(
                    f'score ledger unavailable coordinate lacks a reason: {coordinate_id}'
                )
            expected_unavailable.append({
                'coordinate_id': coordinate_id,
                'reason': reason,
            })
    if (
        ledger.get('schema_complete') is not True
        or type(ledger.get('available_count')) is not int
        or ledger.get('available_count') != available_count
        or ledger.get('all_values_available')
            is not (available_count == len(EXPECTED_COORDINATE_IDS))
    ):
        raise ValueError('score ledger summary counts differ')
    if ledger.get('unavailable') != expected_unavailable:
        raise ValueError('score ledger unavailable inventory differs')
    return entries


def _approved_prior_ledger_revision(ledger):
    revisions = (
        (GOVERNANCE.get('compatibility') or {})
        .get('migratableLedgerRevisions')
        or []
    )
    expected_ids = ledger.get('expected_coordinate_ids')
    expected_ids_sha256 = (
        hashlib.sha256(ledger_json_bytes(expected_ids)).hexdigest()
        if isinstance(expected_ids, list)
        else None
    )
    for revision in revisions:
        if (
            ledger.get('ledger_version')
            == revision.get('ledgerVersion')
            and ledger.get('feature_contract_version')
            == revision.get('featureContractVersion')
            and ledger.get('feature_contract_identity_schema_version')
            == revision.get('featureContractIdentitySchemaVersion')
            and ledger.get('feature_contract_sha256')
            == revision.get('featureContractSha256')
            and ledger.get('feature_contract_document_sha256')
            == revision.get('featureContractDocumentSha256')
            and ledger.get('coordinate_governance_version')
            == revision.get('coordinateGovernanceVersion')
            and ledger.get('coordinate_governance_sha256')
            == revision.get('coordinateGovernanceSha256')
            and expected_ids_sha256
            == revision.get('expectedCoordinateIdsSha256')
        ):
            return revision
    return None


def _migrate_prior_entry_units(ledger, approved_revision):
    migration = approved_revision.get('scoreValueMigration')
    if (
        not isinstance(migration, dict)
        or migration.get('kind') != 'target-unit-relabel'
        or migration.get('target') != 'ret5'
        or migration.get('fromUnit') != 'percent'
        or migration.get('toUnit')
            != 'retention_percent_rewatch_capable'
        or migration.get('numericTransform') != 'identity'
        or migration.get('priorMinimumInclusive') != 0
        or migration.get('priorMaximumInclusive') is not None
        or migration.get('historicalUpperBoundWasEnforced') is not False
    ):
        raise ValueError('prior score ledger unit migration is not approved')
    entries = ledger.get('entries')
    if not isinstance(entries, list):
        return copy.deepcopy(entries)
    migrated_entries = []
    for index, entry in enumerate(entries):
        definition = FEATURES[index] if index < len(FEATURES) else None
        migrated_entry = copy.deepcopy(entry)
        if (
            not isinstance(definition, dict)
            or not isinstance(entry, dict)
            or definition.get('target') != migration.get('target')
        ):
            migrated_entries.append(migrated_entry)
            continue
        coordinate_id = (
            f"{GOVERNANCE['coordinates']['storedPattern']}"
            .replace('{featureKey}', definition['key'])
        )
        if entry.get('unit') != migration.get('fromUnit'):
            raise ValueError(
                f"{coordinate_id} prior unit is not "
                f"{migration.get('fromUnit')}"
            )
        if (
            entry.get('available') is True
            and (
                _finite(entry.get('value')) is None
                or _finite(entry.get('value'))
                < migration.get('priorMinimumInclusive')
            )
        ):
            raise ValueError(
                f'{coordinate_id} value is outside governance range '
                f"for prior unit {migration.get('fromUnit')}"
            )
        migrated_entry['unit'] = migration.get('toUnit')
        migrated_entries.append(migrated_entry)
    return migrated_entries


def migrate_prior_canonical_score_ledger(ledger):
    """Upgrade an older addressed ledger without re-estimating any score."""
    if not isinstance(ledger, dict):
        raise ValueError('prior score ledger is missing')
    if ledger.get('schema') != 'shorts-stored-score-ledger-v1':
        raise ValueError('prior score ledger schema is not canonical')
    if ledger.get('schema_version') != 1:
        raise ValueError('prior score ledger schema version is not supported')
    prior_version = ledger.get('ledger_version')
    if (
        type(prior_version) is not int
        or prior_version < 1
        or prior_version >= GOVERNANCE['ledgerVersion']
    ):
        raise ValueError('score ledger is not a supported prior version')
    prior_contract_version = ledger.get('feature_contract_version')
    if (
        type(prior_contract_version) is not int
        or prior_contract_version < 1
        or prior_contract_version > FEATURE_CONTRACT['version']
    ):
        raise ValueError(
            'prior score ledger feature contract version is invalid'
        )
    prior_document_hash = ledger.get(
        'feature_contract_document_sha256'
    )
    if (
        not isinstance(prior_document_hash, str)
        or len(prior_document_hash) != 64
        or any(
            character not in '0123456789abcdef'
            for character in prior_document_hash
        )
    ):
        raise ValueError(
            'prior score ledger feature contract document hash is missing'
        )
    prior_governance_version = ledger.get(
        'coordinate_governance_version'
    )
    prior_governance_hash = ledger.get(
        'coordinate_governance_sha256'
    )
    if (
        type(prior_governance_version) is not int
        or prior_governance_version < 1
        or prior_governance_version > GOVERNANCE['schemaVersion']
        or not isinstance(prior_governance_hash, str)
        or len(prior_governance_hash) != 64
        or any(
            character not in '0123456789abcdef'
            for character in prior_governance_hash
        )
    ):
        raise ValueError('prior score ledger governance identity is invalid')
    approved_revision = _approved_prior_ledger_revision(ledger)
    if approved_revision is None:
        raise ValueError(
            'prior score ledger revision is not on the immutable migration '
            'allowlist'
        )
    expected_hash = hashlib.sha256(ledger_json_bytes({
        key: value
        for key, value in ledger.items()
        if key != 'ledger_sha256'
    })).hexdigest()
    if ledger.get('ledger_sha256') != expected_hash:
        raise ValueError('prior score ledger content hash does not match')
    migrated_entries = _migrate_prior_entry_units(
        ledger,
        approved_revision,
    )

    migrated = {
        'schema': 'shorts-stored-score-ledger-v1',
        'schema_version': 1,
        'ledger_version': GOVERNANCE['ledgerVersion'],
        'feature_contract_version': FEATURE_CONTRACT['version'],
        'feature_contract_identity_schema_version':
            FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        'feature_contract_sha256': FEATURE_CONTRACT_SHA256,
        'feature_contract_document_sha256':
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        'coordinate_governance_version': GOVERNANCE['schemaVersion'],
        'coordinate_governance_sha256': GOVERNANCE_SHA256,
        'expected_coordinate_ids': copy.deepcopy(
            ledger.get('expected_coordinate_ids')
        ),
        'entries': migrated_entries,
        'values_by_id': copy.deepcopy(ledger.get('values_by_id')),
        'percentiles_by_id': copy.deepcopy(
            ledger.get('percentiles_by_id')
        ),
        'schema_complete': ledger.get('schema_complete'),
        'all_values_available': ledger.get('all_values_available'),
        'available_count': ledger.get('available_count'),
        'unavailable': copy.deepcopy(ledger.get('unavailable')),
        'registry_revision': copy.deepcopy(
            ledger.get('registry_revision')
        ),
        'registry_meta': copy.deepcopy(ledger.get('registry_meta')),
    }
    migrated['ledger_sha256'] = hashlib.sha256(
        ledger_json_bytes(migrated)
    ).hexdigest()
    validate_score_ledger(migrated)
    return migrated


def feature_bundle_from_ledger(ledger):
    """Validate a persisted ledger and recover its compact feature bundle."""
    entries = validate_score_ledger(ledger)
    features = {}
    novelty_targets = {}
    for entry in entries:
        value = _finite(entry.get('value'))
        percentile = _finite(entry.get('percentile'))
        if value is not None:
            features[entry['feature_key']] = [value, percentile]
        if entry.get('source') == 'novelty':
            novelty_targets[entry.get('target')] = (
                entry.get('provenance') or {}
            )
    return {
        'features': features,
        'novelty_provenance': {
            'schemaVersion': 1,
            'registryRevision': ledger.get('registry_revision'),
            'registryMeta': ledger.get('registry_meta'),
            'targets': novelty_targets,
        },
    }
