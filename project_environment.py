#!/usr/bin/env python3

import os
from pathlib import Path


def _dotenv_candidates(start):
    root = Path(start or __file__).resolve()
    if root.is_file():
        root = root.parent
    return [parent / '.env' for parent in (root, *root.parents)]


def env_value(name, start=None):
    value = os.environ.get(name)
    if value:
        return value
    for path in _dotenv_candidates(start):
        if not path.is_file():
            continue
        for raw_line in path.read_text(encoding='utf-8').splitlines():
            line = raw_line.strip()
            if (
                not line
                or line.startswith('#')
                or '=' not in line
            ):
                continue
            key, candidate = line.split('=', 1)
            if key.strip() != name:
                continue
            candidate = candidate.strip()
            if (
                len(candidate) >= 2
                and candidate[0] == candidate[-1]
                and candidate[0] in ('"', "'")
            ):
                candidate = candidate[1:-1]
            return candidate
    return None
