# Promise Lab

Promise Lab is the Shorts Quant opening-retention analyzer. It has one product
contract for both saved openings and typed text:

1. align the supplied transcript to a media or declared speaking clock;
2. split every analyzed token into one variable-count, non-overlapping cover;
3. assign each selected component to the frozen four-category semantic map;
4. embed only the transcript prefix completed by each second;
5. apply the frozen scalar model for that second through 20 seconds; and
6. show measured outcomes, uncertainty, components, and graph diagnostics
   without promoting unvalidated channels.

The active product uses Shorts openings only. It does not use the Long Quant
title manifold, a generative LLM, or a resident GPU.

## Product Surfaces

- **Score opening** analyzes typed text with the frozen full-fit temporal model.
- **Opening library** shows source-level out-of-fold predictions and measured
  curves for all 208 aligned Shorts openings.
- **Saved embedding** preserves the outcome-blind four-category component map.

Both scorer and library use the same partition decoder, four-category model,
20-second temporal family, component schema, and UI renderer. Their only
intentional differences are timing provenance and evaluation policy: saved
openings use source-media word intervals plus out-of-fold predictions; typed
openings use a supplied duration or the measured corpus speaking-rate
distribution plus frozen full fits.

## Retention Contract

At second `t`:

```text
prefix(t)      = transcript atoms acoustically completed by t
prediction(t)  = mean retention at t + frozen semantic adjustment(prefix(t))
headline(t)    = prediction(t) + 0 component points + 0 relationship points
```

Two curve families are displayed:

- `entryIndexed` starts every opening at 100% and measures survival from entry.
- `observedAbsolute` preserves the raw analytics curve, including rewatch lift.

Component-deletion and adjacent-relationship effects are 20-second model
counterfactuals. They stay visible but are withheld from the headline because
they have not passed the promotion gate. The individualized view forecast is
also withheld: its random-fold R2 is approximately 0.001 and its chronological
R2 is negative.

The current normalized-retention model has modest same-era signal and does not
yet beat the mean curve in the past-to-future stress test. The UI reports those
numbers directly instead of turning them into a fake virality percentile.

## Timing

All 208 saved openings are measured through 20 seconds. Canonical transcript
words are aligned to downloaded source media with local CTC forced alignment;
an independent Whisper free-decode pass audits the mapping. Times are model
estimates, not hand-labeled ground truth. Typed text never forecasts beyond the
words supplied by the user.

## Build

`build.py` is the active rebuild path:

1. intervention/discovery and the saved component atlas;
2. all contiguous span vectors and atlas projection;
3. persistent manual projection;
4. source-media alignment and independent timing verification;
5. outcome-blind canonical partitions;
6. Shorts-only opening lattice support;
7. 20-second opening structures;
8. causal temporal predictor and verification;
9. typed/saved serving canary; and
10. UI artifact validation and publication.

The old market-reward, hook-quality, long-title-prior, outcome-axis,
component-response, example, and duplicate component-lattice stages are not in
the active build.

```bash
python build.py --no-upload
python build.py --from-stage opening-lattice --no-upload
```

Current generated data lives in `.cache/`. Browser artifacts and serving models
are mirrored to `shorts/promise-lab-v1/` in R2.

## Verification

- `verify_media_alignment.py` audits media hashes, word order, source-clock
  offsets, and independent timestamp agreement.
- `verify_opening_horizon.py` checks all 208 exact covers and measured curves.
- `verify_opening_predictor.py` checks 20 causal models per curve family, no
  future-word leakage, OOF saved predictions, and the views promotion gate.
- `verify_product_scorer.py` runs one opening through both saved and typed paths,
  verifies the same partition and 21-point horizon, and blocks `sklearn` to
  prove the Render serving path is NumPy-only.
- `test_score_hook.py` covers causal prefix timing, 20-second support, explicit
  scoping, and the no-`sklearn` import contract.

The saved category map remains an outcome-blind semantic discovery artifact;
it does not itself prove retention lift.
