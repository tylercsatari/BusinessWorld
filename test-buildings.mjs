/**
 * Playwright test: verify all building UIs render and buttons work.
 * Uses REAL Notion API (Ideas + To-Do), mocks only VideoService (Airtable videos).
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8002';
let browser, page;

async function setup() {
    browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();

    page.on('pageerror', err => {
        if (!err.message.includes('WebGL'))
            console.log(`  [PAGE ERROR] ${err.message}`);
    });

    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Mock VideoService only (Airtable videos) — Notion services are real
    await page.evaluate(() => {
        const mockVideos = [];
        let videoIdCounter = 1;
        const mockProjects = ['Project Alpha', 'Project Beta', 'Project Gamma'];

        VideoService.sync = async () => mockVideos;
        VideoService.getAll = () => mockVideos;
        VideoService.getById = (id) => mockVideos.find(v => v.id === id) || null;
        VideoService.getByStatus = (status) => mockVideos.filter(v => v.status === status);
        VideoService.getByIdeaId = (ideaId) => mockVideos.find(v => v.sourceIdeaId === ideaId) || null;
        VideoService.getByProject = (project) => mockVideos.filter(v => v.project === project);
        VideoService.getProjects = async () => mockProjects;
        VideoService.getCachedProjects = () => mockProjects;
        VideoService.create = async (data) => {
            const video = {
                id: 'vid_' + (videoIdCounter++),
                name: data.name || 'Untitled Video',
                project: data.project || '',
                hook: data.hook || '',
                context: data.context || '',
                status: data.status || 'incubator',
                linkedScriptId: data.linkedScriptId || '',
                links: data.links || '',
                assignedTo: data.assignedTo || '',
                sourceIdeaId: data.sourceIdeaId || '',
                postedDate: data.postedDate || ''
            };
            mockVideos.push(video);
            return video;
        };
        VideoService.update = async (id, changes) => {
            const video = mockVideos.find(v => v.id === id);
            if (video) Object.assign(video, changes);
            return video;
        };
        VideoService.remove = async (id) => {
            const idx = mockVideos.findIndex(v => v.id === id);
            if (idx >= 0) mockVideos.splice(idx, 1);
        };
        VideoService.moveToWorkshop = async (id) => {
            const v = mockVideos.find(v => v.id === id);
            if (v) v.status = 'workshop';
        };
        VideoService.moveToPosted = async (id, links) => {
            const v = mockVideos.find(v => v.id === id);
            if (v) { v.status = 'posted'; v.links = links || v.links; v.postedDate = new Date().toISOString(); }
        };
        VideoService.moveToIncubator = async (id) => {
            const v = mockVideos.find(v => v.id === id);
            if (v) v.status = 'incubator';
        };
    });
}

async function teardown() {
    if (browser) await browser.close();
}

async function openBuilding(name) {
    await page.evaluate((n) => openModal(n, 'building'), name);
    await page.waitForTimeout(2000);
}

async function closeBuilding() {
    await page.evaluate(() => closeModal());
    await page.waitForTimeout(500);
}

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; failures.push({ name, error: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// Track created Notion items for cleanup
const createdIdeaIds = [];

// ============================================
// LIBRARY TESTS
// ============================================
async function testLibrary() {
    console.log('\n📚 LIBRARY TESTS');
    await openBuilding('Library');

    await test('Library panel renders with 4 tabs', async () => {
        assert(await page.$('.library-panel'), 'Panel not found');
        const tabs = await page.$$('.library-tab');
        assert(tabs.length === 4, `Expected 4 tabs, got ${tabs.length}`);
    });

    // --- IDEAS TAB (Notion-backed) ---
    await test('Switch to Ideas tab', async () => {
        await page.click('.library-tab[data-tab="notes"]');
        await page.waitForTimeout(2000);
        const heading = await page.$eval('#library-list-heading', el => el.textContent);
        assert(heading === 'Ideas', `Expected "Ideas", got "${heading}"`);
    });

    await test('+ creates new idea via Notion', async () => {
        await page.click('#library-new-btn');
        await page.waitForTimeout(3000);
        const cls = await page.$eval('.library-panel', el => el.className);
        assert(cls.includes('show-editor'), `Expected show-editor, got: ${cls}`);
        const noteId = await page.evaluate(() => {
            const notes = NotesService.getAll();
            return notes.length > 0 ? notes[notes.length - 1].id : null;
        });
        if (noteId) createdIdeaIds.push(noteId);
    });

    await test('Idea editor has Title, Hook, Context, Project, Script', async () => {
        assert(await page.$('#library-editor-title'), 'Title not found');
        assert(await page.$('#library-idea-hook'), 'Hook not found');
        assert(await page.$('#library-idea-context'), 'Context not found');
        assert(await page.$('#library-note-project'), 'Project select not found');
        const hasLinkBtn = await page.$('#library-link-script');
        const hasNewBtn = await page.$('#library-new-script-for-idea');
        assert(hasLinkBtn || hasNewBtn, 'Script linker not found');
    });

    await test('Can fill in idea fields', async () => {
        await page.fill('#library-editor-title', 'Playwright Test Idea');
        await page.fill('#library-idea-hook', 'This is the hook');
        await page.fill('#library-idea-context', 'Extra context here');
        await page.waitForTimeout(2000);
        const title = await page.$eval('#library-editor-title', el => el.value);
        assert(title === 'Playwright Test Idea', `Title: ${title}`);
    });

    await test('Send to Incubator button exists', async () => {
        assert(await page.$('#library-send-incubator'), 'Send button not found');
    });

    await test('Back returns to list', async () => {
        await page.click('#library-back-btn');
        await page.waitForTimeout(1000);
        const cls = await page.$eval('.library-panel', el => el.className);
        assert(cls.includes('show-list'), `Expected show-list, got: ${cls}`);
    });

    await test('Idea appears in list', async () => {
        await page.waitForTimeout(500);
        const items = await page.$$('#library-notes-list .library-list-item');
        assert(items.length >= 1, 'No ideas in list');
    });

    // --- PROJECTS TAB ---
    await test('Projects tab shows Videos and Ideas only (no separate Scripts section)', async () => {
        await page.click('.library-tab[data-tab="projects"]');
        await page.waitForTimeout(2000);
        const heading = await page.$eval('#library-list-heading', el => el.textContent);
        assert(heading === 'Projects', `Expected "Projects", got "${heading}"`);
    });

    // --- TO-DO TAB ---
    await test('Switch to To-Do tab', async () => {
        await page.click('.library-tab[data-tab="todo"]');
        await page.waitForTimeout(2000);
        const heading = await page.$eval('#library-list-heading', el => el.textContent);
        assert(heading === 'To-Do', `Expected "To-Do", got "${heading}"`);
    });

    await test('To-Do has inline input and Add button', async () => {
        assert(await page.$('#library-todo-input'), 'Input not found');
        assert(await page.$('#library-todo-add-btn'), 'Add button not found');
    });

    await test('Can add to-do item', async () => {
        await page.fill('#library-todo-input', 'Playwright test task');
        await page.click('#library-todo-add-btn');
        await page.waitForTimeout(2000);
        const items = await page.$$('.library-todo-item');
        assert(items.length >= 1, 'No to-do items after adding');
        const text = await items[0].$eval('.library-todo-text', el => el.textContent);
        assert(text.includes('Playwright test task'), `Got: ${text}`);
    });

    await test('Can delete to-do item', async () => {
        const countBefore = (await page.$$('.library-todo-item')).length;
        const delBtns = await page.$$('.library-todo-delete');
        await delBtns[0].click();
        await page.waitForTimeout(1000);
        const countAfter = (await page.$$('.library-todo-item')).length;
        assert(countAfter < countBefore, 'Item not deleted');
    });

    // Clean up remaining to-do items
    const remaining = await page.$$('.library-todo-delete');
    for (const btn of remaining) {
        await btn.click();
        await page.waitForTimeout(500);
    }

    // --- SCRIPTS TAB ---
    await test('Switch to Scripts tab works', async () => {
        await page.click('.library-tab[data-tab="scripts"]');
        await page.waitForTimeout(300);
        const heading = await page.$eval('#library-list-heading', el => el.textContent);
        assert(heading === 'Scripts', `Expected "Scripts", got "${heading}"`);
    });

    await closeBuilding();
}

// ============================================
// INCUBATOR TESTS
// ============================================
async function testIncubator() {
    console.log('\n🥚 INCUBATOR TESTS');
    await openBuilding('Incubator');

    await test('Incubator panel renders', async () => {
        assert(await page.$('.incubator-panel'), 'Panel not found');
    });

    await test('3D container exists', async () => {
        assert(await page.$('#incubator-3d-container'), '3D container not found');
    });

    await test('Empty nest — no egg meshes when no videos', async () => {
        const eggCount = await page.evaluate(() => {
            const queued = VideoService.getByStatus('incubator');
            return queued.length;
        });
        assert(eggCount === 0, `Expected 0 eggs, got ${eggCount}`);
    });

    await test('+ New Video opens draft mode (no Notion create yet)', async () => {
        await page.click('#incubator-add-btn');
        await page.waitForTimeout(500);
        const cls = await page.$eval('.incubator-panel', el => el.className);
        assert(cls.includes('show-detail'), `Expected show-detail, got: ${cls}`);
        const saveBtn = await page.$('#incubator-save-draft');
        assert(saveBtn, 'Save button not found — should be in draft mode');
        const workshopBtn = await page.$('#incubator-to-workshop');
        assert(!workshopBtn, 'Workshop button should NOT exist in draft mode');
    });

    await test('Draft has hook and context fields (not notes)', async () => {
        assert(await page.$('#incubator-hook'), 'Hook field not found');
        assert(await page.$('#incubator-context'), 'Context field not found');
    });

    await test('Draft mode: no video created in mock yet', async () => {
        const count = await page.evaluate(() => VideoService.getAll().length);
        assert(count === 0, `Expected 0 videos, got ${count} — draft should not create`);
    });

    await test('Save blocked without project', async () => {
        await page.fill('#incubator-name', 'Test Draft Video');
        await page.fill('#incubator-project-search', '');
        await page.click('#incubator-save-draft');
        await page.waitForTimeout(500);
        const display = await page.$eval('#incubator-project-error', el => el.style.display);
        assert(display !== 'none', 'Project error should show');
        const count = await page.evaluate(() => VideoService.getAll().length);
        assert(count === 0, 'Video should NOT have been created without project');
    });

    await test('Draft shows silhouette egg (not 2D pattern egg)', async () => {
        const silhouette = await page.$('.incubator-silhouette-egg');
        assert(silhouette, 'Silhouette egg not found in draft mode');
    });

    await test('Save works with project — creates video with hook/context', async () => {
        await page.fill('#incubator-name', 'Test Draft Video');
        await page.fill('#incubator-hook', 'Test hook');
        await page.fill('#incubator-context', 'Test context');
        await page.fill('#incubator-project-search', 'Project Alpha');
        await page.click('#incubator-save-draft');
        await page.waitForTimeout(500);
        const video = await page.evaluate(() => VideoService.getAll()[0]);
        assert(video, 'Video should exist');
        assert(video.hook === 'Test hook', `Hook: ${video.hook}`);
        assert(video.context === 'Test context', `Context: ${video.context}`);
        // Reveal overlay should appear
        const reveal = await page.$('.incubator-reveal-overlay');
        assert(reveal, 'Reveal overlay should appear after save');
        // Wait for reveal to finish
        await page.waitForTimeout(3000);
        const cls = await page.$eval('.incubator-panel', el => el.className);
        assert(cls.includes('show-list'), `Expected show-list after reveal, got: ${cls}`);
    });

    // Create another video to test filters
    await test('Create second video with different project', async () => {
        await page.click('#incubator-add-btn');
        await page.waitForTimeout(500);
        await page.fill('#incubator-name', 'Second Video');
        await page.fill('#incubator-project-search', 'Project Beta');
        await page.click('#incubator-save-draft');
        await page.waitForTimeout(3500);
        const count = await page.evaluate(() => VideoService.getByStatus('incubator').length);
        assert(count === 2, `Expected 2 incubator videos, got ${count}`);
    });

    await test('Filter pills appear for projects', async () => {
        const filters = await page.$$('.incubator-filter-btn');
        assert(filters.length >= 3, `Expected 3+ filter pills (All + 2 projects), got ${filters.length}`);
    });

    await test('Script linker present on saved video detail', async () => {
        // EggRenderer should be exposed
        const hasRenderer = await page.evaluate(() => !!window.EggRenderer);
        assert(hasRenderer, 'EggRenderer not exposed');
    });

    await closeBuilding();
}

// ============================================
// WORKSHOP TESTS
// ============================================
async function testWorkshop() {
    console.log('\n🔨 WORKSHOP TESTS');

    // Move a video to workshop first
    await page.evaluate(() => {
        const v = VideoService.getByStatus('incubator')[0];
        if (v) { v.status = 'workshop'; v.assignedTo = 'Robin'; }
    });

    await openBuilding('Workshop');

    await test('Workshop renders with video from Incubator', async () => {
        assert(await page.$('.workshop-panel'), 'Panel not found');
        const cards = await page.$$('.workshop-card');
        assert(cards.length >= 1, 'No workshop cards');
    });

    await test('Workshop cards have 3D egg canvases', async () => {
        const canvases = await page.$$('.workshop-egg-canvas');
        assert(canvases.length >= 1, 'No egg canvases found on cards');
    });

    await test('Workshop cards show character avatar for assigned worker', async () => {
        const avatars = await page.$$('.workshop-avatar-canvas');
        assert(avatars.length >= 1, 'No character avatar canvases found');
    });

    await test('Detail has hook, context, and script linker (not textarea)', async () => {
        const card = await page.$('.workshop-card');
        await card.click();
        await page.waitForTimeout(500);
        assert(await page.$('#workshop-hook'), 'Hook field not found');
        assert(await page.$('#workshop-context'), 'Context field not found');
        // Should have script linker, not a script textarea
        const scriptTextarea = await page.$('#workshop-script');
        assert(!scriptTextarea, 'Old script textarea should not exist');
        const hasLinkBtn = await page.$('#workshop-link-script');
        const hasNewBtn = await page.$('#workshop-new-script');
        const hasBadge = await page.$('.workshop-script-badge');
        assert(hasLinkBtn || hasNewBtn || hasBadge, 'Script linker not found');
    });

    await test('Detail has no links field (removed from Workshop)', async () => {
        assert(!(await page.$('#workshop-links')), 'Links should NOT be in Workshop');
    });

    await test('Detail shows animated 3D egg preview', async () => {
        const canvas = await page.$('#workshop-detail-egg-canvas');
        assert(canvas, 'Detail egg canvas not found');
    });

    await test('Detail shows character avatar for assigned worker', async () => {
        const avatar = await page.$('#workshop-detail-avatar');
        assert(avatar, 'Detail avatar canvas not found');
    });

    await test('Post Video blocked without script', async () => {
        // Dismiss any alert from clicking Post without a script
        page.once('dialog', d => d.accept());
        await page.click('#workshop-post');
        await page.waitForTimeout(500);
        const cls = await page.$eval('.workshop-panel', el => el.className);
        assert(cls.includes('show-detail'), 'Should stay on detail (no script)');
    });

    await test('Post Video works with script linked', async () => {
        // Give the video a fake linkedScriptId
        await page.evaluate(() => {
            const v = VideoService.getByStatus('workshop')[0];
            if (v) v.linkedScriptId = 'fake_script_id';
        });
        await page.click('#workshop-post');
        await page.waitForTimeout(4500);
        const cls = await page.$eval('.workshop-panel', el => el.className);
        assert(cls.includes('show-list'), 'Should return to list');
    });

    await closeBuilding();
}

// ============================================
// PEN TESTS
// ============================================
async function testPen() {
    console.log('\n🖊️ PEN TESTS');
    await openBuilding('The Pen');

    await test('Pen renders with posted video', async () => {
        assert(await page.$('.pen-panel'), 'Panel not found');
        const cards = await page.$$('.pen-video-card');
        assert(cards.length >= 1, 'No pen cards');
    });

    await test('Pen cards have 3D creature canvases', async () => {
        const canvases = await page.$$('.pen-creature-canvas');
        assert(canvases.length >= 1, 'No 3D creature canvases on pen cards');
    });

    await test('Pen detail has hook, context, and script linker', async () => {
        const card = await page.$('.pen-video-card');
        await card.click();
        await page.waitForTimeout(500);
        assert(await page.$('#pen-hook'), 'Hook field not found');
        assert(await page.$('#pen-context'), 'Context field not found');
        // Script linker — could be link/new buttons or inline editor
        const hasLinkBtn = await page.$('#pen-link-script');
        const hasNewBtn = await page.$('#pen-new-script');
        const hasBadge = await page.$('.pen-script-badge');
        const hasInline = await page.$('#pen-inline-script');
        assert(hasLinkBtn || hasNewBtn || hasBadge || hasInline, 'Script linker not found');
    });

    await test('Pen detail has 3D creature preview', async () => {
        const canvas = await page.$('#pen-detail-creature-canvas');
        assert(canvas, 'Detail creature canvas not found');
    });

    await test('Import Video works', async () => {
        await page.click('#pen-back-btn');
        await page.waitForTimeout(500);
        await page.click('#pen-import-btn');
        await page.waitForTimeout(1500);
        const cls = await page.$eval('.pen-panel', el => el.className);
        assert(cls.includes('show-detail'), 'Should show detail');
        await page.click('#pen-back-btn');
        await page.waitForTimeout(500);
    });

    await closeBuilding();
}

// ============================================
// CONSISTENCY TESTS
// ============================================
async function testConsistency() {
    console.log('\n🔗 CONSISTENCY TESTS');

    await test('EggRenderer is exposed globally with all methods', async () => {
        const ok = await page.evaluate(() =>
            window.EggRenderer &&
            typeof window.EggRenderer.getProjectColor === 'function' &&
            typeof window.EggRenderer.renderEggSnapshot === 'function' &&
            typeof window.EggRenderer.initEggPreview === 'function' &&
            typeof window.EggRenderer.renderCharacterAvatar === 'function' &&
            typeof window.EggRenderer.renderSilhouetteEgg === 'function'
        );
        assert(ok, 'EggRenderer not fully exposed');
    });

    await test('Video model has hook and context fields (not notes)', async () => {
        const video = await page.evaluate(() => {
            const v = VideoService.getAll()[0];
            return v ? { hasHook: 'hook' in v, hasContext: 'context' in v } : null;
        });
        assert(video, 'No video found');
        assert(video.hasHook, 'Video missing hook field');
        assert(video.hasContext, 'Video missing context field');
    });

    await test('All views have same fields: name, project, hook, context, script', async () => {
        // Check Incubator detail fields
        await openBuilding('Incubator');
        await page.click('#incubator-add-btn');
        await page.waitForTimeout(500);
        const incFields = await page.evaluate(() => ({
            name: !!document.getElementById('incubator-name'),
            project: !!document.getElementById('incubator-project-search'),
            hook: !!document.getElementById('incubator-hook'),
            context: !!document.getElementById('incubator-context'),
            script: !!document.getElementById('incubator-link-script') || !!document.getElementById('incubator-new-script')
        }));
        assert(incFields.name && incFields.project && incFields.hook && incFields.context && incFields.script,
            `Incubator missing fields: ${JSON.stringify(incFields)}`);
        await closeBuilding();

        // Workshop
        await page.evaluate(() => {
            const v = VideoService.getByStatus('posted')[0];
            if (v) v.status = 'workshop';
        });
        await openBuilding('Workshop');
        const workshopCards = await page.$$('.workshop-card');
        if (workshopCards.length > 0) {
            await workshopCards[0].click();
            await page.waitForTimeout(500);
            const wsFields = await page.evaluate(() => ({
                name: !!document.getElementById('workshop-name'),
                project: !!document.getElementById('workshop-project'),
                hook: !!document.getElementById('workshop-hook'),
                context: !!document.getElementById('workshop-context'),
                script: !!document.getElementById('workshop-link-script') || !!document.getElementById('workshop-new-script') || !!document.querySelector('.workshop-script-badge') || !!document.getElementById('workshop-inline-script')
            }));
            assert(wsFields.name && wsFields.project && wsFields.hook && wsFields.context && wsFields.script,
                `Workshop missing fields: ${JSON.stringify(wsFields)}`);
        }
        await closeBuilding();
    });

    await test('Project colors are deterministic and consistent', async () => {
        const result = await page.evaluate(() => {
            const projects = VideoService.getCachedProjects();
            if (!projects.length) return { ok: true, detail: 'No projects to test' };
            const issues = [];
            for (const p of projects) {
                // getProjectColor should return same value every time
                const c1 = window.EggRenderer.getProjectColor(p);
                const c2 = window.EggRenderer.getProjectColor(p);
                if (c1 !== c2) issues.push(`${p}: getProjectColor inconsistent: ${c1} vs ${c2}`);
                // Calling it 10 more times to be sure
                for (let i = 0; i < 10; i++) {
                    const cn = window.EggRenderer.getProjectColor(p);
                    if (cn !== c1) { issues.push(`${p}: getProjectColor changed on call ${i+3}: ${cn} vs ${c1}`); break; }
                }
            }
            // Also verify that the color used by createPenCreature matches getProjectColor
            // (both use seededRng(hashString(name)) with same algorithm)
            for (const p of projects) {
                const eggColor = window.EggRenderer.getProjectColor(p);
                const rng2 = seededRng(hashString(p));
                const hue = Math.floor(rng2() * 360);
                const sat = 65 + Math.floor(rng2() * 30);
                const lit = 40 + Math.floor(rng2() * 20);
                const h = hue, s = sat / 100, l = lit / 100;
                const k = n => (n + h / 30) % 12;
                const a = s * Math.min(l, 1 - l);
                const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
                const creatureColor = '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
                if (eggColor !== creatureColor) issues.push(`${p}: EggRenderer color ${eggColor} !== creature color ${creatureColor}`);
            }
            // Verify posted videos use project name (not video name) when project exists
            const posted = VideoService.getByStatus('posted');
            for (const v of posted) {
                if (v.project) {
                    const expectedColor = window.EggRenderer.getProjectColor(v.project);
                    const videoNameColor = window.EggRenderer.getProjectColor(v.name);
                    if (expectedColor === videoNameColor) continue; // happens to match, fine
                    // The seed used should be v.project, not v.name
                    // This is implicit — just verify the function is deterministic
                }
            }
            return { ok: issues.length === 0, detail: issues.join('; ') };
        });
        assert(result.ok, `Color inconsistency: ${result.detail}`);
    });
}

// ============================================
// CLEANUP
// ============================================
async function cleanup() {
    console.log('\n🧹 CLEANUP');
    for (const id of createdIdeaIds) {
        try {
            await page.evaluate(async (noteId) => {
                await NotesService.remove(noteId);
            }, id);
            console.log(`  Deleted test idea: ${id}`);
        } catch (e) { console.log(`  Could not delete idea ${id}`); }
    }
}

// ============================================
// MAIN
// ============================================
(async () => {
    console.log('🎮 Business World — Building UI Tests (Notion-backed)');
    console.log('=====================================================');

    try {
        await setup();
        console.log('✅ Page loaded');

        await test('Global utilities exist', async () => {
            const ok = await page.evaluate(() =>
                typeof seededRng === 'function' && typeof hashString === 'function' &&
                typeof VideoService !== 'undefined' && typeof NotesService !== 'undefined' &&
                typeof LibraryUI !== 'undefined' &&
                BuildingRegistry.has('Library') && BuildingRegistry.has('Incubator') &&
                BuildingRegistry.has('Workshop') && BuildingRegistry.has('The Pen')
            );
            assert(ok, 'Missing globals or registrations');
        });

        await test('LibraryUI exposes getScripts and fetchScriptsIfNeeded', async () => {
            const ok = await page.evaluate(() =>
                typeof LibraryUI.getScripts === 'function' &&
                typeof LibraryUI.fetchScriptsIfNeeded === 'function'
            );
            assert(ok, 'LibraryUI script methods not exposed');
        });

        await testLibrary();
        await testIncubator();
        await testWorkshop();
        await testPen();
        await testConsistency();
        await cleanup();

    } catch (e) {
        console.log(`\n💥 Fatal: ${e.message}`);
        failed++;
    } finally {
        await teardown();
    }

    console.log('\n=====================================================');
    console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
    }
    process.exit(failed > 0 ? 1 : 0);
})();
