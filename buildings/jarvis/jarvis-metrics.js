/**
 * jarvis-metrics.js — Node-native metric extraction + statistics for Jarvis pipeline.
 * Replaces numpy/scipy dependency for hosted Render execution.
 */

// ── Statistical helpers (no external deps) ───────────────────────────────

/** Simple mean */
function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

/** Population std dev (matches numpy.std default ddof=0) */
function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    let ss = 0;
    for (let i = 0; i < arr.length; i++) ss += (arr[i] - m) ** 2;
    return Math.sqrt(ss / arr.length);
}

/** Population variance (numpy.var ddof=0) */
function variance(arr) {
    if (!arr.length) return 0;
    const m = mean(arr);
    let ss = 0;
    for (let i = 0; i < arr.length; i++) ss += (arr[i] - m) ** 2;
    return ss / arr.length;
}

/** Simple linear regression: returns { slope, intercept } */
function linregress(x, y) {
    const n = x.length;
    if (n < 2) return { slope: 0, intercept: 0 };
    const mx = mean(x), my = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx;
        num += dx * (y[i] - my);
        den += dx * dx;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = my - slope * mx;
    return { slope, intercept };
}

/** Pearson correlation coefficient + two-tailed p-value */
function pearsonr(x, y) {
    const n = x.length;
    if (n < 3) return { r: 0, p: 1 };
    const mx = mean(x), my = mean(y);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    if (denom === 0) return { r: 0, p: 1 };
    const r = Math.max(-1, Math.min(1, num / denom));
    // t-test for significance
    const t = r * Math.sqrt((n - 2) / (1 - r * r + 1e-15));
    const p = twoTailPFromT(Math.abs(t), n - 2);
    return { r, p };
}

/** Spearman rank correlation */
function spearmanr(x, y) {
    const n = x.length;
    if (n < 3) return { rho: 0, p: 1 };
    const rx = rank(x), ry = rank(y);
    return pearsonr(rx, ry);  // Spearman = Pearson on ranks
}

/** Assign ranks (average for ties, matching scipy.stats.rankdata) */
function rank(arr) {
    const n = arr.length;
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
        let j = i;
        while (j < n - 1 && indexed[j + 1].v === indexed[i].v) j++;
        const avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
        i = j + 1;
    }
    return ranks;
}

/** Two-tailed p-value from t-statistic using Beta incomplete function approx.
 *  Good enough for n > 20 which is always true (min_n=50). */
function twoTailPFromT(t, df) {
    // Use the regularized incomplete beta function approximation
    const x = df / (df + t * t);
    const p = betaIncomplete(df / 2, 0.5, x);
    return Math.min(1, Math.max(0, p));
}

/** Regularized incomplete beta function Ix(a, b) — continued fraction approx.
 *  Lentz's algorithm. Accuracy sufficient for pipeline use. */
function betaIncomplete(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);
    // Use continued fraction (Lentz)
    if (x < (a + 1) / (a + b + 2)) {
        return front * betaCF(a, b, x) / a;
    }
    return 1 - front * betaCF(b, a, 1 - x) / b;
}

function betaCF(a, b, x) {
    const maxIter = 200;
    const eps = 1e-10;
    let qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIter; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
        c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
        c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < eps) break;
    }
    return h;
}

/** Stirling's approximation for ln(Gamma(x)) — good for x > 0.5 */
function lnGamma(x) {
    // Lanczos approximation (g=7, n=9)
    const g = 7;
    const c = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    }
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < c.length; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Skewness (Fisher's, matching scipy.stats.skew) */
function skew(arr) {
    const n = arr.length;
    if (n < 3) return 0;
    const m = mean(arr);
    let m2 = 0, m3 = 0;
    for (let i = 0; i < n; i++) {
        const d = arr[i] - m;
        m2 += d * d;
        m3 += d * d * d;
    }
    m2 /= n;
    m3 /= n;
    const s = Math.sqrt(m2);
    if (s === 0) return 0;
    return m3 / (s * s * s);
}

// ── Metric definitions ───────────────────────────────────────────────────

const RETENTION_POINTS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95];
const RETENTION_WINDOWS = [
    [0, 5], [0, 10], [5, 15], [10, 20], [20, 30], [30, 40], [40, 50],
    [50, 60], [60, 70], [70, 80], [80, 90], [90, 100], [95, 100],
];
const DAILY_VIEWS_WINDOWS = [[0, 1], [0, 3], [0, 7], [7, 14], [14, 30]];
const DAILY_VIEWS_RATIOS = [
    ['week2', 'week1', 7, 14, 0, 7],
    ['month1', 'week1', 0, 30, 0, 7],
    ['week3', 'week2', 14, 21, 7, 14],
];

const MOTION_KEYWORDS = new Set([
    'moving', 'motion', 'walking', 'running', 'jumping', 'dancing',
    'gesture', 'action', 'dynamic', 'swinging', 'waving', 'shaking',
]);
const CLIMAX_LABELS = new Set(['climax', 'peak', 'payoff', 'reveal']);

// ── Zygarnik / Open-Loop / Gratification Delay word lists ───────────────

const ZYGARNIK_PHRASE_SETS = {
    open_loop: [
        'what if', 'i wonder', "let's see", 'will it', 'can i', 'can we',
        'how many', 'is it possible', 'to find out', 'to see if', 'to see how',
        'to test', 'but first', 'wait until', 'watch what', "you won't believe",
        "let's find out", 'the question is', 'i wanted to see', 'i wanted to find out',
        'i wanted to test', 'i wanted to know', 'could i', 'could we', 'would it',
        'i need to know', 'i have to try', 'we need to find', "let's test",
        'to figure out', 'if it works', 'if this works', 'whether it',
    ],
    closure: [
        'it works', 'it worked', 'i did it', "it's done", 'finally done',
        'finished', 'the result is', 'turned out', 'success', 'nailed it',
        'as expected', 'complete', 'completed', 'as you can see',
        'the answer is', "here's what happened", "that's how", 'the winner is',
        'and there you go', 'there you have it', 'and that is', 'so basically',
        'worked perfectly', 'mission accomplished', 'all done', 'easy',
    ],
    unresolved_ref: [
        'this thing', 'check this', 'watch this', 'look at this',
        'what happens', 'what happened', 'what will', 'what would',
        'the result', 'the answer', 'the outcome', 'the truth',
        'the secret', "you'll see", 'wait for it', 'you will see',
        'stay tuned', 'keep watching', 'the moment', 'the big',
        'wait for this', 'here it is', 'look what', 'see what',
    ],
    temporal_anticipation: [
        'about to', 'going to', 'gonna', 'when i', 'once i', 'after this',
        'almost', 'ready to', 'here we go', "let's go", "let's do",
        'about to see', 'about to find', 'about to test', 'get ready',
        'brace yourself', 'in a second', 'in a moment', 'any second',
    ],
    contrast: [
        'but', 'however', 'instead', 'versus', 'surprisingly',
        'actually', 'except', 'though', 'although', 'yet',
        'on the other hand', 'plot twist', 'the catch',
    ],
    superlative: [
        'most', 'best', 'worst', 'biggest', 'smallest', 'fastest',
        'strongest', 'first ever', 'never before', "world's", 'ever',
        'insane', 'impossible', 'unbelievable', 'incredible', 'crazy',
        'extreme', 'ultimate', 'maximum', 'legendary',
    ],
    action_verb: [
        'make', 'making', 'build', 'building', 'create', 'creating',
        'try', 'trying', 'test', 'testing', 'break', 'breaking',
        'destroy', 'destroying', 'cut', 'cutting', 'open', 'opening',
        'eat', 'eating', 'cook', 'cooking', 'turn', 'turning',
        'use', 'using', 'smash', 'smashing', 'drop', 'dropping',
        'launch', 'launching', 'pour', 'pouring', 'mix', 'mixing',
    ],
    sensory: [
        'look', 'watch', 'see', 'hear', 'feel', 'taste', 'smell',
        'notice', 'check this', 'look at', 'watch this',
        'listen', 'touch', 'sounds like', 'looks like', 'feels like',
    ],
    imperative: [
        "let's", 'check out', 'watch this', 'look at', 'imagine', 'think about',
        'guess what', 'wait', 'hold on', 'stay tuned', 'keep watching',
        "don't go", 'stick around', 'pay attention', 'remember this',
    ],
    outcome_ref: [
        'result', 'answer', 'outcome', 'what happens', 'what happened',
        'the winner', 'the verdict', 'turns out', 'find out', 'found out',
        'the truth', 'the secret', 'spoiler', 'the reveal',
    ],
    suspense: [
        'careful', 'dangerous', 'risky', 'scary', 'terrifying',
        'deadly', 'insane', 'wild', 'intense', 'nervous',
        'hoping', 'praying', 'fingers crossed', 'moment of truth',
        'do or die', 'no turning back', 'nerve',
    ],
    identity_hook: [
        "if you", "for anyone who", "have you ever", "you know that feeling",
        "does this sound familiar", "anyone else", "raise your hand if",
        "you might be", "sounds like you", "if this is you", "relate",
        "been there", "we all know", "this is for you", "for those of you",
    ],
    social_proof: [
        "million", "millions of", "everyone", "most people", "studies show",
        "research shows", "experts say", "proven", "scientists", "according to",
        "data shows", "statistically", "90 percent", "99 percent",
        "thousands of", "viral", "trending", "people are saying",
    ],
    scarcity: [
        "limited time", "running out", "before it", "disappearing", "last chance",
        "only a few", "once in a lifetime", "never again", "rare", "exclusive",
        "while you can", "dont miss", "time sensitive", "act now",
    ],
    pattern_interrupt: [
        "wait", "stop", "actually no", "plot twist", "wrong", "mistake",
        "i lied", "not what you think", "you were wrong", "everybody says",
        "they say", "but the truth", "unpopular opinion", "nobody talks about",
        "what nobody tells you", "secret nobody",
    ],
    foreshadow: [
        "you will see", "by the end", "coming up", "stay for this", "the moment when",
        "here is the twist", "everything changes when", "wait for the part where",
        "i am saving the best", "the real surprise", "you will not believe what",
        "stick around for", "coming later", "later in this video", "before i show you",
    ],
    stakes_high: [
        "everything changes", "life changing", "never be the same", "risk everything",
        "all or nothing", "make or break", "point of no return", "game changer",
        "changed my life", "changed everything", "stakes are high", "this is huge",
        "the most important", "most critical", "biggest thing",
    ],
    credibility_signal: [
        "years of", "i have done this", "i have been doing", "my experience",
        "i tested", "i tried", "i built", "i made", "based on", "the data shows",
        "the science says", "been proven", "verified", "confirmed", "real results",
        "actual results", "it actually works", "this actually works",
    ],
    reward_language: [
        "finally", "exactly how", "step by step", "here is how", "the key is",
        "what actually works", "the truth about", "worth it", "paid off",
        "the solution", "solved", "figured it out", "the answer is", "found the way",
        "the method", "the technique", "the approach", "the strategy",
    ],
    loss_aversion: [
        "stop wasting", "do not make this mistake", "avoid this", "biggest mistake",
        "most people fail", "why most fail", "if you do not", "what could go wrong",
        "the risk", "the danger", "you will lose", "you could lose", "at risk",
        "common error", "wrong way", "the wrong approach",
    ],
    urgency: [
        "right now", "immediately", "do not wait", "today", "before it is too late",
        "time is running out", "quickly", "fast", "sooner the better",
        "the longer you wait", "every second counts", "do it now", "as soon as",
        "no time to waste", "urgent",
    ],
    delayed_gratification: [
        'worth the wait', 'pay off', 'by the end', 'stay for', 'keep watching',
        'coming up', 'before I show', 'first let me', 'later in', 'trust me',
        'about to', 'stick around', 'do not skip', 'the result is', 'big reveal',
        'the answer is', 'finally shows', 'almost there', 'hold on',
    ],
    reference_callback: [
        'remember when', 'as I mentioned', 'I said earlier', 'going back to',
        'like I showed', 'that is why', 'which means', 'so now', 'this is why',
        'this proves', 'see what I mean', 'full circle', 'coming back to',
        'here is the proof', 'just like I said', 'pays off now', 'and now you see',
    ],
    visual_proof: [
        'look at', 'watch this', 'notice', 'see here', 'right here',
        'look closely', 'can you see', 'as you can see', 'proof right here',
        'before and after', 'compare', 'spot the difference', 'did you catch',
        'pay attention', 'look at that', 'side by side', 'evidence right here',
    ],
    story_stake: [
        'everything depends', 'make or break', 'on the line', 'all or nothing',
        'cost me', 'no choice', 'last chance', 'final attempt', 'biggest mistake',
        'if this fails', 'high stakes', 'do or die', 'critical moment',
        'cannot fail', 'must succeed', 'everything on the line', 'nothing to lose',
    ],
    transformation: [
        'used to be', 'turned it around', 'changed everything', 'from zero to',
        'a year later', 'six months of', 'i was broke', 'now i make',
        'the old me', 'new version', 'completely different', 'unrecognisable',
        'my life before', 'look where i am now', 'never thought i would',
        'before this happened', 'after i changed', 'i became', 'transformed my',
    ],
    vulnerability: [
        'i am embarrassed', 'i was ashamed', 'no one knew', 'i never told',
        'this is hard to say', 'i almost quit', 'i failed', 'my biggest regret',
        'i was scared', 'i cried', 'i felt like a fraud', 'imposter syndrome',
        'i doubted myself', 'i made a mistake', 'i was wrong about',
        'i wish someone told me', 'i was not okay', 'i struggled',
    ],
    specificity_anchor: [
        'at exactly', 'in just', 'after only', 'exactly how much', 'the exact number',
        'in 30 days', 'in 90 days', 'specific', 'precisely', 'to the dollar',
        'down to the day', 'per month', 'per year', 'step one', 'step two',
        'step three', 'here are the five', 'the three reasons', 'exactly',
    ],
    micro_commitment: [
        'if you are still watching', 'comment below', 'let me know', 'tell me',
        'drop a', 'save this', 'share this', 'you with me', 'follow along',
        'do this with me', 'take notes', 'write this down', 'pause here',
        'try this', 'test this', 'bookmark this', 'nod your head', 'stay with me',
    ],
    emotional_peak: [
        'unbelievable', 'i cannot believe', 'this blew my mind', 'shocked',
        'jaw dropped', 'mind blown', 'electric', 'heart racing', 'goosebumps',
        'surreal', 'overwhelming', 'speechless', 'in tears', 'screaming inside',
        'best feeling ever', 'worst feeling', 'i lost it', 'completely lost it',
    ],
    revelation_pace: [
        'first i need to explain', 'before we get to', 'there is more',
        'but that is not all', 'i saved the best', 'the final piece',
        'one more thing', 'and here is the kicker', 'plot thickens',
        'wait there is more', 'the last part', 'and then it gets worse',
        'but it gets better', 'the twist comes', 'the real reason',
    ],
    social_contrast: [
        'most people do not know', 'while everyone else', 'they do not want you to know',
        'the real truth', 'what i know that you', 'the insider secret',
        'what nobody tells you', 'hidden from', 'they hide this',
        'the thing they never teach', 'mainstream does not', 'what the pros know',
        'what beginners miss', 'the hack they do not share', 'what i learned the hard way',
    ],
    anticipatory_build: [
        'just a few more', 'almost ready', 'we are getting close', 'nearly there',
        'patience', 'the wait is almost over', 'building to', 'leading up to',
        'every second closer', 'worth it trust me', 'not long now', 'you will thank me',
        'getting warmer', 'closer and closer', 'right around the corner',
    ],
    // Group X: New conceptual families
    tension_ratchet: [
        'it gets worse', 'then something unexpected', 'but that was just the beginning',
        'little did i know', 'and then everything changed', 'what happened next',
        'but wait', 'and it only got worse', 'that was nothing compared to',
        'the real problem', 'things spiraled', 'it escalated quickly',
        'then it hit me', 'that is when', 'out of nowhere',
        'everything fell apart', 'i had no idea', 'it was about to get much worse',
        'the situation escalated', 'stakes just went up', 'it gets even better',
    ],
    promise_echo: [
        'remember what i said', 'like i mentioned', 'as i promised', 'i told you',
        'going back to what', 'recall that', 'earlier i said', 'you might remember',
        'as i showed you', 'circling back', 'that brings us back',
        'this is what i was talking about', 'which is why i said', 'as promised',
        'remember the', 'earlier we', 'going back to',
    ],
    story_clock: [
        'by the end of this', 'in the next', 'within minutes', 'before this video ends',
        'at the end i will', 'at the end of this video', 'by the time you finish watching',
        'by the end', 'in just a moment', 'coming up', 'stay till the end',
        'stick around because', 'do not skip ahead', 'save this for later',
        'before i show you', 'later in this video', 'in a few minutes',
        'stay to the end', 'at the very end', 'keep watching',
    ],
    proof_build: [
        'here is proof', 'the data shows', 'as you can see', 'the evidence',
        'studies show', 'research shows', 'tested this', 'ran the numbers',
        'i measured', 'here are the results', 'the experiment showed',
        'this confirms', 'this proves', 'the numbers', 'statistically',
        'according to', 'in my experience testing', 'the stats show',
        'i have proof', 'look at this', 'check this out', 'as you saw',
        'see for yourself', 'the math', 'here is the data',
    ],
};

// ── New phrase sets for expanded indicator families (Group P) ─────────────

const NEW_PROOF_PHRASES = [
    'the result', 'it worked', 'here is the result', 'look at this', 'as you can see',
    'check this out', 'before and after', 'here it is', 'turns out', 'proof',
    'evidence', 'you can see', 'i showed', 'what happened was',
];

const NEW_SETUP_PHRASES = [
    'the problem', 'i was', 'i had', 'imagine', 'what if', 'the question is',
    'most people', 'everyone thinks', 'the truth is', 'here is what',
    'let me show', 'i want to show', 'you might think', 'the challenge', 'the struggle',
];

const NEW_PAYOFF_PHRASES = [
    'the result', 'it worked', 'in the end', 'finally', 'at the end',
    'and that is how', 'so that is why', 'this is the answer', 'here is what happened',
    'the takeaway', 'what i learned', 'the lesson', 'that is why',
];

const NEW_VISUAL_PROOF_PHRASES = [
    'look at this', 'as you can see', 'check this out', 'before and after',
    'watch this', 'see the results', 'here are the numbers', 'the data shows',
    'here is what', 'i will show you', 'you can see', 'look how', 'notice how',
    'see how', 'here is proof',
];

const NEW_CREDENTIAL_PHRASES = [
    'i tested', 'the science says', 'studies show', 'my clients',
    'in my experience', 'i found', 'research shows', 'data shows', 'according to',
    'experts say', 'i spent', 'i tried', 'it took me', 'tested this',
];

const NEW_CONSEQUENCE_PHRASES = [
    'that meant', 'which means', 'so that', 'as a result', 'because of this',
    'this is why', 'which led to', 'ended up', 'turned out', 'the consequence',
    'that is when', 'everything changed',
];

const NEW_PERSONAL_STAKE_PHRASES = [
    'my life', 'everything changed', 'almost lost', 'could have', 'would have',
    'saved me', 'cost me', 'changed everything', 'biggest mistake', 'best decision',
    'best thing', 'ruined', 'broke', 'fixed',
];

const NEW_MICRO_REWARD_PHRASES = [
    'exactly', 'that is right', 'here is why', 'wait for it', 'i will show',
    'you will see', 'now watch', 'here is the thing', 'the reason is',
    'this is key', 'pay attention', 'this is important', 'here is what most',
    'most people do not know',
];

const NEW_EARLY_ENGAGEMENT_PHRASES = [
    'think about this', 'imagine', 'picture this',
    'have you ever', 'do you know', 'what would you', 'can you imagine',
    'what if i told', 'here is something',
];

const NEW_MID_FILLER_PHRASES = [
    'um', 'uh', 'so basically', 'and then', 'like i said',
    'you know', 'anyway', 'moving on', 'so yeah', 'and so',
];

const NEW_CLOSING_HOOK_PHRASES = [
    'but wait', 'one more thing', 'before you go', 'last thing',
    'hold on', 'now here is', 'one last', 'quick thing', 'i almost forgot',
];

// ── Group Q phrase sets ───────────────────────────────────────────────────

const ANTICIPATION_PHRASES = [
    'wait for it', "here's the thing", "you won't believe", 'before i show you',
    'but first', 'hold on', "here's what happened", 'wait until you see',
    'you need to see this', 'stay with me', 'trust me on this',
    'this is where it gets', 'it gets better', 'it gets worse', 'what happens next',
];

const COUNTERINTUITIVE_PHRASES = [
    'actually', 'surprisingly', 'counterintuitively', "you'd think",
    'most people think', 'the truth is', 'turns out', 'it turns out',
    'plot twist', "here's the twist", "not what you'd expect",
    'against all odds', 'nobody expected', 'the opposite', 'contrary to',
    'what actually happened', 'what really works', 'what i found instead',
];

const CONFESSION_PHRASES = [
    'i was wrong', 'i made a mistake', 'i failed', 'honestly',
    'truth is', 'i struggled', "it wasn't easy", 'i almost gave up',
    "i didn't know", 'i had no idea', 'embarrassing', 'hard to admit',
    'i was scared', 'i was nervous', 'the real reason', 'behind the scenes',
    'what nobody shows', 'the ugly truth',
];

const ESCALATION_PHRASES = [
    'and then', 'but then', "what's worse", 'it gets worse',
    'even more', 'and on top of that', 'to make matters worse',
    "but here's the thing", "that's when", "and that's when",
    'which means', 'so naturally', 'so i decided', 'so what did i do',
    'the next step', 'what happened next',
];

const SPECIFICITY_PHRASES = [
    'exactly', 'specifically', 'precisely', 'in particular',
    'to be exact', 'to be specific', 'the specific', 'the exact',
    'for instance', 'for example', 'such as', 'like this',
    "here's an example", 'case study', 'data shows', 'the numbers show',
    'the stat', 'the statistic',
];

const CALLBACK_PHRASES = [
    'as i mentioned', 'remember when', 'earlier i said', 'going back to',
    'like i said', 'as we saw', 'as you saw', 'we talked about',
    'i talked about', 'i mentioned earlier', 'this connects to',
    'this ties back', 'which brings us back', 'full circle', 'coming full circle',
];

const URGENCY_PHRASES = [
    "don't miss", 'watch till the end', 'watch to the end', 'stay till the end',
    "before it's too late", 'limited time', 'right now', 'today only',
    'act now', 'time is running out', "don't scroll past", 'stop scrolling',
    'you need to watch', 'most important', 'the most important thing',
    'pay attention', 'this matters', 'this is crucial', 'this changes everything',
];

// ── Group R phrase sets ────────────────────────────────────────────────────

const RHETORICAL_QUESTION_PHRASES = [
    'what if', 'have you ever', 'did you know', 'why do', 'why does',
    'how do you', 'have you noticed', 'ever wonder', 'ever wondered',
    'ever feel', 'does this sound', 'sound familiar', 'can you imagine',
    'imagine if', 'what would you do', 'what would happen',
    'have you tried', 'are you one of', 'are you still',
];

const SOCIAL_COMPARISON_PHRASES = [
    'most people', 'everyone thinks', 'everyone knows', 'everybody',
    'nobody tells you', 'they never tell you', 'no one talks about',
    'other people', 'other creators', 'your competitors', 'compared to',
    'versus', ' vs ', 'unlike most', 'unlike other', 'unlike the',
    'the difference between', 'sets apart', 'what separates',
];

const TRANSFORMATION_ARC_PHRASES = [
    'from zero to', 'went from', 'turned into', 'transformed',
    'used to be', 'used to think', 'used to', 'i was once',
    'no longer', 'not anymore', 'completely changed', 'changed everything',
    'life-changing', 'game-changing', 'changed my', 'changed how',
    'before i knew', 'before i learned', 'after i learned', 'once i realized',
];

const LOSS_FRAMING_PHRASES = [
    "don't make", 'avoid this', 'stop doing', 'quit doing', 'never do',
    'big mistake', 'costly mistake', 'terrible mistake', 'huge mistake',
    'the problem with', "here's the problem", 'the issue with',
    'what goes wrong', 'why it fails', 'why people fail', 'common mistake',
    'you could lose', "don't lose", 'losing', 'costs you', 'hurts you',
    'destroying your', 'killing your',
];

const MYSTERY_SETUP_PHRASES = [
    'the secret', 'the truth', "what's really", 'what really happens',
    'behind the scenes', 'the real reason', 'no one tells you',
    "you won't find this", 'hidden', 'mystery', 'unexpected',
    "what's inside", "what's actually", 'the actual', 'the real',
    'shocking', 'surprising truth', 'the surprising', 'believe it or not',
];

const PROMISE_SPECIFICITY_PHRASES = [
    'by the end', 'after watching', 'after this', 'in this video',
    'today i will', "today i'm going to", "i'm going to show you",
    "i'll show you", "i'll teach you", "i'll give you",
    'you will learn', "you'll learn", "you'll get", "you'll have",
    'step by step', 'the exact steps', 'the exact', 'exactly how',
    'the complete', 'the full', 'everything you need',
];

const PATTERN_INTERRUPT_PHRASES = [
    'wait', 'hold on', 'stop', 'actually no', 'but wait',
    'i was wrong', 'i was wrong about', 'scratch that',
    'not exactly', 'not quite', 'well actually', 'well not exactly',
    'here is the thing', "here's the catch", "here's the twist",
    "that's where it gets interesting", 'the plot twist',
    'i lied', 'okay real talk',
];

const VIEWER_STAKES_PHRASES = [
    'for you', 'your business', 'your channel', 'your life', 'your career',
    'your future', 'you need this', 'you need to know', 'you should know',
    'critical for you', 'important for you', 'affects you', 'impacts you',
    'change your', 'improve your', 'grow your', 'fix your',
    'save you', 'help you', 'benefit you',
];

// ── Group S phrase arrays ──
const SOCIAL_PROOF_PHRASES = [
    'studies show', 'research shows', 'according to', 'proven', 'data shows',
    'statistics show', 'percent of people', 'millions of', 'thousands of',
    'experts say', 'scientists found', 'survey found', 'results show',
    'the numbers', 'backed by', 'evidence shows', 'clinical', 'scientifically',
];
const CURIOSITY_GAP_PHRASES = [
    'you probably don', "you don't know", 'most people miss', 'most people don',
    'what nobody', 'the thing is', 'here is why', "here's why", 'the reason is',
    'turns out', 'it turns out', "here's the secret", 'the real secret',
    "here's what", 'what actually', "what's really", 'the hidden', 'the missing',
    'overlooked', 'underrated', 'the key is', "here's the key",
];
const EMOTIONAL_PEAK_PHRASES = [
    'honestly', 'genuinely', 'truly', 'literally', 'absolutely', 'completely',
    'blew my mind', 'blew me away', 'i was shocked', 'i was devastated',
    'i was terrified', 'i was amazed', 'unbelievable', 'incredible', 'insane',
    'ridiculous', 'wild', 'crazy', 'i cried', "i couldn't believe",
];
const COMMITMENT_DEVICE_PHRASES = [
    'by the end of this', 'stay until', 'stick around', 'stay to the end',
    "don't leave yet", 'part one', 'part two', 'series', 'next video',
    'next week', 'tomorrow i will', 'subscribe to see', 'challenge accepted',
    'day one', 'day two', 'week one', 'follow along', 'join me', 'the journey',
];
const PROOF_OF_WORK_PHRASES = [
    'i tested', "i've tested", 'i tried', 'i spent', 'after years',
    'after months', 'after weeks', 'i built', 'i created', 'i learned',
    "i've been doing this", 'my experience', 'in my experience', 'from experience',
    'i went through', 'i did this for', 'hours of', 'i analyzed', 'i researched',
    'i found that', 'my results',
];
const FUTURE_SELF_PHRASES = [
    'you will be', "you'll be able to", "you'll finally", "you'll never",
    'imagine yourself', 'your future', 'by next month', 'in 30 days',
    'in 90 days', 'a year from now', 'six months from now', 'the version of you',
    'who you want to be', 'who you become', 'your future self', 'build the life',
    'the life you want', 'the person you', 'one day you',
];
const FAILURE_VULNERABILITY_PHRASES = [
    'i failed', "i've failed", 'my biggest failure', 'i was wrong',
    'i made a mistake', 'i got this wrong', 'embarrassing', 'humiliating',
    'i struggled', 'the hardest part', 'i almost quit', 'i wanted to quit',
    "i couldn't figure", 'i had no idea', 'i was clueless', "i didn't know",
    'i was terrible', 'i sucked at', 'my worst', 'brutal lesson',
];
const ACTION_TRIGGER_PHRASES = [
    'right now', 'do this now', 'start today', 'start now', 'take action',
    'take this step', 'the next step', 'first step', 'step one is', 'begin by',
    'get started', 'go ahead and', 'click the link', 'use the code',
    'limited time', 'before it', 'before you', 'do not wait', "don't wait",
    'act now', 'deadline',
];

// ── Group T phrase arrays ──
const REFERENCE_CALLBACK_PHRASES = [
    'remember when i said', 'as i mentioned', 'going back to', 'earlier i showed',
    'i told you', 'you saw earlier', 'like i said', 'recall that', 'as we covered',
    'what i showed before', 'as i said earlier', 'remember i mentioned',
    'going back to what', 'earlier i mentioned', 'as i showed',
];
const VISUAL_CREDIBILITY_PHRASES = [
    'look at this', 'you can see', 'notice how', 'watch what happens', 'look at the screen',
    'right here you can see', 'this is what it looks like', 'watch closely', 'check this out',
    'see this number', 'look at these', 'as you can see', 'watch this', 'look right here',
    'see what happens',
];
const PAYOFF_SIGNAL_PHRASES = [
    'here is the result', 'heres what happened', 'and the answer is', 'so the answer is',
    'here it is', 'that is the secret', 'turns out the answer', 'so what actually happened',
    'the reveal is', 'and it worked', 'here are the results', 'and this is it',
    'so here is what', 'and this is what', 'the outcome was',
];
const SETUP_SIGNAL_PHRASES = [
    'in this video i will', 'what i am going to show', 'by the end of this video',
    'today i will show', 'i am going to prove', 'let me show you exactly',
    'what you are about to see', 'this is how i', 'i am going to walk you through',
    'today we will cover', 'in this video i am', 'what i will show you',
    'by the end of this', 'i will walk you through', 'today i am going to',
];
const STAKES_ESCALATION_PHRASES = [
    'it gets worse', 'but then', 'and then suddenly', 'everything changed', 'and that is when',
    'out of nowhere', 'which meant', 'and i realized', 'the problem was', 'what i did not know',
    'but here is the thing', 'and then it happened', 'that is when i', 'and suddenly',
    'everything fell apart',
];
const PROOF_ARRIVAL_PHRASES = [
    'look at this', 'you can see', 'right here', 'see this', 'watch this', 'look how',
    'check this', 'the result', 'it worked', 'it actually worked', 'i tested', 'i tried it',
    'here is what happened', 'turns out', 'it turns out', 'and it actually', 'this actually',
];
const NARRATIVE_ANCHOR_PHRASES = [
    'this is the moment', 'this is where', 'at this point', 'right here', 'this is it',
    'this is the part', 'this is when', 'that moment when', 'the moment i', 'right at this point',
    'this is exactly where', 'this is the spot', 'right at this moment', 'this is the exact moment',
    'at this exact point',
];
const DELAYED_REVEAL_PHRASES = [
    'i will tell you in a second', 'keep watching', 'before i tell you', 'but first',
    'hold on', 'just wait', 'in just a moment', 'i will get to that', 'the answer is coming',
    'stay with me', 'bear with me', 'i will explain in a moment', 'before i show you',
    'i will reveal that', 'but before that',
];

const CLIFFHANGER_PHRASES = [
  'but wait', 'but here is the thing', 'but here is where it gets', 'and then',
  'suddenly', 'out of nowhere', 'at that point', 'and that is when',
  'little did i know', 'what i did not expect', 'what i did not realize',
  'what happened next', 'and it only gets', 'but it gets worse', 'but it gets better',
  'what came next', 'you will not believe what', 'here is the twist',
  'and this is where', 'right at that moment',
];

const PAYOFF_TEASE_PHRASES = [
  'spoiler', 'at the end', 'by the end', 'ultimately', 'what ended up happening',
  'what ended up', 'fast forward', 'skip ahead', 'long story short',
  'to cut to the chase', 'to get to the point', 'the bottom line',
  'what you really came for', 'the moment you have been waiting for',
  'the big reveal', 'here it comes', 'drum roll', 'ta da',
  'so the result', 'and the result', 'final result', 'final answer',
];

const STAKES_REINFORCEMENT_PHRASES = [
  'this matters because', 'this is important because', 'why does this matter',
  'the reason this matters', 'this changes everything', 'this is a game changer',
  'this could', 'this would', 'imagine if', 'think about what',
  'what that means is', 'the implication', 'the consequence', 'so what',
  'so why should you care', 'why you should care', 'here is why',
  'that is why', 'and that is why this', 'the stakes',
];

const VIEWER_AGENCY_PHRASES = [
  'you can', 'you could', 'you should', 'you need to', 'you want to',
  'you will want', 'you have to', 'you must', 'do not', 'make sure you',
  'remember to', 'keep in mind', 'take note', 'pay attention to',
  'here is what to do', 'what you should do', 'my advice', 'my recommendation',
  'if i were you', 'trust me on this',
];

const REVELATION_SIGNAL_PHRASES = [
  'turns out', 'it turns out', 'as it turns out', 'what i discovered',
  'what i found', 'what i learned', 'what surprised me', 'the surprising thing',
  'surprisingly', 'unexpectedly', 'against all odds', 'contrary to what',
  'the truth is', 'the reality is', 'what no one tells you', 'nobody told me',
  'the secret is', 'here is the secret', 'here is what works', 'here is what happened',
  'here is why', 'the reason is', 'and the answer is',
];

const CURIOSITY_ESCALATION_PHRASES = [
  'but that is not all', 'and there is more', 'it gets better', 'wait for it',
  'but here is the best part', 'but here is the crazy part', 'here is the kicker',
  'the craziest part', 'the best part', 'the worst part', 'the weird part',
  'the funny thing', 'the ironic thing', 'the interesting thing',
  'i have not even told you', 'i did not mention', 'oh and by the way',
  'and one more thing', 'one last thing', 'oh wait',
];

// ── Group V phrase arrays ──
const EARLY_PROOF_PHRASES = [
    'i tested', 'i tried', 'i did this', 'i spent', 'i have been',
    'the result', 'results were', 'it worked', 'it actually worked', 'it does work',
    'it actually', 'it really does', 'this works', 'and it worked',
    'after doing this', 'after trying', 'my experience', 'what happened was',
    'what actually happened', 'here is what happened',
];

const SOCIAL_SIGNAL_PHRASES = [
    'million', 'thousand', 'hundreds', 'millions of', 'thousands of',
    'viral', 'went viral', 'everyone', 'people are saying', 'everyone knows',
    'subscribers', 'views', 'comments', 'likes', 'my audience',
    'they told me', 'people said', 'the comments',
];

const PRE_UPLOAD_CREDIBILITY_PHRASES = [
    'i am', 'i have', 'i know', 'trust me', 'believe me', 'i promise',
    'i can tell you', 'from experience', 'in my experience', 'speaking from',
    'i have done this', 'i have tried', 'i have tested', 'i know what',
    'let me show you', 'let me tell you', 'i will show you', 'i will tell you',
    'here is the thing', 'here is what', 'the thing is',
];

const ZYGARNIK_FAMILIES = Object.keys(ZYGARNIK_PHRASE_SETS);
const ZYGARNIK_EARLY_WINDOWS = [2, 3, 5, 8, 10, 15, 20];

const ZYGARNIK_SPECIAL_KEYS = [
    'gratification_delay_word_idx', 'gratification_delay_pct',
    'promise_proof_gap_words', 'promise_proof_gap_pct',
    'first_question_position_pct',
    'dangling_question_count', 'dangling_question_ratio',
    'hook_tension_ratio',
    'hook_open_loop_density', 'hook_closure_density', 'hook_unresolved_density',
    'countdown_flag', 'countdown_position_pct',
    'withheld_outcome_flag',
    'setup_duration_s', 'setup_duration_pct', 'hook_plus_setup_duration_pct',
    'payoff_position_pct',
    'object_mention_frame_pct_first3s', 'object_mention_frame_pct_first5s',
    'object_mention_frame_pct_first10s',
    'setup_visual_frame_count', 'anticipatory_frame_pct',
    'open_loop_before_closure_flag',
    'title_open_loop_flag', 'title_curiosity_gap_flag',
    'hook_question_density',
    'identity_hook_density',
    'social_proof_hook_density',
    'scarcity_hook_density',
    'pattern_interrupt_density',
    'hook_specificity_score',
    'hook_number_density',
    'title_number_count',
    'micro_commitment_count',
    'open_loop_before_first_third_flag',
    'tension_peak_position_pct',
    'story_arc_front_load_ratio',
    'hook_identity_flag',
    'stakes_density',
    'stakes_density_hook',
    'loss_aversion_density',
    'credibility_signal_density',
    'reward_language_density',
    'foreshadow_density',
    'urgency_density',
    'open_loop_density_first_quarter',
    'open_loop_density_last_quarter',
    'tension_closure_balance',
    'first_closure_position_pct',
    'reward_density_first_half',
    'foreshadow_density_hook',
    'demonstration_frame_pct',
    'result_reveal_frame_pct',
    'proof_before_midpoint_flag',
    'delayed_gratification_density',
    'delayed_gratification_count',
    'reference_callback_density',
    'reference_callback_count',
    'visual_proof_density',
    'visual_proof_count',
    'story_stake_density',
    'story_stake_count',
    'open_loop_density_mid',
    'closure_density_mid',
    'story_stake_density_first_quarter',
    'visual_proof_density_hook',
    'reference_callback_density_mid',
    'pre_gratification_open_loop_count',
    'stake_introduction_position_pct',
    'proof_density_post_midpoint',
    'callback_before_payoff_flag',
    'delayed_gratification_peak_position_pct',
    // Group K: Transformation & vulnerability arcs (base density only; _hook variants excluded — return null)
    'transformation_density',
    'vulnerability_density',
    'specificity_anchor_density',
    // Group L: Commitment & emotion escalation (base density only; _hook/_quarter variants excluded — return null)
    'micro_commitment_density',
    'emotional_peak_density',
    // Group M: Revelation pace & social contrast (base density only; _mid/_hook variants excluded — return null)
    'revelation_pace_density',
    'social_contrast_density',
    'anticipatory_build_density',
    // Group N: Derived arc-position metrics (EXCLUDED: emotional_peak_position_pct, revelation_pace_score — sparse coverage, always return null)
    'early_stakes_flag',
    'transformation_arc_flag',
    'vulnerability_before_proof_flag',
    'social_contrast_hook_flag',
    // Group X special keys
    'tension_ratchet_hook_count',
    'tension_ratchet_density',
    'promise_echo_density',
    'promise_echo_second_half_count',
    'story_clock_density',
    'story_clock_count_first10s',
    'proof_build_density',
    'proof_build_count_first_half',
    // Group Y: High-resolution zygarnik structural metrics
    'open_loop_density_second_quarter',
    'open_loop_density_third_quarter',
    'loop_resolution_ratio',
    'sustained_tension_word_pct',
    'proof_phrase_mid_density',
    'open_loop_front_third_density',
];

function windowedTranscript(transcript, duration, windowSec) {
    if (!transcript || !duration || duration <= 0) return '';
    const words = transcript.split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const frac = Math.min(windowSec / duration, 1.0);
    const nWords = Math.max(1, Math.ceil(words.length * frac));
    return words.slice(0, nWords).join(' ');
}

function countPhraseMatches(textLower, phrases) {
    let count = 0;
    for (const phrase of phrases) {
        let idx = 0;
        while ((idx = textLower.indexOf(phrase, idx)) !== -1) {
            count++;
            idx += phrase.length;
        }
    }
    return count;
}

const COUNTDOWN_RE = /\b(3\s*[,.]?\s*2\s*[,.]?\s*1|countdown|ready\s+set|here we go|here it goes|in\s+\d+\s*seconds?)\b/i;

const OBJECT_KEYWORDS = [
    'device', 'machine', 'tool', 'material', 'setup', 'apparatus',
    'equipment', 'gadget', 'contraption', 'press', 'hydraulic',
    'saw', 'drill', 'knife', 'hammer', 'blender', 'oven',
];

const INTERACTION_BASES = [
    'retention_pct_50', 'retention_pct_25', 'speech_rate_wps',
    'face_frame_pct', 'retention_entropy', 'hook_drop_rate',
    'non_sub_view_share', 'swipe_away_rate', 'like_rate',
    'unique_word_ratio', 'scene_change_rate', 'hook_duration_pct',
    'title_word_count', 'avg_segment_duration_s', 'close_up_frame_pct',
    'open_loop_count', 'open_loop_density',
    'open_loop_count_first5s', 'open_loop_density_first5s',
    'open_loop_count_first10s',
    'closure_count', 'closure_density',
    'closure_count_first5s', 'closure_density_first5s',
    'closure_count_first10s',
    'unresolved_ref_density', 'unresolved_ref_density_first5s',
    'temporal_anticipation_density', 'temporal_anticipation_count',
    'contrast_count', 'superlative_count',
    'action_verb_density', 'sensory_density',
    'suspense_density', 'imperative_density', 'outcome_ref_density',
    'gratification_delay_pct', 'promise_proof_gap_pct',
    'hook_tension_ratio', 'dangling_question_ratio',
    'withheld_outcome_flag', 'countdown_flag',
    'setup_duration_pct', 'payoff_position_pct',
    'hook_open_loop_density', 'hook_closure_density',
    // New Group A indicators
    'hook_payoff_gap', 'end_recovery_score', 'narrative_arc_completeness',
    'action_frame_pct', 'max_silence_gap_s', 'opening_speech_rate_3s',
    // New Group B indicators
    'open_loop_to_closure_ratio', 'zygarnik_tension_peak_pct', 'early_proof_position_pct',
    'hook_stake_density', 'setup_payoff_ratio', 'resolution_density',
    'closure_rate_per_min', 'tension_arc_score', 'pre_payoff_open_loop_density',
    'visual_stake_frame_pct',
    // New indicator families
    'open_loop_count_first3s',
    'open_loop_count_first15s',
    'closure_count_first10s',
    'suspense_count',
    'suspense_density',
    'contrast_density',
    'identity_hook_density',
    'social_proof_hook_density',
    'pattern_interrupt_density',
    'hook_specificity_score',
    'hook_number_density',
    'open_loop_to_closure_ratio',
    'zygarnik_tension_peak_pct',
    'tension_arc_score',
    'resolution_density',
    'tension_peak_position_pct',
    'story_arc_front_load_ratio',
    // Group H: New temporal tension mechanics
    "stakes_density",
    "stakes_density_hook",
    "loss_aversion_density",
    "credibility_signal_density",
    "reward_language_density",
    "foreshadow_density",
    "urgency_density",
    "open_loop_density_first_quarter",
    "open_loop_density_last_quarter",
    "tension_closure_balance",
    "first_closure_position_pct",
    "reward_density_first_half",
    "foreshadow_density_hook",
    "proof_before_midpoint_flag",
    // Group I: Delayed gratification & reference-callback
    'delayed_gratification_density',
    'reference_callback_density',
    'visual_proof_density',
    'story_stake_density',
    'open_loop_density_mid',
    'closure_density_mid',
    'story_stake_density_first_quarter',
    'visual_proof_density_hook',
    'reference_callback_density_mid',
    'pre_gratification_open_loop_count',
    'stake_introduction_position_pct',
    'proof_density_post_midpoint',
    'callback_before_payoff_flag',
    // Group J: Underused metrics now added as bases
    'title_question_flag',
    'title_number_flag',
    'hook_number_density',
    'identity_hook_density',
    'story_arc_front_load_ratio',
    // Group K bases
    'transformation_density',
    'vulnerability_density',
    'specificity_anchor_density',
    'micro_commitment_density',
    'emotional_peak_density',
    'revelation_pace_density',
    'social_contrast_density',
    'anticipatory_build_density',
    // Group L bases — underused engagement metrics (key names match STATIC_KEYS)
    'comment_rate',
    'share_rate',
    'subs_gained_per_view',
    'retention_pct_10',   // retention_pct_N pattern; no explicit retention_10pct in STATIC_KEYS
    'retention_75pct',    // exists as retention_75pct in STATIC_KEYS
    'retention_90pct',    // exists as retention_90pct in STATIC_KEYS
    // Group M bases — new arc-position scalars
    // NOTE: emotional_peak_position_pct and revelation_pace_score removed from INTERACTION_BASES
    // because phrase-match coverage is too sparse (4-12 of 370 videos) to produce valid cross-metrics.
    // They remain as standalone indicators in ZYGARNIK_SPECIAL_KEYS.
    // Group P bases (full coverage, n=370)
    'visual_proof_phrase_count',
    'visual_proof_phrase_density',
    'zygarnik_score',
    'zygarnik_buildup_ratio',
    'unresolved_loop_count',
    'pre_proof_tension_score',
    'credential_signal_count',
    'credential_signal_density',
    'closure_gap_pct',
    'micro_reward_density',
    'information_drip_ratio',
    // Group W bases (zygarnik-gradient/proof-closure/credibility/story-stake)
    'zygarnik_gradient_pct',
    'zygarnik_front_load_ratio',
    'loop_to_closure_gap_s',
    'ref_to_gratification_gap_pct',
    'pre_payoff_tension_index',
    'early_proof_to_loop_ratio',
    'proof_arrival_delay_proxy',
    'closure_to_open_ratio_first10s',
    'credibility_setup_pct',
    'proof_density_hook',
    'stakes_to_loop_ratio',
    'stake_loop_product',
    // Group R bases (psychographic/persuasion — have extraction logic, new as cross-product bases)
    'rhetorical_question_count', 'rhetorical_question_density',
    'social_comparison_count', 'social_comparison_density',
    'mystery_setup_count', 'mystery_setup_density',
    'promise_specificity_count', 'promise_specificity_density',
    'loss_framing_count', 'loss_framing_density',
    'viewer_stakes_count', 'viewer_stakes_density',
    'transformation_arc_count', 'transformation_arc_density',
    // Group S bases (social proof / curiosity / commitment)
    'social_proof_count', 'social_proof_density',
    'curiosity_gap_count', 'curiosity_gap_density',
    'emotional_peak_count', 'emotional_peak_density',
    'proof_of_work_count', 'proof_of_work_density',
    'failure_vulnerability_count', 'failure_vulnerability_density',
    'future_self_count', 'future_self_density',
    'commitment_device_count', 'commitment_device_density',
    'action_trigger_count', 'action_trigger_density',
    // Group T bases (reference-callback / visual-credibility / payoff / setup / stakes / proof)
    'reference_callback_count', 'reference_callback_density',
    'visual_credibility_count', 'visual_credibility_density',
    'payoff_signal_count', 'payoff_signal_density',
    'setup_signal_count', 'setup_signal_density',
    'stakes_escalation_count', 'stakes_escalation_density',
    'delayed_reveal_count', 'delayed_reveal_density',
    'proof_arrival_count', 'proof_arrival_density',
    'narrative_anchor_count', 'narrative_anchor_density',
    // Group U bases (cliffhanger / payoff-tease / revelation / curiosity-escalation)
    'cliffhanger_count', 'cliffhanger_density',
    'payoff_tease_count', 'payoff_tease_density',
    'revelation_signal_count', 'revelation_signal_density',
    'curiosity_escalation_count', 'curiosity_escalation_density',
    'stakes_reinforcement_count', 'stakes_reinforcement_density',
];
// Excluded from cross-metric generation due to sparse video coverage (<50 videos with scores):
// 'emotional_peak_position_pct', 'revelation_pace_score'

// Static metric definitions — keys that have hardcoded extraction logic
const STATIC_KEYS = new Set([
    'hook_retention_pct', 'final_5pct_retention', 'mid_video_cliff',
    'retention_entropy', 'hook_drop_rate', 'early_momentum',
    'retention_25pct', 'retention_50pct', 'retention_75pct', 'retention_90pct',
    'above_baseline_mean', 'peak_count', 'drop_count', 'max_peak_delta',
    'max_drop_delta', 'retention_variance', 'retention_skew',
    'view_accel_7day', 'week1_week2_ratio', 'non_sub_view_share',
    'swipe_away_rate', 'daily_view_peak_day',
    'like_rate', 'comment_rate', 'share_rate', 'subs_gained_per_view',
    'subs_per_like', 'revenue_per_view',
    'duration_log', 'transcript_word_count', 'speech_rate_wps',
    'hook_word_count', 'question_count', 'segment_count',
    'has_hook_segment', 'hook_duration_s',
    'face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count',
    'keep_x_non_sub_share',
    // Pre-upload: transcript
    'transcript_char_count', 'avg_word_length', 'unique_word_ratio',
    'sentence_count', 'exclamation_count', 'uppercase_word_ratio',
    'hook_question_count', 'hook_word_ratio', 'hook_char_count',
    'transcript_number_count',
    // Pre-upload: structure
    'hook_duration_pct', 'avg_segment_duration_s', 'longest_segment_duration_s',
    'shortest_segment_duration_s', 'hook_position_s', 'climax_position_pct',
    'has_climax_segment', 'hook_to_climax_gap_s',
    // Pre-upload: metadata
    'duration_s', 'title_char_count', 'title_word_count',
    'title_question_flag', 'title_exclamation_flag', 'title_number_flag',
    // Pre-upload: visual
    'scene_change_rate', 'unique_scene_ratio', 'visual_technique_count_mean',
    'close_up_frame_pct', 'hand_presence_frame_pct', 'motion_word_frame_pct',
    // Group U: Cliffhanger / payoff-tease / stakes-reinforcement / viewer-agency / revelation-signal / curiosity-escalation
    'cliffhanger_count', 'cliffhanger_density', 'cliffhanger_first_half_count', 'cliffhanger_hook_count',
    'payoff_tease_count', 'payoff_tease_density', 'payoff_tease_first_half_count', 'payoff_tease_hook_count',
    'stakes_reinforcement_count', 'stakes_reinforcement_density', 'stakes_reinforcement_first_half_count', 'stakes_reinforcement_hook_count',
    'viewer_agency_count', 'viewer_agency_density', 'viewer_agency_first_half_count', 'viewer_agency_hook_count',
    'revelation_signal_count', 'revelation_signal_density', 'revelation_signal_first_half_count', 'revelation_signal_hook_count',
    'curiosity_escalation_count', 'curiosity_escalation_density', 'curiosity_escalation_first_half_count', 'curiosity_escalation_hook_count',
    // Group V: Early proof / social signal / pre-upload credibility
    'early_proof_count', 'early_proof_density', 'early_proof_count_hook', 'early_proof_front_load_ratio', 'early_proof_count_first_half',
    'social_signal_count', 'social_signal_density', 'social_signal_count_hook', 'social_signal_front_load_ratio',
    'pre_upload_credibility_count', 'pre_upload_credibility_density', 'pre_upload_credibility_count_hook', 'pre_upload_credibility_front_load_ratio', 'pre_upload_credibility_position_pct',
]);

// Layer map for static keys
const STATIC_LAYER = {
    // post-upload (need analytics)
    hook_retention_pct: 'post', final_5pct_retention: 'post', mid_video_cliff: 'post',
    retention_entropy: 'post', hook_drop_rate: 'post', early_momentum: 'post',
    retention_25pct: 'post', retention_50pct: 'post', retention_75pct: 'post', retention_90pct: 'post',
    above_baseline_mean: 'post', peak_count: 'post', drop_count: 'post',
    max_peak_delta: 'post', max_drop_delta: 'post', retention_variance: 'post', retention_skew: 'post',
    view_accel_7day: 'post', week1_week2_ratio: 'post',
    non_sub_view_share: 'post', swipe_away_rate: 'post', daily_view_peak_day: 'post',
    like_rate: 'post', comment_rate: 'post', share_rate: 'post',
    subs_gained_per_view: 'post', subs_per_like: 'post', revenue_per_view: 'post',
    keep_x_non_sub_share: 'post',
    // pre-upload
    duration_log: 'pre', transcript_word_count: 'pre', speech_rate_wps: 'pre',
    hook_word_count: 'pre', question_count: 'pre', segment_count: 'pre',
    has_hook_segment: 'pre', hook_duration_s: 'pre',
    face_frame_pct: 'pre', text_overlay_frame_pct: 'pre', scene_change_count: 'pre',
    transcript_char_count: 'pre', avg_word_length: 'pre', unique_word_ratio: 'pre',
    sentence_count: 'pre', exclamation_count: 'pre', uppercase_word_ratio: 'pre',
    hook_question_count: 'pre', hook_word_ratio: 'pre', hook_char_count: 'pre',
    transcript_number_count: 'pre',
    hook_duration_pct: 'pre', avg_segment_duration_s: 'pre',
    longest_segment_duration_s: 'pre', shortest_segment_duration_s: 'pre',
    hook_position_s: 'pre', climax_position_pct: 'pre',
    has_climax_segment: 'pre', hook_to_climax_gap_s: 'pre',
    duration_s: 'pre', title_char_count: 'pre', title_word_count: 'pre',
    title_question_flag: 'pre', title_exclamation_flag: 'pre', title_number_flag: 'pre',
    scene_change_rate: 'pre', unique_scene_ratio: 'pre',
    visual_technique_count_mean: 'pre', close_up_frame_pct: 'pre',
    hand_presence_frame_pct: 'pre', motion_word_frame_pct: 'pre',
};

// ── Programmatic registration of Zygarnik keys ──
for (const fam of ZYGARNIK_FAMILIES) {
    for (const measure of ['count', 'density']) {
        const fullKey = `${fam}_${measure}`;
        STATIC_KEYS.add(fullKey);
        STATIC_LAYER[fullKey] = 'pre';
        for (const w of ZYGARNIK_EARLY_WINDOWS) {
            const wKey = `${fam}_${measure}_first${w}s`;
            STATIC_KEYS.add(wKey);
            STATIC_LAYER[wKey] = 'pre';
        }
    }
}
for (const k of ZYGARNIK_SPECIAL_KEYS) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── New Group A indicators ──
for (const k of ['hook_payoff_gap', 'narrative_arc_completeness', 'action_frame_pct',
    'max_silence_gap_s', 'opening_speech_rate_3s']) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}
STATIC_KEYS.add('end_recovery_score');
STATIC_LAYER['end_recovery_score'] = 'post';

// ── New Group B indicators ──
for (const k of ['open_loop_to_closure_ratio', 'zygarnik_tension_peak_pct', 'early_proof_position_pct',
    'hook_stake_density', 'setup_payoff_ratio', 'resolution_density',
    'closure_rate_per_min', 'tension_arc_score', 'pre_payoff_open_loop_density',
    'visual_stake_frame_pct']) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── New Group P: Zygarnik depth / proof / stake / closure / micro-reward ──
for (const k of [
    'zygarnik_buildup_ratio', 'unresolved_loop_count', 'zygarnik_score',
    'loop_density_acceleration',
    'proof_withheld_duration_pct', 'setup_density_first_third', 'payoff_density_last_third',
    'setup_to_payoff_ratio', 'pre_proof_tension_score',
    'visual_proof_phrase_count', 'visual_proof_phrase_density',
    'credential_signal_count', 'credential_signal_density',
    'consequence_density', 'consequence_density_first_half',
    'personal_stake_density', 'personal_stake_density_first10s',
    'stakes_early_flag', 'consequence_front_load_ratio',
    'first_payoff_position_pct', 'hook_to_payoff_gap_pct',
    'pre_closure_open_loop_count', 'closure_gap_pct',
    'micro_reward_density', 'micro_reward_density_first_quarter',
    'information_drip_ratio', 'early_engagement_density',
    'mid_filler_density', 'closing_hook_density',
    'title_open_loop_count',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}
// Windowed variants for new count/density families
for (const [fam, measures] of [
    ['visual_proof_phrase', ['count', 'density']],
    ['credential_signal', ['count', 'density']],
    ['consequence', ['density']],
    ['personal_stake', ['density']],
    ['micro_reward', ['density']],
]) {
    for (const measure of measures) {
        for (const w of ZYGARNIK_EARLY_WINDOWS) {
            const wk = `${fam}_${measure}_first${w}s`;
            STATIC_KEYS.add(wk);
            STATIC_LAYER[wk] = 'pre';
        }
    }
}
for (const w of ZYGARNIK_EARLY_WINDOWS) {
    STATIC_KEYS.add(`unresolved_loop_count_first${w}s`);
    STATIC_LAYER[`unresolved_loop_count_first${w}s`] = 'pre';
}

// ── New Group Q: Anticipation / Counterintuitive / Confession / Escalation / Specificity / Callback / Urgency ──
for (const k of [
    'anticipation_phrase_count', 'anticipation_phrase_density',
    'anticipation_phrase_count_first10s', 'anticipation_front_load_ratio',
    'counterintuitive_count', 'counterintuitive_density',
    'counterintuitive_count_first_half', 'counterintuitive_count_first10s',
    'confession_signal_count', 'confession_signal_density',
    'confession_first_half_count', 'confession_hook_count',
    'escalation_phrase_count', 'escalation_phrase_density',
    'escalation_count_first_third', 'escalation_count_mid_third',
    'numeric_specificity_count', 'numeric_specificity_density',
    'numeric_specificity_first_half', 'specificity_phrase_count', 'specificity_phrase_density',
    'callback_count', 'callback_density',
    'callback_second_half_count', 'callback_last_third_count',
    'urgency_signal_count', 'urgency_signal_density',
    'urgency_count_first_quarter', 'urgency_count_last_quarter',
    'urgency_front_load_ratio',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── New Group R: Rhetorical questions / social comparison / transformation arc / loss framing / mystery setup / promise specificity / pattern interrupt / viewer stakes ──
for (const k of [
    // Rhetorical questions
    'rhetorical_question_count', 'rhetorical_question_density',
    'rhetorical_question_count_hook', 'rhetorical_question_front_load_ratio',
    // Social comparison
    'social_comparison_count', 'social_comparison_density',
    'social_comparison_count_first_half', 'social_comparison_hook_count',
    // Transformation arc
    'transformation_arc_count', 'transformation_arc_density',
    'transformation_arc_count_first_half', 'transformation_arc_hook_count',
    // Loss framing
    'loss_framing_count', 'loss_framing_density',
    'loss_framing_count_hook', 'loss_framing_count_first_half',
    // Mystery setup
    'mystery_setup_count', 'mystery_setup_density',
    'mystery_setup_count_hook', 'mystery_setup_front_load_ratio',
    // Promise specificity
    'promise_specificity_count', 'promise_specificity_density',
    'promise_specificity_count_hook', 'promise_specificity_front_load_ratio',
    // Pattern interrupt
    'pattern_interrupt_count', 'pattern_interrupt_density',
    'pattern_interrupt_count_hook', 'pattern_interrupt_count_first_half',
    // Viewer stakes language
    'viewer_stakes_count', 'viewer_stakes_density',
    'viewer_stakes_count_hook', 'viewer_stakes_front_load_ratio',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── New Group S: Social proof / curiosity gap / emotional peak / commitment device / proof of work / future self / failure vulnerability / action trigger ──
for (const k of [
    // Social proof
    'social_proof_count', 'social_proof_density',
    'social_proof_count_hook', 'social_proof_front_load_ratio',
    // Curiosity gap
    'curiosity_gap_count', 'curiosity_gap_density',
    'curiosity_gap_count_hook', 'curiosity_gap_front_load_ratio',
    // Emotional peak
    'emotional_peak_count', 'emotional_peak_density',
    'emotional_peak_count_hook', 'emotional_peak_count_first_half',
    // Commitment device
    'commitment_device_count', 'commitment_device_density',
    'commitment_device_count_hook', 'commitment_device_count_first_quarter',
    // Proof of work
    'proof_of_work_count', 'proof_of_work_density',
    'proof_of_work_count_hook', 'proof_of_work_front_load_ratio',
    // Future self
    'future_self_count', 'future_self_density',
    'future_self_count_hook', 'future_self_count_first_half',
    // Failure vulnerability
    'failure_vulnerability_count', 'failure_vulnerability_density',
    'failure_vulnerability_count_hook', 'failure_vulnerability_count_first_half',
    // Action trigger
    'action_trigger_count', 'action_trigger_density',
    'action_trigger_count_hook', 'action_trigger_count_last_quarter',
    // Scalar/derived indicators
    'loop_resolution_ratio',
    'promise_density_first_third',
    'emotional_arc_peak_pct',
    'curiosity_resolution_gap_pct',
    'hook_phrase_diversity',
    'social_proof_before_midpoint_count',
    'proof_of_work_before_claim_ratio',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}
// Windowed variants for Group S families
for (const fam of ['social_proof', 'curiosity_gap', 'emotional_peak', 'proof_of_work', 'failure_vulnerability']) {
    for (const w of ZYGARNIK_EARLY_WINDOWS) {
        for (const variant of ['count', 'density']) {
            STATIC_KEYS.add(`${fam}_${variant}_first${w}s`);
            STATIC_LAYER[`${fam}_${variant}_first${w}s`] = 'pre';
        }
    }
}

// ── New Group T: Reference callback / visual credibility / payoff signal / setup signal / stakes escalation / proof arrival / narrative anchor / delayed reveal ──
for (const k of [
    // Reference callback
    'reference_callback_count', 'reference_callback_density',
    'reference_callback_count_hook', 'reference_callback_front_load_ratio',
    // Visual credibility
    'visual_credibility_count', 'visual_credibility_density',
    'visual_credibility_count_hook', 'visual_credibility_front_load_ratio',
    // Payoff signal
    'payoff_signal_count', 'payoff_signal_density',
    'payoff_signal_count_hook', 'payoff_signal_count_last_quarter',
    // Setup signal
    'setup_signal_count', 'setup_signal_density',
    'setup_signal_count_hook', 'setup_signal_front_load_ratio',
    // Stakes escalation
    'stakes_escalation_count', 'stakes_escalation_density',
    'stakes_escalation_count_mid', 'stakes_escalation_count_first_half',
    // Proof arrival
    'proof_arrival_count', 'proof_arrival_density',
    'proof_arrival_count_hook', 'proof_arrival_position_pct',
    // Narrative anchor
    'narrative_anchor_count', 'narrative_anchor_density',
    'narrative_anchor_count_first_half', 'narrative_anchor_count_last_quarter',
    // Delayed reveal
    'delayed_reveal_count', 'delayed_reveal_density',
    'delayed_reveal_count_hook', 'delayed_reveal_front_load_ratio',
    // Group T scalar/derived
    'setup_to_payoff_signal_gap_pct',
    'proof_arrival_timing_pct',
    'delayed_reveal_to_payoff_ratio',
    'visual_credibility_before_claim_ratio',
    'reference_callback_rate_per_min',
    'stakes_escalation_mid_density',
    'narrative_anchor_peak_pct',
    'delayed_reveal_setup_ratio',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}
// Windowed variants for Group T/V families
for (const fam of ['reference_callback', 'visual_credibility', 'payoff_signal', 'setup_signal', 'stakes_escalation', 'proof_arrival', 'narrative_anchor', 'delayed_reveal', 'early_proof', 'social_signal', 'pre_upload_credibility']) {
    for (const w of ZYGARNIK_EARLY_WINDOWS) {
        for (const variant of ['count', 'density']) {
            STATIC_KEYS.add(`${fam}_${variant}_first${w}s`);
            STATIC_LAYER[`${fam}_${variant}_first${w}s`] = 'pre';
        }
    }
}


// ── New Group W: Zygarnik gradient / ref-to-gratification / proof-closure / credibility / story-stake ──
for (const k of [
    // W1: Zygarnik tension gradient
    'zygarnik_gradient_pct', 'zygarnik_front_load_ratio', 'loop_to_closure_gap_s',
    // W2: Reference-to-gratification timing
    'ref_to_gratification_gap_pct', 'gratification_density_first_quarter', 'pre_payoff_tension_index',
    // W3: Early proof vs closure
    'early_proof_to_loop_ratio', 'proof_arrival_delay_proxy', 'closure_to_open_ratio_first10s',
    // W4: Visual credibility setup-to-payoff
    'credibility_setup_pct', 'proof_density_hook', 'visual_credibility_density_hook',
    // W5: Story-stake proxies
    'stakes_to_loop_ratio', 'stake_loop_product', 'consequence_front_weight',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── get_metric_definition ────────────────────────────────────────────────

function getMetricDefinition(key) {
    // Static keys — simplified definitions (layer is what matters for the runner)
    if (STATIC_KEYS.has(key)) {
        return {
            description: key.replace(/_/g, ' '),
            formula: key,
            expected_range: 'varies',
            data_sources: ['analysis'],
            layer: STATIC_LAYER[key] || 'post',
        };
    }

    let m;

    // retention_pct_N
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) {
        return {
            description: `Retention at ${m[1]}% into the video.`,
            formula: `retentionCurve[${m[1]}].retention`,
            expected_range: '0 to 2.0',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // retention_mean_LO_HI
    m = key.match(/^retention_mean_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Mean retention in the ${m[1]}-${m[2]}% window.`,
            formula: `mean(retentionCurve[${m[1]}:${m[2]}].retention)`,
            expected_range: '0 to 2.0',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // retention_slope_LO_HI
    m = key.match(/^retention_slope_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Linear regression slope of retention in ${m[1]}-${m[2]}% window.`,
            formula: `linregress(retentionCurve[${m[1]}:${m[2]}]).slope`,
            expected_range: '-0.05 to 0.05',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // retention_volatility_LO_HI
    m = key.match(/^retention_volatility_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Std deviation of retention in ${m[1]}-${m[2]}% window.`,
            formula: `std(retentionCurve[${m[1]}:${m[2]}].retention)`,
            expected_range: '0 to 0.5',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
    }

    // views_log_days_D0_D1
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) {
        return {
            description: `Log10 of total views in days ${m[1]}-${m[2]}.`,
            formula: `log10(sum(dailyViews[${m[1]}:${m[2]}].views) + 1)`,
            expected_range: '0 to 8',
            data_sources: ['analytics.dailyViews'],
            layer: 'post',
        };
    }

    // views_ratio_X_vs_Y
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) {
        const ri = DAILY_VIEWS_RATIOS.find(r => r[0] === m[1] && r[1] === m[2]);
        if (ri) {
            return {
                description: `View ratio: days ${ri[2]}-${ri[3]} / days ${ri[4]}-${ri[5]}.`,
                formula: `sum(dailyViews[${ri[2]}:${ri[3]}]) / sum(dailyViews[${ri[4]}:${ri[5]}]) + 1)`,
                expected_range: '0 to 5',
                data_sources: ['analytics.dailyViews'],
                layer: 'post',
            };
        }
    }

    // Interaction terms: keyA_x_keyB
    m = key.match(/^(.+)_x_(.+)$/);
    if (m) {
        const defA = getMetricDefinition(m[1]);
        const defB = getMetricDefinition(m[2]);
        if (defA && defB) {
            const layerA = defA.layer || 'post';
            const layerB = defB.layer || 'post';
            return {
                description: `Interaction: ${m[1]} * ${m[2]}.`,
                formula: `${m[1]} * ${m[2]}`,
                expected_range: 'varies',
                data_sources: [...new Set([...(defA.data_sources || []), ...(defB.data_sources || [])])],
                layer: (layerA === 'pre' && layerB === 'pre') ? 'pre' : 'post',
            };
        }
    }

    return null;
}


// ── extract_metric ───────────────────────────────────────────────────────

function extractMetric(key, analysis) {
    const meta = analysis.metadata || {};
    const analytics = analysis.analytics || {};
    const rawT = analysis.transcript;
    const transcript = (typeof rawT === 'object' && rawT ? (rawT.fullText || '') : (rawT || '')).trim();
    const ai = analysis.aiAnalysis || {};
    const frames = analysis.frames || [];
    const segments = (typeof ai === 'object' ? (ai.segments || []) : []);
    const curve = analytics.retentionCurve || [];
    const daily = analytics.dailyViews || [];

    function curveVal(idx) {
        if (curve.length <= idx) return null;
        return curve[idx].retention;
    }

    function hookSeg() {
        return segments.find(s => (s.label || '').toLowerCase() === 'hook') || null;
    }

    function hookText() {
        const hs = hookSeg();
        if (hs && hs.transcript) return hs.transcript;
        if (transcript) {
            const dur = meta.duration || 1;
            const words = transcript.split(/\s+/).filter(Boolean);
            const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
            return words.slice(0, hookEst).join(' ');
        }
        return '';
    }

    function sceneChangeCount() {
        let changes = 0, prev = '';
        for (const f of frames) {
            const desc = String((f.analysis || {}).sceneDescription || '');
            if (prev && desc.slice(0, 60) !== prev.slice(0, 60)) changes++;
            prev = desc;
        }
        return changes;
    }

    // ── Static keys ──────────────────────────────────────────────────────

    if (key === 'hook_retention_pct') {
        const v = curveVal(10);
        return v != null ? [v, null] : [null, 'no curve'];
    }
    if (key === 'final_5pct_retention') {
        if (curve.length < 5) return [null, 'curve too short'];
        return [mean(curve.slice(-5).map(p => p.retention)), null];
    }
    if (key === 'mid_video_cliff') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let maxDiff = 0;
        for (let i = 1; i < vals.length; i++) maxDiff = Math.max(maxDiff, Math.abs(vals[i] - vals[i - 1]));
        return [maxDiff, null];
    }
    if (key === 'retention_entropy') {
        if (!curve.length) return [null, 'no curve'];
        const vals = curve.map(p => Math.abs(p.retention));
        const total = vals.reduce((a, b) => a + b, 0);
        if (total === 0) return [0, null];
        let h = 0;
        for (const v of vals) {
            if (v > 0) { const p = v / total; h -= p * Math.log2(p); }
        }
        return [h, null];
    }
    if (key === 'hook_drop_rate') {
        if (curve.length < 10) return [null, 'curve too short'];
        const vals = curve.slice(0, 10).map(p => p.retention);
        const x = vals.map((_, i) => i);
        return [linregress(x, vals).slope, null];
    }
    if (key === 'early_momentum') {
        const v25 = curveVal(25), v10 = curveVal(10);
        if (v25 == null || v10 == null) return [null, 'no curve'];
        return [v25 - v10, null];
    }
    if (key === 'retention_25pct') { const v = curveVal(25); return v != null ? [v, null] : [null, 'no curve']; }
    if (key === 'retention_50pct') { const v = curveVal(50); return v != null ? [v, null] : [null, 'no curve']; }
    if (key === 'retention_75pct') { const v = curveVal(75); return v != null ? [v, null] : [null, 'no curve']; }
    if (key === 'retention_90pct') { const v = curveVal(90); return v != null ? [v, null] : [null, 'no curve']; }

    if (key === 'above_baseline_mean') {
        if (!curve.length) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        const n = vals.length;
        const above = vals.map((v, i) => v - (1.0 - i / Math.max(n - 1, 1)));
        return [mean(above), null];
    }
    if (key === 'peak_count') {
        if (curve.length < 3) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        let peaks = 0;
        for (let i = 1; i < vals.length - 1; i++) {
            if (vals[i] > vals[i - 1] && vals[i] > vals[i + 1]) peaks++;
        }
        return [peaks, null];
    }
    if (key === 'drop_count') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let drops = 0;
        for (let i = 1; i < vals.length; i++) {
            if ((vals[i - 1] - vals[i]) > 0.03) drops++;
        }
        return [drops, null];
    }
    if (key === 'max_peak_delta') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let maxInc = 0;
        for (let i = 1; i < vals.length; i++) {
            if (vals[i] > vals[i - 1]) maxInc = Math.max(maxInc, vals[i] - vals[i - 1]);
        }
        return [maxInc, null];
    }
    if (key === 'max_drop_delta') {
        if (curve.length < 2) return [null, 'no curve'];
        const vals = curve.map(p => p.retention);
        let maxDrop = 0;
        for (let i = 1; i < vals.length; i++) {
            if (vals[i] < vals[i - 1]) maxDrop = Math.max(maxDrop, vals[i - 1] - vals[i]);
        }
        return [maxDrop, null];
    }
    if (key === 'retention_variance') {
        if (!curve.length) return [null, 'no curve'];
        return [variance(curve.map(p => p.retention)), null];
    }
    if (key === 'retention_skew') {
        if (curve.length < 3) return [null, 'curve too short'];
        return [skew(curve.map(p => p.retention)), null];
    }

    // Views / engagement
    if (key === 'view_accel_7day') {
        if (!daily.length) return [null, 'no daily views'];
        const w1 = daily.slice(0, 7).reduce((s, d) => s + (d.views || 0), 0);
        return [Math.log10(w1 + 1), null];
    }
    if (key === 'week1_week2_ratio') {
        if (daily.length < 7) return [null, 'insufficient daily views'];
        const w1 = daily.slice(0, 7).reduce((s, d) => s + (d.views || 0), 0);
        const w2 = daily.slice(7, 14).reduce((s, d) => s + (d.views || 0), 0);
        return [w2 / (w1 + 1), null];
    }
    if (key === 'non_sub_view_share') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.nonSubscriberViews || 0) / total, null];
    }
    if (key === 'swipe_away_rate') {
        const v = analytics.swipedAwayRate;
        return v != null ? [v, null] : [null, 'no swipe data'];
    }
    if (key === 'daily_view_peak_day') {
        if (!daily.length) return [null, 'no daily views'];
        let maxV = -1, maxI = 0;
        for (let i = 0; i < daily.length; i++) {
            if ((daily[i].views || 0) > maxV) { maxV = daily[i].views || 0; maxI = i; }
        }
        return [maxI, null];
    }
    if (key === 'like_rate') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.likes || 0) / total * 1000, null];
    }
    if (key === 'comment_rate') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.comments || 0) / total * 1000, null];
    }
    if (key === 'share_rate') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.shares || 0) / total * 1000, null];
    }
    if (key === 'subs_gained_per_view') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.subscribersGained || 0) / total * 1000, null];
    }
    if (key === 'subs_per_like') {
        const likes = analytics.likes || 0;
        const subs = analytics.subscribersGained || 0;
        return [subs / (likes + 1), null];
    }
    if (key === 'revenue_per_view') {
        const total = analytics.totalViews || 0;
        if (!total) return [null, 'no views'];
        return [(analytics.estimatedRevenue || 0) / total * 1000, null];
    }
    if (key === 'duration_log') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        return [Math.log10(dur), null];
    }
    if (key === 'transcript_word_count') {
        if (!transcript) return [null, 'no transcript'];
        return [transcript.split(/\s+/).filter(Boolean).length, null];
    }
    if (key === 'speech_rate_wps') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        return [transcript.split(/\s+/).filter(Boolean).length / dur, null];
    }
    if (key === 'hook_word_count') {
        const hs = hookSeg();
        if (hs && hs.transcript) return [hs.transcript.split(/\s+/).filter(Boolean).length, null];
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 1;
        const words = transcript.split(/\s+/).filter(Boolean);
        const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
        return [words.slice(0, hookEst).length, null];
    }
    if (key === 'question_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/\?/g) || []).length, null];
    }
    if (key === 'segment_count') return [segments.length, null];
    if (key === 'has_hook_segment') return [hookSeg() ? 1 : 0, null];
    if (key === 'hook_duration_s') {
        const hs = hookSeg();
        if (hs) return [(hs.endTime || 0) - (hs.startTime || 0), null];
        return [0, null];
    }
    if (key === 'face_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => String((f.analysis || {}).sceneDescription || '').toLowerCase().includes('face')).length;
        return [ct / frames.length, null];
    }
    if (key === 'text_overlay_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            return String(a.visualTechniques || '').toLowerCase().includes('text overlay') ||
                   String(a.sceneDescription || '').toLowerCase().includes('text overlay');
        }).length;
        return [ct / frames.length, null];
    }
    if (key === 'scene_change_count') {
        if (!frames.length) return [null, 'no frames'];
        return [sceneChangeCount(), null];
    }
    if (key === 'keep_x_non_sub_share') {
        const keep = analytics.avgRetention;
        const total = analytics.totalViews || 0;
        if (keep == null || !total) return [null, 'missing data'];
        return [keep * ((analytics.nonSubscriberViews || 0) / total), null];
    }

    // Pre-upload: transcript/language
    if (key === 'transcript_char_count') {
        if (!transcript) return [null, 'no transcript'];
        return [transcript.length, null];
    }
    if (key === 'avg_word_length') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [mean(words.map(w => w.length)), null];
    }
    if (key === 'unique_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [new Set(words).size / words.length, null];
    }
    if (key === 'sentence_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/[.!?]/g) || []).length, null];
    }
    if (key === 'exclamation_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/!/g) || []).length, null];
    }
    if (key === 'uppercase_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const ct = words.filter(w => w.length >= 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
        return [ct / words.length, null];
    }
    if (key === 'hook_question_count') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        return [(ht.match(/\?/g) || []).length, null];
    }
    if (key === 'hook_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const totalWords = transcript.split(/\s+/).filter(Boolean).length;
        if (!totalWords) return [null, 'empty transcript'];
        const hs = hookSeg();
        let hw;
        if (hs && hs.transcript) {
            hw = hs.transcript.split(/\s+/).filter(Boolean).length;
        } else {
            const dur = meta.duration || 1;
            const words = transcript.split(/\s+/).filter(Boolean);
            const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
            hw = words.slice(0, hookEst).length;
        }
        return [hw / totalWords, null];
    }
    if (key === 'hook_char_count') {
        const hs = hookSeg();
        if (hs && hs.transcript) return [hs.transcript.length, null];
        if (transcript) {
            const dur = meta.duration || 1;
            return [transcript.length / dur * 5, null];
        }
        return [null, 'no hook text'];
    }
    if (key === 'transcript_number_count') {
        if (!transcript) return [null, 'no transcript'];
        return [(transcript.match(/\d+/g) || []).length, null];
    }

    // Pre-upload: structure
    if (key === 'hook_duration_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const hs = hookSeg();
        if (!hs) return [0, null];
        return [((hs.endTime || 0) - (hs.startTime || 0)) / dur * 100, null];
    }
    if (key === 'avg_segment_duration_s') {
        if (!segments.length) return [null, 'no segments'];
        return [mean(segments.map(s => (s.endTime || 0) - (s.startTime || 0))), null];
    }
    if (key === 'longest_segment_duration_s') {
        if (!segments.length) return [null, 'no segments'];
        return [Math.max(...segments.map(s => (s.endTime || 0) - (s.startTime || 0))), null];
    }
    if (key === 'shortest_segment_duration_s') {
        if (!segments.length) return [null, 'no segments'];
        return [Math.min(...segments.map(s => (s.endTime || 0) - (s.startTime || 0))), null];
    }
    if (key === 'hook_position_s') {
        const hs = hookSeg();
        if (!hs) return [null, 'no hook segment'];
        return [hs.startTime || 0, null];
    }
    if (key === 'climax_position_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const cs = segments.find(s => CLIMAX_LABELS.has((s.label || '').toLowerCase()));
        if (!cs) return [null, 'no climax segment'];
        return [(cs.startTime || 0) / dur * 100, null];
    }
    if (key === 'has_climax_segment') {
        return [segments.some(s => CLIMAX_LABELS.has((s.label || '').toLowerCase())) ? 1 : 0, null];
    }
    if (key === 'hook_to_climax_gap_s') {
        const hs = hookSeg();
        const cs = segments.find(s => CLIMAX_LABELS.has((s.label || '').toLowerCase()));
        if (!hs || !cs) return [null, 'missing hook or climax segment'];
        return [Math.max(0, (cs.startTime || 0) - (hs.endTime || 0)), null];
    }

    // Pre-upload: metadata
    if (key === 'duration_s') {
        const dur = meta.duration || 0;
        return dur ? [dur, null] : [null, 'no duration'];
    }
    if (key === 'title_char_count') {
        const title = meta.title || '';
        return title ? [title.length, null] : [null, 'no title'];
    }
    if (key === 'title_word_count') {
        const title = meta.title || '';
        return title ? [title.split(/\s+/).filter(Boolean).length, null] : [null, 'no title'];
    }
    if (key === 'title_question_flag') {
        return [(meta.title || '').includes('?') ? 1 : 0, null];
    }
    if (key === 'title_exclamation_flag') {
        return [(meta.title || '').includes('!') ? 1 : 0, null];
    }
    if (key === 'title_number_flag') {
        return [/\d/.test(meta.title || '') ? 1 : 0, null];
    }

    // Pre-upload: visual
    if (key === 'scene_change_rate') {
        if (!frames.length) return [null, 'no frames'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        return [sceneChangeCount() / dur, null];
    }
    if (key === 'unique_scene_ratio') {
        if (!frames.length) return [null, 'no frames'];
        const descs = frames.map(f => String((f.analysis || {}).sceneDescription || '').slice(0, 60));
        return [new Set(descs).size / descs.length, null];
    }
    if (key === 'visual_technique_count_mean') {
        if (!frames.length) return [null, 'no frames'];
        const counts = frames.map(f => {
            const vt = String((f.analysis || {}).visualTechniques || '');
            return vt.split(/[.;]/).filter(s => s.trim()).length;
        });
        return [mean(counts), null];
    }
    if (key === 'close_up_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            return String(a.sceneDescription || '').toLowerCase().includes('close') ||
                   String(a.visualTechniques || '').toLowerCase().includes('close') ||
                   String(a.cinematography || '').toLowerCase().includes('close');
        }).length;
        return [ct / frames.length, null];
    }
    if (key === 'hand_presence_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => String((f.analysis || {}).sceneDescription || '').toLowerCase().includes('hand')).length;
        return [ct / frames.length, null];
    }
    if (key === 'motion_word_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const ct = frames.filter(f => {
            const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
            for (const kw of MOTION_KEYWORDS) { if (desc.includes(kw)) return true; }
            return false;
        }).length;
        return [ct / frames.length, null];
    }

    // ── Zygarnik / Open-Loop / Gratification Delay families ────────────

    // Phrase family metrics: {family}_{count|density}[_first{N}s]
    const _zyFamRe = new RegExp(`^(${ZYGARNIK_FAMILIES.join('|')})_(count|density)(?:_first(\\d+)s)?$`);
    const zyFamMatch = key.match(_zyFamRe);
    if (zyFamMatch) {
        const [, family, measure, windowStr] = zyFamMatch;
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        const windowSec = windowStr ? parseInt(windowStr) : null;
        const text = windowSec && dur ? windowedTranscript(transcript, dur, windowSec) : transcript;
        if (!text) return [null, 'no text for window'];
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty text'];
        const count = countPhraseMatches(text.toLowerCase(), ZYGARNIK_PHRASE_SETS[family]);
        return measure === 'count' ? [count, null] : [count / words.length, null];
    }

    // Gratification delay: word index of first closure phrase
    if (key === 'gratification_delay_word_idx') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        let minIdx = words.length;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0) {
                const wb = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                if (wb < minIdx) minIdx = wb;
            }
        }
        return [minIdx, null];
    }
    if (key === 'gratification_delay_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        let minIdx = words.length;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0) {
                const wb = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                if (wb < minIdx) minIdx = wb;
            }
        }
        return [minIdx / words.length, null];
    }

    // Promise-proof gap
    if (key === 'promise_proof_gap_words' || key === 'promise_proof_gap_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const totalWords = tl.split(/\s+/).filter(Boolean).length;
        if (!totalWords) return [null, 'empty transcript'];
        let firstOpen = -1, firstClose = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.open_loop) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstOpen < 0 || pos < firstOpen)) firstOpen = pos;
        }
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstClose < 0 || pos < firstClose)) firstClose = pos;
        }
        if (firstOpen < 0) return [0, null];
        const gapWords = firstClose < 0
            ? totalWords
            : tl.slice(firstOpen, Math.max(firstClose, firstOpen)).split(/\s+/).filter(Boolean).length;
        return key.endsWith('_pct') ? [gapWords / totalWords, null] : [gapWords, null];
    }

    if (key === 'first_question_position_pct') {
        if (!transcript) return [null, 'no transcript'];
        const idx = transcript.indexOf('?');
        if (idx < 0) return [1.0, null];
        return [idx / Math.max(transcript.length, 1), null];
    }

    // Dangling questions (not resolved within 30 words)
    if (key === 'dangling_question_count' || key === 'dangling_question_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        let dangling = 0, total = 0;
        for (let i = 0; i < words.length; i++) {
            if (words[i].includes('?')) {
                total++;
                const window30 = words.slice(i + 1, i + 31).join(' ');
                let resolved = false;
                for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
                    if (window30.includes(phrase)) { resolved = true; break; }
                }
                if (!resolved) dangling++;
            }
        }
        if (key === 'dangling_question_count') return [dangling, null];
        return total > 0 ? [dangling / total, null] : [1.0, null];
    }

    // Hook tension metrics
    if (key === 'hook_tension_ratio') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const htl = ht.toLowerCase();
        const oc = countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.open_loop);
        const cc = countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.closure);
        return [oc / (oc + cc + 1), null];
    }
    if (key === 'hook_open_loop_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.open_loop) / w.length, null];
    }
    if (key === 'hook_closure_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.closure) / w.length, null];
    }
    if (key === 'hook_unresolved_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.unresolved_ref) / w.length, null];
    }
    if (key === 'hook_question_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [(ht.match(/\?/g) || []).length / w.length, null];
    }

    // Countdown
    if (key === 'countdown_flag') {
        if (!transcript) return [null, 'no transcript'];
        return [COUNTDOWN_RE.test(transcript) ? 1 : 0, null];
    }
    if (key === 'countdown_position_pct') {
        if (!transcript) return [null, 'no transcript'];
        const cm = COUNTDOWN_RE.exec(transcript);
        if (!cm) return [1.0, null];
        return [cm.index / Math.max(transcript.length, 1), null];
    }

    // Withheld outcome: first 50% has open loops but no closure
    if (key === 'withheld_outcome_flag') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const mid = Math.floor(tl.length / 2);
        const firstHalf = tl.slice(0, mid);
        const hasOpen = ZYGARNIK_PHRASE_SETS.open_loop.some(p => firstHalf.includes(p));
        const hasClose = ZYGARNIK_PHRASE_SETS.closure.some(p => firstHalf.includes(p));
        return [hasOpen && !hasClose ? 1 : 0, null];
    }
    if (key === 'open_loop_before_closure_flag') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        let firstOpen = tl.length, firstClose = tl.length;
        for (const phrase of ZYGARNIK_PHRASE_SETS.open_loop) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && pos < firstOpen) firstOpen = pos;
        }
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && pos < firstClose) firstClose = pos;
        }
        return [firstOpen < firstClose ? 1 : 0, null];
    }

    // Title-level indicators
    if (key === 'title_open_loop_flag') {
        const title = (meta.title || '').toLowerCase();
        if (!title) return [null, 'no title'];
        return [ZYGARNIK_PHRASE_SETS.open_loop.some(p => title.includes(p)) ? 1 : 0, null];
    }
    if (key === 'title_curiosity_gap_flag') {
        const title = (meta.title || '').toLowerCase();
        if (!title) return [null, 'no title'];
        const hasCuriosity = title.includes('?') ||
            ['how', 'why', 'what', 'can', 'will', 'is it', 'could'].some(w => title.includes(w));
        const hasResolution = ZYGARNIK_PHRASE_SETS.closure.some(p => title.includes(p));
        return [hasCuriosity && !hasResolution ? 1 : 0, null];
    }

    // Segment timing
    if (key === 'setup_duration_s') {
        const ss = segments.find(s => (s.label || '').toLowerCase() === 'setup');
        return ss ? [(ss.endTime || 0) - (ss.startTime || 0), null] : [0, null];
    }
    if (key === 'setup_duration_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const ss = segments.find(s => (s.label || '').toLowerCase() === 'setup');
        if (!ss) return [0, null];
        return [((ss.endTime || 0) - (ss.startTime || 0)) / dur * 100, null];
    }
    if (key === 'hook_plus_setup_duration_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        let total = 0;
        for (const s of segments) {
            const lbl = (s.label || '').toLowerCase();
            if (lbl === 'hook' || lbl === 'setup') total += (s.endTime || 0) - (s.startTime || 0);
        }
        return [total / dur * 100, null];
    }
    if (key === 'payoff_position_pct') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const payoffLabels = new Set(['payoff', 'reveal', 'result', 'climax', 'peak', 'conclusion']);
        const ps = segments.find(s => payoffLabels.has((s.label || '').toLowerCase()));
        if (!ps) return [null, 'no payoff segment'];
        return [(ps.startTime || 0) / dur * 100, null];
    }

    // Visual/frame indicators
    {
        const objFrameMatch = key.match(/^object_mention_frame_pct_first(\d+)s$/);
        if (objFrameMatch) {
            if (!frames.length) return [null, 'no frames'];
            const windowSec = parseInt(objFrameMatch[1]);
            const wFrames = frames.filter(f => (f.timestamp || 0) <= windowSec);
            if (!wFrames.length) return [0, null];
            const ct = wFrames.filter(f => {
                const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
                return OBJECT_KEYWORDS.some(kw => desc.includes(kw));
            }).length;
            return [ct / wFrames.length, null];
        }
    }
    if (key === 'setup_visual_frame_count') {
        if (!frames.length) return [null, 'no frames'];
        const sw = ['setup', 'setting up', 'preparing', 'preparation', 'arranging', 'positioning'];
        return [frames.filter(f => {
            const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
            return sw.some(w => desc.includes(w));
        }).length, null];
    }
    if (key === 'anticipatory_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const aw = ['anticipat', 'tension', 'suspense', 'curios', 'intrigu', 'engaging', 'hook'];
        const ct = frames.filter(f => {
            const eng = String((f.analysis || {}).engagementAnalysis || '').toLowerCase();
            const desc = String((f.analysis || {}).sceneDescription || '').toLowerCase();
            return aw.some(w => eng.includes(w) || desc.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    // ── Group A: New indicators ──────────────────────────────────────────

    if (key === 'hook_payoff_gap') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const hs = hookSeg();
        const payoffLabels = new Set(['payoff', 'reveal', 'result', 'climax', 'peak', 'conclusion']);
        const ps = segments.find(s => payoffLabels.has((s.label || '').toLowerCase()));
        if (hs && ps) {
            return [Math.max(0, (ps.startTime || 0) - (hs.endTime || 0)) / dur * 100, null];
        }
        if (transcript && hs) {
            const tl = transcript.toLowerCase();
            let closurePos = -1;
            for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
                const pos = tl.indexOf(phrase);
                if (pos >= 0 && (closurePos < 0 || pos < closurePos)) closurePos = pos;
            }
            if (closurePos >= 0) {
                const closureFrac = closurePos / tl.length;
                const hookEndFrac = (hs.endTime || 0) / dur;
                return [Math.max(0, closureFrac - hookEndFrac) * 100, null];
            }
        }
        return [50, null];
    }

    if (key === 'end_recovery_score') {
        if (curve.length < 10) return [null, 'curve too short'];
        const tail = curve.slice(-10).map(p => p.retention);
        const x = tail.map((_, i) => i);
        return [linregress(x, tail).slope, null];
    }

    if (key === 'narrative_arc_completeness') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const openCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const closureCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        return [Math.min(2.0, closureCount / (openCount + 1)), null];
    }

    if (key === 'action_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const actionWords = ['running', 'jumping', 'hitting', 'throwing', 'cutting', 'breaking',
            'exploding', 'falling', 'fighting', 'spinning', 'moving', 'action',
            'fast', 'quick', 'rush', 'slam', 'crash'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            const desc = String(a.sceneDescription || '').toLowerCase();
            const vt = String(a.visualTechniques || '').toLowerCase();
            return actionWords.some(w => desc.includes(w) || vt.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    if (key === 'max_silence_gap_s') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        if (!transcript) return [dur / 2, null];
        const wordCount = transcript.split(/\s+/).filter(Boolean).length;
        const segCount = Math.max(segments.length, 1);
        const approx = (dur - wordCount / 2.5) / segCount;
        return [Math.min(Math.max(0, approx), dur / 2), null];
    }

    if (key === 'opening_speech_rate_3s') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const text = windowedTranscript(transcript, dur, 3);
        if (!text) return [null, 'no opening text'];
        const wc = text.split(/\s+/).filter(Boolean).length;
        return [wc / 3, null];
    }

    // ── Group B: Zygarnik-effect / delayed gratification indicators ──────

    if (key === 'open_loop_to_closure_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const openCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const closureCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        return [Math.min(10, openCount / (closureCount + 1)), null];
    }

    if (key === 'zygarnik_tension_peak_pct') {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (words.length < 5) return [0, null];
        const windowSize = Math.max(1, Math.floor(words.length * 0.2));
        let maxDensity = 0, peakPos = 0;
        for (let i = 0; i <= words.length - windowSize; i++) {
            const windowText = words.slice(i, i + windowSize).join(' ');
            const count = countPhraseMatches(windowText, ZYGARNIK_PHRASE_SETS.open_loop);
            const density = count / windowSize;
            if (density > maxDensity) {
                maxDensity = density;
                peakPos = (i + windowSize / 2) / words.length * 100;
            }
        }
        return [maxDensity > 0 ? peakPos : 0, null];
    }

    if (key === 'early_proof_position_pct') {
        if (!transcript) return [1.0, null];
        const tl = transcript.toLowerCase();
        const proofPhrases = ['the result', 'it worked', 'look at this', 'here it is', 'turns out',
            'and it', 'so it', 'actually', 'proof', 'evidence', 'before and after',
            'this is what', 'as you can see', 'check this out'];
        let earliest = -1;
        for (const phrase of proofPhrases) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (earliest < 0 || pos < earliest)) earliest = pos;
        }
        if (earliest < 0) return [1.0, null];
        return [earliest / Math.max(tl.length, 1), null];
    }

    if (key === 'hook_stake_density') {
        const ht = hookText();
        if (!ht) return [null, 'no hook text'];
        const htl = ht.toLowerCase();
        const stakePhrases = ['destroy', 'ruin', 'save', 'lose', 'win', 'die', 'break', 'kill',
            'survive', 'never', 'always', 'impossible', 'dangerous', 'deadly',
            'incredible', 'insane', 'crazy', 'unbelievable', 'shocking'];
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, 'empty hook'];
        return [countPhraseMatches(htl, stakePhrases) / w.length, null];
    }

    if (key === 'setup_payoff_ratio') {
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const ss = segments.find(s => (s.label || '').toLowerCase() === 'setup');
        const payoffLabels = new Set(['payoff', 'reveal', 'result', 'climax', 'peak', 'conclusion']);
        const ps = segments.find(s => payoffLabels.has((s.label || '').toLowerCase()));
        const setupDur = ss ? (ss.endTime || 0) - (ss.startTime || 0) : 0;
        if (!ps) return [setupDur ? setupDur / dur : 0, null];
        const payoffDur = (ps.endTime || 0) - (ps.startTime || 0);
        return [setupDur / (payoffDur + 1), null];
    }

    if (key === 'resolution_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const startIdx = Math.floor(words.length * 0.8);
        const lastWords = words.slice(startIdx);
        if (!lastWords.length) return [0, null];
        const count = countPhraseMatches(lastWords.join(' '), ZYGARNIK_PHRASE_SETS.closure);
        return [count / lastWords.length, null];
    }

    if (key === 'closure_rate_per_min') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const count = countPhraseMatches(transcript.toLowerCase(), ZYGARNIK_PHRASE_SETS.closure);
        return [count / (dur / 60), null];
    }

    if (key === 'tension_arc_score') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const firstCount = countPhraseMatches(firstHalf, ZYGARNIK_PHRASE_SETS.open_loop);
        const secondCount = countPhraseMatches(secondHalf, ZYGARNIK_PHRASE_SETS.open_loop);
        const firstDensity = firstCount / Math.max(mid, 1);
        const secondDensity = secondCount / Math.max(words.length - mid, 1);
        return [firstDensity - secondDensity, null];
    }

    if (key === 'pre_payoff_open_loop_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const [payoffPct] = extractMetric('payoff_position_pct', analysis);
        const cutoffFrac = payoffPct != null ? payoffPct / 100 : 0.7;
        const cutoffIdx = Math.floor(words.length * cutoffFrac);
        const preWords = words.slice(0, cutoffIdx);
        if (!preWords.length) return [0, null];
        const count = countPhraseMatches(preWords.join(' '), ZYGARNIK_PHRASE_SETS.open_loop);
        return [count / preWords.length, null];
    }

    if (key === 'visual_stake_frame_pct') {
        if (!frames.length) return [null, 'no frames'];
        const stakeWords = ['danger', 'dramatic', 'intense', 'climax', 'reveal', 'shock',
            'surprise', 'impact', 'extreme', 'before and after', 'transformation'];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            const desc = String(a.sceneDescription || '').toLowerCase();
            const eng = String(a.engagementAnalysis || '').toLowerCase();
            return stakeWords.some(w => desc.includes(w) || eng.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    if (key === "identity_hook_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.identity_hook) / w.length, null];
    }

    if (key === "social_proof_hook_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.social_proof) / w.length, null];
    }

    if (key === "scarcity_hook_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.scarcity) / w.length, null];
    }

    if (key === "pattern_interrupt_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        // Weight early words more (first 25% of video)
        const earlyWords = words.slice(0, Math.ceil(words.length * 0.25)).join(" ");
        return [countPhraseMatches(earlyWords, ZYGARNIK_PHRASE_SETS.pattern_interrupt) / Math.max(earlyWords.split(/\s+/).length, 1), null];
    }

    if (key === "hook_specificity_score") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        // Numbers, percentages, specific time references = high specificity
        const numberMatches = (ht.match(/\b\d+(\.\d+)?(%|\s*percent|\s*times|\s*x|\s*dollars?|\s*seconds?|\s*minutes?|\s*hours?|\s*days?|\s*months?|\s*years?)?\b/gi) || []).length;
        const w = ht.split(/\s+/).filter(Boolean);
        return [numberMatches / Math.max(w.length, 1), null];
    }

    if (key === "hook_number_density") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const numberMatches = (ht.match(/\b\d+\b/g) || []).length;
        const w = ht.split(/\s+/).filter(Boolean);
        return [numberMatches / Math.max(w.length, 1), null];
    }

    if (key === "title_number_count") {
        const title = (meta.title || "").toLowerCase();
        return [(title.match(/\b\d+\b/g) || []).length, null];
    }

    if (key === "micro_commitment_count") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const mcPhrases = [
            "raise your hand", "comment below", "tell me", "let me know",
            "do you agree", "have you tried", "tag someone", "save this",
            "share this", "write yes", "type yes", "tap the", "click the",
            "smash the like", "hit the like",
        ];
        return [countPhraseMatches(tl, mcPhrases), null];
    }

    if (key === "open_loop_before_first_third_flag") {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        const firstThird = words.slice(0, Math.ceil(words.length / 3)).join(" ");
        const hasOpen = countPhraseMatches(firstThird, ZYGARNIK_PHRASE_SETS.open_loop) > 0;
        const hasClose = countPhraseMatches(firstThird, ZYGARNIK_PHRASE_SETS.closure) > 0;
        return [hasOpen && !hasClose ? 1 : 0, null];
    }

    if (key === "tension_peak_position_pct") {
        // Like zygarnik_tension_peak_pct but for suspense language
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (words.length < 5) return [0, null];
        const windowSize = Math.max(1, Math.floor(words.length * 0.15));
        let maxDensity = 0, peakPos = 0;
        for (let i = 0; i <= words.length - windowSize; i++) {
            const windowText = words.slice(i, i + windowSize).join(" ");
            const count = countPhraseMatches(windowText, ZYGARNIK_PHRASE_SETS.suspense);
            const density = count / windowSize;
            if (density > maxDensity) {
                maxDensity = density;
                peakPos = (i + windowSize / 2) / words.length * 100;
            }
        }
        return [maxDensity > 0 ? peakPos : 0, null];
    }

    if (key === "story_arc_front_load_ratio") {
        // How much narrative tension is in first 40% vs last 60%
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        const splitIdx = Math.floor(words.length * 0.4);
        const firstPart = words.slice(0, splitIdx).join(" ");
        const lastPart = words.slice(splitIdx).join(" ");
        const firstTension = countPhraseMatches(firstPart, ZYGARNIK_PHRASE_SETS.open_loop) +
                             countPhraseMatches(firstPart, ZYGARNIK_PHRASE_SETS.suspense);
        const lastTension = countPhraseMatches(lastPart, ZYGARNIK_PHRASE_SETS.open_loop) +
                            countPhraseMatches(lastPart, ZYGARNIK_PHRASE_SETS.suspense);
        return [firstTension / (lastTension + 1), null];
    }

    if (key === "stakes_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.stakes_high) / words.length, null];
    }

    if (key === "stakes_density_hook") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.stakes_high) / w.length, null];
    }

    if (key === "loss_aversion_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.loss_aversion) / words.length, null];
    }

    if (key === "credibility_signal_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.credibility_signal) / words.length, null];
    }

    if (key === "reward_language_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.reward_language) / words.length, null];
    }

    if (key === "foreshadow_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.foreshadow) / words.length, null];
    }

    if (key === "urgency_density") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.urgency) / words.length, null];
    }

    if (key === "open_loop_density_first_quarter") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        const quarter = words.slice(0, Math.ceil(words.length * 0.25));
        if (!quarter.length) return [0, null];
        return [countPhraseMatches(quarter.join(" "), ZYGARNIK_PHRASE_SETS.open_loop) / quarter.length, null];
    }

    if (key === "open_loop_density_last_quarter") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        const quarter = words.slice(Math.floor(words.length * 0.75));
        if (!quarter.length) return [0, null];
        return [countPhraseMatches(quarter.join(" "), ZYGARNIK_PHRASE_SETS.open_loop) / quarter.length, null];
    }

    if (key === "tension_closure_balance") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const openCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const closeCount = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        return [(openCount - closeCount) / (openCount + closeCount + 1), null];
    }

    if (key === "first_closure_position_pct") {
        if (!transcript) return [1.0, null];
        const tl = transcript.toLowerCase();
        let earliest = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (earliest < 0 || pos < earliest)) earliest = pos;
        }
        if (earliest < 0) return [1.0, null];
        return [earliest / Math.max(tl.length, 1), null];
    }

    if (key === "reward_density_first_half") {
        if (!transcript) return [null, "no transcript"];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, "empty transcript"];
        const half = words.slice(0, Math.ceil(words.length * 0.5));
        if (!half.length) return [0, null];
        return [countPhraseMatches(half.join(" "), ZYGARNIK_PHRASE_SETS.reward_language) / half.length, null];
    }

    if (key === "foreshadow_density_hook") {
        const ht = hookText();
        if (!ht) return [null, "no hook text"];
        const htl = ht.toLowerCase();
        const w = ht.split(/\s+/).filter(Boolean);
        if (!w.length) return [null, "empty hook"];
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.foreshadow) / w.length, null];
    }

    if (key === "demonstration_frame_pct") {
        if (!frames.length) return [null, "no frames"];
        const demoWords = ["demo", "demonstrat", "showing", "watch how", "step by step",
            "applying", "adding", "cutting", "building", "assembling", "testing",
            "working on", "in progress", "hands on", "hands working"];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            const desc = String(a.sceneDescription || "").toLowerCase();
            return demoWords.some(w => desc.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    if (key === "result_reveal_frame_pct") {
        if (!frames.length) return [null, "no frames"];
        const resultWords = ["result", "final", "finished", "complete", "done", "outcome",
            "before and after", "transformation", "reveal", "the end result",
            "achieved", "success", "worked"];
        const ct = frames.filter(f => {
            const a = f.analysis || {};
            const desc = String(a.sceneDescription || "").toLowerCase();
            const eng = String(a.engagementAnalysis || "").toLowerCase();
            return resultWords.some(w => desc.includes(w) || eng.includes(w));
        }).length;
        return [ct / frames.length, null];
    }

    if (key === "proof_before_midpoint_flag") {
        const [proofPos] = extractMetric("early_proof_position_pct", analysis);
        return [proofPos != null && proofPos < 0.5 ? 1 : 0, null];
    }

    if (key === 'open_loop_density_mid') {
        const mid = segments.filter((_, i) => i >= segments.length * 0.33 && i < segments.length * 0.67);
        const text = mid.map(s => s.transcript || '').join(' ').toLowerCase();
        return text.split(/\s+/).length < 3 ? [null, 'insufficient text'] : [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.open_loop) / Math.max(1, text.split(/\s+/).length) * 100, null];
    }

    if (key === 'closure_density_mid') {
        const mid = segments.filter((_, i) => i >= segments.length * 0.33 && i < segments.length * 0.67);
        const text = mid.map(s => s.transcript || '').join(' ').toLowerCase();
        return text.split(/\s+/).length < 3 ? [null, 'insufficient text'] : [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.closure) / Math.max(1, text.split(/\s+/).length) * 100, null];
    }

    if (key === 'story_stake_density_first_quarter') {
        const q1 = segments.filter((_, i) => i < segments.length * 0.25);
        const text = q1.map(s => s.transcript || '').join(' ').toLowerCase();
        return text.split(/\s+/).length < 3 ? [null, 'insufficient text'] : [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.story_stake) / Math.max(1, text.split(/\s+/).length) * 100, null];
    }

    if (key === 'visual_proof_density_hook') {
        const dur = meta.duration || 60;
        const hook = segments.filter(s => (s.startTime || 0) < dur * 0.1);
        const text = hook.map(s => s.transcript || '').join(' ').toLowerCase();
        return text.split(/\s+/).length < 3 ? [null, 'insufficient text'] : [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.visual_proof) / Math.max(1, text.split(/\s+/).length) * 100, null];
    }

    if (key === 'reference_callback_density_mid') {
        const mid = segments.filter((_, i) => i >= segments.length * 0.33 && i < segments.length * 0.67);
        const text = mid.map(s => s.transcript || '').join(' ').toLowerCase();
        return text.split(/\s+/).length < 3 ? [null, 'insufficient text'] : [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.reference_callback) / Math.max(1, text.split(/\s+/).length) * 100, null];
    }

    if (key === 'pre_gratification_open_loop_count') {
        let firstGratIdx = segments.length;
        for (let i = 0; i < segments.length; i++) {
            const t = (segments[i].transcript || '').toLowerCase();
            if (countPhraseMatches(t, ZYGARNIK_PHRASE_SETS.delayed_gratification) > 0) { firstGratIdx = i; break; }
        }
        const pre = segments.slice(0, firstGratIdx);
        const text = pre.map(s => s.transcript || '').join(' ').toLowerCase();
        return [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.open_loop), null];
    }

    if (key === 'stake_introduction_position_pct') {
        for (let i = 0; i < segments.length; i++) {
            const t = (segments[i].transcript || '').toLowerCase();
            if (countPhraseMatches(t, ZYGARNIK_PHRASE_SETS.story_stake) > 0) {
                return [Math.round((i / Math.max(1, segments.length)) * 100), null];
            }
        }
        return [100, null];
    }

    if (key === 'proof_density_post_midpoint') {
        const post = segments.filter((_, i) => i >= segments.length * 0.5);
        const text = post.map(s => s.transcript || '').join(' ').toLowerCase();
        return text.split(/\s+/).length < 3 ? [null, 'insufficient text'] : [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.visual_proof) / Math.max(1, text.split(/\s+/).length) * 100, null];
    }

    if (key === 'callback_before_payoff_flag') {
        const midPoint = Math.floor(segments.length * 0.5);
        const preMid = segments.slice(0, midPoint);
        const text = preMid.map(s => s.transcript || '').join(' ').toLowerCase();
        return [countPhraseMatches(text, ZYGARNIK_PHRASE_SETS.reference_callback) > 0 ? 1 : 0, null];
    }

    if (key === 'delayed_gratification_peak_position_pct') {
        if (!segments.length) return [null, 'no segments'];
        let peakDen = -1, peakPos = 50;
        segments.forEach((seg, idx) => {
            const t = seg.transcript || '';
            const den = countPhraseMatches(t.toLowerCase(), ZYGARNIK_PHRASE_SETS.delayed_gratification) / Math.max(1, t.split(/\s+/).length);
            if (den > peakDen) { peakDen = den; peakPos = Math.round((idx / segments.length) * 100); }
        });
        return [peakPos, null];
    }

    if (key === "hook_identity_flag") {
        const ht = hookText();
        if (!ht) return [0, null];
        return [countPhraseMatches(ht.toLowerCase(), ZYGARNIK_PHRASE_SETS.identity_hook) > 0 ? 1 : 0, null];
    }

    // ── Group N: Arc-position derived metrics ────────────────────────────

    if (key === 'early_stakes_flag') {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const first15 = words.slice(0, Math.ceil(words.length * 0.15)).join(' ');
        const hasStake = ZYGARNIK_PHRASE_SETS.stakes_high.some(p => first15.includes(p)) ||
                         ZYGARNIK_PHRASE_SETS.story_stake.some(p => first15.includes(p));
        return [hasStake ? 1 : 0, null];
    }

    if (key === 'emotional_peak_position_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        let firstMatchWordIdx = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.emotional_peak) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0) {
                const wordIdx = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                if (firstMatchWordIdx < 0 || wordIdx < firstMatchWordIdx) firstMatchWordIdx = wordIdx;
            }
        }
        if (firstMatchWordIdx < 0) return [null, null];
        return [firstMatchWordIdx / words.length * 100, null];
    }

    if (key === 'transformation_arc_flag') {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const hasTransformation = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.transformation) > 0;
        if (!hasTransformation) return [0, null];
        const [proofBefore] = extractMetric('proof_before_midpoint_flag', analysis);
        return [proofBefore === 1 ? 1 : 0, null];
    }

    if (key === 'vulnerability_before_proof_flag') {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        let firstVuln = -1, firstCred = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.vulnerability) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstVuln < 0 || pos < firstVuln)) firstVuln = pos;
        }
        for (const phrase of ZYGARNIK_PHRASE_SETS.credibility_signal) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstCred < 0 || pos < firstCred)) firstCred = pos;
        }
        if (firstVuln < 0 || firstCred < 0) return [0, null];
        return [firstVuln < firstCred ? 1 : 0, null];
    }

    if (key === 'revelation_pace_score') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const firstCount = countPhraseMatches(firstHalf, ZYGARNIK_PHRASE_SETS.revelation_pace);
        if (firstCount === 0) return [null, null];
        const secondCount = countPhraseMatches(secondHalf, ZYGARNIK_PHRASE_SETS.revelation_pace);
        return [secondCount / firstCount, null];
    }

    if (key === 'social_contrast_hook_flag') {
        if (!transcript) return [0, null];
        const dur = meta.duration || 0;
        const hookWin = windowedTranscript(transcript, dur || transcript.length, 10);
        if (!hookWin) return [0, null];
        const hasContrast = ZYGARNIK_PHRASE_SETS.social_contrast.some(p => hookWin.toLowerCase().includes(p));
        return [hasContrast ? 1 : 0, null];
    }

    // ── Group P: Zygarnik depth / proof / stake / closure / micro-reward ──

    // Family 1: Zygarnik depth metrics
    if (key === 'zygarnik_buildup_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const firstDensity = countPhraseMatches(firstHalf, ZYGARNIK_PHRASE_SETS.open_loop) / Math.max(mid, 1);
        const secondDensity = countPhraseMatches(secondHalf, ZYGARNIK_PHRASE_SETS.open_loop) / Math.max(words.length - mid, 1);
        return [firstDensity / (secondDensity + 0.0001), null];
    }

    if (key === 'unresolved_loop_count') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalfText = words.slice(0, Math.floor(words.length / 2)).join(' ');
        const openCount = countPhraseMatches(firstHalfText, ZYGARNIK_PHRASE_SETS.open_loop);
        const closureCount = countPhraseMatches(firstHalfText, ZYGARNIK_PHRASE_SETS.closure);
        return [Math.max(0, openCount - closureCount), null];
    }

    if (key === 'zygarnik_score') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const wText = windowedTranscript(transcript, dur, 10);
        const openCount = wText ? countPhraseMatches(wText.toLowerCase(), ZYGARNIK_PHRASE_SETS.open_loop) : 0;
        const [gratPct] = extractMetric('gratification_delay_pct', analysis);
        if (gratPct == null) return [null, 'no gratification_delay_pct'];
        return [Math.min(10, openCount * (1 - Math.min(1, gratPct / 100))), null];
    }

    if (key === 'loop_density_acceleration') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const q1End = Math.floor(words.length * 0.25);
        const q2End = Math.floor(words.length * 0.50);
        const quarter1 = words.slice(0, q1End).join(' ');
        const quarter2 = words.slice(q1End, q2End).join(' ');
        const d1 = countPhraseMatches(quarter1, ZYGARNIK_PHRASE_SETS.open_loop) / Math.max(q1End, 1);
        const d2 = countPhraseMatches(quarter2, ZYGARNIK_PHRASE_SETS.open_loop) / Math.max(q2End - q1End, 1);
        return [d1 - d2, null];
    }

    // Family 2: Delayed gratification / pre-proof tension
    if (key === 'proof_withheld_duration_pct') {
        if (!transcript) return [1.0, null];
        const tl = transcript.toLowerCase();
        let earliest = -1;
        for (const phrase of NEW_PROOF_PHRASES) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (earliest < 0 || pos < earliest)) earliest = pos;
        }
        if (earliest < 0) return [1.0, null];
        return [earliest / Math.max(tl.length, 1), null];
    }

    if (key === 'setup_density_first_third') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const third = words.slice(0, Math.ceil(words.length / 3));
        if (!third.length) return [0, null];
        return [countPhraseMatches(third.join(' '), NEW_SETUP_PHRASES) / third.length, null];
    }

    if (key === 'payoff_density_last_third') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const startIdx = Math.floor(words.length * 2 / 3);
        const lastThird = words.slice(startIdx);
        if (!lastThird.length) return [0, null];
        return [countPhraseMatches(lastThird.join(' '), NEW_PAYOFF_PHRASES) / lastThird.length, null];
    }

    if (key === 'setup_to_payoff_ratio') {
        const [setupD] = extractMetric('setup_density_first_third', analysis);
        const [payoffD] = extractMetric('payoff_density_last_third', analysis);
        if (setupD == null) return [null, 'no setup_density_first_third'];
        if (payoffD == null) return [null, 'no payoff_density_last_third'];
        return [setupD / (payoffD + 0.001), null];
    }

    if (key === 'pre_proof_tension_score') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const openLoopDensity = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop) / words.length;
        const [proofWithheld] = extractMetric('proof_withheld_duration_pct', analysis);
        if (proofWithheld == null) return [null, 'no proof_withheld_duration_pct'];
        return [Math.min(10, openLoopDensity * proofWithheld * 10), null];
    }

    // Family 3: Visual credibility / proof markers
    if (key === 'visual_proof_phrase_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), NEW_VISUAL_PROOF_PHRASES), null];
    }

    if (key === 'visual_proof_phrase_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(tl, NEW_VISUAL_PROOF_PHRASES) / words.length, null];
    }

    if (key === 'credential_signal_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), NEW_CREDENTIAL_PHRASES), null];
    }

    if (key === 'credential_signal_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(tl, NEW_CREDENTIAL_PHRASES) / words.length, null];
    }

    // Family 4: Story stake / consequence proxies
    if (key === 'consequence_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(tl, NEW_CONSEQUENCE_PHRASES) / words.length, null];
    }

    if (key === 'consequence_density_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = words.slice(0, Math.ceil(words.length / 2));
        if (!half.length) return [0, null];
        return [countPhraseMatches(half.join(' '), NEW_CONSEQUENCE_PHRASES) / half.length, null];
    }

    if (key === 'personal_stake_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(tl, NEW_PERSONAL_STAKE_PHRASES) / words.length, null];
    }

    if (key === 'personal_stake_density_first10s') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration || 0;
        if (!dur) return [null, 'no duration'];
        const wText = windowedTranscript(transcript, dur, 10);
        if (!wText) return [null, 'no text for window'];
        const words = wText.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        return [countPhraseMatches(wText.toLowerCase(), NEW_PERSONAL_STAKE_PHRASES) / words.length, null];
    }

    if (key === 'stakes_early_flag') {
        if (!transcript) return [0, null];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const first15 = words.slice(0, Math.ceil(words.length * 0.15)).join(' ');
        return [countPhraseMatches(first15, NEW_PERSONAL_STAKE_PHRASES) > 0 ? 1 : 0, null];
    }

    if (key === 'consequence_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const d1 = countPhraseMatches(firstHalf, NEW_CONSEQUENCE_PHRASES) / Math.max(mid, 1);
        const d2 = countPhraseMatches(secondHalf, NEW_CONSEQUENCE_PHRASES) / Math.max(words.length - mid, 1);
        return [d1 / (d2 + 0.0001), null];
    }

    // Family 5: Setup-payoff gap / closure gap (transcript-based)
    if (key === 'first_payoff_position_pct') {
        if (!transcript) return [1.0, null];
        const tl = transcript.toLowerCase();
        const payoffPhrases = [
            'the answer is', 'turns out', 'it worked', 'here is why', 'the result',
            'you can see', 'as you can see', 'the truth', 'what actually', 'what really',
            'in reality', 'actually it', 'the real reason', 'i discovered',
        ];
        let earliest = -1;
        for (const phrase of payoffPhrases) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (earliest < 0 || pos < earliest)) earliest = pos;
        }
        if (earliest < 0) return [1.0, null];
        return [earliest / Math.max(tl.length, 1), null];
    }

    if (key === 'hook_to_payoff_gap_pct') {
        const [firstPayoffPct] = extractMetric('first_payoff_position_pct', analysis);
        const [hookDurPct] = extractMetric('hook_duration_pct', analysis);
        const hookFrac = hookDurPct != null ? hookDurPct / 100 : 0.1;
        const payoffPos = firstPayoffPct != null ? firstPayoffPct : 1.0;
        return [payoffPos - hookFrac, null];
    }

    if (key === 'pre_closure_open_loop_count') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        let firstClosure = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (firstClosure < 0 || pos < firstClosure)) firstClosure = pos;
        }
        const preText = firstClosure >= 0 ? tl.slice(0, firstClosure) : tl;
        return [countPhraseMatches(preText, ZYGARNIK_PHRASE_SETS.open_loop), null];
    }

    if (key === 'closure_gap_pct') {
        if (!transcript) return [1.0, null];
        const tl = transcript.toLowerCase();
        let earliest = -1;
        for (const phrase of ZYGARNIK_PHRASE_SETS.closure) {
            const pos = tl.indexOf(phrase);
            if (pos >= 0 && (earliest < 0 || pos < earliest)) earliest = pos;
        }
        if (earliest < 0) return [1.0, null];
        return [earliest / Math.max(tl.length, 1), null];
    }

    // Family 6: Micro-reward / information drip
    if (key === 'micro_reward_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(tl, NEW_MICRO_REWARD_PHRASES) / words.length, null];
    }

    if (key === 'micro_reward_density_first_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const quarter = words.slice(0, Math.ceil(words.length * 0.25));
        if (!quarter.length) return [0, null];
        return [countPhraseMatches(quarter.join(' '), NEW_MICRO_REWARD_PHRASES) / quarter.length, null];
    }

    if (key === 'information_drip_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const thirdLen = Math.max(1, Math.floor(words.length / 3));
        const firstThird = words.slice(0, thirdLen).join(' ');
        const lastThird = words.slice(words.length - thirdLen).join(' ');
        const d1 = countPhraseMatches(firstThird, NEW_MICRO_REWARD_PHRASES) / thirdLen;
        const d2 = countPhraseMatches(lastThird, NEW_MICRO_REWARD_PHRASES) / thirdLen;
        return [d1 / (d2 + 0.0001), null];
    }

    if (key === 'early_engagement_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const quarter = words.slice(0, Math.ceil(words.length * 0.25));
        if (!quarter.length) return [0, null];
        return [countPhraseMatches(quarter.join(' '), NEW_EARLY_ENGAGEMENT_PHRASES) / quarter.length, null];
    }

    if (key === 'mid_filler_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const midStart = Math.floor(words.length * 0.25);
        const midEnd = Math.ceil(words.length * 0.75);
        const midWords = words.slice(midStart, midEnd);
        if (!midWords.length) return [0, null];
        return [countPhraseMatches(midWords.join(' '), NEW_MID_FILLER_PHRASES) / midWords.length, null];
    }

    if (key === 'closing_hook_density') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const closingWords = words.slice(Math.floor(words.length * 0.80));
        if (!closingWords.length) return [0, null];
        return [countPhraseMatches(closingWords.join(' '), NEW_CLOSING_HOOK_PHRASES) / closingWords.length, null];
    }

    // Family 7: Title curiosity gap
    if (key === 'title_open_loop_count') {
        const title = (meta.title || '').toLowerCase();
        if (!title) return [null, 'no title'];
        const titleLoopPhrases = [
            'why', 'how', 'what', 'when', 'this is why', 'the reason',
            "you won't believe", 'nobody tells', 'secret', 'mistake',
            'truth about', 'real reason', 'actually', 'surprising',
        ];
        return [countPhraseMatches(title, titleLoopPhrases), null];
    }

    // Windowed variants for new count/density families
    {
        const _nfRe = /^(visual_proof_phrase_(?:count|density)|credential_signal_(?:count|density)|consequence_density|personal_stake_density|micro_reward_density|unresolved_loop_count)_first(\d+)s$/;
        const _nfm = key.match(_nfRe);
        if (_nfm) {
            if (!transcript) return [null, 'no transcript'];
            const dur = meta.duration || 0;
            if (!dur) return [null, 'no duration'];
            const wSec = parseInt(_nfm[2]);
            const wText = windowedTranscript(transcript, dur, wSec);
            if (!wText) return [null, 'no text for window'];
            const wl = wText.toLowerCase();
            const wWords = wl.split(/\s+/).filter(Boolean);
            if (!wWords.length) return [0, null];
            const baseKey = _nfm[1];
            if (baseKey === 'unresolved_loop_count') {
                const openCt = countPhraseMatches(wl, ZYGARNIK_PHRASE_SETS.open_loop);
                const closeCt = countPhraseMatches(wl, ZYGARNIK_PHRASE_SETS.closure);
                return [Math.max(0, openCt - closeCt), null];
            }
            const phraseMap = {
                'visual_proof_phrase_count': NEW_VISUAL_PROOF_PHRASES,
                'visual_proof_phrase_density': NEW_VISUAL_PROOF_PHRASES,
                'credential_signal_count': NEW_CREDENTIAL_PHRASES,
                'credential_signal_density': NEW_CREDENTIAL_PHRASES,
                'consequence_density': NEW_CONSEQUENCE_PHRASES,
                'personal_stake_density': NEW_PERSONAL_STAKE_PHRASES,
                'micro_reward_density': NEW_MICRO_REWARD_PHRASES,
            };
            const phrases = phraseMap[baseKey];
            if (!phrases) return [null, `unknown windowed family: ${baseKey}`];
            const count = countPhraseMatches(wl, phrases);
            return baseKey.endsWith('_density') ? [count / wWords.length, null] : [count, null];
        }
    }

    // ── Pattern-based keys ───────────────────────────────────────────────

    let m;

    // retention_pct_N
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) {
        const v = curveVal(parseInt(m[1]));
        return v != null ? [v, null] : [null, 'no curve'];
    }

    // retention_mean_LO_HI
    m = key.match(/^retention_mean_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (curve.length < hi) return [null, 'curve too short'];
        const vals = curve.slice(lo, hi).map(p => p.retention);
        if (!vals.length) return [null, 'empty window'];
        return [mean(vals), null];
    }

    // retention_slope_LO_HI
    m = key.match(/^retention_slope_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (curve.length < hi) return [null, 'curve too short'];
        const vals = curve.slice(lo, hi).map(p => p.retention);
        if (vals.length < 2) return [null, 'window too small'];
        const x = vals.map((_, i) => i);
        return [linregress(x, vals).slope, null];
    }

    // retention_volatility_LO_HI
    m = key.match(/^retention_volatility_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (curve.length < hi) return [null, 'curve too short'];
        const vals = curve.slice(lo, hi).map(p => p.retention);
        if (vals.length < 2) return [null, 'window too small'];
        return [std(vals), null];
    }

    // views_log_days_D0_D1
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) {
        const d0 = parseInt(m[1]), d1 = parseInt(m[2]);
        if (!daily.length) return [null, 'no daily views'];
        const totalV = daily.slice(d0, d1).reduce((s, d) => s + (d.views || 0), 0);
        return [Math.log10(totalV + 1), null];
    }

    // views_ratio_X_vs_Y
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) {
        const ri = DAILY_VIEWS_RATIOS.find(r => r[0] === m[1] && r[1] === m[2]);
        if (ri && daily.length) {
            const num = daily.slice(ri[2], ri[3]).reduce((s, d) => s + (d.views || 0), 0);
            const den = daily.slice(ri[4], ri[5]).reduce((s, d) => s + (d.views || 0), 0);
            return [num / (den + 1), null];
        }
        return [null, 'no daily views or unknown ratio'];
    }

    // Interaction: keyA_x_keyB
    m = key.match(/^(.+)_x_(.+)$/);
    if (m) {
        const aKey = m[1], bKey = m[2];
        if (getMetricDefinition(aKey) && getMetricDefinition(bKey)) {
            const [va, skipA] = extractMetric(aKey, analysis);
            const [vb, skipB] = extractMetric(bKey, analysis);
            if (va != null && vb != null) return [va * vb, null];
            return [null, skipA || skipB || 'missing component'];
        }
    }

    // ── Group Q: Anticipation language ──────────────────────────────────────

    if (key === 'anticipation_phrase_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), ANTICIPATION_PHRASES), null];
    }
    if (key === 'anticipation_phrase_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), ANTICIPATION_PHRASES) / words.length, null];
    }
    if (key === 'anticipation_phrase_count_first10s') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ');
        return [countPhraseMatches(first10.toLowerCase(), ANTICIPATION_PHRASES), null];
    }
    if (key === 'anticipation_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ').toLowerCase();
        const secondHalf = words.slice(mid).join(' ').toLowerCase();
        const c1 = countPhraseMatches(firstHalf, ANTICIPATION_PHRASES);
        const c2 = countPhraseMatches(secondHalf, ANTICIPATION_PHRASES);
        return [c1 / (c2 + 0.001), null];
    }

    // ── Group Q: Counterintuitive/reveal signals ─────────────────────────

    if (key === 'counterintuitive_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), COUNTERINTUITIVE_PHRASES), null];
    }
    if (key === 'counterintuitive_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), COUNTERINTUITIVE_PHRASES) / words.length, null];
    }
    if (key === 'counterintuitive_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, COUNTERINTUITIVE_PHRASES), null];
    }
    if (key === 'counterintuitive_count_first10s') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, COUNTERINTUITIVE_PHRASES), null];
    }

    // ── Group Q: Confession/vulnerability signals ────────────────────────

    if (key === 'confession_signal_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CONFESSION_PHRASES), null];
    }
    if (key === 'confession_signal_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CONFESSION_PHRASES) / words.length, null];
    }
    if (key === 'confession_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, CONFESSION_PHRASES), null];
    }
    if (key === 'confession_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, CONFESSION_PHRASES), null];
    }

    // ── Group Q: Escalation language ─────────────────────────────────────

    if (key === 'escalation_phrase_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), ESCALATION_PHRASES), null];
    }
    if (key === 'escalation_phrase_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), ESCALATION_PHRASES) / words.length, null];
    }
    if (key === 'escalation_count_first_third') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstThird = words.slice(0, Math.ceil(words.length / 3)).join(' ').toLowerCase();
        return [countPhraseMatches(firstThird, ESCALATION_PHRASES), null];
    }
    if (key === 'escalation_count_mid_third') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const start = Math.floor(words.length / 3);
        const end = Math.ceil(words.length * 2 / 3);
        const midThird = words.slice(start, end).join(' ').toLowerCase();
        return [countPhraseMatches(midThird, ESCALATION_PHRASES), null];
    }

    // ── Group Q: Specificity markers ─────────────────────────────────────

    if (key === 'numeric_specificity_count') {
        if (!transcript) return [null, 'no transcript'];
        const matches = transcript.match(/\b\d+(?:\.\d+)?(?:%|x|k|m|b|s|sec|min|hour|day|week|month|year)?\b/gi);
        return [matches ? matches.length : 0, null];
    }
    if (key === 'numeric_specificity_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const matches = transcript.match(/\b\d+(?:\.\d+)?(?:%|x|k|m|b|s|sec|min|hour|day|week|month|year)?\b/gi);
        return [(matches ? matches.length : 0) / words.length, null];
    }
    if (key === 'numeric_specificity_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ');
        const matches = firstHalf.match(/\b\d+(?:\.\d+)?(?:%|x|k|m|b|s|sec|min|hour|day|week|month|year)?\b/gi);
        return [matches ? matches.length : 0, null];
    }
    if (key === 'specificity_phrase_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), SPECIFICITY_PHRASES), null];
    }
    if (key === 'specificity_phrase_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), SPECIFICITY_PHRASES) / words.length, null];
    }

    // ── Group Q: Narrative callback signals ──────────────────────────────

    if (key === 'callback_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CALLBACK_PHRASES), null];
    }
    if (key === 'callback_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CALLBACK_PHRASES) / words.length, null];
    }
    if (key === 'callback_second_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const secondHalf = words.slice(Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(secondHalf, CALLBACK_PHRASES), null];
    }
    if (key === 'callback_last_third_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const lastThird = words.slice(Math.floor(words.length * 2 / 3)).join(' ').toLowerCase();
        return [countPhraseMatches(lastThird, CALLBACK_PHRASES), null];
    }

    // ── Group Q: Urgency/FOMO signals ────────────────────────────────────

    if (key === 'urgency_signal_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), URGENCY_PHRASES), null];
    }
    if (key === 'urgency_signal_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), URGENCY_PHRASES) / words.length, null];
    }
    if (key === 'urgency_count_first_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstQuarter = words.slice(0, Math.ceil(words.length * 0.25)).join(' ').toLowerCase();
        return [countPhraseMatches(firstQuarter, URGENCY_PHRASES), null];
    }
    if (key === 'urgency_count_last_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const lastQuarter = words.slice(Math.floor(words.length * 0.75)).join(' ').toLowerCase();
        return [countPhraseMatches(lastQuarter, URGENCY_PHRASES), null];
    }
    if (key === 'urgency_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ').toLowerCase();
        const secondHalf = words.slice(mid).join(' ').toLowerCase();
        const c1 = countPhraseMatches(firstHalf, URGENCY_PHRASES);
        const c2 = countPhraseMatches(secondHalf, URGENCY_PHRASES);
        return [c1 / (c2 + 0.001), null];
    }

    // ── Group R: New psychographic indicator families ──────────────────
    if (key === 'rhetorical_question_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), RHETORICAL_QUESTION_PHRASES), null];
    }
    if (key === 'rhetorical_question_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), RHETORICAL_QUESTION_PHRASES) / words.length, null];
    }
    if (key === 'rhetorical_question_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, RHETORICAL_QUESTION_PHRASES), null];
    }
    if (key === 'rhetorical_question_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, RHETORICAL_QUESTION_PHRASES);
        const s = countPhraseMatches(secondHalf, RHETORICAL_QUESTION_PHRASES) + 0.0001;
        return [f / s, null];
    }

    if (key === 'social_comparison_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), SOCIAL_COMPARISON_PHRASES), null];
    }
    if (key === 'social_comparison_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), SOCIAL_COMPARISON_PHRASES) / words.length, null];
    }
    if (key === 'social_comparison_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, SOCIAL_COMPARISON_PHRASES), null];
    }
    if (key === 'social_comparison_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, SOCIAL_COMPARISON_PHRASES), null];
    }

    if (key === 'transformation_arc_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), TRANSFORMATION_ARC_PHRASES), null];
    }
    if (key === 'transformation_arc_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), TRANSFORMATION_ARC_PHRASES) / words.length, null];
    }
    if (key === 'transformation_arc_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, TRANSFORMATION_ARC_PHRASES), null];
    }
    if (key === 'transformation_arc_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, TRANSFORMATION_ARC_PHRASES), null];
    }

    if (key === 'loss_framing_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), LOSS_FRAMING_PHRASES), null];
    }
    if (key === 'loss_framing_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), LOSS_FRAMING_PHRASES) / words.length, null];
    }
    if (key === 'loss_framing_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, LOSS_FRAMING_PHRASES), null];
    }
    if (key === 'loss_framing_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, LOSS_FRAMING_PHRASES), null];
    }

    if (key === 'mystery_setup_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), MYSTERY_SETUP_PHRASES), null];
    }
    if (key === 'mystery_setup_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), MYSTERY_SETUP_PHRASES) / words.length, null];
    }
    if (key === 'mystery_setup_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, MYSTERY_SETUP_PHRASES), null];
    }
    if (key === 'mystery_setup_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, MYSTERY_SETUP_PHRASES);
        const s = countPhraseMatches(secondHalf, MYSTERY_SETUP_PHRASES) + 0.0001;
        return [f / s, null];
    }

    if (key === 'promise_specificity_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PROMISE_SPECIFICITY_PHRASES), null];
    }
    if (key === 'promise_specificity_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PROMISE_SPECIFICITY_PHRASES) / words.length, null];
    }
    if (key === 'promise_specificity_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, PROMISE_SPECIFICITY_PHRASES), null];
    }
    if (key === 'promise_specificity_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, PROMISE_SPECIFICITY_PHRASES);
        const s = countPhraseMatches(secondHalf, PROMISE_SPECIFICITY_PHRASES) + 0.0001;
        return [f / s, null];
    }

    if (key === 'pattern_interrupt_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PATTERN_INTERRUPT_PHRASES), null];
    }
    if (key === 'pattern_interrupt_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PATTERN_INTERRUPT_PHRASES) / words.length, null];
    }
    if (key === 'pattern_interrupt_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, PATTERN_INTERRUPT_PHRASES), null];
    }
    if (key === 'pattern_interrupt_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, PATTERN_INTERRUPT_PHRASES), null];
    }

    if (key === 'viewer_stakes_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), VIEWER_STAKES_PHRASES), null];
    }
    if (key === 'viewer_stakes_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), VIEWER_STAKES_PHRASES) / words.length, null];
    }
    if (key === 'viewer_stakes_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, VIEWER_STAKES_PHRASES), null];
    }
    if (key === 'viewer_stakes_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, VIEWER_STAKES_PHRASES);
        const s = countPhraseMatches(secondHalf, VIEWER_STAKES_PHRASES) + 0.0001;
        return [f / s, null];
    }

    // ── Group S: Social proof / curiosity gap / emotional peak / commitment device / proof of work / future self / failure vulnerability / action trigger ──

    // Social proof
    if (key === 'social_proof_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), SOCIAL_PROOF_PHRASES), null];
    }
    if (key === 'social_proof_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), SOCIAL_PROOF_PHRASES) / words.length, null];
    }
    if (key === 'social_proof_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, SOCIAL_PROOF_PHRASES), null];
    }
    if (key === 'social_proof_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, SOCIAL_PROOF_PHRASES);
        const s = countPhraseMatches(secondHalf, SOCIAL_PROOF_PHRASES) + 0.0001;
        return [f / s, null];
    }

    // Curiosity gap
    if (key === 'curiosity_gap_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CURIOSITY_GAP_PHRASES), null];
    }
    if (key === 'curiosity_gap_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CURIOSITY_GAP_PHRASES) / words.length, null];
    }
    if (key === 'curiosity_gap_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, CURIOSITY_GAP_PHRASES), null];
    }
    if (key === 'curiosity_gap_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, CURIOSITY_GAP_PHRASES);
        const s = countPhraseMatches(secondHalf, CURIOSITY_GAP_PHRASES) + 0.0001;
        return [f / s, null];
    }

    // Emotional peak
    if (key === 'emotional_peak_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), EMOTIONAL_PEAK_PHRASES), null];
    }
    if (key === 'emotional_peak_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), EMOTIONAL_PEAK_PHRASES) / words.length, null];
    }
    if (key === 'emotional_peak_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, EMOTIONAL_PEAK_PHRASES), null];
    }
    if (key === 'emotional_peak_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, EMOTIONAL_PEAK_PHRASES), null];
    }

    // Commitment device
    if (key === 'commitment_device_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), COMMITMENT_DEVICE_PHRASES), null];
    }
    if (key === 'commitment_device_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), COMMITMENT_DEVICE_PHRASES) / words.length, null];
    }
    if (key === 'commitment_device_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, COMMITMENT_DEVICE_PHRASES), null];
    }
    if (key === 'commitment_device_count_first_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstQuarter = words.slice(0, Math.floor(words.length / 4)).join(' ').toLowerCase();
        return [countPhraseMatches(firstQuarter, COMMITMENT_DEVICE_PHRASES), null];
    }

    // Proof of work
    if (key === 'proof_of_work_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PROOF_OF_WORK_PHRASES), null];
    }
    if (key === 'proof_of_work_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PROOF_OF_WORK_PHRASES) / words.length, null];
    }
    if (key === 'proof_of_work_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, PROOF_OF_WORK_PHRASES), null];
    }
    if (key === 'proof_of_work_front_load_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        const f = countPhraseMatches(firstHalf, PROOF_OF_WORK_PHRASES);
        const s = countPhraseMatches(secondHalf, PROOF_OF_WORK_PHRASES) + 0.0001;
        return [f / s, null];
    }

    // Future self
    if (key === 'future_self_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), FUTURE_SELF_PHRASES), null];
    }
    if (key === 'future_self_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), FUTURE_SELF_PHRASES) / words.length, null];
    }
    if (key === 'future_self_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, FUTURE_SELF_PHRASES), null];
    }
    if (key === 'future_self_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, FUTURE_SELF_PHRASES), null];
    }

    // Failure vulnerability
    if (key === 'failure_vulnerability_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), FAILURE_VULNERABILITY_PHRASES), null];
    }
    if (key === 'failure_vulnerability_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), FAILURE_VULNERABILITY_PHRASES) / words.length, null];
    }
    if (key === 'failure_vulnerability_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, FAILURE_VULNERABILITY_PHRASES), null];
    }
    if (key === 'failure_vulnerability_count_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, FAILURE_VULNERABILITY_PHRASES), null];
    }

    // Action trigger
    if (key === 'action_trigger_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), ACTION_TRIGGER_PHRASES), null];
    }
    if (key === 'action_trigger_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), ACTION_TRIGGER_PHRASES) / words.length, null];
    }
    if (key === 'action_trigger_count_hook') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(hookText, ACTION_TRIGGER_PHRASES), null];
    }
    if (key === 'action_trigger_count_last_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const lastQuarter = words.slice(Math.floor(words.length * 0.75)).join(' ').toLowerCase();
        return [countPhraseMatches(lastQuarter, ACTION_TRIGGER_PHRASES), null];
    }

    // ── Group S: Scalar/derived indicators ──────────────────────────────
    if (key === 'loop_resolution_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const openCt = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const closedCt = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        return [closedCt / (openCt + 0.001), null];
    }
    if (key === 'promise_density_first_third') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const third = Math.floor(words.length / 3);
        const firstThird = words.slice(0, third).join(' ').toLowerCase();
        const tWords = firstThird.split(/\s+/).filter(Boolean);
        if (!tWords.length) return [0, null];
        return [countPhraseMatches(firstThird, PROMISE_SPECIFICITY_PHRASES) / tWords.length, null];
    }
    if (key === 'emotional_arc_peak_pct') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length < 10) return [null, 'transcript too short'];
        const WIN = 10;
        let maxDensity = -1;
        let peakPos = 0;
        for (let i = 0; i <= words.length - WIN; i++) {
            const windowText = words.slice(i, i + WIN).join(' ');
            const density = countPhraseMatches(windowText, EMOTIONAL_PEAK_PHRASES) / WIN;
            if (density > maxDensity) {
                maxDensity = density;
                peakPos = i;
            }
        }
        return [(peakPos / words.length) * 100, null];
    }
    if (key === 'curiosity_resolution_gap_pct') {
        if (!transcript) return [null, 'no transcript'];
        const [payoffPct] = extractMetric('payoff_position_pct', analysis);
        const [gratPct] = extractMetric('gratification_delay_pct', analysis);
        if (payoffPct == null || gratPct == null) return [null, 'missing component metrics'];
        return [Math.abs(payoffPct - gratPct), null];
    }
    if (key === 'hook_phrase_diversity') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        const allFamilies = [
            NEW_PROOF_PHRASES, NEW_SETUP_PHRASES, NEW_PAYOFF_PHRASES,
            NEW_VISUAL_PROOF_PHRASES, NEW_CREDENTIAL_PHRASES, NEW_CONSEQUENCE_PHRASES,
            NEW_PERSONAL_STAKE_PHRASES, NEW_MICRO_REWARD_PHRASES, NEW_EARLY_ENGAGEMENT_PHRASES,
            NEW_MID_FILLER_PHRASES, NEW_CLOSING_HOOK_PHRASES,
            ANTICIPATION_PHRASES, COUNTERINTUITIVE_PHRASES, CONFESSION_PHRASES,
            ESCALATION_PHRASES, SPECIFICITY_PHRASES, CALLBACK_PHRASES, URGENCY_PHRASES,
            RHETORICAL_QUESTION_PHRASES, SOCIAL_COMPARISON_PHRASES, TRANSFORMATION_ARC_PHRASES,
            LOSS_FRAMING_PHRASES, MYSTERY_SETUP_PHRASES, PROMISE_SPECIFICITY_PHRASES,
            PATTERN_INTERRUPT_PHRASES, VIEWER_STAKES_PHRASES,
            SOCIAL_PROOF_PHRASES, CURIOSITY_GAP_PHRASES, EMOTIONAL_PEAK_PHRASES,
            COMMITMENT_DEVICE_PHRASES, PROOF_OF_WORK_PHRASES, FUTURE_SELF_PHRASES,
            FAILURE_VULNERABILITY_PHRASES, ACTION_TRIGGER_PHRASES,
            ...Object.values(ZYGARNIK_PHRASE_SETS),
        ];
        let diversity = 0;
        for (const familyPhrases of allFamilies) {
            if (countPhraseMatches(hookText, familyPhrases) > 0) diversity++;
        }
        return [diversity, null];
    }
    if (key === 'social_proof_before_midpoint_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, SOCIAL_PROOF_PHRASES), null];
    }
    if (key === 'proof_of_work_before_claim_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstThird = words.slice(0, Math.floor(words.length * 0.3)).join(' ').toLowerCase();
        const f = countPhraseMatches(firstThird, PROOF_OF_WORK_PHRASES);
        const total = countPhraseMatches(transcript.toLowerCase(), PROOF_OF_WORK_PHRASES);
        return [f / (total + 0.001), null];
    }

    // ── Group S: Windowed variants for phrase families ───────────────────
    {
        const _gsRe = /^(social_proof|curiosity_gap|emotional_peak|proof_of_work|failure_vulnerability)_(count|density)_first(\d+)s$/;
        const _gsm = key.match(_gsRe);
        if (_gsm) {
            if (!transcript) return [null, 'no transcript'];
            const dur = meta.duration || 0;
            const wSec = parseInt(_gsm[3]);
            const fam = _gsm[1];
            const variant = _gsm[2];
            let wText;
            if (dur) {
                wText = windowedTranscript(transcript, dur, wSec);
            } else {
                const allWords = transcript.split(/\s+/).filter(Boolean);
                wText = allWords.slice(0, Math.ceil(allWords.length * 0.1)).join(' ');
            }
            if (!wText) return [null, 'no text for window'];
            const wl = wText.toLowerCase();
            const wWords = wl.split(/\s+/).filter(Boolean);
            if (!wWords.length) return [0, null];
            const _gsPhraseMap = {
                'social_proof': SOCIAL_PROOF_PHRASES,
                'curiosity_gap': CURIOSITY_GAP_PHRASES,
                'emotional_peak': EMOTIONAL_PEAK_PHRASES,
                'proof_of_work': PROOF_OF_WORK_PHRASES,
                'failure_vulnerability': FAILURE_VULNERABILITY_PHRASES,
            };
            const phrases = _gsPhraseMap[fam];
            const count = countPhraseMatches(wl, phrases);
            return variant === 'density' ? [count / wWords.length, null] : [count, null];
        }
    }

    // ── Group T: Reference callback / visual credibility / payoff signal / setup signal / stakes escalation / proof arrival / narrative anchor / delayed reveal ──
    {
        const _gtFamilies = {
            'reference_callback':     REFERENCE_CALLBACK_PHRASES,
            'visual_credibility':     VISUAL_CREDIBILITY_PHRASES,
            'payoff_signal':          PAYOFF_SIGNAL_PHRASES,
            'setup_signal':           SETUP_SIGNAL_PHRASES,
            'stakes_escalation':      STAKES_ESCALATION_PHRASES,
            'proof_arrival':          PROOF_ARRIVAL_PHRASES,
            'narrative_anchor':       NARRATIVE_ANCHOR_PHRASES,
            'delayed_reveal':         DELAYED_REVEAL_PHRASES,
            // Group V
            'early_proof':            EARLY_PROOF_PHRASES,
            'social_signal':          SOCIAL_SIGNAL_PHRASES,
            'pre_upload_credibility': PRE_UPLOAD_CREDIBILITY_PHRASES,
        };

        // Per-family count/density/hook/positional keys
        for (const [fam, phrases] of Object.entries(_gtFamilies)) {
            if (key === `${fam}_count`) {
                if (!transcript) return [null, 'no transcript'];
                return [countPhraseMatches(transcript.toLowerCase(), phrases), null];
            }
            if (key === `${fam}_density`) {
                if (!transcript) return [null, 'no transcript'];
                const words = transcript.split(/\s+/).filter(Boolean);
                if (!words.length) return [null, 'empty transcript'];
                return [countPhraseMatches(transcript.toLowerCase(), phrases) / words.length, null];
            }
            if (key === `${fam}_count_hook`) {
                if (!transcript) return [null, 'no transcript'];
                const words = transcript.split(/\s+/).filter(Boolean);
                if (!words.length) return [null, 'empty transcript'];
                const hookText = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
                return [countPhraseMatches(hookText, phrases), null];
            }
            if (key === `${fam}_front_load_ratio`) {
                if (!transcript) return [null, 'no transcript'];
                const words = transcript.split(/\s+/).filter(Boolean);
                if (!words.length) return [null, 'empty transcript'];
                const half = Math.floor(words.length / 2);
                const firstHalf = words.slice(0, half).join(' ').toLowerCase();
                const secondHalf = words.slice(half).join(' ').toLowerCase();
                const f = countPhraseMatches(firstHalf, phrases);
                const s = countPhraseMatches(secondHalf, phrases) + 0.0001;
                return [f / s, null];
            }
            if (key === `${fam}_count_mid`) {
                if (!transcript) return [null, 'no transcript'];
                const words = transcript.split(/\s+/).filter(Boolean);
                if (!words.length) return [null, 'empty transcript'];
                const midText = words.slice(Math.floor(words.length * 0.33), Math.floor(words.length * 0.67)).join(' ').toLowerCase();
                return [countPhraseMatches(midText, phrases), null];
            }
            if (key === `${fam}_count_first_half`) {
                if (!transcript) return [null, 'no transcript'];
                const words = transcript.split(/\s+/).filter(Boolean);
                if (!words.length) return [null, 'empty transcript'];
                const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
                return [countPhraseMatches(firstHalf, phrases), null];
            }
            if (key === `${fam}_count_last_quarter`) {
                if (!transcript) return [null, 'no transcript'];
                const words = transcript.split(/\s+/).filter(Boolean);
                if (!words.length) return [null, 'empty transcript'];
                const lqText = words.slice(Math.floor(words.length * 0.75)).join(' ').toLowerCase();
                return [countPhraseMatches(lqText, phrases), null];
            }
            if (key === `${fam}_position_pct`) {
                if (!transcript) return [null, 'no transcript'];
                const tl = transcript.toLowerCase();
                for (const ph of phrases) {
                    const idx = tl.indexOf(ph);
                    if (idx !== -1) return [idx / tl.length, null];
                }
                return [null, 'phrase not found'];
            }
        }

        // Windowed variants for Group T families
        const _gtWinRe = /^(reference_callback|visual_credibility|payoff_signal|setup_signal|stakes_escalation|proof_arrival|narrative_anchor|delayed_reveal|early_proof|social_signal|pre_upload_credibility)_(count|density)_first(\d+)s$/;
        const _gtm = key.match(_gtWinRe);
        if (_gtm) {
            if (!transcript) return [null, 'no transcript'];
            const dur = meta.duration || 0;
            const wSec = parseInt(_gtm[3]);
            const fam = _gtm[1];
            const variant = _gtm[2];
            let wText;
            if (dur) {
                wText = windowedTranscript(transcript, dur, wSec);
            } else {
                const allWords = transcript.split(/\s+/).filter(Boolean);
                wText = allWords.slice(0, Math.ceil(allWords.length * 0.1)).join(' ');
            }
            if (!wText) return [null, 'no text for window'];
            const wl = wText.toLowerCase();
            const wWords = wl.split(/\s+/).filter(Boolean);
            if (!wWords.length) return [0, null];
            const phrases = _gtFamilies[fam];
            const count = countPhraseMatches(wl, phrases);
            return variant === 'density' ? [count / wWords.length, null] : [count, null];
        }

        // Group T scalar/derived metrics
        if (key === 'setup_to_payoff_signal_gap_pct') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            let firstSetup = -1, firstPayoff = -1;
            for (const ph of SETUP_SIGNAL_PHRASES) {
                const idx = tl.indexOf(ph);
                if (idx !== -1) firstSetup = firstSetup === -1 ? idx : Math.min(firstSetup, idx);
            }
            for (const ph of PAYOFF_SIGNAL_PHRASES) {
                const idx = tl.indexOf(ph);
                if (idx !== -1) firstPayoff = firstPayoff === -1 ? idx : Math.min(firstPayoff, idx);
            }
            if (firstSetup === -1 || firstPayoff === -1) return [null, 'phrase not found'];
            return [Math.max(0, (firstPayoff - firstSetup) / tl.length), null];
        }
        if (key === 'proof_arrival_timing_pct') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            for (const ph of PROOF_ARRIVAL_PHRASES) {
                const idx = tl.indexOf(ph);
                if (idx !== -1) return [idx / tl.length, null];
            }
            return [null, 'phrase not found'];
        }
        if (key === 'delayed_reveal_to_payoff_ratio') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            let dr = 0, ps = 0;
            for (const ph of DELAYED_REVEAL_PHRASES) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { dr++; i += ph.length; } }
            for (const ph of PAYOFF_SIGNAL_PHRASES) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { ps++; i += ph.length; } }
            if (ps === 0) return [null, 'no payoff signals'];
            return [dr / ps, null];
        }
        if (key === 'visual_credibility_before_claim_ratio') {
            if (!transcript) return [null, 'no transcript'];
            const words = transcript.split(/\s+/).filter(Boolean);
            if (!words.length) return [null, 'empty transcript'];
            const tl = transcript.toLowerCase();
            const halfText = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
            const total = countPhraseMatches(tl, VISUAL_CREDIBILITY_PHRASES);
            if (total === 0) return [null, 'no visual credibility phrases'];
            const beforeHalf = countPhraseMatches(halfText, VISUAL_CREDIBILITY_PHRASES);
            return [beforeHalf / total, null];
        }
        if (key === 'reference_callback_rate_per_min') {
            if (!transcript) return [null, 'no transcript'];
            const dur = meta.duration || 0;
            if (!dur) return [null, 'no duration'];
            const count = countPhraseMatches(transcript.toLowerCase(), REFERENCE_CALLBACK_PHRASES);
            return [count / (dur / 60), null];
        }
        if (key === 'stakes_escalation_mid_density') {
            if (!transcript) return [null, 'no transcript'];
            const words = transcript.split(/\s+/).filter(Boolean);
            if (!words.length) return [null, 'empty transcript'];
            const midText = words.slice(Math.floor(words.length * 0.33), Math.floor(words.length * 0.67)).join(' ').toLowerCase();
            const midWords = midText.split(/\s+/).filter(Boolean);
            if (!midWords.length) return [0, null];
            return [countPhraseMatches(midText, STAKES_ESCALATION_PHRASES) / midWords.length, null];
        }
        if (key === 'narrative_anchor_peak_pct') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            let lastIdx = -1;
            for (const ph of NARRATIVE_ANCHOR_PHRASES) {
                let i = 0;
                while ((i = tl.indexOf(ph, i)) !== -1) { lastIdx = Math.max(lastIdx, i); i += ph.length; }
            }
            if (lastIdx === -1) return [null, 'phrase not found'];
            return [lastIdx / tl.length, null];
        }
        if (key === 'delayed_reveal_setup_ratio') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            let dr = 0, ss = 0;
            for (const ph of DELAYED_REVEAL_PHRASES) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { dr++; i += ph.length; } }
            for (const ph of SETUP_SIGNAL_PHRASES) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { ss++; i += ph.length; } }
            if (ss === 0) return [null, 'no setup signals'];
            return [dr / ss, null];
        }
    }

    // ── Group U: Cliffhanger signals ─────────────────────────────────────

    if (key === 'cliffhanger_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CLIFFHANGER_PHRASES), null];
    }
    if (key === 'cliffhanger_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CLIFFHANGER_PHRASES) / words.length, null];
    }
    if (key === 'cliffhanger_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, CLIFFHANGER_PHRASES), null];
    }
    if (key === 'cliffhanger_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, CLIFFHANGER_PHRASES), null];
    }

    // ── Group U: Payoff tease signals ────────────────────────────────────

    if (key === 'payoff_tease_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PAYOFF_TEASE_PHRASES), null];
    }
    if (key === 'payoff_tease_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PAYOFF_TEASE_PHRASES) / words.length, null];
    }
    if (key === 'payoff_tease_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, PAYOFF_TEASE_PHRASES), null];
    }
    if (key === 'payoff_tease_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, PAYOFF_TEASE_PHRASES), null];
    }

    // ── Group U: Stakes reinforcement signals ────────────────────────────

    if (key === 'stakes_reinforcement_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), STAKES_REINFORCEMENT_PHRASES), null];
    }
    if (key === 'stakes_reinforcement_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), STAKES_REINFORCEMENT_PHRASES) / words.length, null];
    }
    if (key === 'stakes_reinforcement_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, STAKES_REINFORCEMENT_PHRASES), null];
    }
    if (key === 'stakes_reinforcement_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, STAKES_REINFORCEMENT_PHRASES), null];
    }

    // ── Group U: Viewer agency signals ───────────────────────────────────

    if (key === 'viewer_agency_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), VIEWER_AGENCY_PHRASES), null];
    }
    if (key === 'viewer_agency_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), VIEWER_AGENCY_PHRASES) / words.length, null];
    }
    if (key === 'viewer_agency_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, VIEWER_AGENCY_PHRASES), null];
    }
    if (key === 'viewer_agency_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, VIEWER_AGENCY_PHRASES), null];
    }

    // ── Group U: Revelation signal signals ───────────────────────────────

    if (key === 'revelation_signal_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), REVELATION_SIGNAL_PHRASES), null];
    }
    if (key === 'revelation_signal_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), REVELATION_SIGNAL_PHRASES) / words.length, null];
    }
    if (key === 'revelation_signal_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, REVELATION_SIGNAL_PHRASES), null];
    }
    if (key === 'revelation_signal_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, REVELATION_SIGNAL_PHRASES), null];
    }

    // ── Group U: Curiosity escalation signals ────────────────────────────

    if (key === 'curiosity_escalation_count') {
        if (!transcript) return [null, 'no transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CURIOSITY_ESCALATION_PHRASES), null];
    }
    if (key === 'curiosity_escalation_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), CURIOSITY_ESCALATION_PHRASES) / words.length, null];
    }
    if (key === 'curiosity_escalation_first_half_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, CURIOSITY_ESCALATION_PHRASES), null];
    }
    if (key === 'curiosity_escalation_hook_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const first10 = words.slice(0, Math.ceil(words.length * 0.1)).join(' ').toLowerCase();
        return [countPhraseMatches(first10, CURIOSITY_ESCALATION_PHRASES), null];
    }

    // ── Group W: Zygarnik gradient / ref-to-gratification / proof-closure / credibility / story-stake ──
    if (key === "zygarnik_gradient_pct") {
        const [olFull] = extractMetric('open_loop_count', analysis);
        const [ol20] = extractMetric('open_loop_count_first20s', analysis);
        const [ol5] = extractMetric('open_loop_count_first5s', analysis);
        const a = olFull || 0, b = ol20 || 0, c = ol5 || 0;
        return [Math.max(0, b - c) / Math.max(a, 1), null];
    }
    if (key === "zygarnik_front_load_ratio") {
        const [olFull] = extractMetric('open_loop_count', analysis);
        const [ol10] = extractMetric('open_loop_count_first10s', analysis);
        const a = olFull || 0, b = ol10 || 0;
        return [b / Math.max(a, 1), null];
    }
    if (key === "loop_to_closure_gap_s") {
        const dur = meta.duration || 60;
        const [cl5] = extractMetric('closure_count_first5s', analysis);
        const [ol5] = extractMetric('open_loop_count_first5s', analysis);
        const c = cl5 || 0, o = ol5 || 0;
        return [c > 0 ? 0 : dur * Math.min(o / Math.max(o, 1), 1), null];
    }
    if (key === "ref_to_gratification_gap_pct") {
        const [olQ1] = extractMetric('open_loop_density_first_quarter', analysis);
        const [cbDensity] = extractMetric('reference_callback_density', analysis);
        const a = olQ1 || 0, b = cbDensity || 0;
        return [a / Math.max(b, 0.001), null];
    }
    if (key === "gratification_density_first_quarter") {
        const [mrd] = extractMetric('micro_reward_density', analysis);
        const [sdp] = extractMetric('setup_duration_pct', analysis);
        const a = mrd || 0, b = sdp || 0;
        return [a * b, null];
    }
    if (key === "pre_payoff_tension_index") {
        const [zs] = extractMetric('zygarnik_score', analysis);
        const [sdp] = extractMetric('setup_duration_pct', analysis);
        const a = zs || 0, b = sdp || 0;
        return [a * (1 - b), null];
    }
    if (key === "early_proof_to_loop_ratio") {
        const [vp10] = extractMetric('visual_proof_phrase_count_first10s', analysis);
        const [ol10] = extractMetric('open_loop_count_first10s', analysis);
        const a = vp10 || 0, b = ol10 || 0;
        return [a / Math.max(b, 1), null];
    }
    if (key === "proof_arrival_delay_proxy") {
        const [vp10] = extractMetric('visual_proof_phrase_count_first10s', analysis);
        const [vpFull] = extractMetric('visual_proof_phrase_count', analysis);
        const a = vp10 || 0, b = vpFull || 0;
        return [1 - (a / Math.max(b, 1)), null];
    }
    if (key === "closure_to_open_ratio_first10s") {
        const [cl10] = extractMetric('closure_count_first10s', analysis);
        const [ol10] = extractMetric('open_loop_count_first10s', analysis);
        const a = cl10 || 0, b = ol10 || 0;
        return [a / Math.max(b, 1), null];
    }
    if (key === "credibility_setup_pct") {
        const [cs10] = extractMetric('credential_signal_count_first10s', analysis);
        const [csFull] = extractMetric('credential_signal_count', analysis);
        const a = cs10 || 0, b = csFull || 0;
        return [a / Math.max(b, 1), null];
    }
    if (key === "proof_density_hook") {
        const [vp5] = extractMetric('visual_proof_phrase_count_first5s', analysis);
        return [(vp5 || 0) / 5.0, null];
    }
    if (key === "visual_credibility_density_hook") {
        const [cs5] = extractMetric('credential_signal_count_first5s', analysis);
        return [(cs5 || 0) / 5.0, null];
    }
    if (key === "stakes_to_loop_ratio") {
        const [sh] = extractMetric('stakes_density_hook', analysis);
        const [ol5] = extractMetric('open_loop_density_first5s', analysis);
        const a = sh || 0, b = ol5 || 0;
        return [a / Math.max(b, 0.001), null];
    }
    if (key === "stake_loop_product") {
        const [psd] = extractMetric('personal_stake_density', analysis);
        const [old_] = extractMetric('open_loop_density', analysis);
        const a = psd || 0, b = old_ || 0;
        return [a * b, null];
    }
    if (key === "consequence_front_weight") {
        const [cdH] = extractMetric('consequence_density_first_half', analysis);
        const [cdFull] = extractMetric('consequence_density', analysis);
        const a = cdH || 0, b = cdFull || 0;
        return [a / Math.max(b, 0.001), null];
    }

    // Group X special keys: tension_ratchet / promise_echo / story_clock / proof_build
    if (key === 'tension_ratchet_hook_count') {
        const htl = (analysis.hook_text || '').toLowerCase();
        return [countPhraseMatches(htl, ZYGARNIK_PHRASE_SETS.tension_ratchet), null];
    }
    if (key === 'tension_ratchet_density') {
        const tl = (transcript || '').toLowerCase();
        const dur = meta.duration || 0;
        if (!tl || !dur) return [null, 'no transcript/duration'];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.tension_ratchet) / dur, null];
    }
    if (key === 'promise_echo_density') {
        const tl = (transcript || '').toLowerCase();
        const dur = meta.duration || 0;
        if (!tl || !dur) return [null, 'no transcript/duration'];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.promise_echo) / dur, null];
    }
    if (key === 'promise_echo_second_half_count') {
        const dur2 = meta.duration || 0;
        if (!transcript || !dur2) return [null, 'no transcript/duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        const half = Math.floor(words.length / 2);
        const secondHalf = words.slice(half).join(' ').toLowerCase();
        return [countPhraseMatches(secondHalf, ZYGARNIK_PHRASE_SETS.promise_echo), null];
    }
    if (key === 'story_clock_density') {
        const tl = (transcript || '').toLowerCase();
        const dur = meta.duration || 0;
        if (!tl || !dur) return [null, 'no transcript/duration'];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.story_clock) / dur, null];
    }
    if (key === 'story_clock_count_first10s') {
        const dur3 = meta.duration || 0;
        if (!transcript || !dur3) return [null, 'no transcript/duration'];
        const win = windowedTranscript(transcript, dur3, 10).toLowerCase();
        return [countPhraseMatches(win, ZYGARNIK_PHRASE_SETS.story_clock), null];
    }
    if (key === 'proof_build_density') {
        const tl = (transcript || '').toLowerCase();
        const dur = meta.duration || 0;
        if (!tl || !dur) return [null, 'no transcript/duration'];
        return [countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.proof_build) / dur, null];
    }
    if (key === 'proof_build_count_first_half') {
        const dur4 = meta.duration || 0;
        if (!transcript || !dur4) return [null, 'no transcript/duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        const half = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, half).join(' ').toLowerCase();
        return [countPhraseMatches(firstHalf, ZYGARNIK_PHRASE_SETS.proof_build), null];
    }

    // ── Group Y: High-resolution zygarnik structural metrics ────────────────
    if (key === 'open_loop_density_second_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const q1 = Math.floor(words.length * 0.25);
        const q2 = Math.floor(words.length * 0.50);
        const midText = words.slice(q1, q2).join(' ').toLowerCase();
        const midWords = midText.split(/\s+/).filter(Boolean);
        if (!midWords.length) return [0, null];
        return [countPhraseMatches(midText, ZYGARNIK_PHRASE_SETS.open_loop) / midWords.length, null];
    }
    if (key === 'open_loop_density_third_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const q2 = Math.floor(words.length * 0.50);
        const q3 = Math.floor(words.length * 0.75);
        const midText = words.slice(q2, q3).join(' ').toLowerCase();
        const midWords = midText.split(/\s+/).filter(Boolean);
        if (!midWords.length) return [0, null];
        return [countPhraseMatches(midText, ZYGARNIK_PHRASE_SETS.open_loop) / midWords.length, null];
    }
    if (key === 'loop_resolution_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const ol = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        const cl = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        if (cl === 0) return [ol > 0 ? 2.0 : null, ol > 0 ? null : 'no loops or closures'];
        return [ol / cl, null];
    }
    if (key === 'sustained_tension_word_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        let firstLoop = -1, firstClosure = -1;
        for (const ph of ZYGARNIK_PHRASE_SETS.open_loop) {
            const idx = tl.indexOf(ph);
            if (idx !== -1) firstLoop = firstLoop === -1 ? idx : Math.min(firstLoop, idx);
        }
        for (const ph of ZYGARNIK_PHRASE_SETS.closure) {
            const idx = tl.indexOf(ph);
            if (idx !== -1) firstClosure = firstClosure === -1 ? idx : Math.min(firstClosure, idx);
        }
        if (firstLoop === -1) return [null, 'no open loops'];
        if (firstClosure === -1 || firstClosure <= firstLoop) return [null, 'no closure after loop'];
        return [(firstClosure - firstLoop) / tl.length, null];
    }
    if (key === 'proof_phrase_mid_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const q1 = Math.floor(words.length * 0.25);
        const q3 = Math.floor(words.length * 0.75);
        const midText = words.slice(q1, q3).join(' ').toLowerCase();
        const midWords = midText.split(/\s+/).filter(Boolean);
        if (!midWords.length) return [0, null];
        return [countPhraseMatches(midText, NEW_VISUAL_PROOF_PHRASES) / midWords.length, null];
    }
    if (key === 'open_loop_front_third_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const q1 = Math.floor(words.length * 0.33);
        const frontText = words.slice(0, q1).join(' ').toLowerCase();
        const frontWords = frontText.split(/\s+/).filter(Boolean);
        if (!frontWords.length) return [0, null];
        return [countPhraseMatches(frontText, ZYGARNIK_PHRASE_SETS.open_loop) / frontWords.length, null];
    }

    return [null, `unknown key: ${key}`];
}


// ── Candidate generation ─────────────────────────────────────────────────

const DEFAULT_CANDIDATES = [
    'hook_retention_pct', 'final_5pct_retention', 'mid_video_cliff',
    'retention_entropy', 'hook_drop_rate', 'early_momentum',
    'retention_25pct', 'retention_50pct', 'retention_75pct', 'retention_90pct',
    'above_baseline_mean', 'peak_count', 'drop_count', 'max_peak_delta',
    'max_drop_delta', 'retention_variance', 'retention_skew',
    'view_accel_7day', 'week1_week2_ratio', 'non_sub_view_share',
    'swipe_away_rate', 'daily_view_peak_day',
    'like_rate', 'comment_rate', 'share_rate', 'subs_gained_per_view',
    'subs_per_like', 'revenue_per_view',
    'duration_log', 'transcript_word_count', 'speech_rate_wps',
    'hook_word_count', 'question_count', 'segment_count',
    'has_hook_segment', 'hook_duration_s',
    'face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count',
    'keep_x_non_sub_share',
];

function generateAutonomousCandidates() {
    const candidates = [];

    // ── Priority block: Group W standalone metrics (zygarnik/open-loop/pre-upload) ──
    // These are NOT generated by any other loop below; they must be front-loaded so
    // the runner tests them in the first biasPool batch rather than after 7000+ items.
    for (const k of [
        // W1: Zygarnik tension gradient
        'zygarnik_gradient_pct', 'zygarnik_front_load_ratio', 'loop_to_closure_gap_s',
        // W2: Reference-to-gratification timing
        'ref_to_gratification_gap_pct', 'gratification_density_first_quarter', 'pre_payoff_tension_index',
        // W3: Early proof vs closure
        'early_proof_to_loop_ratio', 'proof_arrival_delay_proxy', 'closure_to_open_ratio_first10s',
        // W4: Visual credibility setup-to-payoff
        'credibility_setup_pct', 'proof_density_hook', 'visual_credibility_density_hook',
        // W5: Story-stake proxies
        'stakes_to_loop_ratio', 'stake_loop_product', 'consequence_front_weight',
        // Group T scalar/derived (phrase-match derived, sparse but valid for correlation)
        'setup_to_payoff_signal_gap_pct', 'proof_arrival_timing_pct',
        'delayed_reveal_to_payoff_ratio', 'visual_credibility_before_claim_ratio',
        'reference_callback_rate_per_min', 'stakes_escalation_mid_density',
        'narrative_anchor_peak_pct', 'delayed_reveal_setup_ratio',
        // Group Y: High-resolution zygarnik structural metrics (new atomics)
        'open_loop_density_second_quarter', 'open_loop_density_third_quarter',
        'loop_resolution_ratio', 'sustained_tension_word_pct',
        'proof_phrase_mid_density', 'open_loop_front_third_density',
    ]) { candidates.push(k); }

    // ── Group X: High-signal zygarnik cross-products (top-r pairs, run before generic interaction loop) ──
    for (const k of [
        'pre_gratification_open_loop_count_x_open_loop_to_closure_ratio',
        'pre_gratification_open_loop_count_x_visual_proof_phrase_count',
        'pre_gratification_open_loop_count_x_setup_duration_s',
        'open_loop_to_closure_ratio_x_setup_duration_s',
        'open_loop_to_closure_ratio_x_proof_before_midpoint_flag',
        'open_loop_density_mid_x_visual_proof_phrase_count',
        'open_loop_density_mid_x_setup_duration_s',
        'open_loop_density_mid_x_open_loop_to_closure_ratio',
        'pre_closure_open_loop_count_x_visual_proof_phrase_count',
        'pre_closure_open_loop_count_x_setup_duration_s',
        'open_loop_before_closure_flag_x_visual_proof_phrase_count',
        'open_loop_before_closure_flag_x_setup_duration_s',
        'zygarnik_gradient_pct_x_open_loop_to_closure_ratio',
        'zygarnik_gradient_pct_x_pre_gratification_open_loop_count',
        'zygarnik_buildup_ratio_x_pre_gratification_open_loop_count',
        'zygarnik_buildup_ratio_x_open_loop_to_closure_ratio',
        'loop_to_closure_gap_s_x_pre_gratification_open_loop_count',
        'stakes_reinforcement_count_x_open_loop_to_closure_ratio',
        'stakes_reinforcement_count_x_pre_gratification_open_loop_count',
        'proof_before_midpoint_flag_x_pre_gratification_open_loop_count',
        'proof_before_midpoint_flag_x_open_loop_density_mid',
        'setup_duration_s_x_pre_gratification_open_loop_count',
        'setup_duration_s_x_open_loop_density_mid',
        'open_loop_count_first20s_x_visual_proof_phrase_count',
        'open_loop_count_first20s_x_setup_duration_s',
    ]) { candidates.push(k); }

    for (const pct of RETENTION_POINTS) candidates.push(`retention_pct_${pct}`);
    for (const [lo, hi] of RETENTION_WINDOWS) candidates.push(`retention_mean_${lo}_${hi}`);
    for (const [lo, hi] of RETENTION_WINDOWS) { if (hi - lo >= 5) candidates.push(`retention_slope_${lo}_${hi}`); }
    for (const [lo, hi] of RETENTION_WINDOWS) { if (hi - lo >= 3) candidates.push(`retention_volatility_${lo}_${hi}`); }
    for (const [d0, d1] of DAILY_VIEWS_WINDOWS) candidates.push(`views_log_days_${d0}_${d1}`);
    for (const [numN, denN] of DAILY_VIEWS_RATIOS) candidates.push(`views_ratio_${numN}_vs_${denN}`);

    // Transcript static
    for (const k of ['transcript_word_count', 'question_count', 'speech_rate_wps']) candidates.push(k);
    // Pre-upload transcript
    for (const k of ['transcript_char_count', 'avg_word_length', 'unique_word_ratio',
        'sentence_count', 'exclamation_count', 'uppercase_word_ratio',
        'hook_question_count', 'hook_word_ratio', 'hook_char_count',
        'transcript_number_count']) candidates.push(k);
    // Frame
    for (const k of ['face_frame_pct', 'text_overlay_frame_pct', 'scene_change_count']) candidates.push(k);
    // Pre-upload visual
    for (const k of ['scene_change_rate', 'unique_scene_ratio', 'visual_technique_count_mean',
        'close_up_frame_pct', 'hand_presence_frame_pct', 'motion_word_frame_pct']) candidates.push(k);
    // Pre-upload structure (climax_position_pct and hook_to_climax_gap_s excluded — require segment data, return null for most videos)
    for (const k of ['hook_duration_pct', 'avg_segment_duration_s', 'longest_segment_duration_s',
        'shortest_segment_duration_s', 'hook_position_s',
        'has_climax_segment']) candidates.push(k);
    // Pre-upload metadata
    for (const k of ['duration_s', 'title_char_count', 'title_word_count',
        'title_question_flag', 'title_exclamation_flag', 'title_number_flag']) candidates.push(k);

    // Zygarnik / Open-Loop / Gratification Delay families
    for (const fam of ZYGARNIK_FAMILIES) {
        for (const measure of ['count', 'density']) {
            candidates.push(`${fam}_${measure}`);
            for (const w of ZYGARNIK_EARLY_WINDOWS) {
                candidates.push(`${fam}_${measure}_first${w}s`);
            }
        }
    }
    for (const k of ZYGARNIK_SPECIAL_KEYS) candidates.push(k);

    // Interaction terms
    const seenPairs = new Set();
    for (let i = 0; i < INTERACTION_BASES.length; i++) {
        for (let j = i + 1; j < INTERACTION_BASES.length; j++) {
            const pk = `${INTERACTION_BASES[i]}_x_${INTERACTION_BASES[j]}`;
            if (!seenPairs.has(pk)) { seenPairs.add(pk); candidates.push(pk); }
        }
    }

    // Group H: New families — temporal tension, stakes, proof signals
    for (const k of [
        "stakes_density", "stakes_density_hook", "loss_aversion_density",
        "credibility_signal_density", "reward_language_density",
        "foreshadow_density", "urgency_density",
        "open_loop_density_first_quarter", "open_loop_density_last_quarter",
        "tension_closure_balance", "first_closure_position_pct",
        "reward_density_first_half", "foreshadow_density_hook",
        "demonstration_frame_pct", "result_reveal_frame_pct",
        "proof_before_midpoint_flag",
    ]) {
        candidates.push(k);
    }

    // Group I: New temporal/proof/stake computed keys
    for (const k of [
        'open_loop_density_mid', 'closure_density_mid', 'story_stake_density_first_quarter',
        'visual_proof_density_hook', 'reference_callback_density_mid',
        'pre_gratification_open_loop_count', 'stake_introduction_position_pct',
        'proof_density_post_midpoint', 'callback_before_payoff_flag',
        'delayed_gratification_peak_position_pct',
    ]) {
        candidates.push(k);
    }

    // Deduplicate preserving order
    const seen = new Set();
    return candidates.filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
}


function canonicalizeKey(raw) {
    let k = raw.trim().toLowerCase();
    k = k.replace(/[^a-z0-9_]/g, '_');
    k = k.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return k;
}

function validateCandidate(key) {
    if (STATIC_KEYS.has(key)) return true;
    let m;
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) { const pct = parseInt(m[1]); return pct >= 1 && pct <= 99; }
    m = key.match(/^retention_(?:mean|slope|volatility)_(\d+)_(\d+)$/);
    if (m) { const lo = parseInt(m[1]), hi = parseInt(m[2]); return lo >= 0 && lo < hi && hi <= 100; }
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) { const d0 = parseInt(m[1]), d1 = parseInt(m[2]); return d0 >= 0 && d0 < d1 && d1 <= 365; }
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) return DAILY_VIEWS_RATIOS.some(r => r[0] === m[1] && r[1] === m[2]);
    m = key.match(/^(.+)_x_(.+)$/);
    if (m) return getMetricDefinition(m[1]) != null && getMetricDefinition(m[2]) != null;
    return false;
}

function getCandidateLayer(key) {
    const defn = getMetricDefinition(key);
    return defn ? (defn.layer || 'post') : 'post';
}

/**
 * Returns true if key is an interaction composite (a_x_b pattern),
 * excluding hardcoded static keys like keep_x_non_sub_share.
 */
function isCompositeKey(key) {
    if (STATIC_KEYS.has(key)) return false;
    return /^(.+)_x_(.+)$/.test(key);
}

/**
 * Parse a composite key into its component keys.
 * Returns { a, b } or null if not composite.
 */
function parseCompositeKey(key) {
    if (STATIC_KEYS.has(key)) return null;
    const m = key.match(/^(.+)_x_(.+)$/);
    if (!m) return null;
    if (getMetricDefinition(m[1]) && getMetricDefinition(m[2])) return { a: m[1], b: m[2] };
    return null;
}

function biasPool(pool, preuploadRatio) {
    if (preuploadRatio == null) return pool;
    const pre = pool.filter(k => getCandidateLayer(k) === 'pre');
    const post = pool.filter(k => getCandidateLayer(k) !== 'pre');
    if (!pre.length) return pool;
    if (!post.length || preuploadRatio >= 1.0) return [...pre, ...post];
    if (preuploadRatio <= 0.0) return [...post, ...pre];

    const result = [];
    let pi = 0, qi = 0;
    const batch = 10;
    while (pi < pre.length || qi < post.length) {
        const nPre = Math.round(batch * preuploadRatio);
        const nPost = batch - nPre;
        let added = 0;
        while (added < nPre && pi < pre.length) { result.push(pre[pi++]); added++; }
        added = 0;
        while (added < nPost && qi < post.length) { result.push(post[qi++]); added++; }
        if (pi >= pre.length && qi < post.length) { result.push(...post.slice(qi)); break; }
        if (qi >= post.length && pi < pre.length) { result.push(...pre.slice(pi)); break; }
    }
    return result;
}


// ── Resolution logic ─────────────────────────────────────────────────────

const INDICATOR_RESOLUTION_MAP = {
    mid_video_cliff: ['r0', 0, 100, null, null],
    retention_entropy: ['r0', 0, 100, null, null],
    above_baseline_mean: ['r0', 0, 100, null, null],
    peak_count: ['r0', 0, 100, null, null],
    drop_count: ['r0', 0, 100, null, null],
    max_peak_delta: ['r0', 0, 100, null, null],
    max_drop_delta: ['r0', 0, 100, null, null],
    retention_variance: ['r0', 0, 100, null, null],
    retention_skew: ['r0', 0, 100, null, null],
    non_sub_view_share: ['r0', 0, 100, null, null],
    swipe_away_rate: ['r0', 0, 100, null, null],
    daily_view_peak_day: ['r0', 0, 100, null, null],
    duration_log: ['r0', 0, 100, null, null],
    transcript_word_count: ['r0', 0, 100, null, null],
    speech_rate_wps: ['r0', 0, 100, null, null],
    segment_count: ['r0', 0, 100, null, null],
    scene_change_count: ['r0', 0, 100, null, null],
    like_rate: ['r0', 0, 100, null, null],
    comment_rate: ['r0', 0, 100, null, null],
    share_rate: ['r0', 0, 100, null, null],
    subs_gained_per_view: ['r0', 0, 100, null, null],
    subs_per_like: ['r0', 0, 100, null, null],
    revenue_per_view: ['r0', 0, 100, null, null],
    keep_x_non_sub_share: ['r0', 0, 100, null, null],
    face_frame_pct: ['r0', 0, 100, null, null],
    text_overlay_frame_pct: ['r0', 0, 100, null, null],
    transcript_char_count: ['r0', 0, 100, null, null],
    avg_word_length: ['r0', 0, 100, null, null],
    unique_word_ratio: ['r0', 0, 100, null, null],
    sentence_count: ['r0', 0, 100, null, null],
    exclamation_count: ['r0', 0, 100, null, null],
    uppercase_word_ratio: ['r0', 0, 100, null, null],
    transcript_number_count: ['r0', 0, 100, null, null],
    hook_question_count: ['r_hook', 0, 10, null, null],
    hook_word_ratio: ['r_hook', 0, 10, null, null],
    hook_char_count: ['r_hook', 0, 10, null, null],
    hook_duration_pct: ['r_hook', 0, 10, null, null],
    hook_position_s: ['r_hook', 0, 10, null, null],
    avg_segment_duration_s: ['r0', 0, 100, null, null],
    longest_segment_duration_s: ['r0', 0, 100, null, null],
    shortest_segment_duration_s: ['r0', 0, 100, null, null],
    climax_position_pct: ['r0', 0, 100, null, null],
    has_climax_segment: ['r0', 0, 100, null, null],
    hook_to_climax_gap_s: ['r0', 0, 100, null, null],
    duration_s: ['r0', 0, 100, null, null],
    title_char_count: ['r0', 0, 100, null, null],
    title_word_count: ['r0', 0, 100, null, null],
    title_question_flag: ['r0', 0, 100, null, null],
    title_exclamation_flag: ['r0', 0, 100, null, null],
    title_number_flag: ['r0', 0, 100, null, null],
    scene_change_rate: ['r0', 0, 100, null, null],
    unique_scene_ratio: ['r0', 0, 100, null, null],
    visual_technique_count_mean: ['r0', 0, 100, null, null],
    close_up_frame_pct: ['r0', 0, 100, null, null],
    hand_presence_frame_pct: ['r0', 0, 100, null, null],
    motion_word_frame_pct: ['r0', 0, 100, null, null],
    hook_retention_pct: ['r0', 0, 100, null, null],
    retention_25pct: ['r0', 0, 100, null, null],
    retention_50pct: ['r0', 0, 100, null, null],
    retention_75pct: ['r0', 0, 100, null, null],
    retention_90pct: ['r0', 0, 100, null, null],
    final_5pct_retention: ['r_last5pct', 95, 100, null, null],
    hook_drop_rate: ['r_hook', 0, 10, null, null],
    hook_word_count: ['r_hook', 0, 10, null, null],
    has_hook_segment: ['r_hook', 0, 10, null, null],
    hook_duration_s: ['r_hook', 0, 10, null, null],
    early_momentum: ['r_early', 10, 25, null, null],
    view_accel_7day: ['r_week1', null, null, 0, 7],
    week1_week2_ratio: ['r_week1_2', null, null, 0, 14],
};

// ── Zygarnik resolution registration ──
for (const fam of ZYGARNIK_FAMILIES) {
    for (const measure of ['count', 'density']) {
        INDICATOR_RESOLUTION_MAP[`${fam}_${measure}`] = ['r0', 0, 100, null, null];
        for (const w of ZYGARNIK_EARLY_WINDOWS) {
            INDICATOR_RESOLUTION_MAP[`${fam}_${measure}_first${w}s`] =
                w <= 10 ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
        }
    }
}
for (const k of ZYGARNIK_SPECIAL_KEYS) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}
for (const k of [
    'open_loop_density_mid', 'closure_density_mid', 'story_stake_density_first_quarter',
    'visual_proof_density_hook', 'reference_callback_density_mid',
    'pre_gratification_open_loop_count', 'stake_introduction_position_pct',
    'proof_density_post_midpoint', 'callback_before_payoff_flag',
    'delayed_gratification_peak_position_pct',
]) {
    INDICATOR_RESOLUTION_MAP[k] = ['r0', 0, 100, null, null];
}
for (const k of [
    'rhetorical_question_count', 'rhetorical_question_density',
    'rhetorical_question_front_load_ratio', 'rhetorical_question_count_hook',
    'social_comparison_count', 'social_comparison_density',
    'social_comparison_count_first_half', 'social_comparison_hook_count',
    'transformation_arc_count', 'transformation_arc_density',
    'transformation_arc_count_first_half', 'transformation_arc_hook_count',
    'loss_framing_count', 'loss_framing_density',
    'loss_framing_count_hook', 'loss_framing_count_first_half',
    'mystery_setup_count', 'mystery_setup_density',
    'mystery_setup_count_hook', 'mystery_setup_front_load_ratio',
    'promise_specificity_count', 'promise_specificity_density',
    'promise_specificity_count_hook', 'promise_specificity_front_load_ratio',
    'pattern_interrupt_count', 'pattern_interrupt_density',
    'pattern_interrupt_count_hook', 'pattern_interrupt_count_first_half',
    'viewer_stakes_count', 'viewer_stakes_density',
    'viewer_stakes_count_hook', 'viewer_stakes_front_load_ratio',
]) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}
// Group S resolution map
for (const k of [
    'social_proof_count', 'social_proof_density',
    'social_proof_count_hook', 'social_proof_front_load_ratio',
    'curiosity_gap_count', 'curiosity_gap_density',
    'curiosity_gap_count_hook', 'curiosity_gap_front_load_ratio',
    'emotional_peak_count', 'emotional_peak_density',
    'emotional_peak_count_hook', 'emotional_peak_count_first_half',
    'commitment_device_count', 'commitment_device_density',
    'commitment_device_count_hook', 'commitment_device_count_first_quarter',
    'proof_of_work_count', 'proof_of_work_density',
    'proof_of_work_count_hook', 'proof_of_work_front_load_ratio',
    'future_self_count', 'future_self_density',
    'future_self_count_hook', 'future_self_count_first_half',
    'failure_vulnerability_count', 'failure_vulnerability_density',
    'failure_vulnerability_count_hook', 'failure_vulnerability_count_first_half',
    'action_trigger_count', 'action_trigger_density',
    'action_trigger_count_hook', 'action_trigger_count_last_quarter',
    'loop_resolution_ratio', 'promise_density_first_third',
    'emotional_arc_peak_pct', 'curiosity_resolution_gap_pct',
    'hook_phrase_diversity', 'social_proof_before_midpoint_count',
    'proof_of_work_before_claim_ratio',
]) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}
// Group S windowed variant resolution map
for (const fam of ['social_proof', 'curiosity_gap', 'emotional_peak', 'proof_of_work', 'failure_vulnerability']) {
    for (const w of [2, 3, 5, 8, 10, 15, 20]) {
        for (const variant of ['count', 'density']) {
            INDICATOR_RESOLUTION_MAP[`${fam}_${variant}_first${w}s`] = ['r_hook', 0, 10, null, null];
        }
    }
}
// Group T resolution map
for (const k of [
    'reference_callback_count', 'reference_callback_density',
    'reference_callback_count_hook', 'reference_callback_front_load_ratio',
    'visual_credibility_count', 'visual_credibility_density',
    'visual_credibility_count_hook', 'visual_credibility_front_load_ratio',
    'payoff_signal_count', 'payoff_signal_density',
    'payoff_signal_count_hook', 'payoff_signal_count_last_quarter',
    'setup_signal_count', 'setup_signal_density',
    'setup_signal_count_hook', 'setup_signal_front_load_ratio',
    'stakes_escalation_count', 'stakes_escalation_density',
    'stakes_escalation_count_mid', 'stakes_escalation_count_first_half',
    'proof_arrival_count', 'proof_arrival_density',
    'proof_arrival_count_hook', 'proof_arrival_position_pct',
    'narrative_anchor_count', 'narrative_anchor_density',
    'narrative_anchor_count_first_half', 'narrative_anchor_count_last_quarter',
    'delayed_reveal_count', 'delayed_reveal_density',
    'delayed_reveal_count_hook', 'delayed_reveal_front_load_ratio',
    'setup_to_payoff_signal_gap_pct', 'proof_arrival_timing_pct',
    'delayed_reveal_to_payoff_ratio', 'visual_credibility_before_claim_ratio',
    'reference_callback_rate_per_min', 'stakes_escalation_mid_density',
    'narrative_anchor_peak_pct', 'delayed_reveal_setup_ratio',
]) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}
// Group T windowed variant resolution map
for (const fam of ['reference_callback', 'visual_credibility', 'payoff_signal', 'setup_signal', 'stakes_escalation', 'proof_arrival', 'narrative_anchor', 'delayed_reveal']) {
    for (const w of [2, 3, 5, 8, 10, 15, 20]) {
        for (const variant of ['count', 'density']) {
            INDICATOR_RESOLUTION_MAP[`${fam}_${variant}_first${w}s`] = ['r_hook', 0, 10, null, null];
        }
    }
}
// Group V resolution map
for (const k of [
    'early_proof_count', 'early_proof_density',
    'early_proof_count_hook', 'early_proof_front_load_ratio', 'early_proof_count_first_half',
    'social_signal_count', 'social_signal_density',
    'social_signal_count_hook', 'social_signal_front_load_ratio',
    'pre_upload_credibility_count', 'pre_upload_credibility_density',
    'pre_upload_credibility_count_hook', 'pre_upload_credibility_front_load_ratio', 'pre_upload_credibility_position_pct',
]) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}
// Group V windowed variant resolution map
for (const fam of ['early_proof', 'social_signal', 'pre_upload_credibility']) {
    for (const w of [2, 3, 5, 8, 10, 15, 20]) {
        for (const variant of ['count', 'density']) {
            INDICATOR_RESOLUTION_MAP[`${fam}_${variant}_first${w}s`] = ['r_hook', 0, 10, null, null];
        }
    }
}

const DEFAULT_RESOLUTION_DEFS = {
    r0: { id: 'r0', label: 'Full Video', description: 'Entire video analyzed as one unit.', start_pct: 0, end_pct: 100, start_day: null, end_day: null, granularity: 'whole' },
    r_last5pct: { id: 'r_last5pct', label: 'Last 5% of Video', description: 'Final 5 percent of video.', start_pct: 95, end_pct: 100, start_day: null, end_day: null, granularity: 'video_window' },
    r_hook: { id: 'r_hook', label: 'Hook Window (0-10%)', description: 'First 10 percent of video.', start_pct: 0, end_pct: 10, start_day: null, end_day: null, granularity: 'video_window' },
    r_early: { id: 'r_early', label: 'Early Window (10-25%)', description: 'Post-hook momentum window.', start_pct: 10, end_pct: 25, start_day: null, end_day: null, granularity: 'video_window' },
    r_week1: { id: 'r_week1', label: 'First 7 Days', description: 'First 7 days post-upload.', start_pct: null, end_pct: null, start_day: 0, end_day: 7, granularity: 'time_window' },
    r_week1_2: { id: 'r_week1_2', label: 'Days 0-14', description: 'First two weeks post-upload.', start_pct: null, end_pct: null, start_day: 0, end_day: 14, granularity: 'time_window' },
};

function getResolutionForKey(key) {
    if (INDICATOR_RESOLUTION_MAP[key]) return INDICATOR_RESOLUTION_MAP[key];
    let m;
    m = key.match(/^retention_pct_(\d+)$/);
    if (m) {
        const n = parseInt(m[1]);
        if (n <= 10) return ['r_hook', 0, 10, null, null];
        if (n >= 95) return ['r_last5pct', 95, 100, null, null];
        return [`r_pct_${n}_${n}`, n, n, null, null];
    }
    m = key.match(/^retention_(?:mean|slope|volatility)_(\d+)_(\d+)$/);
    if (m) {
        const lo = parseInt(m[1]), hi = parseInt(m[2]);
        if (lo === 0 && hi === 100) return ['r0', 0, 100, null, null];
        if (hi <= 10) return ['r_hook', 0, 10, null, null];
        if (lo >= 95) return ['r_last5pct', 95, 100, null, null];
        return [`r_pct_${lo}_${hi}`, lo, hi, null, null];
    }
    m = key.match(/^views_log_days_(\d+)_(\d+)$/);
    if (m) return [`r_days_${m[1]}_${m[2]}`, null, null, parseInt(m[1]), parseInt(m[2])];
    m = key.match(/^views_ratio_(\w+)_vs_(\w+)$/);
    if (m) {
        const ri = DAILY_VIEWS_RATIOS.find(r => r[0] === m[1] && r[1] === m[2]);
        if (ri) {
            const endDay = Math.max(ri[3], ri[5]);
            return [`r_days_0_${endDay}`, null, null, 0, endDay];
        }
    }
    return ['r0', 0, 100, null, null];
}


module.exports = {
    // Stats
    mean, std, variance, linregress, pearsonr, spearmanr, skew,
    // Metrics
    extractMetric, getMetricDefinition, getCandidateLayer,
    // Candidates
    DEFAULT_CANDIDATES, generateAutonomousCandidates,
    canonicalizeKey, validateCandidate, biasPool,
    // Composite helpers
    isCompositeKey, parseCompositeKey,
    // Resolution
    INDICATOR_RESOLUTION_MAP, DEFAULT_RESOLUTION_DEFS, getResolutionForKey,
    // Constants
    RETENTION_POINTS, RETENTION_WINDOWS, DAILY_VIEWS_WINDOWS, DAILY_VIEWS_RATIOS,
    INTERACTION_BASES, STATIC_KEYS,
};
