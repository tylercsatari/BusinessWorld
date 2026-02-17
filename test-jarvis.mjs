import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.join(__dirname, 'test-screenshots', 'jarvis');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    console.log('Loading Business World...');
    await page.goto('http://localhost:8002', { waitUntil: 'networkidle' });

    // Wait for loading screen to finish
    await page.waitForFunction(() => {
        const overlay = document.getElementById('loading-overlay');
        return overlay && overlay.style.display === 'none';
    }, { timeout: 30000 });
    console.log('Game loaded.');
    await sleep(2000); // let scene settle

    // Screenshot 1: Initial view
    await page.screenshot({ path: path.join(SCREENSHOTS, '01-initial-view.png') });
    console.log('Took initial view screenshot.');

    // Move camera toward Jarvis by pressing D and S keys
    // Jarvis is at position (30, 0, -20) relative to world
    // We need to navigate there using WASD
    // Press D (right) and S (back) to move toward Jarvis direction
    console.log('Moving toward Jarvis...');

    // Use keyboard to navigate - press keys for movement
    // Jarvis is at roughly x=30, z=-20, so we go right (D) and backward (S)
    for (let i = 0; i < 40; i++) {
        await page.keyboard.down('d');
        await sleep(50);
        await page.keyboard.up('d');
        await sleep(30);
    }
    for (let i = 0; i < 25; i++) {
        await page.keyboard.down('s');
        await sleep(50);
        await page.keyboard.up('s');
        await sleep(30);
    }
    await sleep(1500);

    // Screenshot 2: Approach to Jarvis
    await page.screenshot({ path: path.join(SCREENSHOTS, '02-approaching-jarvis.png') });
    console.log('Took approach screenshot.');

    // Scroll to zoom in
    for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(100);
    }
    await sleep(1000);

    // Screenshot 3: Zoomed into Jarvis
    await page.screenshot({ path: path.join(SCREENSHOTS, '03-jarvis-zoomed.png') });
    console.log('Took zoomed Jarvis screenshot.');

    // Rotate camera by right-click drag to see it from another angle
    await page.mouse.move(700, 450);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(500, 400, { steps: 15 });
    await page.mouse.up({ button: 'right' });
    await sleep(1000);

    // Screenshot 4: Rotated view of Jarvis
    await page.screenshot({ path: path.join(SCREENSHOTS, '04-jarvis-rotated.png') });
    console.log('Took rotated Jarvis screenshot.');

    // Zoom in closer
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(100);
    }
    await sleep(1000);

    // Screenshot 5: Close-up of Jarvis network
    await page.screenshot({ path: path.join(SCREENSHOTS, '05-jarvis-closeup.png') });
    console.log('Took close-up screenshot.');

    // Rotate further to see spire
    await page.mouse.move(700, 450);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(700, 300, { steps: 15 });
    await page.mouse.up({ button: 'right' });
    await sleep(1000);

    // Screenshot 6: View of spire/top
    await page.screenshot({ path: path.join(SCREENSHOTS, '06-jarvis-spire.png') });
    console.log('Took spire view screenshot.');

    // Now check the house - move toward it
    console.log('Moving toward The House...');
    // House is at (-30, 0, 20), so go left (A) and forward (W) from Jarvis area
    for (let i = 0; i < 60; i++) {
        await page.keyboard.down('a');
        await sleep(50);
        await page.keyboard.up('a');
        await sleep(30);
    }
    for (let i = 0; i < 40; i++) {
        await page.keyboard.down('w');
        await sleep(50);
        await page.keyboard.up('w');
        await sleep(30);
    }
    // Zoom out a bit
    for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 120);
        await sleep(100);
    }
    await sleep(1500);

    // Screenshot 7: The House area (white walls, black roof, Tennille, Zeus)
    await page.screenshot({ path: path.join(SCREENSHOTS, '07-house-area.png') });
    console.log('Took house area screenshot.');

    // Zoom into house
    for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -120);
        await sleep(100);
    }
    await sleep(1000);

    // Screenshot 8: House close-up
    await page.screenshot({ path: path.join(SCREENSHOTS, '08-house-closeup.png') });
    console.log('Took house close-up screenshot.');

    // Check the Science Center (should be half size)
    // SC is at (24, 0, 20)
    console.log('Moving toward Science Center...');
    for (let i = 0; i < 50; i++) {
        await page.keyboard.down('d');
        await sleep(50);
        await page.keyboard.up('d');
        await sleep(30);
    }
    await sleep(1500);

    // Screenshot 9: Science Center (half size)
    await page.screenshot({ path: path.join(SCREENSHOTS, '09-science-center.png') });
    console.log('Took Science Center screenshot.');

    // Zoom out for overview
    for (let i = 0; i < 15; i++) {
        await page.mouse.wheel(0, 120);
        await sleep(100);
    }
    await sleep(1500);

    // Screenshot 10: Full overview
    await page.screenshot({ path: path.join(SCREENSHOTS, '10-full-overview.png') });
    console.log('Took full overview screenshot.');

    console.log('All screenshots saved to test-screenshots/jarvis/');
    await browser.close();
})();
