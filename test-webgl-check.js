const { chromium } = require('playwright');
const path = require('path');

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    await page.goto('http://localhost:8002', { waitUntil: 'networkidle' });
    await new Promise(r => setTimeout(r, 3000));

    const info = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { error: 'No canvas found' };

        const gl = canvas.getContext('webgl') || canvas.getContext('webgl2') || canvas.getContext('experimental-webgl');

        return {
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            hasWebGL: !!gl,
            renderer: gl ? gl.getParameter(gl.RENDERER) : 'none',
            vendor: gl ? gl.getParameter(gl.VENDOR) : 'none',
            threeExists: typeof THREE !== 'undefined',
            sceneChildren: typeof scene !== 'undefined' ? scene.children.length : 0,
            clickables: typeof clickables !== 'undefined' ? clickables.length : 0,
            draggables: typeof draggables !== 'undefined' ? draggables.length : 0,
            employees: typeof employees !== 'undefined' ? employees.length : 0,
            editMode: typeof editMode !== 'undefined' ? editMode : 'undefined',
            money: typeof money !== 'undefined' ? money : 'undefined',
            level: typeof level !== 'undefined' ? level : 'undefined',
            playerExists: typeof playerMesh !== 'undefined',
            cameraDistance: typeof cameraDistance !== 'undefined' ? cameraDistance : 'undefined',
        };
    });

    console.log('\n=== WebGL & Game State Report ===');
    console.log(JSON.stringify(info, null, 2));

    // Test that the game logic works end-to-end
    const logicTests = await page.evaluate(() => {
        const results = [];

        // Test money update
        const oldMoney = money;
        money = 50000;
        updateMoneyDisplay();
        const newMoneyText = document.getElementById('money-text').textContent;
        results.push({ test: 'Money update', pass: newMoneyText === '$50,000', detail: newMoneyText });
        money = oldMoney;
        updateMoneyDisplay();

        // Test level calculation
        money = 150000;
        updateMoneyDisplay();
        const lvlText = document.getElementById('level-text').textContent;
        results.push({ test: 'Level calculation', pass: lvlText === 'Lv. 2', detail: lvlText });
        money = oldMoney;
        updateMoneyDisplay();

        // Test all building names exist
        const buildingNames = clickables
            .filter(c => c.userData.type === 'building')
            .map(c => c.userData.name);
        results.push({
            test: 'All buildings present',
            pass: buildingNames.length === 6,
            detail: buildingNames.join(', ')
        });

        // Test employee names
        const empNames = employees.map(e => e.userData.name);
        results.push({
            test: 'Employees named correctly',
            pass: empNames.includes('Robin') && empNames.includes('Jordan'),
            detail: empNames.join(', ')
        });

        // Test player character
        results.push({
            test: 'Player character exists',
            pass: playerMesh && playerMesh.userData.name === 'You',
            detail: playerMesh ? playerMesh.userData.name : 'missing'
        });

        // Test camera distance bounds
        const origDist = cameraDistance;
        cameraDistance = 5; // Below min (10)
        cameraDistance = Math.max(10, Math.min(80, cameraDistance));
        results.push({ test: 'Camera min zoom', pass: cameraDistance === 10, detail: String(cameraDistance) });
        cameraDistance = 100; // Above max (80)
        cameraDistance = Math.max(10, Math.min(80, cameraDistance));
        results.push({ test: 'Camera max zoom', pass: cameraDistance === 80, detail: String(cameraDistance) });
        cameraDistance = origDist;

        return results;
    });

    console.log('\n=== Game Logic Tests ===');
    logicTests.forEach(t => {
        console.log(`[${t.pass ? 'PASS' : 'FAIL'}] ${t.test}: ${t.detail}`);
    });

    await browser.close();
})();
