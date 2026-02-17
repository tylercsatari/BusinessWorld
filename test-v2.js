const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'test-screenshots', 'v2');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
    const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`  Screenshot saved: ${filepath}`);
    return filepath;
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    console.log('=== Business World V2 - Comprehensive Test ===\n');

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // Collect ALL console messages
    const consoleMessages = [];
    const consoleErrors = [];
    const networkErrors = [];

    page.on('console', msg => {
        const entry = { type: msg.type(), text: msg.text() };
        consoleMessages.push(entry);
        if (msg.type() === 'error') {
            consoleErrors.push(msg.text());
        }
    });

    page.on('pageerror', err => {
        consoleErrors.push(`PAGE ERROR: ${err.message}`);
    });

    page.on('requestfailed', req => {
        networkErrors.push(`FAILED REQUEST: ${req.url()} - ${req.failure()?.errorText || 'unknown'}`);
    });

    const results = [];
    function log(test, status, detail = '') {
        const entry = { test, status, detail };
        results.push(entry);
        const icon = status === 'PASS' ? 'OK' : status === 'FAIL' ? 'XX' : status === 'WARN' ? '!!' : '--';
        console.log(`  [${icon}] ${test}${detail ? ' - ' + detail : ''}`);
    }

    try {
        // ========================================
        // TEST 1: Navigate and wait for load
        // ========================================
        console.log('\n--- TEST 1: Navigate to app and wait for load ---');
        const response = await page.goto('http://localhost:8002', { waitUntil: 'networkidle', timeout: 30000 });
        log('HTTP response OK', response.status() === 200 ? 'PASS' : 'FAIL', `Status: ${response.status()}`);

        // Wait 3 seconds for Three.js to fully initialize
        console.log('  Waiting 3 seconds for Three.js initialization...');
        await wait(3000);

        const title = await page.title();
        log('Page title correct', title === 'Business World' ? 'PASS' : 'FAIL', `"${title}"`);

        // ========================================
        // TEST 2: Initial screenshot
        // ========================================
        console.log('\n--- TEST 2: Initial screenshot ---');
        await screenshot(page, '01-initial-load');

        // ========================================
        // TEST 3: Console errors (CRITICAL)
        // ========================================
        console.log('\n--- TEST 3: Console errors check (CRITICAL) ---');

        if (consoleErrors.length === 0 && networkErrors.length === 0) {
            log('No JavaScript errors', 'PASS', 'Clean console');
        } else {
            if (consoleErrors.length > 0) {
                log('JavaScript errors found', 'FAIL', `${consoleErrors.length} error(s)`);
                console.log('\n  === CONSOLE ERRORS (VERBATIM) ===');
                consoleErrors.forEach((err, i) => {
                    console.log(`  ERROR ${i + 1}: ${err}`);
                });
                console.log('  === END CONSOLE ERRORS ===\n');
            }
            if (networkErrors.length > 0) {
                log('Network request failures', 'FAIL', `${networkErrors.length} failure(s)`);
                console.log('\n  === NETWORK ERRORS (VERBATIM) ===');
                networkErrors.forEach((err, i) => {
                    console.log(`  NET ERROR ${i + 1}: ${err}`);
                });
                console.log('  === END NETWORK ERRORS ===\n');
            }
        }

        // Check if ES modules loaded properly
        const modulesLoaded = await page.evaluate(() => {
            return typeof window.__THREE_LOADED__ !== 'undefined' || document.querySelectorAll('canvas').length > 0;
        });
        log('ES Modules loaded (canvas exists)', modulesLoaded ? 'PASS' : 'FAIL');

        // Check if Three.js scene is accessible (module scope - check via canvas)
        const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
        log('Canvas element rendered', canvasCount > 0 ? 'PASS' : 'FAIL', `${canvasCount} canvas(es)`);

        // Check for import map
        const importMap = await page.evaluate(() => {
            const script = document.querySelector('script[type="importmap"]');
            return script ? JSON.parse(script.textContent) : null;
        });
        log('Import map present', importMap ? 'PASS' : 'FAIL',
            importMap ? `three -> ${importMap.imports.three}` : 'Not found');

        // ========================================
        // TEST 4: Open hamburger menu - screenshot
        // ========================================
        console.log('\n--- TEST 4: Hamburger menu ---');

        const hamburgerVisible = await page.isVisible('#hamburger-btn');
        log('Hamburger button visible', hamburgerVisible ? 'PASS' : 'FAIL');

        await page.click('#hamburger-btn');
        await wait(500);

        const menuOpen = await page.evaluate(() => {
            return document.getElementById('menu-panel').classList.contains('open');
        });
        log('Menu opens on click', menuOpen ? 'PASS' : 'FAIL');

        // Check menu has controls section
        const menuContent = await page.textContent('#menu-panel');
        log('Menu has Controls section', menuContent.includes('Controls') ? 'PASS' : 'FAIL');
        log('Menu has WASD control', menuContent.includes('W A S D') ? 'PASS' : 'FAIL');
        log('Menu has Edit Mode section', menuContent.includes('Edit Mode') ? 'PASS' : 'FAIL');
        log('Menu has Buildings section', menuContent.includes('Buildings') ? 'PASS' : 'FAIL');
        log('Menu has Scroll control', menuContent.includes('Scroll') ? 'PASS' : 'FAIL');
        log('Menu has R-Click control', menuContent.includes('R-Click') ? 'PASS' : 'FAIL');

        await screenshot(page, '02-hamburger-menu-open');

        // Close menu
        await page.click('#menu-overlay');
        await wait(500);

        // ========================================
        // TEST 5: Edit mode - path control points
        // ========================================
        console.log('\n--- TEST 5: Edit mode & path control points ---');

        await page.click('#edit-btn');
        await wait(500);

        const editModeActive = await page.evaluate(() => {
            return document.getElementById('edit-btn').classList.contains('active');
        });
        log('Edit mode activates', editModeActive ? 'PASS' : 'FAIL');

        const editBtnText = await page.textContent('#edit-btn');
        log('Button text changes to Done Editing', editBtnText.includes('Done') ? 'PASS' : 'FAIL', `"${editBtnText}"`);

        const editIndicatorShown = await page.evaluate(() => {
            return document.getElementById('edit-indicator').style.display === 'block';
        });
        log('Edit indicator shown', editIndicatorShown ? 'PASS' : 'FAIL');

        // Check for path control points (red spheres in the 3D scene)
        const pathControlPoints = await page.evaluate(() => {
            let controlPointCount = 0;
            if (typeof pathControlPointMeshes !== 'undefined') {
                return pathControlPointMeshes.length;
            }
            // Fallback: count red sphere meshes visible in edit mode
            let redSpheres = 0;
            if (typeof scene !== 'undefined') {
                scene.traverse(child => {
                    if (child.isMesh && child.geometry?.type === 'SphereGeometry' && child.visible) {
                        const color = child.material?.color;
                        if (color && (color.r > 0.8 && color.g < 0.3 && color.b < 0.3)) {
                            redSpheres++;
                        }
                    }
                });
            }
            return redSpheres;
        });
        log('Path control points (red spheres)', pathControlPoints > 0 ? 'PASS' : 'WARN',
            `${pathControlPoints} control points found`);

        await screenshot(page, '03-edit-mode-active');

        // Deactivate edit mode
        await page.click('#edit-btn');
        await wait(500);

        // ========================================
        // TEST 6: Zoom in for character close-up
        // ========================================
        console.log('\n--- TEST 6: Zoom in for character close-up ---');

        // Zoom in close by setting camera distance directly
        const zoomWorked = await page.evaluate(() => {
            if (typeof cameraDistance !== 'undefined') {
                cameraDistance = 15;
                return true;
            }
            return false;
        });

        if (!zoomWorked) {
            // Try scroll zoom as fallback
            for (let i = 0; i < 10; i++) {
                await page.mouse.wheel(0, -200);
                await wait(100);
            }
        }

        await wait(1000);
        await screenshot(page, '04-character-closeup');
        log('Zoomed in for character view', 'PASS', zoomWorked ? 'Direct camera control' : 'Scroll wheel');

        // Check character design (life-peg style = no arms, no legs, no mouth)
        const characterInfo = await page.evaluate(() => {
            if (typeof playerMesh === 'undefined') return null;
            let childCount = 0;
            let meshTypes = [];
            playerMesh.traverse(child => {
                if (child.isMesh) {
                    childCount++;
                    meshTypes.push(child.geometry.type);
                }
            });
            return { childCount, meshTypes, position: {
                x: playerMesh.position.x.toFixed(2),
                y: playerMesh.position.y.toFixed(2),
                z: playerMesh.position.z.toFixed(2)
            }};
        });

        if (characterInfo) {
            log('Player mesh exists', 'PASS',
                `${characterInfo.childCount} mesh parts, types: ${[...new Set(characterInfo.meshTypes)].join(', ')}`);
            log('Player position', 'INFO',
                `(${characterInfo.position.x}, ${characterInfo.position.y}, ${characterInfo.position.z})`);
        } else {
            log('Player mesh exists', 'FAIL', 'playerMesh not found in module scope');
        }

        // ========================================
        // TEST 7: Final overview screenshot
        // ========================================
        console.log('\n--- TEST 7: Final overview screenshot ---');

        // Reset camera to overview
        const resetWorked = await page.evaluate(() => {
            if (typeof cameraDistance !== 'undefined') {
                cameraDistance = 50;
                cameraAngle = Math.PI / 4;
                cameraPitch = Math.PI / 3.5;
                if (typeof cameraTarget !== 'undefined') {
                    cameraTarget.set(0, 0, 0);
                }
                return true;
            }
            return false;
        });

        await wait(1000);
        await screenshot(page, '05-final-overview');
        log('Final overview captured', 'PASS');

        // ========================================
        // BONUS: Check post-processing & shaders
        // ========================================
        console.log('\n--- BONUS: Post-processing & shader checks ---');

        const postProcessing = await page.evaluate(() => {
            const info = {};
            info.hasComposer = typeof composer !== 'undefined';
            info.hasBloom = typeof bloomPass !== 'undefined';
            // Check for custom shaders
            let customShaderCount = 0;
            if (typeof scene !== 'undefined') {
                scene.traverse(child => {
                    if (child.isMesh && child.material?.type === 'ShaderMaterial') {
                        customShaderCount++;
                    }
                });
            }
            info.customShaders = customShaderCount;
            // Check for PBR materials
            let pbrCount = 0;
            if (typeof scene !== 'undefined') {
                scene.traverse(child => {
                    if (child.isMesh && child.material?.type === 'MeshStandardMaterial') {
                        pbrCount++;
                    }
                });
            }
            info.pbrMaterials = pbrCount;
            // Check for particles
            let particleCount = 0;
            if (typeof scene !== 'undefined') {
                scene.traverse(child => {
                    if (child.isPoints) particleCount++;
                });
            }
            info.particleSystems = particleCount;
            return info;
        });

        if (postProcessing) {
            log('EffectComposer exists', postProcessing.hasComposer ? 'PASS' : 'WARN',
                postProcessing.hasComposer ? 'Post-processing active' : 'Not found (module scope)');
            log('Bloom pass exists', postProcessing.hasBloom ? 'PASS' : 'WARN');
            log('Custom shaders', postProcessing.customShaders > 0 ? 'PASS' : 'WARN',
                `${postProcessing.customShaders} ShaderMaterial instances`);
            log('PBR materials (MeshStandardMaterial)', postProcessing.pbrMaterials > 0 ? 'PASS' : 'WARN',
                `${postProcessing.pbrMaterials} PBR materials`);
            log('Particle systems', postProcessing.particleSystems > 0 ? 'PASS' : 'WARN',
                `${postProcessing.particleSystems} particle system(s)`);
        }

        // Final error recheck after all interactions
        console.log('\n--- Final console error recheck ---');
        if (consoleErrors.length === 0) {
            log('No errors after all interactions', 'PASS', 'Clean console throughout');
        } else {
            log('Errors found during testing', 'FAIL', `${consoleErrors.length} total error(s)`);
            console.log('\n  === ALL CONSOLE ERRORS (VERBATIM) ===');
            consoleErrors.forEach((err, i) => {
                console.log(`  ERROR ${i + 1}: ${err}`);
            });
            console.log('  === END ALL CONSOLE ERRORS ===\n');
        }

        if (networkErrors.length > 0) {
            console.log('\n  === ALL NETWORK ERRORS (VERBATIM) ===');
            networkErrors.forEach((err, i) => {
                console.log(`  NET ERROR ${i + 1}: ${err}`);
            });
            console.log('  === END ALL NETWORK ERRORS ===\n');
        }

    } catch (err) {
        console.error('\nTEST SCRIPT ERROR:', err.message);
        console.error(err.stack);
        try { await screenshot(page, 'ERROR-state'); } catch (e) {}
    }

    // ========================================
    // SUMMARY
    // ========================================
    console.log('\n========================================');
    console.log('       TEST RESULTS SUMMARY');
    console.log('========================================');

    let pass = 0, fail = 0, warn = 0, info = 0;
    results.forEach(r => {
        if (r.status === 'PASS') pass++;
        else if (r.status === 'FAIL') fail++;
        else if (r.status === 'WARN') warn++;
        else info++;
    });

    console.log(`\n  PASS: ${pass}  |  FAIL: ${fail}  |  WARN: ${warn}  |  INFO: ${info}`);
    console.log(`  Total: ${results.length} tests\n`);

    results.forEach(r => {
        const icon = r.status === 'PASS' ? 'OK' : r.status === 'FAIL' ? 'XX' : r.status === 'WARN' ? '!!' : '--';
        console.log(`  [${icon}] ${r.test}${r.detail ? ' - ' + r.detail : ''}`);
    });

    console.log(`\n  Console messages total: ${consoleMessages.length}`);
    console.log(`  Console errors: ${consoleErrors.length}`);
    console.log(`  Network errors: ${networkErrors.length}`);

    await browser.close();
    console.log('\n  Screenshots saved to:', SCREENSHOTS_DIR);
    console.log('  Done.\n');
})();
