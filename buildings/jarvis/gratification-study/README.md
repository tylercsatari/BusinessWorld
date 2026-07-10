# Reference to Gratification Study

This study searches the existing 211-video Shorts hook corpus for reproducible
directions in the **Long Quant text embedding space**. It deliberately does not
assign a hand-made reference-to-gratification label.

The pipeline compares four representations:

- exact spoken hook
- published title (the noisy base-idea anchor)
- hook minus title (the extra promise/framing)
- hook orthogonal to title (a stricter idea-removal diagnostic)

Each representation is tested against fixed-time, exact-hook-aligned,
traditional, and unsupervised retention-shape outcomes. Every outcome is shown
raw, timing-adjusted, and adjusted for timing + entry keep rate + title-space
idea PCs. Reported model metrics are out of fold with semantic title clusters
held out. Full-data axes only draw the map.

Two linear coordinate systems are compared: a local basis learned from the 208
hook/title records and a global 64-dimensional basis fit incrementally across
**every Long Quant title vector** (42,299 at the latest build). The global basis
is cached, so it is rebuilt only when explicitly requested.

Run:

```bash
/Users/tylercsatari/miniforge3/bin/python3 \
  buildings/jarvis/gratification-study/build_study.py
```

Useful checks:

```bash
/Users/tylercsatari/miniforge3/bin/python3 \
  buildings/jarvis/gratification-study/build_study.py --self-test
```

Artifacts are cached and published to R2 at:

- `longform/gratification/embeddings.npz`
- `longform/gratification/title_corpus_basis.npz`
- `longform/gratification/report.json`

The embedding cache is content-addressed by video, channel (hook/title), and
text hash. Re-running only embeds changed hook edits or newly added videos.
