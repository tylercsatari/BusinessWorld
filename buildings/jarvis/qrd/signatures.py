"""
Path signatures — pure numpy (iisignature/signatory not installed).

§6.2 of the QRD spec: turn a reel's bundle of curves moving together
(loudness, pitch, onset, brightness, motion, face size ...) into a single
fixed-length vector that captures the ORDER of events and how channels
interact — independent of where on the clock the events sit.

We implement the truncated signature to level 2. For a d-channel path the
signature is:

    level 0 : 1                          (dropped — constant)
    level 1 : ΔX_k        for each k     (d net changes)
    level 2 : ∫∫ dX_i dX_j  for i,j      (d² ordered area / interaction terms)

Level-2 terms are the useful ones: the antisymmetric part (area) encodes
"channel i moves, THEN channel j moves" vs the reverse — exactly what
separates a hook that lands from one that does not, even when the per-channel
averages are identical.

A leading monotone time channel is prepended (per the spec) so the level-2
terms with time capture how wiggly each channel is.
"""
import numpy as np


def _level2_signature(path):
    """Truncated signature to level 2 for a (T, d) path via iterated integrals.

    Returns concatenation of level-1 (d,) and level-2 (d*d,) terms.
    Computed with the Chen / increment recursion so it is exact for the
    piecewise-linear interpolation of the sampled path.
    """
    path = np.asarray(path, dtype=np.float64)
    T, d = path.shape
    if T < 2:
        return np.zeros(d + d * d, dtype=np.float64)
    dX = np.diff(path, axis=0)                 # (T-1, d) increments
    lvl1 = dX.sum(axis=0)                       # (d,) total displacement

    # level-2: A = sum over segments of [ S_before ⊗ dX  +  0.5 dX ⊗ dX ]
    # where S_before is the running level-1 signature up to that segment.
    lvl2 = np.zeros((d, d), dtype=np.float64)
    running = np.zeros(d, dtype=np.float64)
    for k in range(dX.shape[0]):
        inc = dX[k]
        lvl2 += np.outer(running, inc) + 0.5 * np.outer(inc, inc)
        running += inc
    return np.concatenate([lvl1, lvl2.ravel()])


def signature_features(channels, with_time=True, normalize=True):
    """channels: dict[name] -> 1-D array (already event-aligned, same length).

    Returns (names, vector). Channels are resampled to a common length,
    optionally min-max normalised per channel (so the signature is scale-free),
    a monotone time channel is prepended, and the level<=2 signature is taken.
    """
    names = sorted(channels.keys())
    series = [np.asarray(channels[n], dtype=np.float64) for n in names]
    series = [s for s in series if s.size >= 2]
    names = [n for n, s in zip(names, [np.asarray(channels[k]) for k in sorted(channels)]) if np.asarray(channels[n]).size >= 2]
    if not series:
        return [], np.zeros(0)

    L = max(s.shape[0] for s in series)
    grid = np.linspace(0.0, 1.0, L)
    cols = []
    for s in series:
        xs = np.linspace(0.0, 1.0, s.shape[0])
        r = np.interp(grid, xs, s)
        if normalize:
            rng = r.max() - r.min()
            r = (r - r.min()) / rng if rng > 1e-9 else r * 0.0
        cols.append(r)

    chan_names = list(names)
    if with_time:
        cols = [grid.copy()] + cols
        chan_names = ['t'] + chan_names

    path = np.stack(cols, axis=1)              # (L, d)
    sig = _level2_signature(path)
    d = path.shape[1]
    out_names = [f'sig1_{a}' for a in chan_names]
    out_names += [f'sig2_{a}_{b}' for a in chan_names for b in chan_names]
    return out_names, sig


if __name__ == '__main__':
    # self-test: order matters — swapping two channels' temporal order
    # flips the antisymmetric level-2 (area) term.
    t = np.linspace(0, 1, 50)
    a = np.where(t < 0.5, t * 2, 1.0)          # rises first
    b = np.where(t < 0.5, 0.0, (t - 0.5) * 2)  # rises second
    n1, s1 = signature_features({'a': a, 'b': b}, with_time=False, normalize=False)
    n2, s2 = signature_features({'a': b, 'b': a}, with_time=False, normalize=False)
    i_ab = n1.index('sig2_a_b'); i_ba = n1.index('sig2_b_a')
    area1 = s1[i_ab] - s1[i_ba]
    area2 = s2[i_ab] - s2[i_ba]
    print(f'area(a-then-b) = {area1:+.4f}   area(b-then-a) = {area2:+.4f}')
    assert np.sign(area1) != np.sign(area2), 'level-2 area should flip with order'
    print('signature self-test OK — order is encoded')
