// Copied from repo root tests/helpers/findCreateBridge.js to make the Function App self-contained.

class IncidentPage {
  /** @param {import('@playwright/test').Page} page */
  constructor(page) {
    this.page = page;
  }

  async gotoSearch() {
    const url = 'https://ppeportal.microsofticm.com/imp/v3/overview/main';

    // networkidle can hang indefinitely on SPAs with long-polling; prefer domcontentloaded.
    const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      console.log(`[gotoSearch] navigated url=${this.page.url()} status=${resp ? resp.status() : 'n/a'}`);
    } catch {
      /* ignore */
    }

    // Best-effort settle.
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // If the site shows login options, click the Microsoft Entra ID option (first choice)
    try {
      // Try exact text first (handles correct spelling and common typo variant)
      const entraExact = this.page.locator('text="Microsoft Entra ID"').first();
      const entraTypo = this.page.locator('text="Micrsosft Entra ID"').first();
      if ((await entraExact.count()) > 0) {
        await entraExact.click({ timeout: 5000 });
        await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      } else if ((await entraTypo.count()) > 0) {
        await entraTypo.click({ timeout: 5000 });
        await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      } else {
        // Fallback: click any visible tile or element containing 'Entra' (case-insensitive)
        const entraAlt = this.page.locator('text=/Entra ID|Entra/i').first();
        if ((await entraAlt.count()) > 0) {
          await entraAlt.click({ timeout: 5000 });
          await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        }
      }

      // After choosing Entra, try to click a visible 'Sign in' button if present
      const signInSelectors = [
        'button:has-text("Sign in")',
        'a:has-text("Sign in")',
        'text="Sign in"',
        'text=/^\\s*Sign in\\s*$/i',
      ];
      let clicked = false;
      for (const sel of signInSelectors) {
        const signIn = this.page.locator(sel).first();
        if ((await signIn.count()) > 0) {
          await signIn.click({ timeout: 5000 });
          clicked = true;
          break;
        }
      }

      const searchSelector =
        'input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]';

      // If we hit an interactive login form, MSAuth.json isn't being honored (expired/invalid) or access is blocked.
      // In cloud runs we can't manually sign in; fail fast with a clear error.
      const loginForm = await this.page
        .locator('input[type="email"], input[name="loginfmt"], input[type="password"], input[name="passwd"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (loginForm) {
        throw new Error('Detected Entra login form. MSAuth.json may be expired/invalid or conditional access is blocking cloud browsers.');
      }

      if (clicked) {
        try {
          await this.page.waitForSelector(searchSelector, { timeout: 600000 });
          return;
        } catch (e) {
          const loginInputsHandle = await this.page
            .waitForSelector('input[type="email"], input[name="loginfmt"], input[type="password"], input[name="passwd"]', {
              timeout: 15000,
            })
            .catch(() => null);
          if (loginInputsHandle) {
            console.log('Detected login form. Waiting for credentials to be entered...');
            try {
              await this.page.waitForFunction(
                () => {
                  const email = document.querySelector('input[name="loginfmt"], input[type="email"], input[name="username"]');
                  const pass = document.querySelector('input[name="passwd"], input[type="password"], input[name="password"]');
                  return email && email.value && email.value.length > 0 && pass && pass.value && pass.value.length > 0;
                },
                { timeout: 600000 }
              );

              const submitSelectors = [
                '#idSIButton9',
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Sign in")',
                'button:has-text("Next")',
              ];
              for (const s of submitSelectors) {
                const el = this.page.locator(s).first();
                if ((await el.count()) > 0) {
                  try {
                    await el.click({ timeout: 5000 });
                  } catch {
                    /* ignore */
                  }
                  break;
                }
              }

              await this.page.waitForSelector(searchSelector, { timeout: 600000 });
              return;
            } catch (err) {
              console.log('Timed out waiting for manual credentials or submission.');
              throw err;
            }
          } else {
            await this.page.waitForTimeout(5000);
            return;
          }
        }
      }
    } catch {
      // ignore
    }

    try {
      await this.page.waitForSelector(
        'input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]',
        { timeout: 15000 }
      );
    } catch {
      // allow caller to handle
    }
  }

  async searchIncident(incidentNumber) {
    const input = this.page
      .locator('input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]')
      .first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click({ timeout: 5000 });
    await input.fill(String(incidentNumber));
    await input.press('Enter');
  }

  async waitForDetails(incidentNumber) {
    await this.page.waitForURL(new RegExp(`.*incidents/details/${incidentNumber}/.*`), { timeout: 15000 });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  }

  async clickCreateBridge() {
    const joinBridgeBtn = this.page.locator('button:has-text("Join bridge")');
    try {
      if ((await joinBridgeBtn.count()) > 0) {
        const isVisible = await joinBridgeBtn.isVisible().catch(() => false);
        if (isVisible) {
          return { alreadyCreated: true, message: 'This incident is already created bridge' };
        }
      }
    } catch {
      // continue
    }

    const directBtn = this.page.locator('button:has-text("Create bridge")');
    try {
      if ((await directBtn.count()) > 0) {
        const isVisibleNow = await directBtn.isVisible().catch(() => false);
        if (isVisibleNow) {
          console.log('Found direct "Create bridge" button, clicking it');
          await directBtn.click({ timeout: 2000 });
          return { alreadyCreated: false, message: 'Create bridge dialog opened' };
        }
      }
    } catch {
      // ignore
    }

    console.log('"Create bridge" not directly visible, trying "More actions" menu');
    try {
      const moreRole = this.page.getByRole('button', { name: /More actions/i }).first();
      await moreRole.waitFor({ state: 'visible', timeout: 2000 });
      await moreRole.click({ timeout: 2000 });

      const menuItem = this.page.getByText(/Create bridge/i).first();
      const createBridgeVisible = await menuItem.isVisible({ timeout: 2000 }).catch(() => false);

      if (!createBridgeVisible) {
        console.log('Create bridge not found in More actions menu');
        await this.page.keyboard.press('Escape').catch(() => {});
        return { alreadyCreated: true, message: 'This incident is already created bridge' };
      }

      await menuItem.click({ timeout: 2000 });
      return { alreadyCreated: false, message: 'Create bridge dialog opened' };
    } catch {
      // fallback
    }

    const moreSelectors = [
      'text=/More actions/i',
      'button:has-text("More actions")',
      'button:has-text("More")',
      '[aria-label="More actions"]',
      '[aria-label="More"]',
      'button[title="More actions"]',
      'button:has-text("...")',
      '.more-actions',
    ];

    const start = Date.now();
    for (const sel of moreSelectors) {
      if (Date.now() - start > 5000) break;
      const more = this.page.locator(sel).first();
      const moreVisible = await more.isVisible().catch(() => false);
      if (!moreVisible) continue;
      try {
        await more.waitFor({ state: 'visible', timeout: 2000 });
        await more.click({ timeout: 2000 });
        const menuItem = this.page.locator('text=/Create bridge/i').first();
        if ((await menuItem.count()) > 0) {
          const isMenuItemVisible = await menuItem.isVisible().catch(() => false);
          if (isMenuItemVisible) {
            await menuItem.click({ timeout: 2000 }).catch(() => {});
            return { alreadyCreated: false, message: 'Create bridge dialog opened' };
          }
        }
        await this.page.keyboard.press('Escape').catch(() => {});
      } catch {
        // try next
      }
    }

    return { alreadyCreated: true, message: 'This incident is already created bridge' };
  }

  async selectEngineeringOption() {
    const heading = this.page
      .locator('text=/Create Collaboration Experience|Create Teams Collaboration|Create Collaboration/i')
      .first();
    await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    // Exact Fluent UI structure (matches: <div class="ms-ChoiceField-wrapper"><input id="ChoiceGroup###-Engineering" ...><label for="...-Engineering" ...>...)
    // Prefer finding the *exact* input by id suffix and clicking its label (even if already selected).
    const engineeringInput = this.page.locator('input[type="radio"][id$="-Engineering"]').first();
    await engineeringInput.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    if ((await engineeringInput.count()) > 0) {
      const beforeChecked = await engineeringInput.isChecked().catch(() => null);
      const engineeringId = await engineeringInput.getAttribute('id').catch(() => null);
      console.log(`[create-bridge] engineering option found id=${engineeringId} checkedBefore=${beforeChecked}`);
      if (engineeringId) {
        const engineeringLabelByFor = this.page.locator(`label[for="${engineeringId}"]`).first();
        if ((await engineeringLabelByFor.count()) > 0) {
          await engineeringLabelByFor.scrollIntoViewIfNeeded().catch(() => {});
          await engineeringLabelByFor.click({ timeout: 10000 }).catch(() => {});
          await this.page.waitForTimeout(250).catch(() => {});
          // Click again to satisfy "click even if selected" (some UIs wire enablement on click handler).
          await engineeringLabelByFor.click({ timeout: 10000 }).catch(() => {});
          await this.page.waitForTimeout(250).catch(() => {});
          const afterChecked = await engineeringInput.isChecked().catch(() => null);
          console.log(`[create-bridge] engineering clicked by label checkedAfter=${afterChecked}`);
          return;
        }
      }
      console.log('[create-bridge] engineering input found but label-for click not available; falling back');
    }

    console.log('[create-bridge] engineering input id$="-Engineering" not found; using heuristic selectors');

    // Fallbacks: role-based radio, then any label/text match.
    const engineeringRadio = this.page.getByRole('radio', { name: /Engineering/i }).first();
    if ((await engineeringRadio.count()) > 0) {
      await engineeringRadio.scrollIntoViewIfNeeded().catch(() => {});
      await engineeringRadio.click({ timeout: 10000 }).catch(() => {});
      await this.page.waitForTimeout(250).catch(() => {});
      await engineeringRadio.click({ timeout: 10000 }).catch(() => {});
      await this.page.waitForTimeout(250).catch(() => {});
      const ariaChecked = await engineeringRadio.getAttribute('aria-checked').catch(() => null);
      console.log(`[create-bridge] engineering clicked by role aria-checked=${ariaChecked}`);
      return;
    }

    const engineeringLabel = this.page.locator('label:has-text("Engineering")').first();
    if ((await engineeringLabel.count()) > 0) {
      await engineeringLabel.scrollIntoViewIfNeeded().catch(() => {});
      await engineeringLabel.click({ timeout: 10000 }).catch(() => {});
      await this.page.waitForTimeout(250).catch(() => {});
      await engineeringLabel.click({ timeout: 10000 }).catch(() => {});
      await this.page.waitForTimeout(250).catch(() => {});
      console.log('[create-bridge] engineering clicked by generic label match');
    }
  }

  async clickSaveButton(timeoutMs = 30000) {
    // There can be multiple "Save" buttons on the page. Prefer the *primary* Save inside the
    // Create Bridge modal (the one that becomes enabled when the form is valid).
    const engineeringInput = this.page.locator('input[type="radio"][id$="-Engineering"]').first();
    const engineeringDialog = engineeringInput
      .locator('xpath=ancestor-or-self::*[@role="dialog" or contains(@class,"ms-Modal") or contains(@class,"ms-Dialog")][1]')
      .first();
    const scope = ((await engineeringDialog.count()) > 0 ? engineeringDialog : this.page);

    const anySave = scope.locator('button[aria-label="Save"], button[title="Save"], button:has-text("Save")');
    await anySave.first().waitFor({ state: 'visible', timeout: Math.min(8000, timeoutMs) });

    // Wait for a Save that is not disabled.
    const enabledSave = scope.locator(
      'button[aria-label="Save"]:not([disabled]):not([aria-disabled="true"]), button[title="Save"]:not([disabled]):not([aria-disabled="true"])'
    );

    try {
      await enabledSave.first().waitFor({ state: 'visible', timeout: timeoutMs });
      await enabledSave.first().click({ timeout: 10000 });
      return;
    } catch {
      // Diagnostics: enumerate all Save candidates in-scope.
      const candidates = await anySave
        .evaluateAll((nodes) =>
          nodes.map((n) => {
            const el = /** @type {any} */ (n);
            return {
              ariaLabel: el.getAttribute?.('aria-label') || null,
              title: el.getAttribute?.('title') || null,
              disabledAttr: el.hasAttribute?.('disabled') || false,
              ariaDisabled: el.getAttribute?.('aria-disabled') || null,
              className: el.className || null,
              text: (el.textContent || '').trim().slice(0, 80),
            };
          })
        )
        .catch(() => null);

      if (candidates) console.log(`[create-bridge] save_candidates=${JSON.stringify(candidates)}`);

      const save = anySave.first();
      const initialEnabled = await save.isEnabled().catch(() => null);
      const initialAriaDisabled = await save.getAttribute('aria-disabled').catch(() => null);
      console.log(`[create-bridge] save visible enabled=${initialEnabled} aria-disabled=${initialAriaDisabled}`);

      const outer = await save.evaluate((el) => el.outerHTML).catch(() => null);
      if (outer) console.log(`[create-bridge] save outerHTML=${outer}`);

      const diag = await this.page
        .evaluate(() => {
          const saveBtn = Array.from(document.querySelectorAll('button')).find((b) => {
            const t = (b.getAttribute('title') || '').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
            return t === 'save' || a === 'save';
          });

          const root =
            saveBtn?.closest('[role="dialog"]') ||
            saveBtn?.closest('.ms-Modal') ||
            saveBtn?.closest('.ms-Dialog') ||
            document.body;

          const required = Array.from(root.querySelectorAll('[required]')).map((el) => {
            const anyEl = /** @type {any} */ (el);
            return {
              tag: el.tagName,
              type: anyEl.type,
              id: anyEl.id,
              name: anyEl.name,
              ariaLabel: anyEl.getAttribute?.('aria-label') || null,
              disabled: Boolean(anyEl.disabled),
              checked: typeof anyEl.checked === 'boolean' ? anyEl.checked : undefined,
              value: typeof anyEl.value === 'string' ? anyEl.value : undefined,
            };
          });

          const radioGroups = new Map();
          for (const el of Array.from(root.querySelectorAll('input[type="radio"]'))) {
            const anyEl = /** @type {any} */ (el);
            const name = anyEl.name || '(no-name)';
            const entry = radioGroups.get(name) || [];
            entry.push({ id: anyEl.id || null, checked: Boolean(anyEl.checked), required: el.hasAttribute('required') });
            radioGroups.set(name, entry);
          }

          const radios = Array.from(radioGroups.entries()).map(([name, items]) => ({ name, items }));

          const visibleText = (node) => {
            const style = window.getComputedStyle(node);
            if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          const messages = Array.from(
            root.querySelectorAll('[role="alert"], .ms-MessageBar, .ms-TextField-errorMessage, .error, .validation')
          )
            .filter((n) => n && typeof n.textContent === 'string' && n.textContent.trim().length > 0)
            .filter((n) => visibleText(/** @type {any} */ (n)))
            .map((n) => n.textContent.trim())
            .slice(0, 30);

          return {
            requiredCount: required.length,
            required,
            radioGroupCount: radios.length,
            radios,
            messageCount: messages.length,
            messages,
          };
        })
        .catch(() => null);

      if (diag) console.log(`[create-bridge] save_disabled_diag=${JSON.stringify(diag)}`);
      throw new Error(`Save button did not become enabled within ${timeoutMs}ms (aria-disabled=true).`);
    }
  }

  async waitForSuccessMessage(timeoutMs = 5000) {
    const success = this.page.locator('text=/Success|saved successfully|created successfully/i').first();
    try {
      await success.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { IncidentPage };
