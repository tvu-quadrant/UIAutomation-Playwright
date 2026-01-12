const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Incident numbers for the two browsers
const SOURCE_INCIDENT = process.env.SOURCE_INCIDENT || '154887209';
const TARGET_INCIDENT = process.env.TARGET_INCIDENT || '154887055';
const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

test('two-browser: copy Bridge Name to Discussion', async () => {
    // Allow enough time for both browsers to complete
    test.setTimeout(300000);

    if (!fs.existsSync(AUTH_FILE)) {
        test.skip(true, 'No MSAuth.json found. Run `npm run save-auth` first.');
        return;
    }

    // Launch two Edge browser instances with shared authentication
    const browserLaunchOptions = { channel: 'msedge', headless: false };

    const browser1 = await chromium.launch(browserLaunchOptions);
    const browser2 = await chromium.launch(browserLaunchOptions);

    const context1 = await browser1.newContext({ storageState: AUTH_FILE });
    const context2 = await browser2.newContext({ storageState: AUTH_FILE });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    let bridgeName = '';

    try {
        // ===== BROWSER 1: Get Bridge Name from source incident =====
        console.log(`Browser 1: Navigating to incident ${SOURCE_INCIDENT}...`);
        await page1.goto(`https://ppeportal.microsofticm.com/imp/v5/incidents/details/${SOURCE_INCIDENT}/summary`, { waitUntil: 'networkidle' });

        // Click Create bridge (directly or via More actions)
        const createBridgeBtn = page1.locator('button:has-text("Create bridge")');
        const moreActionsBtn = page1.getByRole('button', { name: /More actions/i }).first();

        if (await createBridgeBtn.isVisible().catch(() => false)) {
            console.log('Browser 1: Clicking direct "Create bridge" button');
            await createBridgeBtn.click({ timeout: 5000 });
        } else {
            console.log('Browser 1: Clicking "More actions" then "Create bridge"');
            await moreActionsBtn.waitFor({ state: 'visible', timeout: 5000 });
            await moreActionsBtn.click({ timeout: 2000 });
            const menuItem = page1.getByText(/Create bridge/i).first();
            await menuItem.waitFor({ state: 'visible', timeout: 5000 });
            await menuItem.click({ timeout: 2000 });
        }

        // Wait for collaboration form to appear
        await page1.waitForTimeout(1000);

        // Click Engineering option
        console.log('Browser 1: Selecting Engineering option...');
        const engineeringLabel = page1.locator('label:has-text("Engineering")').first();
        const engineeringRadio = page1.getByRole('radio', { name: /Engineering/i }).first();

        if (await engineeringRadio.count() > 0) {
            await engineeringRadio.click({ timeout: 2000 }).catch(() => { });
        }
        if (await engineeringLabel.count() > 0) {
            await engineeringLabel.click({ timeout: 2000 }).catch(() => { });
        }

        // Wait for Bridge Name field to be auto-filled
        console.log('Browser 1: Waiting for Bridge Name to auto-fill...');
        const bridgeNameInput = page1.locator('input[aria-label="Bridge Name"]');

        // Poll until Bridge Name has a value
        const maxWait = 10000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            bridgeName = await bridgeNameInput.inputValue().catch(() => '');
            if (bridgeName && bridgeName.trim().length > 0) {
                break;
            }
            await page1.waitForTimeout(500);
        }

        if (!bridgeName) {
            throw new Error('Bridge Name was not auto-filled');
        }
        console.log(`Browser 1: Got Bridge Name: "${bridgeName}"`);

        // ===== BROWSER 2: Paste Bridge Name into Discussion =====
        console.log(`Browser 2: Navigating to incident ${TARGET_INCIDENT}...`);
        await page2.goto(`https://ppeportal.microsofticm.com/imp/v5/incidents/details/${TARGET_INCIDENT}/summary`, { waitUntil: 'networkidle' });

        // Wait for page to fully load
        await page2.waitForTimeout(2000);

        // Find the Discussion section and click to expand/edit
        console.log('Browser 2: Looking for Discussion textbox...');

        // Try multiple selectors for the Discussion area
        const discussionSelectors = [
            'textarea[aria-label*="Discussion" i]',
            'div[aria-label*="Discussion" i] textarea',
            'textarea[placeholder*="discussion" i]',
            '[data-automation-id="discussion-input"]',
            'div.discussion-editor textarea',
            'textarea'
        ];

        let discussionInput = null;
        for (const sel of discussionSelectors) {
            const element = page2.locator(sel).first();
            if (await element.count() > 0 && await element.isVisible().catch(() => false)) {
                discussionInput = element;
                console.log(`Browser 2: Found Discussion input with selector: ${sel}`);
                break;
            }
        }

        // If no textarea, look for a contenteditable div or try clicking Discussion header first
        if (!discussionInput) {
            // Try clicking the Discussion section header to reveal input
            const discussionHeader = page2.locator('text=/Discussion/i').first();
            if (await discussionHeader.count() > 0) {
                await discussionHeader.click({ timeout: 2000 }).catch(() => { });
                await page2.waitForTimeout(1000);
            }

            // Now look for textarea or contenteditable
            const textarea = page2.locator('textarea').first();
            if (await textarea.count() > 0 && await textarea.isVisible().catch(() => false)) {
                discussionInput = textarea;
            } else {
                // Try contenteditable div
                const contentEditable = page2.locator('[contenteditable="true"]').first();
                if (await contentEditable.count() > 0) {
                    discussionInput = contentEditable;
                }
            }
        }

        if (!discussionInput) {
            throw new Error('Could not find Discussion input field');
        }

        // Type the bridge name into the Discussion field
        console.log(`Browser 2: Typing Bridge Name into Discussion: "${bridgeName}"`);
        await discussionInput.click({ timeout: 2000 });
        await discussionInput.fill(bridgeName);

        // Wait a moment to see the input
        await page2.waitForTimeout(1000);

        // Click Save button
        console.log('Browser 2: Clicking Save button...');
        const saveBtn = page2.locator('button:has-text("Save"), [aria-label="Save"]').first();

        if (await saveBtn.count() > 0) {
            await saveBtn.click({ timeout: 2000 });
            console.log('Browser 2: Clicked Save button');
        } else {
            // Try finding save by role
            const saveByRole = page2.getByRole('button', { name: /Save/i }).first();
            if (await saveByRole.count() > 0) {
                await saveByRole.click({ timeout: 2000 });
                console.log('Browser 2: Clicked Save button via role');
            } else {
                console.log('Browser 2: Save button not found');
            }
        }

        // Wait for save to complete
        await page2.waitForTimeout(3000);

        // Take screenshots of both browsers
        await page1.screenshot({ path: 'test-results/browser1-bridge-name.png' });
        await page2.screenshot({ path: 'test-results/browser2-discussion-saved.png' });

        console.log('Test completed successfully!');
        console.log(`Bridge Name "${bridgeName}" was copied from incident ${SOURCE_INCIDENT} to Discussion of incident ${TARGET_INCIDENT}`);

    } finally {
        // Keep browsers open briefly for visual inspection
        await page1.waitForTimeout(2000);
        await page2.waitForTimeout(2000);

        // Close browsers
        await browser1.close();
        await browser2.close();
    }
});
