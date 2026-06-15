/**
 * EggRenderer — shared 3D/SVG rendering utilities for videos & projects.
 * Eggs, creatures, character avatars, project flags/badges, inline script
 * editor, and the reveal/hatch animations. Used by Workshop, Pen, Library.
 * (Extracted from the retired Incubator building.)
 */
(() => {
    const escHtml = HtmlUtils.escHtml;

    const GEO_GENERATORS = ['chevrons','octogons','overlappingCircles','plusSigns','xes','sineWaves','hexagons','overlappingRings','plaid','triangles','squares','nestedSquares','mosaicSquares','concentricCircles','diamonds','tessellation'];

    // Silhouette egg SVG (black egg with "?" — used for drafts / ungenerated eggs)
    function renderSilhouetteEgg() {
        return `<svg viewBox="0 0 60 70" class="incubator-egg-svg incubator-silhouette-egg">
            <ellipse cx="30" cy="38" rx="22" ry="28" fill="#2d2d2d" stroke="#1a1a1a" stroke-width="1.5"/>
            <ellipse cx="30" cy="38" rx="22" ry="28" fill="url(#silShine)" opacity="0.15"/>
            <text x="30" y="44" text-anchor="middle" font-size="22" font-weight="700" fill="#888">?</text>
            <defs><radialGradient id="silShine" cx="40%" cy="30%"><stop offset="0%" stop-color="white" stop-opacity="0.3"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs>
        </svg>`;
    }

    // Same color algorithm as project flags (index.html)
    function getProjectColor(project) {
        if (!project) return '#d4cfc4';
        const rng = seededRng(hashString(project));
        const hue = Math.floor(rng() * 360);
        const sat = 65 + Math.floor(rng() * 30);
        const lit = 40 + Math.floor(rng() * 20);
        const h = hue, s = sat / 100, l = lit / 100;
        const k = n => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
        return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
    }

    function makeEggTexture(project) {
        if (typeof GeoPattern === 'undefined' || !project) return null;
        const color = getProjectColor(project);
        const gen = GEO_GENERATORS[Math.abs(hashString(project)) % GEO_GENERATORS.length];
        const pattern = GeoPattern.generate(project, { color, generator: gen });
        const svgStr = pattern.toSvg();
        const blob = new Blob([svgStr], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);

        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const img = new Image();

        const T = window.THREE;
        const tex = new T.CanvasTexture(canvas);
        tex.colorSpace = T.SRGBColorSpace;

        img.onload = () => {
            ctx.drawImage(img, 0, 0, 256, 256);
            URL.revokeObjectURL(url);
            tex.needsUpdate = true;
        };
        img.src = url;
        return tex;
    }

    function makeEggTextureSync(project) {
        if (typeof GeoPattern === 'undefined' || !project) return null;
        const color = getProjectColor(project);
        const gen = GEO_GENERATORS[Math.abs(hashString(project)) % GEO_GENERATORS.length];
        const pattern = GeoPattern.generate(project, { color, generator: gen });
        const svgStr = pattern.toSvg();

        const T = window.THREE;
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 256, 256);

        const tex = new T.CanvasTexture(canvas);
        tex.colorSpace = T.SRGBColorSpace;

        const blob = new Blob([svgStr], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        tex._loaded = false;
        tex._loadPromise = new Promise(resolve => {
            img.onload = () => {
                ctx.drawImage(img, 0, 0, 256, 256);
                URL.revokeObjectURL(url);
                tex.needsUpdate = true;
                tex._loaded = true;
                resolve();
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        });
        img.src = url;
        return tex;
    }

    // Render a small animated 3D egg preview in a canvas (for detail views)
    function initEggPreview(canvasId, project) {
        const T = window.THREE;
        if (!T) return;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const previewRenderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
        previewRenderer.setClearColor(0x000000, 0);
        previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        previewRenderer.setSize(160, 200);

        const previewScene = new T.Scene();
        const previewCam = new T.PerspectiveCamera(40, 160 / 200, 0.1, 50);
        previewCam.position.set(0, 0.3, 2.5);
        previewCam.lookAt(0, 0.2, 0);

        previewScene.add(new T.AmbientLight(0xfff5e6, 0.7));
        const dirLight = new T.DirectionalLight(0xffffff, 0.9);
        dirLight.position.set(3, 5, 4);
        previewScene.add(dirLight);

        const color = getProjectColor(project);
        const eggGeo = new T.SphereGeometry(0.5, 24, 24);
        eggGeo.scale(1, 1.4, 1);

        const matOpts = { roughness: 0.4, emissive: new T.Color(color), emissiveIntensity: 0.05 };
        const patternTex = makeEggTexture(project);
        if (patternTex) {
            matOpts.map = patternTex;
            matOpts.color = new T.Color(0xffffff);
        } else {
            matOpts.color = new T.Color(color);
        }
        const eggMat = new T.MeshStandardMaterial(matOpts);
        const egg = new T.Mesh(eggGeo, eggMat);

        const outlineMat = new T.ShaderMaterial({
            side: T.BackSide,
            uniforms: { w: { value: 0.02 }, col: { value: new T.Color(0x8b6914) } },
            vertexShader: `uniform float w; void main(){ vec3 p=position+normal*w; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
            fragmentShader: `uniform vec3 col; void main(){ gl_FragColor=vec4(col,1.0); }`
        });
        egg.add(new T.Mesh(eggGeo, outlineMat));
        previewScene.add(egg);

        const startTime = performance.now();
        let frameId;
        function animate() {
            frameId = requestAnimationFrame(animate);
            const t = (performance.now() - startTime) / 1000;
            egg.rotation.z = Math.sin(t * 1.2) * 0.06;
            egg.rotation.x = Math.cos(t * 0.9) * 0.04;
            previewRenderer.render(previewScene, previewCam);
        }
        animate();

        canvas._cleanup = () => {
            cancelAnimationFrame(frameId);
            previewRenderer.dispose();
        };
    }

    // Show egg reveal animation overlay (e.g. after queueing a new video)
    function showEggReveal(project, containerEl, onDone, labelText) {
        if (!containerEl) { if (onDone) onDone(); return; }
        const displayLabel = labelText || 'Egg Created!';
        const overlay = document.createElement('div');
        overlay.className = 'incubator-reveal-overlay';

        overlay.innerHTML = `
            <div class="incubator-reveal-content">
                <div class="incubator-reveal-silhouette">
                    <svg viewBox="0 0 60 70" class="incubator-egg-svg">
                        <ellipse cx="30" cy="38" rx="22" ry="28" fill="#2d2d2d" stroke="#1a1a1a" stroke-width="1.5"/>
                        <text x="30" y="44" text-anchor="middle" font-size="22" font-weight="700" fill="#888">?</text>
                    </svg>
                </div>
                <canvas id="incubator-reveal-canvas" class="incubator-reveal-canvas" width="200" height="250"></canvas>
                <div class="incubator-reveal-label">${escHtml(displayLabel)}</div>
            </div>
        `;
        containerEl.appendChild(overlay);

        setTimeout(() => {
            overlay.classList.add('revealing');
            initEggPreview('incubator-reveal-canvas', project);
        }, 600);

        setTimeout(() => {
            overlay.classList.add('done');
            setTimeout(() => {
                const canvasEl = document.getElementById('incubator-reveal-canvas');
                if (canvasEl && canvasEl._cleanup) canvasEl._cleanup();
                overlay.remove();
                if (onDone) onDone();
            }, 400);
        }, 2200);
    }

    // Show egg hatch animation (egg wobbles, cracks, creature emerges)
    function showHatchAnimation(project, containerEl, onDone) {
        const overlay = document.createElement('div');
        overlay.className = 'egg-hatch-overlay';

        const color = getProjectColor(project);
        overlay.innerHTML = `
            <div class="egg-hatch-content">
                <canvas id="egg-hatch-canvas" class="egg-hatch-canvas" width="240" height="300"></canvas>
                <div class="egg-hatch-label" id="egg-hatch-label">Hatched!</div>
            </div>
        `;
        containerEl.appendChild(overlay);

        const canvas = document.getElementById('egg-hatch-canvas');
        const label = document.getElementById('egg-hatch-label');
        if (!canvas) return;

        const T = window.THREE;
        if (!T) { overlay.remove(); if (onDone) onDone(); return; }

        const r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
        r.setClearColor(0x000000, 0);
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.setSize(240, 300);

        const s = new T.Scene();
        const cam = new T.PerspectiveCamera(40, 240 / 300, 0.1, 50);
        cam.position.set(0, 0.3, 3.2);
        cam.lookAt(0, 0.2, 0);

        s.add(new T.AmbientLight(0xfff5e6, 0.7));
        const dl = new T.DirectionalLight(0xffffff, 0.9);
        dl.position.set(3, 5, 4);
        s.add(dl);

        // Egg
        const eggGeo = new T.SphereGeometry(0.5, 24, 24);
        eggGeo.scale(1, 1.4, 1);
        const patternTex = makeEggTextureSync(project);
        const matOpts = { roughness: 0.4, emissive: new T.Color(color), emissiveIntensity: 0.05 };
        if (patternTex) { matOpts.map = patternTex; matOpts.color = new T.Color(0xffffff); }
        else { matOpts.color = new T.Color(color); }
        const eggMat = new T.MeshStandardMaterial(matOpts);
        const egg = new T.Mesh(eggGeo, eggMat);
        s.add(egg);

        // Shell fragments (hidden initially)
        const fragments = [];
        const fragGeo = new T.BoxGeometry(0.12, 0.12, 0.04);
        for (let i = 0; i < 12; i++) {
            const fMat = new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.6 });
            const frag = new T.Mesh(fragGeo, fMat);
            frag.visible = false;
            const angle = (i / 12) * Math.PI * 2;
            frag.userData.vel = new T.Vector3(Math.cos(angle) * (1.5 + Math.random()), 2 + Math.random() * 2, Math.sin(angle) * (1.5 + Math.random()));
            frag.userData.rotVel = new T.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10);
            s.add(frag);
            fragments.push(frag);
        }

        // Creature (body + eyes) — hidden initially
        const creatureGroup = new T.Group();
        creatureGroup.visible = false;
        creatureGroup.scale.set(0.01, 0.01, 0.01);

        const bodyGeo = new T.SphereGeometry(0.35, 24, 24);
        const bodyMat = new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.5 });
        const body = new T.Mesh(bodyGeo, bodyMat);
        creatureGroup.add(body);

        const eyeWhiteGeo = new T.SphereGeometry(0.1, 12, 12);
        const eyeWhiteMat = new T.MeshBasicMaterial({ color: 0xffffff });
        const pupilGeo = new T.SphereGeometry(0.06, 12, 12);
        const pupilMat = new T.MeshBasicMaterial({ color: 0x1a1a2e });
        [[-0.14, 0.08, 0.28], [0.14, 0.08, 0.28]].forEach(([x, y, z]) => {
            const ew = new T.Mesh(eyeWhiteGeo, eyeWhiteMat);
            ew.position.set(x, y, z);
            creatureGroup.add(ew);
            const ep = new T.Mesh(pupilGeo, pupilMat);
            ep.position.set(x, y, z + 0.05);
            creatureGroup.add(ep);
        });
        s.add(creatureGroup);

        const startTime = performance.now();
        let frameId;

        function animate() {
            frameId = requestAnimationFrame(animate);
            const elapsed = (performance.now() - startTime) / 1000;

            if (elapsed < 0.8) {
                const intensity = elapsed / 0.8;
                egg.rotation.z = Math.sin(elapsed * 15) * 0.08 * intensity;
                egg.rotation.x = Math.cos(elapsed * 12) * 0.05 * intensity;
            } else if (elapsed < 1.6) {
                egg.rotation.z = Math.sin(elapsed * 30) * 0.15;
                egg.rotation.x = Math.cos(elapsed * 25) * 0.1;
                egg.position.x = Math.sin(elapsed * 40) * 0.03;
            } else if (elapsed < 2.4) {
                if (egg.visible) {
                    egg.visible = false;
                    fragments.forEach(f => {
                        f.visible = true;
                        f.position.set(0, 0.2, 0);
                    });
                    creatureGroup.visible = true;
                }
                const breakT = elapsed - 1.6;
                const dt = 0.016;
                fragments.forEach(f => {
                    f.position.add(f.userData.vel.clone().multiplyScalar(dt));
                    f.userData.vel.y -= 9.8 * dt;
                    f.rotation.x += f.userData.rotVel.x * dt;
                    f.rotation.y += f.userData.rotVel.y * dt;
                    f.material.opacity = Math.max(0, 1 - breakT * 1.5);
                    f.material.transparent = true;
                });
                const scale = Math.min(1, breakT / 0.6);
                creatureGroup.scale.set(scale, scale, scale);
            } else {
                const idleT = elapsed - 2.4;
                creatureGroup.position.y = Math.sin(idleT * 3) * 0.05;
                fragments.forEach(f => { f.visible = false; });
                if (label && !label.classList.contains('visible')) {
                    label.classList.add('visible');
                }
            }

            r.render(s, cam);
        }
        animate();

        setTimeout(() => {
            overlay.classList.add('done');
            setTimeout(() => {
                cancelAnimationFrame(frameId);
                eggGeo.dispose(); eggMat.dispose();
                fragGeo.dispose();
                fragments.forEach(f => f.material.dispose());
                bodyGeo.dispose(); bodyMat.dispose();
                eyeWhiteGeo.dispose(); eyeWhiteMat.dispose();
                pupilGeo.dispose(); pupilMat.dispose();
                if (patternTex) patternTex.dispose();
                r.dispose();
                overlay.remove();
                if (onDone) onDone();
            }, 400);
        }, 3200);
    }

    async function renderEggSnapshot(project, canvas, size) {
        const T = window.THREE;
        if (!T || !canvas) return;

        const w = size || 50;
        const h = Math.round(w * 1.24);
        canvas.width = w * 2;
        canvas.height = h * 2;

        const color = getProjectColor(project);

        const patternTex = makeEggTextureSync(project);
        if (patternTex && patternTex._loadPromise) {
            await patternTex._loadPromise;
        }

        const r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
        r.setClearColor(0x000000, 0);
        r.setPixelRatio(1);
        r.setSize(w * 2, h * 2);

        const s = new T.Scene();
        const cam = new T.PerspectiveCamera(40, w / h, 0.1, 50);
        cam.position.set(0, 0.3, 2.5);
        cam.lookAt(0, 0.2, 0);

        s.add(new T.AmbientLight(0xfff5e6, 0.7));
        const dl = new T.DirectionalLight(0xffffff, 0.9);
        dl.position.set(3, 5, 4);
        s.add(dl);

        const eggGeo = new T.SphereGeometry(0.5, 24, 24);
        eggGeo.scale(1, 1.4, 1);

        const matOpts = { roughness: 0.4, emissive: new T.Color(color), emissiveIntensity: 0.05 };
        if (patternTex) {
            matOpts.map = patternTex;
            matOpts.color = new T.Color(0xffffff);
        } else {
            matOpts.color = new T.Color(color);
        }
        const egg = new T.Mesh(eggGeo, new T.MeshStandardMaterial(matOpts));

        const outlineMat = new T.ShaderMaterial({
            side: T.BackSide,
            uniforms: { w: { value: 0.02 }, col: { value: new T.Color(0x8b6914) } },
            vertexShader: `uniform float w; void main(){ vec3 p=position+normal*w; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
            fragmentShader: `uniform vec3 col; void main(){ gl_FragColor=vec4(col,1.0); }`
        });
        egg.add(new T.Mesh(eggGeo, outlineMat));
        s.add(egg);

        r.render(s, cam);

        eggGeo.dispose();
        egg.material.dispose();
        outlineMat.dispose();
        if (patternTex) patternTex.dispose();
        r.dispose();
    }

    // Shared offscreen renderer — avoids creating multiple WebGL contexts (which kills the main 3D world)
    let _sharedRenderer = null;
    let _sharedCanvas = null;

    function _getSharedRenderer(w, h) {
        const T = window.THREE;
        if (!_sharedCanvas) {
            _sharedCanvas = document.createElement('canvas');
        }
        _sharedCanvas.width = w;
        _sharedCanvas.height = h;
        if (!_sharedRenderer || _sharedRenderer.getContext().isContextLost()) {
            if (_sharedRenderer) _sharedRenderer.dispose();
            _sharedRenderer = new T.WebGLRenderer({ canvas: _sharedCanvas, antialias: true, alpha: true });
        }
        _sharedRenderer.setClearColor(0x000000, 0);
        _sharedRenderer.setPixelRatio(1);
        _sharedRenderer.setSize(w, h);
        return _sharedRenderer;
    }

    function renderCreatureSnapshot(project, canvas, size, opts) {
        const T = window.THREE;
        if (!T || !canvas) return;
        const ghost = opts && opts.ghost;

        const w = size || 50;
        canvas.width = w * 2;
        canvas.height = w * 2;

        const color = ghost ? '#ffffff' : getProjectColor(project);

        // Use shared renderer (1 WebGL context) and copy to target canvas via 2D
        const sRenderer = _getSharedRenderer(w * 2, w * 2);

        const sc = new T.Scene();
        const cam = new T.PerspectiveCamera(36, 1, 0.1, 50);
        cam.position.set(0, 0.1, 2.2);
        cam.lookAt(0, 0, 0);

        sc.add(new T.AmbientLight(ghost ? 0xffffff : 0xfff5e6, ghost ? 1.0 : 0.7));
        const dl = new T.DirectionalLight(0xffffff, ghost ? 1.0 : 0.9);
        dl.position.set(3, 5, 4);
        sc.add(dl);

        const bodyGeo = new T.SphereGeometry(0.4, 24, 24);
        const bodyMat = new T.MeshStandardMaterial({
            color: new T.Color(color), roughness: ghost ? 0.3 : 0.85,
            transparent: false, opacity: 1.0
        });
        const body = new T.Mesh(bodyGeo, bodyMat);
        sc.add(body);

        const eyeWhiteGeo = new T.SphereGeometry(0.11, 12, 12);
        const eyeWhiteMat = new T.MeshBasicMaterial({ color: 0xffffff });
        const pupilGeo = new T.SphereGeometry(0.065, 12, 12);
        const pupilMat = new T.MeshBasicMaterial({ color: 0x1a1a2e });
        const highlightGeo = new T.SphereGeometry(0.025, 8, 8);

        [[-0.15, 0.08, 0.32], [0.15, 0.08, 0.32]].forEach(([x, y, z]) => {
            const ew = new T.Mesh(eyeWhiteGeo, eyeWhiteMat); ew.position.set(x, y, z); sc.add(ew);
            const ep = new T.Mesh(pupilGeo, pupilMat); ep.position.set(x, y, z + 0.05); sc.add(ep);
            const eh = new T.Mesh(highlightGeo, eyeWhiteMat); eh.position.set(x + 0.03, y + 0.04, z + 0.09); sc.add(eh);
        });

        sRenderer.render(sc, cam);
        // Copy to target canvas via 2D context
        const ctx2d = canvas.getContext('2d');
        ctx2d.drawImage(_sharedCanvas, 0, 0);

        function disposeGeo() {
            bodyGeo.dispose(); bodyMat.dispose();
            eyeWhiteGeo.dispose(); eyeWhiteMat.dispose();
            pupilGeo.dispose(); pupilMat.dispose();
            highlightGeo.dispose();
        }

        if (!ghost && typeof GeoPattern !== 'undefined' && project) {
            const gen = GEO_GENERATORS[Math.abs(hashString(project)) % GEO_GENERATORS.length];
            const pattern = GeoPattern.generate(project, { color, generator: gen });
            const svgStr = pattern.toSvg();
            const blob = new Blob([svgStr], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const texCanvas = document.createElement('canvas');
                texCanvas.width = 256; texCanvas.height = 256;
                texCanvas.getContext('2d').drawImage(img, 0, 0, 256, 256);
                URL.revokeObjectURL(url);
                const tex = new T.CanvasTexture(texCanvas);
                tex.colorSpace = T.SRGBColorSpace;
                bodyMat.map = tex;
                bodyMat.color = new T.Color(0xffffff);
                bodyMat.needsUpdate = true;
                const sr = _getSharedRenderer(w * 2, w * 2);
                sr.render(sc, cam);
                ctx2d.drawImage(_sharedCanvas, 0, 0);
                tex.dispose();
                disposeGeo();
            };
            img.src = url;
        } else {
            disposeGeo();
        }
    }

    const CHARACTER_HEX = { 'You': 0x3498db, 'Robin': 0xe74c3c, 'Jordan': 0x9b59b6, 'Tennille': 0xff69b4 };

    function colorForEmployeeName(name) {
        if (window.EmployeeService) return window.EmployeeService.colorNumberForName(name);
        return CHARACTER_HEX[name] || 0x888888;
    }

    function renderCharacterAvatar(name, canvas, size, colorOverride) {
        const T = window.THREE;
        if (!T || !canvas) return;
        const color = colorOverride != null
            ? (typeof colorOverride === 'string' ? parseInt(colorOverride.replace('#', ''), 16) : colorOverride)
            : colorForEmployeeName(name);

        const w = size || 32;
        const res = w * 4;
        canvas.width = res;
        canvas.height = res;

        const r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
        r.setClearColor(0x000000, 0);
        r.setPixelRatio(1);
        r.setSize(res, res);

        const s = new T.Scene();
        const cam = new T.PerspectiveCamera(28, 1, 0.1, 50);
        cam.position.set(0, 1.7, 1.8);
        cam.lookAt(0, 1.6, 0);

        s.add(new T.AmbientLight(0xffffff, 0.7));
        const dl = new T.DirectionalLight(0xffffff, 0.9);
        dl.position.set(2, 4, 3);
        s.add(dl);
        const rimLight = new T.DirectionalLight(0xffffff, 0.3);
        rimLight.position.set(-2, 3, -1);
        s.add(rimLight);

        const cMat = new T.ShaderMaterial({
            uniforms: { uColor: { value: new T.Color(color) }, uRim: { value: new T.Color(0xffffff) }, uRimPow: { value: 2.5 } },
            vertexShader: `varying vec3 vN,vV;void main(){vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
            fragmentShader: `uniform vec3 uColor,uRim;uniform float uRimPow;varying vec3 vN,vV;void main(){float rim=1.0-max(0.0,dot(normalize(vN),normalize(vV)));rim=pow(rim,uRimPow)*0.6;vec3 col=uColor+uRim*rim;float NdotL=max(0.0,dot(normalize(vN),normalize(vec3(1,2,1))));col*=0.5+0.5*NdotL;gl_FragColor=vec4(col,1.0);}`
        });

        const geos = [];
        const headGeo = new T.SphereGeometry(0.38, 32, 32);
        const head = new T.Mesh(headGeo, cMat); head.position.y = 1.65; s.add(head); geos.push(headGeo);
        const neckGeo = new T.CylinderGeometry(0.15, 0.2, 0.2, 16);
        const neck = new T.Mesh(neckGeo, cMat); neck.position.y = 1.28; s.add(neck); geos.push(neckGeo);
        const eyeM = new T.MeshBasicMaterial({ color: 0x1a1a2e });
        const eyeW = new T.MeshBasicMaterial({ color: 0xffffff });
        const eyeGeos = [];
        [[-0.15, 1.72, 0.3], [0.15, 1.72, 0.3]].forEach(([x, y, z]) => {
            const ewGeo = new T.SphereGeometry(0.1, 16, 16);
            const ew = new T.Mesh(ewGeo, eyeW); ew.position.set(x, y, z); s.add(ew); eyeGeos.push(ewGeo);
            const epGeo = new T.SphereGeometry(0.07, 16, 16);
            const ep = new T.Mesh(epGeo, eyeM); ep.position.set(x, y, z + 0.04); s.add(ep); eyeGeos.push(epGeo);
            const ehGeo = new T.SphereGeometry(0.03, 8, 8);
            const eh = new T.Mesh(ehGeo, eyeW); eh.position.set(x + 0.03, y + 0.03, z + 0.08); s.add(eh); eyeGeos.push(ehGeo);
        });

        r.render(s, cam);

        geos.forEach(g => g.dispose());
        eyeGeos.forEach(g => g.dispose());
        cMat.dispose(); eyeM.dispose(); eyeW.dispose();
        r.dispose();
    }

    function projectFlagSvg(project, size, rectangular) {
        const sz = size || 20;
        if (typeof GeoPattern === 'undefined' || !project) return '';
        const color = getProjectColor(project);
        const gen = GEO_GENERATORS[Math.abs(hashString(project)) % GEO_GENERATORS.length];
        const pattern = GeoPattern.generate(project, { color, generator: gen });
        const svg = pattern.toSvg();
        const uid = 'fb' + Math.abs(hashString(project));
        if (rectangular) {
            const rid = 'r' + uid;
            return `<svg class="project-flag-svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}" xmlns="http://www.w3.org/2000/svg"><clipPath id="${rid}"><rect width="${sz}" height="${sz}" rx="3"/></clipPath><g clip-path="url(#${rid})"><foreignObject width="${sz}" height="${sz}">${svg}</foreignObject></g></svg>`;
        }
        return `<svg class="project-flag-svg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}" xmlns="http://www.w3.org/2000/svg"><clipPath id="c${uid}"><circle cx="${sz/2}" cy="${sz/2}" r="${sz/2}"/></clipPath><g clip-path="url(#c${uid})"><foreignObject width="${sz}" height="${sz}">${svg}</foreignObject></g></svg>`;
    }

    function projectBadgeHtml(project) {
        if (!project) return '';
        const color = getProjectColor(project);
        const flag = projectFlagSvg(project, 24);
        return `<span class="project-badge" style="border-left-color:${color}">${flag || `<span class="project-dot" style="background:${color}"></span>`}${escHtml(project)}</span>`;
    }

    function statusBadgeHtml(status) {
        if (!status) return '';
        const map = {
            incubator: { emoji: '\u{1F95A}', label: 'Pipeline',  cls: 'status-incubator' },
            workshop:  { emoji: '\u{1F528}', label: 'Pipeline',  cls: 'status-workshop' },
            pipeline:  { emoji: '\u{1F528}', label: 'Pipeline',  cls: 'status-workshop' },
            posted:    { emoji: '✅',    label: 'Posted',    cls: 'status-posted' }
        };
        const info = map[status] || { emoji: '', label: status, cls: '' };
        return `<span class="status-badge ${info.cls}">${info.emoji} ${info.label}</span>`;
    }

    function inlineScriptEditorHtml(containerId, label) {
        return `<div class="inline-script-editor" id="${containerId}">
            <div class="inline-script-header">
                <span class="inline-script-title">${escHtml(label || 'Script')}</span>
                <div class="inline-script-actions">
                    <button class="inline-script-fullscreen-btn" title="Fullscreen editing"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg></button>
                    <span class="inline-script-toggle">&#9654;</span>
                </div>
            </div>
            <div class="inline-script-body">
                <div class="inline-script-status" id="${containerId}-status">Saved</div>
                <textarea class="inline-script-textarea" id="${containerId}-textarea" placeholder="Start writing your script..."></textarea>
            </div>
        </div>`;
    }

    /**
     * Initialize inline script editor.
     * @param {string} containerId - DOM id of the editor container
     * @param {object} opts - { get: () => string, save: (text) => Promise }
     */
    function initInlineScriptEditor(containerId, opts) {
        const containerDiv = document.getElementById(containerId);
        if (!containerDiv) return;
        const header = containerDiv.querySelector('.inline-script-header');
        const textarea = document.getElementById(containerId + '-textarea');
        const statusEl = document.getElementById(containerId + '-status');
        let saveTimer = null;
        let dirty = false;

        // Load initial text
        textarea.value = opts.get() || '';
        autoResize();
        statusEl.textContent = 'Saved';
        statusEl.className = 'inline-script-status saved';

        header.addEventListener('click', () => {
            containerDiv.classList.toggle('expanded');
            if (containerDiv.classList.contains('expanded')) autoResize();
        });

        function autoResize() {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        }

        textarea.addEventListener('input', () => {
            autoResize();
            dirty = true;
            statusEl.textContent = 'Editing...';
            statusEl.className = 'inline-script-status';
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(doSave, 1500);
        });

        async function doSave() {
            if (!dirty) return;
            dirty = false;
            statusEl.textContent = 'Saving...';
            statusEl.className = 'inline-script-status saving';
            try {
                await opts.save(textarea.value);
                statusEl.textContent = 'Saved';
                statusEl.className = 'inline-script-status saved';
            } catch (e) {
                statusEl.textContent = 'Save failed';
                statusEl.className = 'inline-script-status';
                dirty = true;
                console.warn('Inline script: save failed', e);
            }
        }

        // Fullscreen editing overlay
        const fullscreenBtn = containerDiv.querySelector('.inline-script-fullscreen-btn');
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const overlay = document.createElement('div');
                overlay.className = 'library-script-overlay';
                overlay.innerHTML = `
                    <div class="library-script-overlay-header">
                        <span class="script-overlay-label">Script</span>
                        <span class="script-overlay-status"></span>
                        <button class="script-overlay-done">Done</button>
                    </div>
                    <textarea class="library-script-overlay-textarea"></textarea>
                `;
                const ta = overlay.querySelector('textarea');
                const overlayStatus = overlay.querySelector('.script-overlay-status');
                ta.value = textarea.value;
                document.body.appendChild(overlay);
                ta.focus();

                // Mirror save status into overlay
                const mirrorStatus = () => {
                    overlayStatus.textContent = statusEl.textContent;
                    overlayStatus.className = 'script-overlay-status' +
                        (statusEl.classList.contains('saved') ? ' saved' :
                         statusEl.classList.contains('saving') ? ' saving' : '');
                };
                mirrorStatus();
                const obs = new MutationObserver(mirrorStatus);
                obs.observe(statusEl, { childList: true, characterData: true, subtree: true });

                // Continuously sync edits to inline textarea and trigger save
                ta.addEventListener('input', () => {
                    textarea.value = ta.value;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                });

                overlay.querySelector('.script-overlay-done').addEventListener('click', () => {
                    textarea.value = ta.value;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    obs.disconnect();
                    overlay.remove();
                });
            });
        }

        return () => {
            if (saveTimer) { clearTimeout(saveTimer); doSave(); }
        };
    }

    window.EggRenderer = { getProjectColor, makeEggTexture, initEggPreview, renderSilhouetteEgg, renderEggSnapshot, renderCreatureSnapshot, renderCharacterAvatar, projectBadgeHtml, statusBadgeHtml, projectFlagSvg, inlineScriptEditorHtml, initInlineScriptEditor, showHatchAnimation, showEggReveal };
})();
