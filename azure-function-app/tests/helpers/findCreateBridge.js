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

    // Best-effort selectors
    const engineering = this.page.locator('label:has-text("Engineering") input[type="radio"]').first();
    if ((await engineering.count()) > 0) {
      await engineering.check({ timeout: 5000 }).catch(() => {});
      return;
    }

    const engineeringText = this.page.getByText(/Engineering/i).first();
    if ((await engineeringText.count()) > 0) {
      await engineeringText.click({ timeout: 5000 }).catch(() => {});
    }
  }

  async clickSaveButton() {
    const save = this.page.locator('button:has-text("Save")').first();
    await save.waitFor({ state: 'visible', timeout: 10000 });
    await save.click({ timeout: 5000 });
  }

  async waitForSuccessMessage(timeoutMs = 15000) {
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
