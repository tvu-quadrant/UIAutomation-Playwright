# UIAutomation-Playwright

Instructions to run the Playwright test locally.

Prerequisites
- Node.js (14+)

Install deps

```bash
npm install
npx playwright install
```

Run test

```bash
npm test
```

What the test does
- Navigates to the advanced incident search page
- Finds the search textbox, fills incident `154847522`, and presses Enter
- Waits for the incident detail page to load
- Clicks the `Create bridge` button

Notes
- You may need to sign in to access the portal before the script can proceed.
# UIAutomation-Playwright

Instructions to run the Playwright test locally.

Prerequisites
- Node.js (14+)

Install deps

```bash
npm install
npx playwright install
```

Run test

```bash
npm test
```

What the test does
- Navigates to the advanced incident search page
- Finds the search textbox, fills incident `154847522`, and presses Enter
- Waits for the incident detail page to load
- Clicks the `Create bridge` button

Notes
- You may need to sign in to access the portal before the script can proceed.
