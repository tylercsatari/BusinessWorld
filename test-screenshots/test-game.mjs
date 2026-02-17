import { chromium } from 'playwright';
import path from 'path';

const SCREENSHOT_DIR = '/Users/tylercsatari/Desktop/PenguinFarm/BusinessWorld/test-screenshots';
const URL = 'http://localhost:8002';

function screenshotPath(name) {
  return path.join(SCREENSHOT_DIR, name);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Collect ALL console messages
  const consoleMessages = [];
  page.on('console', msg => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  // Collect page errors
  const pageErrors = [];
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  console.log('=== STEP 1: Navigate to the game ===');
  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log('Navigation warning:', e.message);
  }

  // Wait for scene to render
  await page.waitForTimeout(3000);

  console.log('=== STEP 2: Screenshot of initial load ===');
  await page.screenshot({ path: screenshotPath('01-initial-load.png'), fullPage: false });
  console.log('Screenshot saved: 01-initial-load.png');

  console.log('=== STEP 3: Check console for errors ===');
  const errors = consoleMessages.filter(m => m.type === 'error');
  const warnings = consoleMessages.filter(m => m.type === 'warning');
  console.log(`Total console messages: ${consoleMessages.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);

  if (errors.length > 0) {
    console.log('\n--- CONSOLE ERRORS ---');
    errors.forEach((e, i) => console.log(`  Error ${i + 1}: ${e.text}`));
  }
  if (warnings.length > 0) {
    console.log('\n--- CONSOLE WARNINGS ---');
    warnings.forEach((w, i) => console.log(`  Warning ${i + 1}: ${w.text}`));
  }
  if (pageErrors.length > 0) {
    console.log('\n--- PAGE ERRORS (uncaught exceptions) ---');
    pageErrors.forEach((e, i) => console.log(`  PageError ${i + 1}: ${e}`));
  }

  // Check what's visible in the scene
  console.log('\n=== Check scene contents ===');
  const sceneInfo = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const result = { hasCanvas: !!canvas };
    if (canvas) {
      result.canvasWidth = canvas.width;
      result.canvasHeight = canvas.height;
    }
    // Check for Three.js scene
    if (window.scene) {
      result.sceneChildren = window.scene.children.length;
      const types = {};
      window.scene.traverse(obj => {
        const t = obj.type || 'unknown';
        types[t] = (types[t] || 0) + 1;
      });
      result.objectTypes = types;
    }

    // Find all buttons and interactive elements
    const allButtons = Array.from(document.querySelectorAll('button'));
    result.buttonTexts = allButtons.map(b => ({
      text: b.textContent.trim().substring(0, 50),
      id: b.id,
      className: b.className,
      visible: b.offsetHeight > 0
    }));

    // Find divs that look clickable
    const clickableDivs = Array.from(document.querySelectorAll('div[onclick], div[class*="btn"], div[class*="button"]'));
    result.clickableDivs = clickableDivs.map(d => ({
      text: d.textContent.trim().substring(0, 50),
      id: d.id,
      className: d.className
    }));

    return result;
  });
  console.log('Scene info:', JSON.stringify(sceneInfo, null, 2));

  console.log('\n=== STEP 4: Test hamburger menu ===');
  let hamburgerClicked = false;
  try {
    // Find by scanning all elements
    const btnInfo = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div[onclick], span[onclick], a'));
      return btns.filter(b => b.getBoundingClientRect().width > 0).map(b => ({
        tag: b.tagName,
        text: b.textContent.trim().substring(0, 30),
        className: b.className,
        id: b.id,
        rect: { x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }
      }));
    });

    for (const btn of btnInfo) {
      if (btn.text.includes('☰') || btn.text.includes('≡') || btn.className.includes('hamburger') || btn.className.includes('menu') || btn.id.includes('hamburger') || btn.id.includes('menu')) {
        const x = btn.rect.x + btn.rect.w / 2;
        const y = btn.rect.y + btn.rect.h / 2;
        await page.mouse.click(x, y);
        hamburgerClicked = true;
        console.log(`Clicked hamburger: "${btn.text}" at (${x}, ${y}), id="${btn.id}", class="${btn.className}"`);
        break;
      }
    }

    if (!hamburgerClicked) {
      // Try Playwright text selectors
      for (const sel of ['.hamburger-btn', '#hamburger-btn', '.hamburger', '#menu-btn']) {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          hamburgerClicked = true;
          console.log(`Clicked hamburger via CSS: ${sel}`);
          break;
        }
      }
    }

    if (hamburgerClicked) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: screenshotPath('02-hamburger-open.png') });
      console.log('Screenshot saved: 02-hamburger-open.png');

      // Try to close by clicking overlay or right side of screen
      const overlayClosed = await page.evaluate(() => {
        const overlay = document.querySelector('.overlay, .menu-overlay, .sidebar-overlay');
        if (overlay && overlay.offsetHeight > 0) { overlay.click(); return 'overlay'; }
        return null;
      });

      if (overlayClosed) {
        console.log(`Closed via ${overlayClosed}`);
      } else {
        await page.mouse.click(1000, 400);
        console.log('Clicked right side to close');
      }
      await page.waitForTimeout(600);
      await page.screenshot({ path: screenshotPath('03-hamburger-closed.png') });
      console.log('Screenshot saved: 03-hamburger-closed.png');
    } else {
      console.log('Could not find hamburger menu button');
      console.log('All buttons found:', JSON.stringify(btnInfo, null, 2));
    }
  } catch (e) {
    console.log('Hamburger test error:', e.message);
  }

  console.log('\n=== STEP 5: Test edit mode toggle ===');
  try {
    const editBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const t = b.textContent.toLowerCase();
        if (t.includes('edit') || b.id.includes('edit') || b.className.includes('edit')) {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2, text: b.textContent.trim(), id: b.id };
        }
      }
      return null;
    });

    if (editBtn) {
      console.log(`Found edit button: "${editBtn.text}" id="${editBtn.id}"`);
      await page.mouse.click(editBtn.x, editBtn.y);
      await page.waitForTimeout(600);
      await page.screenshot({ path: screenshotPath('04-edit-mode-on.png') });
      console.log('Screenshot saved: 04-edit-mode-on.png');

      // Toggle off
      await page.mouse.click(editBtn.x, editBtn.y);
      await page.waitForTimeout(600);
      await page.screenshot({ path: screenshotPath('05-edit-mode-off.png') });
      console.log('Screenshot saved: 05-edit-mode-off.png');
    } else {
      console.log('Could not find edit mode button');
    }
  } catch (e) {
    console.log('Edit mode test error:', e.message);
  }

  console.log('\n=== STEP 6: Test scroll to zoom ===');
  try {
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas) {
        for (let i = 0; i < 5; i++) {
          canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
        }
      }
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: screenshotPath('06-zoomed-in.png') });
    console.log('Screenshot saved: 06-zoomed-in.png');

    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas) {
        for (let i = 0; i < 10; i++) {
          canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
        }
      }
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: screenshotPath('07-zoomed-out.png') });
    console.log('Screenshot saved: 07-zoomed-out.png');
  } catch (e) {
    console.log('Zoom test error:', e.message);
  }

  console.log('\n=== STEP 7: Test WASD movement ===');
  try {
    const canvas = await page.$('canvas');
    if (canvas) {
      await canvas.click();
      await page.waitForTimeout(200);
    }

    console.log('Pressing W to move forward...');
    await page.keyboard.down('w');
    await page.waitForTimeout(1500);
    await page.keyboard.up('w');
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath('08-after-W-move.png') });
    console.log('Screenshot saved: 08-after-W-move.png');

    console.log('Pressing D then S...');
    await page.keyboard.down('d');
    await page.waitForTimeout(1000);
    await page.keyboard.up('d');
    await page.keyboard.down('s');
    await page.waitForTimeout(1000);
    await page.keyboard.up('s');
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath('09-after-WASD-movement.png') });
    console.log('Screenshot saved: 09-after-WASD-movement.png');
  } catch (e) {
    console.log('WASD test error:', e.message);
  }

  console.log('\n=== STEP 8: Click on a building ===');
  try {
    const buildingInfo = await page.evaluate(() => {
      if (window.scene) {
        let buildings = [];
        window.scene.traverse(obj => {
          if (obj.userData && (obj.userData.type === 'building' || obj.userData.buildingId || obj.userData.id || obj.userData.clickable)) {
            buildings.push({
              name: obj.name,
              userData: JSON.stringify(obj.userData).substring(0, 200),
              type: obj.type
            });
          }
        });
        return buildings.slice(0, 10);
      }
      return [];
    });
    console.log('Buildings in scene:', JSON.stringify(buildingInfo, null, 2));

    // Click in various positions
    const clickPositions = [
      { x: 640, y: 400 }, { x: 500, y: 350 }, { x: 750, y: 350 },
      { x: 640, y: 300 }, { x: 400, y: 300 }, { x: 640, y: 500 },
      { x: 300, y: 400 }, { x: 800, y: 400 }
    ];

    let modalOpened = false;
    for (const pos of clickPositions) {
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(800);

      const hasModal = await page.evaluate(() => {
        // Check for any visible overlay/modal/popup
        const candidates = document.querySelectorAll('div');
        for (const d of candidates) {
          const style = window.getComputedStyle(d);
          if (style.position === 'fixed' || style.position === 'absolute') {
            if (d.offsetHeight > 100 && d.offsetWidth > 100) {
              const cls = d.className || '';
              const id = d.id || '';
              if (cls.includes('modal') || cls.includes('popup') || cls.includes('dialog') ||
                  id.includes('modal') || id.includes('popup') || id.includes('dialog') ||
                  cls.includes('info') || cls.includes('detail')) {
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  return { visible: true, text: d.textContent.substring(0, 300), className: cls, id: id };
                }
              }
            }
          }
        }
        return { visible: false };
      });

      if (hasModal.visible) {
        console.log(`Modal opened after clicking (${pos.x}, ${pos.y})!`);
        console.log(`Modal class="${hasModal.className}" id="${hasModal.id}"`);
        console.log(`Modal text: ${hasModal.text}`);
        modalOpened = true;
        await page.screenshot({ path: screenshotPath('10-building-modal.png') });
        console.log('Screenshot saved: 10-building-modal.png');
        break;
      }
    }

    if (!modalOpened) {
      console.log('No modal opened from clicking positions. Checking DOM for hidden modals...');
      const hiddenModals = await page.evaluate(() => {
        const all = document.querySelectorAll('div');
        const modals = [];
        for (const d of all) {
          const cls = (d.className || '').toLowerCase();
          const id = (d.id || '').toLowerCase();
          if (cls.includes('modal') || id.includes('modal') || cls.includes('popup') || id.includes('popup')) {
            modals.push({ className: d.className, id: d.id, display: window.getComputedStyle(d).display, height: d.offsetHeight });
          }
        }
        return modals;
      });
      console.log('Modal-like elements in DOM:', JSON.stringify(hiddenModals, null, 2));
      await page.screenshot({ path: screenshotPath('10-no-modal.png') });
      console.log('Screenshot saved: 10-no-modal.png');
    }
  } catch (e) {
    console.log('Building click test error:', e.message);
  }

  console.log('\n=== STEP 9: Test closing modal ===');
  try {
    // Try close button
    let closed = false;
    for (const sel of ['.close-btn', '.close', '.modal-close', 'button.close']) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click();
        closed = true;
        console.log(`Closed modal with: ${sel}`);
        break;
      }
    }
    if (!closed) {
      await page.keyboard.press('Escape');
      console.log('Pressed Escape to close any modal');
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: screenshotPath('11-modal-closed.png') });
    console.log('Screenshot saved: 11-modal-closed.png');
  } catch (e) {
    console.log('Modal close test error:', e.message);
  }

  console.log('\n=== STEP 10: Final error check ===');
  const allErrors = consoleMessages.filter(m => m.type === 'error');
  const allWarnings = consoleMessages.filter(m => m.type === 'warning');

  console.log('\n========================================');
  console.log('FINAL CONSOLE ERROR/WARNING REPORT');
  console.log('========================================');
  console.log(`Total console messages: ${consoleMessages.length}`);
  console.log(`Total errors: ${allErrors.length}`);
  console.log(`Total warnings: ${allWarnings.length}`);
  console.log(`Total page errors (uncaught): ${pageErrors.length}`);

  if (allErrors.length > 0) {
    console.log('\n--- ALL CONSOLE ERRORS ---');
    allErrors.forEach((e, i) => console.log(`  Error ${i + 1}: ${e.text}`));
  } else {
    console.log('\n*** NO CONSOLE ERRORS - CLEAN RUN ***');
  }

  if (allWarnings.length > 0) {
    console.log('\n--- ALL CONSOLE WARNINGS ---');
    allWarnings.forEach((w, i) => console.log(`  Warning ${i + 1}: ${w.text}`));
  }

  if (pageErrors.length > 0) {
    console.log('\n--- ALL PAGE ERRORS ---');
    pageErrors.forEach((e, i) => console.log(`  PageError ${i + 1}: ${e}`));
  } else {
    console.log('*** NO UNCAUGHT PAGE ERRORS ***');
  }

  const logMessages = consoleMessages.filter(m => m.type === 'log');
  if (logMessages.length > 0) {
    console.log('\n--- CONSOLE LOG MESSAGES (first 40) ---');
    logMessages.slice(0, 40).forEach((l, i) => console.log(`  Log ${i + 1}: ${l.text}`));
  }

  await page.screenshot({ path: screenshotPath('12-final-state.png') });
  console.log('\nScreenshot saved: 12-final-state.png');

  await browser.close();
  console.log('\n=== TEST COMPLETE ===');
})();
