(function (root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) root.JarvisStoryboardStylePresets = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_STYLE_ID = 'photographic';
    const ANIMATION_STYLE_ID = 'stylized-3d-explainer-v1';

    const ANIMATION_PROMPT_CONTRACT = [
        'VISUAL STYLE PRESET: STYLIZED 3D EXPLAINER, VERSION 1.',
        'Apply this style to the requested content only. Do not introduce any '
            + 'object, action, setting, text, or story event that the scene '
            + 'description does not call for.',
        'RENDERING LANGUAGE: clean real-time 3D animation resembling a polished '
            + 'game-engine previs render. Use simplified geometry, smooth '
            + 'surfaces, soft ambient occlusion, broad global illumination, '
            + 'subtle contact shadows, restrained reflections, and a mild '
            + 'pastel bloom. The result is dimensional and physically legible '
            + 'but intentionally not photorealistic, painterly, illustrated, '
            + 'anime, cel-shaded, claymation, or stop-motion.',
        'RECURRING HUMAN CHARACTER BIBLE: unless the scene explicitly requires '
            + 'a different cast, use one adult masculine mannequin with a '
            + 'smooth featureless peach-beige ovoid head, no eyes, mouth, nose, '
            + 'ears, hair, facial texture, or facial expression. Give him '
            + 'consistent average-tall proportions, a fitted plain black '
            + 'short-sleeve crew-neck shirt, slim black trousers, and simple '
            + 'black shoes. Hands remain simplified but readable. Preserve the '
            + 'exact body proportions, skin tone, clothing silhouette, and '
            + 'wardrobe across all five frames. Express intent through a clear '
            + 'body pose and silhouette rather than a face.',
        'OBJECT BIBLE: make the main device or object a bold, chunky, toy-like '
            + '3D construction with an immediately readable silhouette. Use '
            + 'large geometric parts, clean joins, slightly softened edges, '
            + 'matte-to-satin plastic or painted-metal surfaces, and a small '
            + 'number of high-saturation accent colors. Establish its exact '
            + 'shape, dimensions, color blocking, materials, attachments, and '
            + 'damage state on first appearance, then reproduce those facts '
            + 'without redesigning it in later frames. Keep realistic objects '
            + 'recognizable while simplifying nonessential surface detail.',
        'WORLD BIBLE: default to an uncluttered pale powder-blue virtual studio '
            + 'with a blue floor plane, thin white perspective grid lines, a '
            + 'soft blue-white horizon, and airy atmospheric falloff. When the '
            + 'story requires a real location, reduce that location to a few '
            + 'large clean architectural forms while retaining the same '
            + 'material simplicity, bright exposure, and visual grammar. Keep '
            + 'backgrounds sparse so the action reads instantly.',
        'LIGHT AND COLOR: use high-key cool daylight, a soft frontal key, broad '
            + 'sky fill, gentle rim separation, low-to-moderate contrast, and '
            + 'very soft shadows. Keep the environment pale blue, white, and '
            + 'light gray so saturated props and effects dominate. Energy, '
            + 'fire, sparks, or impact effects use a white-hot center, saturated '
            + 'colored fringe, strong but controlled bloom, and a readable '
            + 'direction of travel. Never crush shadows or use a dark cinematic '
            + 'grade.',
        'CAMERA AND COMPOSITION: stage each vertical frame as one instantly '
            + 'readable action beat. Prefer a neutral eye-to-chest-height '
            + 'camera, a moderate-wide 28-40 mm equivalent lens, generous '
            + 'negative space, and a full-body or waist-up view chosen to make '
            + 'the interaction obvious. Use exaggerated scale only when the '
            + 'story calls for it. Keep horizon, screen direction, character '
            + 'handedness, object orientation, and relative scale continuous '
            + 'from frame to frame. Avoid extreme depth of field, dutch angles, '
            + 'busy compositions, tiny subjects, and ornamental camera moves.',
        'MOTION LANGUAGE: poses should resemble clean keyframes from a 3D '
            + 'animation: slightly stiff but purposeful joint articulation, '
            + 'strong silhouettes, one dominant action per frame, and obvious '
            + 'cause-and-effect progression. Preserve the state produced by '
            + 'each action in every later frame.',
        'FIVE-FRAME CONTINUITY LOCK: treat the five panels as consecutive shots '
            + 'from one animation. Reuse the exact same character model, object '
            + 'model, palette, world, light direction, rendering pipeline, and '
            + 'scale logic. Do not drift toward realism, add facial features, '
            + 'change wardrobe, recolor or rebuild a prop, replace the setting, '
            + 'or reset physical state between panels unless the user explicitly '
            + 'requests that change.',
        'EXCLUSIONS: no captions, subtitles, logos, interface elements, numbers, '
            + 'watermarks, split screens, comic panels, line art, visible mesh '
            + 'wireframes, photoreal human faces, skin pores, detailed hair, '
            + 'crowds, background clutter, or unrequested branded products.',
    ].join('\n');

    const PRESETS = Object.freeze({
        [DEFAULT_STYLE_ID]: Object.freeze({
            id: DEFAULT_STYLE_ID,
            label: 'Live action',
            promptContract: '',
        }),
        [ANIMATION_STYLE_ID]: Object.freeze({
            id: ANIMATION_STYLE_ID,
            label: 'Animation',
            promptContract: ANIMATION_PROMPT_CONTRACT,
        }),
    });

    function normalizeStylePreset(value) {
        return Object.prototype.hasOwnProperty.call(PRESETS, value)
            ? value
            : DEFAULT_STYLE_ID;
    }

    function stylePreset(value) {
        return PRESETS[normalizeStylePreset(value)];
    }

    return Object.freeze({
        ANIMATION_STYLE_ID,
        DEFAULT_STYLE_ID,
        PRESETS,
        normalizeStylePreset,
        stylePreset,
    });
}));
