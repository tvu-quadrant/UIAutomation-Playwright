class IncidentPage {
  /** @param {import('@playwright/test').Page} page */
  constructor(page) {
    this.page = page;
  }

  async gotoSearch() {
    await this.page.goto('https://ppeportal.microsofticm.com/imp/v3/incidents/search/advanced', { waitUntil: 'networkidle' });

    // If the site shows login options, click the Microsoft Entra ID option (first choice)
    try {
      // Try exact text first (handles correct spelling and common typo variant)
      const entraExact = this.page.locator('text="Microsoft Entra ID"').first();
      const entraTypo = this.page.locator('text="Micrsosft Entra ID"').first();
      if (await entraExact.count() > 0) {
        await entraExact.click({ timeout: 5000 });
        await this.page.waitForLoadState('networkidle');
      } else if (await entraTypo.count() > 0) {
        await entraTypo.click({ timeout: 5000 });
        await this.page.waitForLoadState('networkidle');
      } else {
        // Fallback: click any visible tile or element containing 'Entra' (case-insensitive)
        const entraAlt = this.page.locator('text=/Entra ID|Entra/i').first();
        if (await entraAlt.count() > 0) {
          await entraAlt.click({ timeout: 5000 });
          await this.page.waitForLoadState('networkidle');
        }
      }

      // After choosing Entra, try to click a visible 'Sign in' button if present
      const signInSelectors = [
        'button:has-text("Sign in")',
        'a:has-text("Sign in")',
        'text="Sign in"',
        'text=/^\\s*Sign in\\s*$/i'
      ];
      let clicked = false;
      for (const sel of signInSelectors) {
        const signIn = this.page.locator(sel).first();
        if (await signIn.count() > 0) {
          await signIn.click({ timeout: 5000 });
          clicked = true;
          break;
        }
      }

      const searchSelector = 'input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]';
      if (clicked) {
        // Wait for either the landing search input or the MS login inputs to appear.
        try {
          // Prefer waiting for the landing search input (up to 10 minutes)
          await this.page.waitForSelector(searchSelector, { timeout: 600000 });
          return;
        } catch (e) {
          // If landing input didn't appear, check for login inputs (shorter wait)
          const loginInputsHandle = await this.page.waitForSelector('input[type="email"], input[name="loginfmt"], input[type="password"], input[name="passwd"]', { timeout: 15000 }).catch(() => null);
          if (loginInputsHandle) {
            console.log('Detected login form. Waiting for credentials to be entered...');
            try {
              await this.page.waitForFunction(() => {
                const email = document.querySelector('input[name="loginfmt"], input[type="email"], input[name="username"]');
                const pass = document.querySelector('input[name="passwd"], input[type="password"], input[name="password"]');
                return (email && email.value && email.value.length > 0) && (pass && pass.value && pass.value.length > 0);
              }, { timeout: 600000 });

              const submitSelectors = ['#idSIButton9', 'button[type="submit"]', 'input[type="submit"]', 'button:has-text("Sign in")', 'button:has-text("Next")'];
              for (const s of submitSelectors) {
                const el = this.page.locator(s).first();
                if (await el.count() > 0) {
                  try { await el.click({ timeout: 5000 }); } catch (err) { /* ignore */ }
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
            // Neither landing nor login inputs appeared in time — short fallback wait then continue
            await this.page.waitForTimeout(5000);
            return;
          }
        }
      }
    } catch (e) {
      // ignore and continue — if login choice isn't present, the page may already show the search box
    }

    // Wait for the incident search input to appear (exact selector provided)
    try {
      await this.page.waitForSelector('input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]', { timeout: 15000 });
    } catch (e) {
      // allow caller to handle absence — we'll try to locate the input later
    }
  }

  async searchIncident(incidentNumber) {
    const input = this.page.locator('input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]').first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    await input.click({ timeout: 5000 });
    await input.fill(String(incidentNumber));
    await input.press('Enter');
  }

  async waitForDetails(incidentNumber) {
    await this.page.waitForURL(new RegExp(`.*incidents/details/${incidentNumber}/.*`), { timeout: 15000 });
    await this.page.waitForLoadState('networkidle');
  }

  async clickCreateBridge() {
    const btn = this.page.locator('button:has-text("Create bridge")');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
  }
}

module.exports = { IncidentPage };
