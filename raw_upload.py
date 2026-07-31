#!/usr/bin/env python3
"""
RAW upload — process ONE uploaded video exactly like a dataset hook, then locate it
in the existing embedding space by nearest neighbours (the maps only store 2D coords,
not the projection models, so a new vector is placed among the hooks it's most similar
to — consistent across all three channels/projections).

  args: --file <path> [--title <name>]
  stdout: JSON {montage (b64 jpeg), transcript, silent, channels:{visual,text,together},
                visual_keep_forecast:{raw, coordinate_id, model_artifact_sha256}}
          each channel = {neighbors:[{id,sim}]} (text=null when no real voiceover)

Identical montage/whisper/embed to raw_embed.py so the upload's vectors are comparable.
"""
import os, sys, json, base64, subprocess, tempfile, shutil, io, time, re, hashlib, unicodedata
import numpy as np, boto3, urllib.request, urllib.error
from PIL import Image, __version__ as PILLOW_VERSION
from creator_adaptive_keep import (
    load_serving_state,
    score_creator_adaptive_keep,
)
from shorts_score_ledger import (
    EXPECTED_COORDINATE_IDS as SHORTS_STORED_COORDINATE_IDS,
    FEATURE_CONTRACT_DOCUMENT_SHA256,
    FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
    FEATURE_CONTRACT_SHA256,
    materialize_score_bundle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DISPLAY_CONTRACT_PATH = os.path.join(
    HERE,
    'buildings',
    'jarvis',
    'saved-channel-feature-contract.json',
)
COORDINATE_GOVERNANCE_PATH = os.path.join(
    HERE,
    'buildings',
    'jarvis',
    'quant-coordinate-governance.json',
)

def _load_display_contract_version():
    with open(DISPLAY_CONTRACT_PATH, encoding='utf-8') as handle:
        version = json.load(handle).get('version')
    if not isinstance(version, int) or version < 1:
        raise RuntimeError(
            'saved-channel feature contract must declare a positive integer version'
        )
    return version


def _load_coordinate_governance():
    with open(COORDINATE_GOVERNANCE_PATH, encoding='utf-8') as handle:
        governance = json.load(handle)
    if not isinstance(governance.get('schemaVersion'), int):
        raise RuntimeError(
            'coordinate governance must declare an integer schemaVersion'
        )
    return governance

def env(k):
    v = os.environ.get(k)
    if v: return v
    try:
        for ln in open(os.path.join(HERE, '.env')):
            if ln.strip().startswith(k + '='): return ln.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception: pass
KEY = env('GEMINI_API_KEY'); BUCKET = env('R2_BUCKET_NAME') or 'business-world-videos'
s3 = boto3.client('s3', endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
                  aws_access_key_id=env('R2_ACCESS_KEY_ID'), aws_secret_access_key=env('R2_SECRET_ACCESS_KEY'), region_name='auto')
DIM = 1536
EMBEDDING_MODEL = 'gemini-embedding-2'
TRANSCRIPTION_MODEL = env('RAW_TRANSCRIPTION_MODEL') or 'gemini-2.5-flash'
EMB_URL = f'https://generativelanguage.googleapis.com/v1beta/models/{EMBEDDING_MODEL}:embedContent'
SCORE_CACHE_VERSION = 2
DISPLAY_CONTRACT_VERSION = _load_display_contract_version()
COORDINATE_GOVERNANCE = _load_coordinate_governance()
COORDINATE_GOVERNANCE_SHA256 = hashlib.sha256(
    open(COORDINATE_GOVERNANCE_PATH, 'rb').read()
).hexdigest()
SCORE_CACHE_PREFIX = (env('RAW_SCORE_CACHE_PREFIX') or 'raw/score-cache/v2').strip('/')
VISUAL_KEEP_MODEL_KEY = 'raw/predictor-lab/visual-keep-model-v1.json'
VISUAL_KEEP_MODEL_MANIFEST_KEY = 'raw/predictor-lab/visual-keep-model-v1.manifest.json'
VISUAL_KEEP_COORDINATE_ID = (
    COORDINATE_GOVERNANCE['coordinates']['visualKeepForecast']['id']
)
VISUAL_KEEP_ESTIMATOR_ID = 'shorts.visual-keep.pooled-ridge.v1'
VISUAL_KEEP_POOLED_ALPHAS = (0.1, 1.0, 10.0)
CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY = (
    'raw/predictor-lab/creator-adaptive-keep-model-v1.manifest.json'
)
CREATOR_ADAPTIVE_KEEP_MODEL_KEY = (
    'raw/predictor-lab/creator-adaptive-keep-model-v1.json'
)
CREATOR_ADAPTIVE_KEEP_SERVING_KEY = (
    'raw/predictor-lab/creator-adaptive-keep-serving-v1.npz'
)
CREATOR_ADAPTIVE_KEEP_SERVING_MANIFEST_KEY = (
    'raw/predictor-lab/creator-adaptive-keep-serving-v1.manifest.json'
)
CREATOR_ADAPTIVE_KEEP_COORDINATE_ID = (
    COORDINATE_GOVERNANCE['coordinates']['creatorAdaptiveKeepForecast']['id']
)
CANONICAL_MONTAGE_WIDTH = 1600
CANONICAL_MONTAGE_HEIGHT = 568
CANONICAL_MONTAGE_QUALITY = 90
SCORE_REVISION_KEYS = (
    'raw/steer_models.npz',
    'raw/indicators/weights.npz',
    'raw/indicators/registry.json',
    'raw/novelty_models.npz',
    VISUAL_KEEP_MODEL_MANIFEST_KEY,
    CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY,
    CREATOR_ADAPTIVE_KEEP_SERVING_MANIFEST_KEY,
    'raw/visual/embeddings.npz',
    'raw/text/embeddings.npz',
    'raw/together/embeddings.npz',
)

class ScoreArtifactIntegrityError(RuntimeError):
    pass


def coherent(txt):
    toks = re.findall(r"[a-z']{2,}", (txt or '').lower())
    return len(toks) >= 2

def r2_get(key):
    expected = globals().get(
        '_PINNED_ARTIFACT_REVISIONS',
        {},
    ).get(key)
    request = {'Bucket': BUCKET, 'Key': key}
    if expected:
        state = expected.get('state')
        if state == 'missing':
            try:
                s3.get_object(**request)
            except Exception as error:
                code = str(
                    getattr(error, 'response', {})
                    .get('Error', {})
                    .get('Code', '')
                )
                if code in ('404', 'NoSuchKey', 'NotFound'):
                    return None
                raise ScoreArtifactIntegrityError(
                    f'could not verify pinned missing artifact {key}: {error}'
                ) from error
            raise ScoreArtifactIntegrityError(
                f'artifact appeared after scoring snapshot: {key}'
            )
        if state != 'present':
            raise ScoreArtifactIntegrityError(
                f'artifact revision is not scoreable ({state}): {key}'
            )
        expected_etag = str(expected.get('etag') or '').strip('"')
        if not expected_etag:
            raise ScoreArtifactIntegrityError(
                f'pinned artifact has no immutable ETag: {key}'
            )
        request['IfMatch'] = expected_etag
    try:
        response = s3.get_object(**request)
        payload = response['Body'].read()
    except ScoreArtifactIntegrityError:
        raise
    except Exception as error:
        if expected:
            raise ScoreArtifactIntegrityError(
                f'pinned artifact could not be read unchanged: {key}: {error}'
            ) from error
        return None
    if expected:
        actual_etag = str(response.get('ETag') or '').strip('"')
        expected_etag = str(expected.get('etag') or '').strip('"')
        if actual_etag and actual_etag != expected_etag:
            raise ScoreArtifactIntegrityError(
                f'pinned artifact ETag changed: {key}'
            )
        expected_size = expected.get('size')
        if (
            expected_size is not None
            and int(expected_size) != len(payload)
        ):
            raise ScoreArtifactIntegrityError(
                f'pinned artifact byte length changed: {key}'
            )
        expected_sha256 = str(expected.get('sha256') or '').lower()
        if (
            expected_sha256
            and hashlib.sha256(payload).hexdigest() != expected_sha256
        ):
            raise ScoreArtifactIntegrityError(
                f'pinned artifact content hash changed: {key}'
            )
    return payload


def _indicator_registry_snapshot():
    key = 'raw/indicators/registry.json'
    expected = _PINNED_ARTIFACT_REVISIONS.get(key)
    try:
        payload = r2_get(key)
        if not payload:
            raise RuntimeError('indicator registry is unavailable')
        registry = json.loads(payload)
        if not isinstance(registry, dict) or not isinstance(
            registry.get('indicators'),
            list,
        ):
            raise RuntimeError('indicator registry is malformed')
        revision = {
            'source': key,
            'sha256': hashlib.sha256(payload).hexdigest(),
            'bytes': len(payload),
            'etag': (
                str((expected or {}).get('etag') or '').strip('"')
                or None
            ),
            'versionId': (
                str((expected or {}).get('version_id') or '')
                or None
            ),
        }
        return registry, revision
    except ScoreArtifactIntegrityError:
        raise
    except Exception as error:
        return {}, {
            'source': key,
            'state': 'unavailable',
            'error': f'{type(error).__name__}: {str(error)[:200]}',
        }

_VISUAL_KEEP_MODEL_CACHE = None
_CREATOR_ADAPTIVE_KEEP_STATE_CACHE = None

def _exact_sha256(value):
    return bool(re.fullmatch(r'[a-f0-9]{64}', str(value or '').lower()))

def _visual_keep_forecast_from_payload(
    embedding,
    payload,
    artifact_sha256,
    artifact_key=None,
    manifest_sha256=None,
):
    if not isinstance(payload, dict):
        raise RuntimeError('visual keep predictor artifact is invalid')
    if payload.get('coordinateId') != VISUAL_KEEP_COORDINATE_ID:
        raise RuntimeError('visual keep predictor coordinate does not match the scorer contract')
    formula = payload.get('formula') or {}
    pooled = formula.get('pooled') or {}
    selected = formula.get('selected') or {}
    try:
        selected_alpha = float(selected.get('pooledAlpha'))
        selected_account_weight = float(
            selected.get('accountWeight')
        )
        pooled_intercept = float(pooled.get('intercept'))
    except (TypeError, ValueError):
        raise RuntimeError(
            'visual keep predictor selected candidate is invalid'
        )
    if (
        formula.get('estimatorId') != VISUAL_KEEP_ESTIMATOR_ID
        or formula.get('scope') != 'pooled_global'
        or formula.get('accountInputs') != []
        or formula.get('accounts') not in (None, [])
        or selected.get('estimatorId') != VISUAL_KEEP_ESTIMATOR_ID
        or selected_alpha not in VISUAL_KEEP_POOLED_ALPHAS
        or selected_account_weight != 0
        or formula.get('outputTransform')
        != 'clip(linear_prediction, 0, 100)'
        or formula.get('outputBounds') != [0, 100]
    ):
        raise RuntimeError('visual keep predictor must contain one pooled-global formula')
    coefficients = np.asarray(pooled.get('coefficients') or [], dtype=float)
    vector = np.asarray(embedding, dtype=float).reshape(-1)
    if len(coefficients) != DIM or len(vector) != DIM:
        raise RuntimeError(
            f'visual keep predictor expects {DIM} dimensions '
            f'(model={len(coefficients)}, input={len(vector)})'
        )
    if (
        not np.isfinite(coefficients).all()
        or not np.isfinite(pooled_intercept)
    ):
        raise RuntimeError(
            'visual keep predictor formula contains non-finite values'
        )
    vector = vector / (np.linalg.norm(vector) + 1e-9)
    linear_prediction = (
        pooled_intercept
        + float(vector @ coefficients)
    )
    raw_prediction = float(np.clip(linear_prediction, 0, 100))
    if not np.isfinite(raw_prediction):
        raise RuntimeError('visual keep predictor returned a non-finite value')
    return {
        'coordinate_id': VISUAL_KEEP_COORDINATE_ID,
        'est': round(raw_prediction, 6),
        'raw': round(raw_prediction, 6),
        'pctile': None,
        'kind': 'keep_rate_percent',
        'unit': 'percent',
        'calibration_scope': 'pooled_global',
        'account_model': None,
        'model_artifact_sha256': artifact_sha256,
        'model_artifact_key': artifact_key,
        'model_artifact_canonical_key': VISUAL_KEEP_MODEL_KEY,
        'model_manifest_key': VISUAL_KEEP_MODEL_MANIFEST_KEY,
        'model_manifest_sha256': manifest_sha256,
        'producer_source_sha256': payload.get('producerSourceSha256'),
        'feature_contract_version': payload.get('featureContractVersion'),
        'feature_contract_sha256': payload.get('featureContractSha256'),
        'model_generated_at': payload.get('generatedAt'),
        'model_status': payload.get('status'),
        'input': payload.get('input'),
        'source': 'live_frozen_model_score',
    }

def visual_keep_forecast(embedding):
    global _VISUAL_KEEP_MODEL_CACHE
    if _VISUAL_KEEP_MODEL_CACHE is None:
        manifest_bytes = r2_get(VISUAL_KEEP_MODEL_MANIFEST_KEY)
        if not manifest_bytes:
            raise RuntimeError('visual keep predictor release manifest is unavailable')
        try:
            manifest = json.loads(manifest_bytes)
        except Exception as error:
            raise RuntimeError('visual keep predictor release manifest is not valid JSON') from error
        artifact_sha256 = str(manifest.get('artifactSha256') or '').lower()
        artifact_key = str(manifest.get('archiveKey') or '')
        expected_archive_key = (
            'raw/predictor-lab/visual-keep-model/by-sha256/'
            f'{artifact_sha256}.json'
        )
        if (
            manifest.get('coordinateId') != VISUAL_KEEP_COORDINATE_ID
            or manifest.get('canonicalKey') != VISUAL_KEEP_MODEL_KEY
            or not _exact_sha256(artifact_sha256)
            or artifact_key != expected_archive_key
            or not _exact_sha256(manifest.get('producerSourceSha256'))
            or not _exact_sha256(manifest.get('featureContractSha256'))
        ):
            raise RuntimeError('visual keep predictor release manifest failed integrity validation')
        payload_bytes = r2_get(artifact_key)
        if not payload_bytes:
            raise RuntimeError('visual keep predictor immutable artifact is unavailable')
        actual_sha256 = hashlib.sha256(payload_bytes).hexdigest()
        if actual_sha256 != artifact_sha256:
            raise RuntimeError('visual keep predictor immutable artifact hash does not match its manifest')
        try:
            payload = json.loads(payload_bytes)
        except Exception as error:
            raise RuntimeError('visual keep predictor artifact is not valid JSON') from error
        if (
            payload.get('coordinateId') != VISUAL_KEEP_COORDINATE_ID
            or payload.get('producerSourceSha256') != manifest.get('producerSourceSha256')
            or payload.get('featureContractVersion') != manifest.get('featureContractVersion')
            or payload.get('featureContractSha256') != manifest.get('featureContractSha256')
        ):
            raise RuntimeError('visual keep predictor artifact provenance does not match its release manifest')
        _VISUAL_KEEP_MODEL_CACHE = {
            'payload': payload,
            'artifact_sha256': artifact_sha256,
            'artifact_key': artifact_key,
            'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
        }
    cached = _VISUAL_KEEP_MODEL_CACHE
    return _visual_keep_forecast_from_payload(
        embedding,
        cached['payload'],
        cached['artifact_sha256'],
        cached['artifact_key'],
        cached['manifest_sha256'],
    )

def creator_adaptive_keep_forecast(visual, together, profile):
    global _CREATOR_ADAPTIVE_KEEP_STATE_CACHE
    profile = str(profile or '').strip().lower()
    if not profile:
        return None
    if _CREATOR_ADAPTIVE_KEEP_STATE_CACHE is None:
        serving_manifest_bytes = r2_get(
            CREATOR_ADAPTIVE_KEEP_SERVING_MANIFEST_KEY
        )
        model_manifest_bytes = r2_get(
            CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY
        )
        if not serving_manifest_bytes or not model_manifest_bytes:
            raise RuntimeError(
                'creator-adaptive keep serving release is unavailable'
            )
        try:
            serving_manifest = json.loads(serving_manifest_bytes)
            model_manifest = json.loads(model_manifest_bytes)
        except Exception as error:
            raise RuntimeError(
                'creator-adaptive keep release manifest is invalid JSON'
            ) from error
        artifact_sha256 = str(
            serving_manifest.get('artifactSha256') or ''
        ).lower()
        artifact_key = str(serving_manifest.get('archiveKey') or '')
        expected_key = (
            'raw/predictor-lab/creator-adaptive-keep-serving/by-sha256/'
            f'{artifact_sha256}.npz'
        )
        model_artifact_sha256 = str(
            model_manifest.get('artifactSha256') or ''
        ).lower()
        model_artifact_key = str(
            model_manifest.get('archiveKey') or ''
        )
        expected_model_key = (
            'raw/predictor-lab/creator-adaptive-keep-model/by-sha256/'
            f'{model_artifact_sha256}.json'
        )
        if (
            serving_manifest.get('coordinateId')
            != CREATOR_ADAPTIVE_KEEP_COORDINATE_ID
            or serving_manifest.get('canonicalKey')
            != CREATOR_ADAPTIVE_KEEP_SERVING_KEY
            or artifact_key != expected_key
            or not _exact_sha256(artifact_sha256)
            or not _exact_sha256(model_artifact_sha256)
            or serving_manifest.get('modelArtifactSha256')
            != model_artifact_sha256
            or model_manifest.get('coordinateId')
            != CREATOR_ADAPTIVE_KEEP_COORDINATE_ID
            or model_manifest.get('canonicalKey')
            != CREATOR_ADAPTIVE_KEEP_MODEL_KEY
            or model_artifact_key != expected_model_key
            or not _exact_sha256(
                model_manifest.get('producerSourceSha256')
            )
            or not _exact_sha256(
                model_manifest.get('featureContractSha256')
            )
            or not _exact_sha256(
                serving_manifest.get('producerSourceSha256')
            )
            or not _exact_sha256(
                serving_manifest.get('servingScorerSourceSha256')
            )
            or serving_manifest.get('featureContractVersion')
            != model_manifest.get('featureContractVersion')
            or serving_manifest.get('featureContractSha256')
            != model_manifest.get('featureContractSha256')
        ):
            raise RuntimeError(
                'creator-adaptive keep serving manifest failed integrity validation'
            )
        artifact = r2_get(artifact_key)
        if not artifact:
            raise RuntimeError(
                'creator-adaptive keep immutable serving artifact is unavailable'
            )
        if hashlib.sha256(artifact).hexdigest() != artifact_sha256:
            raise RuntimeError(
                'creator-adaptive keep serving artifact hash does not match'
            )
        state = load_serving_state(artifact)
        metadata = state.get('metadata') or {}
        scorer_source_sha256 = hashlib.sha256(
            open(
                os.path.join(HERE, 'creator_adaptive_keep.py'),
                'rb',
            ).read()
        ).hexdigest()
        if (
            metadata.get('modelArtifactSha256') != model_artifact_sha256
            or metadata.get('servingScorerSourceSha256')
            != scorer_source_sha256
            or serving_manifest.get('servingScorerSourceSha256')
            != scorer_source_sha256
            or metadata.get('producerSourceSha256')
            != serving_manifest.get('producerSourceSha256')
            or metadata.get('featureContractVersion')
            != serving_manifest.get('featureContractVersion')
            or metadata.get('featureContractSha256')
            != serving_manifest.get('featureContractSha256')
        ):
            raise RuntimeError(
                'creator-adaptive keep serving code or model revision is incompatible'
            )
        _CREATOR_ADAPTIVE_KEEP_STATE_CACHE = {
            'state': state,
            'artifact_sha256': artifact_sha256,
            'artifact_key': artifact_key,
            'manifest_sha256': hashlib.sha256(
                serving_manifest_bytes
            ).hexdigest(),
            'manifest_key': CREATOR_ADAPTIVE_KEEP_SERVING_MANIFEST_KEY,
            'model_artifact_sha256': model_artifact_sha256,
            'model_artifact_key': model_artifact_key,
            'model_manifest_sha256': hashlib.sha256(
                model_manifest_bytes
            ).hexdigest(),
            'model_manifest_key':
                CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY,
            'model_producer_source_sha256':
                model_manifest.get('producerSourceSha256'),
            'serving_producer_source_sha256':
                serving_manifest.get('producerSourceSha256'),
            'serving_scorer_source_sha256':
                serving_manifest.get('servingScorerSourceSha256'),
            'feature_contract_version':
                serving_manifest.get('featureContractVersion'),
            'feature_contract_sha256':
                serving_manifest.get('featureContractSha256'),
            'candidate_registry_sha256':
                metadata.get('candidateRegistrySha256'),
        }
    cached = _CREATOR_ADAPTIVE_KEEP_STATE_CACHE
    result = score_creator_adaptive_keep(
        cached['state'],
        visual,
        together,
        profile,
    )
    result.update({
        'serving_artifact_sha256': cached['artifact_sha256'],
        'serving_artifact_key': cached['artifact_key'],
        'serving_artifact_canonical_key':
            CREATOR_ADAPTIVE_KEEP_SERVING_KEY,
        'serving_manifest_sha256': cached['manifest_sha256'],
        'serving_manifest_key': cached['manifest_key'],
        'serving_producer_source_sha256':
            cached['serving_producer_source_sha256'],
        'serving_scorer_source_sha256':
            cached['serving_scorer_source_sha256'],
        'model_artifact_sha256': cached['model_artifact_sha256'],
        'model_artifact_key': cached['model_artifact_key'],
        'model_artifact_canonical_key':
            CREATOR_ADAPTIVE_KEEP_MODEL_KEY,
        'model_manifest_sha256': cached['model_manifest_sha256'],
        'model_manifest_key': cached['model_manifest_key'],
        'model_producer_source_sha256':
            cached['model_producer_source_sha256'],
        'feature_contract_version':
            cached['feature_contract_version'],
        'feature_contract_sha256':
            cached['feature_contract_sha256'],
        'candidate_registry_sha256':
            cached['candidate_registry_sha256'],
        'calibration_scope': 'creator_profile_snapshot',
        'input': (
            'canonical visual embedding + canonical together embedding '
            '+ registered strictly-earlier creator profile history'
        ),
    })
    return result

def _canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def normalize_transcript(value):
    """Canonicalize only representation, not meaning, before both hashing and embedding."""
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value or ''))).strip()

def canonicalize_montage_bytes(value):
    """Give every source path the exact same pixel geometry and JPEG encoder contract."""
    try:
        with Image.open(io.BytesIO(value)) as source:
            if (
                source.format == 'JPEG'
                and source.size
                == (CANONICAL_MONTAGE_WIDTH, CANONICAL_MONTAGE_HEIGHT)
            ):
                return bytes(value)
            image = source.convert('RGB').resize(
                (CANONICAL_MONTAGE_WIDTH, CANONICAL_MONTAGE_HEIGHT),
                Image.Resampling.LANCZOS,
            )
            output = io.BytesIO()
            image.save(
                output,
                format='JPEG',
                quality=CANONICAL_MONTAGE_QUALITY,
                subsampling=2,
                optimize=False,
                progressive=False,
            )
            return output.getvalue()
    except Exception as error:
        raise RuntimeError(f'could not canonicalize the five-frame montage: {error}') from error

def canonicalize_montage_b64(value):
    raw = base64.b64decode(value)
    return base64.b64encode(canonicalize_montage_bytes(raw)).decode()

def _duration_milliseconds(value):
    try:
        number = float(value)
        return int(round(number * 1000)) if np.isfinite(number) and number > 0 else None
    except Exception:
        return None

def _embedding_input_state(montage_b64, transcript, transcript_used):
    montage_bytes = base64.b64decode(montage_b64)
    used = bool(transcript_used and transcript)
    return {
        'schema': 'shorts-embedding-input-v2',
        'montage_sha256': hashlib.sha256(montage_bytes).hexdigest(),
        'transcript': normalize_transcript(transcript),
        'channels': {
            'visual': '5-frame-montage',
            'text': 'normalized-transcript' if used else 'absent',
            'together': '5-frame-montage+normalized-transcript' if used else '5-frame-montage',
        },
    }

def _score_input_state(
    montage_b64,
    transcript,
    transcript_used,
    duration_s,
    creator_profile=None,
):
    embedding_state = _embedding_input_state(
        montage_b64,
        transcript,
        transcript_used,
    )
    embedding_fingerprint = hashlib.sha256(
        _canonical_json(embedding_state)
    ).hexdigest()
    return {
        'schema': 'shorts-score-input-v2',
        'embedding_input_fingerprint': embedding_fingerprint,
        'embedding_input': embedding_state,
        'duration_ms': _duration_milliseconds(duration_s),
        'creator_profile': str(creator_profile or '').strip().lower() or None,
    }

def _score_input_fingerprint(
    montage_b64,
    transcript,
    transcript_used,
    duration_s,
    creator_profile=None,
):
    state = _score_input_state(
        montage_b64,
        transcript,
        transcript_used,
        duration_s,
        creator_profile,
    )
    return hashlib.sha256(_canonical_json(state)).hexdigest(), state

def _r2_error_code(error):
    try:
        return str((error.response or {}).get('Error', {}).get('Code') or '')
    except Exception:
        return 'NoSuchKey' if isinstance(error, KeyError) else ''

def _object_revision(key):
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        etag = str(head.get('ETag') or '').strip('"')
        size = int(head.get('ContentLength') or 0)
        if not etag:
            raise ScoreArtifactIntegrityError(
                f'artifact has no immutable ETag: {key}'
            )
        revision = {
            'state': 'present',
            'etag': etag,
            'version_id': str(head.get('VersionId') or ''),
            'size': size,
        }
        if key.endswith('.json') and size <= 2 * 1024 * 1024:
            response = s3.get_object(
                Bucket=BUCKET,
                Key=key,
                IfMatch=etag,
            )
            payload = response['Body'].read()
            actual_etag = str(
                response.get('ETag') or ''
            ).strip('"')
            if actual_etag and actual_etag != etag:
                raise ScoreArtifactIntegrityError(
                    f'JSON artifact changed during revision capture: {key}'
                )
            if len(payload) != size:
                raise ScoreArtifactIntegrityError(
                    f'JSON artifact size changed during revision capture: {key}'
                )
            revision['sha256'] = hashlib.sha256(
                payload
            ).hexdigest()
        return revision
    except Exception as error:
        if _r2_error_code(error) in ('404', 'NoSuchKey', 'NotFound'):
            return {'state': 'missing'}
        return {'state': 'unavailable', 'error': f'{type(error).__name__}: {str(error)[:160]}'}

def _score_code_sha256():
    try:
        return hashlib.sha256(open(__file__, 'rb').read()).hexdigest()
    except Exception:
        return None

def _score_ledger_code_sha256():
    try:
        return hashlib.sha256(
            open(os.path.join(HERE, 'shorts_score_ledger.py'), 'rb').read()
        ).hexdigest()
    except Exception:
        return None

def _creator_scorer_code_sha256():
    try:
        return hashlib.sha256(
            open(os.path.join(HERE, 'creator_adaptive_keep.py'), 'rb').read()
        ).hexdigest()
    except Exception:
        return None

_FFMPEG_VERSION = None
def _ffmpeg_version():
    global _FFMPEG_VERSION
    if _FFMPEG_VERSION is None:
        try:
            result = subprocess.run(
                ['ffmpeg', '-version'],
                capture_output=True,
                text=True,
                timeout=5,
            )
            _FFMPEG_VERSION = (
                result.stdout.strip().splitlines()[0][:160]
                if result.stdout.strip()
                else 'unavailable'
            )
        except Exception:
            _FFMPEG_VERSION = 'unavailable'
    return _FFMPEG_VERSION

def _score_revisions():
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=len(SCORE_REVISION_KEYS)) as executor:
        artifact_rows = list(executor.map(_object_revision, SCORE_REVISION_KEYS))
    return {
        'schema': 'shorts-score-revisions-v1',
        'scorer': {
            'name': 'raw_upload.py',
            'sha256': _score_code_sha256(),
            'score_ledger_module_sha256':
                _score_ledger_code_sha256(),
            'creator_adaptive_module_sha256':
                _creator_scorer_code_sha256(),
        },
        'models': {
            'embedding': {
                'name': EMBEDDING_MODEL,
                'dimensions': DIM,
                'endpoint': EMB_URL,
            },
            'transcription': {
                'name': TRANSCRIPTION_MODEL,
                'decoding': 'temperature=0,topP=1,topK=1',
            },
        },
        'runtime': {
            'python': f'{sys.version_info.major}.{sys.version_info.minor}',
            'numpy': np.__version__,
            'pillow': PILLOW_VERSION,
            'pillow_jpeg': str(
                getattr(Image.core, 'jpeglib_version', 'unavailable')
            ),
            'ffmpeg': _ffmpeg_version(),
        },
        'artifacts': dict(zip(SCORE_REVISION_KEYS, artifact_rows)),
    }

def _revision_fingerprint(revisions):
    return hashlib.sha256(_canonical_json(revisions)).hexdigest()

def _score_cache_key(input_fingerprint, revision_fingerprint):
    digest = hashlib.sha256(_canonical_json({
        'version': SCORE_CACHE_VERSION,
        'input': input_fingerprint,
        'revisions': revision_fingerprint,
    })).hexdigest()
    return f'{SCORE_CACHE_PREFIX}/{digest}.json'

def _score_output_fingerprint(score):
    return hashlib.sha256(_canonical_json(score)).hexdigest()

def _score_completeness_errors(
    score,
    creator_profile=None,
    transcript_used=False,
):
    missing = []
    previews = score.get('emb_preview') or {}
    for channel in ('visual', 'together'):
        preview = previews.get(channel)
        if not (
            isinstance(preview, list)
            and len(preview) == 48
            and all(np.isfinite(value) for value in preview)
        ):
            missing.append(f'{channel} embedding preview')
    required_channels = ['visual', 'together']
    if transcript_used:
        required_channels.append('text')
    steer = score.get('steer') or {}
    for channel in required_channels:
        for target in (
            'keep', 'ret5', 'views', 'realviews', 'outlier', 'gt10M'
        ):
            value = (steer.get(f'{channel}_{target}') or {}).get('est')
            if value is None or not np.isfinite(value):
                missing.append(f'{channel}_{target}')
    indicators = score.get('indicators') or {}
    for channel in ('vis', 'tog'):
        value = indicators.get(f'nov_{channel}_global')
        if value is None or not np.isfinite(value):
            missing.append(f'nov_{channel}_global')
    if transcript_used:
        value = indicators.get('nov_txt_global')
        if value is None or not np.isfinite(value):
            missing.append('nov_txt_global')
    visual_forecast = score.get('visual_keep_forecast') or {}
    if (
        visual_forecast.get('coordinate_id')
        != VISUAL_KEEP_COORDINATE_ID
        or visual_forecast.get('raw') is None
        or not np.isfinite(visual_forecast.get('raw'))
    ):
        missing.append('frozen visual keep forecast')
    for channel in ('visual', 'together'):
        placement = ((score.get('channels') or {}).get(channel) or {})
        neighbors_value = placement.get('neighbors')
        if not isinstance(neighbors_value, list) or not neighbors_value:
            missing.append(f'{channel} map placement')
    if creator_profile:
        creator_forecast = score.get(
            'creator_adaptive_keep_forecast'
        ) or {}
        if (
            creator_forecast.get('coordinate_id')
            != CREATOR_ADAPTIVE_KEEP_COORDINATE_ID
            or creator_forecast.get('profile_account')
            != creator_profile
            or creator_forecast.get('raw') is None
            or not np.isfinite(creator_forecast.get('raw'))
        ):
            missing.append('creator-adaptive keep forecast')
    return missing

def _score_cache_read(
    key,
    input_fingerprint,
    revision_fingerprint,
    creator_profile=None,
    transcript_used=False,
):
    try:
        raw = s3.get_object(Bucket=BUCKET, Key=key)['Body'].read()
        payload = json.loads(raw)
        score = payload.get('score')
        output_fingerprint = payload.get('output_fingerprint')
        valid = (
            payload.get('schema') == 'shorts-score-replay-v1'
            and int(payload.get('version') or 0) == SCORE_CACHE_VERSION
            and payload.get('input_fingerprint') == input_fingerprint
            and payload.get('revision_fingerprint') == revision_fingerprint
            and isinstance(score, dict)
            and all(isinstance(score.get(field), dict) for field in (
                'indicators',
                'steer',
                'visual_keep_forecast',
                'emb_preview',
                'channels',
            ))
            and not _score_completeness_errors(
                score,
                creator_profile,
                transcript_used,
            )
            and output_fingerprint == _score_output_fingerprint(score)
        )
        if not valid:
            return None, 'invalid', 'cached score failed schema or integrity validation'
        return score, 'hit', None
    except Exception as error:
        if _r2_error_code(error) in ('404', 'NoSuchKey', 'NotFound'):
            return None, 'miss', None
        return None, 'read_error', f'{type(error).__name__}: {str(error)[:160]}'

def _score_cache_write(key, input_fingerprint, revision_fingerprint, revisions, score):
    output_fingerprint = _score_output_fingerprint(score)
    payload = {
        'schema': 'shorts-score-replay-v1',
        'version': SCORE_CACHE_VERSION,
        'created_at_ms': int(time.time() * 1000),
        'input_fingerprint': input_fingerprint,
        'revision_fingerprint': revision_fingerprint,
        'output_fingerprint': output_fingerprint,
        'revisions': revisions,
        'score': score,
    }
    try:
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=_canonical_json(payload),
            ContentType='application/json',
            CacheControl='no-store',
        )
        return 'stored', None, output_fingerprint
    except Exception as error:
        return 'write_error', f'{type(error).__name__}: {str(error)[:160]}', output_fingerprint

def _score_replay_prepare(
    montage_b64,
    transcript,
    transcript_used,
    duration_s,
    creator_profile=None,
    revisions=None,
):
    input_fingerprint, input_state = _score_input_fingerprint(
        montage_b64,
        transcript,
        transcript_used,
        duration_s,
        creator_profile,
    )
    revisions = revisions or _score_revisions()
    revision_fingerprint = _revision_fingerprint(revisions)
    unavailable = [
        key for key, value in (revisions.get('artifacts') or {}).items()
        if value.get('state') == 'unavailable'
    ]
    cache_key = _score_cache_key(input_fingerprint, revision_fingerprint)
    disabled = str(env('RAW_SCORE_CACHE_DISABLED') or '').lower() in ('1', 'true', 'yes')
    meta = {
        'cache_version': SCORE_CACHE_VERSION,
        'cache_key': cache_key,
        'cache_status': 'disabled' if disabled else 'disabled_revision_unavailable' if unavailable else 'miss',
        'cache_write_status': 'not_attempted',
        'input_fingerprint': input_fingerprint,
        'embedding_input_fingerprint': input_state.get(
            'embedding_input_fingerprint'
        ),
        'revision_fingerprint': revision_fingerprint,
        'output_fingerprint': None,
        'scorer_revisions': revisions,
        'input_state': input_state,
    }
    if disabled or unavailable:
        if unavailable:
            meta['cache_error'] = 'revision lookup unavailable for: ' + ', '.join(unavailable)
        return {'score': None, 'meta': meta}
    score, status, error = _score_cache_read(
        cache_key,
        input_fingerprint,
        revision_fingerprint,
        str(creator_profile or '').strip().lower() or None,
        bool(transcript_used),
    )
    meta['cache_status'] = status
    if error:
        meta['cache_error'] = error
    if score is not None:
        meta['output_fingerprint'] = _score_output_fingerprint(score)
    return {'score': score, 'meta': meta}

def _scorer_contract():
    global _PINNED_ARTIFACT_REVISIONS
    revisions = _score_revisions()
    _PINNED_ARTIFACT_REVISIONS = dict(
        revisions.get('artifacts') or {}
    )
    creator_profiles = []
    visual_manifest_bytes = r2_get(
        VISUAL_KEEP_MODEL_MANIFEST_KEY
    )
    serving_manifest_bytes = r2_get(
        CREATOR_ADAPTIVE_KEEP_SERVING_MANIFEST_KEY
    )
    model_manifest_bytes = r2_get(
        CREATOR_ADAPTIVE_KEEP_MODEL_MANIFEST_KEY
    )
    visual_manifest = None
    serving_manifest = None
    model_manifest = None
    if visual_manifest_bytes:
        try:
            visual_manifest = json.loads(visual_manifest_bytes)
        except Exception:
            visual_manifest = None
    if serving_manifest_bytes:
        try:
            serving_manifest = json.loads(serving_manifest_bytes)
            creator_profiles = sorted(
                str(value).strip().lower()
                for value in (serving_manifest.get('profiles') or [])
                if str(value).strip()
            )
        except Exception:
            creator_profiles = []
    if model_manifest_bytes:
        try:
            model_manifest = json.loads(model_manifest_bytes)
        except Exception:
            model_manifest = None
    return {
        'schema': 'shorts-live-score-contract-v2',
        'scorer': 'raw_upload.py',
        'revision_fingerprint': _revision_fingerprint(revisions),
        'scorer_revisions': revisions,
        'display_contract_version': DISPLAY_CONTRACT_VERSION,
        'feature_contract_identity_schema_version':
            FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        'feature_contract_sha256': FEATURE_CONTRACT_SHA256,
        'feature_contract_document_sha256':
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        'coordinate_governance_version': COORDINATE_GOVERNANCE['schemaVersion'],
        'coordinate_governance_sha256': COORDINATE_GOVERNANCE_SHA256,
        'embedding_model': EMBEDDING_MODEL,
        'embedding_dimensions': DIM,
        'source_window': 'first 5 seconds',
        'canonical_montage': {
            'width': CANONICAL_MONTAGE_WIDTH,
            'height': CANONICAL_MONTAGE_HEIGHT,
            'format': 'JPEG',
            'quality': CANONICAL_MONTAGE_QUALITY,
            'subsampling': '4:2:0',
        },
        'coordinates': {
            'stored_pattern':
                COORDINATE_GOVERNANCE['coordinates']['storedPattern'],
            'stored': list(SHORTS_STORED_COORDINATE_IDS),
            'visual_keep_forecast': VISUAL_KEEP_COORDINATE_ID,
            'creator_adaptive_keep_forecast':
                CREATOR_ADAPTIVE_KEEP_COORDINATE_ID,
        },
        'creator_profiles': creator_profiles,
        'visual_keep_model_manifest_sha256': (
            hashlib.sha256(visual_manifest_bytes).hexdigest()
            if visual_manifest_bytes else None
        ),
        'visual_keep_model_artifact_sha256': (
            visual_manifest.get('artifactSha256')
            if visual_manifest else None
        ),
        'visual_keep_model_producer_source_sha256': (
            visual_manifest.get('producerSourceSha256')
            if visual_manifest else None
        ),
        'creator_serving_manifest_sha256': (
            hashlib.sha256(serving_manifest_bytes).hexdigest()
            if serving_manifest_bytes else None
        ),
        'creator_serving_artifact_sha256': (
            serving_manifest.get('artifactSha256')
            if serving_manifest else None
        ),
        'creator_serving_producer_source_sha256': (
            serving_manifest.get('producerSourceSha256')
            if serving_manifest else None
        ),
        'creator_serving_scorer_source_sha256': (
            serving_manifest.get('servingScorerSourceSha256')
            if serving_manifest else None
        ),
        'creator_model_manifest_sha256': (
            hashlib.sha256(model_manifest_bytes).hexdigest()
            if model_manifest_bytes else None
        ),
        'creator_model_artifact_sha256': (
            model_manifest.get('artifactSha256')
            if model_manifest else None
        ),
        'creator_model_producer_source_sha256': (
            model_manifest.get('producerSourceSha256')
            if model_manifest else None
        ),
        'parity_rule': (
            'Ordinary embedding coordinates replay exactly when the '
            'embedding_input_fingerprint and revision_fingerprint match. '
            'Duration and creator profile affect only derived scores. '
            'The realviews coordinate also requires the same duration_ms; '
            'a five-frame input without duration uses the documented default '
            'and cannot claim realviews parity with a source of known duration.'
        ),
    }

def _score_replay_store(
    replay,
    score,
    creator_profile=None,
    transcript_used=False,
):
    meta = replay['meta']
    incomplete = _score_completeness_errors(
        score,
        str(creator_profile or '').strip().lower() or None,
        bool(transcript_used),
    )
    if incomplete:
        meta['cache_write_status'] = 'skipped_incomplete'
        raise RuntimeError(
            'scoring dependencies returned an incomplete result: '
            + ', '.join(incomplete)
        )
    if meta.get('cache_status') in ('disabled', 'disabled_revision_unavailable'):
        meta['output_fingerprint'] = _score_output_fingerprint(score)
        return meta
    status, error, output_fingerprint = _score_cache_write(
        meta['cache_key'],
        meta['input_fingerprint'],
        meta['revision_fingerprint'],
        meta['scorer_revisions'],
        score,
    )
    meta['cache_write_status'] = status
    meta['output_fingerprint'] = output_fingerprint
    if error:
        meta['cache_error'] = '; '.join(filter(None, (meta.get('cache_error'), error)))
    return meta

def embed(parts, tries=3):
    # bounded so 3 sequential embeds can't blow past the server's 240s kill (was 5×60s=300s PER call,
    # which intermittently hung the whole upload when Gemini was slow). 3×30s = 90s worst case per embed.
    body = json.dumps({'content': {'parts': parts}, 'outputDimensionality': DIM}).encode()
    if not KEY:
        raise RuntimeError('GEMINI_API_KEY is not configured')
    last_error = 'unknown Gemini embedding failure'
    for a in range(tries):
        retry_delay = 1.0 * (a + 1)
        try:
            req = urllib.request.Request(EMB_URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=30) as r:
                return np.array(json.loads(r.read())['embedding']['values'], np.float32)
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode('utf-8', 'replace'))
                detail = str((payload.get('error') or {}).get('message') or '')[:240]
            except Exception:
                detail = ''
            last_error = f'Gemini embedding HTTP {error.code}' + (f': {detail}' if detail else '')
            # Bad key, billing suspension, and exhausted project quota do not improve
            # when retried seconds later. A 429 can also be a transient rate limit,
            # so honor Retry-After and surface it only after bounded retries.
            if error.code in (400, 401, 403):
                raise RuntimeError(last_error)
            if error.code == 429:
                try: retry_delay = min(10.0, max(1.0, float(error.headers.get('Retry-After') or retry_delay)))
                except Exception: pass
        except Exception as error:
            last_error = f'{type(error).__name__}: {str(error)[:220]}'
        if a < tries - 1:
            time.sleep(retry_delay)
    raise RuntimeError(last_error)
def img_part(b64): return {'inlineData': {'mimeType': 'image/jpeg', 'data': b64}}

def gemini_transcribe(wav):
    """Transcribe via the Gemini API — used where Whisper/torch isn't installed
    (e.g. the Render box). Returns (text, is_voiceover)."""
    if not KEY:
        raise RuntimeError('GEMINI_API_KEY is not configured for transcription')
    data = base64.b64encode(open(wav, 'rb').read()).decode()
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{TRANSCRIPTION_MODEL}:generateContent'
    body = json.dumps({'contents': [{'parts': [
        {'inlineData': {'mimeType': 'audio/wav', 'data': data}},
        {'text': 'Transcribe ONLY the spoken words in this short audio, verbatim. If there is no speech (music or ambient noise only), reply with exactly: NO_SPEECH'}]}],
        'generationConfig': {'temperature': 0, 'topP': 1, 'topK': 1}}).encode()
    last_error = 'unknown Gemini transcription failure'
    for attempt in range(3):
        retry_delay = 1.0 * (attempt + 1)
        try:
            req = urllib.request.Request(url, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read())
            t = (((j.get('candidates') or [{}])[0].get('content') or {}).get('parts') or [{}])[0].get('text', '').strip()
            if not t:
                raise RuntimeError('Gemini transcription returned no text')
            if t.upper() == 'NO_SPEECH':
                return '', False
            return t, coherent(t)
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode('utf-8', 'replace'))
                detail = str((payload.get('error') or {}).get('message') or '')[:240]
            except Exception:
                detail = ''
            last_error = f'Gemini transcription HTTP {error.code}' + (f': {detail}' if detail else '')
            if error.code in (400, 401, 403):
                raise RuntimeError(last_error)
            if error.code == 429:
                try: retry_delay = min(10.0, max(1.0, float(error.headers.get('Retry-After') or retry_delay)))
                except Exception: pass
        except Exception as error:
            last_error = f'{type(error).__name__}: {str(error)[:220]}'
        if attempt < 2:
            time.sleep(retry_delay)
    raise RuntimeError(last_error)

def whisper_text(wav):
    """Use one transcriber on Render and the relay so source mode cannot change text."""
    return gemini_transcribe(wav)

def _montage_audio(src, mon, wav):
    """Extract the 5-frame montage + first-5s audio→transcript from one source file.
    ffmpeg auto-detects the container/codec, so .mov/.mp4/.webm/.mkv all work here."""
    subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', src, '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', mon], timeout=90)
    txt, good = '', False
    if os.path.exists(mon):
        try:
            subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-t', '5', '-i', src, '-vn', '-ar', '16000', '-ac', '1', wav], timeout=90)
        except Exception: pass
        if os.path.exists(wav) and os.path.getsize(wav) > 1000:
            txt, good = whisper_text(wav)
    return txt, good

def hook_inputs(src):
    """first-5s montage (b64) + (transcript, is_voiceover) from ANY local video file.
    Tries the file directly first; if ffmpeg can't decode it (exotic codec/container),
    normalizes to a clean H.264 mp4 and retries — so any uploadable format works."""
    tmp = tempfile.mkdtemp(prefix='rawup_')
    try:
        mon, wav, norm = os.path.join(tmp, 'm.jpg'), os.path.join(tmp, 'a.wav'), os.path.join(tmp, 'norm.mp4')
        txt, good = _montage_audio(src, mon, wav)
        if not os.path.exists(mon):                       # decode failed → transcode then retry
            try:
                subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', src, '-t', '6',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', norm], timeout=180)
            except Exception: pass
            if os.path.exists(norm):
                for f in (mon, wav):
                    try: os.remove(f)
                    except Exception: pass
                txt, good = _montage_audio(norm, mon, wav)
        if not os.path.exists(mon): return None
        b64 = base64.b64encode(open(mon, 'rb').read()).decode()
        return b64, txt, good
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

class _YoutubeLogger:
    def debug(self, *args): pass
    def warning(self, *args): pass
    def error(self, *args): pass

def _clear_youtube_downloads(folder):
    for filename in os.listdir(folder):
        try:
            path = os.path.join(folder, filename)
            if os.path.isdir(path): shutil.rmtree(path, ignore_errors=True)
            else: os.remove(path)
        except OSError:
            pass

def _youtube_profiles():
    """Ordered auth profiles for the one shared link-scoring downloader.

    Render gets the anonymous attempt and relays access failures to the Mac.
    The Mac can then use an exported cookie file or the user's browser session;
    browser cookies are never requested on Linux/Render.
    """
    profiles = [('anonymous', {})]
    cookie_file = env('RAW_YOUTUBE_COOKIES_FILE') or env('YTDLP_COOKIES_FILE')
    if not cookie_file:
        local_cookie_file = os.path.join(HERE, 'raw-cookies.txt')
        if os.path.isfile(local_cookie_file) and os.path.getsize(local_cookie_file) > 0:
            cookie_file = local_cookie_file
    if cookie_file and os.path.isfile(os.path.expanduser(cookie_file)):
        profiles.append(('cookie-file', {'cookiefile': os.path.expanduser(cookie_file)}))

    configured = env('RAW_YOUTUBE_COOKIES_FROM_BROWSER') or env('YTDLP_COOKIES_FROM_BROWSER')
    browsers = re.split(r'[\s,]+', configured.strip()) if configured else (
        ['chrome', 'safari'] if sys.platform == 'darwin' else [])
    seen = set()
    for browser in browsers:
        browser = browser.strip().lower()
        if browser and browser not in seen:
            seen.add(browser)
            profiles.append(('browser-' + browser, {'cookiesfrombrowser': (browser,)}))
    return profiles

def _youtube_download_options(folder, auth_options, ranged=True):
    import yt_dlp
    from yt_dlp.utils import download_range_func
    options = {
        'format': 'mp4[height<=480]/best[height<=480]/best',
        'outtmpl': os.path.join(folder, 'v.%(ext)s'),
        'quiet': True,
        'no_warnings': True,
        'noprogress': True,
        'noplaylist': True,
        'logger': _YoutubeLogger(),
        'socket_timeout': 30,
        'retries': 3,
        'fragment_retries': 3,
        'js_runtimes': {'node': {}},
        'remote_components': ['ejs:github'],
    }
    options.update(auth_options)
    if auth_options:
        # The authenticated Safari client exposes a stable muxed HLS stream and
        # avoids the mweb media URLs that currently resolve but fail with 403.
        options['extractor_args'] = {'youtube': {'player_client': ['web_safari']}}
    if ranged:
        options['download_ranges'] = download_range_func(None, [(0, 6)])
        options['force_keyframes_at_cuts'] = True
    else:
        options['format'] = 'bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best'
        options['merge_output_format'] = 'mp4'
    return options

def _downloaded_youtube_file(folder):
    candidates = []
    for filename in os.listdir(folder):
        path = os.path.join(folder, filename)
        if (os.path.isfile(path) and not filename.endswith(('.part', '.ytdl', '.json'))
                and os.path.getsize(path) >= 10000):
            candidates.append(path)
    return max(candidates, key=os.path.getsize) if candidates else None

def download_youtube_hook(video_id, folder):
    """Download the measured six-second opening, returning info/path/profile.

    All callers use this function, so direct scoring and the R2 Mac relay cannot
    drift into different YouTube acquisition behavior.
    """
    import yt_dlp
    source = f'https://www.youtube.com/watch?v={video_id}'
    failures = []
    profiles = _youtube_profiles()
    for profile, auth_options in profiles:
        _clear_youtube_downloads(folder)
        try:
            with yt_dlp.YoutubeDL(_youtube_download_options(folder, auth_options, ranged=True)) as ydl:
                info = ydl.extract_info(source, download=True)
            path = _downloaded_youtube_file(folder)
            if path:
                return info, path, profile
            raise RuntimeError('download produced no usable video')
        except Exception as range_error:
            failures.append((profile, str(range_error)))
            message = str(range_error).lower()
            # Preserve the historical progressive-MP4 recovery. For an
            # authenticated profile, also recover from a range/ffmpeg transport
            # failure by downloading the small 480p source normally.
            should_try_full = 'ffmpeg exited with code 183' in message or bool(auth_options)
            if not should_try_full:
                continue
            _clear_youtube_downloads(folder)
            try:
                with yt_dlp.YoutubeDL(_youtube_download_options(folder, auth_options, ranged=False)) as ydl:
                    info = ydl.extract_info(source, download=True)
                path = _downloaded_youtube_file(folder)
                if path:
                    return info, path, profile + '-full'
                raise RuntimeError('full download produced no usable video')
            except Exception as full_error:
                failures.append((profile + '-full', str(full_error)))
    message = failures[-1][1] if failures else 'no downloader profile was available'
    attempted = ', '.join(profile for profile, _ in failures) or 'none'
    raise RuntimeError(f'{message} (attempted: {attempted})')

import gc, tempfile
# The scorer was taking 310s on the deploy (>240s kill → error) vs 26s locally: re-downloading three
# ~72MB embedding files from R2 every upload and holding them in RAM swap-thrashed the tight box.
# Fix: keep a normalized copy on local disk (validated by the R2 ETag so it's never stale), memory-map
# it, and compute similarities in CHUNKS so a matmul never pulls the whole 72MB into RAM. First upload
# after a deploy warms the cache; every one after skips the download entirely. Result cached per request.
_CDIR = tempfile.gettempdir()
_NBR = {}
_PINNED_ARTIFACT_REVISIONS = {}

def _zip_central_dir(key, size, etag=None):
    """Member table of a remote zip (npz) from ONE small ranged read of its central directory."""
    import struct
    tl = min(size, 65536)
    conditional = {'IfMatch': etag} if etag else {}
    tail = s3.get_object(
        Bucket=BUCKET,
        Key=key,
        Range=f'bytes={size - tl}-',
        **conditional,
    )['Body'].read()
    out = {}
    for m in re.finditer(rb'PK\x01\x02', tail):
        e = tail[m.start():m.start() + 46]
        if len(e) < 46: continue
        nlen = struct.unpack('<H', e[28:30])[0]
        rec = {'method': struct.unpack('<H', e[10:12])[0],
               'csize': struct.unpack('<I', e[20:24])[0],
               'usize': struct.unpack('<I', e[24:28])[0],
               'off': struct.unpack('<I', e[42:46])[0]}
        if rec['csize'] == 0xFFFFFFFF or rec['off'] == 0xFFFFFFFF: raise RuntimeError('zip64 npz not supported')
        out[tail[m.start() + 46:m.start() + 46 + nlen].decode('utf-8', 'replace')] = rec
    return out

def _zip_member_stream(key, info, etag=None):
    """Yield one member's DECOMPRESSED bytes via ranged reads — the archive is never on disk
    and the array never fully in RAM. IfMatch pins the object so a concurrent rewrite by the
    embed batch fails loudly instead of corrupting the stream."""
    import struct, zlib
    cond = {'IfMatch': etag} if etag else {}
    hdr = s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes={info['off']}-{info['off'] + 29}", **cond)['Body'].read()
    n2, x2 = struct.unpack('<HH', hdr[26:30])
    start = info['off'] + 30 + n2 + x2
    body = s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes={start}-{start + info['csize'] - 1}", **cond)['Body']
    d = None if info['method'] == 0 else zlib.decompressobj(-15)
    while True:
        chunk = body.read(1 << 20)
        if not chunk: break
        piece = chunk if d is None else d.decompress(chunk)
        if piece: yield piece
    if d is not None:
        piece = d.flush()
        if piece: yield piece

def _norm_emb(c):
    npy = os.path.join(_CDIR, f'rawemb_{c}.npy'); meta = os.path.join(_CDIR, f'rawemb_{c}.meta.json')
    key = f'raw/{c}/embeddings.npz'
    etag, size = None, None
    expected = _PINNED_ARTIFACT_REVISIONS.get(key)
    try:
        h = s3.head_object(Bucket=BUCKET, Key=key)
        etag, size = str(h.get('ETag') or '').strip('"'), h['ContentLength']
    except Exception as error:
        if expected and expected.get('state') == 'present':
            raise RuntimeError(f'could not verify pinned artifact {key}: {error}') from error
    if expected and expected.get('state') == 'present':
        expected_etag = str(expected.get('etag') or '').strip('"')
        if not etag or etag != expected_etag:
            raise RuntimeError(
                f'pinned artifact changed before scoring: {key} '
                f'(expected {expected_etag or "unknown"}, found {etag or "unavailable"})'
            )
    def _cached(require_etag=True):
        try:
            m = json.load(open(meta))
            if (not require_etag) or m.get('etag') == etag: return np.load(npy, mmap_mode='r'), m['ids']
        except Exception: pass
        return None
    if etag and os.path.exists(npy) and os.path.exists(meta):
        hit = _cached()
        if hit: return hit
    # The library grew ~5x (66k videos → visual/together embeddings.npz are ~380MB EACH), so the
    # old read-whole-npz-into-RAM warm held ~3 copies (~1.2GB) and OOM-restarted the 2GB deploy
    # box — which lost the in-memory scoring job, and the UI's auto-resubmit looped the OOM.
    # Now the vecs.npy member is range-streamed from R2 and decompressed STRAIGHT to disk (the
    # archive never exists here and the matrix is never fully in RAM), then normalized in place
    # through a writable mmap in 4096-row chunks. A stale cache is never accepted: doing so would
    # attribute neighbor-derived scores to an artifact revision that did not produce them.
    if not etag or not size:
        return (None, None)
    tmp = npy + f'.dl{os.getpid()}'
    try:   # sweep partial downloads orphaned by killed runs (SIGKILL skips finally blocks)
        import glob
        for g in glob.glob(npy + '.dl*'):
            if g != tmp and time.time() - os.path.getmtime(g) > 900: os.remove(g)
    except Exception: pass
    try:
        print(f'[warm] {c}: streaming {round(size / 1e6)}MB library from R2', file=sys.stderr, flush=True)
        members = _zip_central_dir(key, size, etag)
        vi, ii = members.get('vecs.npy'), members.get('ids.npy')
        if not vi or not ii: raise RuntimeError('npz missing vecs/ids members')
        with open(tmp, 'wb') as f:
            for piece in _zip_member_stream(key, vi, etag): f.write(piece)
        ids = [str(x) for x in np.load(io.BytesIO(b''.join(_zip_member_stream(key, ii, etag))), allow_pickle=True)]
        V = np.load(tmp, mmap_mode='r+')
        if V.ndim != 2 or len(V) != len(ids): raise RuntimeError(f'bad matrix {V.shape} vs {len(ids)} ids')
        for i in range(0, len(V), 4096):
            V[i:i + 4096] /= (np.linalg.norm(V[i:i + 4096], axis=1, keepdims=True) + 1e-9)
        V.flush(); del V; gc.collect()
        os.replace(tmp, npy); json.dump({'etag': etag, 'ids': ids}, open(meta, 'w'))
        print(f'[warm] {c}: cached + normalized → mmap', file=sys.stderr, flush=True)
        return np.load(npy, mmap_mode='r'), ids
    except Exception as e:
        print(f'[warm] {c}: FAILED ({type(e).__name__}: {str(e)[:120]}) — stale cache rejected', file=sys.stderr, flush=True)
        try: os.remove(tmp)
        except Exception: pass
        if expected and expected.get('state') == 'present':
            raise RuntimeError(f'could not materialize pinned artifact {key}: {e}') from e
        return (None, None)
def warm_all():
    """Warm the three neighbour caches in PARALLEL threads — each stream is network-bound
    and independent, so overlapping them cuts a cold warm (fresh deploy, ~900MB at the
    deploy's ~4MB/s from R2) from sequential minutes to the slowest single file. Safe to
    run concurrently with anything: caches land via atomic os.replace."""
    from concurrent.futures import ThreadPoolExecutor
    chans = ('visual', 'text', 'together')
    with ThreadPoolExecutor(3) as ex:
        for c, (V, ids) in zip(chans, ex.map(_norm_emb, chans)):
            print(f'[warm] {c}: {("ready n=" + str(len(ids))) if ids else "UNAVAILABLE"}', file=sys.stderr, flush=True)

def neighbors(c, vec, k=12):
    if c not in _NBR:
        V, ids = _norm_emb(c)
        if V is None: _NBR[c] = None
        elif len(V) == 0: _NBR[c] = []
        else:
            q = (np.asarray(vec, np.float32) / (np.linalg.norm(vec) + 1e-9))
            n = len(V); sims = np.empty(n, np.float32)
            for i in range(0, n, 4096): sims[i:i + 4096] = np.asarray(V[i:i + 4096]) @ q   # chunked over the mmap → low RAM
            del V; gc.collect()
            kk = min(13, n)
            part = np.argpartition(-sims, kk - 1)[:kk]
            _NBR[c] = [{'id': ids[i], 'sim': round(float(sims[i]), 4)} for i in part[np.argsort(-sims[part])]]
    r = _NBR[c]
    return r if r is None else r[:k]

def _score_input_manifest(
    txt,
    good,
    dur_s,
    score,
    replay_meta,
    creator_profile=None,
    source_mode=None,
):
    input_state = replay_meta.get('input_state') or {}
    embedding_state = input_state.get('embedding_input') or {}
    input_manifest = {
        'domain': 'shorts_raw',
        'scorer': 'raw_upload.py',
        'embedding_model': EMBEDDING_MODEL,
        'embedding_dimensions': DIM,
        'display_contract_version': DISPLAY_CONTRACT_VERSION,
        'feature_contract_identity_schema_version':
            FEATURE_CONTRACT_IDENTITY_SCHEMA_VERSION,
        'feature_contract_sha256': FEATURE_CONTRACT_SHA256,
        'feature_contract_document_sha256':
            FEATURE_CONTRACT_DOCUMENT_SHA256,
        'coordinate_governance_version': COORDINATE_GOVERNANCE['schemaVersion'],
        'coordinate_governance_sha256': COORDINATE_GOVERNANCE_SHA256,
        'canonical_output_contract': {
            'canonical_embedding_outputs': len(SHORTS_STORED_COORDINATE_IDS),
            'canonical_coordinate_ids': list(SHORTS_STORED_COORDINATE_IDS),
            'universal_raw_scorer_total': 22,
            'creator_profile_enriched_maximum': 23,
            'steer_coordinates': 18,
            'novelty_coordinates': 3,
            'derived_forecasts_total': 2,
            'frozen_model_forecasts': 1,
            'conditional_creator_forecasts': 1,
            'visual_keep_forecast_coordinate_id': VISUAL_KEEP_COORDINATE_ID,
            'creator_adaptive_keep_forecast_coordinate_id':
                CREATOR_ADAPTIVE_KEEP_COORDINATE_ID,
            'creator_adaptive_availability': 'registered known creator with at least eight strictly earlier labeled uploads; unavailable in anonymous raw scoring',
            'novelty_derivation': 'cached indicator state + revision-pinned indicator registry',
        },
        'steer_artifact_sha256': score.get('steer_artifact_sha256'),
        'steer_artifact_archive_key': score.get('steer_artifact_archive_key'),
        'steer_lineage_manifest_sha256': score.get('steer_lineage_manifest_sha256'),
        'steer_lineage_schema_version': score.get('steer_lineage_schema_version'),
        'source_window': 'first 5 seconds',
        'source_mode': source_mode or 'unknown',
        'canonical_montage': {
            'width': CANONICAL_MONTAGE_WIDTH,
            'height': CANONICAL_MONTAGE_HEIGHT,
            'format': 'JPEG',
            'quality': CANONICAL_MONTAGE_QUALITY,
            'subsampling': '4:2:0',
            'montage_sha256': embedding_state.get('montage_sha256'),
        },
        'display_preference': ['together', 'text', 'visual'],
        'transcript_used': bool(good),
        'duration_s': round(float(dur_s), 3) if dur_s else None,
        'creator_profile': str(creator_profile or '').strip().lower() or None,
        'cache_version': replay_meta.get('cache_version'),
        'cache_key': replay_meta.get('cache_key'),
        'cache_status': replay_meta.get('cache_status'),
        'cache_write_status': replay_meta.get('cache_write_status'),
        'input_fingerprint': replay_meta.get('input_fingerprint'),
        'score_input_fingerprint': replay_meta.get('input_fingerprint'),
        'embedding_input_fingerprint': replay_meta.get(
            'embedding_input_fingerprint'
        ),
        'revision_fingerprint': replay_meta.get('revision_fingerprint'),
        'output_fingerprint': replay_meta.get('output_fingerprint'),
        'scorer_revisions': replay_meta.get('scorer_revisions'),
        'channels': {
            'visual': {
                'present': True,
                'input': '5-frame montage only',
                'image': 'five frames sampled from the first 5 seconds and stitched left to right',
                'text': '',
            },
            'text': {
                'present': bool(good),
                'input': 'first-5-second normalized transcript only',
                'image': '',
                'text': txt if good else '',
            },
            'together': {
                'present': True,
                'input': '5-frame montage plus first-5-second normalized transcript' if good else '5-frame montage only because no coherent voiceover was detected',
                'image': 'five frames sampled from the first 5 seconds and stitched left to right',
                'text': txt if good else '',
            },
        },
    }
    if replay_meta.get('cache_error'):
        input_manifest['cache_error'] = replay_meta['cache_error']
    return input_manifest

def _score_output(
    extra,
    title,
    b64,
    txt,
    good,
    dur_s,
    score,
    replay_meta,
    creator_profile=None,
    source_mode=None,
):
    registry, registry_revision = _indicator_registry_snapshot()
    bundle = materialize_score_bundle(
        score,
        registry,
        registry_revision,
    )
    ledger = bundle['score_ledger']
    if not ledger.get('schema_complete'):
        raise RuntimeError(
            'canonical Shorts score ledger failed structural validation'
        )
    served_score = {
        **score,
        'steer': bundle['addressed_steer'],
        'score_ledger': ledger,
    }
    return {
        **extra,
        'montage': b64,
        'transcript': txt,
        'silent': (not good),
        'dur_s': dur_s,
        'title': title,
        'indicators': served_score.get('indicators') or {},
        'steer': served_score.get('steer') or {},
        'features': bundle['features'],
        'score_ledger': ledger,
        'novelty_provenance': bundle['novelty_provenance'],
        'visual_keep_forecast': score.get('visual_keep_forecast') or None,
        'creator_adaptive_keep_forecast': (
            score.get('creator_adaptive_keep_forecast') or None
        ),
        'creator_adaptive_keep_forecast_error': score.get(
            'creator_adaptive_keep_forecast_error'
        ),
        'emb_preview': score.get('emb_preview') or {},
        'input_manifest': _score_input_manifest(
            txt,
            good,
            dur_s,
            served_score,
            replay_meta,
            creator_profile,
            source_mode,
        ),
        'channels': score.get('channels') or {},
    }

def _run():
    global _PINNED_ARTIFACT_REVISIONS
    global _VISUAL_KEEP_MODEL_CACHE
    global _CREATOR_ADAPTIVE_KEEP_STATE_CACHE
    _PINNED_ARTIFACT_REVISIONS = {}
    _VISUAL_KEEP_MODEL_CACHE = None
    _CREATOR_ADAPTIVE_KEEP_STATE_CACHE = None
    _NBR.clear()
    args = {}
    a = sys.argv[1:]
    for i in range(0, len(a) - 1, 2):
        if a[i].startswith('--'): args[a[i][2:]] = a[i + 1]
    # --image: a montage image is provided directly (built from photos in the browser)
    # with explicit --text; no ffmpeg/transcription needed. Otherwise --file is a video.
    dur_s = None                                           # full-video duration → predict-scope realistic views
    try:                                                   # the client may send the REAL full length (it trims the upload to 6s)
        if args.get('duration'): dur_s = float(args['duration'])
    except Exception: dur_s = None
    creator_profile = str(args.get('creator-profile') or '').strip().lower() or None
    extra = {}
    source_mode = 'youtube' if args.get('youtube') else 'five-frame-montage' if args.get('image') else 'device-upload'
    if args.get('youtube'):
        # ⬇ score straight from a YouTube link: download the short (lowest useful quality),
        # then run the EXACT same 5-frame + first-5s-transcript pipeline as a manual upload.
        m = re.search(r'(?:v=|youtu\.be/|/shorts/|/live/)([\w-]{11})', args['youtube']) or re.search(r'^([\w-]{11})$', args['youtube'].strip())
        if not m:
            print(json.dumps({'error': 'could not find a YouTube video id in that link'})); return
        vid = m.group(1)
        try:
            import yt_dlp
        except Exception:
            print(json.dumps({'error': 'yt-dlp is not installed on this server yet — redeploy to pick it up'})); return
        ytmp = tempfile.mkdtemp(prefix='rawyt_')
        try:
            info, path, acquisition = download_youtube_hook(vid, ytmp)
            if dur_s is None:
                try: dur_s = float(info.get('duration') or 0) or None
                except Exception: dur_s = None
            if not args.get('title'):
                args['title'] = str(info.get('title') or vid)[:80]
            extra = {'videoId': vid, 'sourceUrl': f'https://www.youtube.com/watch?v={vid}',
                     'sourceTitle': str(info.get('title') or '')[:120], 'sourceViews': info.get('view_count'),
                     'sourceChannel': str(info.get('channel') or info.get('uploader') or '')[:80],
                     'sourcePublished': info.get('upload_date') or info.get('timestamp'),
                     'sourceSubscribers': info.get('channel_follower_count'),
                     'sourceAcquisition': acquisition}
            inp = hook_inputs(path)
            if not inp:
                print(json.dumps({'error': 'downloaded but could not extract frames (ffmpeg decode failed)'})); return
            b64, txt, good = inp
        except Exception as e:
            msg = str(e)[:200]
            print(json.dumps({'error': 'YouTube download failed: ' + msg})); return
        finally:
            shutil.rmtree(ytmp, ignore_errors=True)
    elif args.get('image'):
        img = args['image']
        if not os.path.exists(img):
            print(json.dumps({'error': 'no image'})); return
        b64 = base64.b64encode(open(img, 'rb').read()).decode()
        txt = (args.get('text') or '').strip()
        good = bool(txt)                                   # user-set text is used verbatim
    else:
        path = args.get('file')
        if not path or not os.path.exists(path):
            print(json.dumps({'error': 'no file'})); return
        inp = hook_inputs(path)
        if not inp:
            print(json.dumps({'error': 'could not read this video — ffmpeg failed to decode it even after transcoding'})); return
        b64, txt, good = inp
        if dur_s is None:                                  # only ffprobe if the client didn't send the real duration (else we'd read the 6s clip)
            try:
                r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                                   capture_output=True, text=True, timeout=20)
                dur_s = float(r.stdout.strip()) if r.stdout.strip() else None
            except Exception: dur_s = None
    b64 = canonicalize_montage_b64(b64)
    txt = normalize_transcript(txt)
    good = bool(good and txt)
    replay = _score_replay_prepare(
        b64,
        txt,
        good,
        dur_s,
        creator_profile,
    )
    _PINNED_ARTIFACT_REVISIONS = dict(
        ((replay.get('meta') or {}).get('scorer_revisions') or {}).get(
            'artifacts'
        ) or {}
    )
    if replay.get('score') is not None:
        print(json.dumps(_score_output(
            extra, args.get('title', 'My hook'), b64, txt, good, dur_s,
            replay['score'], replay['meta'], creator_profile, source_mode)))
        return

    ev = embed([img_part(b64)])
    et = embed([{'text': txt}]) if good else None
    eg = embed([img_part(b64)] + ([{'text': txt}] if good else []))
    warm_all()   # every neighbor artifact is pinned to the revision in this score identity
    # score the hook on every validated indicator (project its embedding onto the
    # registry's probe weights; + per-modality global novelty from the neighbours).
    indicators = {}
    try:
        wb = r2_get('raw/indicators/weights.npz')
        embmap = {'visual': ev, 'text': et, 'together': eg}
        if wb:
            W = np.load(io.BytesIO(wb), allow_pickle=True)
            for key in W.files:                         # content_{mod}__{target}
                mod = key.split('content_')[-1].split('__')[0]; e = embmap.get(mod)
                if e is None: continue
                en = e / (np.linalg.norm(e) + 1e-9); w = W[key]
                indicators[key] = round(float(en @ w[:-1] + w[-1]), 4)
        skof = {'visual': 'vis', 'text': 'txt', 'together': 'tog'}
        for mod, e in embmap.items():                   # global novelty = mean cos-dist to nearest hooks
            if e is None: continue
            nb = neighbors(mod, e, k=13)
            if nb: indicators[f'nov_{skof[mod]}_global'] = round(float(np.mean([1 - x['sim'] for x in nb])), 4)
        # niche / temporal / combinatorial novelty via the saved corpus models
        mb = r2_get('raw/novelty_models.npz')
        if mb:
            M = np.load(io.BytesIO(mb), allow_pickle=True)
            nrm = {'vis': ev, 'txt': et, 'tog': eg}
            for sk, e in nrm.items():
                if e is None: continue
                en = np.asarray(e, float); en = en / (np.linalg.norm(en) + 1e-9)
                cen = M[f'{sk}_centroids']; indicators[f'nov_{sk}_niche'] = round(float(1 - np.max(cen @ en)), 4)
                rc = M[f'{sk}_recent']; indicators[f'nov_{sk}_temporal'] = round(float(1 - en @ rc), 4)
                comp = M[f'{sk}_pca_comp']; mu = M[f'{sk}_pca_mean']; recon = mu + (en - mu) @ comp.T @ comp
                indicators[f'nov_{sk}_combinatorial'] = round(float(np.linalg.norm(en - recon) / (np.linalg.norm(en) + 1e-9)), 4)
            if ev is not None and et is not None:
                vn = np.asarray(ev, float); vn /= (np.linalg.norm(vn) + 1e-9); tn = np.asarray(et, float); tn /= (np.linalg.norm(tn) + 1e-9)
                indicators['nov_coherence'] = round(float(vn @ tn), 4)
                if eg is not None:
                    gn = np.asarray(eg, float); gn /= (np.linalg.norm(gn) + 1e-9); mix = (vn + tn); mix /= (np.linalg.norm(mix) + 1e-9)
                    indicators['nov_fusion_combinatorial'] = round(float(1 - gn @ mix), 4)
    except ScoreArtifactIntegrityError:
        raise
    except Exception:
        pass
    # STEERED estimate — the ONE global number. Project the upload onto the same linear
    # direction the 11k map uses for each (channel × metric), then map it exactly the way
    # the map does: keep/ret5 quantile-map onto your 211's actual outcomes; views/outlier
    # quantile-map onto the corpus distribution; >10M = local >10M rate around the hook's
    # rank. Whatever the graph shows for a video, an upload gets the identical maths.
    steer = {}
    steer_artifact_sha256 = None
    steer_artifact_archive_key = None
    steer_lineage_manifest_sha256 = None
    steer_lineage_schema_version = None
    try:
        sb = r2_get('raw/steer_models.npz')
        if sb:
            steer_artifact_sha256 = hashlib.sha256(sb).hexdigest()
            SM = np.load(io.BytesIO(sb), allow_pickle=True); keys = set(SM.files)
            if 'LINEAGE_JSON' in keys:
                steer_artifact_archive_key = f'raw/steer_models/by-sha256/{steer_artifact_sha256}.npz'
                lineage_text = str(np.asarray(SM['LINEAGE_JSON']).reshape(-1)[0])
                lineage_bytes = lineage_text.encode()
                steer_lineage_manifest_sha256 = hashlib.sha256(lineage_bytes).hexdigest()
                recorded_lineage_sha = (
                    str(np.asarray(SM['LINEAGE_SHA256']).reshape(-1)[0])
                    if 'LINEAGE_SHA256' in keys else None
                )
                if recorded_lineage_sha and recorded_lineage_sha != steer_lineage_manifest_sha256:
                    raise ScoreArtifactIntegrityError('steer lineage manifest hash mismatch')
                steer_lineage_schema_version = json.loads(lineage_text).get('schemaVersion')
            for mod, e in {'visual': ev, 'text': et, 'together': eg}.items():
                if e is None: continue
                en = np.asarray(e, float); en = en / (np.linalg.norm(en) + 1e-9)
                for tgt in ('keep', 'ret5', 'views', 'outlier', 'gt10M'):
                    ck = f'{mod}_{tgt}_coef'
                    if ck not in keys: continue
                    pred = float(en @ SM[ck] + SM[f'{mod}_{tgt}_int'])
                    psort = SM[f'{mod}_{tgt}_psort']
                    rank = float(np.searchsorted(psort, pred)) / max(1, len(psort) - 1)
                    rank = min(1.0, max(0.0, rank))
                    kind = str(SM[f'{mod}_{tgt}_kind']) if f'{mod}_{tgt}_kind' in keys else 'pct'
                    if kind == 'binary':                                    # >10M class: local rate in a ±5% rank window
                        yb = SM[f'{mod}_{tgt}_ybypred']; n = len(yb); c = int(round(rank * (n - 1))); w = max(1, n // 20)
                        est = float(yb[max(0, c - w):min(n, c + w)].mean())
                    else:
                        ysort = SM[f'{mod}_{tgt}_ysort']; yv = float(ysort[int(round(rank * (len(ysort) - 1)))])
                        est = float(max(0.0, 10 ** yv - 1)) if kind in ('logcount', 'logx') else yv
                    steer[f'{mod}_{tgt}'] = {
                        'coordinate_id': COORDINATE_GOVERNANCE[
                            'coordinates'
                        ]['storedPattern'].replace(
                            '{featureKey}',
                            f'{mod}.{tgt}',
                        ),
                        'feature_key': f'{mod}.{tgt}',
                        'group': mod,
                        'target': tgt,
                        'est': round(est, 4) if est < 100 else round(est),
                        'pctile': round(rank * 100, 1),
                        'kind': kind,
                    }
            # REALISTIC VIEWS (predict-scope): feed the steered keep/ret5 ests + this video's real
            # duration through the 211's retention→views model → views on Tyler's channel scale.
            if 'PSCOPE' in keys:
                # video upload → its real (ffprobed) duration; 5-frame build → no duration, so
                # assume a generic 30s short. keep + ret5 + log_dur all feed the predict-scope.
                have_dur = bool(dur_s and dur_s > 0)
                dv = dur_s if have_dur else 30.0
                PS = SM['PSCOPE']; ld = float(np.log10(dv + 1))
                for mod in ('visual', 'text', 'together'):
                    kk = steer.get(f'{mod}_keep'); rr = steer.get(f'{mod}_ret5')
                    if kk and rr:
                        rv = float(max(0.0, 10 ** (PS[0] * kk['est'] + PS[1] * rr['est'] + PS[2] * ld + PS[3]) - 1))
                        steer[f'{mod}_realviews'] = {
                            'coordinate_id': COORDINATE_GOVERNANCE[
                                'coordinates'
                            ]['storedPattern'].replace(
                                '{featureKey}',
                                f'{mod}.realviews',
                            ),
                            'feature_key': f'{mod}.realviews',
                            'group': mod,
                            'target': 'realviews',
                            'est': round(rv),
                            'pctile': None,
                            'kind': 'realviews',
                            'dur_s': round(dv),
                            'dur_assumed': not have_dur,
                        }
    except ScoreArtifactIntegrityError:
        raise
    except Exception:
        pass
    def preview(e):
        if e is None: return None
        a = np.asarray(e, float)
        return [round(float(x), 3) for x in (a[:1536].reshape(48, 32).mean(1) if len(a) >= 1536 else a)]
    visual_keep = visual_keep_forecast(ev)
    creator_keep = None
    creator_keep_error = None
    if creator_profile:
        try:
            creator_keep = creator_adaptive_keep_forecast(
                ev,
                eg,
                creator_profile,
            )
        except Exception as error:
            creator_keep_error = str(error)[:500]
    score = {
        'indicators': indicators,
        'steer': steer,
        'visual_keep_forecast': visual_keep,
        'creator_adaptive_keep_forecast': creator_keep,
        'creator_adaptive_keep_forecast_error': creator_keep_error,
        'emb_preview': {'visual': preview(ev), 'text': preview(et), 'together': preview(eg)},
        'steer_artifact_sha256': steer_artifact_sha256,
        'steer_artifact_archive_key': steer_artifact_archive_key,
        'steer_lineage_manifest_sha256': steer_lineage_manifest_sha256,
        'steer_lineage_schema_version': steer_lineage_schema_version,
        'channels': {
            'visual': {'neighbors': neighbors('visual', ev)} if ev is not None else None,
            'text': ({'neighbors': neighbors('text', et)} if (good and et is not None) else None),
            'together': {'neighbors': neighbors('together', eg)} if eg is not None else None,
        },
    }
    replay_meta = _score_replay_store(
        replay,
        score,
        creator_profile,
        good,
    )
    print(json.dumps(_score_output(
        extra, args.get('title', 'My hook'), b64, txt, good, dur_s,
        score, replay_meta, creator_profile, source_mode)))

def main():
    if '--contract' in sys.argv:
        print(json.dumps(_scorer_contract()))
        return
    if '--prewarm' in sys.argv:   # server boot: fill the neighbour caches before anyone uploads
        try: warm_all()
        except Exception as e: print(f'[prewarm] failed: {e}', file=sys.stderr, flush=True)
        return
    try:
        _run()
    except Exception as e:
        import traceback
        print(json.dumps({'error': 'processing failed: ' + str(e)[:200], 'trace': traceback.format_exc()[-500:]}))

if __name__ == '__main__':
    main()
