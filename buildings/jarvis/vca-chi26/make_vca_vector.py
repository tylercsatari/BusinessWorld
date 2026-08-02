#!/usr/bin/env python3
"""
Create one VCA vector by concatenating Video-LLaMA video and audio embeddings
for the same video.

Expected input files by default:
  embs/video_<VIDEO_ID>.pth
  embs/audio_<VIDEO_ID>.pth

Expected tensor shapes:
  video: [1, 32, 4096] or [32, 4096]
  audio: [1, 8, 4096] or [8, 4096]

Output:
  default saves a flattened numpy vector of shape [40 * 4096] = [163840]
"""

import argparse
import os
from pathlib import Path
from typing import Tuple

import numpy as np
import torch


def _load_embedding(path: Path, expected_tokens: int, hidden_dim: int = 4096) -> torch.Tensor:
    if not path.exists():
        raise FileNotFoundError(f"Missing embedding file: {path}")

    emb = torch.load(path, map_location="cpu")

    # Some checkpoints may save dicts. Be conservative and support common keys.
    if isinstance(emb, dict):
        for key in ("embedding", "embeddings", "features", "feat"):
            if key in emb:
                emb = emb[key]
                break
        else:
            raise ValueError(
                f"{path} is a dict, but no known embedding key was found. "
                f"Available keys: {list(emb.keys())}"
            )

    if not torch.is_tensor(emb):
        emb = torch.as_tensor(emb)

    emb = emb.detach().cpu()

    # Accept [1, T, D], [T, D], or anything with the right total size.
    if emb.ndim == 3 and emb.shape[0] == 1:
        emb = emb.squeeze(0)

    if emb.shape == (expected_tokens, hidden_dim):
        return emb.float()

    expected_numel = expected_tokens * hidden_dim
    if emb.numel() == expected_numel:
        return emb.reshape(expected_tokens, hidden_dim).float()

    raise ValueError(
        f"Unexpected shape for {path}: got {tuple(emb.shape)}, expected "
        f"[1, {expected_tokens}, {hidden_dim}] or [{expected_tokens}, {hidden_dim}]"
    )


def make_vca_vector(
    video_id: str,
    embs_dir: Path,
    flatten: bool = True,
    video_prefix: str = "video_",
    audio_prefix: str = "audio_",
) -> Tuple[np.ndarray, torch.Tensor, torch.Tensor]:
    video_path = embs_dir / f"{video_prefix}{video_id}.pth"
    audio_path = embs_dir / f"{audio_prefix}{video_id}.pth"

    video_emb = _load_embedding(video_path, expected_tokens=32)
    audio_emb = _load_embedding(audio_path, expected_tokens=8)

    # Concatenate along token/frame dimension: [32,4096] + [8,4096] -> [40,4096]
    vca = torch.cat([video_emb, audio_emb], dim=0)

    if flatten:
        vca_np = vca.reshape(-1).numpy()  # [163840]
    else:
        vca_np = vca.numpy()             # [40,4096]

    return vca_np, video_emb, audio_emb


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a VCA vector from one video/audio embedding pair.")
    parser.add_argument("--videoname", required=True, help="Video ID/name without audio_ or video_ prefix and without .pth")
    parser.add_argument("--embs-dir", default="embs", help="Directory containing audio_*.pth and video_*.pth files")
    parser.add_argument("--output-dir", default="vcavectors", help="Directory to save VCA vectors")
    parser.add_argument("--output-format", choices=["npy", "pth"], default="npy", help="Save format")
    parser.add_argument("--keep-2d", action="store_true", help="Save as [40,4096] instead of flattened [163840]")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output file")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    embs_dir = Path(args.embs_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    suffix = args.output_format
    output_path = output_dir / f"vca_{args.videoname}.{suffix}"

    if output_path.exists() and not args.overwrite:
        print(f"Output already exists, skipping: {output_path}")
        return

    vca_np, video_emb, audio_emb = make_vca_vector(
        video_id=args.videoname,
        embs_dir=embs_dir,
        flatten=not args.keep_2d,
    )

    if args.output_format == "npy":
        np.save(output_path, vca_np)
    else:
        torch.save(torch.from_numpy(vca_np), output_path)

    print(f"Loaded video embedding: {tuple(video_emb.shape)}")
    print(f"Loaded audio embedding: {tuple(audio_emb.shape)}")
    print(f"Saved VCA vector: {output_path}")
    print(f"VCA shape: {vca_np.shape}")


if __name__ == "__main__":
    main()
