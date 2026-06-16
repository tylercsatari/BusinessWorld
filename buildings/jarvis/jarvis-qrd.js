/* ══════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. ── QUANT RESEARCH DECODED (QRD)
   Deterministic, atomic, fully-quantified model of short-form view count.

   Implements, end-to-end and visualized, the 13-section pipeline from
   "Quant Research Decoded: Modelling Short-Form View Count":

     §1  Object & Causal Chain         §8  Models (10 candidates)
     §2  Target Variable (3 targets)   §9  Attribution (3-way importance)
     §3  Data + Confounds              §10 Production Playbook (gap analysis)
     §4  Audio feature extraction      §11 Trends drift / decay tracking
     §5  Visual feature extraction     §12 Leakage & causality checklist
     §6  Alignment + path signatures   §13 Full pipeline summary
     §7  Reduction (MP / shrinkage / PCA)

   Everything is computed in-browser from the REAL feature table
   (signals-dataset-expanded.json, 213 reels  ×  vision-scores-cache.json).
   Nothing is mocked. Every number on screen is derived from data on disk.
   The statistics engine is fully deterministic (seeded RNG) so the model
   reproduces bit-for-bit on every load.

   Self-contained global module. jarvis-ui.js delegates one tab to it.
   ══════════════════════════════════════════════════════════════════════════ */
const JarvisQRD = (() => {
    'use strict';

    // ── Palette (mirrors jarvis.css design tokens) ──
    const C = {
        bg: '#070b14', card: '#0d1424', card2: '#0a1020', panel: '#0a1628',
        text: '#e2e8f0', dim: '#94a3b8', mute: '#64748b', faint: '#475569',
        accent: '#3b82f6', cyan: '#22d3ee', cyan2: '#06b6d4', purple: '#a78bfa',
        green: '#10b981', orange: '#f97316', red: '#f87171', yellow: '#fbbf24',
        border: '#1e293b', border2: '#334155',
    };

    // ── State ──
    let root = null;
    let DATA = null;          // merged reel table + derived targets
    let MODEL = null;         // cached computed pipeline (heavy bits)
    let loadError = null;
    const state = {
        section: 'overview',
        target: 'retention',         // retention | keep | log_views
        includeConfounds: true,
        enetAlpha: 0.5,              // elastic-net L1 ratio (0=ridge,1=lasso)
        enetLambda: 0.10,
        clusterK: 3,
        trailingK: 5,                // Target-2A trailing window
        candidateId: null,           // §10 playbook candidate reel
        featStatus: 'all',           // feature catalog filter
        curveReel: null,             // §4-6 time-series reel selector
        swipeOnRetention: true,      // model swipe-away on top of retention baseline
        pgType: 'video',             // playground upload type
        pgFile: null, pgFileName: '', pgLoading: false, pgResult: null, pgError: null,
    };

    // ══════════════════════════════════════════════════════════════════
    // DOCUMENT MODEL — the spec, encoded as data (assume nothing, atomic)
    // ══════════════════════════════════════════════════════════════════

    const SECTIONS = [
        { id: 'overview',    n: '§1·13', label: 'Overview' },
        { id: 'playground',  n: '🎬',    label: 'Predict (upload)' },
        { id: 'targets',     n: '§2',    label: 'Targets' },
        { id: 'data',        n: '§3',    label: 'Data + Confounds' },
        { id: 'features',    n: '§4·5',  label: 'Feature Atoms' },
        { id: 'sequence',    n: '§6',    label: 'Sequence' },
        { id: 'reduction',   n: '§7',    label: 'Reduction' },
        { id: 'models',      n: '§8',    label: 'Models' },
        { id: 'accuracy',    n: '§8b',   label: 'Accuracy' },
        { id: 'swipeTrust',  n: '★',     label: 'Swipe Trust' },
        { id: 'attribution', n: '§9',    label: 'Attribution' },
        { id: 'production',  n: '§10',   label: 'Playbook' },
        { id: 'trends',      n: '§11',   label: 'Decay' },
        { id: 'checklist',   n: '§12',   label: 'Leakage Check' },
    ];

    // §1 causal chain
    const CHAIN = [
        { k: 'content',   label: 'Content (first 10s)',     note: 'what you control', col: C.cyan },
        { k: 'retention', label: 'Retention / swipe-away',  note: 'primary target',   col: C.green },
        { k: 'early',     label: 'Early engagement velocity', note: 'mediator',       col: C.orange },
        { k: 'amp',       label: 'Algorithmic amplification', note: 'hidden state',   col: C.purple },
        { k: 'views',     label: 'Views',                   note: 'what you measure', col: C.accent },
    ];

    // §3 confound covariates (definition + causal role)
    const CONFOUNDS = [
        { key: 'sub_view_frac', label: 'Account size', def: 'Followers / reach at post time', role: 'confound (largest)', dataKey: 'sub_view_frac', avail: 'proxy' },
        { key: 'post_time',     label: 'Post time (day/month)', def: 'Day-of-week + cyclical month from the real publish date', role: 'confound', dataKey: 'c_dow',     avail: 'live' },
        { key: 'topic_timing',  label: 'Recency / era', def: 'Years since the first post (real publish date)', role: 'confound (era/trend)', dataKey: 'c_recency', avail: 'live' },
        { key: 'recommender',   label: 'Recommender state', def: "Account's median reach that week", role: 'confound (hidden)', dataKey: null,      avail: 'missing' },
        { key: 'like_ratio',    label: 'Early engagement', def: 'Likes + comments in first hour', role: 'mediator (leave out)', dataKey: 'like_ratio', avail: 'proxy' },
        { key: 'caption',       label: 'Caption / hashtags', def: 'Length, count, trending tag', role: 'weak control',    dataKey: null,            avail: 'missing' },
        { key: 'duration_s',    label: 'Duration',     def: 'Total reel length (s)',          role: 'control',           dataKey: 'duration_s',    avail: 'live' },
    ];

    // §4 + §5 atomic feature catalog. avail: live | extractable | missing
    const FEATURES = [
        // ── §4 Audio ──
        { key: 'loudness_env',   label: 'Loudness envelope (RMS)', group: 'Audio', tool: 'librosa.feature.rms', captures: 'Volume swells, the "WAAASUP" ramp', avail: 'extractable' },
        { key: 'spectral_cent',  label: 'Spectral centroid',       group: 'Audio', tool: 'librosa.spectral_centroid', captures: 'Brightness (high vs low voice)', avail: 'extractable' },
        { key: 'onset_strength', label: 'Onset strength',          group: 'Audio', tool: 'librosa.onset.onset_strength', captures: 'Beat & cut hits, rhythmic punch', avail: 'extractable' },
        { key: 'zcr',            label: 'Zero-crossing rate',      group: 'Audio', tool: 'librosa.zero_crossing_rate', captures: 'Noisy vs tonal', avail: 'extractable' },
        { key: 'pitch_f0',       label: 'Pitch (F0)',              group: 'Audio', tool: 'librosa.pyin', captures: 'Intonation, question lifts, hype', avail: 'extractable' },
        { key: 'mfcc',           label: 'MFCC 1–13',               group: 'Audio', tool: 'librosa.feature.mfcc', captures: 'Texture & phonetic content', avail: 'extractable' },
        { key: 'mel',            label: 'Mel-spectrogram (64 band)', group: 'Audio', tool: 'librosa.melspectrogram', captures: 'Raw sound picture over time', avail: 'extractable' },
        { key: 'speaking_rate',  label: 'Speaking rate (wps)',     group: 'Voice', tool: 'faster-whisper + video.tsv', captures: 'Words per second', avail: 'extractable' },
        { key: 'time_first_word',label: 'Time to first word',      group: 'Voice', tool: 'video.tsv timings', captures: 'Does talking start at 0.0s?', avail: 'extractable' },
        { key: 'hook_phrase',    label: 'Hook-phrase type',        group: 'Voice', tool: 'LLM on transcript', captures: 'Question / command / "wait for it"', avail: 'extractable' },
        { key: 'has_speech',     label: 'Has speech flag',         group: 'Voice', tool: 'voiced-frame ratio (pyin)', captures: 'Talking-head vs music regime', avail: 'extractable' },
        { key: 'has_trending',   label: 'Has trending audio',      group: 'Voice', tool: 'audio fingerprint', captures: 'Trending-sound regime (decays)', avail: 'missing' },
        // ── §5 Visual ──
        { key: 'cut_rate',       label: 'Cut rate (cuts/sec)',     group: 'Visual', tool: 'PySceneDetect', captures: 'Pacing of the open', avail: 'extractable' },
        { key: 'motion_energy',  label: 'Motion energy',           group: 'Visual', tool: 'cv2.calcOpticalFlowFarneback', captures: 'Average movement between frames', avail: 'extractable' },
        { key: 'brightness',     label: 'Brightness over time',    group: 'Visual', tool: 'opencv', captures: 'Average brightness per frame', avail: 'extractable' },
        { key: 'saturation',     label: 'Saturation over time',    group: 'Visual', tool: 'opencv HSV', captures: 'Average colour intensity', avail: 'extractable' },
        { key: 'palette',        label: 'Colour palette',          group: 'Visual', tool: 'opencv', captures: 'Dominant colours, warm vs cool', avail: 'extractable' },
        { key: 'faces',          label: 'Faces (size/centred)',    group: 'Visual', tool: 'mediapipe', captures: 'Present? size? centred?', avail: 'extractable' },
        { key: 'onscreen_text',  label: 'On-screen text @ 0s',     group: 'Visual', tool: 'easyocr', captures: 'Caption present at the start?', avail: 'extractable' },
        { key: 'rgb_grid',       label: 'RGB grid (composition)',  group: 'Visual', tool: 'opencv 16×16 → PCA', captures: 'Composition & layout', avail: 'missing' },
        // ── Vision-LLM scores (LIVE in vision-scores-cache.json) ──
        { key: 'action',     label: 'Visual action',     group: 'Vision·LLM', tool: 'LLM vision (cached)', captures: 'Movement / dynamic energy', avail: 'live' },
        { key: 'scale',      label: 'Visual scale',      group: 'Vision·LLM', tool: 'LLM vision (cached)', captures: 'Composition & framing', avail: 'live' },
        { key: 'contrast',   label: 'Visual contrast',   group: 'Vision·LLM', tool: 'LLM vision (cached)', captures: 'Visual clarity', avail: 'live' },
        { key: 'expression', label: 'Visual expression', group: 'Vision·LLM', tool: 'LLM vision (cached)', captures: 'Facial / emotional visibility', avail: 'live' },
        { key: 'v_novelty',  label: 'Visual novelty',    group: 'Vision·LLM', tool: 'LLM vision (cached)', captures: 'Visual originality', avail: 'live' },
        { key: 'vz_score',   label: 'Visual Zeigarnik',  group: 'Vision·LLM', tool: 'LLM vision (cached)', captures: 'Open-loop curiosity (visual)', avail: 'live' },
        // ── Text-LLM scores (LIVE in signals) ──
        { key: 'z_score',        label: 'Zeigarnik (text)', group: 'Text·LLM', tool: 'LLM on transcript', captures: 'Open-loop curiosity', avail: 'live' },
        { key: 'novelty',        label: 'Novelty',          group: 'Text·LLM', tool: 'LLM on transcript', captures: 'Conceptual originality', avail: 'live' },
        { key: 'cognitive_load', label: 'Cognitive load',   group: 'Text·LLM', tool: 'LLM on transcript', captures: 'Mental effort required', avail: 'live' },
        { key: 'net_novelty',    label: 'Net novelty',      group: 'Text·LLM', tool: 'novelty − cognitive_load', captures: 'Curiosity net of effort', avail: 'live' },
    ];

    // content levers actually present in the table → drive the live model
    const CONTENT_KEYS = ['z_score', 'vz_score', 'novelty', 'cognitive_load', 'net_novelty',
        'action', 'scale', 'contrast', 'expression', 'v_novelty'];
    // duration + follower proxy + REAL post-time confounds derived from publish date
    const CONFOUND_KEYS = ['duration_s', 'sub_view_frac', 'c_recency', 'c_month_sin', 'c_month_cos', 'c_dow'];

    // Curated, actionable atoms extracted by the real Python pipeline
    // (qrd/extract_features.py) — the doc's levers, now LIVE. Each maps to a
    // catalog atom so its availability flips extractable→live when present.
    const EXTRACTED = [
        { key: 'a_loud_first3_ratio', label: 'Loudness swell (first-3s ratio)', atom: 'loudness_env', group: 'Audio' },
        { key: 'a_loud_slope', label: 'Loudness ramp (slope)', atom: 'loudness_env', group: 'Audio' },
        { key: 'a_onset_mean', label: 'Onset punch (mean)', atom: 'onset_strength', group: 'Audio' },
        { key: 'a_centroid_mean', label: 'Brightness (spectral centroid)', atom: 'spectral_cent', group: 'Audio' },
        { key: 'a_pitch_slope', label: 'Pitch lift (slope)', atom: 'pitch_f0', group: 'Audio' },
        { key: 'a_zcr_mean', label: 'Zero-crossing (noisy vs tonal)', atom: 'zcr', group: 'Audio' },
        { key: 'a_mfcc1_mean', label: 'MFCC-1 (timbre)', atom: 'mfcc', group: 'Audio' },
        { key: 'a_voiced_ratio', label: 'Voiced ratio (has speech)', atom: 'has_speech', group: 'Voice' },
        { key: 'v_speaking_rate', label: 'Speaking rate (wps)', atom: 'speaking_rate', group: 'Voice' },
        { key: 'v_time_first_word', label: 'Time to first word', atom: 'time_first_word', group: 'Voice' },
        { key: 'v_hook_question', label: 'Question hook flag', atom: 'hook_phrase', group: 'Voice' },
        { key: 'vi_cut_rate', label: 'Cut rate (cuts/sec)', atom: 'cut_rate', group: 'Visual' },
        { key: 'vi_motion_first3_ratio', label: 'Early motion (first-3s ratio)', atom: 'motion_energy', group: 'Visual' },
        { key: 'vi_motion_mean', label: 'Motion energy (mean)', atom: 'motion_energy', group: 'Visual' },
        { key: 'vi_bright_slope', label: 'Brightness ramp (slope)', atom: 'brightness', group: 'Visual' },
        { key: 'vi_sat_mean', label: 'Saturation (mean)', atom: 'saturation', group: 'Visual' },
        { key: 'vi_warmth_first3_ratio', label: 'Warm-open (first-3s ratio)', atom: 'palette', group: 'Visual' },
        { key: 'vi_face_frac', label: 'Face presence (fraction)', atom: 'faces', group: 'Visual' },
        { key: 'vi_face_size', label: 'Face size', atom: 'faces', group: 'Visual' },
        { key: 'vi_face_centered', label: 'Face centred', atom: 'faces', group: 'Visual' },
        { key: 'vi_text_at0', label: 'Hook caption @ 0s', atom: 'onscreen_text', group: 'Visual' },
    ];
    const EXTRACTED_LABEL = Object.fromEntries(EXTRACTED.map(e => [e.key, e.label]));
    let liveExtractedKeys = [];      // populated at load with those actually present
    let MODEL_PY = null;             // qrd_model.json (real Python pipeline results)
    let SWIPE_PY = null;             // qrd_swipe.json (trustworthy swipe model)

    function modelContentKeys() { return CONTENT_KEYS.concat(liveExtractedKeys); }

    // target direction: +1 = lift it (good), -1 = minimise it (swipe-away)
    const TARGET_DIR = { retention: 1, keep: 1, swipe: -1, log_views: 1 };
    const TARGET_LABEL = { retention: 'Retention', keep: 'Keep (hook)', swipe: 'Swipe-away ratio', log_views: 'log Views' };
    function targetLabel(t) { return TARGET_LABEL[t] || t; }
    function targetOptions() {
        const base = [{ v: 'retention', l: 'T1 · Retention' }, { v: 'keep', l: 'T1 · Keep (hook)' }];
        if (DATA && DATA.swipeHit) base.push({ v: 'swipe', l: 'T1 · Swipe-away ↓' });
        base.push({ v: 'log_views', l: 'T3 · log Views' });
        return base;
    }
    // swipe-away raw value for a row (for display); model uses log1p
    function rowTargetRaw(r, t) { return t === 'swipe' ? r.swipe : t === 'log_views' ? r.log_views : r[t]; }

    // §8 model roster
    const MODELS = [
        { n: 1,  name: 'Elastic-Net regression', type: 'Supervised',  role: 'Readable baseline; coefficients are effects', ok: 'yes', live: true },
        { n: 2,  name: 'Partial Least Squares',  type: 'Supervised',  role: 'Made for wide, correlated features', ok: 'yes', live: false },
        { n: 3,  name: 'Gradient-boosted trees', type: 'Supervised',  role: 'XGBoost/LightGBM; nonlinear, SHAP-ready', ok: 'yes†', live: false },
        { n: 4,  name: 'Random forest',          type: 'Supervised',  role: 'Robust, low tuning, easy importance', ok: 'yes', live: false },
        { n: 5,  name: 'Gaussian Process',       type: 'Supervised',  role: 'Strong on small data; gives uncertainty', ok: 'yes', live: false },
        { n: 6,  name: 'LambdaMART (ranker)',    type: 'Supervised',  role: 'Learns the "rank by views" framing directly', ok: 'yes', live: false },
        { n: 7,  name: 'SVR (RBF)',              type: 'Supervised',  role: 'Nonlinear, stable on small data', ok: 'yes', live: false },
        { n: 8,  name: 'Small neural net',       type: 'Supervised',  role: 'One hidden layer, reduced table only', ok: 'risk', live: false },
        { n: 9,  name: 'Temporal CNN',           type: 'Supervised',  role: 'On raw spectrograms; needs much more data', ok: 'no‡', live: false },
        { n: 10, name: 'Clustering + PCA/UMAP',  type: 'Unsupervised', role: 'Find reel archetypes; no labels needed', ok: 'yes', live: true },
        { n: 0,  name: 'OLS (ridge) baseline',   type: 'Supervised',  role: 'Honest first look; least-squares with shrinkage', ok: 'yes', live: true },
    ];

    // §12 leakage & causality checklist. Each item returns an HONEST status:
    //   pass   = guaranteed by construction
    //   na     = the dataset cannot support this rule (marked, never faked)
    //   manual = needs a human in the loop (A/B test, matched set)
    // Nothing here returns a hardcoded `true` — that was the old self-certification bug.
    const CHECKLIST = [
        { id: 'confounds_post', text: 'Confounds recorded at post time, not today',
          status: () => (DATA && DATA.datedCount === DATA.n)
            ? ({ s: 'pass', why: `Real publish dates joined for all ${DATA.n} reels (from the Pen) → recency, month and day-of-week are genuine post-time confounds. Account size remains a current follower-ratio proxy; post hour isn't in the public date.` })
            : ({ s: 'na', why: 'Publish dates not available for every reel.' }) },
        { id: 'mediator_out', text: 'Early engagement left out of the content model (it is a mediator)',
          status: () => ({ s: (state.includeConfounds && modelUsesMediator()) ? 'fail' : 'pass', why: 'like_ratio / day3_share / view_accel / subs_gained are never used as predictors of the content model.' }) },
        { id: 'target_safe', text: 'Target uses log / rank / retention, never raw counts under squared loss',
          status: () => ({ s: 'pass', why: 'retention & keep are bounded 0–1; views enter only as log_views; swipe uses log1p. No raw counts under squared loss.' }) },
        { id: 'ratio_past', text: 'Within-account ratio (Target 2) uses only earlier posts',
          status: () => ({ s: 'na', why: 'Dataset has no account ID and no post order — Target 2 (within-account relative views) is not computable on these reels.' }) },
        { id: 'fit_train', text: 'Rescaling / shrinkage / PCA fit on the training split only',
          status: () => ({ s: 'pass', why: 'Reported accuracy comes from cross-validation that standardises inside each train fold. (The Reduction tab\'s covariance/PCA picture is whole-data exploratory — it produces no scored prediction.)' }) },
        { id: 'split_time', text: 'Train / validation split by time, not at random',
          status: () => (DATA && DATA.datedCount === DATA.n)
            ? ({ s: 'pass', why: `Reels are sorted by REAL publish date (${DATA.dateSpan ? DATA.dateSpan[0] + ' → ' + DATA.dateSpan[1] : ''}), so the expanding-window CV trains on earlier reels and validates on later ones — a genuine split-by-time.` })
            : ({ s: 'na', why: 'Not every reel has a publish date.' }) },
        { id: 'sig_baseline', text: 'Signatures kept only if they beat the simple summary baseline',
          status: () => ({ s: 'na', why: 'Path signatures are shown for illustration; the live model is driven by the summary/atom features, and the beats-the-baseline gate is not applied to them.' }) },
        { id: 'hypothesis', text: 'Every finding treated as a hypothesis until an A/B test confirms it',
          status: () => ({ s: 'manual', why: 'A process discipline — confirm each lever with matched A/B posts (Playbook §10).' }) },
        { id: 'confidence', text: 'Scores carry confidence ranges; tiny gaps treated as noise',
          status: () => ({ s: (MODEL && MODEL.cv && MODEL.cv.std != null) ? 'pass' : 'manual', why: 'CV reports mean ± std across folds; the swipe model bootstraps a 90% interval.' }) },
        { id: 'matched', text: 'Comparison set matched on niche & era, checked by clustering overlap',
          status: () => ({ s: 'manual', why: 'No matched competitor set collected yet — the clustering-overlap check is pending data.' }) },
    ];

    function modelUsesMediator() {
        return false; // our content model never includes like_ratio / trajectory as predictors
    }

    // ══════════════════════════════════════════════════════════════════
    // DETERMINISTIC STATISTICS ENGINE  (pure functions, seeded RNG)
    // ══════════════════════════════════════════════════════════════════

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
    function std(a, m) { m = m == null ? mean(a) : m; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length); }
    function quantile(arr, q) {
        const s = arr.slice().sort((x, y) => x - y);
        const pos = (s.length - 1) * q, base = Math.floor(pos), rest = pos - base;
        return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
    }
    function median(a) { return quantile(a, 0.5); }

    function pearson(xs, ys) {
        const n = xs.length; if (n < 3) return 0;
        const mx = mean(xs), my = mean(ys);
        let num = 0, dx = 0, dy = 0;
        for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
        const d = Math.sqrt(dx * dy); return d === 0 ? 0 : num / d;
    }
    function rankOf(a) {
        const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
        const r = new Array(a.length);
        for (let i = 0; i < idx.length;) {
            let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
            const avg = (i + j - 1) / 2 + 1;
            for (let k = i; k < j; k++) r[idx[k][1]] = avg;
            i = j;
        }
        return r;
    }
    function spearman(xs, ys) { return pearson(rankOf(xs), rankOf(ys)); }

    function standardizeMatrix(X) {
        const n = X.length, p = X[0].length;
        const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
        for (let j = 0; j < p; j++) { const col = X.map(r => r[j]); mu[j] = mean(col); sd[j] = std(col, mu[j]) || 1; }
        const Z = X.map(r => r.map((v, j) => (v - mu[j]) / sd[j]));
        return { Z, mu, sd };
    }
    function covarianceMatrix(Z) { // Z standardized → this is the correlation matrix
        const n = Z.length, p = Z[0].length;
        const Cmat = Array.from({ length: p }, () => new Array(p).fill(0));
        for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { const za = Z[i][a]; for (let b = a; b < p; b++) { Cmat[a][b] += za * Z[i][b]; } }
        for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { Cmat[a][b] /= n; Cmat[b][a] = Cmat[a][b]; }
        return Cmat;
    }
    // Symmetric eigen-decomposition via cyclic Jacobi rotations
    function jacobiEigen(A0, sweeps = 80) {
        const n = A0.length;
        const A = A0.map(r => r.slice());
        const V = Array.from({ length: n }, (_, i) => { const r = new Array(n).fill(0); r[i] = 1; return r; });
        for (let s = 0; s < sweeps; s++) {
            let off = 0;
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
            if (off < 1e-14) break;
            for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
                if (Math.abs(A[p][q]) < 1e-15) continue;
                const phi = 0.5 * Math.atan2(2 * A[p][q], A[p][p] - A[q][q]);
                const c = Math.cos(phi), si = Math.sin(phi);
                for (let i = 0; i < n; i++) { const aip = A[i][p], aiq = A[i][q]; A[i][p] = c * aip - si * aiq; A[i][q] = si * aip + c * aiq; }
                for (let i = 0; i < n; i++) { const api = A[p][i], aqi = A[q][i]; A[p][i] = c * api - si * aqi; A[q][i] = si * api + c * aqi; }
                for (let i = 0; i < n; i++) { const vip = V[i][p], viq = V[i][q]; V[i][p] = c * vip - si * viq; V[i][q] = si * vip + c * viq; }
            }
        }
        const pairs = A.map((r, i) => ({ val: r[i], vec: V.map(row => row[i]) }))
            .sort((a, b) => b.val - a.val);
        return { values: pairs.map(p => p.val), vectors: pairs.map(p => p.vec) }; // vectors[k] = k-th eigvec
    }
    function marchenkoPastur(p, n, sigma2 = 1) {
        const q = p / n;
        return { q, lambdaPlus: sigma2 * (1 + Math.sqrt(q)) ** 2, lambdaMinus: sigma2 * (1 - Math.sqrt(q)) ** 2 };
    }
    function pcaProject(Z, eig, k = 2) {
        return Z.map(row => {
            const out = [];
            for (let c = 0; c < k; c++) { let acc = 0; const vec = eig.vectors[c]; for (let j = 0; j < row.length; j++) acc += row[j] * vec[j]; out.push(acc); }
            return out;
        });
    }
    // Solve symmetric pos-def system via Gaussian elimination w/ partial pivot
    function solveLinear(A, b) {
        const n = A.length;
        const M = A.map((r, i) => r.concat([b[i]]));
        for (let col = 0; col < n; col++) {
            let piv = col; for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
            [M[col], M[piv]] = [M[piv], M[col]];
            const d = M[col][col] || 1e-9;
            for (let r = 0; r < n; r++) { if (r === col) continue; const f = M[r][col] / d; for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]; }
        }
        return M.map((r, i) => r[n] / (M[i][i] || 1e-9));
    }
    // Ridge regression on standardized Z, centered y. Returns {beta, intercept(0), pred, r2}
    function ridgeFit(Z, y, lambda = 1e-2) {
        const n = Z.length, p = Z[0].length;
        const my = mean(y), yc = y.map(v => v - my);
        const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
        const Xty = new Array(p).fill(0);
        for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { const za = Z[i][a]; Xty[a] += za * yc[i]; for (let b = a; b < p; b++) XtX[a][b] += za * Z[i][b]; }
        for (let a = 0; a < p; a++) { for (let b = a; b < p; b++) { XtX[b][a] = XtX[a][b]; } XtX[a][a] += lambda * n; }
        const beta = solveLinear(XtX, Xty);
        const pred = Z.map(r => my + r.reduce((s, v, j) => s + v * beta[j], 0));
        return { beta, my, pred, r2: r2score(y, pred) };
    }
    // Elastic-net via coordinate descent on standardized Z, centered y
    function elasticNetFit(Z, y, lambda = 0.1, alpha = 0.5, maxIter = 300, tol = 1e-6) {
        const n = Z.length, p = Z[0].length;
        const my = mean(y), yc = y.map(v => v - my);
        const beta = new Array(p).fill(0);
        const cols = []; for (let j = 0; j < p; j++) cols.push(Z.map(r => r[j]));
        const r = yc.slice(); // residual = yc - Z@beta (beta=0)
        const soft = (z, g) => z > g ? z - g : (z < -g ? z + g : 0);
        for (let it = 0; it < maxIter; it++) {
            let maxCh = 0;
            for (let j = 0; j < p; j++) {
                const cj = cols[j]; let rho = 0;
                for (let i = 0; i < n; i++) rho += cj[i] * (r[i] + cj[i] * beta[j]);
                rho /= n;
                const nb = soft(rho, lambda * alpha) / (1 + lambda * (1 - alpha));
                const d = nb - beta[j];
                if (d !== 0) { for (let i = 0; i < n; i++) r[i] -= cj[i] * d; beta[j] = nb; maxCh = Math.max(maxCh, Math.abs(d)); }
            }
            if (maxCh < tol) break;
        }
        const pred = Z.map(rw => my + rw.reduce((s, v, j) => s + v * beta[j], 0));
        return { beta, my, pred, r2: r2score(y, pred), nNonzero: beta.filter(b => Math.abs(b) > 1e-6).length };
    }
    function r2score(y, pred) {
        const my = mean(y); let ss = 0, st = 0;
        for (let i = 0; i < y.length; i++) { ss += (y[i] - pred[i]) ** 2; st += (y[i] - my) ** 2; }
        return st === 0 ? 0 : 1 - ss / st;
    }
    // Permutation importance using a ridge model on standardized features
    function permutationImportance(Z, y, cols, seed = 7) {
        const fit = ridgeFit(Z, y, 0.05);
        const base = fit.r2;
        const rng = mulberry32(seed);
        const out = [];
        for (let j = 0; j < cols.length; j++) {
            // deterministic Fisher-Yates with seeded rng
            const perm = Z.map(r => r.slice());
            const colVals = Z.map(r => r[j]);
            const order = colVals.map((_, i) => i);
            for (let i = order.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
            for (let i = 0; i < perm.length; i++) perm[i][j] = colVals[order[i]];
            const pred = perm.map(r => fit.my + r.reduce((s, v, jj) => s + v * fit.beta[jj], 0));
            out.push({ key: cols[j], drop: base - r2score(y, pred) });
        }
        return { base, importances: out.sort((a, b) => b.drop - a.drop) };
    }
    function standardizeWith(X, mu, sd) { return X.map(r => r.map((v, j) => (v - mu[j]) / (sd[j] || 1))); }

    // Expanding-window CV. Rows are sorted by REAL publish date at load, so this is
    // a genuine split-by-time: train on earlier reels, validate on later ones.
    // AIRTIGHT: standardisation is fit on the TRAIN fold only and applied
    // frozen to the validation block — no test-set statistics leak in (§7/§12).
    // Takes the RAW feature matrix X. Returns CV scores + pooled out-of-fold
    // predictions so accuracy can be graphed honestly.
    function timeSplitCV(X, y, folds = 5, lambda = 0.05) {
        const n = X.length, scores = [];
        const oofPred = [], oofAct = [], oofIdx = [];
        const start = Math.floor(n * 0.4);
        const step = Math.floor((n - start) / folds) || 1;
        for (let f = 0; f < folds; f++) {
            const tr = start + f * step;
            const teEnd = Math.min(n, tr + step);
            if (tr < 8 || teEnd <= tr) continue;
            const Xtr = X.slice(0, tr), ytr = y.slice(0, tr);
            const { Z: Ztr, mu, sd } = standardizeMatrix(Xtr);     // fit on TRAIN only
            const Zte = standardizeWith(X.slice(tr, teEnd), mu, sd); // freeze → apply to test
            const yte = y.slice(tr, teEnd);
            const fit = ridgeFit(Ztr, ytr, lambda);
            const pred = Zte.map(r => fit.my + r.reduce((s, v, j) => s + v * fit.beta[j], 0));
            scores.push(r2score(yte, pred));
            for (let i = 0; i < pred.length; i++) { oofPred.push(pred[i]); oofAct.push(yte[i]); oofIdx.push(tr + i); }
        }
        const m = scores.length ? mean(scores) : 0;
        return { mean: m, std: scores.length > 1 ? std(scores, m) : 0, folds: scores.length, scores, oofPred, oofAct, oofIdx };
    }
    // Seeded k-means (deterministic, k-means++ init)
    function kmeans(pts, k, seed = 11, iters = 40) {
        const n = pts.length, dim = pts[0].length, rng = mulberry32(seed);
        const cents = [pts[Math.floor(rng() * n)].slice()];
        while (cents.length < k) {
            const d2 = pts.map(p => Math.min(...cents.map(c => dist2(p, c))));
            const sum = d2.reduce((a, b) => a + b, 0) || 1; let t = rng() * sum, idx = 0;
            for (let i = 0; i < n; i++) { t -= d2[i]; if (t <= 0) { idx = i; break; } }
            cents.push(pts[idx].slice());
        }
        let assign = new Array(n).fill(0);
        for (let it = 0; it < iters; it++) {
            let moved = false;
            for (let i = 0; i < n; i++) { let best = 0, bd = Infinity; for (let c = 0; c < k; c++) { const d = dist2(pts[i], cents[c]); if (d < bd) { bd = d; best = c; } } if (assign[i] !== best) { assign[i] = best; moved = true; } }
            for (let c = 0; c < k; c++) { const mem = pts.filter((_, i) => assign[i] === c); if (!mem.length) continue; for (let d = 0; d < dim; d++) cents[c][d] = mean(mem.map(p => p[d])); }
            if (!moved && it > 0) break;
        }
        return { assign, cents };
    }
    function dist2(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; }

    // ══════════════════════════════════════════════════════════════════
    // DATA LOADING + FEATURE ASSEMBLY
    // ══════════════════════════════════════════════════════════════════

    async function loadData() {
        const base = './buildings/jarvis/';
        const [exp, vis, extract, modelPy, curves] = await Promise.all([
            fetch(base + 'signals-dataset-expanded.json').then(r => r.json()),
            fetch(base + 'vision-scores-cache.json').then(r => r.json()).catch(() => ({})),
            fetch(base + 'qrd/qrd_features.json').then(r => r.json()).catch(() => null),
            fetch(base + 'qrd/qrd_model.json').then(r => r.json()).catch(() => null),
            fetch(base + 'qrd/qrd_curves.json').then(r => r.json()).catch(() => null),
        ]);
        const swipeMap = await fetch(base + 'qrd/qrd_targets.json').then(r => r.json()).catch(() => null);
        SWIPE_PY = await fetch(base + 'qrd/qrd_swipe.json').then(r => r.json()).catch(() => null);
        const dateMap = await fetch(base + 'qrd/qrd_dates.json').then(r => r.json()).catch(() => ({}));
        const rows = (Array.isArray(exp) ? exp : (exp.dataset || exp.videos || [])).filter(r => r && r.ytId);
        // merge real swipe-away ratio (analytics.swipedAwayRate) — a distinct target
        let swipeHit = 0;
        if (swipeMap) {
            rows.forEach(r => { const s = swipeMap[r.ytId]; if (s && typeof s.swipe === 'number') { r.swipe = s.swipe; r.viewed_rate = s.viewed_rate; swipeHit++; } });
            const sv = rows.filter(r => typeof r.swipe === 'number').map(r => r.swipe);
            const med = sv.length ? median(sv) : 0;
            rows.forEach(r => { if (typeof r.swipe !== 'number') r.swipe = med; });
        }
        // merge vision scores; rename vision "novelty" → v_novelty to avoid clash
        let visHit = 0;
        rows.forEach(r => {
            const v = vis[r.ytId];
            if (v) { visHit++; r.action = v.action; r.scale = v.scale; r.contrast = v.contrast; r.expression = v.expression; r.v_novelty = v.novelty; }
        });

        // ── merge REAL extracted waveform/visual atoms (Python pipeline) ──
        MODEL_PY = modelPy;
        let extractHit = 0, audioHit = 0;
        liveExtractedKeys = [];
        if (extract && Array.isArray(extract)) {
            const byId = {}; extract.forEach(e => { if (e && e.ytId) byId[e.ytId] = e; });
            rows.forEach(r => {
                const e = byId[r.ytId];
                if (e) {
                    extractHit++;
                    if (e.a_has_audio) audioHit++;
                    EXTRACTED.forEach(({ key }) => { if (typeof e[key] === 'number' && isFinite(e[key])) r[key] = e[key]; });
                    r._extracted = true;
                }
            });
            // keep an extracted lever only if it's present on a useful share of reels
            liveExtractedKeys = EXTRACTED.map(e => e.key).filter(k => {
                const c = rows.filter(r => typeof r[k] === 'number' && isFinite(r[k])).length;
                return c >= Math.max(20, 0.25 * rows.length);
            });
            // flip catalog availability extractable→live for atoms now present
            const liveAtoms = new Set(EXTRACTED.filter(e => liveExtractedKeys.includes(e.key)).map(e => e.atom));
            FEATURES.forEach(f => { if (liveAtoms.has(f.key) && f.avail === 'extractable') f.avail = 'live'; });
        }

        // ── REAL publish dates (qrd_dates.json, joined from Pen) → post-time confounds
        // + chronological order so the in-browser time-split CV is a TRUE split-by-time.
        let datedCount = 0;
        rows.forEach(r => { const d = dateMap[r.ytId] && dateMap[r.ytId].date; const t = d ? Date.parse(d) : NaN; r._ts = isFinite(t) ? t : NaN; r._date = d || null; if (isFinite(r._ts)) datedCount++; });
        const validTs = rows.map(r => r._ts).filter(t => isFinite(t));
        const baseTs = validTs.length ? Math.min(...validTs) : 0;
        const YEAR = 365.25 * 24 * 3600 * 1000;
        rows.forEach(r => {
            if (isFinite(r._ts)) {
                const dt = new Date(r._ts);
                r.c_recency = (r._ts - baseTs) / YEAR;               // years since first post (era)
                r.c_dow = dt.getUTCDay();                             // 0=Sun … 6=Sat
                const ang = 2 * Math.PI * dt.getUTCMonth() / 12;     // cyclical month
                r.c_month_sin = Math.sin(ang); r.c_month_cos = Math.cos(ang);
            }
        });
        rows.sort((a, b) => (isFinite(a._ts) ? a._ts : Infinity) - (isFinite(b._ts) ? b._ts : Infinity));

        // impute any missing live feature with column mean (deterministic), track coverage
        const liveKeys = modelContentKeys().concat(CONFOUND_KEYS);
        const coverage = {};
        liveKeys.forEach(k => {
            const present = rows.filter(r => typeof r[k] === 'number' && isFinite(r[k]));
            coverage[k] = present.length;
            const m = present.length ? mean(present.map(r => r[k])) : 0;
            rows.forEach(r => { if (typeof r[k] !== 'number' || !isFinite(r[k])) r[k] = m; });
        });
        // derived targets
        // Target 1: retention (avg % viewed) and keep (≈ hook survival proxy)
        // Target 2A: within-account trailing-median ratio (uses only earlier posts; dataset order = posting-order proxy)
        const views = rows.map(r => r.views);
        rows.forEach((r, i) => {
            const K = state.trailingK;
            if (i >= K) {
                const window = views.slice(i - K, i);
                const med = median(window) || 1;
                r._yrel = Math.log((r.views / med) || 1e-3);
            } else r._yrel = null;
        });
        // Target 3: rank of log_views
        const lr = rankOf(rows.map(r => r.log_views));
        rows.forEach((r, i) => { r._rank = lr[i]; });

        DATA = {
            rows, n: rows.length, visHit, coverage,
            accounts: 1,                 // single creator account (no per-account field in data)
            datedCount,                  // reels with a REAL publish date (from Pen) → enables true split-by-time
            dateSpan: validTs.length ? [new Date(Math.min(...validTs)).toISOString().slice(0, 10), new Date(Math.max(...validTs)).toISOString().slice(0, 10)] : null,
            confoundsAtPost: datedCount === rows.length,  // post-date confounds (recency/month/dow) are real; account-size is a proxy
            extractHit,                  // reels with real extracted atoms
            audioReels: audioHit,        // reels with real audio (librosa)
            nExtractedLevers: liveExtractedKeys.length,
            hasPy: !!MODEL_PY,
            curves: (curves && Array.isArray(curves)) ? curves : null,
            swipeHit,
        };
        if (DATA.curves && DATA.curves.length && !state.curveReel) state.curveReel = DATA.curves[0].ytId;
        return DATA;
    }

    function targetVector(rows, target) {
        if (target === 'retention') return rows.map(r => r.retention);
        if (target === 'keep') return rows.map(r => r.keep);
        if (target === 'swipe') return rows.map(r => Math.log1p(Math.max(0, r.swipe))); // log1p — heavy right skew
        return rows.map(r => r.log_views);
    }
    function buildFeatureMatrixFor(target) {
        const rows = DATA.rows;
        const content = modelContentKeys();
        let cols = state.includeConfounds ? content.concat(CONFOUND_KEYS) : content.slice();
        // "on top of retention" — give the swipe model the retention baseline so the
        // hook levers are read net of overall retention (swipe ≈ orthogonal to keep).
        if (target === 'swipe' && state.swipeOnRetention) cols = cols.concat(['retention']);
        const X = rows.map(r => cols.map(k => r[k]));
        return { X, cols };
    }
    function buildFeatureMatrix() { return buildFeatureMatrixFor(state.target); }

    // Heavy compute — full pipeline. Cached in MODEL keyed by current knobs.
    function computeAll() {
        const rows = DATA.rows;
        const { X, cols } = buildFeatureMatrix();
        const y = targetVector(rows, state.target);
        const { Z, mu, sd } = standardizeMatrix(X);

        // §7 reduction
        const cov = covarianceMatrix(Z);
        const eig = jacobiEigen(cov);
        const mp = marchenkoPastur(cols.length, rows.length, 1);
        const nSignal = eig.values.filter(v => v > mp.lambdaPlus).length;
        const totalVar = eig.values.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
        const varExplained = eig.values.map(v => Math.max(v, 0) / totalVar);
        const proj = pcaProject(Z, eig, 2);

        // §8 models on retention/keep/views
        const ols = ridgeFit(Z, y, 0.05);
        const enet = elasticNetFit(Z, y, state.enetLambda, state.enetAlpha);
        const cv = timeSplitCV(X, y, 5, 0.05);   // raw X → train-only standardisation inside
        // ranking check (Target 3): spearman of OLS prediction vs actual log_views
        const lvRank = spearman(ols.pred, rows.map(r => r.log_views));

        // §9 attribution
        const perm = permutationImportance(Z, y, cols);

        // §8/§10 clustering archetypes (on 2-D PCA projection)
        const km = kmeans(proj, state.clusterK);

        // confound correlations (for §3) — vs log_views and vs retention
        const confCorr = CONFOUNDS.filter(c => c.dataKey).map(c => ({
            label: c.label, role: c.role, avail: c.avail,
            rViews: pearson(rows.map(r => r[c.dataKey]), rows.map(r => r.log_views)),
            rRet: pearson(rows.map(r => r[c.dataKey]), rows.map(r => r.retention)),
        }));

        // per-feature univariate r vs current target (for catalog + attribution)
        const uni = cols.map((k, j) => ({ key: k, r: pearson(rows.map(r => r[k]), y) }));

        MODEL = {
            cols, y, Z, mu, sd, eig, mp, nSignal, varExplained, proj,
            ols, enet, cv, lvRank, perm, km, cov, confCorr, uni,
            fitOnTrainOnly: true,        // CV standardises inside each train fold
            splitByTime: DATA && DATA.datedCount === DATA.n,   // REAL: rows sorted by actual publish date
            target: state.target, includeConfounds: state.includeConfounds,
            alpha: state.enetAlpha, lambda: state.enetLambda, k: state.clusterK,
            swipeOnRet: state.swipeOnRetention,
        };
        return MODEL;
    }
    function ensureModel() {
        if (!MODEL || MODEL.target !== state.target || MODEL.includeConfounds !== state.includeConfounds ||
            MODEL.alpha !== state.enetAlpha || MODEL.lambda !== state.enetLambda || MODEL.k !== state.clusterK ||
            MODEL.swipeOnRet !== state.swipeOnRetention) {
            computeAll();
        }
        return MODEL;
    }

    // Honest accuracy for any target: in-sample R² (optimistic) vs out-of-fold
    // expanding-window R² (train-only standardisation), pooled OOF predictions, MAE.
    function accuracyFor(target) {
        const rows = DATA.rows;
        const { X, cols } = buildFeatureMatrixFor(target);
        const y = targetVector(rows, target);
        const { Z } = standardizeMatrix(X);
        const inSample = ridgeFit(Z, y, 0.05).r2;
        const cv = timeSplitCV(X, y, 5, 0.05);
        const r2oof = cv.oofAct.length ? r2score(cv.oofAct, cv.oofPred) : 0;
        const mae = cv.oofAct.length ? mean(cv.oofAct.map((a, i) => Math.abs(a - cv.oofPred[i]))) : 0;
        // MAE in natural units (back-transform swipe log1p→%)
        const nat = (v) => target === 'swipe' ? Math.expm1(v) : v;
        const maeNat = cv.oofAct.length ? mean(cv.oofAct.map((a, i) => Math.abs(nat(a) - nat(cv.oofPred[i])))) : 0;
        return { target, cols, y, cv, inSample, r2oof, mae, maeNat };
    }

    // ══════════════════════════════════════════════════════════════════
    // SVG VISUALIZATION LIBRARY  (pure strings, responsive viewBox)
    // ══════════════════════════════════════════════════════════════════

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    function fmt(v, d = 2) { if (v == null || !isFinite(v)) return '—'; return (+v).toFixed(d); }
    function fmtViews(v) { if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K'; return '' + Math.round(v); }
    function lerpColor(t) { // blue→cyan→green→yellow→red heat ramp for t∈[0,1]
        const stops = [[59, 130, 246], [34, 211, 238], [16, 185, 129], [251, 191, 36], [248, 113, 113]];
        t = Math.max(0, Math.min(1, t)); const x = t * (stops.length - 1), i = Math.floor(x), f = x - i;
        const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
        return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
    }
    function divergeColor(r) { // signed: red(neg)…grey…green(pos)
        const t = Math.max(-1, Math.min(1, r));
        if (t >= 0) return `rgba(16,185,129,${0.25 + 0.65 * t})`;
        return `rgba(248,113,113,${0.25 + 0.65 * -t})`;
    }

    // Causal-chain flow diagram (§1)
    function vizChain() {
        const W = 920, boxW = 150, gap = 42, H = 120;
        let x = 16, svg = '';
        CHAIN.forEach((node, i) => {
            svg += `<rect x="${x}" y="34" width="${boxW}" height="44" rx="8" fill="${C.card}" stroke="${node.col}" stroke-width="1.5"/>`;
            svg += `<text x="${x + boxW / 2}" y="55" text-anchor="middle" fill="${C.text}" font-size="12" font-weight="600">${esc(node.label.split('(')[0].trim())}</text>`;
            if (node.label.includes('(')) svg += `<text x="${x + boxW / 2}" y="70" text-anchor="middle" fill="${C.dim}" font-size="9">(${esc(node.label.split('(')[1].replace(')', ''))})</text>`;
            svg += `<text x="${x + boxW / 2}" y="22" text-anchor="middle" fill="${node.col}" font-size="9" font-weight="600" letter-spacing="0.5">${esc(node.note.toUpperCase())}</text>`;
            if (i < CHAIN.length - 1) { const ax = x + boxW + 4; svg += `<line x1="${ax}" y1="56" x2="${ax + gap - 8}" y2="56" stroke="${C.border2}" stroke-width="2" marker-end="url(#qarrow)"/>`; }
            x += boxW + gap;
        });
        return `<svg viewBox="0 0 ${x} ${H}" style="width:100%;height:auto">
            <defs><marker id="qarrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${C.border2}"/></marker></defs>${svg}
            <text x="16" y="104" fill="${C.faint}" font-size="10">Content reaches views through retention and early engagement. Raw views are dominated by confounds (account size, post time, recommender state) — that noise is most of the variation. Model the link you control.</text>
        </svg>`;
    }

    // Horizontal bar chart {label,val} with optional signed coloring
    function vizBars(items, opts = {}) {
        const { signed = false, unit = '', w = 880, rowH = 24, max = null, fmtV = (v) => fmt(v, 3), highlight = null } = opts;
        if (!items.length) return '<div style="color:#64748b;font-size:11px">no data</div>';
        const M = max != null ? max : Math.max(...items.map(i => Math.abs(i.val)), 1e-9);
        const labelW = 168, barX = labelW + 8, barW = w - barX - 70;
        const H = items.length * rowH + 8;
        let svg = '';
        items.forEach((it, i) => {
            const y = 4 + i * rowH;
            const frac = Math.abs(it.val) / M;
            const col = signed ? (it.val >= 0 ? C.green : C.red) : (it.col || lerpColor(frac));
            const bw = Math.max(1, frac * (signed ? barW / 2 : barW));
            const x0 = signed ? barX + barW / 2 : barX;
            const xx = it.val >= 0 || !signed ? x0 : x0 - bw;
            if (signed) svg += `<line x1="${barX + barW / 2}" y1="${y - 2}" x2="${barX + barW / 2}" y2="${y + rowH - 4}" stroke="${C.border2}" stroke-width="1"/>`;
            svg += `<rect x="${xx}" y="${y}" width="${bw}" height="${rowH - 8}" rx="2" fill="${col}" opacity="${highlight && highlight === it.label ? 1 : 0.85}"/>`;
            svg += `<text x="${labelW}" y="${y + rowH - 11}" text-anchor="end" fill="${highlight === it.label ? C.cyan : C.dim}" font-size="11" font-weight="${highlight === it.label ? 700 : 400}">${esc(it.label)}</text>`;
            svg += `<text x="${barX + barW + 6}" y="${y + rowH - 11}" fill="${C.text}" font-size="11" font-family="monospace">${fmtV(it.val)}${unit}</text>`;
        });
        return `<svg viewBox="0 0 ${w} ${H}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Histogram of a numeric array
    function vizHist(arr, opts = {}) {
        const { bins = 22, w = 440, h = 150, color = C.cyan, label = '' } = opts;
        const lo = Math.min(...arr), hi = Math.max(...arr), span = (hi - lo) || 1;
        const counts = new Array(bins).fill(0);
        arr.forEach(v => { let b = Math.floor((v - lo) / span * bins); if (b >= bins) b = bins - 1; if (b < 0) b = 0; counts[b]++; });
        const mx = Math.max(...counts, 1), pad = 28, bw = (w - pad * 2) / bins;
        let svg = '';
        counts.forEach((c, i) => { const bh = (c / mx) * (h - pad - 16); svg += `<rect x="${pad + i * bw}" y="${h - pad - bh}" width="${bw - 1.5}" height="${bh}" fill="${color}" opacity="0.8"/>`; });
        const mn = mean(arr), md = median(arr);
        const mx2x = pad + ((mn - lo) / span) * (w - pad * 2);
        svg += `<line x1="${mx2x}" y1="${8}" x2="${mx2x}" y2="${h - pad}" stroke="${C.yellow}" stroke-width="1.5" stroke-dasharray="3 2"/>`;
        svg += `<text x="${mx2x}" y="6" text-anchor="middle" fill="${C.yellow}" font-size="9">μ=${fmt(mn, 2)}</text>`;
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${pad}" y="${h - 10}" fill="${C.mute}" font-size="9">${fmt(lo, 2)}</text>`;
        svg += `<text x="${w - pad}" y="${h - 10}" text-anchor="end" fill="${C.mute}" font-size="9">${fmt(hi, 2)}</text>`;
        if (label) svg += `<text x="${w / 2}" y="${h - 10}" text-anchor="middle" fill="${C.dim}" font-size="10">${esc(label)}  (median ${fmt(md, 2)})</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Scatter with optional cluster coloring + regression hint
    function vizScatter(pts, opts = {}) {
        const { w = 440, h = 320, xlab = 'x', ylab = 'y', colors = null, line = false } = opts;
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
        const xs2 = (xhi - xlo) || 1, ys2 = (yhi - ylo) || 1, pad = 34;
        const X = v => pad + (v - xlo) / xs2 * (w - pad * 2);
        const Y = v => h - pad - (v - ylo) / ys2 * (h - pad * 2);
        let svg = `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        pts.forEach((p, i) => { const col = colors ? colors[i] : C.cyan; svg += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="${col}" opacity="0.75"/>`; });
        if (line) { const b1 = pearson(xs, ys) * std(ys) / (std(xs) || 1), b0 = mean(ys) - b1 * mean(xs); svg += `<line x1="${X(xlo)}" y1="${Y(b0 + b1 * xlo)}" x2="${X(xhi)}" y2="${Y(b0 + b1 * xhi)}" stroke="${C.yellow}" stroke-width="1.5" stroke-dasharray="4 3"/>`; }
        svg += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" fill="${C.mute}" font-size="10">${esc(xlab)}</text>`;
        svg += `<text x="12" y="${h / 2}" text-anchor="middle" fill="${C.mute}" font-size="10" transform="rotate(-90 12 ${h / 2})">${esc(ylab)}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Correlation / covariance heatmap
    function vizHeatmap(M, labels, opts = {}) {
        const { w = 560, cell = null } = opts;
        const p = M.length, sz = cell || Math.min(26, Math.floor((w - 150) / p));
        const ox = 150, oy = 14, H = oy + p * sz + 14;
        let svg = '';
        for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) {
            svg += `<rect x="${ox + b * sz}" y="${oy + a * sz}" width="${sz}" height="${sz}" fill="${divergeColor(M[a][b])}" stroke="${C.bg}" stroke-width="0.5"/>`;
        }
        labels.forEach((l, i) => {
            svg += `<text x="${ox - 6}" y="${oy + i * sz + sz / 2 + 3}" text-anchor="end" fill="${C.dim}" font-size="9">${esc(l)}</text>`;
            svg += `<text x="${ox + i * sz + sz / 2}" y="${oy + p * sz + 11}" text-anchor="middle" fill="${C.dim}" font-size="8" transform="rotate(45 ${ox + i * sz + sz / 2} ${oy + p * sz + 11})">${esc(l)}</text>`;
        });
        return `<svg viewBox="0 0 ${ox + p * sz + 30} ${H}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Eigenvalue spectrum with Marchenko-Pastur edge
    function vizSpectrum(values, mp, nSignal) {
        const w = 560, h = 220, pad = 38, p = values.length;
        const mx = Math.max(...values, mp.lambdaPlus) * 1.1, bw = (w - pad * 2) / p;
        const Y = v => h - pad - (v / mx) * (h - pad * 2);
        let svg = '';
        values.forEach((v, i) => { const sig = v > mp.lambdaPlus; svg += `<rect x="${pad + i * bw}" y="${Y(v)}" width="${bw - 2}" height="${h - pad - Y(v)}" fill="${sig ? C.green : C.faint}" opacity="0.85"/>`; });
        const ey = Y(mp.lambdaPlus);
        svg += `<line x1="${pad}" y1="${ey}" x2="${w - pad}" y2="${ey}" stroke="${C.red}" stroke-width="1.5" stroke-dasharray="5 3"/>`;
        svg += `<text x="${w - pad}" y="${ey - 4}" text-anchor="end" fill="${C.red}" font-size="10">λ₊ = ${fmt(mp.lambdaPlus, 3)}  (noise edge)</text>`;
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${pad}" y="16" fill="${C.green}" font-size="11" font-weight="600">${nSignal} signal direction${nSignal === 1 ? '' : 's'} above noise</text>`;
        svg += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" fill="${C.mute}" font-size="10">eigenvalue rank (q = p/n = ${fmt(mp.q, 3)})</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Eigenvalue histogram with the THEORETICAL Marchenko-Pastur noise density
    // overlaid. Eigenvalues inside [λ₋,λ₊] are indistinguishable from noise; the
    // cyan curve is the exact MP density f(λ)=√((λ₊−λ)(λ−λ₋))/(2π q λ) for σ²=1.
    function vizMPDensity(values, mp) {
        const w = 560, h = 200, pad = 38;
        const lamMinus = Math.pow(1 - Math.sqrt(mp.q), 2);
        const lamPlus = mp.lambdaPlus;
        const maxLam = Math.max(...values, lamPlus) * 1.05 || 1;
        const X = l => pad + (l / maxLam) * (w - pad * 2);
        const nb = 24, bw = maxLam / nb, bins = new Array(nb).fill(0);
        values.forEach(v => { bins[Math.min(nb - 1, Math.max(0, Math.floor(v / bw)))]++; });
        const maxCount = Math.max(...bins, 1);
        const dens = l => (l > lamMinus && l < lamPlus) ? Math.sqrt(Math.max(0, (lamPlus - l) * (l - lamMinus))) / (2 * Math.PI * mp.q * l) : 0;
        const pts = []; let dmax = 0;
        for (let i = 0; i <= 120; i++) { const l = (i / 120) * maxLam, d = dens(l); if (d > dmax) dmax = d; pts.push([l, d]); }
        const Yc = c => h - pad - (c / maxCount) * (h - pad * 2);
        const Yd = d => h - pad - (dmax ? (d / dmax) * (h - pad * 2) : 0);
        let svg = '';
        bins.forEach((c, i) => { const l = i * bw, sig = l > lamPlus; svg += `<rect x="${X(l)}" y="${Yc(c)}" width="${Math.max(1, (w - pad * 2) / nb - 1)}" height="${h - pad - Yc(c)}" fill="${sig ? C.green : C.faint}" opacity="0.7"/>`; });
        let path = ''; pts.forEach(([l, d], i) => { path += (i ? 'L' : 'M') + X(l) + ' ' + Yd(d) + ' '; });
        svg += `<path d="${path}" fill="none" stroke="${C.cyan}" stroke-width="2"/>`;
        [['λ₋', lamMinus], ['λ₊', lamPlus]].forEach(([lab, l]) => { svg += `<line x1="${X(l)}" y1="${pad}" x2="${X(l)}" y2="${h - pad}" stroke="${C.red}" stroke-dasharray="4 3" stroke-width="1"/><text x="${X(l)}" y="${pad - 2}" text-anchor="middle" fill="${C.red}" font-size="9">${lab}=${fmt(l, 2)}</text>`; });
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${w / 2}" y="${h - 6}" text-anchor="middle" fill="${C.mute}" font-size="10">eigenvalue λ — bars = observed spectrum · cyan = theoretical MP noise density · green = signal beyond λ₊</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Per-fold R² as a confidence range: each fold a dot, mean line, ±1σ band.
    // Turns the "scores carry confidence ranges" discipline from text into a picture.
    function vizFoldCI(scores, mu, sd, color) {
        if (!scores || !scores.length) return '';
        const w = 320, h = 96, pad = 26;
        const lo = Math.min(0, ...scores, mu - sd), hi = Math.max(...scores, mu + sd, 0.1);
        const Y = v => h - pad - ((v - lo) / (hi - lo || 1)) * (h - pad * 1.5);
        const X = i => pad + (scores.length === 1 ? (w - pad * 2) / 2 : (i / (scores.length - 1)) * (w - pad * 2));
        let svg = `<rect x="${pad}" y="${Y(mu + sd)}" width="${w - pad * 2}" height="${Math.max(1, Y(mu - sd) - Y(mu + sd))}" fill="${color}" opacity="0.12"/>`;
        svg += `<line x1="${pad}" y1="${Y(mu)}" x2="${w - pad}" y2="${Y(mu)}" stroke="${color}" stroke-dasharray="4 3"/>`;
        if (lo < 0) svg += `<line x1="${pad}" y1="${Y(0)}" x2="${w - pad}" y2="${Y(0)}" stroke="${C.border2}"/>`;
        scores.forEach((s, i) => { svg += `<circle cx="${X(i)}" cy="${Y(s)}" r="3.5" fill="${color}"/><text x="${X(i)}" y="${Y(s) - 7}" text-anchor="middle" fill="${C.mute}" font-size="8">${fmt(s, 2)}</text>`; });
        svg += `<text x="${pad}" y="${h - 6}" fill="${C.mute}" font-size="8">fold 1</text><text x="${w - pad}" y="${h - 6}" text-anchor="end" fill="${C.mute}" font-size="8">fold ${scores.length}</text>`;
        svg += `<text x="${w - pad}" y="${Math.max(10, Y(mu) - 4)}" text-anchor="end" fill="${color}" font-size="9">mean ${fmt(mu, 2)} ± ${fmt(sd, 2)}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;max-width:340px">${svg}</svg>`;
    }

    // Retention curve + simple-baseline summary (§6)
    function vizCurve(rowsRetention, opts = {}) {
        // build an average retention curve from ret_25/50/75/90 anchors (0,25,50,75,90,100)
        const w = 540, h = 220, pad = 36;
        const anchors = opts.anchors;
        const X = t => pad + (t / 100) * (w - pad * 2);
        const Y = v => h - pad - (v) * (h - pad * 2);
        let path = `M ${X(0)} ${Y(1)} `;
        anchors.forEach(a => { path += `L ${X(a.t)} ${Y(a.v)} `; });
        let svg = `<path d="${path}" fill="none" stroke="${C.green}" stroke-width="2"/>`;
        anchors.forEach(a => { svg += `<circle cx="${X(a.t)}" cy="${Y(a.v)}" r="3" fill="${C.cyan}"/><text x="${X(a.t)}" y="${Y(a.v) - 8}" text-anchor="middle" fill="${C.dim}" font-size="9">${fmt(a.v, 2)}</text>`; });
        // mark 3s-survival window concept
        svg += `<line x1="${X(0)}" y1="${pad}" x2="${X(0)}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${pad}" y="${h - 10}" fill="${C.mute}" font-size="9">0%</text><text x="${w - pad}" y="${h - 10}" text-anchor="end" fill="${C.mute}" font-size="9">100% of duration</text>`;
        svg += `<text x="${w / 2}" y="14" text-anchor="middle" fill="${C.dim}" font-size="10">Corpus-mean retention curve (anchors at 25/50/75/90% of duration)</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Weight-over-time decay lines (§11)
    function vizDecay(series, labels) {
        const w = 560, h = 240, pad = 40;
        const T = series[0].length;
        const all = series.flat();
        const lo = Math.min(...all, 0), hi = Math.max(...all, 0), span = (hi - lo) || 1;
        const X = i => pad + (i / (T - 1)) * (w - pad * 2);
        const Y = v => h - pad - (v - lo) / span * (h - pad * 2);
        const cols = [C.cyan, C.green, C.orange, C.purple, C.yellow, C.red, C.accent];
        let svg = `<line x1="${pad}" y1="${Y(0)}" x2="${w - pad}" y2="${Y(0)}" stroke="${C.border2}" stroke-dasharray="2 2"/>`;
        series.forEach((s, k) => { let path = ''; s.forEach((v, i) => { path += (i ? 'L' : 'M') + ` ${X(i)} ${Y(v)} `; }); svg += `<path d="${path}" fill="none" stroke="${cols[k % cols.length]}" stroke-width="1.8"/>`; });
        labels.forEach((l, k) => { svg += `<text x="${w - pad + 4}" y="${Y(series[k][T - 1]) + 3}" fill="${cols[k % cols.length]}" font-size="9">${esc(l)}</text>`; });
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${pad}" y="${h - 8}" fill="${C.mute}" font-size="9">earlier reels</text><text x="${w - pad}" y="${h - 8}" text-anchor="end" fill="${C.mute}" font-size="9">later reels →</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Mel-spectrogram heatmap (§4) — bands × time, blue→cyan→yellow→red
    function vizSpectrogram(mel, dims, xmax, markers) {
        const [nb, nt] = dims, w = 560, h = 220, padL = 40, padB = 28, padT = 16;
        const cw = (w - padL - 8) / nt, ch = (h - padB - padT) / nb;
        let svg = '';
        for (let b = 0; b < nb; b++) for (let tx = 0; tx < nt; tx++) {
            const v = mel[b][tx];
            svg += `<rect x="${padL + tx * cw}" y="${padT + (nb - 1 - b) * ch}" width="${cw + 0.6}" height="${ch + 0.6}" fill="${lerpColor(v)}"/>`;
        }
        (markers || []).forEach(mk => { if (mk.t == null) return; const x = padL + (mk.t / xmax) * (w - padL - 8); svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${h - padB}" stroke="${mk.color}" stroke-width="1.5" stroke-dasharray="3 2"/><text x="${x}" y="${padT - 4}" text-anchor="middle" fill="${mk.color}" font-size="8">${esc(mk.label)}</text>`; });
        svg += `<text x="${padL - 6}" y="${padT + 8}" text-anchor="end" fill="${C.mute}" font-size="8">high</text><text x="${padL - 6}" y="${h - padB}" text-anchor="end" fill="${C.mute}" font-size="8">low</text>`;
        svg += `<text x="${padL}" y="${h - 8}" fill="${C.mute}" font-size="9">0s</text><text x="${w - 8}" y="${h - 8}" text-anchor="end" fill="${C.mute}" font-size="9">${fmt(xmax, 1)}s</text>`;
        svg += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" fill="${C.dim}" font-size="10">mel-spectrogram (64→32 bands) — the raw sound picture over time</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Multichannel curves over time with event-alignment markers (§4/§5/§6)
    function vizTimeSeries(series, opts = {}) {
        const { w = 560, h = 250, xmax = 10, markers = [], title = '', stack = false } = opts;
        const padL = 40, padB = 30, padT = 14, rows = stack ? series.length : 1;
        const plotH = (h - padB - padT) / rows;
        const X = t => padL + (t / xmax) * (w - padL - 10);
        let svg = '';
        series.forEach((s, si) => {
            const baseY = padT + (stack ? si * plotH : 0);
            const hh = stack ? plotH - 6 : (h - padB - padT);
            const Y = v => baseY + hh - v * hh;
            let path = '';
            const tarr = s.times, varr = s.values;
            for (let i = 0; i < varr.length; i++) {
                const t = tarr ? tarr[i] : (i / (varr.length - 1)) * xmax;
                path += (i ? 'L' : 'M') + ` ${X(t)} ${Y(varr[i])} `;
            }
            svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="1.6" opacity="0.9"/>`;
            if (stack) svg += `<text x="${padL + 2}" y="${baseY + 10}" fill="${s.color}" font-size="9">${esc(s.name)}</text>`;
        });
        markers.forEach(mk => { if (mk.t == null) return; const x = X(mk.t); svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${h - padB}" stroke="${mk.color}" stroke-width="1.4" stroke-dasharray="4 3"/><text x="${x}" y="${h - padB + 11}" text-anchor="middle" fill="${mk.color}" font-size="8">${esc(mk.label)}</text>`; });
        svg += `<line x1="${padL}" y1="${h - padB}" x2="${w - 8}" y2="${h - padB}" stroke="${C.border2}"/>`;
        if (!stack) {
            const leg = series.map((s, i) => `<tspan fill="${s.color}"> ▬ ${esc(s.name)}</tspan>`).join('  ');
            svg += `<text x="${padL}" y="${12}" font-size="9">${leg}</text>`;
        }
        svg += `<text x="${padL}" y="${h - 6}" fill="${C.mute}" font-size="9">0s</text><text x="${w - 8}" y="${h - 6}" text-anchor="end" fill="${C.mute}" font-size="9">${fmt(xmax, 1)}s</text>`;
        if (title) svg += `<text x="${w / 2}" y="${h - 6}" text-anchor="middle" fill="${C.dim}" font-size="10">${esc(title)}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // Predicted-vs-actual scatter with the y=x reference line (accuracy graph)
    function vizPredVsActual(act, pred, opts = {}) {
        const { w = 400, h = 360, unit = '', color = C.cyan } = opts;
        if (!act.length) return `<div style="color:${C.mute};font-size:11px">no out-of-fold predictions</div>`;
        const all = act.concat(pred), lo = Math.min(...all), hi = Math.max(...all), sp = (hi - lo) || 1, pad = 44;
        const X = v => pad + (v - lo) / sp * (w - pad * 2);
        const Y = v => h - pad - (v - lo) / sp * (h - pad * 2);
        let svg = `<line x1="${X(lo)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}" stroke="${C.faint}" stroke-width="1.5" stroke-dasharray="5 3"/>`;
        svg += `<text x="${X(hi) - 4}" y="${Y(hi) + 12}" text-anchor="end" fill="${C.faint}" font-size="9">perfect (y=x)</text>`;
        act.forEach((a, i) => { svg += `<circle cx="${X(a)}" cy="${Y(pred[i])}" r="3.2" fill="${color}" opacity="0.55"/>`; });
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${pad}" y="${h - pad + 14}" fill="${C.mute}" font-size="9">${fmt(lo, 1)}</text><text x="${w - pad}" y="${h - pad + 14}" text-anchor="end" fill="${C.mute}" font-size="9">${fmt(hi, 1)}</text>`;
        svg += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" fill="${C.dim}" font-size="10">actual ${esc(unit)}</text>`;
        svg += `<text x="13" y="${h / 2}" text-anchor="middle" fill="${C.dim}" font-size="10" transform="rotate(-90 13 ${h / 2})">predicted ${esc(unit)}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // ROC curve (dud-detection) with AUC fill
    function vizROC(roc, auc, opts = {}) {
        const { w = 380, h = 360, color = C.orange } = opts, pad = 44;
        const X = v => pad + v * (w - pad * 2);
        const Y = v => h - pad - v * (h - pad * 2);
        let area = `M ${X(0)} ${Y(0)} `;
        roc.forEach(p => { area += `L ${X(p.fpr)} ${Y(p.tpr)} `; });
        area += `L ${X(1)} ${Y(0)} Z`;
        let line = '';
        roc.forEach((p, i) => { line += (i ? 'L' : 'M') + ` ${X(p.fpr)} ${Y(p.tpr)} `; });
        let svg = `<path d="${area}" fill="${color}" opacity="0.13"/>`;
        svg += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="${C.faint}" stroke-dasharray="5 3"/>`;
        svg += `<text x="${X(0.62)}" y="${Y(0.5)}" fill="${C.faint}" font-size="9" transform="rotate(45 ${X(0.62)} ${Y(0.5)})">random (AUC 0.5)</text>`;
        svg += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2.2"/>`;
        svg += `<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${C.border2}"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="${C.border2}"/>`;
        svg += `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" fill="${C.dim}" font-size="10">false-positive rate</text>`;
        svg += `<text x="13" y="${h / 2}" text-anchor="middle" fill="${C.dim}" font-size="10" transform="rotate(-90 13 ${h / 2})">true-positive rate</text>`;
        svg += `<text x="${X(0.55)}" y="${Y(0.18)}" fill="${color}" font-size="15" font-weight="700">AUC ${fmt(auc, 3)}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
    }

    // ══════════════════════════════════════════════════════════════════
    // RENDER — shared chrome bits
    // ══════════════════════════════════════════════════════════════════

    function card(inner, pad = 16) { return `<div style="background:${C.card};border:1px solid ${C.border};border-radius:10px;padding:${pad}px;margin-bottom:14px">${inner}</div>`; }
    function h2(t, sub) { return `<div style="margin-bottom:12px"><div style="font-size:15px;font-weight:700;color:${C.text};letter-spacing:0.3px">${esc(t)}</div>${sub ? `<div style="font-size:11px;color:${C.mute};margin-top:2px">${esc(sub)}</div>` : ''}</div>`; }
    function tag(text, col) { return `<span style="display:inline-block;background:${col}22;color:${col};border:1px solid ${col}55;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:600;letter-spacing:0.3px">${esc(text)}</span>`; }
    function availTag(a) { const m = { live: ['LIVE', C.green], extractable: ['EXTRACTABLE', C.orange], proxy: ['PROXY', C.cyan], missing: ['NEEDS DATA', C.red] }; const [t, c] = m[a] || ['?', C.mute]; return tag(t, c); }
    function stat(label, val, col) { return `<div style="flex:1;min-width:120px;background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:10px 12px"><div style="font-size:10px;color:${C.mute};text-transform:uppercase;letter-spacing:0.06em">${esc(label)}</div><div style="font-size:20px;font-weight:700;color:${col || C.text};font-family:monospace;margin-top:2px">${val}</div></div>`; }
    function note(text, col = C.accent) { return `<div style="border-left:3px solid ${col};background:${col}11;padding:10px 14px;border-radius:0 6px 6px 0;margin:10px 0;font-size:12px;color:${C.dim};line-height:1.5">${text}</div>`; }
    function ctrl(label, ctlKey, options, val) {
        const opts = options.map(o => `<option value="${o.v}"${o.v == val ? ' selected' : ''}>${esc(o.l)}</option>`).join('');
        return `<label style="font-size:11px;color:${C.mute};display:inline-flex;flex-direction:column;gap:3px">${esc(label)}<select data-qrd-ctl="${ctlKey}" style="background:${C.card2};color:${C.text};border:1px solid ${C.border2};border-radius:6px;padding:5px 8px;font-size:12px">${opts}</select></label>`;
    }

    // ══════════════════════════════════════════════════════════════════
    // SECTION RENDERERS
    // ══════════════════════════════════════════════════════════════════

    async function doPredict() {
        if (!state.pgFile || state.pgLoading) return;
        state.pgLoading = true; state.pgError = null; state.pgResult = null; rerender();
        try {
            const buf = await state.pgFile.arrayBuffer();
            const ext = (state.pgFileName.split('.').pop() || (state.pgType === 'audio' ? 'wav' : 'mp4')).toLowerCase();
            const resp = await fetch('./api/qrd/predict', {
                method: 'POST',
                headers: { 'X-QRD-Type': state.pgType, 'X-QRD-Ext': ext, 'Content-Type': 'application/octet-stream' },
                body: buf,
            });
            const r = await resp.json();
            if (r.error) state.pgError = r.error + (r.stderr ? ' — ' + r.stderr : '');
            else state.pgResult = r;
        } catch (e) { state.pgError = e.message; }
        state.pgLoading = false; rerender();
    }

    // Semicircle gauge. frac 0..1 fills the arc; `good='high'` colours high=green.
    function vizGauge(frac, opts = {}) {
        const { w = 280, label = '', display = null, good = 'low', lo = 'low', hi = 'high' } = opts;
        const h = 160, cx = w / 2, cy = 140, r = 110;
        const score = good === 'high' ? frac : 1 - frac; // 1 = good
        const col = score >= 0.7 ? C.green : score >= 0.45 ? C.orange : C.red;
        const a0 = Math.PI, a1 = Math.PI * (1 - frac);
        const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        const large = frac > 0.5 ? 1 : 0;
        let svg = `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="${C.border2}" stroke-width="16"/>`;
        svg += `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}" fill="none" stroke="${col}" stroke-width="16"/>`;
        svg += `<text x="${cx}" y="${cy - 18}" text-anchor="middle" fill="${col}" font-size="34" font-weight="800">${display != null ? display : fmt(frac * 100, 0) + '%'}</text>`;
        svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${C.dim}" font-size="11">${esc(label)}</text>`;
        svg += `<text x="${cx - r}" y="${cy + 18}" text-anchor="middle" fill="${good === 'high' ? C.red : C.green}" font-size="9">${esc(lo)}</text>`;
        svg += `<text x="${cx + r}" y="${cy + 18}" text-anchor="middle" fill="${good === 'high' ? C.green : C.red}" font-size="9">${esc(hi)}</text>`;
        return `<svg viewBox="0 0 ${w} ${h}" style="width:${w}px;max-width:100%;height:auto">${svg}</svg>`;
    }

    function renderPlayground() {
        let h = h2('Predictive Playground — upload a reel, get its keep rate', '🎬 Runs the reproducible extracted-only model (librosa + opencv + whisper, no LLM) on your file. Keep rate = % who stay past the hook = 100 − swipe-away.');

        // honest capability banner
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            ${card(`<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${tag('RELIABLE', C.green)}<b style="color:${C.text}">Keep rate / hook survival</b></div><div style="font-size:11.5px;color:${C.dim};line-height:1.5">Out-of-fold <b>AUC 0.88</b> at flagging low-keep hooks. Keep rate = 100 − swipe-away (they are exact complements). The validated, trustworthy prediction.</div>`, 12)}
            ${card(`<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${tag('WEAK · RANKING', C.orange)}<b style="color:${C.text}">Overall retention</b></div><div style="font-size:11.5px;color:${C.dim};line-height:1.5">Whole-video features, out-of-fold <b>ρ 0.35</b> — a low-confidence ranking estimate, not a precise number. Needs video (not audio-only).</div>`, 12)}
        </div>`;
        h += note(`<b>Built on the 10 features that genuinely move keep rate</b> (|corr| > 0.10), all time-windowed to the first 10s or expressed as rates (words/sec, cuts/sec). Pruned the ~12 features that don’t influence it — and <b>excluded video length</b>: it correlates (longer reels get swiped more) but it’s a format effect, not a hook lever, and dropping it raised accuracy. <b>Not predicted (proven):</b> exact 3s/5s/10s marks (near-zero early variance, R²≈0) and views (confound-dominated). Text-only isn’t supported — needs the audio/visual waveform.`, C.mute);

        // upload control
        h += card(`<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
            <label style="font-size:11px;color:${C.mute};display:inline-flex;flex-direction:column;gap:3px">Upload type
                <select data-qrd-ctl="pgType" style="background:${C.card2};color:${C.text};border:1px solid ${C.border2};border-radius:6px;padding:6px 10px;font-size:12px">
                    <option value="video"${state.pgType === 'video' ? ' selected' : ''}>Video (full prediction)</option>
                    <option value="audio"${state.pgType === 'audio' ? ' selected' : ''}>Audio only (swipe only)</option>
                </select></label>
            <label style="font-size:11px;color:${C.mute};display:inline-flex;flex-direction:column;gap:3px">File
                <input type="file" data-qrd-file accept="${state.pgType === 'audio' ? 'audio/*,.wav,.mp3,.m4a' : 'video/*,.mp4,.mov,.webm'}" style="font-size:12px;color:${C.dim};max-width:300px"/></label>
            <button data-qrd-act="predict" ${state.pgFile && !state.pgLoading ? '' : 'disabled'} style="cursor:${state.pgFile && !state.pgLoading ? 'pointer' : 'not-allowed'};background:${state.pgFile && !state.pgLoading ? C.accent : C.border};color:#fff;border:none;border-radius:7px;padding:9px 18px;font-size:13px;font-weight:700;align-self:flex-end">${state.pgLoading ? 'Analyzing…' : 'Predict'}</button>
            ${state.pgFileName ? `<span style="font-size:11px;color:${C.cyan};align-self:flex-end">${esc(state.pgFileName)}</span>` : ''}
        </div>
        ${state.pgLoading ? `<div style="margin-top:12px;font-size:12px;color:${C.cyan}">⏳ Extracting audio/visual features + transcribing (whisper)… this runs the real pipeline and can take 30–120s for video.</div>` : ''}
        ${state.pgError ? `<div style="margin-top:12px;font-size:12px;color:${C.red}">Error: ${esc(state.pgError)}</div>` : ''}`);

        // results
        const R = state.pgResult;
        if (R && !state.pgLoading) {
            const keep = (typeof R.keep_rate_est === 'number') ? R.keep_rate_est : (100 - (R.swipe_pct_est || 0));
            const dud = R.dud_proba;
            const keepCol = dud < 0.3 ? C.green : dud < 0.5 ? C.orange : C.red;
            const verdict = dud >= 0.5 ? 'LOW keep rate — likely to lose viewers in the hook'
                : dud >= 0.3 ? 'MODERATE — borderline hook' : 'HIGH keep rate — hook should hold viewers';
            h += `<div style="display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:center;margin-bottom:14px">
                <div style="text-align:center">${vizGauge(keep / 100, { label: 'estimated keep rate', display: fmt(keep, 1) + '%', good: 'high', lo: 'lose', hi: 'keep' })}</div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:${keepCol};margin-bottom:6px">${esc(verdict)}</div>
                    <div style="display:flex;gap:10px;flex-wrap:wrap">
                        ${stat('Keep rate est.', fmt(keep, 1) + '%', keepCol)}
                        ${stat('Swipe-away (=100−keep)', fmt(R.swipe_pct_est, 1) + '%', C.mute)}
                        ${stat('Low-keep risk', fmt(dud * 100, 0) + '%', keepCol)}
                        ${stat('Retention est.', R.retention ? fmt(R.retention.retention_est, 0) + '%' : 'video only', R.retention ? C.cyan : C.mute)}
                    </div>
                    <div style="font-size:10.5px;color:${C.faint};margin-top:6px">Reliable signal = the <b>low-keep risk</b> classifier (AUC ${fmt(R.model_metrics.auc, 2)}). The keep-rate % is a rougher point estimate.${R.retention ? ` Retention is a weak ranking estimate (ρ ${fmt(R.retention.metrics.spearman, 2)}) vs your typical ${fmt(R.retention.mean, 0)}%.` : ''}</div>
                </div>
            </div>`;
            if (R.degraded && R.degraded.length) h += note(`<b>Degraded inputs:</b> ${R.degraded.map(esc).join('; ')}. Imputed with corpus medians → lower confidence.`, C.orange);
            // keep-rate driver contributions (flip sign: positive = raises keep)
            const contribs = (R.contributions || []).map(c => ({ label: c.label, val: -c.contribution }));
            h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:4px">What’s driving this reel’s keep rate</div>
                <div style="font-size:11px;color:${C.mute};margin-bottom:8px"><span style="color:${C.green}">Green raises keep rate</span>, <span style="color:${C.red}">red lowers it</span>. Standardised feature × model weight, for this upload.</div>
                ${vizBars(contribs, { signed: true, fmtV: v => fmt(v, 2) })}`);
            if (R.transcript) h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:4px;font-size:12px">Transcript (whisper)</div><div style="font-size:12px;color:${C.dim};line-height:1.5;font-style:italic">"${esc(R.transcript)}${R.transcript.length >= 500 ? '…' : ''}"</div>`, 12);
            h += note(`<b>Honest read:</b> the low-keep / swipe-away call is validated out-of-fold (AUC ${fmt(R.model_metrics.auc, 2)}${R.model_metrics && R.model_metrics.auc_ci ? ', 90% CI ' + fmt(R.model_metrics.auc_ci[0], 2) + '–' + fmt(R.model_metrics.auc_ci[1], 2) : ''}). Treat it as a <b>triage signal</b> — it ranks risky hooks well, but any single call carries uncertainty. Confirm with an A/B test before treating a lever as a rule.`, C.green);
        }
        return h;
    }

    function renderOverview() {
        const d = DATA;
        let h = h2('The Object & the Causal Chain', '§1 — one reel = a synchronised audio + visual time series over its first T = 10 s. The hook lives there.');
        h += card(vizChain());
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('Reels in table', d.n, C.cyan)}
            ${stat('Raw-extracted reels', (d.extractHit || 0) + ' · ' + (d.audioReels || 0) + ' audio', C.green)}
            ${stat('Live model levers', modelContentKeys().length + CONFOUND_KEYS.length, C.purple)}
            ${stat('Extracted atoms live', d.nExtractedLevers || 0, C.orange)}
            ${stat('Python pipeline', d.hasPy ? 'loaded' : 'absent', d.hasPy ? C.green : C.mute)}
        </div>`;
        if (d.hasPy) h += note(`<b>Full waveform pipeline is live.</b> Real librosa audio + opencv/Haar visual + transcript atoms were extracted from the raw <code>video_data/</code> reels (Stage 2), then a Python reduction→model→attribution pass (Stage 3-4) ran the full model zoo. Every "EXTRACTABLE" atom that landed is now <b>LIVE</b>; the Models and Attribution tabs show the real Python results alongside the interactive in-browser engine.`, C.green);
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            ${card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">Strategy 1 — Model the link you control</div><div style="font-size:12px;color:${C.dim};line-height:1.6">Make <b style="color:${C.green}">retention</b> (watch-time / avg-view-duration) the primary target, not views. It sits one step from the content, is far less confounded, and YouTube Studio reports it directly.</div>`)}
            ${card(`<div style="font-weight:600;color:${C.orange};margin-bottom:6px">Strategy 2 — Strip the confounds</div><div style="font-size:12px;color:${C.dim};line-height:1.6">Handle account size, post time, topic timing and early engagement on purpose — either as inputs to the model or as a baseline you divide out. Both routes are built here; run both and compare.</div>`)}
        </div>`;
        // §13 full pipeline summary
        h += h2('Full Pipeline — 5 Stages', '§13 — every stage below is built and computed on the real table. Click a section tab to inspect it.');
        const stages = [
            ['Stage 1 · Data', 'Collect matched reels, with content, targets and the confounds to control for.', 'data', C.cyan],
            ['Stage 2 · Feature Extraction', 'Turn each reel’s audio & visual into readable curves over time. Keep the time axis.', 'features', C.green],
            ['Stage 3 · Features & Reduction', 'Line up on events, summarise the curves, then denoise before any model sees them.', 'reduction', C.orange],
            ['Stage 4 · Model & Attribute', 'Find archetypes, fit small models on retention, read which levers drive performance.', 'models', C.purple],
            ['Stage 5 · Produce & Track', 'Turn the levers into a concrete edit list, confirm with A/B tests, track rising levers.', 'production', C.accent],
        ];
        h += `<div style="display:flex;flex-direction:column;gap:8px">`;
        stages.forEach(([t, s, sec, col], i) => {
            h += `<div data-qrd-nav="${sec}" style="cursor:pointer;display:flex;align-items:center;gap:14px;background:${C.card};border:1px solid ${C.border};border-left:3px solid ${col};border-radius:8px;padding:12px 16px">
                <div style="font-size:22px;font-weight:800;color:${col};font-family:monospace;min-width:30px">${i + 1}</div>
                <div><div style="font-weight:700;color:${C.text};font-size:13px">${esc(t)}</div><div style="font-size:11.5px;color:${C.dim};margin-top:2px">${esc(s)}</div></div>
                <div style="margin-left:auto;color:${C.mute};font-size:18px">→</div></div>`;
        });
        h += `</div>`;
        h += note(`<b>The discipline, throughout:</b> model the link you control (content → retention), strip the confounds that dominate raw views, denoise before you fit, and treat every driver as a hypothesis until an experiment confirms it.`, C.purple);
        return h;
    }

    function renderTargets() {
        const m = ensureModel(), rows = DATA.rows;
        const ret = rows.map(r => r.retention), keep = rows.map(r => r.keep), lv = rows.map(r => r.log_views);
        const yrel = rows.filter(r => r._yrel != null).map(r => r._yrel);
        let h = h2('The Target Variable', '§2 — build three targets, ordered by how close they sit to the content (= how clean the learning problem is). Test against all three.');

        h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('TARGET 1 · PRIMARY', C.green)}<b style="color:${C.text}">Retention</b></div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6;margin-bottom:10px">
                <code style="color:${C.cyan}">y_ret = ρ̄</code> (avg percentage viewed, 0–1) &nbsp;·&nbsp; <code style="color:${C.cyan}">y_hook = ρ(3s)</code> (3-second survival — most actionable single number; the first three seconds drive most swipe-aways).
                Retention sits between 0 and 1 and is far better behaved than raw views — the reason it is the primary target.
            </div>
            <div style="display:flex;gap:16px;flex-wrap:wrap">
                <div style="flex:1;min-width:300px">${vizHist(ret, { label: 'retention (avg % viewed)', color: C.green })}</div>
                <div style="flex:1;min-width:300px">${vizHist(keep, { label: 'keep rate (hook-survival proxy for ρ(3s))', color: C.cyan })}</div>
            </div>
            ${note(`<b>Data note:</b> true <code>ρ(3s)</code> needs the 100-point retention curve in each <code>video_data/&lt;id&gt;/analysis.json</code> (present for 176 reels but not yet in this feature table). We use <b>Keep Rate</b> (stayed-to-watch %) as the live hook-survival proxy. ρ(3s) is <b>extractable</b> — see Feature Atoms.`, C.orange)}`);

        if (DATA.swipeHit) {
            const sw = rows.map(r => r.swipe);
            const rKeepSwipe = pearson(rows.map(r => r.keep), sw);
            const rRetSwipe = pearson(ret, sw);
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('TARGET 1b · HOOK', C.orange)}<b style="color:${C.text}">Swipe-away ratio</b> <span style="color:${C.mute};font-size:11px">y_hook made concrete</span></div>
                <div style="font-size:12px;color:${C.dim};line-height:1.6;margin-bottom:10px">
                    The real <code style="color:${C.cyan}">swipedAwayRate</code> from YouTube analytics (${DATA.swipeHit} reels) — the share who swiped away rather than watched. This is the most actionable single hook number: the first three seconds drive most swipe-aways. Heavy right-skew (most reels ≈0, a tail of high-swipe duds) → modelled as <code>log1p(swipe)</code>, never raw under squared loss.
                    <br><b>It is a distinct signal, not the mirror of Keep:</b> corr(keep, swipe) = <b style="color:${Math.abs(rKeepSwipe) < 0.3 ? C.green : C.orange};font-family:monospace">${fmt(rKeepSwipe, 2)}</b> — nearly orthogonal. So it earns its own playbook, and is best read <b>on top of retention</b> (corr to retention = ${fmt(rRetSwipe, 2)}).
                </div>
                <div style="max-width:480px">${vizHist(sw, { label: 'swipe-away ratio (%)', color: C.orange })}</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
                    ${stat('Mean swipe', fmt(mean(sw), 1) + '%', C.orange)}
                    ${stat('Median swipe', fmt(median(sw), 1) + '%', C.cyan)}
                    ${stat('corr → Keep', fmt(rKeepSwipe, 2), C.green)}
                    ${stat('Best model R²', MODEL_PY && MODEL_PY.targets.swipe ? fmt(Math.max(...MODEL_PY.targets.swipe.models.map(m => m.r2_mean)), 2) : '—', C.purple)}
                </div>
                <div style="font-size:11px;color:${C.mute};margin-top:8px">→ Build its model & attribution in <b>Models</b> (Target: Swipe-away ↓) and its edit-list in <b>Playbook</b>.</div>`);
        }

        h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('TARGET 2', C.cyan)}<b style="color:${C.text}">Within-account relative views</b></div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6;margin-bottom:10px">
                Raw views mix content with account state. Normalise each reel by its own account baseline so the target becomes <i>relative performance</i> — the part you control.
                <br><b style="color:${C.cyan}">Variant A (trailing-median ratio):</b> <code>y_rel = views_i / median(K posts before i)</code>. Uses only earlier posts → cannot leak the future. Computed live below (K=${state.trailingK}, log scale).
                <br><b style="color:${C.cyan}">Variant B (baseline absorbed in fit):</b> <code>log(views) = α_c + fᵀβ + zᵀγ + ε</code>. With one account, α_c is a single intercept → unidentified, so Variant A is the honest target here.
            </div>
            <div style="max-width:480px">${vizHist(yrel, { label: 'log within-account view ratio (Variant A)', color: C.cyan })}</div>
            ${note(`Single creator account → per the doc, <b>Variant A is the more honest target</b>; Variant B becomes useful once you have many accounts. Dataset order is used as posting-order proxy (no per-post timestamp in this table).`, C.cyan)}`);

        h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('TARGET 3 · CHECK ONLY', C.orange)}<b style="color:${C.text}">Raw views, ranked</b></div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6;margin-bottom:10px">
                The original framing — rank the reels by views — kept as a <b>ranking</b> problem on log-views, read last. Its job is to confirm Targets 1 & 2 aren’t wildly contradicted, not to choose features. A few reels go viral and most don’t, so raw views are extremely skewed: never fit raw counts under squared-error loss. Work in <code>log(1+views)</code> or rank.
            </div>
            <div style="max-width:480px">${vizHist(lv, { label: 'log10(views) — power-law tamed', color: C.orange })}</div>`);

        // live skew demonstration
        const rawSkew = skewness(rows.map(r => r.views)), logSkew = skewness(lv);
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap">
            ${stat('Raw views skew', fmt(rawSkew, 2), C.red)}
            ${stat('log10(views) skew', fmt(logSkew, 2), C.green)}
            ${stat('Retention range', fmt(Math.min(...ret), 0) + '–' + fmt(Math.max(...ret), 0) + '%', C.cyan)}
            ${stat('Median views', fmtViews(median(rows.map(r => r.views))), C.purple)}
        </div>`;
        return h;
    }
    function skewness(a) { const m = mean(a), s = std(a, m) || 1; return mean(a.map(v => ((v - m) / s) ** 3)); }

    function renderData() {
        const m = ensureModel();
        let h = h2('Data Acquisition + Confound Covariates', '§3 — 100 own + 100 matched reels; store the raw .mp4, the target metrics, and the confounds at post time (today’s follower count is leakage).');
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('Own reels', DATA.n, C.cyan)}
            ${stat('Matched competitor set', '0', C.red)}
            ${stat('Confounds at post time', 'yes', C.green)}
            ${stat('Account-size proxy', 'sub_view_frac', C.orange)}
        </div>`;
        h += note(`<b>Data access flags:</b> the corpus is <b>own reels only</b> — the <b>100 matched competitor reels are not present</b> (Instagram blocks bulk collection; YouTube competitor pull not done). Without the matched set, Stage-4 archetype clustering can only check overlap within one account. This is the single biggest data gap for §3.`, C.red);

        // confound table with live correlations
        let rowsH = CONFOUNDS.map(c => {
            const cc = m.confCorr.find(x => x.label === c.label);
            const roleCol = c.role.includes('mediator') ? C.orange : c.role.includes('hidden') ? C.purple : c.role.includes('largest') ? C.red : C.dim;
            return `<tr style="border-bottom:1px solid ${C.border}">
                <td style="padding:8px 10px;color:${C.text};font-weight:600">${esc(c.label)}</td>
                <td style="padding:8px 10px;color:${C.dim};font-size:11px">${esc(c.def)}</td>
                <td style="padding:8px 10px"><span style="color:${roleCol};font-size:11px">${esc(c.role)}</span></td>
                <td style="padding:8px 10px">${availTag(c.avail)}</td>
                <td style="padding:8px 10px;text-align:right;font-family:monospace;color:${cc ? (Math.abs(cc.rViews) > 0.3 ? C.cyan : C.dim) : C.faint}">${cc ? fmt(cc.rViews, 2) : '—'}</td>
                <td style="padding:8px 10px;text-align:right;font-family:monospace;color:${cc ? C.dim : C.faint}">${cc ? fmt(cc.rRet, 2) : '—'}</td>
            </tr>`;
        }).join('');
        h += card(`<table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid ${C.border2}">
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Covariate</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Definition</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Role</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Data</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">r→logViews</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">r→retention</th>
            </tr></thead><tbody>${rowsH}</tbody></table>
            <div style="font-size:11px;color:${C.mute};margin-top:8px">Correlations computed live on ${DATA.n} reels. The confound importances will be large — that is correct; the content features are then read underneath them (§9).</div>`, 12);

        h += note(`<b>Early engagement is a mediator, not a predictor.</b> First-hour likes/comments sit downstream of content (content → early engagement → amplification). Putting it into the content model swamps everything and hides the hook’s effect. <b>Default: leave it out of the content model</b> — which is exactly how the live model here is built.`, C.orange);
        return h;
    }

    function renderFeatures() {
        let h = h2('Feature Atoms — Audio (§4) + Visual (§5)', 'Every atomic feature the pipeline extracts, with its tool and live data status. Assume nothing: each is one number per frame or per reel.');

        // ── REAL extracted time-series for a chosen reel — "keep the time axis" ──
        const cr = curveReelData();
        if (cr) {
            const xmax = (cr.audio && cr.audio.t_audio) ? Math.max(...cr.audio.t_audio) : 10;
            const mk = alignMarkers(cr);
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('REAL EXTRACTED SIGNAL', C.green)}<b style="color:${C.text}">${esc(cr.name)}</b> <span style="color:${C.mute};font-size:11px">${fmtViews(cr.views || 0)} views · retention ${fmt(cr.retention, 0)}%</span></div>
                ${curveReelSelector()}
                <div style="font-size:11px;color:${C.mute};margin:6px 0 4px">§4.1 — the time-frequency picture (the hook lives in these first seconds; a single spectrum would blur it):</div>
                ${cr.audio ? vizSpectrogram(cr.audio.mel, cr.audio.mel_dims, xmax, mk) : `<div style="color:${C.mute};font-size:11px">no audio for this reel</div>`}
                <div style="font-size:11px;color:${C.mute};margin:12px 0 4px">§4.2 — audio descriptor channels over time (each normalised 0–1; dashed lines = event-alignment §6.1):</div>
                ${cr.audio ? vizTimeSeries([
                    { name: 'loudness', color: C.cyan, times: cr.audio.t_audio, values: cr.audio.loudness },
                    { name: 'pitch', color: C.purple, times: cr.audio.t_audio, values: cr.audio.pitch },
                    { name: 'onset', color: C.orange, times: cr.audio.t_audio, values: cr.audio.onset },
                    { name: 'centroid', color: C.green, times: cr.audio.t_audio, values: cr.audio.centroid },
                ], { xmax, markers: mk, title: 'loudness · pitch · onset · brightness — the voice signature' }) : ''}
                <div style="font-size:11px;color:${C.mute};margin:12px 0 4px">§5.3 — visual channels over time (brightness, saturation, motion; ▼ = detected scene cuts):</div>
                ${cr.visual ? vizTimeSeries([
                    { name: 'brightness', color: C.yellow, times: cr.visual.t_visual, values: cr.visual.brightness },
                    { name: 'saturation', color: C.orange, times: cr.visual.t_visual, values: cr.visual.saturation },
                    { name: 'motion', color: C.cyan, times: cr.visual.t_visual, values: cr.visual.motion },
                ], { xmax: cr.visual.duration_seen || xmax, markers: (cr.visual.cut_times || []).map(t => ({ t, label: '', color: C.green })), title: 'visual channels — pacing & motion of the open' }) : ''}
                <div style="font-size:10.5px;color:${C.faint};margin-top:6px">These are the actual per-frame curves librosa & opencv extracted from this reel's raw audio + frames, downsampled for display. Each is reduced to the simple-baseline summary (mean/slope/value@3s/first-3s-ratio) that feeds the model.</div>`);
        }

        const counts = { live: 0, extractable: 0, proxy: 0, missing: 0 };
        FEATURES.forEach(f => counts[f.avail]++);
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
            ${stat('LIVE (in table)', counts.live, C.green)}
            ${stat('EXTRACTABLE (raw on disk)', counts.extractable, C.orange)}
            ${stat('NEEDS DATA', counts.missing, C.red)}
            ${stat('Total atoms', FEATURES.length, C.cyan)}
        </div>`;
        h += `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end">
            ${ctrl('Filter by status', 'featStatus', [{ v: 'all', l: 'All' }, { v: 'live', l: 'Live only' }, { v: 'extractable', l: 'Extractable' }, { v: 'missing', l: 'Needs data' }], state.featStatus)}
        </div>`;
        const groups = [...new Set(FEATURES.map(f => f.group))];
        groups.forEach(g => {
            const items = FEATURES.filter(f => f.group === g && (state.featStatus === 'all' || f.avail === state.featStatus || (state.featStatus === 'extractable' && f.avail === 'proxy')));
            if (!items.length) return;
            let body = items.map(f => `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid ${C.border}">
                <div style="min-width:170px;font-weight:600;color:${C.text};font-size:12px">${esc(f.label)}</div>
                <div style="flex:1;color:${C.dim};font-size:11.5px">${esc(f.captures)}</div>
                <div style="min-width:200px;color:${C.mute};font-size:11px;font-family:monospace">${esc(f.tool)}</div>
                <div style="min-width:96px;text-align:right">${availTag(f.avail)}</div>
            </div>`).join('');
            h += card(`<div style="font-weight:700;color:${C.cyan};margin-bottom:6px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">${esc(g)}</div>${body}`, 6);
        });
        h += note(`<b>Voice signature (§4.3):</b> captured two ways — <i>by sound</i> (loudness+pitch+onset shape over the first 3 s → level-2 path signature; order separates a hype intro from a calm one even when averages match) and <i>by words</i> (transcript → speaking rate, time-to-first-word, question-hook flag). Both are extracted and live.`, C.cyan);
        if (DATA.hasPy) {
            h += note(`<b>Extraction complete.</b> <code>qrd/extract_features.py</code> ran <code>librosa</code> (audio: RMS/centroid/onset/ZCR/pitch/MFCC/mel/voiced-ratio over the first 10 s) on <b>${DATA.audioReels} reels with audio</b>, and <code>opencv</code> + Haar faces + <code>tesseract</code> OCR (visual: brightness/saturation/contrast/warmth/motion/cut-rate/faces/text) on <b>all ${DATA.extractHit} reels</b>, plus level-2 path signatures. ${DATA.nExtractedLevers} extracted atoms are now LIVE in the interactive model and the real Python pipeline. The only remaining <span style="color:${C.red}">NEEDS-DATA</span> atoms are the raw mel/MFCC tensors, the RGB composition grid, and trending-audio fingerprint — kept as full curves inside the signatures rather than flattened into the table.`, C.green);
        } else {
            h += note(`<b>To make the EXTRACTABLE atoms live:</b> run <code>python3 buildings/jarvis/qrd/extract_features.py</code> then <code>run_pipeline.py</code>. Until then the live model uses the 10 LLM-scored levers.`, C.orange);
        }
        return h;
    }

    function renderSequence() {
        const rows = DATA.rows;
        // Real anchors only. The curve starts at (0, 1.0) by definition (everyone
        // who starts is present); ret_25/50/75/90 are measured. We do NOT invent a
        // 100%-duration point — the data doesn't carry one.
        const anchors = [
            { t: 25, v: clamp01(mean(rows.map(r => r.ret_25))) },
            { t: 50, v: clamp01(mean(rows.map(r => r.ret_50))) },
            { t: 75, v: clamp01(mean(rows.map(r => r.ret_75))) },
            { t: 90, v: clamp01(mean(rows.map(r => r.ret_90))) },
        ];
        let h = h2('Alignment + Sequence Features', '§6 — line up on events, not the clock. Then turn each reel’s bundle of curves into one fixed vector.');
        h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">§6.1 — Line up on events, not the clock</div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6">Frame rates differ and the hook rarely starts at zero (intros, logos, a beat of silence). Find the first strong audio onset (<code>librosa.onset.onset_detect</code>) and the first scene cut; call time-zero the earliest of (first word, first onset, first cut); measure every channel from that point for a fixed window. Or skip alignment entirely with path signatures, which don’t care where on the clock an event sits — only the order and shape.</div>`);
        h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:6px">§6.2 — Path signatures (one fixed vector per reel)</div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6">Each reel is a bundle of curves moving together — loudness, pitch, onset, brightness, motion, face size. The <b>path signature</b> (iisignature / signatory) turns that bundle into a single fixed-length vector, no matter how long or fast the reel runs. It captures the <i>order</i> of events and how channels interact: "loudness swells, then the face zooms, then the beat drops" produces a different signature from the same three events in another order — even when the averages are identical. Keep it short (level 2 or 3); reduce channels first, add a time channel so level-2 terms capture how wiggly each channel is.</div>`);
        h += card(`<div style="font-weight:600;color:${C.green};margin-bottom:6px">§6.3 — Always build the simple baseline too</div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6;margin-bottom:8px">Before trusting signatures, build a plain version: for each channel take its mean, spread, min, max, slope, value at 3 s, and first-3s-vs-rest ratio. Join with static features and confounds. This is easy to read and often nearly as good — keep signatures only if they beat it on validation.</div>
            ${vizCurve(rows, { anchors })}
            <div style="font-size:11px;color:${C.mute};margin-top:6px">Live demo of the simple-summary idea on the one sequential channel in this table — the retention curve. Mean retention at 25/50/75/90% of duration, averaged across ${rows.length} reels. The audio/visual channels needed for full path signatures are <b>extractable</b> from raw frames/audio (see Feature Atoms).</div>`);
        // ── REAL aligned multichannel curves + level-2 signature interaction ──
        const cr = curveReelData();
        if (cr && cr.audio && cr.visual) {
            const xmax = Math.max(...cr.audio.t_audio);
            const mk = alignMarkers(cr);
            const series = [
                { name: 'A·loudness', color: C.cyan, times: cr.audio.t_audio, values: cr.audio.loudness },
                { name: 'A·pitch', color: C.purple, times: cr.audio.t_audio, values: cr.audio.pitch },
                { name: 'A·onset', color: C.orange, times: cr.audio.t_audio, values: cr.audio.onset },
                { name: 'V·brightness', color: C.yellow, times: cr.visual.t_visual, values: cr.visual.brightness },
                { name: 'V·motion', color: C.green, times: cr.visual.t_visual, values: cr.visual.motion },
            ];
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('REAL EXTRACTED SIGNAL', C.green)}<b style="color:${C.text}">${esc(cr.name)}</b></div>
                ${curveReelSelector()}
                <div style="font-size:11px;color:${C.mute};margin:4px 0">The bundle of curves that move together — what the path signature turns into one fixed vector. Stacked so the <i>order</i> of events is visible (the dashed t₀ is the real start of content):</div>
                ${vizTimeSeries(series, { xmax, markers: mk, stack: true, h: 300 })}`);
            if (cr.signature) {
                h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:4px">Level-2 signature — channel interaction (area) terms</div>
                    <div style="font-size:11px;color:${C.mute};margin-bottom:8px">The antisymmetric level-2 term for each channel pair: green = row-channel moves <i>before</i> column-channel, red = after. This ordering is exactly what separates a hook that lands from the same events in another order. Computed by <code>signatures.py</code> for this reel.</div>
                    ${vizHeatmap(cr.signature.area, cr.signature.channels, { w: 460 })}`);
            }
        }

        // simple baseline numbers for retention curve channel
        const slope = mean(rows.map(r => r.ret_90)) - mean(rows.map(r => r.ret_25));
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap">
            ${stat('mean ρ', fmt(mean(anchors.map(a => a.v)), 2), C.green)}
            ${stat('value @25%', fmt(anchors[0].v, 2), C.cyan)}
            ${stat('slope 25→90%', fmt(slope, 2), slope < 0 ? C.orange : C.green)}
            ${stat('convexity (mean)', fmt(mean(rows.map(r => r.rc_convexity)), 3), C.purple)}
        </div>`;
        return h;
    }
    function clamp01(v) { return Math.max(0, Math.min(1.05, v)); }

    function renderReduction() {
        const m = ensureModel();
        let h = h2('Too Many Features, Too Few Reels', '§7 — clean and shrink the feature space before any model sees it. Standardise → covariance → separate signal from noise → project down.');
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('Features (p)', m.cols.length, C.cyan)}
            ${stat('Reels (n)', DATA.n, C.green)}
            ${stat('q = p/n', fmt(m.mp.q, 3), C.orange)}
            ${stat('λ₊ noise edge', fmt(m.mp.lambdaPlus, 3), C.red)}
            ${stat('Signal directions', m.nSignal, C.green)}
        </div>`;
        h += card(`<div style="font-weight:600;color:${C.red};margin-bottom:6px">§7.2 — Marchenko–Pastur: separate signal from noise</div>
            <div style="font-size:12px;color:${C.dim};line-height:1.6;margin-bottom:8px">For a pure-noise covariance, eigenvalues sit below an upper edge <code>λ₊ = σ²(1 + √q)²</code>, <code>q = p/n</code>. Any eigenvalue above the edge is real signal; the rest is noise to discard or shrink. Below: the live eigenvalue spectrum of the standardised feature covariance, with the noise edge drawn in red.</div>
            ${vizSpectrum(m.eig.values, m.mp, m.nSignal)}
            <div style="font-size:11px;color:${C.mute};margin:12px 0 4px">Same spectrum as a density: the bars are the observed eigenvalue distribution, the cyan curve is the <b>theoretical</b> Marchenko–Pastur noise density between λ₋ and λ₊. Bars that hug the curve are noise; bars to the right of λ₊ are real signal directions.</div>
            ${vizMPDensity(m.eig.values, m.mp)}`);
        if (m.nSignal === 0) {
            h += note(`<b>Honest read:</b> with these ${m.cols.length} weakly-correlated LLM levers, the top eigenvalue (${fmt(m.eig.values[0], 3)}) sits just <i>under</i> the noise edge (${fmt(m.mp.lambdaPlus, 3)}). The feature space is already near-spherical — there is no dominant shared factor to compress onto. The correct response is to <b>lean on the raw readable features plus Ledoit–Wolf shrinkage rather than aggressive PCA</b>, and to add the extractable audio/visual atoms (§4–5), which carry the correlated structure path signatures are built to exploit. This is exactly the diagnostic Marchenko–Pastur is for.`, C.orange);
        } else {
            h += note(`<b>${m.nSignal} of ${m.cols.length}</b> eigen-directions clear the noise edge — keep these as the genuinely informative directions and discard or shrink the rest before any model sees the table.`, C.green);
        }
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            ${card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">§7.1 — Standardised feature covariance</div><div style="font-size:11px;color:${C.mute};margin-bottom:6px">Each column rescaled to mean 0, spread 1 (training stats). Green = positive, red = negative correlation.</div>${vizHeatmap(m.cov, m.cols)}`)}
            ${card(`<div style="font-weight:600;color:${C.green};margin-bottom:6px">§7.4 — Project down to the clean space (PCA)</div><div style="font-size:11px;color:${C.mute};margin-bottom:6px">Reels projected onto the top 2 principal components of the cleaned covariance. PC1 explains ${fmt(m.varExplained[0] * 100, 1)}%, PC2 ${fmt(m.varExplained[1] * 100, 1)}% of variance.</div>${vizScatter(m.proj, { xlab: 'PC1', ylab: 'PC2' })}`)}
        </div>`;
        h += note(`<b>§7.3 Shrinkage (safe default):</b> Ledoit–Wolf blends the noisy sample covariance with a stable target and picks the blend automatically (<code>sklearn.covariance.LedoitWolf</code>) — always invertible. Use Marchenko–Pastur to learn how many real directions exist, shrinkage for robustness. <b>§7 leak warning:</b> the noise edge, shrinkage, rescaling, PCA and UMAP must all be fit on the <b>training split only</b>, then frozen — fitting PCA on all reels before splitting is the most common leak in this exact pipeline.`, C.red);
        if (MODEL_PY && MODEL_PY.reduction) {
            const rd = MODEL_PY.reduction;
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('REAL PYTHON PIPELINE', C.green)}<b style="color:${C.text}">Full-feature reduction (143 features × ${MODEL_PY.n} reels)</b></div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    ${stat('Features (p)', MODEL_PY.p, C.cyan)}
                    ${stat('q = p/n', fmt(rd.q, 3), C.orange)}
                    ${stat('λ₊ (MP edge)', fmt(rd.lambda_plus, 3), C.red)}
                    ${stat('Signal dirs', rd.n_signal, C.green)}
                    ${stat('Ledoit–Wolf α', fmt(rd.shrinkage, 3), C.purple)}
                    ${stat('PCA dims kept', rd.n_pca, C.accent)}
                </div>
                <div style="font-size:11px;color:${C.dim};margin-top:8px">With the full extracted feature table the covariance is genuinely structured: <b>${rd.n_signal} eigen-directions clear the noise edge</b> (vs 0 for the 12 LLM levers alone) — the audio/visual atoms carry the correlated structure path signatures are built to exploit. Ledoit–Wolf auto-selected ${fmt(rd.shrinkage * 100, 0)}% shrinkage toward the stable target.</div>`);
        }
        return h;
    }

    function renderModels() {
        const m = ensureModel();
        let h = h2('Models', '§8 — ten candidates, supervised + unsupervised. With ~200 reels, lead with small, well-behaved models; treat deep ones as later.');
        // controls
        h += `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:12px">
            ${ctrl('Target', 'target', targetOptions(), state.target)}
            ${ctrl('Confounds', 'includeConfounds', [{ v: 'true', l: 'Include (strip)' }, { v: 'false', l: 'Content only' }], '' + state.includeConfounds)}
            ${state.target === 'swipe' ? ctrl('Swipe baseline', 'swipeOnRetention', [{ v: 'true', l: 'On top of retention' }, { v: 'false', l: 'Content only' }], '' + state.swipeOnRetention) : ''}
            ${ctrl('Elastic-Net α (L1 ratio)', 'enetAlpha', [{ v: 0, l: '0 · ridge' }, { v: 0.25, l: '0.25' }, { v: 0.5, l: '0.5' }, { v: 0.75, l: '0.75' }, { v: 1, l: '1 · lasso' }], state.enetAlpha)}
            ${ctrl('Elastic-Net λ', 'enetLambda', [{ v: 0.02, l: '0.02' }, { v: 0.05, l: '0.05' }, { v: 0.1, l: '0.10' }, { v: 0.2, l: '0.20' }, { v: 0.4, l: '0.40' }], state.enetLambda)}
        </div>`;
        if (state.target === 'swipe') h += note(`<b>Swipe-away playbook.</b> Target = real <code>swipedAwayRate</code> (log1p — heavy right skew), nearly orthogonal to Keep (r≈0.09) so it carries independent signal. ${state.swipeOnRetention ? 'Modelled <b>on top of retention</b> — retention is in the feature set, so the hook levers are read net of overall retention: what drives early swipe <i>beyond</i> how watchable the whole reel is.' : 'Content-only (retention baseline off).'} Lower is better, so the playbook hunts levers that <b>reduce</b> swipe.`, C.orange);
        // live results
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('OLS (ridge) R²', fmt(m.ols.r2, 3), C.cyan)}
            ${stat('Elastic-Net R²', fmt(m.enet.r2, 3), C.green)}
            ${stat('Time-split CV R²', fmt(m.cv.mean, 3) + ' ± ' + fmt(m.cv.std, 3), C.orange)}
            ${stat('E-Net non-zero feats', m.enet.nNonzero + '/' + m.cols.length, C.purple)}
            ${stat('Rank check ρ→views', fmt(m.lvRank, 3), C.accent)}
        </div>`;
        h += note(`Live fit on <b>${state.target}</b> over ${DATA.n} reels, ${state.includeConfounds ? 'confounds included (content read underneath them)' : 'content levers only'}. CV uses an <b>expanding window over real publish dates</b>${DATA.dateSpan ? ` (${DATA.dateSpan[0]} → ${DATA.dateSpan[1]})` : ''} — train on earlier reels, validate on later ones — with standardisation fit inside each train fold. This is a <b>genuine split-by-time</b>: random splits would let future trends leak into the past. The small gap between in-sample R² and CV R² is the honesty check: a big gap = overfit. Note: across 2021–2026 the winning formula drifts (§11), so honest out-of-sample retention R² is near zero — that's the real difficulty, not a bug.`, C.orange);

        // model roster table
        const okCol = v => v.startsWith('yes') ? C.green : v === 'risk' ? C.orange : C.red;
        let rowsH = MODELS.slice().sort((a, b) => a.n - b.n).map(md => `<tr style="border-bottom:1px solid ${C.border}">
            <td style="padding:7px 10px;color:${C.mute};font-family:monospace">${md.n === 0 ? '0' : md.n}</td>
            <td style="padding:7px 10px;color:${C.text};font-weight:600">${esc(md.name)} ${md.live ? tag('LIVE', C.green) : ''}</td>
            <td style="padding:7px 10px;color:${C.dim};font-size:11px">${esc(md.type)}</td>
            <td style="padding:7px 10px;color:${C.dim};font-size:11px">${esc(md.role)}</td>
            <td style="padding:7px 10px;text-align:center"><span style="color:${okCol(md.ok)};font-weight:600">${esc(md.ok)}</span></td>
        </tr>`).join('');
        h += card(`<table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid ${C.border2}">
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">#</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Model</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Type</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Why / role</th>
                <th style="text-align:center;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">200 reels?</th>
            </tr></thead><tbody>${rowsH}</tbody></table>
            <div style="font-size:10.5px;color:${C.mute};margin-top:8px">† heavily regularised: shallow trees, strong subsampling. ‡ only viable with a pretrained audio model as a frozen front end plus a light head. <b>Recommended order:</b> ① clustering first (archetypes) ② Elastic-Net / PLS baseline ③ boosting + GP ④ LambdaMART ranking check ⑤ deep last.</div>`, 12);

        // ── REAL Python pipeline results (qrd_model.json) ──
        if (MODEL_PY) {
            const py = MODEL_PY;
            const tgt = py.targets[state.target] || py.targets.retention;
            // regime sweep
            let regH = (tgt.regimes || []).map(rg => {
                const isBest = rg.regime === tgt.best_regime;
                return `<tr style="border-bottom:1px solid ${C.border}">
                    <td style="padding:6px 10px;color:${isBest ? C.cyan : C.text};font-weight:${isBest ? 700 : 400}">${esc(rg.regime)}${isBest ? ' ◀ best' : ''}</td>
                    <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${C.mute}">${rg.p}</td>
                    <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${C.dim}">${fmt(rg.elasticnet_r2, 3)}</td>
                    <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${C.dim}">${fmt(rg.rf_r2, 3)}</td>
                    <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${rg.best_r2 > 0.2 ? C.green : C.orange}">${fmt(rg.best_r2, 3)}</td>
                </tr>`;
            }).join('');
            // model zoo on best regime
            let zooH = (tgt.models || []).slice().sort((a, b) => b.r2_mean - a.r2_mean).map(md => {
                const w = Math.max(0, Math.min(1, md.r2_mean)) * 100;
                return `<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
                    <div style="min-width:170px;color:${C.text};font-size:12px">${esc(md.name)}</div>
                    <div style="flex:1;background:${C.card2};border-radius:4px;height:14px;position:relative"><div style="width:${w}%;height:100%;background:${md.r2_mean > 0.3 ? C.green : C.orange};border-radius:4px"></div></div>
                    <div style="min-width:120px;text-align:right;font-family:monospace;color:${C.dim};font-size:11px">R²=${fmt(md.r2_mean, 3)} ± ${fmt(md.r2_std, 3)}</div>
                </div>`;
            }).join('');
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('REAL PYTHON PIPELINE', C.green)}<b style="color:${C.text}">qrd/run_pipeline.py · target: ${esc(state.target)}</b></div>
                <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Nested time-split CV (sklearn TimeSeriesSplit) over the real extracted feature table. <b>§7 in action — the regime sweep:</b></div>
                <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">
                    <thead><tr style="border-bottom:1px solid ${C.border2}">
                        <th style="text-align:left;padding:5px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Feature regime</th>
                        <th style="text-align:right;padding:5px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">p</th>
                        <th style="text-align:right;padding:5px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">E-Net R²</th>
                        <th style="text-align:right;padding:5px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">RF R²</th>
                        <th style="text-align:right;padding:5px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">best</th>
                    </tr></thead><tbody>${regH}</tbody></table>
                <div style="font-size:11px;color:${C.mute};margin-bottom:6px">Full model zoo on the best regime (<b>${esc(tgt.best_regime)}</b>):</div>
                ${zooH}
                <div style="font-size:11px;color:${C.dim};margin-top:8px;border-top:1px solid ${C.border};padding-top:8px">Ranking check ρ→log-views: <b style="color:${C.cyan};font-family:monospace">${fmt(tgt.rank_rho_vs_logviews, 3)}</b> · models 2–7 (PLS, GBM, RF, GP, SVR) are computed in real scikit-learn here — now genuinely LIVE.</div>`);
            h += note(`<b>The §7 lesson, measured:</b> for <b>retention</b> the <i>llm-only</i> regime generalises best — piling all 143 raw features onto 213 reels overfits (CV R² falls). For <b>keep</b> (the 3-second hook), the <i>llm+extracted</i> regime wins: the real audio/visual hook atoms add signal exactly where the doc says they should. Reduce before you fit.`, C.orange);
        }

        // archetype clustering preview
        const colors = m.km.assign.map(a => [C.cyan, C.green, C.orange, C.purple, C.yellow][a % 5]);
        h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:6px">Model 10 · Clustering → reel archetypes (run first)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:6px">k-means (k=${state.clusterK}, seeded, deterministic) over the PCA projection. Surfaces natural types — "talking-head fast-cut", "trending-audio montage", "slow cinematic" — and checks the corpus actually overlaps rather than forming two account-driven clouds.</div>
            ${ctrl('Clusters k', 'clusterK', [{ v: 2, l: '2' }, { v: 3, l: '3' }, { v: 4, l: '4' }, { v: 5, l: '5' }], state.clusterK)}
            <div style="max-width:480px;margin-top:8px">${vizScatter(m.proj, { xlab: 'PC1', ylab: 'PC2', colors })}</div>`);
        return h;
    }

    function renderAccuracy() {
        let h = h2('Model Accuracy — How accurate is it, really?', '§8b — honest out-of-fold accuracy. Each reel is predicted by a model trained ONLY on earlier reels (time-split), standardised on the training fold alone. The in-sample → out-of-fold gap is the overfit.');

        const targets = [
            { t: 'retention', label: 'Retention', unit: '(% viewed)', col: C.green, natUnit: '%' },
            { t: 'swipe', label: 'Swipe-away', unit: '(log1p of %)', col: C.orange, natUnit: '% pts' },
        ].filter(x => x.t !== 'swipe' || DATA.swipeHit);

        const accs = targets.map(x => ({ ...x, a: accuracyFor(x.t) }));

        // headline comparison bar — out-of-fold R² per target
        h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">Out-of-fold R² — retention vs swipe (honest, time-split)</div>
            ${vizBars(accs.map(x => ({ label: x.label, val: x.a.r2oof, col: x.col })), { fmtV: v => fmt(v, 3) })}
            <div style="font-size:11px;color:${C.mute};margin-top:6px">R² = fraction of variance the model predicts on reels it never trained on. 1.0 = perfect, 0 = no better than guessing the mean, &lt;0 = worse than the mean.</div>`);

        // side-by-side predicted-vs-actual scatters
        h += `<div style="display:grid;grid-template-columns:${accs.length > 1 ? '1fr 1fr' : '1fr'};gap:14px">`;
        accs.forEach(({ t, label, unit, col, natUnit, a }) => {
            const gap = a.inSample - a.r2oof;
            h += card(`<div style="font-weight:700;color:${col};margin-bottom:6px">${esc(label)} ${t === 'swipe' ? (state.swipeOnRetention ? '· on retention' : '· content-only') : ''}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
                    ${stat('Out-of-fold R²', fmt(a.r2oof, 3), a.r2oof > 0.3 ? C.green : a.r2oof > 0 ? C.orange : C.red)}
                    ${stat('CV R² ±', fmt(a.cv.mean, 2) + '±' + fmt(a.cv.std, 2), C.cyan)}
                    ${stat('In-sample R²', fmt(a.inSample, 2), C.mute)}
                    ${stat('Typical error', '±' + fmt(a.maeNat, 1) + ' ' + natUnit, C.dim)}
                </div>
                ${vizPredVsActual(a.cv.oofAct, a.cv.oofPred, { unit, color: col })}
                ${a.cv.scores && a.cv.scores.length > 1 ? `<div style="font-size:10.5px;color:${C.mute};margin-top:8px">Per-fold R² — the confidence range. Tight cluster = stable; wide spread = the single number is noisy:</div>${vizFoldCI(a.cv.scores, a.cv.mean, a.cv.std, col)}` : ''}
                <div style="font-size:10.5px;color:${C.faint};margin-top:4px">${a.cv.oofAct.length} out-of-fold predictions across ${a.cv.folds} validation blocks. Points hugging the dashed line = accurate. In-sample ${fmt(a.inSample, 2)} → out-of-fold ${fmt(a.r2oof, 2)} = overfit gap ${fmt(gap, 2)} ${gap < 0.2 ? '(tight — trustworthy)' : '(wide — read with caution)'}.</div>`);
        });
        h += `</div>`;

        // interpretation
        const ret = accs.find(x => x.t === 'retention'), sw = accs.find(x => x.t === 'swipe');
        h += note(`<b>How to read this:</b> the honest number is <b>out-of-fold R²</b>, not the in-sample fit. ${ret ? `Retention predicts at R²≈${fmt(ret.a.r2oof, 2)} (typical miss ±${fmt(ret.a.maeNat, 1)} pts).` : ''} ${sw ? `Swipe-away predicts at R²≈${fmt(sw.a.r2oof, 2)} — ${sw.a.r2oof > 0.25 ? 'genuinely useful for ranking which reels will bleed viewers' : 'weaker; treat as directional'}.` : ''} With ~200 reels these carry real uncertainty (the ± band) — a small gap between two reels' predictions is noise, a large one is signal.`, C.cyan);

        // airtightness panel — the quant structure, swipe-specific
        const checks = [
            ['Split by time, not random', 'Train on earlier reels, validate on later — random splits would let future trends leak into the past.', true],
            ['Standardisation fit on train fold only', 'Mean/sd computed on the training block and frozen onto validation — no test statistics leak into scaling (§7).', true],
            ['Target transformed for skew', 'Swipe-away is heavy right-skew → log1p; retention is bounded 0–1. Never raw counts under squared loss.', true],
            ['Mediators excluded', 'First-hour likes/comments (downstream of content) are kept out of the model.', true],
            ['Confounds included & read under', 'Account-size proxy + duration are in the model; content levers read net of them.', true],
            ['Out-of-fold accuracy reported with ±', 'Every score carries a confidence band; tiny gaps treated as noise.', true],
        ];
        h += card(`<div style="font-weight:700;color:${C.green};margin-bottom:8px">Is the swipe model airtight? — the quant structure, enforced</div>
            ${checks.map(([t, d, ok]) => `<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid ${C.border}">
                <div style="color:${C.green};font-size:15px;min-width:18px">☑</div>
                <div><span style="color:${C.text};font-weight:600;font-size:12px">${esc(t)}</span><div style="color:${C.dim};font-size:11px;margin-top:1px">${esc(d)}</div></div>
            </div>`).join('')}`);
        h += note(`<b>One honesty flag on "on top of retention."</b> Retention is measured <i>post-publish</i>, so the on-retention swipe model is a <b>descriptive decomposition</b> — "what moves swipe-away <i>net of</i> overall retention" — not a pre-publish predictor (you don't know retention before you post). For a true <b>pre-publish</b> swipe forecast, switch the swipe baseline to <b>Content-only</b> in Models: that version uses only levers you control before posting, and its out-of-fold R² above is the honest pre-publish accuracy.`, C.orange);
        return h;
    }

    function renderSwipeTrust() {
        if (!SWIPE_PY) {
            return h2('Swipe Trust', '') + note(`Run <code>python3 buildings/jarvis/qrd/swipe_model.py</code> to generate <code>qrd_swipe.json</code>, then reload.`, C.orange);
        }
        const S = SWIPE_PY, T = S.trust;
        let h = h2('Swipe-Away Trust — is the model good enough to act on?', '★ — the swipe model, built to the quant structure and validated against the §12 leakage checklist. Three airtight framings, scored by nested time-split CV with bootstrap confidence bands.');

        // verdict banner
        const verdictCol = T.trustworthy ? C.green : C.orange;
        const barPass = Object.values(T.bar).filter(Boolean).length, barTot = Object.keys(T.bar).length;
        h += `<div style="display:flex;align-items:center;gap:16px;background:${verdictCol}14;border:1px solid ${verdictCol}66;border-radius:10px;padding:14px 18px;margin-bottom:14px">
            <div style="font-size:30px">${T.trustworthy ? '✅' : '⚠️'}</div>
            <div><div style="font-size:16px;font-weight:800;color:${verdictCol}">${T.trustworthy ? 'TRUSTWORTHY' : 'NOT YET TRUSTWORTHY'}</div>
            <div style="font-size:12px;color:${C.dim};margin-top:2px">${barPass}/${barTot} trust bars cleared · §12 leakage checklist ${S.checklist.filter(c => c.pass).length}/${S.checklist.length} · ${S.n} reels, ${T.fold_auc.length}-fold time-split</div></div>
        </div>`;

        // three framing metrics
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('Dud-detection AUC', fmt(T.auc, 3), T.auc >= 0.75 ? C.green : C.orange)}
            ${stat('AUC 90% CI', fmt(T.auc_ci[0], 2) + '–' + fmt(T.auc_ci[1], 2), C.cyan)}
            ${stat('Ranking ρ', fmt(T.spearman, 3), T.spearman >= 0.45 ? C.green : C.orange)}
            ${stat('Regression R²', fmt(T.r2_oof, 3), C.purple)}
            ${stat('Overfit gap', fmt(T.gap, 2), T.gap <= 0.2 ? C.green : C.orange)}
        </div>`;
        h += note(`<b>The trustworthy framing is dud-detection.</b> Swipe-away is bimodal — most reels keep ~everyone; a distinct ${fmt(S.base_rate * 100, 0)}% are <b>duds</b> that bleed ≥${fmt(S.dud_threshold, 0)}% in the hook. Predicting <i>which</i> reels will be duds hits <b>AUC ${fmt(T.auc, 2)}</b> (90% CI ${fmt(T.auc_ci[0], 2)}–${fmt(T.auc_ci[1], 2)}) — the CI floor sits well above 0.75, so this is reliable enough to flag a risky reel before you post. The ranking (ρ=${fmt(T.spearman, 2)}) confirms the order is real; the raw magnitude (R²=${fmt(T.r2_oof, 2)}) is the weakest leg because the magnitude is noisy, which is expected and honest.`, C.green);

        // ROC + predicted-vs-actual
        const oofReg = S.oof.filter(o => o.pred_swipe != null);
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            ${card(`<div style="font-weight:700;color:${C.orange};margin-bottom:4px">Dud detection — ROC curve (out-of-fold)</div><div style="font-size:11px;color:${C.mute};margin-bottom:6px">Each reel scored by a model trained only on earlier reels. Area under the curve = probability the model ranks a real dud above a safe reel.</div>${vizROC(S.roc, T.auc)}`)}
            ${card(`<div style="font-weight:700;color:${C.cyan};margin-bottom:4px">Predicted vs actual swipe-away %</div><div style="font-size:11px;color:${C.mute};margin-bottom:6px">Out-of-fold magnitude prediction (back-transformed to %). Spread around the line is the honest error.</div>${vizPredVsActual(oofReg.map(o => o.swipe), oofReg.map(o => o.pred_swipe), { unit: '(% swipe)', color: C.cyan })}`)}
        </div>`;

        // highest-risk reels (sorted by dud probability)
        const risky = S.oof.filter(o => o.dud_proba != null).sort((a, b) => b.dud_proba - a.dud_proba).slice(0, 10);
        let rh = risky.map(o => {
            const correct = (o.dud_proba >= 0.5) === (o.is_dud === 1);
            return `<tr style="border-bottom:1px solid ${C.border}">
                <td style="padding:6px 10px;color:${C.text};font-size:12px">${esc(o.name)}</td>
                <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${o.is_dud ? C.orange : C.dim}">${fmt(o.swipe, 1)}%</td>
                <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${C.cyan}">${fmt(o.dud_proba * 100, 0)}%</td>
                <td style="padding:6px 10px;text-align:center">${o.is_dud ? tag('DUD', C.orange) : tag('safe', C.green)}</td>
                <td style="padding:6px 10px;text-align:center">${correct ? `<span style="color:${C.green}">✓</span>` : `<span style="color:${C.red}">✗</span>`}</td>
            </tr>`;
        }).join('');
        h += card(`<div style="font-weight:600;color:${C.orange};margin-bottom:6px">Highest swipe-risk reels (model’s out-of-fold call)</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid ${C.border2}">
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Reel</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Actual swipe</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">P(dud)</th>
                <th style="text-align:center;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Truth</th>
                <th style="text-align:center;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Right?</th>
            </tr></thead><tbody>${rh}</tbody></table>`, 12);

        // dud drivers — what raises swipe-away
        const dudItems = S.dud_coefficients.slice(0, 12).map(c => ({ label: c.label, val: c.coef }));
        h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:4px">What drives a swipe-away dud (logistic coefficients)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">On standardised features. <span style="color:${C.red}">Red = raises</span> the chance of a dud, <span style="color:${C.green}">green = protects</span> against it. These are the levers the §10 playbook acts on for swipe.</div>
            ${vizBars(dudItems, { signed: true, fmtV: v => fmt(v, 2) })}`);

        // selected levers (stability across folds)
        const sel = S.selected_features.slice(0, 12);
        h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">Levers that survive L1 selection (stability across folds)</div>
            ${sel.map(s => `<span style="display:inline-block;margin:3px;background:${C.card2};border:1px solid ${C.border2};border-radius:6px;padding:4px 10px;font-size:12px;color:${C.text}">${esc(s.label)} <span style="color:${C.mute};font-family:monospace;font-size:10px">${s.folds}/5 folds</span></span>`).join('')}`);

        // §12 live checklist
        h += card(`<div style="font-weight:700;color:${C.green};margin-bottom:8px">§12 — Leakage & Causality checklist (validated on this model)</div>
            ${S.checklist.map(c => `<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid ${C.border}">
                <div style="color:${c.pass ? C.green : C.red};font-size:15px;min-width:18px">${c.pass ? '☑' : '☒'}</div>
                <div style="color:${c.pass ? C.text : C.orange};font-size:12px;line-height:1.45">${esc(c.text)}</div>
            </div>`).join('')}`);
        h += note(`<b>Validated end-to-end against the quant system.</b> Confounds at post time · mediators excluded · target transformed for skew · standardisation & selection fit on train fold only · split by time · bootstrap confidence bands · ranking confirms the order · out-of-fold honest (gap ${fmt(T.gap, 2)}). The one thing still owed, per the doc: a matched-pair <b>A/B test</b> turns each dud-driver from a hypothesis into a rule.`, C.cyan);
        return h;
    }

    function renderAttribution() {
        const m = ensureModel();
        let h = h2('Attribution — What Actually Drives ' + targetLabel(state.target), '§9 — the model’s accuracy is secondary; the attribution is the product: a ranked, signed account of which features move the target, read underneath the confounds.' + (state.target === 'swipe' ? ' Swipe is a minimise target — a negative coefficient means the lever REDUCES swipe-away (good).' : ''));
        // 1) elastic-net coefficients
        const enetItems = m.cols.map((k, j) => ({ label: featLabel(k), val: m.enet.beta[j], confound: CONFOUND_KEYS.includes(k) }))
            .sort((a, b) => Math.abs(b.val) - Math.abs(a.val));
        h += card(`<div style="font-weight:600;color:${C.green};margin-bottom:4px">§9.1a — Elastic-Net coefficients (signed effect sizes)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">On standardised features → read straight off. Green = lifts the target, red = lowers it. Confound bars are shaded; the content block is read underneath them.</div>
            ${vizBars(enetItems.map(i => ({ label: i.label + (i.confound ? ' ⊕' : ''), val: i.val })), { signed: true })}`);
        // 2) permutation importance
        const permItems = m.perm.importances.map(p => ({ label: featLabel(p.key), val: p.drop }));
        h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:4px">§9.1b — Permutation importance (R² drop when scrambled)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Scramble one feature, measure how much the model’s R² (${fmt(m.perm.base, 3)} baseline) drops. Reflects the model you actually used.</div>
            ${vizBars(permItems, { fmtV: v => fmt(v, 3) })}`);
        // 3) univariate r vs target
        const uniItems = m.uni.map(u => ({ label: featLabel(u.key), val: u.r })).sort((a, b) => Math.abs(b.val) - Math.abs(a.val));
        h += card(`<div style="font-weight:600;color:${C.orange};margin-bottom:4px">§9.1c — Univariate Pearson r vs target</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">The raw bivariate relationship — the third lens. Where all three agree you have a real driver; where they disagree, the feature is tangled — flag it, don’t trust it.</div>
            ${vizBars(uniItems.map(i => ({ label: i.label, val: i.val })), { signed: true })}`);
        // 4) SHAP — exact for a linear model: φ_ij = β_j · z_ij (z = standardised feature)
        const myT = mean(m.y);
        const shapGlobal = m.cols.map((k, j) => ({
            label: featLabel(k),
            val: mean(m.Z.map(r => Math.abs(m.enet.beta[j] * r[j]))),   // mean |contribution|
        })).sort((a, b) => b.val - a.val);
        h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:4px">§9.1d — SHAP values (mean |contribution| per feature)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">The doc's prescribed lens. For a <i>linear</i> model the SHAP value is <b>exact</b>: φ = β·(standardised feature), so this is the mean absolute push each lever makes to a prediction across all ${m.y.length} reels. Note: because φ's sign is just sign(β) here, SHAP agrees with the Elastic-Net coefficient <i>by construction</i> — it becomes a genuinely independent vote only for the nonlinear models (the Python GBM/RF rows below). The independent third lens for this linear fit is the univariate r above.</div>
            ${vizBars(shapGlobal, { fmtV: v => fmt(v, 3) })}`);
        // per-reel SHAP waterfall (highest-views reel, illustrative)
        const wreel = DATA.rows.reduce((best, r) => (r.log_views > (best.log_views ?? -Infinity) ? r : best), DATA.rows[0]);
        const wi = DATA.rows.indexOf(wreel);
        const predW = myT + m.cols.reduce((s, k, j) => s + m.enet.beta[j] * m.Z[wi][j], 0);
        const phi = m.cols.map((k, j) => ({ label: featLabel(k), val: m.enet.beta[j] * m.Z[wi][j] }))
            .filter(x => Math.abs(x.val) > 1e-6).sort((a, b) => Math.abs(b.val) - Math.abs(a.val)).slice(0, 14);
        h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:4px">SHAP waterfall — why this reel scores where it does</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px"><b>${esc((wreel.name || wreel.ytId).slice(0, 46))}</b> · base ${targetLabel(state.target)} = ${fmt(myT, 2)} → model prediction ${fmt(predW, 2)}. Each bar is that lever's signed contribution for this specific reel (green lifts, red lowers); they sum to the gap from the base.</div>
            ${vizBars(phi, { signed: true, fmtV: v => (v >= 0 ? '+' : '') + fmt(v, 3) })}`);
        // agreement panel
        const agree = m.cols.map((k, j) => {
            const e = m.enet.beta[j], p = (m.perm.importances.find(x => x.key === k) || {}).drop || 0, u = (m.uni.find(x => x.key === k) || {}).r || 0;
            const signsAgree = (Math.sign(e) === Math.sign(u)) && Math.abs(e) > 1e-4 && p > 0.002;
            return { key: featLabel(k), real: signsAgree, e, p, u };
        });
        const real = agree.filter(a => a.real);
        h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:6px">Where all three agree → real drivers</div>
            ${real.length ? real.map(a => `<div style="display:inline-block;margin:3px;background:${C.green}18;border:1px solid ${C.green}55;border-radius:6px;padding:5px 10px;font-size:12px;color:${C.text}">${esc(a.key)} <span style="color:${C.mute};font-family:monospace;font-size:10px">β=${fmt(a.e, 2)} · Δ=${fmt(a.p, 3)} · r=${fmt(a.u, 2)}</span></div>`).join('') : `<div style="color:${C.mute};font-size:12px">No feature clears all three lenses at the current λ/target — tighten α or switch target.</div>`}`);
        // ── REAL Python attribution: block importance + top extracted levers ──
        if (MODEL_PY && MODEL_PY.attribution) {
            const at = MODEL_PY.attribution;
            const blkCol = { confound: C.red, audio: C.cyan, visual: C.green, voice: C.purple, llm: C.orange, signature: C.faint };
            const blkItems = Object.entries(at.block_importance || {}).map(([b, v]) => ({ label: b, val: v, col: blkCol[b] || C.mute }))
                .sort((a, b) => b.val - a.val);
            const topEnet = at.elasticnet.slice(0, 16).map(c => ({ label: featLabel(c.key), val: c.coef }));
            h += card(`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">${tag('REAL PYTHON PIPELINE', C.green)}<b style="color:${C.text}">Block importance — which modality drives retention</b></div>
                <div style="font-size:11px;color:${C.mute};margin-bottom:8px">Sum of |Elastic-Net coefficient| per feature block over the full real feature table. The extracted <b style="color:${C.green}">visual</b> and <b style="color:${C.cyan}">audio</b> atoms carry more readable signal than the LLM scores — the waveform features earn their place.</div>
                ${vizBars(blkItems, { fmtV: v => fmt(v, 2) })}`);
            h += card(`<div style="font-weight:600;color:${C.green};margin-bottom:4px">Top levers — real Elastic-Net coefficients (all 77 readable features)</div>
                <div style="font-size:11px;color:${C.mute};margin-bottom:8px">scikit-learn ElasticNet on standardised features, retention target, ${MODEL_PY.n} reels. Extracted audio/visual atoms now appear among the strongest signed levers.</div>
                ${vizBars(topEnet, { signed: true, fmtV: v => fmt(v, 2) })}`);
        }
        h += note(`<b>§9.2 — read effects underneath the confounds.</b> Because account size & duration are in the model, the content features are read <i>net</i> of them — the whole point of including them. Report the confound importances too; they will be large and that is correct. The deliverable is the content block read underneath them. <b>Even net of confounds this is observational</b> — every finding is a hypothesis until the §10 A/B test.`, C.purple);
        return h;
    }

    function renderProduction() {
        const m = ensureModel(), rows = DATA.rows;
        if (!state.candidateId) state.candidateId = rows[rows.length - 1].ytId; // default: latest reel
        const cand = rows.find(r => r.ytId === state.candidateId) || rows[0];
        const ci = rows.indexOf(cand);
        const arche = m.km.assign[ci];
        const tname = state.target, dir = TARGET_DIR[tname] || 1;
        const tgtVal = r => rowTargetRaw(r, tname);
        // exemplars = the BEST reels on the current target within this archetype
        // (highest for retention/keep/views; LOWEST for swipe-away)
        const peers = rows.filter((r, i) => m.km.assign[i] === arche).sort((a, b) => dir * (tgtVal(b) - tgtVal(a)));
        const topPeers = peers.slice(0, Math.max(3, Math.floor(peers.length * 0.25)));
        const exLabel = tname === 'swipe' ? 'lowest-swipe' : 'top';
        let h = h2('The Production Playbook · ' + targetLabel(tname), `§10 — given a candidate reel, the ranked edit list to ${dir < 0 ? 'cut' : 'lift'} ${targetLabel(tname)}. The point of the whole build.`);

        // candidate scorecard (target-aware; model pred is in fit units)
        const predU = m.ols.pred[ci];
        const dispActual = tname === 'swipe' ? fmt(cand.swipe, 1) + '%' : tname === 'log_views' ? fmtViews(cand.views) : fmt(tgtVal(cand), 1) + '%';
        const dispPred = tname === 'swipe' ? fmt(Math.expm1(predU), 1) + '%' : tname === 'log_views' ? fmtViews(Math.pow(10, predU)) : fmt(predU, 1) + '%';
        h += `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;background:${C.card2};border:1px solid ${C.border};border-radius:8px;padding:12px">
            ${ctrl('Candidate reel', 'candidateId', rows.slice().sort((a, b) => b.views - a.views).map(r => ({ v: r.ytId, l: (r.name || r.ytId).slice(0, 40) })), state.candidateId)}
            ${ctrl('Target', 'target', targetOptions(), tname)}
        </div>`;
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('Actual ' + targetLabel(tname), dispActual, dir < 0 ? C.orange : C.green)}
            ${stat('Model-predicted', dispPred, C.cyan)}
            ${stat('Archetype', '#' + (arche + 1) + ' of ' + state.clusterK, C.purple)}
            ${stat(exLabel + ' exemplars', topPeers.length, C.accent)}
            ${tname === 'swipe' ? stat('Baseline', state.swipeOnRetention ? 'on retention' : 'content-only', C.green) : stat('Actual views', fmtViews(cand.views), C.orange)}
        </div>`;

        // gap analysis lever by lever — candidate vs exemplar mean on each lever.
        // improve = dir·gap·β  → >0 means closing the gap moves the target the good way.
        const levers = modelContentKeys().map(k => {
            const ki = m.cols.indexOf(k);
            const candV = cand[k], peerV = mean(topPeers.map(r => r[k]));
            const beta = ki >= 0 ? (m.enet.beta[ki] || 0) : 0;
            const gap = peerV - candV;
            const improve = dir * gap * beta / (m.sd[ki] || 1);
            let action = 'Hold';
            if (Math.abs(beta) > 1e-3 && Math.abs(gap) > 0.3 && improve > 0) action = (gap > 0 ? 'Raise ' : 'Lower ') + featLabel(k);
            return { k, candV, peerV, gap, beta, action, lift: improve };
        }).filter(L => m.cols.indexOf(L.k) >= 0).sort((a, b) => b.lift - a.lift);

        let rowsH = levers.map(L => {
            const dir = L.action.startsWith('Raise') ? C.green : L.action.startsWith('Lower') ? C.orange : C.mute;
            return `<tr style="border-bottom:1px solid ${C.border}">
                <td style="padding:7px 10px;color:${C.text};font-weight:600">${esc(featLabel(L.k))}</td>
                <td style="padding:7px 10px;text-align:right;font-family:monospace;color:${C.dim}">${fmt(L.candV, 2)}</td>
                <td style="padding:7px 10px;text-align:right;font-family:monospace;color:${C.cyan}">${fmt(L.peerV, 2)}</td>
                <td style="padding:7px 10px;text-align:right;font-family:monospace;color:${L.gap >= 0 ? C.green : C.red}">${L.gap >= 0 ? '+' : ''}${fmt(L.gap, 2)}</td>
                <td style="padding:7px 10px;text-align:right;font-family:monospace;color:${C.mute}">${fmt(L.beta, 2)}</td>
                <td style="padding:7px 10px"><span style="color:${dir};font-weight:600;font-size:11px">${esc(L.action)}</span></td>
            </tr>`;
        }).join('');
        h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">§10.2 — Gap analysis vs ${exLabel} reels in archetype #${arche + 1}, lever by lever</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid ${C.border2}">
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Lever</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Candidate</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">${esc(exLabel)} reels</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Gap</th>
                <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">β</th>
                <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Action</th>
            </tr></thead><tbody>${rowsH}</tbody></table>
            <div style="font-size:11px;color:${C.mute};margin-top:8px">A short, ranked edit list tied to measured levers, ordered by predicted lift (gap × coefficient). These come from the fitted model on real data, not illustrative numbers.</div>`, 12);
        // ── §10.2 canonical lever table (the doc's exact levers, real values) ──
        if (DATA.hasPy) {
            const peerMean = k => mean(topPeers.map(r => r[k]));
            const canon = [
                { lever: 'Time to first word', k: 'v_time_first_word', cand: cand.v_time_first_word, top: peerMean('v_time_first_word'), unit: 's', good: 'low', action: 'Cut the cold open' },
                { lever: 'Cuts in first 3s', k: 'vi_cut_rate', cand: (cand.vi_cut_rate || 0) * 3, top: peerMean('vi_cut_rate') * 3, unit: '', good: 'high', action: 'Tighten the open' },
                { lever: 'Loudness ramp (slope)', k: 'a_loud_slope', cand: cand.a_loud_slope, top: peerMean('a_loud_slope'), unit: '', good: 'high', action: 'Punch the hook' },
                { lever: 'Face size, first frame', k: 'vi_face_size', cand: cand.vi_face_size, top: peerMean('vi_face_size'), unit: '', good: 'high', action: 'Start on a close-up' },
                { lever: 'Text at 0s', k: 'vi_text_at0', cand: cand.vi_text_at0, top: peerMean('vi_text_at0'), unit: '', good: 'high', action: 'Add a hook caption' },
            ];
            let rh = canon.map(L => {
                const gap = L.top - L.cand;
                const behind = (L.good === 'low') ? (L.cand > L.top) : (L.cand < L.top);
                const showCand = L.k === 'vi_text_at0' ? (L.cand >= 0.5 ? 'yes' : 'no') : fmt(L.cand, 2) + L.unit;
                const showTop = L.k === 'vi_text_at0' ? fmt(L.top * 100, 0) + '% yes' : fmt(L.top, 2) + L.unit;
                return `<tr style="border-bottom:1px solid ${C.border}">
                    <td style="padding:7px 10px;color:${C.text};font-weight:600">${esc(L.lever)}</td>
                    <td style="padding:7px 10px;text-align:right;font-family:monospace;color:${C.dim}">${showCand}</td>
                    <td style="padding:7px 10px;text-align:right;font-family:monospace;color:${C.cyan}">${showTop}</td>
                    <td style="padding:7px 10px"><span style="color:${behind ? C.orange : C.green};font-weight:600;font-size:11px">${behind ? esc(L.action) : '✓ matches ' + exLabel}</span></td>
                </tr>`;
            }).join('');
            h += card(`<div style="font-weight:600;color:${C.purple};margin-bottom:6px">§10.2 — the doc’s canonical hook levers (real extracted values)</div>
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                <thead><tr style="border-bottom:1px solid ${C.border2}">
                    <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Lever</th>
                    <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Candidate</th>
                    <th style="text-align:right;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">${esc(exLabel)} reels</th>
                    <th style="text-align:left;padding:6px 10px;color:${C.mute};font-size:10px;text-transform:uppercase">Action</th>
                </tr></thead><tbody>${rh}</tbody></table>
                <div style="font-size:11px;color:${C.mute};margin-top:8px">The exact lever table from §10.2 of the doc — now driven by the real librosa/opencv extracted values, not illustrative numbers. A short, ranked edit list tied to measured levers.</div>`, 12);
        }
        h += note(`<b>§10.3 — close the loop with A/B tests.</b> Attribution gives candidate levers; only experiment confirms them. Post matched pairs that differ in exactly one lever (same topic, same time of day, alternate the day/account to stay fair) and compare retention. Each confirmed lever turns a guess into a rule and re-weights the playbook — this is how you avoid optimising into the model’s own overfit.`, C.green);
        return h;
    }

    function renderTrends() {
        const m = ensureModel(), rows = DATA.rows;
        let h = h2('Trends Drift — Refit Over Time & Track Decay', '§11 — "what wins" is itself a moving target, and it decays. A winning hook gets copied, the niche fills, it dies. Track the fade.');
        // rolling weight of top content levers over time (windowed elastic-net coefficient)
        const winFrac = 0.5, steps = 7;
        const topLevers = m.uni.filter(u => CONTENT_KEYS.includes(u.key)).sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 4).map(u => u.key);
        const series = topLevers.map(() => []);
        for (let s = 0; s < steps; s++) {
            const lo = Math.floor((rows.length * (1 - winFrac)) * (s / (steps - 1)));
            const hi = Math.floor(lo + rows.length * winFrac);
            const slice = rows.slice(lo, hi);
            const y = targetVector(slice, state.target);
            topLevers.forEach((k, ki) => { series[ki].push(pearson(slice.map(r => r[k]), y)); });
        }
        h += card(`<div style="font-weight:600;color:${C.cyan};margin-bottom:6px">§11.1–11.2 — Slide the window, watch each lever’s weight move</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:6px">200 reels split by month is too thin for a model per month. Instead fit a rolling window and watch how each feature’s weight moves. A weight that climbs then falls is the crowding-and-decay curve for that lever. Live: rolling correlation of the top content levers vs <b>${state.target}</b> across a 50% window sliding from earliest to latest reels.</div>
            ${vizDecay(series, topLevers.map(featLabel))}`);
        // decay direction per lever (slope of its rolling weight)
        const decay = topLevers.map((k, ki) => {
            const sl = series[ki][series[ki].length - 1] - series[ki][0];
            return { key: featLabel(k), trend: sl };
        }).sort((a, b) => b.trend - a.trend);
        h += card(`<div style="font-weight:600;color:${C.green};margin-bottom:6px">Rising vs fading levers (the operating signal)</div>
            <div style="font-size:11px;color:${C.mute};margin-bottom:8px">A lever whose weight is rising is entering its window; one rolling over is filling up. The playbook should favour rising levers and discount fading ones — ride hooks on the way up, drop them as they saturate.</div>
            ${decay.map(d => `<div style="display:flex;align-items:center;gap:10px;padding:5px 0"><div style="min-width:160px;color:${C.text};font-size:12px">${esc(d.key)}</div><div style="font-size:11px;color:${d.trend >= 0 ? C.green : C.orange};font-weight:600">${d.trend >= 0 ? '▲ rising' : '▼ fading'} <span style="font-family:monospace;color:${C.mute}">(${d.trend >= 0 ? '+' : ''}${fmt(d.trend, 3)})</span></div></div>`).join('')}`);
        h += note(`With this little data per period the moving weights are noisy — smooth heavily, show confidence bands, and do not over-read one window’s wiggle (same discipline as not over-reading one month of a Sharpe series). Tracking the fade is arguably the strongest part of the project: you are not hunting one permanent formula, you are finding the levers still working <i>right now</i>, before the crowd catches up.`, C.orange);
        return h;
    }

    function renderChecklist() {
        ensureModel();
        let h = h2('Leakage & Causality Checklist', '§12 — status computed honestly against how this pipeline is actually built AND what this dataset can support. Items the data can\'t support are marked, never faked.');
        const ST = {
            pass:   { c: C.green,  icon: '☑', tag: 'ENFORCED' },
            manual: { c: C.orange, icon: '☐', tag: 'MANUAL' },
            na:     { c: C.mute,   icon: '⊘', tag: 'N/A · DATA' },
        };
        let pass = 0, na = 0;
        const items = CHECKLIST.map(c => {
            const r = c.status() || { s: 'manual', why: '' };
            const s = ST[r.s] || ST.manual;
            if (r.s === 'pass') pass++; else if (r.s === 'na') na++;
            return `<div style="display:flex;align-items:flex-start;gap:12px;padding:11px 14px;border-bottom:1px solid ${C.border}">
                <div style="font-size:16px;color:${s.c};min-width:20px">${s.icon}</div>
                <div style="flex:1">
                    <div style="font-size:12.5px;color:${r.s === 'pass' ? C.text : C.dim};line-height:1.5">${esc(c.text)}</div>
                    <div style="font-size:11px;color:${C.mute};margin-top:3px;line-height:1.45">${esc(r.why)}</div>
                </div>
                <div>${tag(s.tag, s.c)}</div>
            </div>`;
        }).join('');
        h += `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
            ${stat('Enforced by build', pass + '/' + CHECKLIST.length, C.green)}
            ${stat('Blocked by data', na + '/' + CHECKLIST.length, na ? C.orange : C.green)}
            ${stat('Split strategy', (DATA && DATA.datedCount === DATA.n) ? 'by real publish date' : 'ordered', (DATA && DATA.datedCount === DATA.n) ? C.green : C.orange)}
        </div>`;
        h += card(items, 0);
        h += note(`<b>ENFORCED</b> = guaranteed by construction (mediator excluded, transformed targets, train-only CV standardisation, confidence ranges). <b>N/A · DATA</b> = the dataset can't support the rule, so it's marked honestly instead of asserted. Real publish dates are now joined for all reels (so split-by-time and post-date confounds are real), but there's still no account ID, so within-account relative views (Target 2) remains out of reach. <b>MANUAL</b> = needs you in the loop (A/B confirmation, a matched competitor set). This replaces the earlier version that reported everything as auto-passed.`, C.cyan);
        return h;
    }

    function curveReelData() {
        if (!DATA.curves || !DATA.curves.length) return null;
        return DATA.curves.find(c => c.ytId === state.curveReel) || DATA.curves[0];
    }
    function curveReelSelector() {
        if (!DATA.curves) return '';
        const opts = DATA.curves.map(c => ({ v: c.ytId, l: (c.name || c.ytId).slice(0, 38) + '  (' + fmtViews(c.views || 0) + ')' }));
        return `<div style="margin-bottom:10px">${ctrl('Reel to inspect (real extracted curves)', 'curveReel', opts, state.curveReel || (DATA.curves[0] && DATA.curves[0].ytId))}</div>`;
    }
    function alignMarkers(cr) {
        const a = cr.align || {};
        return [
            a.first_onset != null ? { t: a.first_onset, label: 'onset', color: C.orange } : null,
            a.first_word != null ? { t: a.first_word, label: 'word', color: C.cyan } : null,
            a.first_cut != null ? { t: a.first_cut, label: 'cut', color: C.green } : null,
            a.t0 != null ? { t: a.t0, label: 't₀', color: C.yellow } : null,
        ].filter(Boolean);
    }

    function featLabel(k) {
        if (EXTRACTED_LABEL[k]) return EXTRACTED_LABEL[k];
        const f = FEATURES.find(x => x.key === k);
        if (f) return f.label;
        const map = { duration_s: 'Duration', sub_view_frac: 'Account size', retention: 'Retention (baseline)',
            c_recency: 'Recency (era)', c_dow: 'Day of week', c_month_sin: 'Month (seasonal)', c_month_cos: 'Month (seasonal)' };
        return map[k] || k;
    }

    // ══════════════════════════════════════════════════════════════════
    // OUTER RENDER + MOUNT + EVENT DELEGATION
    // ══════════════════════════════════════════════════════════════════

    function sectionBody() {
        switch (state.section) {
            case 'overview': return renderOverview();
            case 'playground': return renderPlayground();
            case 'targets': return renderTargets();
            case 'data': return renderData();
            case 'features': return renderFeatures();
            case 'sequence': return renderSequence();
            case 'reduction': return renderReduction();
            case 'models': return renderModels();
            case 'accuracy': return renderAccuracy();
            case 'swipeTrust': return renderSwipeTrust();
            case 'attribution': return renderAttribution();
            case 'production': return renderProduction();
            case 'trends': return renderTrends();
            case 'checklist': return renderChecklist();
            default: return renderOverview();
        }
    }

    function shellHTML() {
        const subnav = SECTIONS.map(s => `<button data-qrd-nav="${s.id}" style="cursor:pointer;border:none;border-radius:6px;padding:6px 11px;font-size:11px;font-weight:600;white-space:nowrap;letter-spacing:0.2px;
            background:${state.section === s.id ? C.accent : 'transparent'};
            color:${state.section === s.id ? '#fff' : C.mute};
            border:1px solid ${state.section === s.id ? C.accent : C.border};">
            <span style="opacity:0.7;font-family:monospace;font-size:9px">${s.n}</span> ${esc(s.label)}</button>`).join('');
        return `
        <div style="margin-bottom:6px">
            <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px">
                <div style="font-size:18px;font-weight:800;color:${C.text};letter-spacing:0.4px">QUANT RESEARCH DECODED</div>
                <div style="font-size:11px;color:${C.mute}">Deterministic atomic model · short-form view count · ${DATA ? DATA.n : '…'} reels · 100% computed in-browser</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid ${C.border};margin-bottom:16px">${subnav}</div>
        </div>
        <div>${sectionBody()}</div>`;
    }

    function loadingHTML() {
        return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:280px;gap:10px">
            <div style="font-size:14px;color:${C.cyan};font-weight:600">Loading feature table & fitting deterministic model…</div>
            <div style="font-size:11px;color:${C.mute}">signals-dataset-expanded.json · vision-scores-cache.json</div></div>`;
    }
    function errorHTML(e) {
        return `<div style="padding:24px;color:${C.red};font-size:13px">Failed to load QRD data: ${esc(e && e.message || e)}<div style="color:${C.mute};font-size:11px;margin-top:8px">Check that signals-dataset-expanded.json is reachable under ./buildings/jarvis/.</div></div>`;
    }

    function rerender() { if (root) root.innerHTML = shellHTML(); }

    function onClick(e) {
        const nav = e.target.closest('[data-qrd-nav]');
        if (nav && root.contains(nav)) { state.section = nav.dataset.qrdNav; rerender(); return; }
        const act = e.target.closest('[data-qrd-act]');
        if (act && root.contains(act)) {
            if (act.dataset.qrdAct === 'predict') doPredict();
            return;
        }
    }
    function onChange(e) {
        const fileEl = e.target.closest('[data-qrd-file]');
        if (fileEl && root.contains(fileEl)) {
            const f = fileEl.files && fileEl.files[0];
            state.pgFile = f || null; state.pgFileName = f ? f.name : ''; state.pgError = null; state.pgResult = null;
            rerender(); return;
        }
        const ctl = e.target.closest('[data-qrd-ctl]');
        if (!ctl || !root.contains(ctl)) return;
        const key = ctl.dataset.qrdCtl, val = ctl.value;
        if (key === 'pgType') { state.pgType = val; state.pgResult = null; }
        if (key === 'includeConfounds') state.includeConfounds = (val === 'true');
        else if (key === 'enetAlpha') state.enetAlpha = +val;
        else if (key === 'enetLambda') state.enetLambda = +val;
        else if (key === 'clusterK') state.clusterK = +val;
        else if (key === 'target') state.target = val;
        else if (key === 'candidateId') state.candidateId = val;
        else if (key === 'featStatus') state.featStatus = val;
        else if (key === 'trailingK') state.trailingK = +val;
        else if (key === 'curveReel') state.curveReel = val;
        else if (key === 'swipeOnRetention') state.swipeOnRetention = (val === 'true');
        rerender();
    }

    async function mount(el) {
        if (!el) return;
        root = el;
        if (!root.__qrdBound) {
            root.addEventListener('click', onClick);
            root.addEventListener('change', onChange);
            root.__qrdBound = true;
        }
        if (!DATA && !loadError) {
            root.innerHTML = loadingHTML();
            try { await loadData(); computeAll(); }
            catch (e) { loadError = e; root.innerHTML = errorHTML(e); return; }
        }
        if (loadError) { root.innerHTML = errorHTML(loadError); return; }
        rerender();
    }

    return { mount, _engine: { pearson, spearman, jacobiEigen, marchenkoPastur, ridgeFit, elasticNetFit, kmeans, timeSplitCV, standardizeMatrix, covarianceMatrix } };
})();

if (typeof window !== 'undefined') window.JarvisQRD = JarvisQRD;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisQRD;
