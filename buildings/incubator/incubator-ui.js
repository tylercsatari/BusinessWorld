/**
 * Incubator UI — 3D egg nest + script linker.
 * Eggs sit in a nest, colored/patterned by project.
 * Scripts are linkable Library objects (type: 'script'), not a plain textarea.
 */
const IncubatorUI = (() => {
    let container = null;
    let projects = [];
    let selectedVideo = null;
    let currentPage = 'list';
    let filterProject = '';
    let isDraft = false; // true when creating a new video (not yet saved to Notion)

    // 3D state
    let renderer3d = null, scene3d = null, camera3d = null, controls3d = null;
    let animFrameId = null;
    let eggMeshes = []; // { mesh, videoId }
    let nestGroup = null; // nest ring + floor + straw
    let raycaster3d = null, mouse3d = null;
    let hoveredEgg = null;

    const GEO_GENERATORS = ['chevrons','octogons','overlappingCircles','plusSigns','xes','sineWaves','hexagons','overlappingRings','plaid','triangles','squares','nestedSquares','mosaicSquares','concentricCircles','diamonds','tessellation'];

    const escHtml = NotionHelpers.escHtml;
    const escAttr = NotionHelpers.escAttr;

    // Silhouette egg SVG (black egg with "?" — used for drafts / ungenerated eggs)
    function renderSilhouetteEgg() {
        return `<svg viewBox="0 0 60 70" class="incubator-egg-svg incubator-silhouette-egg">
            <ellipse cx="30" cy="38" rx="22" ry="28" fill="#2d2d2d" stroke="#1a1a1a" stroke-width="1.5"/>
            <ellipse cx="30" cy="38" rx="22" ry="28" fill="url(#silShine)" opacity="0.15"/>
            <text x="30" y="44" text-anchor="middle" font-size="22" font-weight="700" fill="#888">?</text>
            <defs><radialGradient id="silShine" cx="40%" cy="30%"><stop offset="0%" stop-color="white" stop-opacity="0.3"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs>
        </svg>`;
    }

    // Render a small 3D egg preview in a canvas (for saved video detail view)
    function renderEggPreviewCanvas(project, canvasId) {
        return `<canvas id="${canvasId}" class="incubator-egg-preview-canvas" width="160" height="200"></canvas>`;
    }

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

        // Lighting
        previewScene.add(new T.AmbientLight(0xfff5e6, 0.7));
        const dirLight = new T.DirectionalLight(0xffffff, 0.9);
        dirLight.position.set(3, 5, 4);
        previewScene.add(dirLight);

        // Egg
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

        // Outline
        const outlineMat = new T.ShaderMaterial({
            side: T.BackSide,
            uniforms: { w: { value: 0.02 }, col: { value: new T.Color(0x8b6914) } },
            vertexShader: `uniform float w; void main(){ vec3 p=position+normal*w; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
            fragmentShader: `uniform vec3 col; void main(){ gl_FragColor=vec4(col,1.0); }`
        });
        egg.add(new T.Mesh(eggGeo, outlineMat));
        previewScene.add(egg);

        // Gentle wobble animation
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

        // Store cleanup ref on canvas
        canvas._cleanup = () => {
            cancelAnimationFrame(frameId);
            previewRenderer.dispose();
        };
    }

    // Show egg reveal animation overlay after saving a new video
    function showEggReveal(project, onDone, labelText) {
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
                <div class="incubator-reveal-label">${displayLabel}</div>
            </div>
        `;
        container.querySelector('.incubator-panel').appendChild(overlay);

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

        // Eyes
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

    // ============ 3D SCENE ============

    function init3DScene() {
        const T = window.THREE;
        const OC = window.OrbitControls;
        if (!T || !OC) { console.warn('Incubator: THREE or OrbitControls not available'); return; }

        const containerEl = document.getElementById('incubator-3d-container');
        if (!containerEl) return;

        renderer3d = new T.WebGLRenderer({ antialias: true, alpha: false });
        renderer3d.setClearColor(0xfef8f0);
        renderer3d.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        const rect = containerEl.getBoundingClientRect();
        renderer3d.setSize(rect.width, rect.height);
        containerEl.appendChild(renderer3d.domElement);

        scene3d = new T.Scene();
        scene3d.background = new T.Color(0xfef8f0);

        camera3d = new T.PerspectiveCamera(50, rect.width / rect.height, 0.1, 100);
        camera3d.position.set(0, 5, 6);
        camera3d.lookAt(0, 0, 0);

        controls3d = new OC(camera3d, renderer3d.domElement);
        controls3d.enableDamping = true;
        controls3d.dampingFactor = 0.08;
        controls3d.maxPolarAngle = Math.PI / 2;
        controls3d.minDistance = 3;
        controls3d.maxDistance = 15;
        controls3d.target.set(0, 0.3, 0);

        const ambient = new T.AmbientLight(0xfff5e6, 0.6);
        scene3d.add(ambient);

        const dir = new T.DirectionalLight(0xffffff, 0.8);
        dir.position.set(5, 8, 5);
        scene3d.add(dir);

        const warm = new T.PointLight(0xff9933, 0.5, 20, 2);
        warm.position.set(0, 3, 0);
        scene3d.add(warm);

        raycaster3d = new T.Raycaster();
        mouse3d = new T.Vector2();

        renderer3d.domElement.addEventListener('mousemove', onMouseMove3D);
        renderer3d.domElement.addEventListener('click', onClick3D);
        renderer3d.domElement.addEventListener('touchend', onTouch3D);
        renderer3d.domElement.style.cursor = 'grab';

        const ro = new ResizeObserver(() => onResize3D());
        ro.observe(containerEl);
        renderer3d._resizeObserver = ro;

        buildNest(1.5);

        const startTime = performance.now();
        function animate() {
            animFrameId = requestAnimationFrame(animate);
            controls3d.update();
            const t = (performance.now() - startTime) / 1000;

            for (const entry of eggMeshes) {
                const offset = entry.mesh.userData.wobbleOffset || 0;
                entry.mesh.rotation.z = Math.sin(t * 1.2 + offset) * 0.04;
                entry.mesh.rotation.x = Math.cos(t * 0.9 + offset * 1.3) * 0.03;
            }
            renderer3d.render(scene3d, camera3d);
        }
        animate();
    }

    function buildNest(radius) {
        const T = window.THREE;
        if (!T || !scene3d) return;

        if (nestGroup) { scene3d.remove(nestGroup); }
        nestGroup = new T.Group();

        const torusGeo = new T.TorusGeometry(radius, 0.25, 8, 32);
        const nestMat = new T.MeshStandardMaterial({ color: 0xd4a574, roughness: 0.9, metalness: 0.0 });
        const nestRing = new T.Mesh(torusGeo, nestMat);
        nestRing.rotation.x = Math.PI / 2;
        nestRing.position.y = 0.15;
        nestGroup.add(nestRing);

        const floorGeo = new T.CircleGeometry(radius - 0.1, 32);
        const floorMat = new T.MeshStandardMaterial({ color: 0xe8d5b0, roughness: 1.0 });
        const floor = new T.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = 0.05;
        nestGroup.add(floor);

        for (let i = 0; i < 12; i++) {
            const strawGeo = new T.CylinderGeometry(0.02, 0.02, 0.3 + Math.random() * 0.4, 4);
            const strawMat = new T.MeshStandardMaterial({ color: 0xc9a86c, roughness: 0.95 });
            const straw = new T.Mesh(strawGeo, strawMat);
            const angle = (i / 12) * Math.PI * 2 + Math.random() * 0.3;
            const r = radius * (0.6 + Math.random() * 0.35);
            straw.position.set(Math.cos(angle) * r, 0.1, Math.sin(angle) * r);
            straw.rotation.z = Math.random() * 0.8 - 0.4;
            straw.rotation.y = Math.random() * Math.PI;
            nestGroup.add(straw);
        }

        scene3d.add(nestGroup);
    }

    function onResize3D() {
        const containerEl = document.getElementById('incubator-3d-container');
        if (!containerEl || !renderer3d || !camera3d) return;
        const rect = containerEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        camera3d.aspect = rect.width / rect.height;
        camera3d.updateProjectionMatrix();
        renderer3d.setSize(rect.width, rect.height);
    }

    function onMouseMove3D(e) {
        if (!renderer3d || !raycaster3d) return;
        const rect = renderer3d.domElement.getBoundingClientRect();
        mouse3d.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse3d.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster3d.setFromCamera(mouse3d, camera3d);
        const meshes = eggMeshes.map(entry => entry.mesh);
        const hits = raycaster3d.intersectObjects(meshes);

        const tooltip = document.getElementById('incubator-3d-tooltip');
        if (hits.length > 0) {
            const hit = hits[0].object;
            const entry = eggMeshes.find(e => e.mesh === hit);
            if (entry) {
                hoveredEgg = entry;
                renderer3d.domElement.style.cursor = 'pointer';
                if (tooltip) {
                    const v = VideoService.getById(entry.videoId);
                    tooltip.innerHTML = `<div>${escHtml(v ? v.name : '')}</div><div class="tooltip-project">${escHtml(v && v.project ? v.project : 'No project')}</div>`;
                    tooltip.style.display = 'block';
                    tooltip.style.left = (e.clientX + 14) + 'px';
                    tooltip.style.top = (e.clientY - 10) + 'px';
                }
            }
        } else {
            hoveredEgg = null;
            renderer3d.domElement.style.cursor = 'grab';
            if (tooltip) tooltip.style.display = 'none';
        }
    }

    function onClick3D(e) {
        if (!hoveredEgg) return;
        openDetail(hoveredEgg.videoId);
        const tooltip = document.getElementById('incubator-3d-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    }

    function onTouch3D(e) {
        if (!renderer3d || !raycaster3d) return;
        const touch = e.changedTouches[0];
        if (!touch) return;
        const rect = renderer3d.domElement.getBoundingClientRect();
        mouse3d.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
        mouse3d.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster3d.setFromCamera(mouse3d, camera3d);
        const meshes = eggMeshes.map(entry => entry.mesh);
        const hits = raycaster3d.intersectObjects(meshes);
        if (hits.length > 0) {
            const entry = eggMeshes.find(e => e.mesh === hits[0].object);
            if (entry) openDetail(entry.videoId);
        }
    }

    function cleanup3D() {
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        if (renderer3d) {
            renderer3d.domElement.removeEventListener('mousemove', onMouseMove3D);
            renderer3d.domElement.removeEventListener('click', onClick3D);
            renderer3d.domElement.removeEventListener('touchend', onTouch3D);
            if (renderer3d._resizeObserver) { renderer3d._resizeObserver.disconnect(); }
            renderer3d.dispose();
            renderer3d = null;
        }
        if (controls3d) { controls3d.dispose(); controls3d = null; }
        eggMeshes = [];
        nestGroup = null;
        scene3d = null; camera3d = null; raycaster3d = null; mouse3d = null;
        hoveredEgg = null;
    }

    function render3DEggs() {
        const T = window.THREE;
        if (!T || !scene3d) return;

        for (const entry of eggMeshes) {
            scene3d.remove(entry.mesh);
            if (entry.mesh.geometry) entry.mesh.geometry.dispose();
            if (entry.mesh.material) entry.mesh.material.dispose();
            entry.mesh.children.forEach(c => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) c.material.dispose();
            });
        }
        eggMeshes = [];

        let queued = VideoService.getByStatus('incubator');
        if (filterProject) queued = queued.filter(v => v.project === filterProject);

        const emptyEl = document.querySelector('.incubator-3d-empty');
        if (emptyEl) emptyEl.style.display = queued.length === 0 ? 'block' : 'none';

        if (queued.length === 0) {
            buildNest(1.5);
            return;
        }

        const count = queued.length;
        const nestRadius = Math.max(1.5, 0.5 + count * 0.25);

        buildNest(nestRadius);

        const eggRadius = nestRadius * 0.6;
        for (let i = 0; i < count; i++) {
            const v = queued[i];
            const color = getProjectColor(v.project);

            const eggGeo = new T.SphereGeometry(0.35, 16, 16);
            eggGeo.scale(1, 1.4, 1);

            const matOpts = {
                color: new T.Color(color),
                roughness: 0.4,
                emissive: new T.Color(color),
                emissiveIntensity: 0.05
            };
            const patternTex = makeEggTexture(v.project);
            if (patternTex) {
                matOpts.map = patternTex;
                matOpts.color = new T.Color(0xffffff);
            }
            const eggMat = new T.MeshStandardMaterial(matOpts);
            const egg = new T.Mesh(eggGeo, eggMat);

            const angle = (i / count) * Math.PI * 2;
            const r = count === 1 ? 0 : eggRadius;
            egg.position.set(Math.cos(angle) * r, 0.45, Math.sin(angle) * r);
            egg.userData.wobbleOffset = i * 1.7;

            const outlineMat = new T.ShaderMaterial({
                side: T.BackSide,
                uniforms: {
                    w: { value: 0.02 },
                    col: { value: new T.Color(0x8b6914) }
                },
                vertexShader: `uniform float w; void main(){ vec3 p=position+normal*w; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); }`,
                fragmentShader: `uniform vec3 col; void main(){ gl_FragColor=vec4(col,1.0); }`
            });
            egg.add(new T.Mesh(eggGeo, outlineMat));

            scene3d.add(egg);
            eggMeshes.push({ mesh: egg, videoId: v.id });
        }
    }

    // ============ LOADING ANIMATION ============

    function showNestLoader() {
        const el = document.getElementById('incubator-3d-container');
        if (!el) return;
        const loader = document.createElement('div');
        loader.className = 'incubator-nest-loader';
        loader.innerHTML = `
            <svg viewBox="0 0 200 160" class="nest-loader-svg">
                <ellipse cx="100" cy="120" rx="80" ry="20" fill="#d4a574" opacity="0.3" class="nest-loader-base"/>
                <ellipse cx="100" cy="115" rx="75" ry="18" fill="none" stroke="#c4956a" stroke-width="3" stroke-dasharray="8 4" class="nest-loader-ring"/>
                <ellipse cx="70" cy="90" rx="16" ry="22" fill="#888" opacity="0.15" class="nest-loader-egg egg1"/>
                <ellipse cx="100" cy="85" rx="16" ry="22" fill="#888" opacity="0.15" class="nest-loader-egg egg2"/>
                <ellipse cx="130" cy="90" rx="16" ry="22" fill="#888" opacity="0.15" class="nest-loader-egg egg3"/>
            </svg>
            <div class="nest-loader-text">Gathering eggs...</div>
        `;
        el.appendChild(loader);
    }

    function hideNestLoader() {
        const el = document.querySelector('.incubator-nest-loader');
        if (!el) return;
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 400);
    }

    // ============ RENDER ============

    function render() {
        container.innerHTML = `
            <div class="incubator-panel show-list">
                <div class="incubator-page incubator-list-page">
                    <div class="incubator-header">
                        <h2>Incubator</h2>
                        <div class="incubator-header-actions">
                            <button class="incubator-from-library-btn" id="incubator-from-library">From Library</button>
                            <button class="incubator-add-btn" id="incubator-add-btn">+ New Video</button>
                        </div>
                    </div>
                    <div class="incubator-filters" id="incubator-filters"></div>
                    <div class="incubator-3d-container" id="incubator-3d-container">
                        <div class="incubator-3d-empty" style="display:none;">No eggs yet. Tap + New Video to start!</div>
                    </div>
                    <div class="incubator-3d-tooltip" id="incubator-3d-tooltip"></div>
                </div>
                <div class="incubator-page incubator-detail-page">
                    <div class="incubator-detail" id="incubator-detail"></div>
                </div>
            </div>
            <div class="incubator-picker-overlay" id="incubator-picker-overlay" style="display:none;">
                <div class="incubator-picker">
                    <div class="incubator-picker-header">
                        <h3>Pick an Idea from Library</h3>
                        <button class="incubator-picker-close" id="incubator-picker-close">&times;</button>
                    </div>
                    <div class="incubator-picker-list" id="incubator-picker-list"></div>
                </div>
            </div>
        `;
        document.getElementById('incubator-add-btn').addEventListener('click', handleAdd);
        document.getElementById('incubator-from-library').addEventListener('click', showLibraryPicker);
        document.getElementById('incubator-picker-close').addEventListener('click', hideLibraryPicker);
        document.getElementById('incubator-picker-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) hideLibraryPicker();
        });
    }

    function renderFilters() {
        const el = document.getElementById('incubator-filters');
        if (!el) return;
        const queued = VideoService.getByStatus('incubator');
        const usedProjects = [...new Set(queued.map(v => v.project).filter(Boolean))].sort();
        if (usedProjects.length === 0) { el.innerHTML = ''; return; }
        el.innerHTML = `
            <button class="incubator-filter-btn ${!filterProject ? 'active' : ''}" data-project="">All (${queued.length})</button>
            ${usedProjects.map(p => {
                const count = queued.filter(v => v.project === p).length;
                return `<button class="incubator-filter-btn ${filterProject === p ? 'active' : ''}" data-project="${escAttr(p)}">${escHtml(p)} (${count})</button>`;
            }).join('')}
        `;
        el.querySelectorAll('.incubator-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                filterProject = btn.dataset.project;
                renderFilters();
                render3DEggs();
            });
        });
    }

    // ============ DETAIL VIEW ============

    function openDetail(id) {
        selectedVideo = VideoService.getById(id);
        if (!selectedVideo) return;
        isDraft = false;
        currentPage = 'detail';
        const panel = container.querySelector('.incubator-panel');
        panel.classList.remove('show-list');
        panel.classList.add('show-detail');
        renderDetail();
    }

    function showList() {
        const previewCanvas = document.getElementById('incubator-detail-egg-canvas');
        if (previewCanvas && previewCanvas._cleanup) previewCanvas._cleanup();

        currentPage = 'list'; selectedVideo = null; isDraft = false;
        const panel = container.querySelector('.incubator-panel');
        panel.classList.remove('show-detail');
        panel.classList.add('show-list');
        renderFilters();
        render3DEggs();
    }

    function renderDetail() {
        const el = document.getElementById('incubator-detail');
        if (!el) return;

        const v = isDraft
            ? { name: '', project: '', hook: '', context: '', linkedScriptId: '', sourceIdeaId: '' }
            : selectedVideo;
        if (!v) return;

        let sourceIdeaHtml = '';
        if (v.sourceIdeaId) {
            const idea = NotesService.getById(v.sourceIdeaId);
            sourceIdeaHtml = `<div class="incubator-source-idea">Source Idea: ${escHtml(idea ? idea.name : v.sourceIdeaId)}</div>`;
        }

        // Script linker section
        let scriptHtml = '';
        if (v.linkedScriptId) {
            const scripts = ScriptService.getAll();
            const linkedScript = scripts.find(s => s.id === v.linkedScriptId);
            const scriptName = linkedScript ? linkedScript.title : 'Linked Script';
            scriptHtml = `<div class="incubator-script-linker">${inlineScriptEditorHtml('incubator-inline-script', scriptName)}</div>`;
        } else {
            scriptHtml = `
                <div class="incubator-script-linker">
                    ${ScriptLinker.renderLinker({ prefix: 'incubator', linkedScriptId: '', useInlineEditor: false })}
                </div>`;
        }

        // Toolbar buttons change based on draft vs existing
        const toolbarActions = isDraft
            ? `<button class="incubator-action-btn workshop-btn" id="incubator-save-draft">Save</button>`
            : `<button class="incubator-action-btn workshop-btn" id="incubator-to-workshop">Move to Workshop</button>
               <button class="incubator-action-btn library-btn" id="incubator-to-library">Back to Library</button>
               <button class="incubator-action-btn delete-btn" id="incubator-delete">Delete</button>`;

        el.innerHTML = `
            <div class="incubator-detail-toolbar">
                <button class="incubator-back-btn" id="incubator-back-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
                    Back
                </button>
                <div class="incubator-detail-actions">
                    ${toolbarActions}
                </div>
            </div>
            <div class="incubator-detail-body">
                <div class="incubator-detail-egg">${isDraft ? renderSilhouetteEgg() : (v.project ? renderEggPreviewCanvas(v.project, 'incubator-detail-egg-canvas') : renderSilhouetteEgg())}</div>
                <div class="incubator-detail-fields">
                    ${sourceIdeaHtml}
                    <label>Video Name</label>
                    <input type="text" id="incubator-name" value="${escAttr(v.name)}" placeholder="Video title...">

                    <label>Project <span class="incubator-required">*required</span></label>
                    <div class="incubator-project-picker" id="incubator-project-picker">
                        <input type="text" class="incubator-project-search" id="incubator-project-search"
                            placeholder="Search or select project..." value="${escAttr(v.project)}" autocomplete="off" />
                        <div class="incubator-project-dropdown" id="incubator-project-dropdown"></div>
                    </div>
                    <div class="incubator-project-error" id="incubator-project-error" style="display:none;">Project is required</div>

                    <label>Hook</label>
                    <textarea id="incubator-hook" placeholder="What's the hook?">${escHtml(v.hook || '')}</textarea>

                    <label>Context</label>
                    <textarea id="incubator-context" placeholder="More details, angles, notes...">${escHtml(v.context || '')}</textarea>

                    <label>Script</label>
                    ${scriptHtml}
                </div>
            </div>
            ${ScriptLinker.renderPickerOverlay('incubator')}
        `;

        // Back button
        document.getElementById('incubator-back-btn').addEventListener('click', () => {
            if (isDraft) {
                showList();
            } else {
                saveAndBack();
            }
        });

        // Draft save or existing video actions
        if (isDraft) {
            document.getElementById('incubator-save-draft').addEventListener('click', () => saveDraft());
        } else {
            document.getElementById('incubator-to-workshop').addEventListener('click', () => moveToWorkshop());
            document.getElementById('incubator-to-library').addEventListener('click', () => backToLibrary());
            document.getElementById('incubator-delete').addEventListener('click', () => handleDelete());
        }

        // Script linker events
        if (v.linkedScriptId) {
            initInlineScriptEditor('incubator-inline-script', v.linkedScriptId, async () => {
                // Unlink callback
                if (!selectedVideo || isDraft) return;
                if (navigator.vibrate) navigator.vibrate(30);
                try {
                    await LinkService.unlinkFromVideo(selectedVideo.id);
                    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
                    selectedVideo = VideoService.getById(selectedVideo.id);
                    renderDetail();
                } catch (e) {
                    console.warn('Incubator: unlink script failed', e);
                    alert('Failed to unlink script.');
                }
            });
        } else {
            ScriptLinker.bindEvents({
                prefix: 'incubator',
                getTarget: () => isDraft ? null : selectedVideo,
                isIdea: false,
                onRefresh: () => { selectedVideo = VideoService.getById(selectedVideo.id); renderDetail(); },
                isDraft
            });
        }

        // Project search/dropdown
        const searchInput = document.getElementById('incubator-project-search');
        const dropdown = document.getElementById('incubator-project-dropdown');

        searchInput.addEventListener('focus', () => showProjectDropdown(searchInput.value));
        searchInput.addEventListener('input', () => showProjectDropdown(searchInput.value));
        searchInput.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));

        // Auto-focus name field for drafts
        if (isDraft) {
            setTimeout(() => {
                const nameEl = document.getElementById('incubator-name');
                if (nameEl) { nameEl.focus(); nameEl.select(); }
            }, 50);
        }

        function showProjectDropdown(query) {
            const q = query.toLowerCase();
            const filtered = q ? projects.filter(p => p.toLowerCase().includes(q)) : projects;
            if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
            dropdown.innerHTML = filtered.map(p => `<div class="incubator-project-option" data-project="${escAttr(p)}">${escHtml(p)}</div>`).join('');
            dropdown.style.display = 'block';
            dropdown.querySelectorAll('.incubator-project-option').forEach(opt => {
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    searchInput.value = opt.dataset.project;
                    dropdown.style.display = 'none';
                    document.getElementById('incubator-project-error').style.display = 'none';
                });
            });
        }

        // Init 3D egg preview for saved videos
        if (!isDraft && v.project) {
            requestAnimationFrame(() => initEggPreview('incubator-detail-egg-canvas', v.project));
        }
    }

    // ============ ACTIONS ============

    function getProjectFromDetail() {
        const searchInput = document.getElementById('incubator-project-search');
        if (!searchInput) return '';
        const val = searchInput.value.trim();
        const match = projects.find(p => p.toLowerCase() === val.toLowerCase());
        return match || val;
    }

    async function saveDraft() {
        const name = document.getElementById('incubator-name')?.value.trim() || 'Untitled Video';
        const project = getProjectFromDetail();
        const hook = document.getElementById('incubator-hook')?.value || '';
        const context = document.getElementById('incubator-context')?.value || '';

        if (!project) {
            const errEl = document.getElementById('incubator-project-error');
            if (errEl) errEl.style.display = 'block';
            document.getElementById('incubator-project-search')?.focus();
            return;
        }

        const btn = document.getElementById('incubator-save-draft');
        if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

        try {
            const video = await VideoService.create({ name, project, hook, context });
            selectedVideo = video;
            isDraft = false;
            showEggReveal(project, () => {
                showList();
            });
        } catch (e) {
            console.warn('Incubator: save draft failed', e);
            alert('Failed to save video. Check connection.');
        } finally {
            if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
        }
    }

    async function saveAndBack() {
        const backBtn = container.querySelector('.incubator-back-btn');
        if (backBtn) backBtn.textContent = 'Saving...';
        if (selectedVideo) {
            const name = document.getElementById('incubator-name')?.value.trim() || selectedVideo.name;
            const project = getProjectFromDetail();
            const hook = document.getElementById('incubator-hook')?.value || '';
            const context = document.getElementById('incubator-context')?.value || '';
            await VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, hook, context });
        }
        showList();
    }

    async function moveToWorkshop() {
        if (!selectedVideo) return;
        const name = document.getElementById('incubator-name')?.value.trim() || selectedVideo.name;
        const project = getProjectFromDetail();
        const hook = document.getElementById('incubator-hook')?.value || '';
        const context = document.getElementById('incubator-context')?.value || '';

        if (!project) {
            const errEl = document.getElementById('incubator-project-error');
            if (errEl) errEl.style.display = 'block';
            document.getElementById('incubator-project-search')?.focus();
            return;
        }

        const btn = container.querySelector('.workshop-btn');
        if (btn) { btn.textContent = 'Moving...'; btn.disabled = true; }

        try {
            await VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, hook, context, status: 'workshop' });
            showEggReveal(project, () => showList(), 'Moved to Workshop!');
        } catch (e) {
            console.warn('Incubator: move to workshop failed', e);
            alert('Failed to move to Workshop. Check connection.');
            if (btn) { btn.textContent = 'Move to Workshop'; btn.disabled = false; }
        }
    }

    async function handleDelete() {
        if (!selectedVideo || !confirm(`Delete "${selectedVideo.name}"?`)) return;
        try {
            await VideoService.remove(selectedVideo.id);
            showList();
        } catch (e) { console.warn('Incubator: delete failed', e); }
    }

    async function backToLibrary() {
        if (!selectedVideo) return;
        if (!confirm('Move this back to Library as an idea? The video entry will be removed.')) return;
        const btn = document.getElementById('incubator-to-library');
        if (btn) { btn.textContent = 'Moving...'; btn.disabled = true; }

        try {
            const v = selectedVideo;
            if (v.sourceIdeaId) {
                const idea = NotesService.getById(v.sourceIdeaId);
                if (idea) {
                    await NotesService.update(idea.id, { type: 'idea' });
                    // Fix reverse-pointer: if script was linked to this video, relink to the idea
                    if (v.linkedScriptId) {
                        try {
                            await LinkService.linkScriptToIdea(v.linkedScriptId, idea.id);
                        } catch (e) { console.warn('Incubator: re-link script to idea failed', e); }
                    }
                }
            } else {
                // No source idea — create a new idea in the Library
                const newIdea = await NotesService.create({
                    name: v.name || 'Untitled',
                    type: 'idea',
                    hook: v.hook || '',
                    context: v.context || '',
                    project: v.project || '',
                    linkedScriptId: v.linkedScriptId || ''
                });
                // Fix reverse-pointer: relink script from video to new idea
                if (v.linkedScriptId && newIdea) {
                    try {
                        await LinkService.linkScriptToIdea(v.linkedScriptId, newIdea.id);
                    } catch (e) { console.warn('Incubator: re-link script to new idea failed', e); }
                }
            }
            await VideoService.remove(v.id);
            if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
            showEggReveal(v.project, () => showList(), 'Moved to Library!');
        } catch (e) {
            console.warn('Incubator: back to library failed', e);
            alert('Failed to move back to Library. Check connection.');
            if (btn) { btn.textContent = 'Back to Library'; btn.disabled = false; }
        }
    }

    function handleAdd() {
        isDraft = true;
        selectedVideo = null;
        currentPage = 'detail';
        const panel = container.querySelector('.incubator-panel');
        panel.classList.remove('show-list');
        panel.classList.add('show-detail');
        renderDetail();
    }

    // ============ LIBRARY PICKER (ideas) ============

    function showLibraryPicker() {
        const overlay = document.getElementById('incubator-picker-overlay');
        const listEl = document.getElementById('incubator-picker-list');
        if (!overlay || !listEl) return;

        const allNotes = NotesService.getAll();
        const unlinked = allNotes.filter(n => n.type === 'idea');

        if (unlinked.length === 0) {
            listEl.innerHTML = '<div class="incubator-picker-empty">No ideas in Library yet. Create ideas in the Library first.</div>';
        } else {
            listEl.innerHTML = unlinked.map(n => {
                const preview = n.hook || n.context || '';
                return `
                <div class="incubator-picker-item" data-id="${n.id}">
                    <div class="incubator-picker-name">${escHtml(n.name)}</div>
                    <div class="incubator-picker-preview">${escHtml(preview.substring(0, 80))}</div>
                </div>`;
            }).join('');
            listEl.querySelectorAll('.incubator-picker-item').forEach(item => {
                item.addEventListener('click', () => pickIdeaFromLibrary(item.dataset.id));
            });
        }
        overlay.style.display = 'flex';
    }

    function hideLibraryPicker() {
        const overlay = document.getElementById('incubator-picker-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    async function pickIdeaFromLibrary(noteId) {
        const note = NotesService.getById(noteId);
        if (!note) return;
        const existing = VideoService.getByIdeaId(noteId);
        if (existing) { alert('This idea is already in the Incubator.'); hideLibraryPicker(); return; }

        const item = document.querySelector(`.incubator-picker-item[data-id="${noteId}"]`);
        if (item) { item.style.opacity = '0.5'; item.style.pointerEvents = 'none'; }

        try {
            const video = await VideoService.create({
                name: note.name || 'Untitled Video',
                hook: note.hook || '',
                context: note.context || '',
                project: note.project || '',
                sourceIdeaId: note.id,
                linkedScriptId: note.linkedScriptId || ''
            });
            await NotesService.update(note.id, { type: 'converted' });
            // Fix reverse-pointer: if idea had a linked script, update it to point to the video
            if (note.linkedScriptId) {
                try {
                    await LinkService.linkScriptToVideo(note.linkedScriptId, video.id);
                } catch (e) { console.warn('Incubator: re-link script to video failed', e); }
            }
            hideLibraryPicker();
            openDetail(video.id);
        } catch (e) {
            console.warn('Incubator: pick from library failed', e);
            alert('Failed to create video from idea. Check connection.');
        }
    }

    // ============ SHARED EGG RENDERER ============

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

    function renderCreatureSnapshot(project, canvas, size) {
        const T = window.THREE;
        if (!T || !canvas) return;

        const w = size || 50;
        canvas.width = w * 2;
        canvas.height = w * 2;

        const color = getProjectColor(project);

        const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(1);
        renderer.setSize(w * 2, w * 2);

        const scene = new T.Scene();
        const cam = new T.PerspectiveCamera(36, 1, 0.1, 50);
        cam.position.set(0, 0.1, 2.2);
        cam.lookAt(0, 0, 0);

        scene.add(new T.AmbientLight(0xfff5e6, 0.7));
        const dl = new T.DirectionalLight(0xffffff, 0.9);
        dl.position.set(3, 5, 4);
        scene.add(dl);

        const bodyGeo = new T.SphereGeometry(0.4, 24, 24);
        const bodyMat = new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.85 });
        const body = new T.Mesh(bodyGeo, bodyMat);
        scene.add(body);

        const eyeWhiteGeo = new T.SphereGeometry(0.11, 12, 12);
        const eyeWhiteMat = new T.MeshBasicMaterial({ color: 0xffffff });
        const pupilGeo = new T.SphereGeometry(0.065, 12, 12);
        const pupilMat = new T.MeshBasicMaterial({ color: 0x1a1a2e });
        const highlightGeo = new T.SphereGeometry(0.025, 8, 8);

        [[-0.15, 0.08, 0.32], [0.15, 0.08, 0.32]].forEach(([x, y, z]) => {
            const ew = new T.Mesh(eyeWhiteGeo, eyeWhiteMat); ew.position.set(x, y, z); scene.add(ew);
            const ep = new T.Mesh(pupilGeo, pupilMat); ep.position.set(x, y, z + 0.05); scene.add(ep);
            const eh = new T.Mesh(highlightGeo, eyeWhiteMat); eh.position.set(x + 0.03, y + 0.04, z + 0.09); scene.add(eh);
        });

        renderer.render(scene, cam);

        function dispose() {
            bodyGeo.dispose(); bodyMat.dispose();
            eyeWhiteGeo.dispose(); eyeWhiteMat.dispose();
            pupilGeo.dispose(); pupilMat.dispose();
            highlightGeo.dispose();
            renderer.dispose();
        }

        if (typeof GeoPattern !== 'undefined' && project) {
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
                renderer.render(scene, cam);
                tex.dispose();
                dispose();
            };
            img.src = url;
        } else {
            dispose();
        }
    }

    const CHARACTER_HEX = { 'You': 0x3498db, 'Robin': 0xe74c3c, 'Jordan': 0x9b59b6, 'Tennille': 0xff69b4 };

    function renderCharacterAvatar(name, canvas, size) {
        const T = window.THREE;
        if (!T || !canvas) return;
        const color = CHARACTER_HEX[name] || 0x888888;

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
            incubator: { emoji: '\u{1F95A}', label: 'Incubator', cls: 'status-incubator' },
            workshop:  { emoji: '\u{1F528}', label: 'Workshop',  cls: 'status-workshop' },
            posted:    { emoji: '\u2705',    label: 'Posted',     cls: 'status-posted' }
        };
        const info = map[status] || { emoji: '', label: status, cls: '' };
        return `<span class="status-badge ${info.cls}">${info.emoji} ${info.label}</span>`;
    }

    function inlineScriptEditorHtml(containerId, scriptName) {
        return `<div class="inline-script-editor" id="${containerId}">
            <div class="inline-script-header">
                <span class="inline-script-title">${escHtml(scriptName)}</span>
                <div class="inline-script-actions">
                    <button class="inline-script-unlink" data-action="unlink">Unlink</button>
                    <span class="inline-script-toggle">&#9654;</span>
                </div>
            </div>
            <div class="inline-script-body">
                <div class="inline-script-status" id="${containerId}-status">Loading...</div>
                <textarea class="inline-script-textarea" id="${containerId}-textarea" placeholder="Loading script..."></textarea>
            </div>
        </div>`;
    }

    function initInlineScriptEditor(containerId, scriptId, onUnlink) {
        const containerDiv = document.getElementById(containerId);
        if (!containerDiv) return;
        const header = containerDiv.querySelector('.inline-script-header');
        const textarea = document.getElementById(containerId + '-textarea');
        const statusEl = document.getElementById(containerId + '-status');
        const unlinkBtn = containerDiv.querySelector('[data-action="unlink"]');
        let saveTimer = null;
        let scriptMeta = null;
        let dirty = false;

        header.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="unlink"]')) return;
            containerDiv.classList.toggle('expanded');
            if (containerDiv.classList.contains('expanded') && !textarea.dataset.loaded) {
                loadContent();
            }
        });

        if (unlinkBtn) {
            unlinkBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (saveTimer) { clearTimeout(saveTimer); doSave(); }
                if (onUnlink) onUnlink();
            });
        }

        async function loadContent() {
            textarea.dataset.loaded = '1';
            try {
                const data = await ScriptService.loadContent(scriptId);
                scriptMeta = data.meta;
                textarea.value = data.text;
                textarea.placeholder = 'Start writing your script...';
                statusEl.textContent = 'Saved';
                statusEl.className = 'inline-script-status saved';
                autoResize();
            } catch (e) {
                textarea.placeholder = 'Could not load script.';
                statusEl.textContent = 'Load failed';
                console.warn('Inline script: load failed', e);
            }
        }

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
                await ScriptService.saveContent(scriptId, textarea.value, scriptMeta);
                statusEl.textContent = 'Saved';
                statusEl.className = 'inline-script-status saved';
            } catch (e) {
                statusEl.textContent = 'Save failed';
                statusEl.className = 'inline-script-status';
                dirty = true;
                console.warn('Inline script: save failed', e);
            }
        }

        return () => {
            if (saveTimer) { clearTimeout(saveTimer); doSave(); }
        };
    }

    // Expose shared rendering utilities for Workshop/Pen
    window.EggRenderer = { getProjectColor, makeEggTexture, initEggPreview, renderSilhouetteEgg, renderEggSnapshot, renderCreatureSnapshot, renderCharacterAvatar, projectBadgeHtml, statusBadgeHtml, projectFlagSvg, inlineScriptEditorHtml, initInlineScriptEditor, showHatchAnimation, showEggReveal };

    // ============ PUBLIC API ============

    return {
        async open(bodyEl) {
            container = bodyEl;
            render();
            showNestLoader();
            requestAnimationFrame(() => init3DScene());
            const [p] = await Promise.all([
                VideoService.getProjects(),
                VideoService.sync(),
                NotesService.sync().catch(() => {}),
                ScriptService.sync().catch(() => {}),
            ]);
            projects = p;
            renderFilters();
            if (!scene3d) await new Promise(r => requestAnimationFrame(() => { if (!scene3d) init3DScene(); r(); }));
            render3DEggs();
            hideNestLoader();
        },
        close() {
            if (currentPage === 'detail' && selectedVideo && !isDraft) {
                const name = document.getElementById('incubator-name')?.value.trim();
                const project = getProjectFromDetail();
                const hook = document.getElementById('incubator-hook')?.value || '';
                const context = document.getElementById('incubator-context')?.value || '';
                if (name) {
                    VideoService.saveWithIdeaSync(selectedVideo.id, { name, project, hook, context }).catch(() => {});
                }
            }
            cleanup3D();
            container = null; selectedVideo = null; currentPage = 'list'; filterProject = ''; isDraft = false;
        }
    };
})();

BuildingRegistry.register('Incubator', {
    open: (bodyEl) => IncubatorUI.open(bodyEl),
    close: () => IncubatorUI.close()
});
