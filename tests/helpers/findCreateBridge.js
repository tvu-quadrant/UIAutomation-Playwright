class IncidentPage {
  /** @param {import('@playwright/test').Page} page */
  constructor(page) {
    this.page = page;
  }

  async gotoSearch() {
    await this.page.goto('https://ppeportal.microsofticm.com/imp/v3/overview/main', { waitUntil: 'networkidle' });

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
          const loginInputsHandle = await this.page
            .waitForSelector('input[type="email"], input[name="loginfmt"], input[type="password"], input[name="passwd"]', { timeout: 15000 })
            .catch(() => null);
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
                  try {
                    await el.click({ timeout: 5000 });
                  } catch (err) {
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
    await this.page.waitForLoadState('networkidle');
  }

  async clickCreateBridge() {
    // First, check if bridge is already created (look for "Join bridge" button)
    const joinBridgeBtn = this.page.locator('button:has-text("Join bridge")');
    try {
      if ((await joinBridgeBtn.count()) > 0) {
        const isVisible = await joinBridgeBtn.isVisible().catch(() => false);
        if (isVisible) {
          return { alreadyCreated: true, message: 'This incident is already created bridge' };
        }
      }
    } catch (err) {
      // continue checking for Create bridge
    }

    // Check if "Create bridge" button is directly visible (no need for More actions)
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
    } catch (err) {
      // ignore and continue to try More actions
    }

    // If "Create bridge" not directly visible, try "More actions" menu
    console.log('"Create bridge" not directly visible, trying "More actions" menu');
    try {
      const moreRole = this.page.getByRole('button', { name: /More actions/i }).first();
      await moreRole.waitFor({ state: 'visible', timeout: 2000 });
      await moreRole.click({ timeout: 2000 });

      // Check if "Create bridge" is in the menu
      const menuItem = this.page.getByText(/Create bridge/i).first();
      const createBridgeVisible = await menuItem.isVisible({ timeout: 2000 }).catch(() => false);

      if (!createBridgeVisible) {
        // Create bridge not in menu - bridge may already exist
        console.log('Create bridge not found in More actions menu');
        // Close the menu by clicking elsewhere
        await this.page.keyboard.press('Escape').catch(() => { });
        return { alreadyCreated: true, message: 'This incident is already created bridge' };
      }

      await menuItem.click({ timeout: 2000 });
      return { alreadyCreated: false, message: 'Create bridge dialog opened' };
    } catch (err) {
      // fallback: try other More selectors within 5s window
    }

    const moreSelectors = [
      'text=/More actions/i',
      'button:has-text("More actions")',
      'button:has-text("More")',
      '[aria-label="More actions"]',
      '[aria-label="More"]',
      'button[title="More actions"]',
      'button:has-text("...")',
      '.more-actions'
    ];

    const start = Date.now();
    for (const sel of moreSelectors) {
      if (Date.now() - start > 5000) break; // only try for 5s total
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
            await menuItem.click({ timeout: 2000 }).catch(() => { });
            return { alreadyCreated: false, message: 'Create bridge dialog opened' };
          }
        }
        // Create bridge not found in this menu - close and continue
        await this.page.keyboard.press('Escape').catch(() => { });
      } catch (err) {
        // try next selector within 5s
      }
    }

    // Create bridge not found after all attempts - treat as already created
    return { alreadyCreated: true, message: 'This incident is already created bridge' };
  }

  // Wait for the collaboration form to appear and select the Engineering radio option
  async selectEngineeringOption() {
    const heading = this.page.locator('text=/Create Collaboration Experience|Create Teams Collaboration|Create Collaboration/i').first();
    await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });

    // First, ensure the left tab 'Create Teams Collaboration' is selected (tab text present)
    try {
      const tab = this.page.locator('span.ms-Pivot-text', { hasText: 'Create Teams Collaboration' }).first();
      if ((await tab.count()) > 0) {
        await tab.click({ timeout: 1000 }).catch(() => { });
      }
    } catch (e) { }

    // Try multiple strategies to select Engineering
    const strategies = [
      async () => {
        const radio = this.page.getByRole('radio', { name: /Engineering/i }).first();
        if ((await radio.count()) === 0) return false;
        await radio.waitFor({ state: 'visible', timeout: 2000 }).catch(() => { });
        try {
          await radio.click({ timeout: 1500 });
        } catch (e) { }
        const checked = await radio.isChecked().catch(() => false);
        if (checked) return true;
        // fallback: click nearby label
        const lbl = this.page.getByText(/Engineering/i).first();
        if ((await lbl.count()) > 0) {
          try {
            await lbl.click({ timeout: 1500 });
          } catch (e) { }
          const checked2 = await radio.isChecked().catch(() => false);
          if (checked2) return true;
        }
        return false;
      },
      async () => {
        const lbl = this.page.locator('label:has-text("Engineering")').first();
        if ((await lbl.count()) === 0) return false;
        await lbl.waitFor({ state: 'visible', timeout: 2000 }).catch(() => { });
        try {
          const box = await lbl.boundingBox().catch(() => null);
          if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 40 });
          else await lbl.click({ timeout: 1200 });
        } catch (e) { }
        return true;
      },
      async () => {
        // Try direct input id if known
        const inputById = this.page.locator('#ChoiceGroup429-Engineering').first();
        if ((await inputById.count()) > 0) {
          try {
            await inputById.click({ timeout: 1200 });
          } catch (e) { }
          return true;
        }

        const lblText = this.page.getByText(/Engineering/i).first();
        if ((await lblText.count()) === 0) return false;
        try {
          await lblText.click({ timeout: 1200 });
        } catch (e) { }
        return true;
      }
    ];

    let selected = false;
    for (const s of strategies) {
      try {
        selected = await s();
      } catch (e) {
        selected = false;
      }
      if (selected) break;
      await this.page.waitForTimeout(200);
    }

    if (!selected) throw new Error('Engineering option not found in collaboration form');
    console.log('Engineering option selected');
  }

  // Click the Save button in the Create Bridge form
  async clickSaveButton() {
    const saveSelectors = [
      'button:has-text("Save")',
      'button[type="submit"]:has-text("Save")',
      '[data-automation-id="save-button"]',
      'button.ms-Button--primary:has-text("Save")',
      'text=/^Save$/i'
    ];

    let saveClicked = false;
    for (const sel of saveSelectors) {
      const saveBtn = this.page.locator(sel).first();
      if ((await saveBtn.count()) > 0) {
        try {
          await saveBtn.waitFor({ state: 'visible', timeout: 2000 });
          await saveBtn.click({ timeout: 2000 });
          saveClicked = true;
          console.log('Clicked Save button');
          break;
        } catch (e) {
          // try next selector
        }
      }
    }

    if (!saveClicked) {
      // Try by role as fallback
      try {
        const saveByRole = this.page.getByRole('button', { name: /Save/i }).first();
        if ((await saveByRole.count()) > 0) {
          await saveByRole.click({ timeout: 2000 });
          saveClicked = true;
          console.log('Clicked Save button via role');
        }
      } catch (e) { }
    }

    if (!saveClicked) {
      throw new Error('Save button not found');
    }
  }

  async waitForSuccessMessage(timeoutMs = 15_000) {
    const selectors = [
      '[role="alert"]:has-text("Success")',
      '[role="status"]:has-text("Success")',
      '.ms-MessageBar:has-text("Success")',
      'text=/\\bSuccess\\b/i'
    ];

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const sel of selectors) {
        const loc = this.page.locator(sel).first();
        try {
          if ((await loc.count()) > 0) {
            const visible = await loc.isVisible().catch(() => false);
            if (visible) return true;
          }
        } catch {
          // ignore and keep trying
        }
      }

      await this.page.waitForTimeout(250);
    }

    return false;
  }

  // Wait for the collaboration form to appear and select the Engineering radio option
  async _selectEngineeringOption() {
    const heading = this.page.locator('text=/Create Collaboration Experience|Create Teams Collaboration|Create Collaboration/i').first();
    await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
    // Helper to wait for Bridge Name to be auto-filled
    const bridgeSelector = 'input[placeholder*="Bridge" i], input[name*="bridge" i], input[aria-label*="Bridge" i]';
    const waitForBridgeValue = async (timeout = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const el = await this.page.locator(bridgeSelector).first();
        if ((await el.count()) > 0) {
          const val = await el.inputValue().catch(() => '');
          if (val && val.trim().length > 0) return val.trim();
        }
        await this.page.waitForTimeout(250);
      }
      return '';
    };

    // First, ensure the left tab 'Create Teams Collaboration' is selected (tab text present)
    try {
      const tab = this.page.locator('span.ms-Pivot-text', { hasText: 'Create Teams Collaboration' }).first();
      if ((await tab.count()) > 0) {
        await tab.click({ timeout: 1000 }).catch(() => { });
      }
    } catch (e) { }

    // Try multiple strategies to select Engineering
    const strategies = [
      async () => {
        const radio = this.page.getByRole('radio', { name: /Engineering/i }).first();
        if ((await radio.count()) === 0) return false;
        await radio.waitFor({ state: 'visible', timeout: 2000 }).catch(() => { });
        try {
          await radio.click({ timeout: 1500 });
        } catch (e) { }
        const checked = await radio.isChecked().catch(() => false);
        if (checked) return true;
        // fallback: click nearby label
        const lbl = this.page.getByText(/Engineering/i).first();
        if ((await lbl.count()) > 0) {
          try {
            await lbl.click({ timeout: 1500 });
          } catch (e) { }
          const checked2 = await radio.isChecked().catch(() => false);
          if (checked2) return true;
        }
        return false;
      },
      async () => {
        const lbl = this.page.locator('label:has-text("Engineering")').first();
        if ((await lbl.count()) === 0) return false;
        await lbl.waitFor({ state: 'visible', timeout: 2000 }).catch(() => { });
        try {
          const box = await lbl.boundingBox().catch(() => null);
          if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 40 });
          else await lbl.click({ timeout: 1200 });
        } catch (e) { }
        return true;
      },
      async () => {
        // Try direct input id if known
        const inputById = this.page.locator('#ChoiceGroup429-Engineering').first();
        if ((await inputById.count()) > 0) {
          try {
            await inputById.click({ timeout: 1200 });
          } catch (e) { }
          return true;
        }

        const lblText = this.page.getByText(/Engineering/i).first();
        if ((await lblText.count()) === 0) return false;
        try {
          await lblText.click({ timeout: 1200 });
        } catch (e) { }
        return true;
      }
    ];

    let selected = false;
    for (const s of strategies) {
      try {
        selected = await s();
      } catch (e) {
        selected = false;
      }
      if (selected) break;
      await this.page.waitForTimeout(200);
    }

    if (!selected) throw new Error('Engineering option not found in collaboration form');

    // Wait 5s for Bridge Name field to be auto-filled and form to render fully
    console.log('Waiting 5s for form to fully render...');
    await this.page.waitForTimeout(5000);

    // Click the Save button
    const saveSelectors = [
      'button:has-text("Save")',
      'button[type="submit"]:has-text("Save")',
      '[data-automation-id="save-button"]',
      'button.ms-Button--primary:has-text("Save")',
      'text=/^Save$/i'
    ];

    let saveClicked = false;
    for (const sel of saveSelectors) {
      const saveBtn = this.page.locator(sel).first();
      if ((await saveBtn.count()) > 0) {
        try {
          await saveBtn.waitFor({ state: 'visible', timeout: 2000 });
          await saveBtn.click({ timeout: 2000 });
          saveClicked = true;
          console.log('Clicked Save button');
          break;
        } catch (e) {
          // try next selector
        }
      }
    }

    if (!saveClicked) {
      // Try by role as fallback
      try {
        const saveByRole = this.page.getByRole('button', { name: /Save/i }).first();
        if ((await saveByRole.count()) > 0) {
          await saveByRole.click({ timeout: 2000 });
          saveClicked = true;
          console.log('Clicked Save button via role');
        }
      } catch (e) { }
    }

    if (!saveClicked) {
      throw new Error('Save button not found');
    }

    // Wait for save action to complete
    await this.page.waitForTimeout(3000);
  }
}

module.exports = { IncidentPage };
