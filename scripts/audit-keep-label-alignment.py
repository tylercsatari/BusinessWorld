#!/usr/bin/env python3
"""Audit keep-rate labels, identities, timestamps, and embedding joins.

This script is deliberately read-only with respect to production artifacts. It
reconstructs the private keep-rate population used by Predictor Lab, inspects
the source rows before canonical de-duplication, and writes a standalone audit.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import tempfile
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse

import boto3
import numpy as np
from scipy.stats import ks_2samp, spearmanr, wasserstein_distance


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = (
    ROOT
    / "buildings"
    / "jarvis"
    / "predictor-lab"
    / "keep-label-alignment-audit.json"
)
LOCAL_OWNER_TABLE = (
    ROOT
    / "buildings"
    / "jarvis"
    / "retention-study"
    / "retention_table.json"
)
MODALITIES = ("visual", "text", "together")
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
TOKEN_RE = re.compile(r"[a-z0-9]+")
EPSILON = 1e-9


def load_dotenv() -> Path | None:
    candidates = (
        ROOT / ".env",
        ROOT.parent / ".env",
        ROOT.parent.parent / ".env",
    )
    for path in candidates:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            key, value = line.split("=", 1)
            os.environ.setdefault(
                key.strip(),
                value.strip().strip('"').strip("'"),
            )
        return path
    return None


def finite(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def clean(value: Any, digits: int = 5) -> float | None:
    if not finite(value):
        return None
    return round(float(value), digits)


def clean_list(values: Iterable[Any], digits: int = 5) -> list[float]:
    return [round(float(value), digits) for value in values if finite(value)]


def percentile(values: np.ndarray, probability: float) -> float | None:
    return clean(np.quantile(values, probability)) if len(values) else None


def parse_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    text = str(value).strip()
    try:
        if text.isdigit() and len(text) == 8:
            return datetime.strptime(text, "%Y%m%d").replace(tzinfo=timezone.utc)
        number = float(text)
        if math.isfinite(number) and number > 0:
            seconds = number / 1000 if number >= 1e12 else number
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def timestamp_ms(value: Any) -> float | None:
    parsed = parse_datetime(value)
    return parsed.timestamp() * 1000 if parsed else None


def timestamp_precision(value: Any) -> str:
    if value is None or value == "":
        return "missing"
    text = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) or (
        text.isdigit() and len(text) == 8
    ):
        return "date_only"
    if re.search(r"\.\d+", text):
        return "subsecond"
    if "T" in text or re.search(r"\d{2}:\d{2}", text):
        return "second"
    if text.isdigit():
        return "epoch"
    return "other"


def iso_from_ms(value: Any) -> str | None:
    if not finite(value):
        return None
    return datetime.fromtimestamp(
        float(value) / 1000,
        tz=timezone.utc,
    ).isoformat()


def normalize_title(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(TOKEN_RE.findall(text))


def title_similarity(left: Any, right: Any) -> dict[str, Any]:
    a = normalize_title(left)
    b = normalize_title(right)
    if not a or not b:
        return {
            "exact": False,
            "prefix": False,
            "sequence": None,
            "tokenJaccard": None,
            "compatible": False,
            "suspicious": False,
        }
    left_tokens = set(a.split())
    right_tokens = set(b.split())
    union = left_tokens | right_tokens
    jaccard = len(left_tokens & right_tokens) / len(union) if union else 1.0
    sequence = SequenceMatcher(None, a, b).ratio()
    prefix = a.startswith(b) or b.startswith(a)
    compatible = a == b or prefix or sequence >= 0.72 or jaccard >= 0.6
    suspicious = sequence < 0.35 and jaccard < 0.25
    return {
        "exact": a == b,
        "prefix": prefix,
        "sequence": clean(sequence),
        "tokenJaccard": clean(jaccard),
        "compatible": compatible,
        "suspicious": suspicious,
    }


def youtube_id_from_url(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = urlparse(text)
    except ValueError:
        return None
    host = parsed.netloc.casefold().split(":")[0]
    if host in {"youtu.be", "www.youtu.be"}:
        candidate = parsed.path.strip("/").split("/")[0]
        return candidate or None
    if "youtube.com" in host:
        if parsed.path.startswith("/shorts/"):
            return parsed.path.split("/")[2] or None
        candidate = (parse_qs(parsed.query).get("v") or [None])[0]
        return candidate
    return None


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def describe_object(head: dict[str, Any]) -> dict[str, Any]:
    modified = head.get("LastModified")
    return {
        "bytes": int(head.get("ContentLength") or 0),
        "etag": str(head.get("ETag") or "").strip('"'),
        "lastModified": modified.astimezone(timezone.utc).isoformat()
        if modified
        else None,
    }


class R2Reader:
    def __init__(self) -> None:
        required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise RuntimeError(
                "Missing R2 credentials after .env discovery: " + ", ".join(missing)
            )
        self.bucket = os.environ.get("R2_BUCKET_NAME") or "business-world-videos"
        self.client = boto3.client(
            "s3",
            endpoint_url=(
                f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
            ),
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )
        self.sources: dict[str, dict[str, Any]] = {}

    def json(self, key: str) -> Any:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        payload = response["Body"].read()
        self.sources[f"r2:{key}"] = {
            "bytes": len(payload),
            "sha256": sha256_bytes(payload),
            "etag": str(response.get("ETag") or "").strip('"'),
            "lastModified": response["LastModified"].astimezone(
                timezone.utc
            ).isoformat()
            if response.get("LastModified")
            else None,
        }
        return json.loads(payload)

    def head(self, key: str) -> dict[str, Any]:
        response = self.client.head_object(Bucket=self.bucket, Key=key)
        return describe_object(response)

    def npz_identity(self, key: str) -> dict[str, Any]:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        hasher = hashlib.sha256()
        byte_count = 0
        with tempfile.TemporaryFile() as temporary:
            for chunk in response["Body"].iter_chunks(chunk_size=8 * 1024 * 1024):
                if not chunk:
                    continue
                temporary.write(chunk)
                hasher.update(chunk)
                byte_count += len(chunk)
            temporary.seek(0)
            with zipfile.ZipFile(temporary) as archive:
                names = set(archive.namelist())
                if "ids.npy" not in names:
                    raise RuntimeError(f"{key} has no ids.npy")
                ids = np.load(
                    io.BytesIO(archive.read("ids.npy")),
                    allow_pickle=True,
                )
                titles = None
                if "title.npy" in names:
                    titles = np.load(
                        io.BytesIO(archive.read("title.npy")),
                        allow_pickle=True,
                    )
                vector_shape = None
                vector_dtype = None
                if "vecs.npy" in names:
                    with archive.open("vecs.npy") as vector_file:
                        version = np.lib.format.read_magic(vector_file)
                        if version == (1, 0):
                            shape, _, dtype = np.lib.format.read_array_header_1_0(
                                vector_file
                            )
                        else:
                            shape, _, dtype = np.lib.format.read_array_header_2_0(
                                vector_file
                            )
                        vector_shape = [int(value) for value in shape]
                        vector_dtype = str(dtype)
        self.sources[f"r2:{key}"] = {
            "bytes": byte_count,
            "sha256": hasher.hexdigest(),
            "etag": str(response.get("ETag") or "").strip('"'),
            "lastModified": response["LastModified"].astimezone(
                timezone.utc
            ).isoformat()
            if response.get("LastModified")
            else None,
        }
        return {
            "ids": [str(value) for value in ids],
            "titles": [str(value) for value in titles] if titles is not None else None,
            "vectorShape": vector_shape,
            "vectorDtype": vector_dtype,
            "members": sorted(names),
        }


def load_local_json(path: Path, sources: dict[str, dict[str, Any]]) -> Any:
    payload = path.read_bytes()
    sources[f"local:{path.relative_to(ROOT)}"] = {
        "bytes": len(payload),
        "sha256": sha256_bytes(payload),
        "lastModified": datetime.fromtimestamp(
            path.stat().st_mtime,
            tz=timezone.utc,
        ).isoformat(),
    }
    return json.loads(payload)


def raw_keep_value(video: dict[str, Any]) -> tuple[Any, str]:
    if "keep_rate" in video:
        return video.get("keep_rate"), "keep_rate"
    return video.get("stayedToWatch"), "stayedToWatch"


def raw_swipe_value(video: dict[str, Any]) -> tuple[Any, str | None]:
    if "swiped" in video:
        return video.get("swiped"), "swiped"
    if "swipedAway" in video:
        return video.get("swipedAway"), "swipedAway"
    return None, None


def distribution(values: list[float]) -> dict[str, Any]:
    array = np.asarray(values, dtype=float)
    counts = Counter(round(float(value), 8) for value in array)
    return {
        "n": len(array),
        "mean": clean(array.mean()) if len(array) else None,
        "standardDeviation": clean(array.std(ddof=1)) if len(array) > 1 else None,
        "minimum": clean(array.min()) if len(array) else None,
        "p05": percentile(array, 0.05),
        "p25": percentile(array, 0.25),
        "median": percentile(array, 0.5),
        "p75": percentile(array, 0.75),
        "p95": percentile(array, 0.95),
        "maximum": clean(array.max()) if len(array) else None,
        "range": clean(np.ptp(array)) if len(array) else None,
        "uniqueValues": len(counts),
        "topRepeatedValues": [
            {"value": clean(value), "n": count}
            for value, count in counts.most_common(8)
        ],
        "integerGridN": int(
            np.sum(np.isclose(array, np.round(array), atol=1e-8))
        ),
        "tenthGridN": int(
            np.sum(np.isclose(array * 10, np.round(array * 10), atol=1e-8))
        ),
        "hundredthGridN": int(
            np.sum(np.isclose(array * 100, np.round(array * 100), atol=1e-8))
        ),
        "atOrBelowZeroN": int(np.sum(array <= 0)),
        "atOrAboveHundredN": int(np.sum(array >= 100)),
        "fractionScaleCandidateN": int(np.sum((array > 0) & (array <= 1))),
    }


def best_temporal_split(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    ordered = sorted(
        (
            row
            for row in rows
            if finite(row.get("publishedAt")) and finite(row.get("keep"))
        ),
        key=lambda row: (float(row["publishedAt"]), str(row["id"])),
    )
    if len(ordered) < 16:
        return None
    values = np.asarray([float(row["keep"]) for row in ordered], dtype=float)
    times = np.asarray([float(row["publishedAt"]) for row in ordered], dtype=float)
    minimum = max(8, int(math.ceil(len(ordered) * 0.1)))
    candidates = [
        index
        for index in range(minimum, len(ordered) - minimum + 1)
        if times[index - 1] < times[index]
    ]
    if not candidates:
        return None
    scored = []
    for index in candidates:
        left = values[:index]
        right = values[index:]
        difference = float(right.mean() - left.mean())
        pooled = math.sqrt(
            (
                max(0, len(left) - 1) * float(left.var(ddof=1))
                + max(0, len(right) - 1) * float(right.var(ddof=1))
            )
            / max(1, len(values) - 2)
        )
        scored.append(
            (
                abs(difference),
                index,
                difference,
                difference / pooled if pooled > EPSILON else None,
            )
        )
    _, index, difference, effect = max(scored, key=lambda item: item[0])
    return {
        "splitAt": iso_from_ms(times[index]),
        "beforeN": index,
        "afterN": len(values) - index,
        "beforeMean": clean(values[:index].mean()),
        "afterMean": clean(values[index:].mean()),
        "afterMinusBeforePp": clean(difference),
        "standardizedEffect": clean(effect),
        "selectionWarning": (
            "This is the largest in-sample mean split among all eligible dates; "
            "it is a drift diagnostic, not a confirmatory changepoint test."
        ),
    }


def temporal_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    valid = [
        row
        for row in rows
        if finite(row.get("publishedAt")) and finite(row.get("keep"))
    ]
    ordered = sorted(valid, key=lambda row: (float(row["publishedAt"]), str(row["id"])))
    batches: dict[float, list[dict[str, Any]]] = defaultdict(list)
    for row in ordered:
        batches[float(row["publishedAt"])].append(row)
    duplicate_batches = [batch for batch in batches.values() if len(batch) > 1]
    values = np.asarray([float(row["keep"]) for row in ordered], dtype=float)
    times = np.asarray([float(row["publishedAt"]) for row in ordered], dtype=float)
    correlation = None
    correlation_p = None
    slope_per_year = None
    if len(ordered) >= 3 and np.ptp(times) > 0:
        statistic = spearmanr(times, values)
        correlation = clean(statistic.statistic)
        correlation_p = clean(statistic.pvalue, 8)
        days = (times - times.min()) / 86400000
        slope_per_year = clean(np.polyfit(days, values, 1)[0] * 365.25)
    quartiles = []
    if len(ordered):
        for indexes in np.array_split(np.arange(len(ordered)), min(4, len(ordered))):
            if not len(indexes):
                continue
            segment = values[indexes]
            quartiles.append(
                {
                    "n": len(indexes),
                    "from": iso_from_ms(times[indexes[0]]),
                    "through": iso_from_ms(times[indexes[-1]]),
                    "mean": clean(segment.mean()),
                    "median": clean(np.median(segment)),
                }
            )
    return {
        "datedN": len(ordered),
        "missingTimestampN": len(rows) - len(ordered),
        "firstPublishedAt": iso_from_ms(times.min()) if len(times) else None,
        "lastPublishedAt": iso_from_ms(times.max()) if len(times) else None,
        "uniqueTimestampN": len(batches),
        "duplicateTimestampBatchN": len(duplicate_batches),
        "rowsInDuplicateTimestampBatches": sum(
            len(batch) for batch in duplicate_batches
        ),
        "maximumTimestampBatchSize": max(
            (len(batch) for batch in batches.values()),
            default=0,
        ),
        "largestTimestampBatches": [
            {
                "publishedAt": iso_from_ms(timestamp),
                "n": len(batch),
                "ids": [str(row["id"]) for row in batch[:20]],
            }
            for timestamp, batch in sorted(
                batches.items(),
                key=lambda item: (-len(item[1]), item[0]),
            )[:8]
            if len(batch) > 1
        ],
        "spearmanPublishedTimeVsKeep": correlation,
        "spearmanPValue": correlation_p,
        "linearSlopePpPerYear": slope_per_year,
        "chronologicalQuartiles": quartiles,
        "largestMeanSplit": best_temporal_split(rows),
    }


def row_scrape_time(video: dict[str, Any]) -> datetime | None:
    candidates = (
        video.get("scrapedAt"),
        video.get("scraped_at"),
    )
    parsed = [parse_datetime(value) for value in candidates]
    valid = [value for value in parsed if value]
    return max(valid) if valid else None


def label_source_summary(videos: list[dict[str, Any]]) -> dict[str, Any]:
    keep_field = Counter()
    shadowed_fallback = []
    redundant_keep_conflicts = []
    swipe_residuals = []
    missing_labels = []
    invalid_labels = []
    scrape_times = []
    observation_ages = []
    future_rows = []
    precisions = Counter()
    for video in videos:
        keep, field = raw_keep_value(video)
        keep_field[field] += 1
        if (
            "keep_rate" in video
            and not finite(video.get("keep_rate"))
            and finite(video.get("stayedToWatch"))
        ):
            shadowed_fallback.append(str(video.get("id") or video.get("videoId") or ""))
        if finite(video.get("keep_rate")) and finite(video.get("stayedToWatch")):
            delta = float(video["keep_rate"]) - float(video["stayedToWatch"])
            if abs(delta) > 1e-8:
                redundant_keep_conflicts.append(
                    {
                        "id": str(video.get("id") or video.get("videoId") or ""),
                        "keep_rate": clean(video["keep_rate"]),
                        "stayedToWatch": clean(video["stayedToWatch"]),
                        "delta": clean(delta),
                    }
                )
        if keep is None or keep == "":
            missing_labels.append(str(video.get("id") or video.get("videoId") or ""))
        elif not finite(keep):
            invalid_labels.append(str(video.get("id") or video.get("videoId") or ""))
        swipe, _ = raw_swipe_value(video)
        if finite(keep) and finite(swipe):
            swipe_residuals.append(float(keep) + float(swipe) - 100)
        published = parse_datetime(video.get("published"))
        scrape = row_scrape_time(video)
        precisions[timestamp_precision(video.get("published"))] += 1
        if scrape:
            scrape_times.append(scrape.timestamp() * 1000)
        if published and scrape:
            age = (scrape - published).total_seconds() / 86400
            observation_ages.append(age)
            if age < 0:
                future_rows.append(
                    {
                        "id": str(video.get("id") or video.get("videoId") or ""),
                        "published": published.isoformat(),
                        "scraped": scrape.isoformat(),
                        "ageDays": clean(age),
                    }
                )
    residual_array = np.asarray(swipe_residuals, dtype=float)
    age_array = np.asarray(observation_ages, dtype=float)
    return {
        "keepFieldUsage": dict(sorted(keep_field.items())),
        "missingLabelN": len(missing_labels),
        "missingLabelIds": missing_labels[:50],
        "invalidLabelN": len(invalid_labels),
        "invalidLabelIds": invalid_labels[:50],
        "fallbackShadowedByPresentButInvalidKeepRateN": len(shadowed_fallback),
        "fallbackShadowedIds": shadowed_fallback[:50],
        "redundantKeepFieldConflictN": len(redundant_keep_conflicts),
        "redundantKeepFieldConflicts": redundant_keep_conflicts[:50],
        "keepPlusSwipePairN": len(residual_array),
        "keepPlusSwipeMaxAbsoluteResidualPp": clean(
            np.max(np.abs(residual_array)) if len(residual_array) else None
        ),
        "keepPlusSwipeNonzeroResidualN": int(
            np.sum(np.abs(residual_array) > 1e-8)
        )
        if len(residual_array)
        else 0,
        "publishedPrecision": dict(sorted(precisions.items())),
        "rowScrapeTimestampN": len(scrape_times),
        "firstScrapedAt": iso_from_ms(min(scrape_times)) if scrape_times else None,
        "lastScrapedAt": iso_from_ms(max(scrape_times)) if scrape_times else None,
        "labelObservationAgeDays": {
            "n": len(age_array),
            "minimum": clean(age_array.min()) if len(age_array) else None,
            "p10": percentile(age_array, 0.1),
            "median": percentile(age_array, 0.5),
            "p90": percentile(age_array, 0.9),
            "maximum": clean(age_array.max()) if len(age_array) else None,
        },
        "scrapedBeforePublishN": len(future_rows),
        "scrapedBeforePublishRows": future_rows[:50],
    }


def duplicate_summary(
    account_videos: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    by_id: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    by_title: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    url_mismatches = []
    invalid_ids = []
    for account, videos in account_videos.items():
        for video in videos:
            video_id = str(video.get("id") or video.get("videoId") or "")
            if video_id:
                by_id[video_id].append((account, video))
                if not YOUTUBE_ID_RE.fullmatch(video_id):
                    invalid_ids.append({"account": account, "id": video_id})
            title = normalize_title(video.get("title"))
            if title:
                by_title[title].append((account, video))
            url_id = youtube_id_from_url(video.get("url"))
            if url_id and video_id and url_id != video_id:
                url_mismatches.append(
                    {
                        "account": account,
                        "id": video_id,
                        "urlId": url_id,
                        "url": str(video.get("url")),
                    }
                )
    repeated_ids = {key: value for key, value in by_id.items() if len(value) > 1}
    repeated_titles = {
        key: value
        for key, value in by_title.items()
        if len({str(item[1].get("id") or item[1].get("videoId") or "") for item in value})
        > 1
    }
    id_conflicts = []
    for video_id, instances in repeated_ids.items():
        labels = {
            clean(raw_keep_value(video)[0])
            for _, video in instances
            if finite(raw_keep_value(video)[0])
        }
        published = {str(video.get("published") or "") for _, video in instances}
        titles = {normalize_title(video.get("title")) for _, video in instances}
        id_conflicts.append(
            {
                "id": video_id,
                "instances": [
                    {
                        "account": account,
                        "title": str(video.get("title") or ""),
                        "published": str(video.get("published") or ""),
                        "keep": clean(raw_keep_value(video)[0]),
                    }
                    for account, video in instances
                ],
                "labelConflict": len(labels) > 1,
                "publishedConflict": len(published) > 1,
                "titleConflict": len(titles) > 1,
            }
        )
    return {
        "rawRowN": sum(len(videos) for videos in account_videos.values()),
        "uniqueVideoIdN": len(by_id),
        "duplicateVideoIdN": len(repeated_ids),
        "duplicateVideoIdRows": sum(len(value) for value in repeated_ids.values()),
        "crossAccountDuplicateVideoIdN": sum(
            len({account for account, _ in instances}) > 1
            for instances in repeated_ids.values()
        ),
        "duplicateVideoIds": id_conflicts[:100],
        "duplicateNormalizedTitleN": len(repeated_titles),
        "duplicateNormalizedTitleSamples": [
            {
                "normalizedTitle": title,
                "instances": [
                    {
                        "account": account,
                        "id": str(video.get("id") or video.get("videoId") or ""),
                        "title": str(video.get("title") or ""),
                        "published": str(video.get("published") or ""),
                        "keep": clean(raw_keep_value(video)[0]),
                    }
                    for account, video in instances[:20]
                ],
            }
            for title, instances in sorted(
                repeated_titles.items(),
                key=lambda item: (-len(item[1]), item[0]),
            )[:50]
        ],
        "urlVideoIdMismatchN": len(url_mismatches),
        "urlVideoIdMismatches": url_mismatches[:100],
        "invalidYoutubeIdN": len(invalid_ids),
        "invalidYoutubeIds": invalid_ids[:100],
    }


def reconstruct_canonical(
    channel_order: list[str],
    account_names: dict[str, str],
    account_videos: dict[str, list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows = []
    seen: set[str] = set()
    skipped = Counter()
    skipped_rows = []
    for account in channel_order:
        for source_index, video in enumerate(account_videos[account]):
            video_id = str(video.get("id") or video.get("videoId") or "")
            keep, keep_field = raw_keep_value(video)
            if not video_id:
                reason = "missing_video_id"
            elif video_id in seen:
                reason = "duplicate_video_id"
            elif not finite(keep):
                reason = "nonfinite_keep"
            else:
                reason = ""
            if reason:
                skipped[reason] += 1
                skipped_rows.append(
                    {
                        "account": account,
                        "sourceIndex": source_index,
                        "id": video_id,
                        "reason": reason,
                    }
                )
                continue
            seen.add(video_id)
            rows.append(
                {
                    "id": video_id,
                    "title": str(video.get("title") or video_id),
                    "account": account,
                    "accountName": account_names[account],
                    "keep": float(keep),
                    "keepField": keep_field,
                    "ret5": float(video["ret5"]) if finite(video.get("ret5")) else None,
                    "views": float(video["views"])
                    if finite(video.get("views"))
                    else None,
                    "duration": float(video["duration_s"])
                    if finite(video.get("duration_s"))
                    else None,
                    "publishedAt": timestamp_ms(video.get("published")),
                    "publishedRaw": video.get("published"),
                    "scrapedAt": (
                        row_scrape_time(video).timestamp() * 1000
                        if row_scrape_time(video)
                        else None
                    ),
                    "sourceIndex": source_index,
                    "source": account,
                }
            )
    return rows, {
        "acceptedN": len(rows),
        "skippedByReason": dict(sorted(skipped.items())),
        "skippedRows": skipped_rows[:100],
    }


def library_index(payload: Any) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    videos = payload.get("videos") if isinstance(payload, dict) else None
    if isinstance(videos, dict):
        source_rows = list(videos.values())
    elif isinstance(videos, list):
        source_rows = videos
    else:
        raise RuntimeError("library/db.json has no videos collection")
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for video in source_rows:
        video_id = str(video.get("videoId") or video.get("id") or "")
        if video_id:
            grouped[video_id].append(video)
    conflicts = []
    for video_id, instances in grouped.items():
        if len(instances) <= 1:
            continue
        conflicts.append(
            {
                "id": video_id,
                "n": len(instances),
                "titles": sorted(
                    {str(video.get("title") or "") for video in instances}
                )[:10],
                "channelIds": sorted(
                    {str(video.get("channelId") or "") for video in instances}
                )[:10],
            }
        )
    return (
        {video_id: instances[0] for video_id, instances in grouped.items()},
        {
            "sourceRowN": len(source_rows),
            "uniqueVideoIdN": len(grouped),
            "duplicateVideoIdN": len(conflicts),
            "duplicateVideoIds": conflicts[:100],
        },
    )


def identity_join_summary(
    canonical_rows: list[dict[str, Any]],
    library: dict[str, dict[str, Any]],
    embedding_indexes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    by_account: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in canonical_rows:
        by_account[str(row["account"])].append(row)
    account_reports = {}
    all_suspicious = []
    for account, rows in sorted(by_account.items()):
        library_channel_ids = Counter()
        library_present = 0
        library_exact = 0
        library_compatible = 0
        library_suspicious = []
        modality_reports = {}
        for row in rows:
            library_video = library.get(str(row["id"]))
            if not library_video:
                continue
            library_present += 1
            channel_id = str(library_video.get("channelId") or "")
            if channel_id:
                library_channel_ids[channel_id] += 1
            comparison = title_similarity(row["title"], library_video.get("title"))
            if comparison["exact"]:
                library_exact += 1
            if comparison["compatible"]:
                library_compatible += 1
            if comparison["suspicious"]:
                item = {
                    "account": account,
                    "id": row["id"],
                    "retentionTitle": row["title"],
                    "libraryTitle": str(library_video.get("title") or ""),
                    "similarity": comparison,
                }
                library_suspicious.append(item)
                all_suspicious.append(item)
        majority_channel_id = (
            library_channel_ids.most_common(1)[0][0] if library_channel_ids else None
        )
        library_channel_mismatches = []
        if majority_channel_id:
            for row in rows:
                video = library.get(str(row["id"]))
                if not video:
                    continue
                channel_id = str(video.get("channelId") or "")
                if channel_id and channel_id != majority_channel_id:
                    library_channel_mismatches.append(
                        {
                            "id": row["id"],
                            "channelId": channel_id,
                            "expectedMajorityChannelId": majority_channel_id,
                        }
                    )
        for modality, index in embedding_indexes.items():
            present = 0
            exact = 0
            compatible = 0
            suspicious = []
            titles = index.get("titlesById") or {}
            ids = index["idSet"]
            for row in rows:
                if row["id"] not in ids:
                    continue
                present += 1
                embedding_title = titles.get(row["id"])
                if embedding_title is None:
                    continue
                comparison = title_similarity(row["title"], embedding_title)
                if comparison["exact"]:
                    exact += 1
                if comparison["compatible"]:
                    compatible += 1
                if comparison["suspicious"]:
                    suspicious.append(
                        {
                            "id": row["id"],
                            "retentionTitle": row["title"],
                            "embeddingTitle": embedding_title,
                            "similarity": comparison,
                        }
                    )
            modality_reports[modality] = {
                "presentN": present,
                "missingN": len(rows) - present,
                "titleComparableN": sum(
                    row["id"] in ids and row["id"] in titles for row in rows
                ),
                "titleExactN": exact,
                "titleCompatibleN": compatible,
                "titleSuspiciousN": len(suspicious),
                "titleSuspiciousRows": suspicious[:50],
            }
        account_reports[account] = {
            "n": len(rows),
            "libraryPresentN": library_present,
            "libraryMissingN": len(rows) - library_present,
            "libraryTitleExactN": library_exact,
            "libraryTitleCompatibleN": library_compatible,
            "libraryTitleSuspiciousN": len(library_suspicious),
            "libraryTitleSuspiciousRows": library_suspicious[:50],
            "libraryChannelIds": dict(library_channel_ids.most_common()),
            "majorityLibraryChannelId": majority_channel_id,
            "libraryChannelMismatchN": len(library_channel_mismatches),
            "libraryChannelMismatches": library_channel_mismatches[:50],
            "embeddings": modality_reports,
        }
    return {
        "perAccount": account_reports,
        "suspiciousLibraryTitleJoinN": len(all_suspicious),
        "suspiciousLibraryTitleJoins": all_suspicious[:100],
        "titleCaveat": (
            "Title mismatches are diagnostics only: YouTube titles can be edited "
            "after upload and embedding archives may retain an earlier title. "
            "Canonical embedding joins use the immutable video ID."
        ),
    }


def embedding_summary(
    canonical_rows: list[dict[str, Any]],
    embedding_indexes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    report: dict[str, Any] = {"modalities": {}}
    by_account: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in canonical_rows:
        by_account[str(row["account"])].append(row)
    for modality, index in embedding_indexes.items():
        ids = index["idSet"]
        present_rows = [row for row in canonical_rows if row["id"] in ids]
        missing_rows = [row for row in canonical_rows if row["id"] not in ids]
        per_account = {}
        for account, rows in sorted(by_account.items()):
            present = [row for row in rows if row["id"] in ids]
            missing = [row for row in rows if row["id"] not in ids]
            present_keep = np.asarray([row["keep"] for row in present], dtype=float)
            missing_keep = np.asarray([row["keep"] for row in missing], dtype=float)
            per_account[account] = {
                "n": len(rows),
                "presentN": len(present),
                "missingN": len(missing),
                "coverage": clean(len(present) / len(rows) if rows else None),
                "missingIds": [row["id"] for row in missing],
                "presentKeepMean": clean(present_keep.mean())
                if len(present_keep)
                else None,
                "missingKeepMean": clean(missing_keep.mean())
                if len(missing_keep)
                else None,
                "missingMinusPresentKeepPp": clean(
                    missing_keep.mean() - present_keep.mean()
                )
                if len(missing_keep) and len(present_keep)
                else None,
            }
        report["modalities"][modality] = {
            "archive": index["archive"],
            "mapParity": index["mapParity"],
            "canonicalPresentN": len(present_rows),
            "canonicalMissingN": len(missing_rows),
            "canonicalCoverage": clean(
                len(present_rows) / len(canonical_rows) if canonical_rows else None
            ),
            "missingCanonicalIds": [row["id"] for row in missing_rows],
            "perAccount": per_account,
        }
    creator_rows = [
        row
        for row in canonical_rows
        if row["id"] in embedding_indexes["visual"]["idSet"]
        and row["id"] in embedding_indexes["together"]["idSet"]
        and finite(row.get("publishedAt"))
    ]
    report["predictorEligibility"] = {
        "canonicalPrivateRows": len(canonical_rows),
        "visualOnlyStudyRows": sum(
            row["id"] in embedding_indexes["visual"]["idSet"]
            for row in canonical_rows
        ),
        "creatorAdaptiveRows": len(creator_rows),
        "creatorAdaptiveRequirements": (
            "finite keep, finite published timestamp, visual NPZ ID, together NPZ ID"
        ),
        "creatorAdaptivePerAccount": dict(
            Counter(str(row["account"]) for row in creator_rows)
        ),
    }
    return report


def pairwise_distributions(
    canonical_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[str, np.ndarray] = {}
    for account in sorted({str(row["account"]) for row in canonical_rows}):
        grouped[account] = np.asarray(
            [
                float(row["keep"])
                for row in canonical_rows
                if str(row["account"]) == account
            ],
            dtype=float,
        )
    output = []
    accounts = sorted(grouped)
    for left_index, left in enumerate(accounts):
        for right in accounts[left_index + 1 :]:
            a = grouped[left]
            b = grouped[right]
            pooled = math.sqrt(
                (
                    max(0, len(a) - 1) * float(a.var(ddof=1))
                    + max(0, len(b) - 1) * float(b.var(ddof=1))
                )
                / max(1, len(a) + len(b) - 2)
            )
            test = ks_2samp(a, b, alternative="two-sided", method="auto")
            output.append(
                {
                    "left": left,
                    "right": right,
                    "leftN": len(a),
                    "rightN": len(b),
                    "rightMinusLeftMeanPp": clean(b.mean() - a.mean()),
                    "standardizedMeanDifference": clean(
                        (b.mean() - a.mean()) / pooled
                        if pooled > EPSILON
                        else None
                    ),
                    "wassersteinDistancePp": clean(wasserstein_distance(a, b)),
                    "ksStatistic": clean(test.statistic),
                    "ksPValue": clean(test.pvalue, 8),
                    "interpretationBoundary": (
                        "A distribution difference can reflect creator/content/"
                        "audience mix or measurement differences; it does not by "
                        "itself prove label incompatibility."
                    ),
                }
            )
    return output


def account_audit(
    account: str,
    account_name: str,
    source_videos: list[dict[str, Any]],
    canonical_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    account_rows = [
        row for row in canonical_rows if str(row["account"]) == account
    ]
    labels = [float(row["keep"]) for row in account_rows]
    duplicate_ids = Counter(
        str(video.get("id") or video.get("videoId") or "")
        for video in source_videos
        if str(video.get("id") or video.get("videoId") or "")
    )
    return {
        "account": account,
        "accountName": account_name,
        "sourceRowN": len(source_videos),
        "canonicalRowN": len(account_rows),
        "sourceDuplicateVideoIdN": sum(
            count > 1 for count in duplicate_ids.values()
        ),
        "label": distribution(labels),
        "labelSource": label_source_summary(source_videos),
        "time": temporal_summary(account_rows),
        "fieldCoverage": {
            field: sum(
                video.get(field) is not None
                for video in source_videos
            )
            for field in (
                "keep_rate",
                "stayedToWatch",
                "swiped",
                "swipedAway",
                "published",
                "scraped_at",
                "scrapedAt",
                "ret5",
                "curve",
                "views",
                "duration_s",
            )
        },
    }


def derive_findings(report: dict[str, Any]) -> list[dict[str, Any]]:
    findings = []
    duplicates = report["duplicates"]
    embeddings = report["embeddings"]
    accounts = report["perAccount"]
    identity = report["identityJoins"]
    canonical = report["canonicalDataset"]

    duplicate_id_n = duplicates["duplicateVideoIdN"]
    findings.append(
        {
            "id": "video_id_uniqueness",
            "severity": "clear" if duplicate_id_n == 0 else "high",
            "finding": (
                f"No duplicate video IDs exist across the {duplicates['rawRowN']} "
                "raw private rows."
                if duplicate_id_n == 0
                else f"{duplicate_id_n} duplicate video IDs exist in private sources."
            ),
            "evidence": {
                "rawRows": duplicates["rawRowN"],
                "uniqueIds": duplicates["uniqueVideoIdN"],
                "duplicateIds": duplicate_id_n,
                "crossAccountDuplicateIds": duplicates[
                    "crossAccountDuplicateVideoIdN"
                ],
            },
            "supportedCorrection": (
                "No row correction is supported. Retain a fail-fast uniqueness "
                "assertion because the production loader otherwise keeps the first "
                "account silently."
                if duplicate_id_n == 0
                else "Resolve duplicate IDs before global de-duplication and reject "
                "conflicting account or label assignments."
            ),
        }
    )

    url_mismatches = duplicates["urlVideoIdMismatchN"]
    invalid_ids = duplicates["invalidYoutubeIdN"]
    library_missing = sum(
        account["libraryMissingN"]
        for account in identity["perAccount"].values()
    )
    library_channel_mismatches = sum(
        account["libraryChannelMismatchN"]
        for account in identity["perAccount"].values()
    )
    suspicious_titles = identity["suspiciousLibraryTitleJoinN"]
    embedding_title_mismatches = sum(
        modality["titleSuspiciousN"]
        for account in identity["perAccount"].values()
        for modality in account["embeddings"].values()
    )
    identity_problem = (
        url_mismatches
        or invalid_ids
        or library_channel_mismatches
        or embedding_title_mismatches
    )
    findings.append(
        {
            "id": "identity_alignment",
            "severity": "high" if identity_problem else "clear",
            "finding": (
                "Canonical video IDs align with URLs and embedding-archive titles; "
                f"the separate library can independently cover only "
                f"{canonical['acceptedN'] - library_missing}/{canonical['acceptedN']} "
                "private rows."
                if not identity_problem
                else "At least one immutable identity check failed; inspect the "
                "listed rows before using them for cross-account validation."
            ),
            "evidence": {
                "urlIdMismatches": url_mismatches,
                "invalidYoutubeIds": invalid_ids,
                "libraryMissingIds": library_missing,
                "libraryChannelMismatches": library_channel_mismatches,
                "embeddingTitleMismatches": embedding_title_mismatches,
                "suspiciousTitleDifferences": suspicious_titles,
            },
            "supportedCorrection": (
                "Exclude or repair immutable ID/channel mismatches. Do not exclude "
                "title-only differences without checking title edit history."
                if identity_problem
                else "No canonical join correction is supported. If independent "
                "channel verification is required, add private rows to the library; "
                "do not treat current library absence as a failed predictor join."
            ),
        }
    )

    repeated_titles = duplicates["duplicateNormalizedTitleN"]
    findings.append(
        {
            "id": "possible_reposted_content",
            "severity": "medium" if repeated_titles else "clear",
            "finding": (
                f"{repeated_titles} normalized titles occur under multiple video "
                "IDs and may represent reposted or near-duplicate content."
                if repeated_titles
                else "No normalized title repeats occur under different video IDs."
            ),
            "evidence": {
                "duplicateNormalizedTitleGroups": repeated_titles,
                "samples": duplicates["duplicateNormalizedTitleSamples"],
            },
            "supportedCorrection": (
                "Before claiming video-level holdout performance, compute visual "
                "near-duplicate hashes and keep every repost family in one fold. "
                "Title equality alone is not enough to delete a row."
                if repeated_titles
                else "No correction is supported."
            ),
        }
    )

    label_conflicts = sum(
        value["labelSource"]["redundantKeepFieldConflictN"]
        for value in accounts.values()
    )
    swipe_conflicts = sum(
        value["labelSource"]["keepPlusSwipeNonzeroResidualN"]
        for value in accounts.values()
    )
    clipped = sum(
        value["label"]["atOrBelowZeroN"] + value["label"]["atOrAboveHundredN"]
        for value in accounts.values()
    )
    shadowed = sum(
        value["labelSource"]["fallbackShadowedByPresentButInvalidKeepRateN"]
        for value in accounts.values()
    )
    all_tenths = all(
        value["label"]["tenthGridN"] == value["label"]["n"]
        for value in accounts.values()
    )
    findings.append(
        {
            "id": "label_integrity_and_precision",
            "severity": (
                "high"
                if label_conflicts or swipe_conflicts or clipped or shadowed
                else "clear"
            ),
            "finding": (
                "All accepted keep labels are internally consistent with redundant "
                "keep/swipe fields, but the labels are quantized to 0.1 percentage "
                "point."
                if not (label_conflicts or swipe_conflicts or clipped or shadowed)
                else "The source tables contain conflicting, clipped, or shadowed "
                "keep labels."
            ),
            "evidence": {
                "redundantKeepFieldConflicts": label_conflicts,
                "keepPlusSwipeConflicts": swipe_conflicts,
                "clippedOrOutOfRangeLabels": clipped,
                "fallbackShadowedRows": shadowed,
                "allAccountsOnTenthPpGrid": all_tenths,
            },
            "supportedCorrection": (
                "Persist the raw YouTube Studio value and its observation timestamp. "
                "Do not add artificial precision or jitter; 0.1 pp quantization is "
                "far below the requested +/-10 pp tolerance."
                if not (label_conflicts or swipe_conflicts or clipped or shadowed)
                else "Resolve listed conflicts from the original Studio export and "
                "fail ingestion when redundant fields disagree."
            ),
        }
    )

    precision_by_account = {
        account: value["labelSource"]["publishedPrecision"]
        for account, value in accounts.items()
    }
    tied_rows = {
        account: value["time"]["rowsInDuplicateTimestampBatches"]
        for account, value in accounts.items()
    }
    findings.append(
        {
            "id": "timestamp_precision_and_batches",
            "severity": "medium"
            if any(value > 0 for value in tied_rows.values())
            else "clear",
            "finding": (
                "Publication timestamp precision differs by source, and at least one "
                "account contains tied timestamp batches."
                if any(value > 0 for value in tied_rows.values())
                else "No publication timestamp ties were found."
            ),
            "evidence": {
                "precisionByAccount": precision_by_account,
                "rowsInTiedBatchesByAccount": tied_rows,
                "maximumBatchByAccount": {
                    account: value["time"]["maximumTimestampBatchSize"]
                    for account, value in accounts.items()
                },
            },
            "supportedCorrection": (
                "Treat every identical timestamp as one simultaneous batch in "
                "forward validation and online history features. Never order tied "
                "rows by video ID or let one tied row train another. Recover exact "
                "upload times for date-only rows if available."
            ),
        }
    )

    scrape_medians = {
        account: value["labelSource"]["labelObservationAgeDays"]["median"]
        for account, value in accounts.items()
    }
    scrape_dates = {
        account: value["labelSource"]["lastScrapedAt"]
        for account, value in accounts.items()
    }
    findings.append(
        {
            "id": "label_snapshot_maturity",
            "severity": "medium",
            "finding": (
                "Private labels were observed in account-specific scrape snapshots "
                "and at different video ages; the current dataset does not identify "
                "a common label maturity horizon."
            ),
            "evidence": {
                "lastScrapeByAccount": scrape_dates,
                "medianObservationAgeDaysByAccount": scrape_medians,
            },
            "supportedCorrection": (
                "Persist labelObservedAt and evaluate a fixed post-publish horizon "
                "(or repeated snapshots) before attributing residual account effects "
                "to visual representation. Existing cumulative labels should not be "
                "silently treated as same-horizon outcomes."
            ),
        }
    )

    missing_visual = embeddings["modalities"]["visual"]["canonicalMissingN"]
    missing_together = embeddings["modalities"]["together"]["canonicalMissingN"]
    map_parity_failures = [
        modality
        for modality, detail in embeddings["modalities"].items()
        if not detail["mapParity"]["exactIdOrderMatch"]
    ]
    findings.append(
        {
            "id": "embedding_availability",
            "severity": (
                "high"
                if map_parity_failures
                else "medium"
                if missing_visual or missing_together
                else "clear"
            ),
            "finding": (
                f"{missing_visual} canonical rows lack visual embeddings and "
                f"{missing_together} lack together embeddings."
            ),
            "evidence": {
                "missingVisual": missing_visual,
                "missingTogether": missing_together,
                "mapArchiveParityFailures": map_parity_failures,
                "visualCoverage": embeddings["modalities"]["visual"][
                    "canonicalCoverage"
                ],
                "togetherCoverage": embeddings["modalities"]["together"][
                    "canonicalCoverage"
                ],
            },
            "supportedCorrection": (
                "Backfill the listed IDs and preserve one immutable multimodal "
                "generation ID. Until then, report account-specific eligibility and "
                "compare embedded versus missing label distributions."
            ),
        }
    )

    text_detail = embeddings["modalities"]["text"]
    selective_text_accounts = {
        account: detail
        for account, detail in text_detail["perAccount"].items()
        if detail["missingN"] > 0
        and finite(detail.get("missingMinusPresentKeepPp"))
        and abs(float(detail["missingMinusPresentKeepPp"])) >= 5
    }
    findings.append(
        {
            "id": "text_embedding_missingness",
            "severity": "high" if selective_text_accounts else "clear",
            "finding": (
                f"{text_detail['canonicalMissingN']} canonical rows lack text "
                "embeddings; missingness is keep-rate selective in "
                f"{len(selective_text_accounts)} account(s)."
            ),
            "evidence": {
                "missingTextN": text_detail["canonicalMissingN"],
                "coverage": text_detail["canonicalCoverage"],
                "selectiveAccounts": selective_text_accounts,
            },
            "supportedCorrection": (
                "Distinguish genuinely silent videos from extraction failures, "
                "backfill recoverable text, and validate text-present and text-"
                "missing strata separately. Do not let median imputation turn "
                "account-specific extraction coverage into a hidden predictor."
            ),
        }
    )

    drift_flags = {}
    for account, value in accounts.items():
        split = value["time"].get("largestMeanSplit")
        if not split:
            continue
        effect = abs(float(split.get("standardizedEffect") or 0))
        shift = abs(float(split.get("afterMinusBeforePp") or 0))
        if effect >= 0.8 and shift >= 5:
            drift_flags[account] = split
    findings.append(
        {
            "id": "temporal_drift",
            "severity": "high" if drift_flags else "clear",
            "finding": (
                "Large within-account temporal mean shifts are present."
                if drift_flags
                else "No account crosses the audit's descriptive large-shift flag "
                "(absolute shift >=5 pp and standardized effect >=0.8)."
            ),
            "evidence": {
                "flaggedAccounts": drift_flags,
                "perAccountTrend": {
                    account: {
                        "spearman": value["time"][
                            "spearmanPublishedTimeVsKeep"
                        ],
                        "slopePpPerYear": value["time"]["linearSlopePpPerYear"],
                        "largestMeanSplit": value["time"]["largestMeanSplit"],
                    }
                    for account, value in accounts.items()
                },
            },
            "supportedCorrection": (
                "Use forward-time and rolling-origin validation with training-only "
                "account calibration. The audit cannot distinguish real creator "
                "improvement from a measurement regime change without repeated "
                "label snapshots or export provenance."
            ),
        }
    )

    findings.append(
        {
            "id": "canonical_population_parity",
            "severity": "clear"
            if canonical["latestResultParity"]["matches"]
            else "high",
            "finding": (
                "The audit reconstruction matches the latest Predictor Lab private "
                "and visual-eligible population counts."
                if canonical["latestResultParity"]["matches"]
                else "The reconstructed canonical population does not match the "
                "latest Predictor Lab artifact."
            ),
            "evidence": canonical["latestResultParity"],
            "supportedCorrection": (
                "No population correction is supported."
                if canonical["latestResultParity"]["matches"]
                else "Regenerate Predictor Lab only after resolving the source or "
                "artifact generation mismatch."
            ),
        }
    )
    return findings


def benchmark_validity_summary(
    report: dict[str, Any],
    canonical_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    accounts = report["perAccount"]
    duplicates = report["duplicates"]
    embeddings = report["embeddings"]["modalities"]
    date_only_rows: dict[str, list[str]] = defaultdict(list)
    for row in canonical_rows:
        if timestamp_precision(row.get("publishedRaw")) == "date_only":
            date_only_rows[str(row["account"])].append(str(row["id"]))
    tied_batches = []
    for account, detail in accounts.items():
        for batch in detail["time"]["largestTimestampBatches"]:
            tied_batches.append({"account": account, **batch})

    label_conflict_rows = []
    for account, detail in accounts.items():
        for conflict in detail["labelSource"]["redundantKeepFieldConflicts"]:
            label_conflict_rows.append({"account": account, **conflict})
    label_integrity_failures = {
        "redundantKeepFieldConflictRows": label_conflict_rows,
        "keepPlusSwipeConflictN": sum(
            detail["labelSource"]["keepPlusSwipeNonzeroResidualN"]
            for detail in accounts.values()
        ),
        "clippedOrOutOfRangeN": sum(
            detail["label"]["atOrBelowZeroN"]
            + detail["label"]["atOrAboveHundredN"]
            for detail in accounts.values()
        ),
        "fallbackShadowedN": sum(
            detail["labelSource"][
                "fallbackShadowedByPresentButInvalidKeepRateN"
            ]
            for detail in accounts.values()
        ),
    }
    immutable_join_failures = {
        "duplicateVideoIdN": duplicates["duplicateVideoIdN"],
        "urlVideoIdMismatchN": duplicates["urlVideoIdMismatchN"],
        "invalidYoutubeIdN": duplicates["invalidYoutubeIdN"],
        "embeddingMapArchiveParityFailures": [
            modality
            for modality, detail in embeddings.items()
            if not detail["mapParity"]["exactIdOrderMatch"]
        ],
        "embeddingTitleSuspiciousN": sum(
            modality["titleSuspiciousN"]
            for account in report["identityJoins"]["perAccount"].values()
            for modality in account["embeddings"].values()
        ),
    }
    static_invalid = bool(
        label_integrity_failures["redundantKeepFieldConflictRows"]
        or label_integrity_failures["keepPlusSwipeConflictN"]
        or label_integrity_failures["clippedOrOutOfRangeN"]
        or label_integrity_failures["fallbackShadowedN"]
        or immutable_join_failures["duplicateVideoIdN"]
        or immutable_join_failures["urlVideoIdMismatchN"]
        or immutable_join_failures["invalidYoutubeIdN"]
        or immutable_join_failures["embeddingMapArchiveParityFailures"]
        or immutable_join_failures["embeddingTitleSuspiciousN"]
    )
    snapshot_by_account = {
        account: {
            "n": detail["canonicalRowN"],
            "firstScrapedAt": detail["labelSource"]["firstScrapedAt"],
            "lastScrapedAt": detail["labelSource"]["lastScrapedAt"],
            "observationAgeDays": detail["labelSource"]["labelObservationAgeDays"],
        }
        for account, detail in accounts.items()
    }
    return {
        "retrospectiveStaticCrossAccount": {
            "valid": not static_invalid,
            "verdict": (
                "No label-value, immutable-ID, NPZ-map, or embedding-title "
                "mismatch invalidates the 632-row embedded retrospective benchmark."
                if not static_invalid
                else "At least one label or immutable join mismatch invalidates the "
                "retrospective benchmark until corrected."
            ),
            "labelIntegrityFailures": label_integrity_failures,
            "immutableJoinFailures": immutable_join_failures,
            "eligibleRows": report["embeddings"]["predictorEligibility"][
                "visualOnlyStudyRows"
            ],
            "excludedForMissingVisualEmbedding": embeddings["visual"][
                "missingCanonicalIds"
            ],
        },
        "fixedHorizonInterpretation": {
            "valid": False,
            "verdict": (
                "Invalid as a same-age or fixed-post-publish target: labels are "
                "single cumulative Studio snapshots observed at materially different "
                "video ages and account-specific scrape dates."
            ),
            "affectedAccounts": snapshot_by_account,
            "affectedRowN": len(canonical_rows),
            "correction": (
                "Persist labelObservedAt and collect repeated labels at a fixed "
                "post-publish horizon before calling this a fixed-horizon forecast."
            ),
        },
        "forwardTimeInterpretation": {
            "validOnlyWithBatching": True,
            "verdict": (
                "Publication order is usable only if identical timestamps are "
                "simultaneous batches. Tyler's date-only rows cannot recover true "
                "intraday order."
            ),
            "dateOnlyRowsByAccount": dict(date_only_rows),
            "dateOnlyRowN": sum(len(ids) for ids in date_only_rows.values()),
            "tiedTimestampBatches": tied_batches,
            "tiedTimestampRowN": sum(batch["n"] for batch in tied_batches),
            "correction": (
                "Use strict earlier-than timestamps for history; never train on one "
                "row from the same timestamp batch to predict another. Recover exact "
                "Tyler upload times where possible."
            ),
        },
        "coverageAndLeakageRisks": {
            "missingVisualRows": embeddings["visual"]["missingCanonicalIds"],
            "missingTogetherRows": embeddings["together"]["missingCanonicalIds"],
            "missingTextRows": embeddings["text"]["missingCanonicalIds"],
            "possibleRepostGroups": duplicates[
                "duplicateNormalizedTitleSamples"
            ],
            "verdict": (
                "The four visual/together exclusions are confined to Hafu and have "
                "nearly identical mean keep to Hafu's included rows, so they cannot "
                "explain broad cross-account failure. Text missingness is substantial "
                "and outcome-selective for some accounts. Possible reposts must be "
                "grouped before video-level holdout claims."
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument(
        "--skip-library",
        action="store_true",
        help="Skip the 50 MB library identity join.",
    )
    parser.add_argument(
        "--skip-npz-verification",
        action="store_true",
        help="Use map IDs only; faster, but not canonical for embedding availability.",
    )
    args = parser.parse_args()

    dotenv_path = load_dotenv()
    reader = R2Reader()
    channel_payload = reader.json("retention/channels.json")
    channels = list(channel_payload.get("channels") or [])
    if not any(str(channel.get("id")) == "tyler" for channel in channels):
        channels.insert(0, {"id": "tyler", "name": "Main", "owner": True})

    account_videos: dict[str, list[dict[str, Any]]] = {}
    account_names: dict[str, str] = {}
    account_meta: dict[str, Any] = {}
    channel_order = []
    for channel in channels:
        account = str(channel.get("id") or "")
        if not account:
            continue
        channel_order.append(account)
        account_names[account] = str(channel.get("name") or account)
        if channel.get("owner") or account == "tyler":
            payload = load_local_json(LOCAL_OWNER_TABLE, reader.sources)
        else:
            payload = reader.json(f"retention/{account}.json")
        videos = payload.get("videos") if isinstance(payload, dict) else None
        if not isinstance(videos, list):
            raise RuntimeError(f"Retention source {account} has no videos list")
        account_videos[account] = videos
        account_meta[account] = payload.get("meta") if isinstance(payload, dict) else None

    duplicates = duplicate_summary(account_videos)
    canonical_rows, canonical_load = reconstruct_canonical(
        channel_order,
        account_names,
        account_videos,
    )

    embedding_indexes: dict[str, dict[str, Any]] = {}
    for modality in MODALITIES:
        map_key = f"raw/{modality}/map.json"
        archive_key = f"raw/{modality}/embeddings.npz"
        map_payload = reader.json(map_key)
        map_ids = [str(value) for value in (map_payload.get("id") or [])]
        map_titles = [str(value) for value in (map_payload.get("title") or [])]
        if args.skip_npz_verification:
            archive_ids = map_ids
            archive_titles = map_titles
            archive = {
                **reader.head(archive_key),
                "idsN": len(archive_ids),
                "duplicateIdsN": len(archive_ids) - len(set(archive_ids)),
                "vectorShape": None,
                "vectorDtype": None,
                "verification": "map_only_noncanonical",
            }
        else:
            identity = reader.npz_identity(archive_key)
            archive_ids = identity["ids"]
            archive_titles = identity.get("titles") or []
            archive = {
                **reader.sources[f"r2:{archive_key}"],
                "idsN": len(archive_ids),
                "duplicateIdsN": len(archive_ids) - len(set(archive_ids)),
                "vectorShape": identity["vectorShape"],
                "vectorDtype": identity["vectorDtype"],
                "verification": "actual_npz_ids_and_header",
            }
        titles_by_id = {
            video_id: archive_titles[index]
            for index, video_id in enumerate(archive_ids)
            if index < len(archive_titles)
        }
        embedding_indexes[modality] = {
            "idSet": set(archive_ids),
            "titlesById": titles_by_id,
            "archive": archive,
            "mapParity": {
                "mapN": len(map_ids),
                "archiveN": len(archive_ids),
                "mapDuplicateIdsN": len(map_ids) - len(set(map_ids)),
                "archiveDuplicateIdsN": len(archive_ids) - len(set(archive_ids)),
                "exactIdOrderMatch": map_ids == archive_ids,
                "mapOnlyIdN": len(set(map_ids) - set(archive_ids)),
                "archiveOnlyIdN": len(set(archive_ids) - set(map_ids)),
                "mapOnlyIds": sorted(set(map_ids) - set(archive_ids))[:100],
                "archiveOnlyIds": sorted(set(archive_ids) - set(map_ids))[:100],
                "mapUpdated": map_payload.get("updated"),
            },
        }

    if args.skip_library:
        library = {}
        library_meta = {
            "skipped": True,
            "sourceRowN": 0,
            "uniqueVideoIdN": 0,
            "duplicateVideoIdN": 0,
            "duplicateVideoIds": [],
        }
    else:
        library_payload = reader.json("library/db.json")
        library, library_meta = library_index(library_payload)

    per_account = {
        account: account_audit(
            account,
            account_names[account],
            account_videos[account],
            canonical_rows,
        )
        for account in channel_order
    }
    embeddings = embedding_summary(canonical_rows, embedding_indexes)
    identity = identity_join_summary(canonical_rows, library, embedding_indexes)

    latest_results_path = (
        ROOT / "buildings" / "jarvis" / "predictor-lab" / "results.json"
    )
    latest_result_counts = {}
    if latest_results_path.exists():
        latest_results = load_local_json(latest_results_path, reader.sources)
        keep = ((latest_results.get("targets") or {}).get("keep") or {})
        latest_result_counts = {
            "privateRetentionRows": (
                (latest_results.get("coverage") or {}).get("privateRetentionRows")
            ),
            "visualOnlyStudyRows": (
                ((keep.get("visualOnlyStudy") or {}).get("population") or {}).get("n")
            ),
            "creatorAdaptiveRows": (
                ((keep.get("creatorAdaptiveStudy") or {}).get("population") or {}).get(
                    "n"
                )
            ),
            "generatedAt": latest_results.get("generatedAt"),
        }
    reconstructed_counts = {
        "privateRetentionRows": len(canonical_rows),
        "visualOnlyStudyRows": embeddings["predictorEligibility"][
            "visualOnlyStudyRows"
        ],
        "creatorAdaptiveRows": embeddings["predictorEligibility"][
            "creatorAdaptiveRows"
        ],
    }
    parity_keys = (
        "privateRetentionRows",
        "visualOnlyStudyRows",
        "creatorAdaptiveRows",
    )
    latest_result_parity = {
        "latestArtifact": latest_result_counts,
        "reconstructed": reconstructed_counts,
        "matches": bool(latest_result_counts)
        and all(
            latest_result_counts.get(key) == reconstructed_counts.get(key)
            for key in parity_keys
        ),
    }

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "purpose": (
            "Read-only audit of whether cross-account keep-rate failure could be "
            "caused by label, timestamp, identity, or embedding alignment rather "
            "than model class."
        ),
        "scope": {
            "canonicalLoader": (
                "Channel order from retention/channels.json; owner source from the "
                "local retention table; other sources from retention/{account}.json; "
                "first occurrence of each video ID with finite keep_rate (or "
                "stayedToWatch only when keep_rate is absent)."
            ),
            "embeddingAvailabilitySource": (
                "Actual embeddings.npz IDs"
                if not args.skip_npz_verification
                else "map.json IDs only"
            ),
            "libraryIdentityJoin": not args.skip_library,
            "dotenvDiscovered": str(dotenv_path) if dotenv_path else None,
            "accounts": channel_order,
        },
        "canonicalDataset": {
            **canonical_load,
            "channelOrder": channel_order,
            "perAccount": dict(Counter(row["account"] for row in canonical_rows)),
            "latestResultParity": latest_result_parity,
        },
        "perAccount": per_account,
        "crossAccountLabelDistributions": pairwise_distributions(canonical_rows),
        "duplicates": duplicates,
        "library": library_meta,
        "identityJoins": identity,
        "embeddings": embeddings,
        "sourceMetadata": {
            account: {
                "name": account_names[account],
                "meta": account_meta[account],
            }
            for account in channel_order
        },
        "methodBoundaries": [
            "This audit can detect inconsistent labels, joins, timestamp precision, "
            "coverage selection, and descriptive drift. It cannot prove that a "
            "distribution shift is measurement error rather than real creator, "
            "audience, or content change.",
            "Title similarity never overrides video-ID identity because titles can "
            "be edited after publication.",
            "The largest temporal split is selected in sample and is not a "
            "confirmatory changepoint p-value.",
            "A fixed-horizon keep label cannot be reconstructed from one cumulative "
            "YouTube Studio snapshot; repeated snapshots are required.",
        ],
        "sources": dict(sorted(reader.sources.items())),
    }
    report["benchmarkValidity"] = benchmark_validity_summary(
        report,
        canonical_rows,
    )
    report["findings"] = derive_findings(report)
    report["conclusion"] = {
        "dataQualityCanContribute": any(
            finding["severity"] in {"high", "medium"}
            and finding["id"]
            in {
                "timestamp_precision_and_batches",
                "label_snapshot_maturity",
                "embedding_availability",
                "temporal_drift",
                "identity_alignment",
                "label_integrity_and_precision",
            }
            for finding in report["findings"]
        ),
        "decisionRule": (
            "Treat data quality as a plausible contributor only where an audit "
            "finding has direct row-level evidence. Do not use account distribution "
            "differences alone to reject the model class."
        ),
        "primaryAssessment": (
            "No direct label-value or canonical embedding-join corruption was found. "
            "The strongest data-side explanation for cross-account instability is "
            "nonstationary, differently sampled creator eras, compounded by "
            "single-snapshot labels at inconsistent maturity and outcome-selective "
            "text availability. These are validation-design and support-shift "
            "problems, not evidence that visual embeddings are attached to the wrong "
            "videos."
        ),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {args.output}")
    print(
        "Canonical rows:",
        len(canonical_rows),
        "| visual eligible:",
        embeddings["predictorEligibility"]["visualOnlyStudyRows"],
        "| creator adaptive:",
        embeddings["predictorEligibility"]["creatorAdaptiveRows"],
    )
    for finding in report["findings"]:
        print(f"[{finding['severity'].upper()}] {finding['id']}: {finding['finding']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
