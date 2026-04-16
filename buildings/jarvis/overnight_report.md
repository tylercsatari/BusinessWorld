# Overnight Build Report

Run finished: 2026-04-16T06:42:01.444Z

## Totals
- Videos processed: 372
- Mechanism observations: 41119
- Distinct mechanisms: 2444
- Components lifted: 87
- Candidate principles: 312
- Principle gaps (mechanisms with no principle yet): 54
- Bridges validated: 312

## Ranking & filter rules (in effect this run)
- **Tautology filter (§11):** principles routing through a target-proxy indicator are dropped. Excluded: `log_views`, `views`, `views_log10`, `log10_views`. Rationale: an indicator that *is* the outcome (e.g. log10 of views) yields chains that look strong but identify no distinct optimization lever.
- **Specificity-weighted ranking (§11):** top principles are sorted by `|chain_strength| × mechanism IDF`, where `IDF = log((N+1)/(n_videos+1))`. Mechanisms present in nearly every video approach IDF 0 and cannot dominate rankings on ubiquity alone. Raw `chain_strength` is kept per row for inspection.
- **Cross-source compound mechanisms:** phase 2 mechanically emits `compound_<kindA>_<famA>_X_<kindB>_<famB>_at_<bucket>` ids when two evidence sources co-occur in the same position bucket. No curated taxonomy — purely emergent co-occurrence.
- **Dropped in phase 4:** 49 tautological + 0 sub-threshold. **Dropped in phase 5:** 0 tautological.

## Top 10 mechanisms by raw support
- `frame_text_overlay_at_first_5s` — 371 videos, 2162 observations (prev=100%, idf=0.0027)
- `frame_text_overlay_at_first_10s` — 370 videos, 1782 observations (prev=99%, idf=0.0054)
- `frame_text_overlay_at_late` — 370 videos, 3709 observations (prev=99%, idf=0.0054)
- `frame_text_overlay_at_mid` — 368 videos, 7427 observations (prev=99%, idf=0.0108)
- `frame_close_up_at_first_5s` — 348 videos, 1386 observations (prev=94%, idf=0.0665)
- `frame_close_up_at_mid` — 345 videos, 4135 observations (prev=93%, idf=0.0751)
- `frame_close_up_at_late` — 336 videos, 1965 observations (prev=90%, idf=0.1015)
- `phrase_action_trigger_at_unknown` — 333 videos, 333 observations (prev=90%, idf=0.1104)
- `phrase_personal_stake_at_unknown` — 325 videos, 325 observations (prev=87%, idf=0.1347)
- `frame_close_up_at_first_10s` — 325 videos, 972 observations (prev=87%, idf=0.1347)

## Top 10 mechanisms by specificity-adjusted support (n_videos × IDF, n≥20)
- `compound_frame_natural_lighting_X_segment_hook_at_first_5s` — 136 videos, idf=1.0016, score=136.22
- `compound_frame_close_up_X_segment_setup_at_first_5s` — 139 videos, idf=0.9799, score=136.21
- `segment_setup_at_first_5s` — 143 videos, idf=0.9518, score=136.11
- `frame_motion_at_mid` — 143 videos, idf=0.9518, score=136.11
- `compound_frame_text_overlay_X_segment_setup_at_first_5s` — 143 videos, idf=0.9518, score=136.11
- `frame_close_up_at_hook_quarter` — 129 videos, idf=1.054, score=135.97
- `frame_relatability_at_first_5s` — 147 videos, idf=0.9244, score=135.89
- `frame_relatability_at_first_10s` — 152 videos, idf=0.8911, score=135.45
- `phrase_urgency_at_unknown` — 119 videos, idf=1.1341, score=134.96
- `phrase_transformation_at_unknown` — 118 videos, idf=1.1425, score=134.81

## Top 10 compound (cross-source) mechanisms by specificity-adjusted support (n≥20)
- `compound_frame_natural_lighting_X_segment_hook_at_first_5s` — 136 videos, idf=1.0016
- `compound_frame_close_up_X_segment_setup_at_first_5s` — 139 videos, idf=0.9799
- `compound_frame_text_overlay_X_segment_setup_at_first_5s` — 143 videos, idf=0.9518
- `compound_frame_direct_address_X_segment_hook_at_first_5s` — 105 videos, idf=1.2581
- `compound_frame_relatability_X_segment_hook_at_first_5s` — 88 videos, idf=1.4329
- `compound_frame_direct_address_X_segment_setup_at_first_5s` — 86 videos, idf=1.4557
- `compound_frame_natural_lighting_X_segment_setup_at_first_5s` — 84 videos, idf=1.4789
- `compound_frame_text_overlay_X_segment_main_point_at_mid` — 77 videos, idf=1.5649
- `compound_frame_text_overlay_X_segment_conclusion_at_late` — 76 videos, idf=1.5778
- `compound_frame_close_up_X_segment_main_point_at_mid` — 74 videos, idf=1.6041

## Top 10 components
- `comp_0020` — source_kind: compound (1943 mechanisms)
- `comp_0009` — position_bucket: mid (1363 mechanisms)
- `comp_0034` — kind_at_bucket: compound__mid (1127 mechanisms)
- `comp_0007` — position_bucket: late (500 mechanisms)
- `comp_0018` — source_kind: segment (430 mechanisms)
- `comp_0036` — kind_at_bucket: compound__late (397 mechanisms)
- `comp_0005` — position_bucket: first_10s (325 mechanisms)
- `comp_0039` — kind_at_bucket: compound__first_10s (250 mechanisms)
- `comp_0032` — kind_at_bucket: segment__mid (227 mechanisms)
- `comp_0003` — position_bucket: first_5s (161 mechanisms)

## Top 25 candidate principles by specificity-weighted chain strength
- `princ_00034` — compound_frame_close_up_X_segment_setup_at_first_10s → swipe_away_rate → views | weighted=-0.1477 (raw=-0.0853, prev=17%), n=369
- `princ_00024` — compound_frame_direct_address_X_segment_setup_at_first_5s → swipe_away_rate → views | weighted=0.1424 (raw=0.0978, prev=23%), n=369
- `princ_00023` — compound_frame_direct_address_X_segment_hook_at_first_5s → swipe_away_rate → views | weighted=0.1268 (raw=0.1008, prev=28%), n=369
- `princ_00046` — segment_setup_at_first_10s → swipe_away_rate → views | weighted=-0.1244 (raw=-0.0769, prev=20%), n=369
- `princ_00047` — compound_frame_text_overlay_X_segment_setup_at_first_10s → swipe_away_rate → views | weighted=-0.1244 (raw=-0.0769, prev=20%), n=369
- `princ_00061` — compound_frame_relatability_X_segment_setup_at_first_5s → swipe_away_rate → views | weighted=0.1197 (raw=0.0685, prev=17%), n=369
- `princ_00014` — frame_close_up_at_hook_quarter → swipe_away_rate → views | weighted=-0.1177 (raw=-0.1117, prev=35%), n=369
- `princ_00085` — frame_natural_lighting_at_hook_quarter → swipe_away_rate → views | weighted=-0.1138 (raw=-0.0572, prev=13%), n=369
- `princ_00109` — frame_reveal_at_mid → swipe_away_rate → views | weighted=-0.1118 (raw=-0.0478, prev=9%), n=369
- `princ_00008` — frame_direct_address_at_first_5s → swipe_away_rate → views | weighted=0.1094 (raw=0.1302, prev=43%), n=369
- `princ_00150` — frame_direct_address_at_first_10s → swipe_away_rate → views | weighted=0.1007 (raw=0.0367, prev=6%), n=369
- `princ_00170` — compound_frame_natural_lighting_X_segment_main_point_at_first_10s → swipe_away_rate → views | weighted=0.097 (raw=0.0337, prev=5%), n=369
- `princ_00133` — compound_frame_natural_lighting_X_segment_setup_at_first_10s → swipe_away_rate → views | weighted=-0.0956 (raw=-0.0409, prev=9%), n=369
- `princ_00128` — compound_frame_close_up_X_segment_main_point_at_first_10s → swipe_away_rate → views | weighted=0.0952 (raw=0.0417, prev=10%), n=369
- `princ_00123` — segment_main_point_at_first_10s → swipe_away_rate → views | weighted=0.0913 (raw=0.0427, prev=12%), n=369
- `princ_00124` — compound_frame_text_overlay_X_segment_main_point_at_first_10s → swipe_away_rate → views | weighted=0.0913 (raw=0.0427, prev=12%), n=369
- `princ_00185` — compound_frame_relatability_X_segment_call_to_action_at_late → swipe_away_rate → views | weighted=0.0849 (raw=0.0314, prev=6%), n=369
- `princ_00151` — frame_relatability_at_hook_quarter → swipe_away_rate → views | weighted=-0.0843 (raw=-0.0365, prev=10%), n=369
- `princ_00026` — frame_text_overlay_at_hook_quarter → swipe_away_rate → views | weighted=-0.0798 (raw=-0.0957, prev=43%), n=369
- `princ_00212` — compound_frame_relatability_X_segment_setup_at_first_10s → swipe_away_rate → views | weighted=-0.0716 (raw=-0.0265, prev=6%), n=369
- `princ_00143` — compound_frame_natural_lighting_X_segment_conclusion_at_late → swipe_away_rate → views | weighted=-0.0703 (raw=-0.0378, prev=15%), n=369
- `princ_00179` — segment_introduction_at_first_5s → swipe_away_rate → views | weighted=-0.0689 (raw=-0.0319, prev=11%), n=369
- `princ_00180` — compound_frame_text_overlay_X_segment_introduction_at_first_5s → swipe_away_rate → views | weighted=-0.0689 (raw=-0.0319, prev=11%), n=369
- `princ_00147` — frame_direct_address_at_late → swipe_away_rate → views | weighted=-0.0685 (raw=-0.0368, prev=15%), n=369
- `princ_00210` — compound_frame_motion_X_segment_hook_at_first_5s → swipe_away_rate → views | weighted=-0.0653 (raw=-0.0266, prev=8%), n=369

## Phase results
- phase_1_init: completed
- phase_2_mechanisms: completed
- phase_3_components: completed
- phase_4_principles: completed
- phase_5_bridge: completed
- phase_6_persist: completed

## Notes
Every principle here is **status: candidate**. Promotion is a human pass.
Mechanism IDs are observation-derived; categorization is allowed to evolve.
Tautological chains (e.g. `… → log_views → views`) are filtered per §11: correlation with the outcome is not optimization-worthiness.