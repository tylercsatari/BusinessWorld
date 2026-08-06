#!/usr/bin/env python3
"""Memory-bounded semantic retrieval against the frozen Together corpus."""

import json
import os
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import raw_upload  # noqa: E402


def normalized(values):
    if values is None:
        return None
    vector = np.asarray(values, dtype=np.float32).reshape(-1)
    if vector.size < 8 or not np.all(np.isfinite(vector)):
        return None
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else None


def main():
    request = json.load(sys.stdin)
    matrix, ids = raw_upload._norm_emb('together')
    if matrix is None or ids is None:
        raise RuntimeError('the frozen Together embedding matrix is unavailable')
    id_to_index = {str(video_id): index for index, video_id in enumerate(ids)}
    candidate_ids = [
        str(video_id)
        for video_id in request.get('candidate_ids', [])
        if str(video_id) in id_to_index
    ]
    centroid_ids = [
        str(video_id)
        for video_id in request.get('centroid_ids', [])
        if str(video_id) in id_to_index
    ]
    query = normalized(request.get('query_vector'))
    if query is not None and query.size != int(matrix.shape[1]):
        raise RuntimeError(
            f'query vector has {query.size} dimensions; '
            f'the frozen Together corpus has {matrix.shape[1]}'
        )
    centroid = None
    if centroid_ids:
        centroid = normalized(np.mean(
            np.asarray(
                matrix[[id_to_index[video_id] for video_id in centroid_ids]],
                dtype=np.float32,
            ),
            axis=0,
        ))
    centroid_weight = max(
        0.0,
        min(0.8, float(request.get('centroid_weight', 0.35))),
    )
    if query is not None and centroid is not None:
        search = normalized(
            (1.0 - centroid_weight) * query + centroid_weight * centroid
        )
    else:
        search = query if query is not None else centroid
    if search is None or not candidate_ids:
        print(json.dumps({
            'results': [],
            'candidate_count': len(request.get('candidate_ids', [])),
            'embedding_candidate_count': len(candidate_ids),
            'centroid_member_count': len(centroid_ids),
            'query_available': query is not None,
            'centroid_available': centroid is not None,
        }))
        return
    indices = np.asarray(
        [id_to_index[video_id] for video_id in candidate_ids],
        dtype=np.int64,
    )
    similarities = np.empty(len(indices), dtype=np.float32)
    query_similarities = np.empty(len(indices), dtype=np.float32)
    centroid_similarities = (
        np.empty(len(indices), dtype=np.float32)
        if centroid is not None
        else None
    )
    for start in range(0, len(indices), 1024):
        end = min(len(indices), start + 1024)
        block = np.asarray(matrix[indices[start:end]], dtype=np.float32)
        similarities[start:end] = block @ search
        query_similarities[start:end] = (
            block @ query if query is not None else similarities[start:end]
        )
        if centroid_similarities is not None:
            centroid_similarities[start:end] = block @ centroid
    limit = max(1, min(1000, int(request.get('limit', 400))))
    order = np.argsort(-similarities, kind='stable')[:limit]
    results = []
    for position in order:
        results.append({
            'id': candidate_ids[int(position)],
            'similarity': round(float(similarities[position]), 6),
            'query_similarity': round(float(query_similarities[position]), 6),
            'centroid_similarity': (
                round(float(centroid_similarities[position]), 6)
                if centroid_similarities is not None
                else None
            ),
        })
    print(json.dumps({
        'results': results,
        'candidate_count': len(request.get('candidate_ids', [])),
        'embedding_candidate_count': len(candidate_ids),
        'centroid_member_count': len(centroid_ids),
        'query_available': query is not None,
        'centroid_available': centroid is not None,
        'embedding_dimensions': int(matrix.shape[1]),
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)[:500]}))
        sys.exit(1)
