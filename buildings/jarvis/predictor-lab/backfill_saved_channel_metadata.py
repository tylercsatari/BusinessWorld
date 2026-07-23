#!/usr/bin/env python3
"""Refresh saved-channel publication dates and public-view snapshots in batches."""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import boto3


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STATUS_KEY = "raw/predictor-lab/metadata-status.json"


def env(name: str) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


BUCKET = env("R2_BUCKET_NAME") or "business-world-videos"
S3 = boto3.client(
    "s3",
    endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
    aws_access_key_id=env("R2_ACCESS_KEY_ID"),
    aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
    region_name="auto",
)


def get_json(key: str, default: Any = None) -> Any:
    try:
        payload = S3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        return json.loads(payload)
    except Exception:
        return default


def put_json(key: str, value: Any) -> None:
    S3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(value, separators=(",", ":")).encode(),
        ContentType="application/json",
    )


def status(stage: str, **extra: Any) -> None:
    put_json(
        STATUS_KEY,
        {
            "version": 1,
            "stage": stage,
            "updatedAt": int(time.time() * 1000),
            **extra,
        },
    )


def oauth_token() -> str:
    body = urllib.parse.urlencode(
        {
            "client_id": env("YOUTUBE_CLIENT_ID"),
            "client_secret": env("YOUTUBE_CLIENT_SECRET"),
            "refresh_token": env("YOUTUBE_REFRESH_TOKEN"),
            "grant_type": "refresh_token",
        }
    ).encode()
    request = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())["access_token"]


def fetch_batch(token: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    query = urllib.parse.urlencode(
        {
            "part": "snippet,statistics,contentDetails",
            "id": ",".join(ids),
            "maxResults": 50,
        }
    )
    request = urllib.request.Request(
        f"https://www.googleapis.com/youtube/v3/videos?{query}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.loads(response.read())
    return {str(item["id"]): item for item in payload.get("items") or []}


def fetch_public_video(video_id: str) -> dict[str, Any] | None:
    try:
        import yt_dlp

        options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "extractor_args": {
                "youtube": {
                    "player_client": ["web_safari", "mweb", "tv_embedded", "web_embedded"]
                }
            },
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}",
                download=False,
            )
        if not info:
            return None
        published = info.get("upload_date")
        if published and len(str(published)) == 8:
            text = str(published)
            published = f"{text[:4]}-{text[4:6]}-{text[6:]}T00:00:00Z"
        return {
            "id": video_id,
            "snippet": {
                "publishedAt": published,
                "channelTitle": info.get("channel") or info.get("uploader"),
            },
            "statistics": {"viewCount": info.get("view_count")},
        }
    except Exception:
        return None


def apply_item(video: dict[str, Any], item: dict[str, Any], observed_at: int) -> None:
    snippet = item.get("snippet") or {}
    statistics = item.get("statistics") or {}
    current_views = statistics.get("viewCount")
    previous_views = video.get("views")
    previous_at = video.get("viewsObservedAt") or video.get("scoredAt")
    history = list(video.get("viewsHistory") or [])
    if previous_views is not None and previous_at:
        prior = {"at": int(previous_at), "views": int(previous_views)}
        if not any(
            int(row.get("at") or 0) == prior["at"]
            for row in history
            if isinstance(row, dict)
        ):
            history.append(prior)
    if current_views is not None:
        video["views"] = int(current_views)
        history.append({"at": observed_at, "views": int(current_views)})
    snapshots = sorted(
        {
            (int(row.get("at") or 0), int(row.get("views") or 0))
            for row in history
            if isinstance(row, dict) and row.get("at") and row.get("views") is not None
        }
    )
    video["viewsHistory"] = [{"at": at, "views": views} for at, views in snapshots]
    video["viewsObservedAt"] = observed_at
    video["published"] = snippet.get("publishedAt") or video.get("published")
    video["sourceChannel"] = snippet.get("channelTitle") or video.get("sourceChannel")
    video["metadataUpdatedAt"] = observed_at


def main() -> int:
    index = get_json("raw/saved-channels/index.json", {"channels": []})
    manifests: dict[str, dict[str, Any]] = {}
    lookup: dict[str, tuple[str, dict[str, Any]]] = {}
    for channel in index.get("channels") or []:
        channel_id = str(channel.get("id") or "")
        manifest = get_json(f"raw/saved-channels/{channel_id}/manifest.json", {})
        manifests[channel_id] = manifest
        for video in manifest.get("videos") or []:
            video_id = str(video.get("id") or "")
            if video_id and video.get("status") == "done":
                lookup[video_id] = (channel_id, video)
    ids = sorted(lookup)
    observed_at = int(time.time() * 1000)
    status("running", total=len(ids), processed=0, message="Refreshing saved-channel metadata")
    try:
        token = oauth_token()
    except Exception:
        token = None
    found = 0
    if token:
        for offset in range(0, len(ids), 50):
            batch_ids = ids[offset : offset + 50]
            try:
                batch = fetch_batch(token, batch_ids)
            except Exception:
                token = oauth_token()
                batch = fetch_batch(token, batch_ids)
            for video_id in batch_ids:
                item = batch.get(video_id)
                if item:
                    apply_item(lookup[video_id][1], item, observed_at)
                    found += 1
            status(
                "running",
                total=len(ids),
                processed=min(offset + len(batch_ids), len(ids)),
                found=found,
                method="youtube-data-api",
                message=f"Refreshed {min(offset + len(batch_ids), len(ids)):,} of {len(ids):,} saved Shorts",
            )
    else:
        workers = max(1, int(os.environ.get("YOUTUBE_METADATA_WORKERS", "12")))
        status(
            "running",
            total=len(ids),
            processed=0,
            found=0,
            method="public-ytdlp",
            message="OAuth is unavailable; refreshing from public video metadata",
        )
        with ThreadPoolExecutor(workers) as executor:
            for processed, (video_id, item) in enumerate(
                zip(ids, executor.map(fetch_public_video, ids)),
                start=1,
            ):
                if item:
                    apply_item(lookup[video_id][1], item, observed_at)
                    found += 1
                if processed % 20 == 0 or processed == len(ids):
                    status(
                        "running",
                        total=len(ids),
                        processed=processed,
                        found=found,
                        method="public-ytdlp",
                        message=f"Refreshed {processed:,} of {len(ids):,} saved Shorts",
                    )
    for channel_id, manifest in manifests.items():
        manifest["metadataUpdatedAt"] = observed_at
        put_json(f"raw/saved-channels/{channel_id}/manifest.json", manifest)
    status(
        "complete",
        total=len(ids),
        processed=len(ids),
        found=found,
        message=f"Saved-channel metadata refreshed for {found:,} Shorts",
    )
    print(json.dumps({"ok": True, "total": len(ids), "found": found, "observedAt": observed_at}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        try:
            status("error", message=str(error))
        except Exception:
            pass
        raise
