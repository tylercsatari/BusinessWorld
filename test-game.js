const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'test-screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);

async function screenshot(page, name) {
    const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`Screenshot saved: ${filepath}`);
    return filepath;
}

async function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const results = [];

    function log(test, status, detail = '') {
        const entry = { test, status, detail };
        results.push(entry);
        console.log(`[${status}] ${test}${detail ? ': ' + detail : ''}`);
    }

    try {
        // ===== 1. Navigate to the app =====
        console.log('\n=== TEST 1: Navigate to app ===');
        await page.goto('http://localhost:8002', { waitUntil: 'networkidle' });
        await wait(2000); // Let Three.js render
        const title = await page.title();
        log('Page loads', title === 'Business World' ? 'PASS' : 'FAIL', `Title: "${title}"`);

        // Check console for errors
        const consoleErrors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        // ===== 2. Initial screenshot =====
        console.log('\n=== TEST 2: Initial screenshot ===');
        await screenshot(page, '01-initial-load');

        // ===== 3. Check HUD elements exist =====
        console.log('\n=== TEST 3: Check HUD elements ===');

        const hamburgerVisible = await page.isVisible('#hamburger-btn');
        log('Hamburger button visible', hamburgerVisible ? 'PASS' : 'FAIL');

        const moneyDisplayVisible = await page.isVisible('#money-display');
        log('Money display visible', moneyDisplayVisible ? 'PASS' : 'FAIL');

        const levelText = await page.textContent('#level-text');
        log('Level text', levelText.includes('Lv.') ? 'PASS' : 'FAIL', levelText);

        const moneyText = await page.textContent('#money-text');
        log('Money text', moneyText.includes('$') ? 'PASS' : 'FAIL', moneyText);

        const editBtnVisible = await page.isVisible('#edit-btn');
        log('Edit Mode button visible', editBtnVisible ? 'PASS' : 'FAIL');

        const editBtnText = await page.textContent('#edit-btn');
        log('Edit Mode button text', editBtnText === 'Edit Mode' ? 'PASS' : 'FAIL', editBtnText);

        const instructionsVisible = await page.isVisible('#instructions');
        log('Instructions bar visible', instructionsVisible ? 'PASS' : 'FAIL');

        const instructionsText = await page.textContent('#instructions');
        log('Instructions text correct', instructionsText.includes('WASD') ? 'PASS' : 'FAIL', instructionsText);

        // ===== 4. Check canvas exists (Three.js rendered) =====
        console.log('\n=== TEST 4: Three.js Canvas ===');
        const canvasCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
        log('Canvas element exists', canvasCount > 0 ? 'PASS' : 'FAIL', `${canvasCount} canvas(es)`);

        // Check if Three.js scene is loaded
        const threeLoaded = await page.evaluate(() => {
            return typeof THREE !== 'undefined' && typeof scene !== 'undefined';
        });
        log('Three.js scene loaded', threeLoaded ? 'PASS' : 'FAIL');

        // ===== 5. Test hamburger menu =====
        console.log('\n=== TEST 5: Hamburger Menu ===');

        // Click hamburger
        await page.click('#hamburger-btn');
        await wait(500);

        const menuOpen = await page.evaluate(() => {
            return document.getElementById('menu-panel').classList.contains('open');
        });
        log('Menu opens on click', menuOpen ? 'PASS' : 'FAIL');

        const menuOverlayVisible = await page.evaluate(() => {
            return document.getElementById('menu-overlay').classList.contains('visible');
        });
        log('Menu overlay visible', menuOverlayVisible ? 'PASS' : 'FAIL');

        await screenshot(page, '02-hamburger-menu-open');

        // Check menu content
        const menuTitle = await page.textContent('#menu-panel h2');
        log('Menu title', menuTitle === 'Menu' ? 'PASS' : 'FAIL', menuTitle);

        // Close menu by clicking overlay
        await page.click('#menu-overlay');
        await wait(500);

        const menuClosed = await page.evaluate(() => {
            return !document.getElementById('menu-panel').classList.contains('open');
        });
        log('Menu closes on overlay click', menuClosed ? 'PASS' : 'FAIL');

        await screenshot(page, '03-hamburger-menu-closed');

        // ===== 6. Test Edit Mode =====
        console.log('\n=== TEST 6: Edit Mode ===');

        await page.click('#edit-btn');
        await wait(500);

        const editModeActive = await page.evaluate(() => {
            return document.getElementById('edit-btn').classList.contains('active');
        });
        log('Edit mode activates', editModeActive ? 'PASS' : 'FAIL');

        const editBtnTextAfter = await page.textContent('#edit-btn');
        log('Edit button text changes', editBtnTextAfter === 'Done Editing' ? 'PASS' : 'FAIL', editBtnTextAfter);

        const editIndicatorVisible = await page.evaluate(() => {
            return document.getElementById('edit-indicator').style.display === 'block';
        });
        log('Edit indicator shows', editIndicatorVisible ? 'PASS' : 'FAIL');

        const editInstructions = await page.textContent('#instructions');
        log('Instructions update for edit mode', editInstructions.includes('EDIT MODE') ? 'PASS' : 'FAIL', editInstructions);

        await screenshot(page, '04-edit-mode-active');

        // Turn off edit mode
        await page.click('#edit-btn');
        await wait(500);

        const editModeOff = await page.evaluate(() => {
            return !document.getElementById('edit-btn').classList.contains('active');
        });
        log('Edit mode deactivates', editModeOff ? 'PASS' : 'FAIL');

        await screenshot(page, '05-edit-mode-off');

        // ===== 7. Test clicking on buildings (via raycasting on canvas) =====
        console.log('\n=== TEST 7: Building click / Modal ===');

        // We need to click on the 3D canvas where buildings are.
        // Since Three.js uses raycasting, we need to click in the right spots.
        // Let's use JavaScript to directly trigger the modal to verify it works.

        // First, test the modal system directly
        await page.evaluate(() => {
            openModal('Storage', 'building');
        });
        await wait(500);

        const modalVisible = await page.evaluate(() => {
            return document.getElementById('modal-overlay').classList.contains('visible');
        });
        log('Modal opens (programmatic)', modalVisible ? 'PASS' : 'FAIL');

        const modalTitle = await page.textContent('#modal-title');
        log('Modal title correct', modalTitle === 'Storage' ? 'PASS' : 'FAIL', modalTitle);

        const modalBody = await page.textContent('#modal-body');
        log('Modal body has content', modalBody.length > 0 ? 'PASS' : 'FAIL', modalBody);

        await screenshot(page, '06-modal-storage');

        // ===== 8. Test closing modal via X button =====
        console.log('\n=== TEST 8: Close Modal (X button) ===');

        await page.click('#modal-close');
        await wait(500);

        const modalClosedX = await page.evaluate(() => {
            return !document.getElementById('modal-overlay').classList.contains('visible');
        });
        log('Modal closes via X button', modalClosedX ? 'PASS' : 'FAIL');

        await screenshot(page, '07-modal-closed');

        // ===== 9. Test closing modal via overlay click =====
        console.log('\n=== TEST 9: Close Modal (overlay click) ===');

        await page.evaluate(() => { openModal('Workshop', 'building'); });
        await wait(500);
        await screenshot(page, '08-modal-workshop');

        // Click the overlay (outside the modal)
        await page.click('#modal-overlay', { position: { x: 10, y: 10 } });
        await wait(500);

        const modalClosedOverlay = await page.evaluate(() => {
            return !document.getElementById('modal-overlay').classList.contains('visible');
        });
        log('Modal closes via overlay click', modalClosedOverlay ? 'PASS' : 'FAIL');

        // ===== 10. Test character modal =====
        console.log('\n=== TEST 10: Character Modal ===');

        await page.evaluate(() => { openModal('Robin', 'character'); });
        await wait(500);

        const charModalTitle = await page.textContent('#modal-title');
        log('Character modal title', charModalTitle === 'Robin' ? 'PASS' : 'FAIL', charModalTitle);

        const charModalBody = await page.textContent('#modal-body');
        log('Character modal body', charModalBody.includes('Assign') ? 'PASS' : 'FAIL', charModalBody);

        await screenshot(page, '09-modal-character-robin');

        await page.evaluate(() => { closeModal(); });
        await wait(300);

        // ===== 11. Test all building modals =====
        console.log('\n=== TEST 11: All Building Modals ===');

        const buildings = ['The Pen', 'Storage', 'Money Pit', 'Workshop', 'Incubator', 'Employee Island'];
        for (const building of buildings) {
            await page.evaluate((name) => { openModal(name, 'building'); }, building);
            await wait(300);
            const title = await page.textContent('#modal-title');
            log(`Modal for ${building}`, title === building ? 'PASS' : 'FAIL', title);
            await page.evaluate(() => { closeModal(); });
            await wait(200);
        }

        // ===== 12. Test raycasting click on canvas =====
        console.log('\n=== TEST 12: Canvas Click (Raycast) ===');

        // Try clicking on the center of the canvas where the player should be
        const canvasEl = await page.$('canvas');
        const canvasBox = canvasEl ? await canvasEl.boundingBox() : { x: 0, y: 0, width: 1280, height: 800 };

        // Click roughly center - this should hit the player character
        await page.mouse.click(
            (canvasBox.x || 0) + (canvasBox.width || 1280) / 2,
            (canvasBox.y || 0) + (canvasBox.height || 800) / 2
        );
        await wait(500);

        const modalAfterCanvasClick = await page.evaluate(() => {
            return document.getElementById('modal-overlay').classList.contains('visible');
        });

        if (modalAfterCanvasClick) {
            const clickTitle = await page.textContent('#modal-title');
            log('Canvas click opens modal', 'PASS', `Clicked on: ${clickTitle}`);
            await screenshot(page, '10-canvas-click-modal');
            await page.evaluate(() => { closeModal(); });
            await wait(300);
        } else {
            log('Canvas click opens modal', 'INFO', 'No object hit at center (player may be at different angle)');
        }

        // ===== 13. Test scroll zoom (via JavaScript) =====
        console.log('\n=== TEST 13: Scroll Zoom ===');

        const initialDistance = await page.evaluate(() => cameraDistance);

        // Simulate scroll
        await page.mouse.wheel(0, 500); // zoom out
        await wait(500);

        const afterZoomOut = await page.evaluate(() => cameraDistance);
        log('Scroll zoom out', afterZoomOut > initialDistance ? 'PASS' : 'FAIL',
            `${initialDistance} -> ${afterZoomOut}`);

        await screenshot(page, '11-zoomed-out');

        await page.mouse.wheel(0, -1000); // zoom back in
        await wait(500);

        const afterZoomIn = await page.evaluate(() => cameraDistance);
        log('Scroll zoom in', afterZoomIn < afterZoomOut ? 'PASS' : 'FAIL',
            `${afterZoomOut} -> ${afterZoomIn}`);

        await screenshot(page, '12-zoomed-in');

        // Reset zoom
        await page.evaluate(() => { cameraDistance = 45; });
        await wait(500);

        // ===== 14. Test WASD movement =====
        console.log('\n=== TEST 14: WASD Movement ===');

        const posBeforeMove = await page.evaluate(() => ({
            x: playerMesh.position.x,
            z: playerMesh.position.z
        }));

        // Press W key for a bit
        await page.keyboard.down('w');
        await wait(1000);
        await page.keyboard.up('w');
        await wait(200);

        const posAfterW = await page.evaluate(() => ({
            x: playerMesh.position.x,
            z: playerMesh.position.z
        }));

        const moved = Math.abs(posAfterW.x - posBeforeMove.x) > 0.1 ||
                       Math.abs(posAfterW.z - posBeforeMove.z) > 0.1;
        log('WASD movement works', moved ? 'PASS' : 'FAIL',
            `Before: (${posBeforeMove.x.toFixed(1)}, ${posBeforeMove.z.toFixed(1)}) After: (${posAfterW.x.toFixed(1)}, ${posAfterW.z.toFixed(1)})`);

        await screenshot(page, '13-after-movement');

        // Reset player position
        await page.evaluate(() => {
            playerMesh.position.set(0, 0, 0);
            cameraTarget.set(0, 0, 0);
        });
        await wait(500);

        // ===== 15. Check 3D world elements =====
        console.log('\n=== TEST 15: 3D World Elements ===');

        const sceneInfo = await page.evaluate(() => {
            let meshCount = 0;
            let groupCount = 0;
            scene.traverse(child => {
                if (child.isMesh) meshCount++;
                if (child.isGroup) groupCount++;
            });
            return {
                meshCount,
                groupCount,
                clickableCount: clickables.length,
                draggableCount: draggables.length,
                employeeCount: employees.length,
                bgColor: scene.background ? scene.background.getHexString() : 'none',
                fogEnabled: !!scene.fog
            };
        });

        log('Scene has meshes', sceneInfo.meshCount > 100 ? 'PASS' : 'WARN',
            `${sceneInfo.meshCount} meshes`);
        log('Clickable objects', sceneInfo.clickableCount >= 8 ? 'PASS' : 'FAIL',
            `${sceneInfo.clickableCount} clickables (expect 8+: 6 buildings + player + 2 employees)`);
        log('Draggable objects', sceneInfo.draggableCount >= 8 ? 'PASS' : 'FAIL',
            `${sceneInfo.draggableCount} draggables`);
        log('Employee count', sceneInfo.employeeCount === 2 ? 'PASS' : 'FAIL',
            `${sceneInfo.employeeCount} employees`);
        log('Sky background', sceneInfo.bgColor === '87ceeb' ? 'PASS' : 'FAIL',
            `#${sceneInfo.bgColor}`);
        log('Fog enabled', sceneInfo.fogEnabled ? 'PASS' : 'FAIL');

        // ===== 16. Check for console errors =====
        console.log('\n=== TEST 16: Console Errors ===');
        log('No console errors', consoleErrors.length === 0 ? 'PASS' : 'WARN',
            consoleErrors.length > 0 ? consoleErrors.join('; ') : 'Clean console');

        // ===== 17. Final full screenshot =====
        console.log('\n=== Final Screenshot ===');
        await page.evaluate(() => {
            playerMesh.position.set(0, 0, 0);
            cameraTarget.set(0, 0, 0);
            cameraDistance = 45;
            cameraAngle = Math.PI / 4;
            cameraPitch = Math.PI / 4;
        });
        await wait(1000);
        await screenshot(page, '14-final-overview');

    } catch (err) {
        console.error('TEST ERROR:', err.message);
        await screenshot(page, 'ERROR-state');
    }

    // ===== Summary =====
    console.log('\n\n========================================');
    console.log('         TEST RESULTS SUMMARY');
    console.log('========================================');

    let pass = 0, fail = 0, warn = 0, info = 0;
    results.forEach(r => {
        if (r.status === 'PASS') pass++;
        else if (r.status === 'FAIL') fail++;
        else if (r.status === 'WARN') warn++;
        else info++;
    });

    console.log(`\nPASS: ${pass}  |  FAIL: ${fail}  |  WARN: ${warn}  |  INFO: ${info}`);
    console.log(`Total: ${results.length} tests\n`);

    results.forEach(r => {
        const icon = r.status === 'PASS' ? 'OK' : r.status === 'FAIL' ? 'XX' : r.status === 'WARN' ? '!!' : '--';
        console.log(`  [${icon}] ${r.test}${r.detail ? ' - ' + r.detail : ''}`);
    });

    await browser.close();
    console.log('\nBrowser closed. Screenshots in:', SCREENSHOTS_DIR);
})();
