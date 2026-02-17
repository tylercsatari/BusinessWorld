const { chromium } = require('playwright');
const path = require('path');

const SCREENSHOT_DIR = '/Users/tylercsatari/Desktop/PenguinFarm/BusinessWorld/test-screenshots/final';
const URL = 'http://localhost:8002';

const results = [];
function report(name, pass, details) {
  const status = pass ? 'PASS' : 'FAIL';
  results.push({ name, status, details });
  console.log(`[${status}] ${name}: ${details}`);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Collect console messages
  const consoleMessages = [];
  const consoleErrors = [];
  page.on('console', msg => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  // ============================================================
  // TEST 1: Navigate and load
  // ============================================================
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial-load.png'), fullPage: false });
    report('Test 1: Initial Load', true, 'Page loaded successfully, screenshot saved');
  } catch (e) {
    report('Test 1: Initial Load', false, e.message);
  }

  // ============================================================
  // TEST 2: Check console for JavaScript errors
  // ============================================================
  try {
    await page.waitForTimeout(1000);
    const jsErrors = consoleErrors.filter(e => !e.includes('favicon'));
    if (jsErrors.length === 0) {
      report('Test 2: Console Errors', true, 'No JavaScript errors in console');
    } else {
      report('Test 2: Console Errors', false, `Found ${jsErrors.length} error(s): ${jsErrors.join(' | ')}`);
    }
    console.log(`  Total console messages: ${consoleMessages.length}`);
    for (const msg of consoleMessages) {
      console.log(`  [${msg.type}] ${msg.text.substring(0, 200)}`);
    }
  } catch (e) {
    report('Test 2: Console Errors', false, e.message);
  }

  // ============================================================
  // TEST 3: Hamburger menu open/close
  // ============================================================
  try {
    // Click #hamburger-btn
    await page.click('#hamburger-btn');
    await page.waitForTimeout(500);

    // Check if menu-panel has class 'open'
    const menuOpen = await page.evaluate(() => {
      return document.getElementById('menu-panel').classList.contains('open');
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-hamburger-open.png'), fullPage: false });

    // Close by clicking the overlay
    await page.click('#menu-overlay');
    await page.waitForTimeout(500);

    const menuClosed = await page.evaluate(() => {
      return !document.getElementById('menu-panel').classList.contains('open');
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-hamburger-closed.png'), fullPage: false });

    report('Test 3: Hamburger Menu', menuOpen && menuClosed,
      `Open: ${menuOpen}, Closed after overlay click: ${menuClosed}`);
  } catch (e) {
    report('Test 3: Hamburger Menu', false, e.message);
  }

  // ============================================================
  // TEST 4: Edit Mode toggle
  // ============================================================
  try {
    await page.click('#edit-btn');
    await page.waitForTimeout(500);

    const btnText = await page.textContent('#edit-btn');
    const hasActive = await page.evaluate(() => document.getElementById('edit-btn').classList.contains('active'));
    const indicatorVisible = await page.evaluate(() => {
      return document.getElementById('edit-indicator').style.display === 'block';
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-edit-mode-on.png'), fullPage: false });

    // Toggle off
    await page.click('#edit-btn');
    await page.waitForTimeout(500);

    const btnTextAfter = await page.textContent('#edit-btn');
    const indicatorHidden = await page.evaluate(() => {
      return document.getElementById('edit-indicator').style.display === 'none';
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-edit-mode-off.png'), fullPage: false });

    const passed = btnText.includes('Done Editing') && hasActive && indicatorVisible && btnTextAfter.includes('Edit Mode') && indicatorHidden;
    report('Test 4: Edit Mode', passed,
      `Active text: "${btnText}", indicator visible: ${indicatorVisible}, reverted text: "${btnTextAfter}", indicator hidden: ${indicatorHidden}`);
  } catch (e) {
    report('Test 4: Edit Mode', false, e.message);
  }

  // ============================================================
  // TEST 5: Escape key closes modal
  // ============================================================
  try {
    // We need to click on a building in the 3D canvas. The player is at origin.
    // Let's click on the Money Pit area (it's at z=-16 in world, so slightly above center on screen).
    // Actually, the player character (clickable) is at center, let's click on it.
    // The canvas center should be near the player character.
    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();

    // Click center of canvas where player character should be
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);

    const modalVisibleBefore = await page.evaluate(() => {
      return document.getElementById('modal-overlay').classList.contains('visible');
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-modal-open.png'), fullPage: false });

    if (!modalVisibleBefore) {
      // Try clicking slightly offset - buildings may not be exactly at screen center
      // Try a few different positions
      const positions = [
        [box.width * 0.5, box.height * 0.45],  // slightly above center
        [box.width * 0.5, box.height * 0.55],  // slightly below center
        [box.width * 0.4, box.height * 0.5],   // slightly left
        [box.width * 0.6, box.height * 0.5],   // slightly right
      ];

      for (const [px, py] of positions) {
        await page.mouse.click(box.x + px, box.y + py);
        await page.waitForTimeout(300);
        const opened = await page.evaluate(() =>
          document.getElementById('modal-overlay').classList.contains('visible')
        );
        if (opened) {
          console.log(`  Modal opened at offset (${px.toFixed(0)}, ${py.toFixed(0)})`);
          break;
        }
      }
    }

    const modalAfterClick = await page.evaluate(() => {
      return document.getElementById('modal-overlay').classList.contains('visible');
    });

    if (!modalAfterClick) {
      // Force open the modal via JS for escape test
      console.log('  Could not click a building - opening modal via JS to test Escape');
      await page.evaluate(() => { openModal('Test Building', 'building'); });
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-modal-open.png'), fullPage: false });

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const modalClosedAfterEscape = await page.evaluate(() => {
      return !document.getElementById('modal-overlay').classList.contains('visible');
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-modal-after-escape.png'), fullPage: false });

    report('Test 5: Escape Closes Modal', modalClosedAfterEscape,
      `Modal visible after open: ${modalAfterClick || 'forced open'}, Closed after Escape: ${modalClosedAfterEscape}`);
  } catch (e) {
    report('Test 5: Escape Closes Modal', false, e.message);
  }

  // ============================================================
  // TEST 6: Escape key closes menu
  // ============================================================
  try {
    // Open hamburger menu
    await page.click('#hamburger-btn');
    await page.waitForTimeout(500);

    const menuOpenBefore = await page.evaluate(() => {
      return document.getElementById('menu-panel').classList.contains('open');
    });

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const menuClosedAfterEscape = await page.evaluate(() => {
      return !document.getElementById('menu-panel').classList.contains('open');
    });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-menu-after-escape.png'), fullPage: false });

    report('Test 6: Escape Closes Menu', menuOpenBefore && menuClosedAfterEscape,
      `Menu opened: ${menuOpenBefore}, Closed after Escape: ${menuClosedAfterEscape}`);
  } catch (e) {
    report('Test 6: Escape Closes Menu', false, e.message);
  }

  // ============================================================
  // TEST 7: Zoom with wheel events
  // ============================================================
  try {
    // Record initial camera distance
    const distBefore = await page.evaluate(() => cameraDistance);
    console.log(`  Camera distance before zoom: ${distBefore}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-zoom-before.png'), fullPage: false });

    // Dispatch wheel events on canvas to zoom in (negative deltaY)
    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();

    for (let i = 0; i < 8; i++) {
      await page.evaluate(({cx, cy}) => {
        const canvas = document.querySelector('canvas');
        canvas.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120,
          clientX: cx,
          clientY: cy,
          bubbles: true
        }));
      }, { cx: box.x + box.width / 2, cy: box.y + box.height / 2 });
      await page.waitForTimeout(50);
    }

    await page.waitForTimeout(500);

    const distAfter = await page.evaluate(() => cameraDistance);
    console.log(`  Camera distance after zoom: ${distAfter}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-zoom-after.png'), fullPage: false });

    const zoomed = distAfter < distBefore;
    report('Test 7: Zoom', zoomed,
      `Distance before: ${distBefore.toFixed(1)}, after: ${distAfter.toFixed(1)}, zoomed in: ${zoomed}`);
  } catch (e) {
    report('Test 7: Zoom', false, e.message);
  }

  // ============================================================
  // TEST 8: WASD Movement (W key)
  // ============================================================
  try {
    // Record player position before
    const posBefore = await page.evaluate(() => ({
      x: playerMesh.position.x,
      z: playerMesh.position.z
    }));
    console.log(`  Player pos before: x=${posBefore.x.toFixed(2)}, z=${posBefore.z.toFixed(2)}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-wasd-before.png'), fullPage: false });

    // Use page.keyboard to hold W key
    await page.keyboard.down('w');
    await page.waitForTimeout(800);
    await page.keyboard.up('w');
    await page.waitForTimeout(300);

    const posAfter = await page.evaluate(() => ({
      x: playerMesh.position.x,
      z: playerMesh.position.z
    }));
    console.log(`  Player pos after: x=${posAfter.x.toFixed(2)}, z=${posAfter.z.toFixed(2)}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-wasd-after.png'), fullPage: false });

    const moved = Math.abs(posAfter.x - posBefore.x) > 0.1 || Math.abs(posAfter.z - posBefore.z) > 0.1;
    report('Test 8: WASD Movement', moved,
      `Moved from (${posBefore.x.toFixed(2)}, ${posBefore.z.toFixed(2)}) to (${posAfter.x.toFixed(2)}, ${posAfter.z.toFixed(2)})`);
  } catch (e) {
    report('Test 8: WASD Movement', false, e.message);
  }

  // ============================================================
  // TEST 9: Final overview screenshot
  // ============================================================
  try {
    // Reset zoom
    await page.evaluate(() => { cameraDistance = 45; });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09-final-overview.png'), fullPage: false });
    report('Test 9: Final Overview', true, 'Final screenshot captured');
  } catch (e) {
    report('Test 9: Final Overview', false, e.message);
  }

  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  console.log('\n========================================');
  console.log('  FINAL TEST RESULTS SUMMARY');
  console.log('========================================');
  let passCount = 0, failCount = 0;
  for (const r of results) {
    console.log(`  [${r.status}] ${r.name}`);
    console.log(`         ${r.details}`);
    if (r.status === 'PASS') passCount++;
    else failCount++;
  }
  console.log(`\n  Total: ${passCount} PASS, ${failCount} FAIL out of ${results.length} tests`);

  if (consoleErrors.length > 0) {
    console.log('\n  Console Errors Found:');
    for (const err of consoleErrors) {
      console.log(`    ERROR: ${err}`);
    }
  } else {
    console.log('\n  No console errors detected.');
  }

  console.log('========================================\n');

  await browser.close();
})();
