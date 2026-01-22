const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Load env defaults for local runs
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

test('two-browser: copy Bridge Name to Discussion', async () => {
    // Reload .env on each run so SOURCE/TARGET can be changed without restarting
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });

    // Incident numbers for the two browsers
    const SOURCE_INCIDENT = process.env.SOURCE_INCIDENT || '154887209';
    const TARGET_INCIDENT = process.env.TARGET_INCIDENT || '154887055';

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

        // Wait for collaboration form to appear and settle
        const dialogHeading = page1.locator('text=/Create Collaboration Experience|Create Teams Collaboration|Create Collaboration/i').first();
        await dialogHeading.waitFor({ state: 'visible', timeout: 15000 });
        await page1.waitForTimeout(3000);

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

        // Give the UI time to auto-fill after selecting Engineering
        await page1.waitForTimeout(2000);

        // Wait for Bridge Name field to be auto-filled
        console.log('Browser 1: Waiting for Bridge Name to auto-fill...');
        const bridgeNameInput = page1
            .locator('input[aria-label*="Bridge" i], input[name*="bridge" i], input[placeholder*="Bridge" i]')
            .first();

        await bridgeNameInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { });

        // Poll until Bridge Name has a value
        const maxWait = 30000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            bridgeName = await bridgeNameInput.inputValue().catch(() => '');
            if (bridgeName && bridgeName.trim().length > 0) {
                break;
            }
            await page1.waitForTimeout(500);
        }

        if (!bridgeName) {
            await page1.screenshot({ path: 'test-results/two-browser-bridge-name-missing.png', fullPage: true }).catch(() => { });
            throw new Error('Bridge Name was not auto-filled');
        }
        console.log(`Browser 1: Got Bridge Name: "${bridgeName}"`);

        // ===== BROWSER 2: Paste Bridge Name into Discussion =====
        console.log(`Browser 2: Navigating to incident ${TARGET_INCIDENT}...`);
        await page2.goto(`https://ppeportal.microsofticm.com/imp/v5/incidents/details/${TARGET_INCIDENT}/summary`, { waitUntil: 'networkidle' });

        // Wait for form to fully load (per request)
        await page2.waitForTimeout(3000);

        // Find the Discussion editor by id and type the Bridge Name into it
        console.log('Browser 2: Looking for Discussion editor (#NewDiscussionEditor)...');

        const editorRoot = page2.locator('#NewDiscussionEditor').first();
        const hasEditorRoot = (await editorRoot.count().catch(() => 0)) > 0;

        // Primary path: use the known id
        let discussionInput = null;
        let discussionScope = page2;

        if (hasEditorRoot) {
            await editorRoot.waitFor({ state: 'visible', timeout: 15000 });
            await editorRoot.scrollIntoViewIfNeeded().catch(() => { });

            // The id might be on the editable element itself or on a wrapper
            const scopedCandidates = [
                editorRoot.locator('div[role="textbox"][contenteditable="true"]').first(),
                editorRoot.locator('[contenteditable="true"]').first(),
                editorRoot.locator('textarea').first(),
                editorRoot,
            ];

            for (const candidate of scopedCandidates) {
                if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
                    discussionInput = candidate;
                    break;
                }
            }

            // Scope Save/Cancel lookup to the closest container that has the Save button
            const containerWithSave = editorRoot.locator('xpath=ancestor::*[self::div or self::section][.//button[@title="Save"]][1]').first();
            if ((await containerWithSave.count().catch(() => 0)) > 0) {
                discussionScope = containerWithSave;
            } else {
                discussionScope = editorRoot;
            }
        }

        // Fallback path if the id is missing for some reason
        if (!discussionInput) {
            console.log('Browser 2: #NewDiscussionEditor not found; falling back to heuristic editor search...');
            const piiWarning = page2.getByText(/Do not enter personally identifiable information/i).first();
            await piiWarning.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { });
            const discussionRegion = (await piiWarning.isVisible().catch(() => false))
                ? piiWarning.locator('xpath=ancestor::*[self::div or self::section][1]')
                : null;
            discussionScope = discussionRegion || page2;

            const discussionCandidates = discussionRegion
                ? [
                    discussionRegion.locator('div[role="textbox"][contenteditable="true"]').first(),
                    discussionRegion.locator('[contenteditable="true"]').first(),
                    discussionRegion.locator('textarea').first(),
                ]
                : [
                    page2.getByRole('textbox', { name: /Discussion/i }).first(),
                    page2.locator('[aria-label*="Discussion" i][contenteditable="true"]').first(),
                    page2.locator('div[role="textbox"][contenteditable="true"]').first(),
                    page2.locator('[contenteditable="true"]').first(),
                    page2.locator('textarea[aria-label*="Discussion" i]').first(),
                    page2.locator('textarea').first()
                ];

            for (const candidate of discussionCandidates) {
                if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
                    discussionInput = candidate;
                    break;
                }
            }
        }

        if (!discussionInput) {
            await page2.screenshot({ path: 'test-results/two-browser-discussion-missing.png', fullPage: true }).catch(() => { });
            throw new Error('Could not find Discussion editor');
        }

        console.log(`Browser 2: Pasting Bridge Name into Discussion: "${bridgeName}"`);
        await discussionInput.click({ timeout: 10000 });
        const isEditable = await discussionInput.evaluate(el => !!el.isContentEditable).catch(() => false);
        const tagName = await discussionInput.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

        if (isEditable) {
            await page2.keyboard.press('Control+A');
            await page2.keyboard.type(bridgeName, { delay: 10 });
        } else if (tagName === 'textarea' || tagName === 'input') {
            await discussionInput.fill(bridgeName);
        } else {
            await discussionInput.evaluate((el, value) => {
                el.textContent = value;
                el.dispatchEvent(new InputEvent('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, bridgeName).catch(() => { });
        }

        // Click outside to ensure UI registers change
        await page2.keyboard.press('Tab').catch(() => { });

        // Wait 2s after typing so Save becomes visible (per request)
        await page2.waitForTimeout(2000);

        // Find the Save button as described: type="button" title="Save" (bottom-right of the Discussion editor)
        console.log('Browser 2: Waiting for Save button (type=button, title=Save) to become visible...');
        const saveBtn = discussionScope.locator('button[type="button"][title="Save"]').first();

        const startSaveWait = Date.now();
        while (Date.now() - startSaveWait < 30000) {
            const visible = await saveBtn.isVisible().catch(() => false);
            const enabled = await saveBtn.isEnabled().catch(() => false);
            if (visible && enabled) break;
            await page2.waitForTimeout(250);
        }

        if (!(await saveBtn.isVisible().catch(() => false)) || !(await saveBtn.isEnabled().catch(() => false))) {
            await page2.screenshot({ path: 'test-results/two-browser-save-not-clickable.png', fullPage: true }).catch(() => { });
            throw new Error('Save button (type=button, title=Save) did not become visible + enabled after editing Discussion');
        }

        await saveBtn.click({ timeout: 10000 });
        console.log('Browser 2: Clicked Save button');

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
