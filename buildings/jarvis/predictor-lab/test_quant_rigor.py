#!/usr/bin/env python3
"""Focused leakage, units, missingness, and metric-contract tests."""

from __future__ import annotations

import importlib.util
import hashlib
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "run_predictor_lab",
    HERE / "run_predictor_lab.py",
)
assert SPEC and SPEC.loader
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)


class DummyAxis:
    def __init__(self, value: float) -> None:
        self.value = value

    def predict(self, vectors: np.ndarray) -> np.ndarray:
        return np.full(len(vectors), self.value, dtype=float)

    def ranks(self, vectors: np.ndarray) -> np.ndarray:
        return np.full(len(vectors), 0.5, dtype=float)

    def predict_proba(self, vectors: np.ndarray) -> np.ndarray:
        probability = np.full(len(vectors), self.value, dtype=float)
        return np.column_stack([1 - probability, probability])


def fixture() -> tuple[
    list[dict[str, object]],
    dict[str, dict[str, object]],
    dict[str, dict[str, object]],
]:
    rng = np.random.default_rng(20260730)
    rows = [
        {
            "id": f"video-{index}",
            "account": "only-account",
            "accountName": "Only account",
            "title": f"opening number {index}",
            "keep": 45.0 + index * 2.0,
            "ret5": 80.0 + index,
            "duration": 20.0 + index,
            "contentFamilyId": f"declared:family-{index}",
        }
        for index in range(20)
    ]
    vectors = LAB.normalized(rng.normal(size=(len(rows), 8)))
    stores = {}
    public_axes = {}
    for modality in LAB.MODALITIES:
        stores[modality] = {
            "ids": [str(row["id"]) for row in rows],
            "index": {
                str(row["id"]): index
                for index, row in enumerate(rows)
            },
            "vectors": vectors.copy(),
        }
        public_axes[modality] = {
            "views": DummyAxis(5.5),
            "outlier": DummyAxis(0.75),
            "hit10m": DummyAxis(0.25),
            "novelty_temporal": np.linspace(0, 1, len(rows)),
            "novelty_niche": np.linspace(1, 0, len(rows)),
            "novelty_combinatorial": np.full(len(rows), 0.5),
        }
    return rows, stores, public_axes


def main() -> None:
    rows, stores, public_axes = fixture()
    first = LAB.private_inner_oof(rows, stores, public_axes)
    changed = [dict(row) for row in rows]
    changed[0]["keep"] = 99.0
    changed[0]["ret5"] = 199.0
    second = LAB.private_inner_oof(changed, stores, public_axes)
    assert np.isfinite(first[0, 0])
    assert first[0, 0] == second[0, 0], (
        "a row's own keep label changed its held-out keep feature"
    )
    assert first[0, 2] == second[0, 2], (
        "a row's own ret5 label changed its held-out ret5 feature"
    )

    small = LAB.private_crossfit_raw_features(
        rows[:6],
        stores,
        public_axes,
    )
    for offset in (0, 6, 12):
        assert np.isnan(small[:, offset]).all()
        assert np.isnan(small[:, offset + 1]).all()
        assert np.isnan(small[:, offset + 3]).all()
        assert np.isfinite(small[:, offset + 2]).all()
        assert np.isfinite(small[:, offset + 4]).all()
        assert np.isfinite(small[:, offset + 5]).all()

    metrics = LAB.regression_metrics(
        np.asarray([0.0, 10.0, 20.0]),
        np.asarray([0.0, np.nan, 20.0]),
    )
    assert metrics["n"] == 2
    assert metrics["total"] == 3
    assert metrics["missingPairsExcluded"] == 1
    assert metrics["r2"] == 1.0

    view_metrics = LAB.log_view_metrics(
        np.asarray([5.0, np.nan, 7.0]),
        np.asarray([5.1, 6.0, 6.9]),
    )
    assert view_metrics["n"] == 2
    assert view_metrics["total"] == 3
    assert view_metrics["missingPairsExcluded"] == 1
    assert np.isfinite(view_metrics["medianFactorError"])
    assert np.isfinite(view_metrics["geometricMeanFactorError"])

    LAB.validate_private_outcome_units("valid", 75.0, 113.0)
    try:
        LAB.validate_private_outcome_units("invalid-keep", 101.0, 90.0)
    except RuntimeError:
        pass
    else:
        raise AssertionError("keep above 100 did not fail unit validation")
    try:
        LAB.validate_private_outcome_units("invalid-ret5", 75.0, -1.0)
    except RuntimeError:
        pass
    else:
        raise AssertionError("negative ret5 did not fail unit validation")

    original_sources = dict(LAB.READ_PROVENANCE)
    original_snapshots = list(LAB.IMMUTABLE_SOURCE_SNAPSHOTS)
    original_s3 = LAB.S3
    try:
        class Body:
            def __init__(self, payload: bytes) -> None:
                self.payload = payload

            def read(self) -> bytes:
                return self.payload

        class SnapshotStore:
            def __init__(self) -> None:
                self.objects = {
                    "longform/db.json":
                        b'{"videos":{"a":{"views":12}}}',
                }

            def get_object(self, *, Bucket: str, Key: str) -> dict:
                if Key not in self.objects:
                    raise KeyError(Key)
                return {
                    "Body": Body(self.objects[Key]),
                    "ETag": '"source-etag"',
                    "VersionId": None,
                    "LastModified": None,
                }

            def put_object(
                self,
                *,
                Bucket: str,
                Key: str,
                Body: bytes,
                **_kwargs: object,
            ) -> dict:
                if Key in self.objects:
                    raise RuntimeError("precondition failed")
                self.objects[Key] = bytes(Body)
                return {"ETag": '"snapshot-etag"'}

            def copy_object(
                self,
                *,
                Bucket: str,
                Key: str,
                CopySource: dict,
                CopySourceIfMatch: str,
                IfNoneMatch: str,
                **_kwargs: object,
            ) -> dict:
                assert CopySourceIfMatch == '"source-etag"'
                assert IfNoneMatch == "*"
                if Key in self.objects:
                    raise RuntimeError("precondition failed")
                source_key = CopySource["Key"]
                self.objects[Key] = bytes(self.objects[source_key])
                return {"CopyObjectResult": {"ETag": '"snapshot-etag"'}}

        snapshot_store = SnapshotStore()
        LAB.S3 = snapshot_store
        LAB.READ_PROVENANCE.clear()
        LAB.IMMUTABLE_SOURCE_SNAPSHOTS.clear()
        frozen = LAB.immutable_r2_json_snapshot(
            "longform/db.json",
            "raw/predictor/source/by-sha256",
        )
        assert frozen["videos"]["a"]["views"] == 12
        assert len(LAB.IMMUTABLE_SOURCE_SNAPSHOTS) == 1
        snapshot_descriptor = LAB.IMMUTABLE_SOURCE_SNAPSHOTS[0]
        assert snapshot_descriptor["readAfterWriteVerified"] is True
        assert (
            snapshot_descriptor["creationMethod"]
            == "conditional_server_copy"
        )
        assert snapshot_descriptor["snapshotKey"].endswith(
            f"/{snapshot_descriptor['sourceSha256']}.json"
        )
        assert (
            f"r2:{snapshot_descriptor['snapshotKey']}"
            in LAB.READ_PROVENANCE
        )
        assert "r2:longform/db.json" not in LAB.READ_PROVENANCE
        binary_source_key = "raw/visual/embeddings.npz"
        binary_payload = b"stable-npz-source-bytes"
        snapshot_store.objects[binary_source_key] = binary_payload
        frozen_binary = LAB.r2_bytes(binary_source_key)
        assert frozen_binary == binary_payload
        assert len(LAB.IMMUTABLE_SOURCE_SNAPSHOTS) == 2
        binary_descriptor = LAB.IMMUTABLE_SOURCE_SNAPSHOTS[1]
        assert binary_descriptor["sourceKey"] == binary_source_key
        assert binary_descriptor["snapshotKey"].endswith(
            f"/{binary_descriptor['sourceSha256']}.npz"
        )
        assert (
            f"r2:{binary_descriptor['snapshotKey']}"
            in LAB.READ_PROVENANCE
        )
        assert f"r2:{binary_source_key}" not in LAB.READ_PROVENANCE
        assert LAB.r2_bytes("raw/missing/embeddings.npz") is None
        snapshot_store.objects["longform/db.json"] = (
            b'{"videos":{"a":{"views":999}}}'
        )
        snapshot_store.objects[binary_source_key] = (
            b"changed-live-npz-source"
        )
        immutable_verification = (
            LAB.verify_read_snapshot_unchanged()
        )
        assert immutable_verification["verified"] is True

        snapshot_payloads = {
            "stable.json": b'{"stable":true}',
        }
        local_payloads = {
            "stable-local.py": b"print('stable')\n",
        }
        stable_payload = snapshot_payloads["stable.json"]
        LAB.READ_PROVENANCE.clear()
        LAB.READ_PROVENANCE["r2:stable.json"] = {
            "sha256": hashlib.sha256(stable_payload).hexdigest(),
            "bytes": len(stable_payload),
        }
        stable_local_payload = local_payloads["stable-local.py"]
        LAB.READ_PROVENANCE["local:stable-local.py"] = {
            "sha256": hashlib.sha256(
                stable_local_payload
            ).hexdigest(),
            "bytes": len(stable_local_payload),
        }
        snapshot = LAB.verify_read_snapshot_unchanged(
            snapshot_payloads.__getitem__,
            local_payloads.__getitem__,
        )
        assert snapshot["verified"] is True
        assert snapshot["artifactCount"] == 2
        assert snapshot["r2ArtifactCount"] == 1
        assert snapshot["localArtifactCount"] == 1
        local_snapshot = LAB.verify_local_sources_unchanged(
            local_payloads.__getitem__
        )
        assert local_snapshot["verified"] is True
        assert local_snapshot["artifactCount"] == 1
        try:
            LAB.verify_read_snapshot_unchanged(
                lambda _key: b'{"stable":false}',
                local_payloads.__getitem__,
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError(
                "changed R2 source did not invalidate the fitted snapshot"
            )
        try:
            LAB.verify_read_snapshot_unchanged(
                lambda _key: (_ for _ in ()).throw(KeyError("missing")),
                local_payloads.__getitem__,
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError(
                "missing R2 source did not invalidate the fitted snapshot"
            )
        try:
            LAB.verify_read_snapshot_unchanged(
                snapshot_payloads.__getitem__,
                lambda _key: b"print('changed')\n",
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError(
                "changed local source did not invalidate the fitted snapshot"
            )
        try:
            LAB.verify_local_sources_unchanged(
                lambda _key: b"print('changed')\n"
            )
        except RuntimeError:
            pass
        else:
            raise AssertionError(
                "changed local source did not block publication"
            )
    finally:
        LAB.S3 = original_s3
        LAB.READ_PROVENANCE.clear()
        LAB.READ_PROVENANCE.update(original_sources)
        LAB.IMMUTABLE_SOURCE_SNAPSHOTS.clear()
        LAB.IMMUTABLE_SOURCE_SNAPSHOTS.extend(
            original_snapshots
        )

    print({
        "passed": True,
        "checks": 44,
    })


if __name__ == "__main__":
    main()
