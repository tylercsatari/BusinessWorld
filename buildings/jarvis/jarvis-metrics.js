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

const CHALLENGE_STATEMENT_PHRASES = [
    "let's see if", "let's see how", "let's find out", 'let me see if',
    'let me find out', 'can i', 'can we', 'i want to see if',
    'i want to find out', 'the goal is', 'my goal is', 'the challenge is',
    'my challenge', 'my mission is', 'i decided to', 'i am going to try',
    "i'm going to try", "i'm going to see", 'what happens if', 'what happens when',
    'what would happen', 'the question is', 'the big question', 'i wonder if',
    'i set out to', 'the experiment', 'my experiment', "i'm testing",
    'i tested', 'i tried to', 'i attempted', 'i set a goal',
    'i gave myself', 'i challenged myself', 'challenge accepted',
];

const NARRATIVE_TENSION_PHRASES = [
    'i was nervous', 'i was scared', 'i was worried', 'not sure if',
    "i didn't know if", "i didn't expect", "i wasn't sure",
    'the scary part', 'the hard part', "but here's the problem",
    'the problem was', "but there's a catch", "there's a catch",
    "what i didn't know", "what i didn't realize",
    'little did i know', 'i had no idea', 'i had no clue',
    'out of nowhere', 'and then suddenly', 'and then it happened',
    'everything changed', 'something happened', 'then things got',
    'the twist is', "here's the twist", 'but then', 'and then',
    "and that's when", "that's when i", 'this is when',
];

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
        'but first', 'wait for it', 'in a moment', 'before that', 'not yet',
        'almost', 'soon', 'more on that later', 'we will get to', 'i will show you',
        'hold that thought', 'remember this', 'keep that in mind',
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
        'i had to', 'i needed to', 'had to figure out', 'or i would', 'changed everything',
        'turned everything around', 'biggest risk', 'scary moment', 'nerve-wracking',
        'was terrified', 'bet everything', 'could not afford to fail', 'what was at stake',
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
    challenge_statement: CHALLENGE_STATEMENT_PHRASES,
    narrative_tension: NARRATIVE_TENSION_PHRASES,
    tension_builder: [
        "one thing led to another", "things escalated", "it got complicated",
        "it started simple", "and then something changed", "that is when things shifted",
        "started to realize", "began to notice", "something was off",
        "it kept building", "pressure was mounting", "tension was building",
        "stakes kept rising", "it was not going to be easy", "challenge after challenge",
        "obstacle after obstacle", "every step was harder", "the further i got",
        "deep into this", "committed now", "no way back",
        "it got crazy", "things got intense", "it was not going well",
        "that is when things got", "halfway through", "i was struggling",
        "this was harder than", "i almost gave up", "push through",
        "keep going", "not gonna stop", "not giving up", "something went wrong",
        "problem after problem", "it was brutal", "i could barely",
        "this is where it gets bad", "and that is when", "by the time i",
        "i kept going", "deep into the challenge", "by hour", "by day",
        "by step", "nothing was working", "i was starting to",
        "i was running out", "started falling apart", "it was getting worse",
        "the pressure was", "i hit a wall", "things were not going",
    ],
    implicit_promise: [
        "what you are about to see", "this is where it gets good",
        "the part that matters", "here is what most people miss",
        "what nobody mentions", "the thing i wish i knew",
        "the real answer", "the actual reason", "the truth behind",
        "here is the real story", "what actually happened", "the full picture",
        "what changed everything", "the moment that mattered",
        "the insight that unlocked it", "the piece that makes it all make sense",
        "once i understood this", "when i finally got it", "the missing piece",
        "you will want to see this", "you are going to want to know this",
        "wait until you see", "you will not believe", "stick around for",
        "keep watching", "i need to show you", "here is the thing",
        "here is what happened", "what i found out", "the result might",
        "this surprised me", "something unexpected", "what came next",
        "you need to see this", "i have to show you", "here is what i",
        "what i discovered", "i did not expect", "i was not ready",
        "this blew my mind", "you are not going to believe", "honestly",
        "i had no idea", "spoiler", "this changes things",
        "turned out better than i", "worked out better than",
        "better than i expected", "better than i thought",
        "better than i imagined", "more than i expected",
        "more than i thought", "actually surprised me",
        "honestly surprised me", "not what i expected",
        "not what i thought", "something really cool",
        "something amazing happened", "something incredible",
        "something really interesting", "i noticed something",
        "i noticed two", "i noticed something really",
        "i discovered something", "i found something",
    ],
    progressive_reveal: [
        "first", "then", "after that", "and then", "next",
        "step one", "step two", "step three", "part one", "part two",
        "the first thing", "the second thing", "the third thing",
        "phase one", "phase two", "level one", "level two",
        "starting with", "beginning with", "working up to",
        "building toward", "getting closer to", "almost at",
        "next step", "the next thing", "following that",
        "once that was done", "moving on", "after finishing",
        "having done that", "first thing i did", "then i",
        "so then", "and after that", "the next part",
        "step by step", "one by one", "first up", "next up",
        "to start", "to begin", "now i", "now we",
        "what happened next", "what came next", "at that point",
    ],
    loop_reinforcer: [
        "remember when i said", "going back to", "as i mentioned",
        "like i showed you", "earlier i told you", "i said earlier",
        "you may recall", "as promised", "here is what i promised",
        "now back to", "let me come back to", "returning to",
        "circling back", "full circle", "this connects to",
        "this is related to what", "this ties back to",
        "now this makes sense because", "now you can see why",
        "like i said", "remember", "going back to", "earlier i",
        "i told you", "i said this would", "and there it is",
        "told you so", "just like i expected", "exactly what i thought",
        "see what i mean", "just as i said", "which is why i said",
        "that is exactly what", "remember at the start", "this is why",
        "which brings us back", "and that is what i meant",
        "you see", "you see when", "that is why i", "which is why",
        "and that is why", "and that is the reason", "that is for a reason",
        "that is because", "the reason for that", "the reason i",
        "now you understand", "now it makes sense", "which explains why",
        "so that is why", "and so that is", "this is the reason",
        "this is because", "and this is because", "which is because",
        "the thing about", "the thing is", "now the thing",
        "what i mean", "what i mean is", "what that means",
        "and what that means", "so what that means",
        "which made sense because", "that makes sense because",
        "which is exactly why", "and that is exactly why",
        "for a reason you", "there is a reason", "there was a reason",
        "that's because", "that's why", "that's for a reason",
        "that's the reason", "there's a reason", "that's what i",
        "and that's why", "and that's because", "and that's for",
        "it's because", "it's the reason", "which is why i",
        "you see", "you know why", "you know what",
        "now you", "now this", "and now", "so now",
        "as you can see", "as you saw", "as i said",
        "i mentioned", "i talked about", "i showed",
    ],
    consequence_language: [
        "because of this", "which means", "so this means",
        "what this means for you", "the implication is", "the consequence",
        "what that leads to", "which led to", "which caused",
        "the result was", "what followed was", "from that point",
        "after that everything", "that is why", "that is the reason",
        "this is why it matters", "this is what happens when",
        "here is what this means", "and because of that",
        "the impact was", "the effect was",
        "so that means", "which is why", "because of that",
        "and that caused", "and that led to", "so then",
        "which then", "so naturally", "obviously that meant",
        "of course", "no wonder", "that is why i",
        "and so", "and that is when", "which means that",
        "so if you", "that meant", "as a result",
        "and that is because", "so what happened was",
    ],
    setup_anchor: [
        "picture this", "imagine", "here is the scenario",
        "here is the situation", "so here is what happened",
        "let me set the scene", "let me give you some context",
        "a bit of background", "here is some context",
        "the backstory is", "to understand this you need to know",
        "before we get into it", "to give you the full picture",
        "starting from the beginning", "from the very start",
        "it all started when", "this whole thing began",
        "the origin of this", "how it all began",
        "so basically", "here is the deal", "okay so",
        "so the thing is", "let me explain", "so i wake up",
        "it started when", "so this all began", "here is how it happened",
        "so what happened was", "basically what happened", "so the story is",
        "okay so basically", "so here is the deal", "alright so",
        "so the situation was", "let me tell you what happened",
        "here is where we are", "to understand what happened",
        "so here is what i did", "here is the background",
        "so i", "so i decided", "so i bought", "so i built",
        "so i started", "so i got", "so naturally i",
        "so what i did", "so my plan", "so the plan",
        "so i had", "so i needed", "so i came up with",
        "so i figured", "so of course", "so as you know",
        "so when i", "so now that", "so at this point",
        "since i was", "since this was", "since it was",
        "since i had", "given that", "with that in mind",
    ],
    outcome_tease: [
        "the number surprised me", "the result was unexpected",
        "i was shocked by", "i could not believe", "what i found was",
        "what the data showed was", "the experiment revealed",
        "it turned out", "turns out", "here is what we discovered",
        "the finding was", "what we learned was", "what surprised us",
        "the most interesting thing", "the most surprising result",
        "the key finding", "the headline result", "the bottom line result",
        "what it all came down to", "the final answer", "the verdict was",
        "to find out", "to see what happens", "what would happen",
        "i wanted to know", "i needed to find out", "so we tested",
        "the question was", "could it", "would it", "can i",
        "is it possible", "i wondered if", "to test this",
        "to see if it would", "to see if i could", "to figure out",
        "what happens when", "i wanted to see what", "i had to know",
        "i set out to find", "the goal was to see",
    ],
    proof_signal: [
        "i have the receipts", "here is the proof", "the evidence shows",
        "the numbers show", "here are the numbers", "the data confirms",
        "verified this", "tested this", "ran the experiment",
        "here is what happened when i", "i compared", "side by side",
        "the before and after", "measured this", "tracked this",
        "documented everything", "recorded it all", "the logs show",
        "actual results not estimates", "real numbers not guesses",
        "i can show you exactly", "hard evidence",
    ],

    // ── Group AB: Expectation-subversion / Knowledge-gap / Momentum / Suspense-bridge ──
    expectation_subversion: [
        "you would think", "most people think", "conventional wisdom says",
        "everyone assumes", "the popular belief is", "what you were taught",
        "what most people believe", "the common assumption", "you might expect",
        "logically you would expect", "the obvious answer seems", "at first glance",
        "on the surface it looks", "most experts say", "the standard advice is",
        "what they teach you", "the traditional approach", "the old way of thinking",
        "that is actually backwards", "completely wrong about",
    ],
    knowledge_gap: [
        "most people do not know", "nobody tells you", "what they never teach you",
        "the secret nobody mentions", "what most miss", "hidden from most",
        "rarely talked about", "almost no one knows", "kept secret",
        "what the top people know", "insider knowledge", "the thing they do not tell you",
        "what i wish i had known", "if only i had known", "the gap nobody fills",
        "what gets left out", "the missing piece most overlook", "buried in",
        "not obvious at first", "you have to dig to find",
    ],
    momentum_language: [
        "and then", "suddenly", "at that point", "from there", "everything changed",
        "that is when", "then it hit me", "next thing i knew", "before i knew it",
        "one thing led to the next", "and it kept going", "momentum built",
        "it snowballed", "from that moment", "that was the turning point",
        "and it got faster", "rapidly", "at a certain point", "without warning",
        "in no time", "almost immediately", "before long",
        "let's go", "let's do this", "here we go", "and we are off",
        "starting now", "so here we go", "diving in", "jumping right in",
        "getting into it", "moving on to", "now for the", "on to the next",
        "i went for it", "i just went", "so i did it", "i decided to go",
        "no going back now", "let us do it", "doing it now",
        "kicking things off", "getting started", "off we go",
        "time to", "let us see", "time to find out",
    ],
    suspense_bridge: [
        "but here is the thing", "here is where it gets interesting",
        "that is when i realized", "what nobody expected", "here is the twist",
        "and this is the part that gets crazy", "but wait", "and then everything changed",
        "which brings me to the most important part", "this is where it gets good",
        "now here is the interesting bit", "but here is what surprised me",
        "this is the part most people skip", "and that is not even the best part",
        "here is what blew my mind", "which leads to something even bigger",
        "and here is the kicker", "this is the part nobody expects",
        "hold on because this gets better", "and the answer will surprise you",
    ],

    // ── Group AC: Identity-challenge / Before-after-frame / FOMO / Mechanism-reveal ──
    identity_challenge: [
        "if you are like most people", "you might be making this mistake",
        "most creators do this wrong", "are you still doing this",
        "if you have been struggling with", "you have probably been told",
        "chances are you have tried", "if this sounds familiar",
        "you might recognize this", "does this sound like you",
        "are you guilty of this", "you might be falling into this trap",
        "this is probably why you", "if you ever wondered why",
        "i used to be exactly like this", "i made this mistake too",
        "this was my problem for years", "i understand this because i lived it",
        "if you watch this and cringe", "you will see yourself in this",
    ],
    before_after_frame: [
        "before i knew this", "i used to", "looking back i can see",
        "before everything changed", "the old version of me", "i used to think",
        "i used to believe", "before i figured this out", "before i understood",
        "in the beginning i", "when i first started", "back when i had no idea",
        "back then i did not know", "that was before i learned", "a year ago i",
        "six months ago i", "before this click", "the transformation started when",
        "i was in your position", "once upon a time",
        "before this i", "after this i", "before versus after",
        "before and after", "what a difference", "the transformation was",
        "look at the difference", "compared to before", "then vs now",
        "day one versus", "starting vs ending", "where i started",
        "where i ended up", "from the beginning to now", "night and day",
        "completely different from", "not even close to", "you would not recognize",
        "the change was", "how much it changed", "i went from",
        "this is what i look like", "this is what it looks like",
        "this is what they look like", "look like before", "looked like before",
        "what it looked like", "looked before", "before and after",
        "this is how it looked", "this is what happened to",
        "what happened to my", "compared to now", "since starting",
        "after doing this", "after trying", "after the challenge",
        "before the challenge", "the difference is", "see the difference",
        "here is the result", "here is the before",
        "looked like", "looks like now", "what they looked", "what it looked",
        "this is what", "this is what i looked", "what i look like",
        "end result looked", "how it turned out", "how they turned out",
        "how i ended up", "what i ended up", "what ended up",
        "starting point", "end point", "the end result",
        "before the", "after the", "before doing", "after doing",
        "before starting", "after finishing", "before i started", "after i finished",
    ],
    fomo_signal: [
        "while you wait", "others are already", "every day you do not",
        "you are falling behind", "the ones who acted", "everyone else is doing this",
        "meanwhile other people", "while most people sit around",
        "the early movers", "those who started already", "the window is closing",
        "time sensitive", "do not wait on this", "the longer you wait",
        "you will wish you had done this sooner", "by the time most people realize",
        "they are not waiting for", "the gap is widening", "the opportunity will not",
        "act now before",
    ],
    mechanism_reveal: [
        "the reason this works", "the mechanism is", "what actually drives this",
        "the underlying cause", "why this actually works", "the root cause",
        "here is the physics of it", "the real reason behind", "this works because",
        "it comes down to", "the core of it is", "fundamentally this is about",
        "at its heart", "stripped down this is", "the engine behind",
        "what makes this tick", "the why behind the what", "here is the mechanism",
        "the principle that makes this work", "the science behind",
    ],

    // ── Group AD: Authority-stack / Narrative-stakes-escalation / Payoff-proximity ──
    authority_stack: [
        "after testing with", "from studying", "based on all my data",
        "having done this myself", "in all my years", "over a decade of",
        "from all the data i have collected", "after hundreds of", "having worked with",
        "from my research into", "based on my experiments", "my track record shows",
        "i have verified this", "i have replicated this", "i have seen this",
        "across all my testing", "from every test i ran", "every single time",
        "consistent across", "reproducible results",
    ],
    narrative_stakes_escalation: [
        "the stakes got higher", "it was not just about", "now it was about",
        "suddenly it mattered more", "the consequences were bigger", "more was on the line",
        "everything was on the line", "this had real consequences", "this could cost",
        "the risk was real", "there was no safety net", "point of no return",
        "could not go back", "all in", "committed completely",
        "the pressure increased", "i had to figure this out", "failure was not an option",
        "the clock was ticking", "time was running out",
        "everything depended on", "this had to work", "failure meant",
        "if this failed", "the stakes were", "i had to succeed",
        "no turning back", "all or nothing", "my whole plan",
        "this was the moment", "this was it", "make or break",
        "do or die", "everything on the line", "i had invested",
        "i spent so much", "i put everything", "this was my chance",
        "i could not afford to", "there was too much at stake",
        "this really mattered", "it meant everything",
        "no matter what", "wasn't gonna stop me", "that wasn't gonna stop",
        "i had to keep", "i had to keep going", "i kept going",
        "i had no choice", "i had to do it", "i needed to",
        "i needed to do this", "i could not stop", "i would not stop",
        "i refused to", "i was determined", "i was not going to give up",
        "i could not quit", "i had to finish", "i had to make it",
        "no way was i", "there was no way i was", "i was not about to",
        "too far in to stop", "too much invested", "could not back down",
        "this meant too much", "this was too important", "absolutely had to",
    ],
    payoff_proximity: [
        "almost there", "getting close", "nearly done", "just a few more",
        "we are so close", "one more step", "the final piece", "right on the verge",
        "so close to the answer", "nearly at the end", "just around the corner",
        "not long now", "almost at the reveal", "coming up very soon",
        "in just a moment", "stay with me", "keep watching", "almost ready to show you",
        "the payoff is coming", "you are about to see this",
    ],

    // ── Group AE: Loop stacking — multiple simultaneous open questions in hook ──
    loop_stacking: [
        "but first", "hold on", "wait but", "one more thing", "before i get to that",
        "and another thing", "also remember", "oh and", "by the way though",
        "not to mention", "on top of that", "which reminds me", "speaking of which",
        "but also", "there is also", "and on top of that", "plus there is",
        "before we continue", "but before that", "first though", "quick thing first",
        "one quick note", "there is something else", "another thing i should mention",
        "and this is important too", "keep that in mind because",
        "also i should say", "oh also", "and another thing",
        "but before i do", "there is more to this", "and get this",
        "but here is the other thing", "and the crazy thing is",
        "oh wait", "hold up", "actually wait", "oh one more thing",
        "but the other part", "and i also", "i should also mention",
        "and there is also", "i almost forgot", "quick note though",
    ],

    // ── Group AF: Deferred reveal — explicit temporal deferral creating open loops ──
    deferred_reveal: [
        "i will explain later", "we will get to that", "more on that in a second",
        "i will tell you why", "stay tuned for", "coming up", "in a few minutes",
        "at the end", "before the end", "i promise i will show you",
        "stick around for", "at the end of this", "i will reveal",
        "the answer is coming", "i will get to that", "save that for later",
        "we will come back to that", "hold that thought", "do not go anywhere",
        "i will explain in a moment", "more on this shortly", "we will unpack that",
        "details coming up", "i will break it down", "the full story is coming",
        "you will see why", "it will make sense soon", "all will be revealed",
        "not yet", "not quite yet", "almost there", "getting close",
        "soon you will see", "wait for it", "in a moment", "coming up next",
        "in just a second", "you will see why", "i promise it is worth it",
        "just wait", "hold on a second", "bear with me", "not quite",
        "we are getting there", "almost ready", "just a little longer",
        "i will show you at the end", "worth the wait", "you will want to see this",
        "a few days later", "a few hours later", "later that day", "the next day",
        "eventually", "after a while", "after some time", "by this point",
        "at this point i", "at the end", "by the end", "at the end of the",
        "so when i finally", "when i finally", "finally i", "finally i was",
        "the moment finally", "the time finally", "it was finally time",
        "so i finally", "i could finally", "i was finally able",
        "once i", "once i was done", "once i had", "once it was done",
        "once that was done", "once it was ready", "when it was done",
        "when it was ready", "when it was finally", "when it was all",
    ],

    teaser_signal: [
        'coming up', 'coming up next', 'wait until you see', 'wait until',
        'before i show you', "i'll show you", 'what you are about to see',
        "what you're about to see", 'stay tuned', 'stick around', 'keep watching',
        'watch until the end', 'by the end of this', 'at the end',
        'at the end of this', 'before the end', "i'll reveal", 'i will reveal',
        "i'll share", "i'll tell you", "i'll explain", 'the reveal is coming',
        'big reveal', 'the surprise',
        'so i decided', 'i had an idea', 'what if i', 'i wanted to see',
        'i had to try', 'i needed to test', 'challenge accepted',
        'the plan was', 'my goal was', 'here is what i did',
        'so here is the thing', 'so what did i do', 'i came up with',
        'i thought of', 'i had a plan', 'the idea was',
        'so my plan', 'so i thought', 'and i thought',
        'i figured', 'so i figured', 'i got the idea',
        'i had this idea', 'what if we', 'so we decided',
    ],
    anticipation_escalation: [
        'it gets better', 'even better', 'but wait', "but that's not all",
        'and it gets worse', "and here's where", "now here's the thing",
        'wait there\'s more', 'and this is just the beginning',
        "but here's the best part", "here's the crazy part", "here's the thing",
        'and then it gets', 'this is where it gets', 'now watch what happens',
        'and then something', 'the crazy thing is', "here's what's wild",
        'and get this', "and here's the kicker",
        'it only gets better', 'it gets more interesting', 'but that is not all',
        'there is more', 'oh and', 'but here is the thing',
        'here is where it gets crazy', 'this is where it gets good',
        'it gets even better', 'and here is the twist', 'hold on',
        'it just keeps getting', 'you have not even heard the best part',
        'and then', 'but then', 'and then something happened',
        'but here is what is crazy', 'oh wait it gets better',
        'keep watching because', 'this is not even the good part yet',
    ],
    proof_delay: [
        "i'll show you later", "you'll see", 'by the end of this video',
        'stick around for', 'keep watching to see', 'wait for the reveal',
        'the proof is coming', "here's what happened", 'the results are',
        'and the answer is', 'the final result', 'and the final',
        'to see if it works', 'the outcome', "i'll let you know",
        'more on that later', "we'll see", 'stay for the results',
        'results at the end', 'check out the results', 'the ending surprised me',
        'before i show you', 'first let me', 'to understand why',
        'you need to know first', 'here is some context', 'a little background',
        'to get there first', 'setting this up', 'i will explain in a second',
        'but first', 'first i need to', 'before i get into',
        'before we get to', 'let me first explain', 'give me a second',
        'i need to show you something first', 'real quick though',
        'but before i show you', 'here is why this matters first',
        'before we see the result', 'you need context first',
        'to see if it', 'to see how', 'to see what', 'to find out if',
        'to test if', 'to test whether', 'in order to', 'in order to find',
        'in order to see', 'in order to test', 'the next thing i had to',
        'before testing', 'before i could', 'before doing that',
        'now since', 'since this', 'now because', 'because this',
        'the first step was', 'the first thing was', 'step one was',
        'i started by', 'i began by', 'starting with this',
    ],
    open_question_setup: [
        'have you ever', 'did you know', 'what if i told you', 'what if you could',
        'what would happen if', 'could you', 'would you', 'have you tried',
        'do you think', 'do you know', 'can you guess', 'guess what',
        'you know what', 'want to know', 'want to see', 'want to find out',
        'curious about', 'ever wonder', 'ever wondered', 'i had a question',
        'the question everyone asks', 'one question changed', 'this one question',
        'what if', 'what would you do', 'what do you think', 'how do you',
        'have you noticed', 'have you thought about', 'did you ever',
        'can you imagine', 'imagine if', 'what happens when', 'why does',
        'why do', 'how would', 'could this', 'is this possible',
        'would this work', 'can this be done', 'i wonder if',
        'does this work', 'how does', 'what is the best way',
        'would you believe', 'think about this', 'consider this',
        'to see if it', 'to see how it', 'to see what would',
        'to see what happens', 'to see how long', 'to see how far',
        'to see how many', 'to see how much', 'to see if this',
        'to see if they', 'to see if i could', 'to see if we',
        'let me see if', 'let me see how', 'let me find out',
        'to find out', 'to find out if', 'to find out how',
        'to figure out', 'to figure out if', 'to figure out how',
        'wondering if', 'wondering whether', 'wondering how',
        'to test it', 'to test them', 'to test this out',
    ],
    visual_anchor: [
        'look at this', 'check this out', 'here it is', 'see this',
        'take a look', 'look right here', 'right here', 'see right here',
        'look at these', 'look at these numbers', 'check these numbers',
        'see these results', 'here are the results', 'as you can see here',
        'look at what happened', "here's what it looks like", 'see what i mean',
        'you can see', 'notice how', 'see how',
        'watch this', 'look', 'look here', 'see here', 'right there',
        'look how', 'look what', 'watch what', 'check it out',
        'see that', 'look at that', 'i am showing you', 'here you can see',
        'look at the screen', 'on screen', 'right on the screen',
        'literally right here', 'do you see', 'can you see that',
        'look at this number', 'see this result', 'look what happened',
        'watch closely', 'see what happens', 'here is what it looks like',
    ],

    // ── Group AJ: New zygarnik/open-loop families ──────────────────────────
    zygarnik_open_loop: [
        'have you ever wondered', 'the question is', 'but why', 'here is what i don',
        'that raises the question', 'which begs the question', 'i still don',
        'nobody knows why', 'the mystery is', 'what i cannot figure out',
        'i kept asking myself', 'the answer is not obvious', 'there is no clear answer',
        'it is complicated', 'hard to explain', 'i am not sure why',
        'the weird thing is', 'that is the strange part', 'still not sure',
        'what i want to know', 'the question i keep asking', 'this is puzzling',
        'i cannot explain why', 'it does not make sense', 'that is strange',
        'here is the question', 'what is going on', 'why would', 'how is it that',
        'what i cannot figure', 'this raises a question', 'i need to understand',
        'the part i do not get', 'i am still figuring out', 'nobody told me why',
        'the answer was not clear', 'i was confused about', 'unclear to me',
        'i wonder', 'wondered if', 'i wondered', 'i wanted to find out',
        'i wanted to know', 'i wanted to see if', 'i wanted to see what',
        'i want to see', 'i want to find out', 'i want to know',
        'to see if', 'to find out', 'to see what', 'to see how',
        'what would happen', 'what happens when', 'what would happen if',
        'if it would', 'whether it would', 'could i', 'could it',
        'is it possible', 'would it work', 'can i actually',
        'i had to find out', 'i needed to know', 'i needed to find',
        'i had a question', 'the big question', 'the real question',
    ],

    gratification_delay_phrase: [
        'not gonna tell you yet', 'you will find out', 'saving this for later',
        'the reveal is coming', 'you will have to wait', 'spoiler at the end',
        'watch until the end', 'stay to the end', 'keep watching',
        'hold that thought', 'but first', 'before the answer',
        'before i reveal', 'the answer comes later', 'i will show you at the end',
        'i am not telling you yet', 'saving the best for last', 'the big moment is coming',
        'you have to watch to find out', 'stick with me', 'trust the process',
        'i will get to the good stuff', 'building up to something',
        'you will see in a minute', 'keep watching for the answer',
        'the payoff is at the end', 'worth sticking around for',
        'do not skip ahead', 'all will be revealed', 'the ending is worth it',
        'but first i had to', 'first i needed', 'first i had to',
        'before that though', 'before we get there', 'before that happens',
        'not yet though', 'not quite there yet', 'a few days later',
        'a few hours later', 'later that day', 'the next day',
        'finally', 'eventually', 'after a while', 'after some time',
        'after that', 'by this point', 'at this point i',
        'getting close now', 'almost at the good part',
        'the moment i had been waiting for', 'and then finally',
        'it was all leading to', 'everything leading up to',
    ],

    story_stake_signal: [
        'this cost me', 'i paid', 'i spent', 'i risked', 'i bet',
        'everything i had', 'months of work', 'weeks building', 'days preparing',
        'my own money', 'personal challenge', 'i have been training',
        'been working on this', 'i sacrificed', 'it was not cheap',
        'this took forever', 'countless hours', 'i put everything into',
        'my own time', 'my own resources', 'out of pocket', 'i funded this',
        'i invested in', 'i put in so much', 'i gave up', 'i stayed up',
        'i woke up early', 'i worked hard', 'i trained for',
        'i practiced for', 'i prepared for', 'i dedicated', 'i committed to',
        'i went all in', 'this was not free', 'it cost a lot', 'i paid a lot',
        'so much time', 'so much effort', 'so much work went into',
        'i bought', 'i built', 'i made', 'i created', 'i designed',
        'i 3d printed', 'i started training', 'i started building',
        'i started working', 'months of training', 'weeks of training',
        'days of training', 'hours of', 'spent hours', 'spent days',
        'spent weeks', 'spent months', 'took weeks', 'took days',
        'took months', 'took forever', 'it took so long',
        'this was expensive', 'this was not easy to build',
        'this took a lot', 'i put a lot of', 'a lot of work went into',
        'way more work than', 'harder to make than', 'harder to build than',
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
    'see what happens', 'i can show you', 'let me show you', 'here you can see',
    'take a look at', 'look at how', 'see how', 'i am showing you', 'showing you',
    'on screen', 'on the screen', 'right on screen', 'screenshot', 'chart shows',
    'data shows', 'graph shows', 'numbers show', 'the stats', 'the data',
    'the results show', 'here is the proof', 'proof right here', 'evidence',
    'as shown here', 'visible here', 'look here', 'see here', 'right there',
];
const PAYOFF_SIGNAL_PHRASES = [
    'here is the result', 'heres what happened', 'and the answer is', 'so the answer is',
    'here it is', 'that is the secret', 'turns out the answer', 'so what actually happened',
    'the reveal is', 'and it worked', 'here are the results', 'and this is it',
    'so here is what', 'and this is what', 'the outcome was',
    'here is what happened', 'what happened was', 'what actually happened',
    'so what happened', 'the answer', 'the result', 'the results',
    'turns out', 'it turns out', 'it worked', 'it actually worked',
    'so here is the thing', 'here is the thing', 'and here is why',
    'this is the result', 'this is what happened', 'this is why',
    'so this is', 'and this is', 'here is', 'so i found', 'i found out',
    'what i found', 'what i discovered', 'the secret is', 'the key is',
    'the reason is', 'the answer was', 'the result was', 'the outcome',
    'so the result', 'the final result', 'end result', 'in the end',
    'ultimately', 'what i learned', 'what i realized', 'the conclusion',
    'to summarize', 'bottom line', 'the bottom line', 'long story short',
];
const SETUP_SIGNAL_PHRASES = [
    'in this video i will', 'what i am going to show', 'by the end of this video',
    'today i will show', 'i am going to prove', 'let me show you exactly',
    'what you are about to see', 'this is how i', 'i am going to walk you through',
    'today we will cover', 'in this video i am', 'what i will show you',
    'by the end of this', 'i will walk you through', 'today i am going to',
    'in this video', 'today i', 'in todays video', 'in today', 'i will show',
    'i am going to', 'we are going to', 'what i will', 'what we will',
    'i will be showing', 'i will be walking', 'i will be covering',
    'i want to show you', 'i want to walk you', 'i want to cover',
    'i want to talk about', 'today we are', 'in this tutorial',
    'in this guide', 'this video is about', 'this video will',
    'welcome to', 'hey guys', 'hey everyone', 'what is up', 'whats up',
    'so today', 'so in this', 'alright so', 'alright today',
    'okay so today', 'in just a moment', 'by the time', 'before the end',
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
    'this is where it gets', 'here is the part', 'here is when', 'and this is the moment',
    'that was the moment', 'this is the point', 'this is exactly when', 'right at that moment',
    'here is the thing that happened', 'this is the scene', 'and here is where',
    'so this is the moment', 'that is when i knew', 'and right there',
    'at that exact moment', 'in that moment', 'this happened right', 'so here we are',
    'this is the part where', 'right here is where', 'and this is it',
    'this is the situation', 'this is what happened at', 'here is where things',
];
const DELAYED_REVEAL_PHRASES = [
    'i will tell you in a second', 'keep watching', 'before i tell you', 'but first',
    'hold on', 'just wait', 'in just a moment', 'i will get to that', 'the answer is coming',
    'stay with me', 'bear with me', 'i will explain in a moment', 'before i show you',
    'i will reveal that', 'but before that',
    'i will get to', 'i will explain', 'more on that', 'more on this',
    'we will get to that', 'we will cover that', 'coming up', 'later in this video',
    'later in the video', 'stay tuned', 'hang on', 'hold that thought',
    'first let me', 'first i need to', 'before we get to',
    'before we get into', 'before i get into', 'before i get to',
    'but before i', 'before we dive in', 'before we dive into',
    'i will get back to', 'i need to first', 'first things first',
    'first i want to', 'let me first', 'let me start by',
    'i will show you that', 'trust me', 'just keep watching',
    'you need to see this first', 'this is important',
    'stick around', 'do not go anywhere', 'do not leave',
    'wait for it', 'the answer is later', 'spoiler alert',
    'i will save that for', 'the reveal comes', 'not telling you yet',
    'saving this for', 'you will find out', 'i am holding off',
    'going to show you soon', 'real quick before that', 'one sec',
    'hold tight', 'just a second', 'give me a moment',
    'almost ready to show', 'not yet though', 'patience',
    'i am getting there', 'we are getting there', 'almost to the good part',
    'this is building up to', 'this is all leading to',
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

const PRE_UPLOAD_MECHANISM_PHRASES = [
    'how i did it', 'the method', 'the process', 'step by step', 'here is how',
    'the technique', 'the system', 'what i used', 'the approach', 'here is the secret',
    'the formula', 'the framework', 'this is how', 'the strategy', 'the blueprint',
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
    // Group Z: New structural zygarnik/challenge/tension metrics
    'challenge_setup_density_first_quarter',
    'narrative_tension_density_first_half',
    'answer_withhold_density_first_third',
    'payoff_delay_score',
    'loop_front_half_density',
    'resolution_density_second_half',
    'challenge_to_resolution_gap_pct',
    // Group AA: New zygarnik structural metrics
    'zygarnik_completion_ratio',
    'stakes_in_hook_flag',
    'payoff_before_midpoint_flag',
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
    'retention_entropy', 'hook_drop_rate',
    'non_sub_view_share', 'swipe_away_rate', 'like_rate',
    'unique_word_ratio',
    'title_word_count',
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
    // Removed LLM-dependent: setup_duration_pct, payoff_position_pct
    'hook_open_loop_density', 'hook_closure_density',
    // New Group A indicators (removed LLM-dependent: hook_payoff_gap, narrative_arc_completeness, action_frame_pct)
    'end_recovery_score', 'max_silence_gap_s', 'opening_speech_rate_3s',
    // New Group B indicators (removed LLM-dependent: visual_stake_frame_pct)
    'open_loop_to_closure_ratio', 'zygarnik_tension_peak_pct', 'early_proof_position_pct',
    'hook_stake_density', 'setup_payoff_ratio', 'resolution_density',
    'closure_rate_per_min', 'tension_arc_score', 'pre_payoff_open_loop_density',
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
    // (Removed segment-transcript metrics: open_loop_density_mid, closure_density_mid, etc.)
    'delayed_gratification_density',
    'reference_callback_density',
    'visual_proof_density',
    'story_stake_density',
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
    // Group Z bases (challenge/tension structural)
    'challenge_statement_count', 'challenge_statement_density',
    'narrative_tension_count', 'narrative_tension_density',
    'payoff_delay_score',
    'challenge_to_resolution_gap_pct',
    'loop_front_half_density',
    'answer_withhold_density_first_third',
    'narrative_tension_density_first_half',
    'challenge_setup_density_first_quarter',
    // New transcript-language bases
    'pivot_word_count', 'sensory_word_density', 'motif_recurrence_score',
    'beat_density_per_minute', 'escalation_slope', 'title_curiosity_gap_score',
    // Group V2: Windowed Group U bases (early-window curiosity/cliffhanger/revelation)
    'curiosity_escalation_count_first2s', 'curiosity_escalation_count_first3s',
    'curiosity_escalation_count_first5s', 'curiosity_escalation_count_first8s',
    'curiosity_escalation_count_first10s', 'curiosity_escalation_count_first15s',
    'curiosity_escalation_count_first20s',
    'curiosity_escalation_density_first5s', 'curiosity_escalation_density_first10s',
    'cliffhanger_count_first2s', 'cliffhanger_count_first3s',
    'cliffhanger_count_first5s', 'cliffhanger_count_first8s',
    'cliffhanger_count_first10s', 'cliffhanger_count_first15s',
    'cliffhanger_count_first20s',
    'revelation_signal_count_first2s', 'revelation_signal_count_first3s',
    'revelation_signal_count_first5s', 'revelation_signal_count_first8s',
    'revelation_signal_count_first10s', 'revelation_signal_count_first15s',
    'revelation_signal_count_first20s',
    'payoff_tease_count_first2s', 'payoff_tease_count_first3s',
    'payoff_tease_count_first5s', 'payoff_tease_count_first8s',
    'payoff_tease_count_first10s', 'payoff_tease_count_first15s',
    'payoff_tease_count_first20s',
    'stakes_reinforcement_count_first2s', 'stakes_reinforcement_count_first5s',
    'stakes_reinforcement_count_first10s', 'stakes_reinforcement_count_first15s',
    'stakes_reinforcement_count_first20s',
    'viewer_agency_count_first5s', 'viewer_agency_count_first10s',
    'viewer_agency_count_first15s', 'viewer_agency_count_first20s',
    // Group V2: Windowed Group R bases
    'rhetorical_question_count_first3s', 'rhetorical_question_count_first5s',
    'rhetorical_question_count_first8s', 'rhetorical_question_count_first10s',
    'rhetorical_question_count_first15s', 'rhetorical_question_count_first20s',
    'social_comparison_count_first3s', 'social_comparison_count_first5s',
    'social_comparison_count_first10s', 'social_comparison_count_first15s',
    'mystery_setup_count_first3s', 'mystery_setup_count_first5s',
    'mystery_setup_count_first10s', 'mystery_setup_count_first15s',
    'mystery_setup_count_first20s',
    'viewer_stakes_count_first3s', 'viewer_stakes_count_first5s',
    'viewer_stakes_count_first10s', 'viewer_stakes_count_first15s',
    'loss_framing_count_first5s', 'loss_framing_count_first10s',
    'loss_framing_count_first15s',
    // Group V2 extended: more window sizes for top families
    'curiosity_escalation_count_first25s', 'curiosity_escalation_count_first30s',
    'curiosity_escalation_count_first45s', 'curiosity_escalation_count_first60s',
    'curiosity_escalation_density_first2s', 'curiosity_escalation_density_first3s',
    'curiosity_escalation_density_first8s', 'curiosity_escalation_density_first15s',
    'curiosity_escalation_density_first20s',
    'cliffhanger_count_first25s', 'cliffhanger_count_first30s',
    'cliffhanger_count_first45s', 'cliffhanger_count_first60s',
    'cliffhanger_density_first5s', 'cliffhanger_density_first10s',
    'cliffhanger_density_first15s', 'cliffhanger_density_first20s',
    'revelation_signal_count_first25s', 'revelation_signal_count_first30s',
    'revelation_signal_count_first45s', 'revelation_signal_count_first60s',
    'revelation_signal_density_first5s', 'revelation_signal_density_first10s',
    'revelation_signal_density_first15s', 'revelation_signal_density_first20s',
    'payoff_tease_count_first25s', 'payoff_tease_count_first30s',
    'payoff_tease_count_first45s', 'payoff_tease_count_first60s',
    'payoff_tease_density_first5s', 'payoff_tease_density_first10s',
    'payoff_tease_density_first15s', 'payoff_tease_density_first20s',
    'stakes_reinforcement_count_first25s', 'stakes_reinforcement_count_first30s',
    'stakes_reinforcement_count_first45s', 'stakes_reinforcement_count_first60s',
    'stakes_reinforcement_density_first5s', 'stakes_reinforcement_density_first10s',
    'stakes_reinforcement_density_first15s', 'stakes_reinforcement_density_first20s',
    'viewer_agency_count_first2s', 'viewer_agency_count_first3s',
    'viewer_agency_count_first8s', 'viewer_agency_count_first25s',
    'viewer_agency_count_first30s',
    'viewer_agency_density_first5s', 'viewer_agency_density_first10s',
    'viewer_agency_density_first15s', 'viewer_agency_density_first20s',
    // Group V2 extended: more Group R windows
    'rhetorical_question_count_first2s', 'rhetorical_question_count_first25s',
    'rhetorical_question_count_first30s',
    'rhetorical_question_density_first5s', 'rhetorical_question_density_first10s',
    'rhetorical_question_density_first15s',
    'social_comparison_count_first2s', 'social_comparison_count_first8s',
    'social_comparison_count_first20s', 'social_comparison_count_first25s',
    'social_comparison_density_first5s', 'social_comparison_density_first10s',
    'mystery_setup_count_first2s', 'mystery_setup_count_first25s',
    'mystery_setup_count_first30s',
    'mystery_setup_density_first5s', 'mystery_setup_density_first10s',
    'mystery_setup_density_first15s',
    'viewer_stakes_count_first2s', 'viewer_stakes_count_first8s',
    'viewer_stakes_count_first20s', 'viewer_stakes_count_first25s',
    'viewer_stakes_density_first5s', 'viewer_stakes_density_first10s',
    'loss_framing_count_first2s', 'loss_framing_count_first3s',
    'loss_framing_count_first20s', 'loss_framing_count_first25s',
    'loss_framing_count_first30s',
    'loss_framing_density_first5s', 'loss_framing_density_first10s',
    'promise_specificity_count_first3s', 'promise_specificity_count_first5s',
    'promise_specificity_count_first8s', 'promise_specificity_count_first10s',
    'promise_specificity_count_first15s', 'promise_specificity_count_first20s',
    'promise_specificity_count_first25s',
    'promise_specificity_density_first5s', 'promise_specificity_density_first10s',
    'transformation_arc_count_first3s', 'transformation_arc_count_first5s',
    'transformation_arc_count_first8s', 'transformation_arc_count_first10s',
    'transformation_arc_count_first15s', 'transformation_arc_count_first20s',
    'transformation_arc_count_first25s',
    'transformation_arc_density_first5s', 'transformation_arc_density_first10s',
    // Group W2: New ratio metrics
    // NOTE: early_curiosity_escalation_ratio and revelation_front_load_ratio removed from INTERACTION_BASES
    // because they return null for ~90%+ of videos (zero denominator: curiosity_escalation_count=0 or
    // revelation_signal_count=0 for most shorts). Every cross-product with them fails, causing max_failures
    // on every run. They remain in STATIC_KEYS as standalone indicators.
    'cliffhanger_front_load_ratio',
    'curiosity_to_closure_ratio',
    'loop_payoff_density_gap', 'revelation_to_cliffhanger_ratio',
    'payoff_tease_to_delivery_ratio',
    // Group AA: New phrase-family bases (tension_builder / implicit_promise / progressive_reveal / loop_reinforcer / consequence_language / setup_anchor / outcome_tease / proof_signal)
    'tension_builder_count', 'tension_builder_density',
    'implicit_promise_count', 'implicit_promise_density',
    'progressive_reveal_count', 'progressive_reveal_density',
    'loop_reinforcer_count', 'loop_reinforcer_density',
    'consequence_language_count', 'consequence_language_density',
    'setup_anchor_count', 'setup_anchor_density',
    'outcome_tease_count', 'outcome_tease_density',
    'proof_signal_count', 'proof_signal_density',
    // Windowed variants for top-priority families
    'tension_builder_count_first5s', 'tension_builder_count_first10s', 'tension_builder_count_first15s', 'tension_builder_count_first20s',
    'tension_builder_density_first5s', 'tension_builder_density_first10s',
    'implicit_promise_count_first5s', 'implicit_promise_count_first10s', 'implicit_promise_count_first15s', 'implicit_promise_count_first20s',
    'implicit_promise_density_first5s', 'implicit_promise_density_first10s',
    'progressive_reveal_count_first5s', 'progressive_reveal_count_first10s', 'progressive_reveal_count_first20s',
    'loop_reinforcer_count_first5s', 'loop_reinforcer_count_first10s', 'loop_reinforcer_count_first15s',
    'consequence_language_count_first5s', 'consequence_language_count_first10s', 'consequence_language_count_first15s',
    'consequence_language_density_first10s',
    'outcome_tease_count_first5s', 'outcome_tease_count_first10s', 'outcome_tease_count_first15s',
    'outcome_tease_density_first10s',
    'proof_signal_count_first5s', 'proof_signal_count_first10s', 'proof_signal_count_first15s', 'proof_signal_count_first20s',
    'proof_signal_density_first5s', 'proof_signal_density_first10s',
    'setup_anchor_count_first5s', 'setup_anchor_count_first10s', 'setup_anchor_count_first15s',
    // Group AJ: New zygarnik/open-loop families
    'zygarnik_open_loop_count', 'zygarnik_open_loop_density',
    'zygarnik_open_loop_front_load_ratio', 'zygarnik_open_loop_count_first_half',
    'zygarnik_open_loop_count_first5s', 'zygarnik_open_loop_count_first10s',
    'zygarnik_open_loop_count_first15s', 'zygarnik_open_loop_count_first20s',
    'gratification_delay_phrase_count', 'gratification_delay_phrase_density',
    'gratification_delay_phrase_front_load_ratio', 'gratification_delay_phrase_count_first_half',
    'gratification_delay_phrase_count_first5s', 'gratification_delay_phrase_count_first10s',
    'gratification_delay_phrase_count_first15s', 'gratification_delay_phrase_count_first20s',
    'story_stake_signal_count', 'story_stake_signal_density',
    'story_stake_signal_front_load_ratio', 'story_stake_signal_count_first_half',
    'story_stake_signal_count_first5s', 'story_stake_signal_count_first10s',
    'story_stake_signal_count_first15s', 'story_stake_signal_count_first20s',
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
    'hook_word_count', 'question_count',
    'keep_x_non_sub_share',
    // Pre-upload: transcript
    'transcript_char_count', 'avg_word_length', 'unique_word_ratio',
    'sentence_count', 'exclamation_count', 'uppercase_word_ratio',
    'hook_question_count', 'hook_word_ratio', 'hook_char_count',
    'transcript_number_count',
    // Pre-upload: metadata
    'duration_s', 'title_char_count', 'title_word_count',
    'title_question_flag', 'title_exclamation_flag', 'title_number_flag',
    // Group U: Cliffhanger / payoff-tease / stakes-reinforcement / viewer-agency / revelation-signal / curiosity-escalation
    'cliffhanger_count', 'cliffhanger_density', 'cliffhanger_first_half_count', 'cliffhanger_hook_count',
    'payoff_tease_count', 'payoff_tease_density', 'payoff_tease_first_half_count', 'payoff_tease_hook_count',
    'stakes_reinforcement_count', 'stakes_reinforcement_density', 'stakes_reinforcement_first_half_count', 'stakes_reinforcement_hook_count',
    'viewer_agency_count', 'viewer_agency_density', 'viewer_agency_first_half_count', 'viewer_agency_hook_count',
    'revelation_signal_count', 'revelation_signal_density', 'revelation_signal_first_half_count', 'revelation_signal_hook_count',
    'curiosity_escalation_count', 'curiosity_escalation_density', 'curiosity_escalation_first_half_count', 'curiosity_escalation_hook_count',
    // Group V: Early proof / social signal / pre-upload credibility / pre-upload mechanism
    'early_proof_count', 'early_proof_density', 'early_proof_count_hook', 'early_proof_front_load_ratio', 'early_proof_count_first_half',
    'social_signal_count', 'social_signal_density', 'social_signal_count_hook', 'social_signal_front_load_ratio',
    'pre_upload_credibility_count', 'pre_upload_credibility_density', 'pre_upload_credibility_count_hook', 'pre_upload_credibility_front_load_ratio', 'pre_upload_credibility_position_pct',
    'pre_upload_mechanism_count', 'pre_upload_mechanism_density', 'pre_upload_mechanism_count_hook', 'pre_upload_mechanism_front_load_ratio', 'pre_upload_mechanism_position_pct',
    'reference_to_gratification_ratio', 'setup_to_payoff_gap',
    // New transcript-language metrics
    'pivot_word_count', 'sensory_word_density', 'motif_recurrence_score',
    'beat_density_per_minute', 'escalation_slope', 'title_curiosity_gap_score',
    // Group AH bases: New zygarnik phrase families (teaser/anticipation/proof-delay/open-question/visual-anchor)
    'teaser_signal_count', 'teaser_signal_density',
    'teaser_signal_front_load_ratio',
    'anticipation_escalation_count', 'anticipation_escalation_density',
    'anticipation_escalation_front_load_ratio',
    'proof_delay_count', 'proof_delay_density',
    'proof_delay_front_load_ratio',
    'open_question_setup_count', 'open_question_setup_density',
    'open_question_setup_front_load_ratio',
    'visual_anchor_count', 'visual_anchor_density',
    'visual_anchor_front_load_ratio',
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
    hook_word_count: 'pre', question_count: 'pre',
    transcript_char_count: 'pre', avg_word_length: 'pre', unique_word_ratio: 'pre',
    sentence_count: 'pre', exclamation_count: 'pre', uppercase_word_ratio: 'pre',
    hook_question_count: 'pre', hook_word_ratio: 'pre', hook_char_count: 'pre',
    transcript_number_count: 'pre',
    duration_s: 'pre', title_char_count: 'pre', title_word_count: 'pre',
    title_question_flag: 'pre', title_exclamation_flag: 'pre', title_number_flag: 'pre',
    pivot_word_count: 'pre', sensory_word_density: 'pre', motif_recurrence_score: 'pre',
    beat_density_per_minute: 'pre', escalation_slope: 'pre', title_curiosity_gap_score: 'pre',
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
// Hook and front-load ratio variants for all Zygarnik phrase families
for (const fam of ZYGARNIK_FAMILIES) {
    for (const variant of ['count_hook', 'front_load_ratio']) {
        const k = `${fam}_${variant}`;
        STATIC_KEYS.add(k);
        STATIC_LAYER[k] = 'pre';
    }
}

// ── New Group A indicators ──
// Removed LLM-dependent: hook_payoff_gap, narrative_arc_completeness, action_frame_pct
for (const k of ['max_silence_gap_s', 'opening_speech_rate_3s']) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}
STATIC_KEYS.add('end_recovery_score');
STATIC_LAYER['end_recovery_score'] = 'post';

// ── New Group B indicators ──
// Removed LLM-dependent: visual_stake_frame_pct
for (const k of ['open_loop_to_closure_ratio', 'zygarnik_tension_peak_pct', 'early_proof_position_pct',
    'hook_stake_density', 'setup_payoff_ratio', 'resolution_density',
    'closure_rate_per_min', 'tension_arc_score', 'pre_payoff_open_loop_density']) {
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
    'first_payoff_position_pct',
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
for (const fam of ['reference_callback', 'visual_credibility', 'payoff_signal', 'setup_signal', 'stakes_escalation', 'proof_arrival', 'narrative_anchor', 'delayed_reveal', 'early_proof', 'social_signal', 'pre_upload_credibility', 'pre_upload_mechanism', 'teaser_signal', 'anticipation_escalation', 'proof_delay', 'open_question_setup', 'visual_anchor']) {
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

// ── New Group X: pre-upload mechanism / reference-to-gratification / setup-to-payoff ──
for (const k of [
    'pre_upload_mechanism_count', 'pre_upload_mechanism_density',
    'pre_upload_mechanism_count_hook', 'pre_upload_mechanism_front_load_ratio', 'pre_upload_mechanism_position_pct',
    'reference_to_gratification_ratio', 'setup_to_payoff_gap',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── Group W2: Curiosity/closure ratios — have extractMetric implementations but were missing from STATIC_KEYS ──
for (const k of [
    'revelation_front_load_ratio',
    'curiosity_to_closure_ratio',
    'loop_payoff_density_gap',
    'revelation_to_cliffhanger_ratio',
    'payoff_tease_to_delivery_ratio',
    'early_curiosity_escalation_ratio',
    'cliffhanger_front_load_ratio',
]) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── hook_payoff_gap / hook_to_payoff_gap_pct — have extractMetric implementations (transcript-based fallback),
//    previously removed from STATIC_KEYS as 'LLM-dependent' but are now transcript-based. ──
for (const k of ['hook_payoff_gap', 'hook_to_payoff_gap_pct']) {
    STATIC_KEYS.add(k);
    STATIC_LAYER[k] = 'pre';
}

// ── Group V2/W2 windowed phrase-family variants — STATIC_KEYS fix ─────────────────────────────
// These families are listed in INTERACTION_BASES and have extractMetric implementations,
// but their windowed firstNs variants were missing from STATIC_KEYS, causing composite
// candidates to get NO_DEF → processIndicator returns null → max_failures.
for (const fam of [
    'curiosity_escalation', 'cliffhanger', 'revelation_signal', 'payoff_tease',
    'stakes_reinforcement', 'viewer_agency', 'rhetorical_question', 'social_comparison',
    'mystery_setup', 'viewer_stakes', 'loss_framing', 'promise_specificity', 'transformation_arc',
    // All other ZYGARNIK families that need hook/ratio variants in STATIC_KEYS
    'open_loop', 'closure', 'unresolved_ref', 'temporal_anticipation', 'contrast',
    'superlative', 'action_verb', 'sensory', 'imperative', 'outcome_ref',
    'suspense', 'identity_hook', 'social_proof', 'scarcity', 'pattern_interrupt',
    'foreshadow', 'stakes_high', 'credibility_signal', 'reward_language', 'loss_aversion',
    'urgency', 'delayed_gratification', 'reference_callback', 'visual_proof', 'story_stake',
    'transformation', 'vulnerability', 'specificity_anchor', 'micro_commitment', 'emotional_peak',
    'revelation_pace', 'social_contrast', 'anticipatory_build', 'tension_ratchet', 'promise_echo',
    'story_clock', 'proof_build',
]) {
    for (const w of [2, 3, 5, 8, 10, 15, 20, 25, 30, 45, 60]) {
        const ck = `${fam}_count_first${w}s`;
        STATIC_KEYS.add(ck);
        STATIC_LAYER[ck] = 'pre';
    }
    for (const w of [2, 3, 5, 8, 10, 15, 20, 25]) {
        const dk = `${fam}_density_first${w}s`;
        STATIC_KEYS.add(dk);
        STATIC_LAYER[dk] = 'pre';
    }
    // Extended variants now backed by _zyExtRe dispatch
    for (const sfx of ['count_hook','density_hook','front_load_ratio','count_first_half','density_first_half','position_pct']) {
        const k = `${fam}_${sfx}`;
        STATIC_KEYS.add(k);
        STATIC_LAYER[k] = 'pre';
    }
}

// ── Group AB/AC/AD windowed phrase-family variants — STATIC_KEYS registration ──────────────────
// New families added in Groups AB/AC/AD; register their base + windowed variants so
// the AutoRun system can compute them without NO_DEF failures.
for (const fam of [
    // Group AB
    'expectation_subversion', 'knowledge_gap', 'momentum_language', 'suspense_bridge',
    // Group AC
    'identity_challenge', 'before_after_frame', 'fomo_signal', 'mechanism_reveal',
    // Group AD
    'authority_stack', 'narrative_stakes_escalation', 'payoff_proximity',
    // Group AA (challenge_statement / narrative_tension were missing from V2/W2 loop)
    'challenge_statement', 'narrative_tension',
    // Group AA phrase families — hook/ratio/first_half variants now backed by _zyExtRe dispatch
    'tension_builder', 'implicit_promise', 'progressive_reveal', 'loop_reinforcer',
    'consequence_language', 'setup_anchor', 'outcome_tease', 'proof_signal',
]) {
    const baseCount = `${fam}_count`;
    const baseDensity = `${fam}_density`;
    STATIC_KEYS.add(baseCount);   STATIC_LAYER[baseCount]   = 'pre';
    STATIC_KEYS.add(baseDensity); STATIC_LAYER[baseDensity] = 'pre';
    for (const w of [2, 3, 5, 8, 10, 15, 20, 25]) {
        const ck = `${fam}_count_first${w}s`;
        const dk = `${fam}_density_first${w}s`;
        STATIC_KEYS.add(ck); STATIC_LAYER[ck] = 'pre';
        STATIC_KEYS.add(dk); STATIC_LAYER[dk] = 'pre';
    }
    // Hook-slice variants
    const hookCount   = `${fam}_count_hook`;
    const hookDensity = `${fam}_density_hook`;
    const frontLoad   = `${fam}_front_load_ratio`;
    const firstHalf   = `${fam}_count_first_half`;
    const firstHalfD  = `${fam}_density_first_half`;
    const posPct      = `${fam}_position_pct`;
    STATIC_KEYS.add(hookCount);   STATIC_LAYER[hookCount]   = 'pre';
    STATIC_KEYS.add(hookDensity); STATIC_LAYER[hookDensity] = 'pre';
    STATIC_KEYS.add(frontLoad);   STATIC_LAYER[frontLoad]   = 'pre';
    STATIC_KEYS.add(firstHalf);   STATIC_LAYER[firstHalf]   = 'pre';
    STATIC_KEYS.add(firstHalfD);  STATIC_LAYER[firstHalfD]  = 'pre';
    STATIC_KEYS.add(posPct);      STATIC_LAYER[posPct]      = 'pre';
}

// ── get_metric_definition ────────────────────────────────────────────────

// Detailed definitions for non-phrase static keys.
// Every entry documents: what inputs are read, what computation happens, what comes out.
const DETAILED_DEFS = {
    // ── Post-upload: retention curve ──
    hook_retention_pct:       { d: 'Audience retention at the 10% mark of the video — proportion of viewers still watching.', f: 'retentionCurve[10].retention', s: ['analytics.retentionCurve'], r: '0 to 2.0' },
    final_5pct_retention:     { d: 'Average retention over the last 5 data points of the retention curve.', f: 'mean(retentionCurve[-5:].retention)', s: ['analytics.retentionCurve'], r: '0 to 2.0' },
    mid_video_cliff:          { d: 'Maximum single-step drop in the retention curve — the worst cliff.', f: 'max(|retentionCurve[i] - retentionCurve[i-1]|)', s: ['analytics.retentionCurve'], r: '0 to 1.0' },
    retention_entropy:        { d: 'Shannon entropy of the absolute retention values — measures flatness vs spikiness.', f: 'H = -sum(p_i * log2(p_i)) where p_i = |retention[i]| / sum', s: ['analytics.retentionCurve'], r: '0 to 7' },
    hook_drop_rate:           { d: 'Linear regression slope of retention over the first 10 data points — how fast viewers leave the hook.', f: 'linregress(retentionCurve[0:10]).slope', s: ['analytics.retentionCurve'], r: '-0.1 to 0.01' },
    early_momentum:           { d: 'Retention at 25% minus retention at 10% — positive = gaining viewers after hook.', f: 'retentionCurve[25].retention - retentionCurve[10].retention', s: ['analytics.retentionCurve'], r: '-0.3 to 0.3' },
    retention_25pct:          { d: 'Retention at the 25% mark.', f: 'retentionCurve[25].retention', s: ['analytics.retentionCurve'], r: '0 to 2.0' },
    retention_50pct:          { d: 'Retention at the 50% mark.', f: 'retentionCurve[50].retention', s: ['analytics.retentionCurve'], r: '0 to 2.0' },
    retention_75pct:          { d: 'Retention at the 75% mark.', f: 'retentionCurve[75].retention', s: ['analytics.retentionCurve'], r: '0 to 2.0' },
    retention_90pct:          { d: 'Retention at the 90% mark.', f: 'retentionCurve[90].retention', s: ['analytics.retentionCurve'], r: '0 to 2.0' },
    above_baseline_mean:      { d: 'Mean of (retention - linear baseline) across curve — how much viewers stay above expected linear decay.', f: 'mean(retention[i] - (1 - i/N)) for each point', s: ['analytics.retentionCurve'], r: '-0.5 to 0.5' },
    peak_count:               { d: 'Number of local peaks in the retention curve (point higher than both neighbors).', f: 'count(retention[i] > retention[i-1] AND retention[i] > retention[i+1])', s: ['analytics.retentionCurve'], r: '0 to 20' },
    drop_count:               { d: 'Number of significant drops (> 3%) in the retention curve.', f: 'count(retention[i-1] - retention[i] > 0.03)', s: ['analytics.retentionCurve'], r: '0 to 20' },
    max_peak_delta:           { d: 'Largest upward jump between consecutive retention points.', f: 'max(retention[i] - retention[i-1]) where diff > 0', s: ['analytics.retentionCurve'], r: '0 to 0.3' },
    max_drop_delta:           { d: 'Largest downward drop between consecutive retention points.', f: 'max(retention[i-1] - retention[i]) where diff > 0', s: ['analytics.retentionCurve'], r: '0 to 0.3' },
    retention_variance:       { d: 'Population variance of all retention values — measures overall curve bumpiness.', f: 'var(retentionCurve[*].retention)', s: ['analytics.retentionCurve'], r: '0 to 0.1' },
    retention_skew:           { d: 'Fisher skewness of the retention curve distribution.', f: 'skew(retentionCurve[*].retention)', s: ['analytics.retentionCurve'], r: '-3 to 3' },
    end_recovery_score:       { d: 'Retention in the last 5% minus the mean of the preceding 10% — measures end-of-video recovery.', f: 'mean(retention[95:100]) - mean(retention[85:95])', s: ['analytics.retentionCurve'], r: '-0.2 to 0.2' },
    // ── Post-upload: daily views & engagement ──
    view_accel_7day:          { d: 'Ratio of views in days 4-7 vs days 1-3 — momentum after launch.', f: 'sum(dailyViews[3:7]) / (sum(dailyViews[0:3]) + 1)', s: ['analytics.dailyViews'], r: '0 to 5' },
    week1_week2_ratio:        { d: 'Week 1 views divided by week 2 views — velocity decay.', f: 'sum(dailyViews[0:7]) / (sum(dailyViews[7:14]) + 1)', s: ['analytics.dailyViews'], r: '0 to 50' },
    non_sub_view_share:       { d: 'Non-subscriber views as a fraction of total views.', f: 'nonSubscriberViews / (subscriberViews + nonSubscriberViews)', s: ['analytics.subscriberViews', 'analytics.nonSubscriberViews'], r: '0 to 1' },
    swipe_away_rate:          { d: 'Fraction of impressions that swiped away without watching.', f: 'analytics.swipedAwayRate', s: ['analytics.swipedAwayRate'], r: '0 to 1' },
    daily_view_peak_day:      { d: 'Day number when daily views peaked (0 = upload day).', f: 'argmax(dailyViews[*].views)', s: ['analytics.dailyViews'], r: '0 to 30' },
    like_rate:                { d: 'Likes per 1000 views.', f: 'likes / (totalViews / 1000)', s: ['analytics.likes', 'analytics.totalViews'], r: '0 to 100' },
    comment_rate:             { d: 'Comments per 1000 views.', f: 'comments / (totalViews / 1000)', s: ['analytics.comments', 'analytics.totalViews'], r: '0 to 50' },
    share_rate:               { d: 'Shares per 1000 views.', f: 'shares / (totalViews / 1000)', s: ['analytics.shares', 'analytics.totalViews'], r: '0 to 50' },
    subs_gained_per_view:     { d: 'Subscribers gained per view.', f: 'subscribersGained / totalViews', s: ['analytics.subscribersGained', 'analytics.totalViews'], r: '0 to 0.01' },
    subs_per_like:            { d: 'Subscribers gained per like.', f: 'subscribersGained / (likes + 1)', s: ['analytics.subscribersGained', 'analytics.likes'], r: '0 to 1' },
    revenue_per_view:         { d: 'Estimated revenue per view.', f: 'estimatedRevenue / totalViews', s: ['analytics.estimatedRevenue', 'analytics.totalViews'], r: '0 to 0.01' },
    keep_x_non_sub_share:     { d: 'Product of keep rate and non-subscriber view share (interaction term).', f: 'swipeRatio.stayedToWatch * non_sub_view_share', s: ['analytics.swipeRatio', 'analytics.subscriberViews'], r: '0 to 1' },
    // ── Pre-upload: transcript stats ──
    duration_log:             { d: 'Log10 of video duration in seconds.', f: 'log10(metadata.duration)', s: ['metadata.duration'], r: '0 to 4' },
    transcript_word_count:    { d: 'Total word count of the full transcript.', f: 'transcript.split(/\\s+/).length', s: ['transcript.fullText'], r: '0 to 5000' },
    speech_rate_wps:          { d: 'Words per second — transcript word count divided by video duration.', f: 'word_count / duration', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 8' },
    hook_word_count:          { d: 'Word count in the hook (~first 5 seconds estimated by word index).', f: 'words[0 : ceil(N * 5/duration)].length', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 50' },
    question_count:           { d: 'Total question marks in the transcript.', f: 'count("?" in transcript)', s: ['transcript.fullText'], r: '0 to 50' },
    transcript_char_count:    { d: 'Total character count of the transcript.', f: 'transcript.length', s: ['transcript.fullText'], r: '0 to 30000' },
    avg_word_length:          { d: 'Average character length per word.', f: 'sum(word.length) / word_count', s: ['transcript.fullText'], r: '2 to 8' },
    unique_word_ratio:        { d: 'Unique words / total words — vocabulary diversity.', f: 'Set(words).size / words.length', s: ['transcript.fullText'], r: '0 to 1' },
    sentence_count:           { d: 'Number of sentences (split on . ! ?).', f: 'transcript.split(/[.!?]+/).length', s: ['transcript.fullText'], r: '0 to 300' },
    exclamation_count:        { d: 'Total exclamation marks in the transcript.', f: 'count("!" in transcript)', s: ['transcript.fullText'], r: '0 to 50' },
    uppercase_word_ratio:     { d: 'Fraction of words that are fully uppercase.', f: 'count(word === word.toUpperCase()) / word_count', s: ['transcript.fullText'], r: '0 to 0.3' },
    hook_question_count:      { d: 'Number of question marks in the hook text (~first 5 seconds by word index).', f: 'count("?" in hookText())', s: ['transcript.fullText'], r: '0 to 5' },
    hook_word_ratio:          { d: 'Hook word count / total word count.', f: 'hook_word_count / transcript_word_count', s: ['transcript.fullText'], r: '0 to 0.3' },
    hook_char_count:          { d: 'Character count of the hook text.', f: 'hookText().length', s: ['transcript.fullText'], r: '0 to 300' },
    transcript_number_count:  { d: 'Count of numeric tokens in the transcript.', f: 'count(word matches /\\d+/) in transcript', s: ['transcript.fullText'], r: '0 to 100' },
    // ── Pre-upload: metadata ──
    duration_s:               { d: 'Video duration in seconds.', f: 'metadata.duration', s: ['metadata.duration'], r: '0 to 3600' },
    title_char_count:         { d: 'Character length of the video title.', f: 'metadata.title.length', s: ['metadata.title'], r: '0 to 100' },
    title_word_count:         { d: 'Word count of the video title.', f: 'metadata.title.split(/\\s+/).length', s: ['metadata.title'], r: '0 to 20' },
    title_question_flag:      { d: 'Binary: does the title contain a question mark?', f: 'title.includes("?") ? 1 : 0', s: ['metadata.title'], r: '0 or 1' },
    title_exclamation_flag:   { d: 'Binary: does the title contain an exclamation mark?', f: 'title.includes("!") ? 1 : 0', s: ['metadata.title'], r: '0 or 1' },
    title_number_flag:        { d: 'Binary: does the title contain a number?', f: '/\\d/.test(title) ? 1 : 0', s: ['metadata.title'], r: '0 or 1' },
    pivot_word_count:         { d: "Count of narrative pivot/transition words in transcript (but, however, yet, etc.).", f: "count pivot words in transcript", s: ["transcript.fullText"], r: "0 to 50" },
    sensory_word_density:     { d: "Density of sensory/visceral words per total word count.", f: "count sensory words / word_count", s: ["transcript.fullText"], r: "0 to 0.05" },
    motif_recurrence_score:   { d: "Score measuring phrase/theme recurrence: repeated 2+ word phrases per word.", f: "recurring_phrase_count / word_count", s: ["transcript.fullText"], r: "0 to 0.02" },
    beat_density_per_minute:  { d: "Story beat transitions per minute — sentence-starters that mark new narrative beats.", f: "beat_count / estimated_minutes", s: ["transcript.fullText"], r: "0 to 20" },
    escalation_slope:         { d: "Slope of tension-word frequency across thirds of transcript (positive = escalating).", f: "(stakes_third3 - stakes_third1) / (word_count/3)", s: ["transcript.fullText", "STAKES_PHRASES"], r: "-0.1 to 0.1" },
    title_curiosity_gap_score:{ d: "Continuous curiosity-gap score for title: sum of 5 binary signals (0–5).", f: "has_question + has_number + starts_how_why_what + has_you + is_short_title", s: ["metadata.title"], r: "0 to 5" },
    // ── Pre-upload: speech & silence ──
    max_silence_gap_s:        { d: 'Longest gap (seconds) between words in the transcript — estimated from word timestamps or evenly spaced positions.', f: 'max(word[i+1].time - word[i].time) or duration-proportional estimate', s: ['transcript.words', 'metadata.duration'], r: '0 to 30' },
    opening_speech_rate_3s:   { d: 'Words per second in the first 3 seconds of the video.', f: 'words_in_first_3s / 3', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10' },
    // ── Zygarnik-derived scalars ──
    zygarnik_score:           { d: 'Composite curiosity-gap score: (open_loop_count - closure_count + unresolved_ref_count) / word_count * 1000.', f: '(open_loops - closures + unresolved_refs) / word_count * 1000', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '-5 to 20' },
    zygarnik_buildup_ratio:   { d: 'Ratio of open-loop phrases to closure phrases — high = loops opened but not closed.', f: '(open_loop_count + 1) / (closure_count + 1)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 10' },
    zygarnik_gradient_pct:    { d: 'Fraction of transcript where open loops exceed closures cumulatively — higher = sustained tension longer.', f: 'fraction_of_words_where(cumulative_opens > cumulative_closes)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 1' },
    zygarnik_front_load_ratio:{ d: 'Open-loop count in first half / second half — measures front-loading of curiosity.', f: '(open_loops_first_half + 0.01) / (open_loops_second_half + 0.01)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 10' },
    zygarnik_tension_peak_pct:{ d: 'Position in transcript (0-1) where cumulative (opens - closures) is highest.', f: 'argmax(cumulative_opens - cumulative_closes) / word_count', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 1' },
    // ── Retention-curve Zygarnik metrics ──
    retention_zygarnik_arc:   { d: 'Zygarnik-inspired arc score from retention: (drop_25_to_50 + recovery_50_to_75) / retention_25. Measures tension-release pattern.', f: '(retention[25] - retention[50] + max(0, retention[75] - retention[50])) / retention[25]', s: ['analytics.retentionCurve'], r: '0 to 2' },
    retention_recovery_ratio: { d: 'Retention at 75% / retention at 50% — measures post-midpoint recovery.', f: 'retentionCurve[75].retention / retentionCurve[50].retention', s: ['analytics.retentionCurve'], r: '0 to 2' },
    retention_late_payoff:    { d: 'Mean retention in last 25% minus mean in 50-75% range — measures end-payoff lift.', f: 'mean(retention[75:100]) - mean(retention[50:75])', s: ['analytics.retentionCurve'], r: '-0.3 to 0.3' },
    retention_pre_payoff_drop:{ d: 'Mean retention in 25-50% minus retention at 50% — measures pre-midpoint tension dip.', f: 'mean(retention[25:50]) - retention[50]', s: ['analytics.retentionCurve'], r: '-0.3 to 0.3' },
    retention_hook_to_mid_ratio:{ d: 'Retention at 10% / retention at 50% — how much the hook retains vs mid-video.', f: 'retention[10] / retention[50]', s: ['analytics.retentionCurve'], r: '0.5 to 3' },
    retention_setup_phase_mean:{ d: 'Mean retention in 0-25% range.', f: 'mean(retentionCurve[0:25].retention)', s: ['analytics.retentionCurve'], r: '0 to 2' },
    retention_open_loop_phase_mean:{ d: 'Mean retention in 25-50% range.', f: 'mean(retentionCurve[25:50].retention)', s: ['analytics.retentionCurve'], r: '0 to 2' },
    retention_payoff_phase_mean:{ d: 'Mean retention in 75-100% range.', f: 'mean(retentionCurve[75:100].retention)', s: ['analytics.retentionCurve'], r: '0 to 2' },
    retention_tension_trough_pct:{ d: 'Position (0-1) of the lowest retention value in the middle 50% of the curve.', f: 'argmin(retentionCurve[25:75].retention) / 100', s: ['analytics.retentionCurve'], r: '0.25 to 0.75' },
    retention_arc_width:      { d: 'Width (in curve points) of the largest contiguous region where retention exceeds the mean.', f: 'max_contiguous_run(retention[i] > mean_retention)', s: ['analytics.retentionCurve'], r: '0 to 100' },
    // ── Derived scalars: transcript-based ──
    open_loop_to_closure_ratio:{ d: 'Open-loop phrase count / (closure phrase count + 1) — how unresolved the content feels.', f: 'open_loop_count / (closure_count + 1)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 20' },
    hook_tension_ratio:       { d: 'Open-loop phrases minus closure phrases in the hook, divided by hook word count.', f: '(hook_open_loops - hook_closures) / hook_word_count', s: ['transcript.fullText'], r: '-0.1 to 0.2' },
    dangling_question_ratio:  { d: 'Question marks in first half / (question marks in second half + 1) — front-loaded curiosity.', f: 'questions_first_half / (questions_second_half + 1)', s: ['transcript.fullText'], r: '0 to 10' },
    countdown_flag:           { d: 'Binary: does transcript contain a countdown pattern (3,2,1 / ready set / here we go)?', f: '/3.*2.*1|countdown|ready\\s+set|here we go/.test(transcript) ? 1 : 0', s: ['transcript.fullText'], r: '0 or 1' },
    withheld_outcome_flag:    { d: 'Binary: does the hook mention an outcome that is not revealed until later?', f: '(outcome_ref in hookText AND low closure_density) ? 1 : 0', s: ['transcript.fullText'], r: '0 or 1' },
    open_loop_before_closure_flag:{ d: 'Binary: does the first open-loop phrase appear before the first closure phrase?', f: 'first_open_loop_index < first_closure_index ? 1 : 0', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 or 1' },
    open_loop_before_first_third_flag:{ d: 'Binary: does an open-loop phrase appear in the first third of the transcript?', f: 'any(open_loop_phrase in first_third_text) ? 1 : 0', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 or 1' },
    title_open_loop_flag:     { d: 'Binary: does the title contain an open-loop phrase?', f: 'any(ZYGARNIK_PHRASE_SETS.open_loop phrase in title) ? 1 : 0', s: ['metadata.title', 'ZYGARNIK_PHRASE_SETS.open_loop'], r: '0 or 1' },
    title_curiosity_gap_flag: { d: 'Binary: does the title contain a question mark OR an open-loop phrase?', f: 'title.includes("?") || open_loop_match_in_title ? 1 : 0', s: ['metadata.title'], r: '0 or 1' },
    hook_identity_flag:       { d: 'Binary: does the hook text contain an identity_hook phrase ("if you", "have you ever")?', f: 'any(IDENTITY_HOOK_PHRASES in hookText()) ? 1 : 0', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.identity_hook'], r: '0 or 1' },
    hook_specificity_score:   { d: 'Ratio of numeric tokens to total words in the hook — measures concrete specificity.', f: 'count(numbers in hookText) / hook_word_count', s: ['transcript.fullText'], r: '0 to 0.3' },
    gratification_delay_pct:  { d: 'Position (0-1) of the first delayed-gratification phrase in the transcript.', f: 'first_match_word_index(DELAYED_GRATIFICATION_PHRASES) / word_count', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.delayed_gratification'], r: '0 to 1' },
    gratification_delay_word_idx:{ d: 'Word index of the first delayed-gratification phrase match.', f: 'first_match_word_index(DELAYED_GRATIFICATION_PHRASES)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.delayed_gratification'], r: '0 to 5000' },
    promise_proof_gap_pct:    { d: 'Gap between first setup/promise phrase and first proof phrase, as fraction of transcript.', f: '(first_proof_position - first_setup_position) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    promise_proof_gap_words:  { d: 'Word distance between first setup/promise phrase and first proof phrase.', f: 'first_proof_word_idx - first_setup_word_idx', s: ['transcript.fullText'], r: '0 to 3000' },
    first_payoff_position_pct:{ d: 'Position (0-1) of the first payoff/closure phrase in the transcript.', f: 'first_match_word_index(PAYOFF_SIGNAL_PHRASES) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    proof_withheld_duration_pct:{ d: 'Position (0-1) of the first proof/result phrase — higher = proof arrives later.', f: 'first_match_char_index(NEW_PROOF_PHRASES) / transcript.length', s: ['transcript.fullText', 'NEW_PROOF_PHRASES'], r: '0 to 1' },
    proof_before_midpoint_flag:{ d: 'Binary: does a visual-proof phrase appear in the first half of the transcript?', f: 'any(VISUAL_PROOF_PHRASES in first_half_text) ? 1 : 0', s: ['transcript.fullText', 'NEW_VISUAL_PROOF_PHRASES'], r: '0 or 1' },
    setup_payoff_ratio:       { d: 'Ratio of setup-phrase density (first third) to payoff-phrase density (last third).', f: 'setup_density_first_third / (payoff_density_last_third + 0.001)', s: ['transcript.fullText'], r: '0 to 20' },
    setup_to_payoff_ratio:    { d: 'Same as setup_payoff_ratio: setup density in first third / payoff density in last third.', f: 'setup_density_first_third / (payoff_density_last_third + 0.001)', s: ['transcript.fullText'], r: '0 to 20' },
    pre_proof_tension_score:  { d: 'Product of zygarnik_score and proof-withheld duration — measures sustained tension before evidence.', f: 'zygarnik_score * proof_withheld_duration_pct', s: ['transcript.fullText'], r: '0 to 20' },
    stakes_early_flag:        { d: 'Binary: does a stakes_high phrase appear in the first 20% of the transcript?', f: 'any(STAKES_HIGH_PHRASES in first_20pct_text) ? 1 : 0', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.stakes_high'], r: '0 or 1' },
    social_contrast_hook_flag:{ d: 'Binary: does a social-contrast phrase appear in the hook text?', f: 'any(SOCIAL_CONTRAST_PHRASES in hookText()) ? 1 : 0', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.social_contrast'], r: '0 or 1' },
    transformation_arc_flag:  { d: 'Binary: does the transcript contain both a transformation phrase and a proof phrase before midpoint?', f: '(has_transformation_phrase AND proof_before_midpoint) ? 1 : 0', s: ['transcript.fullText'], r: '0 or 1' },
    vulnerability_before_proof_flag:{ d: 'Binary: does a vulnerability phrase appear before the first proof phrase?', f: 'first_vulnerability_idx < first_proof_idx ? 1 : 0', s: ['transcript.fullText'], r: '0 or 1' },
    emotional_arc_peak_pct:   { d: 'Position (0-1) of the highest emotional-peak phrase density window in the transcript.', f: 'argmax(windowed_emotional_peak_density) / word_count', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.emotional_peak'], r: '0 to 1' },
    tension_arc_score:        { d: 'Combined tension measure: open_loop_count * (1 - first_closure_position_pct) / word_count * 1000.', f: 'open_loops * (1 - first_closure_pct) / word_count * 1000', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 20' },
    tension_closure_balance:  { d: 'Signed balance: (closure_count - open_loop_count) / word_count * 1000. Positive = more closures, negative = more tension.', f: '(closures - open_loops) / word_count * 1000', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '-10 to 10' },
    closure_gap_pct:          { d: 'Gap between last open-loop and first closure as fraction of transcript — measures resolution delay.', f: '(first_closure_word_idx - last_open_loop_word_idx) / word_count', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '-1 to 1' },
    closure_rate_per_min:     { d: 'Closure phrase count divided by video duration in minutes.', f: 'closure_count / (duration / 60)', s: ['transcript.fullText', 'metadata.duration', 'ZYGARNIK_PHRASE_SETS.closure'], r: '0 to 10' },
    closure_to_open_ratio_first10s:{ d: 'Closure phrases / (open-loop phrases + 1) in the first 10 seconds.', f: 'closure_count_first10s / (open_loop_count_first10s + 1)', s: ['transcript.fullText', 'metadata.duration', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 5' },
    information_drip_ratio:   { d: 'Ratio of micro-reward phrases to open-loop phrases — measures pacing of small payoffs.', f: 'micro_reward_count / (open_loop_count + 1)', s: ['transcript.fullText'], r: '0 to 5' },
    loop_density_acceleration:{ d: 'Difference in open-loop density between second half and first half — positive = accelerating tension.', f: 'open_loop_density_second_half - open_loop_density_first_half', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS.open_loop'], r: '-0.05 to 0.05' },
    loop_resolution_ratio:    { d: 'Open-loop phrases in first half / closure phrases in second half — measures loop-to-resolution balance.', f: 'open_loops_first_half / (closures_second_half + 1)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 10' },
    loop_to_closure_gap_s:    { d: 'Estimated time gap (seconds) between first open-loop and first closure phrase.', f: '(first_closure_word_idx - first_open_loop_word_idx) * duration / word_count', s: ['transcript.fullText', 'metadata.duration', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 300' },
    sustained_tension_word_pct:{ d: 'Fraction of transcript words that fall within open-loop-active regions (between loop open and next closure).', f: 'words_in_open_loop_regions / word_count', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 1' },
    payoff_delay_score:       { d: 'Product of open-loop count and first-payoff position — high = many loops + late payoff.', f: 'open_loop_count * first_payoff_position_pct', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 50' },
    hook_phrase_diversity:    { d: 'Number of distinct phrase families present in the hook text.', f: 'count(unique_families_matching_in_hookText)', s: ['transcript.fullText'], r: '0 to 15' },
    consequence_front_weight: { d: 'Consequence-phrase density in first half / (total consequence density + 0.001).', f: 'consequence_density_first_half / (consequence_density + 0.001)', s: ['transcript.fullText', 'NEW_CONSEQUENCE_PHRASES'], r: '0 to 2' },
    credibility_setup_pct:    { d: 'Position (0-1) of first credential-signal phrase — measures how early credibility is established.', f: 'first_match_word_index(CREDENTIAL_SIGNAL_PHRASES) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    early_proof_to_loop_ratio:{ d: 'Proof phrases in first 10s / (open-loop phrases in first 10s + 1) — early evidence vs questions.', f: 'proof_count_first10s / (open_loop_count_first10s + 1)', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 5' },
    proof_arrival_delay_proxy:{ d: 'Fraction of transcript before first visual-proof phrase — higher = proof arrives later.', f: 'first_match_word_index(VISUAL_PROOF_PHRASES) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    proof_arrival_timing_pct: { d: 'Position (0-1) of first proof-arrival phrase in the transcript.', f: 'first_match_word_index(PROOF_ARRIVAL_PHRASES) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    stake_loop_product:       { d: 'Product of personal-stake density and open-loop density — measures combined tension.', f: 'personal_stake_density * open_loop_density', s: ['transcript.fullText'], r: '0 to 0.01' },
    stakes_to_loop_ratio:     { d: 'Stakes-high density / (open-loop density + 0.001) — stakes pressure relative to curiosity.', f: 'stakes_density / (open_loop_density + 0.001)', s: ['transcript.fullText', 'ZYGARNIK_PHRASE_SETS'], r: '0 to 5' },
    ref_to_gratification_gap_pct:{ d: 'Gap between first reference-callback and first delayed-gratification phrase, as fraction of transcript.', f: '(first_gratification_idx - first_callback_idx) / word_count', s: ['transcript.fullText'], r: '-1 to 1' },
    pre_payoff_tension_index: { d: 'Product of zygarnik_score and (1 - setup_duration_pct_estimate) — tension weighted by unresolved portion.', f: 'zygarnik_score * (1 - first_payoff_position_pct)', s: ['transcript.fullText'], r: '0 to 20' },
    visual_credibility_before_claim_ratio:{ d: 'Visual-credibility phrases before midpoint / total visual-credibility phrases.', f: 'visual_credibility_first_half / (visual_credibility_count + 1)', s: ['transcript.fullText'], r: '0 to 1' },
    proof_of_work_before_claim_ratio:{ d: 'Proof-of-work phrases before midpoint / total proof-of-work phrases.', f: 'proof_of_work_first_half / (proof_of_work_count + 1)', s: ['transcript.fullText'], r: '0 to 1' },
    narrative_anchor_peak_pct:{ d: 'Position (0-1) of the peak narrative-anchor phrase density window.', f: 'argmax(windowed_narrative_anchor_density) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    delayed_reveal_setup_ratio:{ d: 'Delayed-reveal phrases in first half / (setup-signal phrases in first half + 1).', f: 'delayed_reveal_first_half / (setup_signal_first_half + 1)', s: ['transcript.fullText'], r: '0 to 5' },
    delayed_reveal_to_payoff_ratio:{ d: 'Delayed-reveal density / (payoff-signal density + 0.001).', f: 'delayed_reveal_density / (payoff_signal_density + 0.001)', s: ['transcript.fullText'], r: '0 to 10' },
    setup_to_payoff_signal_gap_pct:{ d: 'Word distance from first setup-signal to first payoff-signal as fraction of transcript.', f: '(first_payoff_signal_idx - first_setup_signal_idx) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    challenge_to_resolution_gap_pct:{ d: 'Word distance from first challenge-statement to first resolution phrase as fraction of transcript.', f: '(first_resolution_idx - first_challenge_idx) / word_count', s: ['transcript.fullText'], r: '0 to 1' },
    curiosity_resolution_gap_pct:{ d: 'Gap between first curiosity phrase and first resolution/payoff phrase, as fraction of transcript.', f: '(first_payoff_pct - first_curiosity_pct)', s: ['transcript.fullText'], r: '0 to 1' },
    numeric_specificity_first_half:{ d: 'Count of numeric specificity phrases in the first half of the transcript.', f: 'countPhraseMatches(first_half_text, SPECIFICITY_PHRASES)', s: ['transcript.fullText', 'SPECIFICITY_PHRASES'], r: '0 to 30' },
    pre_upload_mechanism_count:    { d: 'Count of phrases signaling how the result was achieved — process/methodology transparency signals.', f: 'countPhraseMatches(transcript, PRE_UPLOAD_MECHANISM_PHRASES)', s: ['transcript.fullText', 'PRE_UPLOAD_MECHANISM_PHRASES'], r: '0 to 30' },
    pre_upload_mechanism_density:  { d: 'Density of process/methodology transparency phrases (count / word_count).', f: 'pre_upload_mechanism_count / word_count', s: ['transcript.fullText', 'PRE_UPLOAD_MECHANISM_PHRASES'], r: '0 to 0.1' },
    reference_to_gratification_ratio: { d: 'Ratio of reference/callback phrase count to gratification phrase count — measures callback density relative to payoff signaling.', f: 'reference_callback_count / (delayed_gratification_count + 1)', s: ['transcript.fullText', 'REFERENCE_CALLBACK_PHRASES', 'ZYGARNIK_PHRASE_SETS.delayed_gratification'], r: '0 to 10' },
    setup_to_payoff_gap:           { d: 'Word distance between first setup phrase and first payoff phrase — measures structural gap between problem and resolution.', f: 'first_payoff_word_idx - first_setup_word_idx', s: ['transcript.fullText', 'NEW_SETUP_PHRASES', 'NEW_PAYOFF_PHRASES'], r: '0 to 3000' },
    // ── Group A: Direct Analytics Reads ──
    above_baseline_area:           { d: 'Sum of max(0, retention - mean_retention) across all curve points.', f: 'sum(max(0, r.retention - mean_retention))', s: ['analytics.retentionCurve'], r: '0 to 50', layer: 'post' },
    avg_percent_viewed:            { d: 'Average percentage of video viewed per view.', f: 'analytics.avgPercentViewed', s: ['analytics.avgPercentViewed'], r: '0 to 1', layer: 'post' },
    avg_view_duration_s:           { d: 'Average view duration in seconds.', f: 'analytics.avgViewDuration', s: ['analytics.avgViewDuration'], r: '0 to 3600', layer: 'post' },
    daily_views_entropy:           { d: 'Shannon entropy of daily views distribution.', f: '-sum(p * log2(p+1e-10))', s: ['analytics.dailyViews'], r: '0 to 8', layer: 'post' },
    early_late_drop_ratio:         { d: 'Mean retention in first 10% of curve / mean in last 10% — early vs late retention.', f: 'mean(curve[0:10%]) / (mean(curve[90%:]) + 0.001)', s: ['analytics.retentionCurve'], r: '0 to 10', layer: 'post' },
    engagement_rate:               { d: 'Likes + comments divided by view count — overall engagement ratio.', f: '(likes + comments) / max(viewCount, 1)', s: ['analytics.likes', 'analytics.comments', 'metadata.viewCount'], r: '0 to 0.5', layer: 'post' },
    late_drop_severity:            { d: 'Mean retention in 50-75% minus mean in 75-100% — higher = bigger late drop.', f: 'mean(curve[50:75]) - mean(curve[75:100])', s: ['analytics.retentionCurve'], r: '-0.3 to 0.3', layer: 'post' },
    momentum_zone_length:          { d: 'Longest consecutive run of rising retention points / curve.length.', f: 'longest_rising_run / curve.length', s: ['analytics.retentionCurve'], r: '0 to 1', layer: 'post' },
    retention_concavity:           { d: 'Mean of second differences of retention curve — negative = concave down.', f: 'mean(curve[i+2] - 2*curve[i+1] + curve[i])', s: ['analytics.retentionCurve'], r: '-0.1 to 0.1', layer: 'post' },
    retention_quartile_spread:     { d: 'Std of [mean_q1, mean_q2, mean_q3, mean_q4] retention quartiles.', f: 'std([mean_q1, mean_q2, mean_q3, mean_q4])', s: ['analytics.retentionCurve'], r: '0 to 0.5', layer: 'post' },
    retention_variation_raw:       { d: 'Standard deviation of all retention values across the retention curve.', f: 'std(curve.map(p => p.retention))', s: ['analytics.retentionCurve'], r: '0 to 0.5', layer: 'post' },
    stayed_to_watch_rate:          { d: 'Fraction of impressions that stayed to watch the video.', f: 'analytics.viewedRate', s: ['analytics.viewedRate'], r: '0 to 1', layer: 'post' },
    sub_nonsub_retention_gap:      { d: 'Subscriber avg percent viewed minus non-subscriber avg percent.', f: 'subscriberAvgPercent - nonSubscriberAvgPercent', s: ['analytics.subscriberAvgPercent', 'analytics.nonSubscriberAvgPercent'], r: '-0.5 to 0.5', layer: 'post' },
    sub_view_fraction:             { d: 'Subscriber views as fraction of total views.', f: 'subscriberViews / (subscriberViews + nonSubscriberViews + 1)', s: ['analytics.subscriberViews', 'analytics.nonSubscriberViews'], r: '0 to 1', layer: 'post' },
    view_day1_share:               { d: 'Day 1 views as fraction of total daily views.', f: 'daily[0].views / (sum_daily + 1)', s: ['analytics.dailyViews'], r: '0 to 1', layer: 'post' },
    view_week3_week1_ratio:        { d: 'Week 3 views (days 14-21) divided by week 1 views (days 0-7).', f: 'sum(daily[14:21]) / (sum(daily[0:7]) + 1)', s: ['analytics.dailyViews'], r: '0 to 5', layer: 'post' },
    escalation_peak_position_pct:  { d: 'Position (0-1) of maximum retention value in the curve.', f: 'argmax(retention) / (curve.length - 1)', s: ['analytics.retentionCurve'], r: '0 to 1', layer: 'post' },
    deescalation_speed:            { d: 'Drop from retention peak to final retention value.', f: 'curve[peakIdx].retention - curve[last].retention', s: ['analytics.retentionCurve'], r: '-0.5 to 1', layer: 'post' },
    emotional_arc_swing:           { d: 'Max minus min retention across the full curve.', f: 'max(retention) - min(retention)', s: ['analytics.retentionCurve'], r: '0 to 1', layer: 'post' },
    // ── Group B: Metadata Reads ──
    description_hashtag_count:     { d: 'Count of hashtag tokens (#word) in the video description.', f: 'count(/#+\\w+/g in description)', s: ['metadata.description'], r: '0 to 30', layer: 'post' },
    description_word_count:        { d: 'Word count of the video description.', f: 'description.trim().split(/\\s+/).length', s: ['metadata.description'], r: '0 to 500', layer: 'post' },
    duration_optimal_flag:         { d: 'Binary: 1 if duration is in 45-180s sweet spot, else 0.', f: '45 <= duration <= 180 ? 1 : 0', s: ['metadata.duration'], r: '0 or 1', layer: 'post' },
    duration_sweetspot_distance:   { d: 'Absolute distance of duration from 90s sweet spot.', f: 'Math.abs(duration - 90)', s: ['metadata.duration'], r: '0 to 3500', layer: 'post' },
    upload_month:                  { d: 'Calendar month (1-12) of the video upload date.', f: 'new Date(uploadDate).getMonth() + 1', s: ['metadata.uploadDate'], r: '1 to 12', layer: 'post' },
    idea_number_flag:              { d: 'Binary: 1 if title contains a number or listicle pattern.', f: '/\\b\\d+\\b|one|two|three|five|ten/i.test(title) ? 1 : 0', s: ['metadata.title'], r: '0 or 1', layer: 'post' },
    title_avg_word_length:         { d: 'Mean character length of words in the title.', f: 'mean(title.split(/\\s+/).map(w => w.length))', s: ['metadata.title'], r: '2 to 10', layer: 'post' },
    title_compression_ratio:       { d: 'Title length divided by sqrt(word_count + 1) — density measure.', f: 'title.length / sqrt(word_count + 1)', s: ['metadata.title'], r: '0 to 30', layer: 'post' },
    title_contains_making:         { d: 'Binary: 1 if title contains word "making", else 0.', f: '/\\bmaking\\b/i.test(title) ? 1 : 0', s: ['metadata.title'], r: '0 or 1', layer: 'post' },
    title_specificity_score:       { d: 'Count of numeric tokens in title divided by word count.', f: 'title.match(/\\d+/g).length / word_count', s: ['metadata.title'], r: '0 to 1', layer: 'post' },
    title_starts_with_action:      { d: 'Binary: 1 if title starts with an action verb (making, building, testing, etc.).', f: 'ACTION_VERBS.includes(first_word) ? 1 : 0', s: ['metadata.title'], r: '0 or 1', layer: 'post' },
    // ── Group C: Transcript Linguistic Metrics ──
    avg_word_gap_s:                { d: 'Average gap between words in seconds (duration / word_count).', f: 'duration / word_count', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 1', layer: 'pre' },
    beat_count:                    { d: 'Count of narrative beat sentences starting with transition words.', f: 'count(sentences starting with So|And then|Now|But then|etc.)', s: ['transcript.fullText'], r: '0 to 50', layer: 'pre' },
    beat_acceleration:             { d: 'Beat density in 2nd half / beat density in 1st half.', f: 'beat_density_2nd / (beat_density_1st + 0.001)', s: ['transcript.fullText'], r: '0 to 5', layer: 'pre' },
    body_sensation_word_pct:       { d: 'Fraction of words matching body/sensation vocabulary.', f: 'count(sensation_words) / word_count', s: ['transcript.fullText'], r: '0 to 0.05', layer: 'pre' },
    comparison_word_count:         { d: 'Count of comparison phrases in the transcript.', f: 'count(like, than, similar to, compared to, etc.)', s: ['transcript.fullText'], r: '0 to 30', layer: 'pre' },
    first_beat_delay_pct:          { d: 'Position (0-1) of first beat sentence in transcript.', f: 'char_index_of_first_beat / transcript.length', s: ['transcript.fullText'], r: '0 to 1', layer: 'pre' },
    hapax_legomena_ratio:          { d: 'Words appearing exactly once divided by total unique words.', f: 'hapax_count / unique_word_count', s: ['transcript.fullText'], r: '0 to 1', layer: 'pre' },
    hook_number_count:             { d: 'Count of numeric tokens in the hook text.', f: '(hookText().match(/\\d+/g) || []).length', s: ['transcript.fullText'], r: '0 to 5', layer: 'pre' },
    hook_pivot_word_flag:          { d: 'Binary: 1 if hook contains a pivot/contrast word.', f: 'any(pivot_words in hookText()) ? 1 : 0', s: ['transcript.fullText'], r: '0 or 1', layer: 'pre' },
    hook_speech_rate_wps:          { d: 'Words per second in the hook text.', f: 'hookWords.length / hookDuration', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
    hook_tension_density:          { d: 'Density of tension/problem words in the hook.', f: 'count(tension_words in hook) / hook_word_count', s: ['transcript.fullText'], r: '0 to 0.2', layer: 'pre' },
    hook_unique_word_ratio:        { d: 'Unique words / total words in hook text.', f: 'Set(hookWords).size / hookWords.length', s: ['transcript.fullText'], r: '0 to 1', layer: 'pre' },
    long_word_ratio:               { d: 'Fraction of words longer than 7 characters.', f: 'count(word.length > 7) / word_count', s: ['transcript.fullText'], r: '0 to 0.5', layer: 'pre' },
    pivot_word_density:            { d: 'Density of narrative pivot/contrast words per total words.', f: 'count(pivot_words) / word_count', s: ['transcript.fullText'], r: '0 to 0.05', layer: 'pre' },
    repeated_phrase_count:         { d: 'Count of distinct 3-word trigrams that appear 2 or more times.', f: 'count(trigrams with freq >= 2)', s: ['transcript.fullText'], r: '0 to 50', layer: 'pre' },
    resolution_word_density:       { d: 'Density of resolution/conclusion phrases per word count.', f: 'count(resolution_phrases) / word_count', s: ['transcript.fullText'], r: '0 to 0.02', layer: 'pre' },
    second_person_ratio:           { d: 'Fraction of words that are "you" or "your".', f: 'count(you|your) / word_count', s: ['transcript.fullText'], r: '0 to 0.15', layer: 'pre' },
    sensory_technical_ratio:       { d: 'Sensory word count / (technical word count + 1).', f: 'sensory_count / (technical_count + 1)', s: ['transcript.fullText'], r: '0 to 10', layer: 'pre' },
    short_word_ratio:              { d: 'Fraction of words with 3 or fewer characters.', f: 'count(word.length <= 3) / word_count', s: ['transcript.fullText'], r: '0 to 0.5', layer: 'pre' },
    silence_total_pct:             { d: 'Estimated fraction of video time without speech.', f: '1 - (word_count * 0.3 / duration), clamped [0,1]', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 1', layer: 'pre' },
    speech_rate_q1:                { d: 'Words per second in the first 25% of the transcript.', f: 'words_in_first_25pct / (0.25 * duration)', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
    speech_rate_q4:                { d: 'Words per second in the last 25% of the transcript.', f: 'words_in_last_25pct / (0.25 * duration)', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
    speech_acceleration:           { d: 'Speech rate in last quarter / speech rate in first quarter.', f: 'speech_rate_q4 / (speech_rate_q1 + 0.001)', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 5', layer: 'pre' },
    speech_silence_ratio:          { d: 'Estimated speech time / non-speech time.', f: 'speech_time / (duration - speech_time + 0.001)', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
    speech_tempo_range:            { d: 'Range (max - min) of speech rates across four quarters.', f: 'max(q1,q2,q3,q4 rates) - min(q1,q2,q3,q4 rates)', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
    summary_word_count:            { d: 'Count of summary/conclusion phrases in the transcript.', f: 'count(summary phrases in transcript)', s: ['transcript.fullText'], r: '0 to 10', layer: 'pre' },
    transcript_readability:        { d: 'Flesch reading ease score (higher = more readable).', f: '206.835 - 1.015*(words/sentences) - 84.6*(avg_syllables)', s: ['transcript.fullText'], r: '0 to 120', layer: 'pre' },
    word_density_variance:         { d: 'Variance of word counts across 10 equal segments of the transcript.', f: 'variance(word_counts_per_segment)', s: ['transcript.fullText'], r: '0 to 500', layer: 'pre' },
    opening_word_latency_s:        { d: 'Time in seconds before first spoken word.', f: 'transcript.words[0].start or duration * 0.01', s: ['transcript.words', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
    peak_speech_rate_3s:           { d: 'Maximum words per second in any 3-second window.', f: 'max(chunk_sizes) / 3.0', s: ['transcript.fullText', 'metadata.duration'], r: '0 to 10', layer: 'pre' },
};

function getMetricDefinition(key) {
    // Detailed definitions for individual static keys
    const dd = DETAILED_DEFS[key];
    if (dd) {
        return {
            description: dd.d,
            formula: dd.f,
            expected_range: dd.r || 'varies',
            data_sources: dd.s || ['analysis'],
            layer: STATIC_LAYER[key] || 'post',
        };
    }

    // Remaining static keys — detect phrase-pattern suffixes and generate detailed defs
    if (STATIC_KEYS.has(key)) {
        const layer = STATIC_LAYER[key] || 'post';

        // Detect phrase-family patterns: {family}_{suffix}
        // Suffixes: _count, _density, _count_hook, _density_hook, _count_first_half,
        //           _count_first_quarter, _count_last_quarter, _count_mid, _front_load_ratio,
        //           _position_pct, _count_first{N}s, _density_first{N}s, _hook_count,
        //           _first_half_count, _second_half_count, _count_first_third, etc.
        let m;
        m = key.match(/^(.+?)_(count|density)$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            const phraseListName = m[1].toUpperCase() + '_PHRASES';
            if (m[2] === 'count') return { description: `Total count of "${fam}" phrase matches across the full transcript. Lowercases transcript text, scans for each phrase in the family list, counts all substring occurrences.`, formula: `countPhraseMatches(transcript.toLowerCase(), ${phraseListName})`, expected_range: '0 to 100', data_sources: ['transcript.fullText', phraseListName], layer };
            return { description: `"${fam}" phrase count divided by transcript word count — density (rate per word), independent of video length.`, formula: `countPhraseMatches(transcript.toLowerCase(), ${phraseListName}) / word_count`, expected_range: '0 to 0.05', data_sources: ['transcript.fullText', phraseListName], layer };
        }
        m = key.match(/^(.+?)_(count|density)_(hook)$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            const phraseListName = m[1].toUpperCase() + '_PHRASES';
            const measure = m[2];
            if (measure === 'count') return { description: `Count of "${fam}" phrase matches in the hook (first ~5 seconds by word-index estimate).`, formula: `countPhraseMatches(hookText().toLowerCase(), ${phraseListName})`, expected_range: '0 to 20', data_sources: ['transcript.fullText', 'metadata.duration', phraseListName], layer };
            return { description: `"${fam}" phrase density in the hook — count / hook word count.`, formula: `countPhraseMatches(hookText().toLowerCase(), ${phraseListName}) / hook_word_count`, expected_range: '0 to 0.1', data_sources: ['transcript.fullText', 'metadata.duration', phraseListName], layer };
        }
        m = key.match(/^(.+?)_(count|density)_first(\d+)s$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            const phraseListName = m[1].toUpperCase() + '_PHRASES';
            const [, , measure, secs] = m;
            if (measure === 'count') return { description: `Count of "${fam}" phrase matches in the first ${secs} seconds of transcript. Text window = words[0 : ceil(word_count * ${secs} / duration)].`, formula: `countPhraseMatches(first_${secs}s_text, ${phraseListName})`, expected_range: '0 to 30', data_sources: ['transcript.fullText', 'metadata.duration', phraseListName], layer };
            return { description: `"${fam}" phrase density in the first ${secs} seconds — count / words in window.`, formula: `countPhraseMatches(first_${secs}s_text, ${phraseListName}) / words_in_${secs}s`, expected_range: '0 to 0.1', data_sources: ['transcript.fullText', 'metadata.duration', phraseListName], layer };
        }
        m = key.match(/^(.+?)_(count|density)_(first_quarter|first_half|first_third|second_half|second_quarter|third_quarter|last_quarter|last_third|mid|mid_third)$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            const phraseListName = m[1].toUpperCase() + '_PHRASES';
            const [, , measure, window] = m;
            const windowDesc = window.replace(/_/g, ' ');
            if (measure === 'count') return { description: `Count of "${fam}" phrase matches in the ${windowDesc} of the transcript (by word index).`, formula: `countPhraseMatches(${window}_text, ${phraseListName})`, expected_range: '0 to 50', data_sources: ['transcript.fullText', phraseListName], layer };
            return { description: `"${fam}" phrase density in the ${windowDesc} of the transcript.`, formula: `countPhraseMatches(${window}_text, ${phraseListName}) / words_in_window`, expected_range: '0 to 0.1', data_sources: ['transcript.fullText', phraseListName], layer };
        }
        m = key.match(/^(.+?)_front_load_ratio$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            const phraseListName = m[1].toUpperCase() + '_PHRASES';
            return { description: `"${fam}" front-load ratio: first-half phrase count / (second-half count + 0.0001). > 1 means front-loaded.`, formula: `(count_first_half + 0.0001) / (count_second_half + 0.0001)`, expected_range: '0.1 to 10', data_sources: ['transcript.fullText', phraseListName], layer };
        }
        m = key.match(/^(.+?)_position_pct$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            return { description: `Position (as fraction of total words) where the first "${fam}" phrase match occurs in the transcript.`, formula: `first_match_word_index / total_words`, expected_range: '0 to 1', data_sources: ['transcript.fullText'], layer };
        }
        // Order-flipped: {family}_hook_count, {family}_first_half_count, etc.
        m = key.match(/^(.+?)_(hook_count|first_half_count|second_half_count)$/);
        if (m) {
            const fam = m[1].replace(/_/g, ' ').toUpperCase();
            const phraseListName = m[1].toUpperCase() + '_PHRASES';
            const windowDesc = m[2].replace(/_count$/, '').replace(/_/g, ' ');
            return { description: `Count of "${fam}" phrase matches in the ${windowDesc} of the transcript.`, formula: `countPhraseMatches(${m[2].replace('_count','')}_text, ${phraseListName})`, expected_range: '0 to 50', data_sources: ['transcript.fullText', phraseListName], layer };
        }

        // Fallback for any unmatched static key
        return {
            description: key.replace(/_/g, ' '),
            formula: key,
            expected_range: 'varies',
            data_sources: ['analysis'],
            layer,
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

    // Group R retention-curve zygarnik metrics
    const GROUP_R_KEYS = new Set([
        'retention_zygarnik_arc', 'retention_recovery_ratio', 'retention_late_payoff',
        'retention_pre_payoff_drop', 'retention_hook_to_mid_ratio',
        'retention_setup_phase_mean', 'retention_open_loop_phase_mean',
        'retention_payoff_phase_mean', 'retention_tension_trough_pct', 'retention_arc_width'
    ]);
    if (GROUP_R_KEYS.has(key)) {
        return {
            description: key.replace(/_/g, ' '),
            formula: key,
            expected_range: 'varies',
            data_sources: ['analytics.retentionCurve'],
            layer: 'post',
        };
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
        // Deterministic: always use word-index estimate (~first 5 seconds by speech rate)
        // Never use AI-generated segment boundaries (no prompt provenance)
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

    // ── Group R: Retention-Curve Zygarnik metrics ─────────────────────────
    if (key === 'retention_zygarnik_arc') {
        const v25 = curveVal(25), v50 = curveVal(50), v75 = curveVal(75);
        if (v25 == null || v50 == null || v75 == null || v25 === 0) return [null, 'no curve'];
        const drop = v25 - v50;
        const recovery = Math.max(0, v75 - v50);
        return [(drop + recovery) / v25, null];
    }
    if (key === 'retention_recovery_ratio') {
        const v50 = curveVal(50), v75 = curveVal(75);
        if (v50 == null || v75 == null || v50 === 0) return [null, 'no curve'];
        return [v75 / v50, null];
    }
    if (key === 'retention_late_payoff') {
        const v50 = curveVal(50), v90 = curveVal(90);
        if (v50 == null || v90 == null || v50 === 0) return [null, 'no curve'];
        return [v90 / v50, null];
    }
    if (key === 'retention_pre_payoff_drop') {
        const v25 = curveVal(25), v50 = curveVal(50);
        if (v25 == null || v50 == null) return [null, 'no curve'];
        return [v25 - v50, null];
    }
    if (key === 'retention_hook_to_mid_ratio') {
        const v10 = curveVal(10), v50 = curveVal(50);
        if (v10 == null || v50 == null || v50 === 0) return [null, 'no curve'];
        return [v10 / v50, null];
    }
    if (key === 'retention_setup_phase_mean') {
        const pts = [5,10,15,20,25].map(i => curveVal(i)).filter(v => v != null);
        if (pts.length < 3) return [null, 'curve too short'];
        return [pts.reduce((a,b)=>a+b,0)/pts.length, null];
    }
    if (key === 'retention_open_loop_phase_mean') {
        const pts = [25,30,35,40,45,50].map(i => curveVal(i)).filter(v => v != null);
        if (pts.length < 4) return [null, 'curve too short'];
        return [pts.reduce((a,b)=>a+b,0)/pts.length, null];
    }
    if (key === 'retention_payoff_phase_mean') {
        const pts = [60,65,70,75,80,85,90].map(i => curveVal(i)).filter(v => v != null);
        if (pts.length < 4) return [null, 'curve too short'];
        return [pts.reduce((a,b)=>a+b,0)/pts.length, null];
    }
    if (key === 'retention_tension_trough_pct') {
        if (curve.length < 10) return [null, 'curve too short'];
        let minVal = Infinity, minPct = null;
        for (let i = 0; i < curve.length; i++) {
            if (curve[i].retention < minVal) { minVal = curve[i].retention; minPct = i; }
        }
        return [minPct, null];
    }
    if (key === 'retention_arc_width') {
        const v25 = curveVal(25), v50 = curveVal(50), v75 = curveVal(75);
        if (v25 == null || v50 == null || v75 == null) return [null, 'no curve'];
        const peak = Math.max(v25, v75);
        const trough = v50;
        return [peak - trough, null];
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
    if (key === 'pivot_word_count') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const PIVOT_WORDS = ['but', 'however', 'yet', 'although', 'whereas', 'while', 'nevertheless',
            'meanwhile', 'despite', 'instead', 'rather', 'conversely', 'nonetheless',
            'on the other hand', 'in contrast'];
        let count = 0;
        for (const p of PIVOT_WORDS) {
            const re = new RegExp('\\b' + p.replace(/ /g, '\\s+') + '\\b', 'g');
            count += (tl.match(re) || []).length;
        }
        return [count, null];
    }
    if (key === 'sensory_word_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const SENSORY_WORDS = new Set(['feel', 'touch', 'cold', 'warm', 'hot', 'sharp', 'rough', 'smooth',
            'loud', 'quiet', 'bright', 'dark', 'smell', 'taste', 'bitter', 'sweet', 'soft', 'hard',
            'heavy', 'light', 'thick', 'thin', 'pain', 'ache', 'burn', 'tingle']);
        const ct = words.filter(w => SENSORY_WORDS.has(w.replace(/[^a-z]/g, ''))).length;
        return [ct / words.length, null];
    }
    if (key === 'motif_recurrence_score') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length < 20) return [0, null];
        const phraseMap = {};
        for (let i = 0; i < words.length - 1; i++) {
            const phrase = words[i] + ' ' + words[i + 1];
            if (!phraseMap[phrase]) phraseMap[phrase] = [];
            phraseMap[phrase].push(i);
        }
        let recurrences = 0;
        for (const positions of Object.values(phraseMap)) {
            if (positions.length < 2) continue;
            for (let i = 1; i < positions.length; i++) {
                if (positions[i] - positions[i - 1] >= 10) recurrences++;
            }
        }
        return [recurrences / words.length, null];
    }
    if (key === 'beat_density_per_minute') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (words.length < 20) return [0, null];
        const BEAT_STARTERS = /^(So|And\s+then|Now|But\s+then|Then|After|Before|When|Until|Because|Which\s+means)\b/i;
        const sentences = transcript.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
        const beatCount = sentences.filter(s => BEAT_STARTERS.test(s)).length;
        const estimatedMinutes = words.length / 130;
        return [beatCount / estimatedMinutes, null];
    }
    if (key === 'escalation_slope') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length < 20) return [0, null];
        const third = Math.floor(words.length / 3);
        const t1 = words.slice(0, third).join(' ');
        const t2 = words.slice(third, third * 2).join(' ');
        const t3 = words.slice(third * 2).join(' ');
        const c1 = countPhraseMatches(t1, ZYGARNIK_PHRASE_SETS.stakes_high);
        const c3 = countPhraseMatches(t3, ZYGARNIK_PHRASE_SETS.stakes_high);
        return [(c3 - c1) / (third + 0.001), null];
    }
    if (key === 'title_curiosity_gap_score') {
        const title = (meta.title || '');
        if (!title) return [0, null];
        const titleWords = title.trim().split(/\s+/).filter(Boolean);
        let score = 0;
        if (title.includes('?')) score++;
        if (/\d/.test(title)) score++;
        if (/^(How|Why|What)\b/i.test(title)) score++;
        if (/\byou\b|\byour\b/i.test(title)) score++;
        if (titleWords.length <= 8) score++;
        return [score, null];
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

    // Extended phrase family metrics: hook-window, front-load ratio, first-half count, density variants
    // Handles: {fam}_count_hook, {fam}_density_hook, {fam}_front_load_ratio, {fam}_count_first_half,
    //          {fam}_density_first_half, {fam}_position_pct
    const _zyExtRe = new RegExp(`^(${ZYGARNIK_FAMILIES.join('|')})_(count_hook|density_hook|front_load_ratio|count_first_half|density_first_half|position_pct)$`);
    const zyExtMatch = key.match(_zyExtRe);
    if (zyExtMatch) {
        const [, family, variant] = zyExtMatch;
        if (!transcript) return [null, 'no transcript'];
        const phrases = ZYGARNIK_PHRASE_SETS[family];
        if (!phrases || !phrases.length) return [null, 'no phrase list'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        if (variant === 'count_hook') {
            const hookWords = words.slice(0, Math.max(1, Math.ceil(words.length * 0.1)));
            return [countPhraseMatches(hookWords.join(' '), phrases), null];
        }
        if (variant === 'density_hook') {
            const hookWords = words.slice(0, Math.max(1, Math.ceil(words.length * 0.1)));
            const hw = hookWords.length || 1;
            return [countPhraseMatches(hookWords.join(' '), phrases) / hw, null];
        }
        if (variant === 'count_first_half') {
            const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ');
            return [countPhraseMatches(firstHalf, phrases), null];
        }
        if (variant === 'density_first_half') {
            const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ');
            const hw = Math.floor(words.length / 2) || 1;
            return [countPhraseMatches(firstHalf, phrases) / hw, null];
        }
        if (variant === 'front_load_ratio') {
            const mid = Math.floor(words.length / 2);
            const firstHalf = words.slice(0, mid).join(' ');
            const secondHalf = words.slice(mid).join(' ');
            const c1 = countPhraseMatches(firstHalf, phrases);
            const c2 = countPhraseMatches(secondHalf, phrases);
            return [(c1 + 0.01) / (c2 + 0.01), null];
        }
        if (variant === 'position_pct') {
            // Position of first phrase match as fraction of transcript
            for (const ph of phrases) {
                const idx = tl.indexOf(ph);
                if (idx >= 0) {
                    const wordsBefore = tl.slice(0, idx).split(/\s+/).filter(Boolean).length;
                    return [wordsBefore / words.length, null];
                }
            }
            return [null, 'no phrase found'];
        }
        return [null, `unknown variant: ${variant}`];
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

    // ── Group A: Direct Analytics Reads ──────────────────────────────────────

    if (key === 'above_baseline_area') {
        if (curve.length < 4) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        const mRet = mean(vals);
        let area = 0;
        for (const v of vals) area += Math.max(0, v - mRet);
        return [area, null];
    }

    if (key === 'avg_percent_viewed') {
        if (analytics.avgPercentViewed == null) return [null, 'no avgPercentViewed'];
        return [analytics.avgPercentViewed, null];
    }

    if (key === 'avg_view_duration_s') {
        if (analytics.avgViewDuration == null) return [null, 'no avgViewDuration'];
        return [analytics.avgViewDuration, null];
    }

    if (key === 'daily_views_entropy') {
        if (daily.length < 3) return [null, 'not enough daily views'];
        const views = daily.map(d => d.views || 0);
        const total = views.reduce((a, b) => a + b, 0);
        if (total === 0) return [0, null];
        let h = 0;
        for (const v of views) { const p = v / total; h -= p * Math.log2(p + 1e-10); }
        return [h, null];
    }

    if (key === 'early_late_drop_ratio') {
        if (curve.length < 10) return [null, 'curve too short'];
        const n = curve.length;
        const earlyN = Math.max(1, Math.floor(n * 0.1));
        const earlyMean = mean(curve.slice(0, earlyN).map(p => p.retention));
        const lateMean = mean(curve.slice(n - earlyN).map(p => p.retention));
        return [earlyMean / (lateMean + 0.001), null];
    }

    if (key === 'engagement_rate') {
        const lk = analytics.likes, cm = analytics.comments;
        if (lk == null && cm == null) return [null, 'no likes or comments'];
        const eng = (lk || 0) + (cm || 0);
        return [eng / Math.max(meta.viewCount || analytics.totalViews || 1, 1), null];
    }

    if (key === 'late_drop_severity') {
        if (curve.length < 4) return [null, 'curve too short'];
        const n = curve.length;
        const s1 = curve.slice(Math.floor(n * 0.5), Math.floor(n * 0.75)).map(p => p.retention);
        const s2 = curve.slice(Math.floor(n * 0.75)).map(p => p.retention);
        if (!s1.length || !s2.length) return [null, 'segments empty'];
        return [mean(s1) - mean(s2), null];
    }

    if (key === 'momentum_zone_length') {
        if (curve.length < 4) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        let maxRun = 0, curRun = 0;
        for (let i = 1; i < vals.length; i++) {
            if (vals[i] > vals[i - 1]) { curRun++; maxRun = Math.max(maxRun, curRun); }
            else curRun = 0;
        }
        return [maxRun / curve.length, null];
    }

    if (key === 'retention_concavity') {
        if (curve.length < 5) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        const diffs = [];
        for (let i = 0; i < vals.length - 2; i++) diffs.push(vals[i + 2] - 2 * vals[i + 1] + vals[i]);
        return [mean(diffs), null];
    }

    if (key === 'retention_quartile_spread') {
        if (curve.length < 4) return [null, 'curve too short'];
        const n = curve.length;
        const q1m = mean(curve.slice(0, Math.floor(n * 0.25)).map(p => p.retention));
        const q2m = mean(curve.slice(Math.floor(n * 0.25), Math.floor(n * 0.5)).map(p => p.retention));
        const q3m = mean(curve.slice(Math.floor(n * 0.5), Math.floor(n * 0.75)).map(p => p.retention));
        const q4m = mean(curve.slice(Math.floor(n * 0.75)).map(p => p.retention));
        return [std([q1m, q2m, q3m, q4m]), null];
    }

    if (key === 'retention_variation_raw') {
        if (curve.length < 4) return [null, 'curve too short'];
        return [std(curve.map(p => p.retention)), null];
    }

    if (key === 'stayed_to_watch_rate') {
        if (analytics.viewedRate == null) return [null, 'no viewedRate'];
        return [analytics.viewedRate, null];
    }

    if (key === 'sub_nonsub_retention_gap') {
        if (analytics.subscriberAvgPercent == null || analytics.nonSubscriberAvgPercent == null) {
            return [null, 'missing subscriber percentages'];
        }
        return [analytics.subscriberAvgPercent - analytics.nonSubscriberAvgPercent, null];
    }

    if (key === 'sub_view_fraction') {
        if (analytics.subscriberViews == null) return [null, 'no subscriberViews'];
        return [analytics.subscriberViews / (analytics.subscriberViews + (analytics.nonSubscriberViews || 0) + 1), null];
    }

    if (key === 'view_day1_share') {
        if (daily.length < 1) return [null, 'no daily views'];
        const total = daily.reduce((s, d) => s + (d.views || 0), 0);
        return [(daily[0].views || 0) / (total + 1), null];
    }

    if (key === 'view_week3_week1_ratio') {
        if (daily.length < 14) return [null, 'not enough daily views'];
        const w1 = daily.slice(0, 7).reduce((s, d) => s + (d.views || 0), 0);
        const w3 = daily.slice(14, 21).reduce((s, d) => s + (d.views || 0), 0);
        return [w3 / (w1 + 1), null];
    }

    if (key === 'escalation_peak_position_pct') {
        if (curve.length < 4) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        let peakIdx = 0;
        for (let i = 1; i < vals.length; i++) if (vals[i] > vals[peakIdx]) peakIdx = i;
        return [peakIdx / Math.max(curve.length - 1, 1), null];
    }

    if (key === 'deescalation_speed') {
        if (curve.length < 4) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        let peakIdx = 0;
        for (let i = 1; i < vals.length; i++) if (vals[i] > vals[peakIdx]) peakIdx = i;
        return [vals[peakIdx] - vals[vals.length - 1], null];
    }

    if (key === 'emotional_arc_swing') {
        if (curve.length < 4) return [null, 'curve too short'];
        const vals = curve.map(p => p.retention);
        return [Math.max(...vals) - Math.min(...vals), null];
    }

    // ── Group B: Metadata Reads ───────────────────────────────────────────────

    if (key === 'description_hashtag_count') {
        const desc = meta.description;
        if (!desc) return [null, 'no description'];
        return [(desc.match(/#+\w+/g) || []).length, null];
    }

    if (key === 'description_word_count') {
        const desc = meta.description;
        if (!desc) return [null, 'no description'];
        const trimmed = desc.trim();
        return [trimmed ? trimmed.split(/\s+/).length : 0, null];
    }

    if (key === 'duration_optimal_flag') {
        if (meta.duration == null) return [null, 'no duration'];
        return [meta.duration >= 45 && meta.duration <= 180 ? 1 : 0, null];
    }

    if (key === 'duration_sweetspot_distance') {
        if (meta.duration == null) return [null, 'no duration'];
        return [Math.abs(meta.duration - 90), null];
    }

    if (key === 'upload_month') {
        if (!meta.uploadDate) return [null, 'no uploadDate'];
        const s = String(meta.uploadDate);
        const isoStr = s.length === 8 ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : s;
        const ud = new Date(isoStr);
        if (isNaN(ud.getTime())) return [null, 'invalid uploadDate'];
        return [ud.getMonth() + 1, null];
    }

    if (key === 'idea_number_flag') {
        const title = meta.title;
        if (!title) return [null, 'no title'];
        const hasNum = /\b\d+\b|\bone\b|\btwo\b|\bthree\b|\bfive\b|\bten\b/i.test(title);
        const hasList = /\b\d+\s*(ways|things|tips|steps|reasons|tricks|ideas|hacks|mistakes|secrets)/i.test(title);
        return [hasNum || hasList ? 1 : 0, null];
    }

    if (key === 'title_avg_word_length') {
        const title = meta.title;
        if (!title) return [null, 'no title'];
        const words = title.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty title'];
        return [mean(words.map(w => w.length)), null];
    }

    if (key === 'title_compression_ratio') {
        const title = meta.title;
        if (!title) return [null, 'no title'];
        const wc = title.split(/\s+/).filter(Boolean).length;
        return [title.length / Math.sqrt(wc + 1), null];
    }

    if (key === 'title_contains_making') {
        const title = meta.title;
        if (!title) return [null, 'no title'];
        return [/\bmaking\b/i.test(title) ? 1 : 0, null];
    }

    if (key === 'title_specificity_score') {
        const title = meta.title;
        if (!title) return [null, 'no title'];
        const nums = (title.match(/\d+/g) || []).length;
        const wc = Math.max(title.split(/\s+/).length, 1);
        return [nums / wc, null];
    }

    if (key === 'title_starts_with_action') {
        const title = meta.title;
        if (!title) return [null, 'no title'];
        const actionVerbs = new Set(['making','building','creating','testing','trying','cooking','fixing','growing','training','painting','drawing','designing','editing','filming','learning','showing','using','winning','beating','spending','earning','saving','losing','running','starting','stopping','buying','selling','turning','converting']);
        const firstWord = title.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
        return [actionVerbs.has(firstWord) ? 1 : 0, null];
    }

    // ── Group C: Transcript Linguistic Metrics ────────────────────────────────

    if (key === 'avg_word_gap_s') {
        if (!transcript) return [null, 'no transcript'];
        const rawTObj = typeof rawT === 'object' && rawT ? rawT : null;
        if (rawTObj && Array.isArray(rawTObj.words) && rawTObj.words.length > 1) {
            const starts = rawTObj.words.map(w => w.start).filter(s => s != null);
            if (starts.length > 1) {
                const diffs = [];
                for (let i = 1; i < starts.length; i++) diffs.push(starts[i] - starts[i - 1]);
                return [mean(diffs), null];
            }
        }
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const wc = transcript.split(/\s+/).filter(Boolean).length;
        return [dur / Math.max(wc, 1), null];
    }

    if (key === 'beat_count') {
        if (!transcript) return [null, 'no transcript'];
        const BEAT_RE = /^(So|And then|Now|But then|Then|After|Before|When|Until|Because|Which means)\b/i;
        const sentences = transcript.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
        return [sentences.filter(s => BEAT_RE.test(s)).length, null];
    }

    if (key === 'beat_acceleration') {
        if (!transcript) return [null, 'no transcript'];
        const BEAT_RE = /^(So|And then|Now|But then|Then|After|Before|When|Until|Because|Which means)\b/i;
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const mid = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, mid).join(' ');
        const secondHalf = words.slice(mid).join(' ');
        const b1 = firstHalf.split(/[.!?]+/).map(s => s.trim()).filter(s => BEAT_RE.test(s)).length;
        const b2 = secondHalf.split(/[.!?]+/).map(s => s.trim()).filter(s => BEAT_RE.test(s)).length;
        const d1 = b1 / (mid / 100 + 0.001);
        const d2 = b2 / ((words.length - mid) / 100 + 0.001);
        return [d2 / (d1 + 0.001), null];
    }

    if (key === 'body_sensation_word_pct') {
        if (!transcript) return [null, 'no transcript'];
        const SENSATION = new Set(['feel','touch','cold','warm','hot','sharp','rough','smooth','tight','ache','burn','heavy','light','tense','grip','clench','squeeze','tremble','shake','flutter']);
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length < 10) return [null, 'word count < 10'];
        return [words.filter(w => SENSATION.has(w.replace(/[^a-z]/g, ''))).length / words.length, null];
    }

    if (key === 'comparison_word_count') {
        if (!transcript) return [null, 'no transcript'];
        const CMP = ['like','than','similar to','compared to','unlike','as much','as many','more than','less than','twice as','half as'];
        return [countPhraseMatches(transcript.toLowerCase(), CMP), null];
    }

    if (key === 'first_beat_delay_pct') {
        if (!transcript) return [null, 'no transcript'];
        const BEAT_RE = /^(So|And then|Now|But then|Then|After|Before|When|Until|Because|Which means)\b/i;
        const sentences = transcript.split(/[.!?]+/);
        let charPos = 0;
        for (const s of sentences) {
            if (BEAT_RE.test(s.trim())) return [charPos / Math.max(transcript.length, 1), null];
            charPos += s.length + 1;
        }
        return [1.0, null];
    }

    if (key === 'hapax_legomena_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/[^a-z]/g, '')).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        const uniqueWords = Object.keys(freq);
        return [uniqueWords.length > 0 ? uniqueWords.filter(w => freq[w] === 1).length / uniqueWords.length : 0, null];
    }

    if (key === 'hook_number_count') {
        return [(hookText().match(/\d+/g) || []).length, null];
    }

    if (key === 'hook_pivot_word_flag') {
        const PIVOTS = ['but','however','yet','although','whereas','while','nevertheless','still','instead','rather','except','despite'];
        const ht = hookText().toLowerCase();
        return [PIVOTS.some(p => ht.includes(p)) ? 1 : 0, null];
    }

    if (key === 'hook_speech_rate_wps') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        const hookEst = Math.max(1, Math.floor(words.length * 5 / dur));
        const hookWords = words.slice(0, hookEst);
        const hookDur = (hookWords.length / Math.max(words.length, 1)) * dur;
        return [hookWords.length / Math.max(hookDur, 0.001), null];
    }

    if (key === 'hook_tension_density') {
        const TENSION = ['but','however','wait','actually','problem','issue','mistake','wrong','fail','challenge','struggle'];
        const ht = hookText().toLowerCase();
        const hookWords = ht.split(/\s+/).filter(Boolean);
        if (!hookWords.length) return [0, null];
        const count = TENSION.reduce((c, tw) => c + hookWords.filter(w => w.replace(/[^a-z]/g, '') === tw).length, 0);
        return [count / hookWords.length, null];
    }

    if (key === 'hook_unique_word_ratio') {
        const ht = hookText();
        const hookWords = ht.split(/\s+/).filter(Boolean);
        if (!hookWords.length) return [0, null];
        return [new Set(hookWords.map(w => w.toLowerCase())).size / hookWords.length, null];
    }

    if (key === 'long_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [words.filter(w => w.length > 7).length / words.length, null];
    }

    if (key === 'pivot_word_density') {
        if (!transcript) return [null, 'no transcript'];
        const PIVOT_WORDS = ['but','however','yet','although','whereas','while','nevertheless','still','instead','rather','except','despite','though','conversely','on the other hand'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), PIVOT_WORDS) / words.length, null];
    }

    if (key === 'repeated_phrase_count') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/[^a-z0-9]/g, ''));
        if (words.length < 3) return [0, null];
        const trigrams = {};
        for (let i = 0; i < words.length - 2; i++) {
            const tg = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
            trigrams[tg] = (trigrams[tg] || 0) + 1;
        }
        return [Object.values(trigrams).filter(c => c >= 2).length, null];
    }

    if (key === 'resolution_word_density') {
        if (!transcript) return [null, 'no transcript'];
        const RES = ['finally','at last','in the end','conclusion','turns out','ultimately','result','so that','which means','therefore','the answer','the solution'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [countPhraseMatches(transcript.toLowerCase(), RES) / words.length, null];
    }

    if (key === 'second_person_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [(transcript.match(/\byou\b|\byour\b/gi) || []).length / words.length, null];
    }

    if (key === 'sensory_technical_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const SENSORY_SET = new Set(['feel','touch','cold','warm','hot','sharp','rough','smooth','see','hear','taste','smell','sound','look','texture']);
        const TECHNICAL_SET = new Set(['algorithm','protocol','parameter','configuration','implementation','architecture','infrastructure','optimization','calibration','synchronization','framework','methodology','systematic','analytical','empirical']);
        const words = transcript.toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/[^a-z]/g, ''));
        return [words.filter(w => SENSORY_SET.has(w)).length / (words.filter(w => TECHNICAL_SET.has(w)).length + 1), null];
    }

    if (key === 'short_word_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        return [words.filter(w => w.length <= 3).length / words.length, null];
    }

    if (key === 'silence_total_pct') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const wc = transcript.split(/\s+/).filter(Boolean).length;
        return [Math.max(0, Math.min(1, 1 - (wc * 0.3 / Math.max(dur, 1)))), null];
    }

    if (key === 'speech_rate_q1') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        return [words.slice(0, Math.ceil(words.length * 0.25)).length / (0.25 * dur + 0.001), null];
    }

    if (key === 'speech_rate_q4') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        return [words.slice(Math.floor(words.length * 0.75)).length / (0.25 * dur + 0.001), null];
    }

    if (key === 'speech_acceleration') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        const q1r = words.slice(0, Math.ceil(words.length * 0.25)).length / (0.25 * dur + 0.001);
        const q4r = words.slice(Math.floor(words.length * 0.75)).length / (0.25 * dur + 0.001);
        return [q4r / (q1r + 0.001), null];
    }

    if (key === 'speech_silence_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const speechTime = transcript.split(/\s+/).filter(Boolean).length * 0.3;
        return [speechTime / (Math.max(dur, 1) - speechTime + 0.001), null];
    }

    if (key === 'speech_tempo_range') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        const n = words.length;
        const rates = [
            words.slice(0, Math.ceil(n * 0.25)).length / (0.25 * dur + 0.001),
            words.slice(Math.ceil(n * 0.25), Math.ceil(n * 0.5)).length / (0.25 * dur + 0.001),
            words.slice(Math.ceil(n * 0.5), Math.ceil(n * 0.75)).length / (0.25 * dur + 0.001),
            words.slice(Math.ceil(n * 0.75)).length / (0.25 * dur + 0.001),
        ];
        return [Math.max(...rates) - Math.min(...rates), null];
    }

    if (key === 'summary_word_count') {
        if (!transcript) return [null, 'no transcript'];
        const SUM = ['in summary','to summarize','in conclusion','to conclude','in short','overall','at the end of the day','the bottom line','the takeaway','the key point','what this means','the lesson'];
        return [countPhraseMatches(transcript.toLowerCase(), SUM), null];
    }

    if (key === 'transcript_readability') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (words.length < 20) return [null, 'word count < 20'];
        const sentCount = Math.max(transcript.split(/[.!?]+/).filter(s => s.trim().length > 0).length, 1);
        const avgSyl = mean(words.map(w => Math.max(1, w.replace(/[^aeiou]/gi, '').length)));
        return [206.835 - 1.015 * (words.length / sentCount) - 84.6 * avgSyl, null];
    }

    if (key === 'word_density_variance') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [null, 'empty transcript'];
        const segSize = Math.max(1, Math.floor(words.length / 10));
        const counts = [];
        for (let i = 0; i < 10; i++) counts.push(words.slice(i * segSize, (i + 1) * segSize).length);
        return [variance(counts), null];
    }

    if (key === 'opening_word_latency_s') {
        const rawTObj = typeof rawT === 'object' && rawT ? rawT : null;
        if (rawTObj && Array.isArray(rawTObj.words) && rawTObj.words.length > 0 && rawTObj.words[0].start != null) {
            return [rawTObj.words[0].start, null];
        }
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        return [dur * 0.01, null];
    }

    if (key === 'peak_speech_rate_3s') {
        if (!transcript) return [null, 'no transcript'];
        const dur = meta.duration;
        if (!dur) return [null, 'no duration'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (words.length < 3) return [null, 'word count < 3'];
        const chunkSize = Math.max(1, Math.round(words.length * 3 / dur));
        let maxChunk = 0;
        for (let i = 0; i < words.length; i += chunkSize) {
            maxChunk = Math.max(maxChunk, words.slice(i, i + chunkSize).length);
        }
        return [maxChunk / 3.0, null];
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
            'pre_upload_mechanism':   PRE_UPLOAD_MECHANISM_PHRASES,
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
        const _gtWinRe = /^(reference_callback|visual_credibility|payoff_signal|setup_signal|stakes_escalation|proof_arrival|narrative_anchor|delayed_reveal|early_proof|social_signal|pre_upload_credibility|pre_upload_mechanism)_(count|density)_first(\d+)s$/;
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
            if (firstPayoff === -1) return [null, 'no payoff signal'];
            if (firstSetup === -1) firstSetup = 0; // implicit setup at video start
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
            let dr = 0;
            for (const ph of DELAYED_REVEAL_PHRASES) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { dr++; i += ph.length; } }
            const wordCount = tl.split(/\s+/).filter(Boolean).length;
            if (!wordCount) return [null, 'empty transcript'];
            return [dr / wordCount, null];
        }
        if (key === 'reference_to_gratification_ratio') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            let refCount = 0, gratCount = 0;
            for (const ph of REFERENCE_CALLBACK_PHRASES) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { refCount++; i += ph.length; } }
            for (const ph of ZYGARNIK_PHRASE_SETS.delayed_gratification) { let i = 0; while ((i = tl.indexOf(ph, i)) !== -1) { gratCount++; i += ph.length; } }
            return [refCount / (gratCount + 1), null];
        }
        if (key === 'setup_to_payoff_gap') {
            if (!transcript) return [null, 'no transcript'];
            const tl = transcript.toLowerCase();
            const words = tl.split(/\s+/).filter(Boolean);
            if (!words.length) return [null, 'empty transcript'];
            let firstSetupWord = -1, firstPayoffWord = -1;
            for (const ph of NEW_SETUP_PHRASES) {
                const pos = tl.indexOf(ph);
                if (pos >= 0) {
                    const wb = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                    if (firstSetupWord === -1 || wb < firstSetupWord) firstSetupWord = wb;
                }
            }
            for (const ph of NEW_PAYOFF_PHRASES) {
                const pos = tl.indexOf(ph);
                if (pos >= 0) {
                    const wb = tl.slice(0, pos).split(/\s+/).filter(Boolean).length;
                    if (firstPayoffWord === -1 || wb < firstPayoffWord) firstPayoffWord = wb;
                }
            }
            if (firstSetupWord === -1 || firstPayoffWord === -1) return [null, 'setup or payoff phrase not found'];
            return [Math.max(0, firstPayoffWord - firstSetupWord), null];
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

    // ── Group U: Windowed variants for Group U phrase families ──────────────
    {
        const _guRe = /^(cliffhanger|payoff_tease|revelation_signal|curiosity_escalation|stakes_reinforcement|viewer_agency)_(count|density)_first(\d+)s$/;
        const _gum = key.match(_guRe);
        if (_gum) {
            if (!transcript) return [null, 'no transcript'];
            const dur = meta.duration || 0;
            const wSec = parseInt(_gum[3]);
            const fam = _gum[1];
            const variant = _gum[2];
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
            const _guPhraseMap = {
                'cliffhanger': CLIFFHANGER_PHRASES,
                'payoff_tease': PAYOFF_TEASE_PHRASES,
                'revelation_signal': REVELATION_SIGNAL_PHRASES,
                'curiosity_escalation': CURIOSITY_ESCALATION_PHRASES,
                'stakes_reinforcement': STAKES_REINFORCEMENT_PHRASES,
                'viewer_agency': VIEWER_AGENCY_PHRASES,
            };
            const phrases = _guPhraseMap[fam];
            const count = countPhraseMatches(wl, phrases);
            return variant === 'density' ? [count / wWords.length, null] : [count, null];
        }
    }

    // ── Group R: Windowed variants for Group R phrase families ──────────────
    {
        const _grRe = /^(rhetorical_question|social_comparison|mystery_setup|viewer_stakes|loss_framing|promise_specificity|transformation_arc)_(count|density)_first(\d+)s$/;
        const _grm = key.match(_grRe);
        if (_grm) {
            if (!transcript) return [null, 'no transcript'];
            const dur = meta.duration || 0;
            const wSec = parseInt(_grm[3]);
            const fam = _grm[1];
            const variant = _grm[2];
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
            const _grPhraseMap = {
                'rhetorical_question': RHETORICAL_QUESTION_PHRASES,
                'social_comparison': SOCIAL_COMPARISON_PHRASES,
                'mystery_setup': MYSTERY_SETUP_PHRASES,
                'viewer_stakes': VIEWER_STAKES_PHRASES,
                'loss_framing': LOSS_FRAMING_PHRASES,
                'promise_specificity': PROMISE_SPECIFICITY_PHRASES,
                'transformation_arc': TRANSFORMATION_ARC_PHRASES,
            };
            const phrases = _grPhraseMap[fam];
            if (!phrases) return [null, 'no phrase map for ' + fam];
            const count = countPhraseMatches(wl, phrases);
            return variant === 'density' ? [count / wWords.length, null] : [count, null];
        }
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

    // ── Group Z: Challenge/tension structural metrics ─────────────────────────────────────
    if (key === 'challenge_setup_density_first_quarter') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const q1 = words.slice(0, Math.floor(words.length / 4)).join(' ').toLowerCase();
        const q1Words = q1.split(/\s+/).filter(Boolean).length || 1;
        return [countPhraseMatches(q1, CHALLENGE_STATEMENT_PHRASES) / q1Words, null];
    }
    if (key === 'narrative_tension_density_first_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const half = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        const halfWords = half.split(/\s+/).filter(Boolean).length || 1;
        return [countPhraseMatches(half, NARRATIVE_TENSION_PHRASES) / halfWords, null];
    }
    if (key === 'answer_withhold_density_first_third') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const third = words.slice(0, Math.floor(words.length / 3)).join(' ').toLowerCase();
        const thirdWords = third.split(/\s+/).filter(Boolean).length || 1;
        return [countPhraseMatches(third, DELAYED_REVEAL_PHRASES) / thirdWords, null];
    }
    if (key === 'payoff_delay_score') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        let firstPayoff = -1;
        for (const ph of PAYOFF_SIGNAL_PHRASES) {
            const idx = tl.indexOf(ph);
            if (idx !== -1) firstPayoff = firstPayoff === -1 ? idx : Math.min(firstPayoff, idx);
        }
        if (firstPayoff === -1) return [1.0, null]; // no payoff = treated as max delay
        return [firstPayoff / tl.length, null];
    }
    if (key === 'loop_front_half_density') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const half = words.slice(0, Math.floor(words.length / 2)).join(' ').toLowerCase();
        const halfWords = half.split(/\s+/).filter(Boolean).length || 1;
        const OPEN_LOOP_PHRASES = ZYGARNIK_PHRASE_SETS['open_loop'] || [];
        return [countPhraseMatches(half, OPEN_LOOP_PHRASES) / halfWords, null];
    }
    if (key === 'resolution_density_second_half') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const half = words.slice(Math.floor(words.length / 2)).join(' ').toLowerCase();
        const halfWords = half.split(/\s+/).filter(Boolean).length || 1;
        const CLOSURE_PHRASES = ZYGARNIK_PHRASE_SETS['closure'] || [];
        return [countPhraseMatches(half, CLOSURE_PHRASES) / halfWords, null];
    }
    if (key === 'challenge_to_resolution_gap_pct') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        let firstChallenge = -1, firstPayoff = -1;
        for (const ph of CHALLENGE_STATEMENT_PHRASES) {
            const idx = tl.indexOf(ph);
            if (idx !== -1) firstChallenge = firstChallenge === -1 ? idx : Math.min(firstChallenge, idx);
        }
        for (const ph of PAYOFF_SIGNAL_PHRASES) {
            const idx = tl.indexOf(ph);
            if (idx !== -1) firstPayoff = firstPayoff === -1 ? idx : Math.min(firstPayoff, idx);
        }
        if (firstChallenge === -1) firstChallenge = 0; // treat video start as implicit challenge
        if (firstPayoff === -1) return [null, 'no payoff signal'];
        return [Math.max(0, (firstPayoff - firstChallenge) / tl.length), null];
    }

    if (key === 'zygarnik_completion_ratio') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const loops_closed = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.closure);
        const loops_opened = countPhraseMatches(tl, ZYGARNIK_PHRASE_SETS.open_loop);
        return [loops_closed / Math.max(loops_opened, 1), null];
    }

    if (key === 'stakes_in_hook_flag') {
        if (!transcript) return [null, 'no transcript'];
        const words = transcript.split(/\s+/).filter(Boolean);
        const hookWords = words.slice(0, Math.max(1, Math.ceil(words.length * 0.1)));
        const hookLower = hookWords.join(' ').toLowerCase();
        const extraPhrases = ['on the line', 'last chance', 'must', 'need to', 'have to', 'or else', 'if i don', 'cost me'];
        const hasStake = ZYGARNIK_PHRASE_SETS.story_stake.some(p => hookLower.includes(p)) ||
                         extraPhrases.some(p => hookLower.includes(p));
        return [hasStake ? 1 : 0, null];
    }

    if (key === 'payoff_before_midpoint_flag') {
        if (!transcript) return [null, 'no transcript'];
        const tl = transcript.toLowerCase();
        const words = tl.split(/\s+/).filter(Boolean);
        if (!words.length) return [0, null];
        const payoffPhrases = [...ZYGARNIK_PHRASE_SETS.closure, 'result', 'proof', 'here it is', 'the answer', 'and it worked', 'look at this'];
        let firstPayoffWord = words.length;
        for (const phrase of payoffPhrases) {
            const idx = tl.indexOf(phrase);
            if (idx !== -1) {
                const wordIdx = tl.slice(0, idx).split(/\s+/).filter(Boolean).length;
                if (wordIdx < firstPayoffWord) firstPayoffWord = wordIdx;
            }
        }
        return [firstPayoffWord < words.length * 0.5 ? 1 : 0, null];
    }

    // ── Group W2: New curiosity/closure ratio metrics ──
    if (key === "early_curiosity_escalation_ratio") {
        const [full] = extractMetric("curiosity_escalation_count", analysis);
        const [early] = extractMetric("curiosity_escalation_count_first10s", analysis);
        if (!full || full === 0) return [null, "zero denominator"];
        return [(early || 0) / full, null];
    }
    if (key === "cliffhanger_front_load_ratio") {
        const [full] = extractMetric("cliffhanger_count", analysis);
        const [early] = extractMetric("cliffhanger_count_first10s", analysis);
        if (!full || full === 0) return [null, "zero denominator"];
        return [(early || 0) / full, null];
    }
    if (key === "revelation_front_load_ratio") {
        const [full] = extractMetric("revelation_signal_count", analysis);
        const [early] = extractMetric("revelation_signal_count_first10s", analysis);
        if (!full || full === 0) return [null, "zero denominator"];
        return [(early || 0) / full, null];
    }
    if (key === "curiosity_to_closure_ratio") {
        const [cesc] = extractMetric("curiosity_escalation_count", analysis);
        const [clos] = extractMetric("closure_count", analysis);
        if (!clos || clos === 0) return [(cesc || 0) > 0 ? 2.0 : null, (cesc || 0) > 0 ? null : "no curiosity or closure"];
        return [(cesc || 0) / clos, null];
    }
    if (key === "loop_payoff_density_gap") {
        const [openDens] = extractMetric("open_loop_density", analysis);
        const [payoffDens] = extractMetric("payoff_signal_density", analysis);
        return [Math.max(0, (openDens || 0) - (payoffDens || 0)), null];
    }
    if (key === "revelation_to_cliffhanger_ratio") {
        const [rev] = extractMetric("revelation_signal_count", analysis);
        const [cliff] = extractMetric("cliffhanger_count", analysis);
        if (!cliff || cliff === 0) return [(rev || 0) > 0 ? 2.0 : null, (rev || 0) > 0 ? null : "no signals"];
        return [(rev || 0) / cliff, null];
    }
    if (key === "payoff_tease_to_delivery_ratio") {
        const [tease] = extractMetric("payoff_tease_count", analysis);
        const [delivery] = extractMetric("payoff_signal_count", analysis);
        if (!delivery || delivery === 0) return [(tease || 0) > 0 ? 2.0 : null, (tease || 0) > 0 ? null : "no tease or delivery"];
        return [(tease || 0) / delivery, null];
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
    'hook_word_count', 'question_count',
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
        // Group Z: New challenge/tension/structural metrics
        'challenge_setup_density_first_quarter', 'narrative_tension_density_first_half',
        'answer_withhold_density_first_third', 'payoff_delay_score',
        'loop_front_half_density', 'resolution_density_second_half',
        'challenge_to_resolution_gap_pct',
    ]) { candidates.push(k); }

    // ── Group R: Retention-Curve Zygarnik metrics (priority atomics) ──
    for (const k of [
        'retention_zygarnik_arc', 'retention_recovery_ratio', 'retention_late_payoff',
        'retention_pre_payoff_drop', 'retention_hook_to_mid_ratio',
        'retention_setup_phase_mean', 'retention_open_loop_phase_mean',
        'retention_payoff_phase_mean', 'retention_tension_trough_pct', 'retention_arc_width',
    ]) { candidates.push(k); }

    // ── Group R cross-products: retention-curve × known good anchors ──
    const R_BASES = [
        'retention_zygarnik_arc', 'retention_recovery_ratio', 'retention_late_payoff',
        'retention_pre_payoff_drop', 'retention_hook_to_mid_ratio',
        'retention_setup_phase_mean', 'retention_open_loop_phase_mean',
        'retention_payoff_phase_mean',
    ];
    const GOOD_ANCHORS = [
        'open_loop_count', 'open_loop_to_closure_ratio', 'payoff_delay_score',
        'visual_proof_phrase_count', 'pre_gratification_open_loop_count',
        'hook_drop_rate', 'zygarnik_score', 'zygarnik_buildup_ratio',
        'open_loop_density', 'dangling_question_ratio', 'hook_tension_ratio',
        'gratification_delay_pct', 'promise_proof_gap_pct', 'non_sub_view_share',
        'title_number_flag', 'hook_open_loop_density', 'open_loop_count_first20s',
    ];
    for (const r of R_BASES) {
        for (const a of GOOD_ANCHORS) {
            const pk = `${r}_x_${a}`;
            const pk2 = `${a}_x_${r}`;
            candidates.push(pk);
            candidates.push(pk2);
        }
    }

    // ── Group X: High-signal zygarnik cross-products (top-r pairs, run before generic interaction loop) ──
    for (const k of [
        'pre_gratification_open_loop_count_x_open_loop_to_closure_ratio',
        'pre_gratification_open_loop_count_x_visual_proof_phrase_count',
        'open_loop_to_closure_ratio_x_proof_before_midpoint_flag',
        'pre_closure_open_loop_count_x_visual_proof_phrase_count',
        'open_loop_before_closure_flag_x_visual_proof_phrase_count',
        'zygarnik_gradient_pct_x_open_loop_to_closure_ratio',
        'zygarnik_gradient_pct_x_pre_gratification_open_loop_count',
        'zygarnik_buildup_ratio_x_pre_gratification_open_loop_count',
        'zygarnik_buildup_ratio_x_open_loop_to_closure_ratio',
        'loop_to_closure_gap_s_x_pre_gratification_open_loop_count',
        'stakes_reinforcement_count_x_open_loop_to_closure_ratio',
        'stakes_reinforcement_count_x_pre_gratification_open_loop_count',
        'proof_before_midpoint_flag_x_pre_gratification_open_loop_count',
        'open_loop_count_first20s_x_visual_proof_phrase_count',
        // Group Z priority pairs
        'challenge_statement_count_x_open_loop_count',
        'challenge_statement_count_x_pre_gratification_open_loop_count',
        'challenge_statement_density_x_open_loop_to_closure_ratio',
        'payoff_delay_score_x_open_loop_count',
        'payoff_delay_score_x_pre_gratification_open_loop_count',
        'narrative_tension_count_x_open_loop_count',
        'narrative_tension_density_x_pre_gratification_open_loop_count',
        'challenge_to_resolution_gap_pct_x_open_loop_count',
        'challenge_to_resolution_gap_pct_x_pre_gratification_open_loop_count',
        'loop_front_half_density_x_resolution_density_second_half',
        'answer_withhold_density_first_third_x_open_loop_count',
        'challenge_statement_count_x_non_sub_view_share',
        'narrative_tension_count_x_non_sub_view_share',
        'payoff_delay_score_x_non_sub_view_share',
        // Group AA priority pairs: new families × top-signal anchors
        'tension_builder_count_x_gratification_delay_pct',
        'implicit_promise_count_x_gratification_delay_pct',
        'implicit_promise_count_x_proof_arrival_delay_proxy',
        'implicit_promise_density_x_open_loop_to_closure_ratio',
        'progressive_reveal_count_x_open_loop_count',
        'progressive_reveal_count_x_pre_gratification_open_loop_count',
        'loop_reinforcer_count_x_open_loop_to_closure_ratio',
        'loop_reinforcer_count_x_pre_gratification_open_loop_count',
        'consequence_language_count_x_open_loop_count',
        'consequence_language_count_x_gratification_delay_pct',
        'outcome_tease_count_x_gratification_delay_pct',
        'outcome_tease_count_x_proof_arrival_delay_proxy',
        'outcome_tease_density_x_open_loop_to_closure_ratio',
        'proof_signal_count_x_early_proof_position_pct',
        'proof_signal_count_x_proof_arrival_delay_proxy',
        'proof_signal_density_x_gratification_delay_pct',
        'setup_anchor_count_x_open_loop_count',
        'setup_anchor_count_x_gratification_delay_pct',
        'tension_builder_count_x_open_loop_to_closure_ratio',
        'tension_builder_density_first10s_x_gratification_delay_pct',
        'implicit_promise_count_first10s_x_open_loop_to_closure_ratio',
        'proof_signal_count_first10s_x_gratification_delay_pct',
        'consequence_language_count_first10s_x_proof_arrival_delay_proxy',
        'outcome_tease_count_first10s_x_pre_gratification_open_loop_count',
        'loop_reinforcer_count_x_early_proof_position_pct',
        'progressive_reveal_count_first10s_x_gratification_delay_pct',
        'setup_anchor_count_first10s_x_open_loop_to_closure_ratio',
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
    // (Removed: frame-analysis and segment-dependent candidates — no LLM prompt provenance)
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
        "proof_before_midpoint_flag",
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
    'pre_upload_mechanism_count', 'pre_upload_mechanism_density',
    'pre_upload_mechanism_count_hook', 'pre_upload_mechanism_front_load_ratio', 'pre_upload_mechanism_position_pct',
    'reference_to_gratification_ratio', 'setup_to_payoff_gap',
]) {
    INDICATOR_RESOLUTION_MAP[k] = k.includes('hook') ? ['r_hook', 0, 10, null, null] : ['r0', 0, 100, null, null];
}
// Group V windowed variant resolution map
for (const fam of ['early_proof', 'social_signal', 'pre_upload_credibility', 'pre_upload_mechanism', 'teaser_signal', 'anticipation_escalation', 'proof_delay', 'open_question_setup', 'visual_anchor']) {
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


/**
 * Returns the provenance type for a given metric key.
 * All currently registered metrics are 'deterministic' (no LLM dependency).
 * Future LLM-scored metrics must be added with type 'llm_scored' and include
 * full provenance: { prompt, model, temperature, timestamp, input_fields }.
 */
function getProvenanceType(key) {
    const def = getMetricDefinition(key);
    if (!def) return null;
    // All surviving metrics are deterministic (transcript phrase-matching,
    // retention curve reads, engagement stats, metadata parsing)
    return 'deterministic';
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
    // Provenance
    getProvenanceType,
    // Constants
    RETENTION_POINTS, RETENTION_WINDOWS, DAILY_VIEWS_WINDOWS, DAILY_VIEWS_RATIOS,
    INTERACTION_BASES, STATIC_KEYS,
};
