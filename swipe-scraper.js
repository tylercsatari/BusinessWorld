// swipe-scraper.js — Playwright-based YouTube Studio scraper for "Viewed vs Swiped Away"
// Uses real Chrome (not bundled Chromium) so Google login works
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, 'yt-chrome-profile');
const LOGIN_MARKER = path.join(SESSION_DIR, '.logged-in');

let scrapeInProgress = false;
let scrapeStatus = { state: 'idle' }; // idle | logging_in | scraping | done | error

function hasSession() {
    return fs.existsSync(LOGIN_MARKER);
}

function getStatus() {
    return scrapeStatus;
}

// Single unified flow: open Chrome, ensure login, scrape all videos
async function scrapeAll(videoIds, onProgress) {
    if (scrapeInProgress) throw new Error('Scrape already in progress');
    scrapeInProgress = true;
    scrapeStatus = { state: 'starting', current: 0, total: videoIds.length };

    const needsLogin = !hasSession();

    try {
        // Always open headed so user can see what's happening (and log in if needed)
        const context = await chromium.launchPersistentContext(SESSION_DIR, {
            headless: false,
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: { width: 1280, height: 900 },
        });

        const page = context.pages()[0] || await context.newPage();
        const results = {};

        try {
            // Step 1: Navigate to YouTube Studio
            scrapeStatus = { state: 'logging_in', current: 0, total: videoIds.length };
            console.log('[swipe] Navigating to YouTube Studio...');
            await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Step 2: Wait for Studio to be ready (user may need to log in)
            console.log('[swipe] Waiting for Studio dashboard...');
            await page.waitForFunction(() => {
                // We're on Studio when hostname is studio.youtube.com AND there's actual content
                return window.location.hostname === 'studio.youtube.com' &&
                    !window.location.pathname.includes('/error') &&
                    (document.querySelector('#dashboard') ||
                     document.querySelector('.navigation-section') ||
                     document.querySelector('ytcp-button') ||
                     document.querySelector('[id*="channel"]'));
            }, { timeout: 300000 }); // 5 min for login

            // Mark session as valid
            fs.mkdirSync(SESSION_DIR, { recursive: true });
            fs.writeFileSync(LOGIN_MARKER, new Date().toISOString());
            console.log('[swipe] Studio loaded, session saved');

            // Step 3: Scrape each video
            scrapeStatus = { state: 'scraping', current: 0, total: videoIds.length };

            for (let i = 0; i < videoIds.length; i++) {
                const videoId = videoIds[i];
                scrapeStatus = { state: 'scraping', current: i + 1, total: videoIds.length, videoId };
                if (onProgress) onProgress({ current: i + 1, total: videoIds.length, videoId });
                console.log(`[swipe] Scraping ${i + 1}/${videoIds.length}: ${videoId}`);

                try {
                    const data = await scrapeOneVideo(page, videoId);
                    results[videoId] = data;
                    console.log(`[swipe] ${videoId}: ${data.stayedToWatch}% stayed, ${data.swipedAway}% swiped`);
                } catch (e) {
                    console.error(`[swipe] Failed ${videoId}:`, e.message);
                    results[videoId] = { error: e.message };
                }
            }

            scrapeStatus = { state: 'done', results };
        } finally {
            await context.close();
        }

        return results;
    } catch (e) {
        scrapeStatus = { state: 'error', error: e.message };
        throw e;
    } finally {
        scrapeInProgress = false;
    }
}

async function scrapeOneVideo(page, videoId) {
    // Collect network responses that might contain analytics data
    const intercepted = [];
    const responseHandler = async (response) => {
        const url = response.url();
        if (url.includes('youtubei') && (url.includes('analytics') || url.includes('get_screen') || url.includes('creator'))) {
            try {
                const body = await response.text();
                intercepted.push({ url, body });
            } catch (e) {}
        }
    };
    page.on('response', responseHandler);

    try {
        // Navigate to the engagement tab
        await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-engagement`, {
            waitUntil: 'networkidle',
            timeout: 30000
        });

        // Check if we got redirected to login
        if (page.url().includes('accounts.google.com')) {
            throw new Error('SESSION_EXPIRED — redirected to login');
        }

        // Wait for analytics content to render
        await page.waitForTimeout(6000);

        // Strategy 1: Search all text in the DOM including shadow DOM
        let result = await extractSwipeFromDOM(page);

        // Strategy 2: If DOM didn't work, try parsing intercepted network responses
        if (result.stayed === null && result.swiped === null) {
            for (const resp of intercepted) {
                const found = findSwipeInText(resp.body);
                if (found) {
                    result.stayed = found.stayed;
                    result.swiped = found.swiped;
                    break;
                }
            }
        }

        // Strategy 3: Try the Reach tab instead
        if (result.stayed === null && result.swiped === null) {
            intercepted.length = 0;
            await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-reach`, {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            await page.waitForTimeout(6000);
            result = await extractSwipeFromDOM(page);

            if (result.stayed === null && result.swiped === null) {
                for (const resp of intercepted) {
                    const found = findSwipeInText(resp.body);
                    if (found) {
                        result.stayed = found.stayed;
                        result.swiped = found.swiped;
                        break;
                    }
                }
            }
        }

        // Strategy 4: Try the Overview tab
        if (result.stayed === null && result.swiped === null) {
            await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-overview`, {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            await page.waitForTimeout(6000);
            result = await extractSwipeFromDOM(page);
        }

        // Derive complement if we only got one
        if (result.stayed !== null && result.swiped === null) {
            result.swiped = Math.round((100 - result.stayed) * 10) / 10;
        }
        if (result.swiped !== null && result.stayed === null) {
            result.stayed = Math.round((100 - result.swiped) * 10) / 10;
        }

        if (result.stayed === null && result.swiped === null) {
            // Save debug info
            const debugPath = path.join(__dirname, `swipe-debug-${videoId}.txt`);
            fs.writeFileSync(debugPath, `URL: ${page.url()}\n\nDOM TEXT:\n${result.textSample}\n\nINTERCEPTED (${intercepted.length}):\n${intercepted.map(r => r.url).join('\n')}`);
            throw new Error(`Could not find swipe data (debug: swipe-debug-${videoId}.txt)`);
        }

        // Now get subscriber vs non-subscriber swipe ratios
        let subscriberSwipe = null, nonSubscriberSwipe = null;

        // Try subscriber-filtered engagement page
        try {
            await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-engagement/period-default/explore?entity_type=VIDEO&entity_id=${videoId}&time_period=lifetime&explore_type=TABLE_AND_CHART&metric=SWIPE_AWAY_RATE&granularity=DAY&t_filter=SUBSCRIPTION_STATUS&d_filter=SUBSCRIBED`, {
                waitUntil: 'networkidle',
                timeout: 20000
            });
            await page.waitForTimeout(4000);
            const subResult = await extractSwipeFromDOM(page);
            if (subResult.stayed !== null) {
                subscriberSwipe = { stayed: subResult.stayed, swiped: subResult.swiped ?? Math.round((100 - subResult.stayed) * 10) / 10 };
            }
        } catch (e) {
            console.log(`[swipe] Could not get subscriber swipe for ${videoId}: ${e.message}`);
        }

        // Try non-subscriber-filtered engagement page
        try {
            await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-engagement/period-default/explore?entity_type=VIDEO&entity_id=${videoId}&time_period=lifetime&explore_type=TABLE_AND_CHART&metric=SWIPE_AWAY_RATE&granularity=DAY&t_filter=SUBSCRIPTION_STATUS&d_filter=NOT_SUBSCRIBED`, {
                waitUntil: 'networkidle',
                timeout: 20000
            });
            await page.waitForTimeout(4000);
            const nonSubResult = await extractSwipeFromDOM(page);
            if (nonSubResult.stayed !== null) {
                nonSubscriberSwipe = { stayed: nonSubResult.stayed, swiped: nonSubResult.swiped ?? Math.round((100 - nonSubResult.stayed) * 10) / 10 };
            }
        } catch (e) {
            console.log(`[swipe] Could not get non-subscriber swipe for ${videoId}: ${e.message}`);
        }

        // If the explore URLs didn't work, try clicking filter UI on the engagement tab
        if (!subscriberSwipe && !nonSubscriberSwipe) {
            try {
                // Go back to engagement tab
                await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-engagement`, {
                    waitUntil: 'networkidle',
                    timeout: 20000
                });
                await page.waitForTimeout(4000);

                // Look for subscription status filter/dropdown
                const filterClicked = await page.evaluate(() => {
                    function findAndClick(node, text) {
                        if (node.shadowRoot) { const r = findAndClick(node.shadowRoot, text); if (r) return r; }
                        for (const child of (node.childNodes || [])) {
                            if (child.nodeType === 1) {
                                if (child.textContent?.trim()?.toLowerCase().includes(text) &&
                                    (child.tagName === 'BUTTON' || child.tagName === 'A' || child.getAttribute('role') === 'tab' || child.tagName?.includes('BUTTON'))) {
                                    child.click();
                                    return true;
                                }
                                const r = findAndClick(child, text);
                                if (r) return r;
                            }
                        }
                        return false;
                    }
                    // Try to find "Subscriber" or "Subscription status" filter
                    return findAndClick(document.body, 'subscri');
                });

                if (filterClicked) {
                    await page.waitForTimeout(3000);
                    // Try to get subscriber-specific swipe data from the now-filtered page
                    const filteredResult = await extractSwipeFromDOM(page);
                    if (filteredResult.stayed !== null && filteredResult.stayed !== result.stayed) {
                        subscriberSwipe = { stayed: filteredResult.stayed, swiped: filteredResult.swiped ?? Math.round((100 - filteredResult.stayed) * 10) / 10 };
                    }
                }
            } catch (e) {
                console.log(`[swipe] Filter approach failed for ${videoId}: ${e.message}`);
            }
        }

        const output = {
            stayedToWatch: result.stayed,
            swipedAway: result.swiped,
            scrapedAt: new Date().toISOString()
        };

        if (subscriberSwipe) {
            output.subscriberStayed = subscriberSwipe.stayed;
            output.subscriberSwiped = subscriberSwipe.swiped;
        }
        if (nonSubscriberSwipe) {
            output.nonSubscriberStayed = nonSubscriberSwipe.stayed;
            output.nonSubscriberSwiped = nonSubscriberSwipe.swiped;
        }

        return output;
    } finally {
        page.off('response', responseHandler);
    }
}

// Extract swipe data from the visible DOM (walks shadow DOM too)
async function extractSwipeFromDOM(page) {
    return await page.evaluate(() => {
        function getAllText(node) {
            let text = '';
            if (node.shadowRoot) text += getAllText(node.shadowRoot);
            for (const child of (node.childNodes || [])) {
                if (child.nodeType === 3) text += child.textContent + ' ';
                else if (child.nodeType === 1) text += getAllText(child) + ' ';
            }
            return text;
        }

        const bodyText = getAllText(document.body);

        const patterns = [
            { re: /(\d+\.?\d*)%\s*Stayed to watch/i, type: 'stayed' },
            { re: /Stayed to watch\s*(\d+\.?\d*)%/i, type: 'stayed' },
            { re: /(\d+\.?\d*)%\s*Swiped away/i, type: 'swiped' },
            { re: /Swiped away\s*(\d+\.?\d*)%/i, type: 'swiped' },
        ];

        let stayed = null, swiped = null;
        for (const { re, type } of patterns) {
            const match = bodyText.match(re);
            if (match) {
                const val = parseFloat(match[1]);
                if (val > 0 && val <= 100) {
                    if (type === 'stayed' && stayed === null) stayed = val;
                    if (type === 'swiped' && swiped === null) swiped = val;
                }
            }
        }

        return { stayed, swiped, textSample: bodyText.substring(0, 5000) };
    });
}

// Search text (could be JSON or HTML) for swipe-related data
function findSwipeInText(text) {
    // Look for percentage patterns near swipe-related words
    const stayedMatch = text.match(/[Ss]tayed[^%]*?(\d+\.?\d*)%/) || text.match(/(\d+\.?\d*)%[^%]*?[Ss]tayed/);
    const swipedMatch = text.match(/[Ss]wiped[^%]*?(\d+\.?\d*)%/) || text.match(/(\d+\.?\d*)%[^%]*?[Ss]wiped/);

    if (stayedMatch || swipedMatch) {
        return {
            stayed: stayedMatch ? parseFloat(stayedMatch[1]) : null,
            swiped: swipedMatch ? parseFloat(swipedMatch[1]) : null
        };
    }
    return null;
}

module.exports = { hasSession, getStatus, scrapeAll };
