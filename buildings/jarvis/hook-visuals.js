/**
 * hook-visuals.js — the operationalized visual hook knowledge base, distilled
 * from frame-analysis of this channel's high- vs low-swipe-through openings.
 *
 * The VISUAL is half the hook. These are the mechanisms that make a first frame
 * un-swipeable, the proven visual components to draw from, and the anti-patterns
 * that get videos swiped — fed to Kimi as the natural context for designing the
 * opening shot, the same way the spoken principles drive the line.
 */

// The 0.1-second decision: the brain asks "is this something I've NEVER seen,
// with a human in it, doing something impossible or dangerous, in clean colors?"
const FRAME_TEST = 'In the first 0.1s the viewer asks: have I never seen this before + is a human in it + is something impossible/dangerous about to happen + is it clean and high-contrast? If yes → they stay.';

// Core principles of an un-swipeable first frame.
const VISUAL_PRINCIPLES = [
    'ONE clear visual contradiction — object + WRONG material, OR impossible scale next to a human, OR an action on an impossible surface. The frame poses a question with zero words.',
    'A human hand or body in frame — gives scale and an emotional anchor (will THEY be okay?). The viewer must be able to feel the stakes on a person.',
    'Frozen or about-to-happen motion — mid-air, mid-cut, mid-pull, the instant BEFORE impact/launch/release. Tension lives in the moment before resolution.',
    'Visible stakes / danger — something could break, burn, fall, launch, crush, or hurt someone. Survival or destruction is implied.',
    'Novelty on the apparatus itself — the switch, button, launcher, box, trap, or weapon is oversized, strange, or home-built, and what it implies is bigger than the object.',
    'Strong material/color contrast — hot vs cold, hard vs soft, metallic vs organic, one bold color on a clean field.',
    'Clean background, NO text — the visual IS the hook; nothing to read, no clutter, no desk/bedroom.'
];

// What gets videos SWIPED — never open on these.
const VISUAL_ANTIPATTERNS = [
    'a talking head / seated person just explaining',
    'a bedroom, desk, or domestic background',
    'text overlays the viewer has to read instead of see',
    'series markers ("Part 3", "Day 2") that imply they already missed something',
    'a frame with no visual question — nothing to wonder about'
];

// Proven visual COMPONENTS — the working mechanisms, each tagged with the tension
// it creates. The model picks and adapts these to the video, then makes the
// apparatus novel.
const VISUAL_COMPONENTS = [
    'Holding up a car while someone is trapped underneath — impossible strength + rescue stakes',
    'Lighting a fuse on a strange device — novelty on the device + an event about to fire',
    'A giant switch to pull / a giant button to press — novelty + dread of what it triggers',
    'A large speeding object (car, train, wrecking ball) moving toward the camera — impending impact',
    'A weapon swung at the head with novelty on the helmet/weapon — a survival test',
    'Hanging from a great height, or dropping an object from a great height — gravity + consequence',
    'Loading and firing a launcher — novelty on the launcher AND the implication of what it launches',
    'Slow-mo blade cutting through something, or a giant balloon popped in slow-mo — destruction frozen',
    'Activating a bear trap, then walking toward another — credibility of having to survive it',
    'Opening a huge mystery box / a massive piñata / pulling a mystery item from a jar — a reveal loop',
    'A massive object toppling as if about to land on the creator — impending crush',
    'A wheel or continuous motion that must land on an outcome — suspense resolving to a result',
    'An everyday object made of the WRONG material (a Rubik\'s cube of meat, boots of butter) — cognitive dissonance',
    'A visible, irreversible body transformation (an arm covered in magnets, a hand in liquid nitrogen) — visceral stakes',
    'A giant version of an everyday object beside a human for scale — comprehension + absurdity',
    'Fraying a rope you hang from with a knife, or a single domino the size of a car about to be hit — frozen one-way tension'
];

function block() {
    return [
        '=== VISUAL HOOK MECHANICS (the opening shot is half the hook — design it with these) ===',
        FRAME_TEST,
        '\nAn un-swipeable first frame has:',
        VISUAL_PRINCIPLES.map(p => '• ' + p).join('\n'),
        '\nProven visual components to adapt to this video (then make the apparatus novel):',
        VISUAL_COMPONENTS.map(c => '• ' + c).join('\n'),
        '\nNEVER open on (these get swiped): ' + VISUAL_ANTIPATTERNS.join('; ') + '.',
        '=== END VISUAL MECHANICS ==='
    ].join('\n');
}

module.exports = { block, VISUAL_PRINCIPLES, VISUAL_COMPONENTS, VISUAL_ANTIPATTERNS, FRAME_TEST };
