// The Canvas login window. Vision opens Chrome on the Canvas sign-in page, the
// user logs in by hand (password, Duo, whatever the school asks), and once
// Canvas accepts the session the cookies are saved and the window closes.
// Vision never sees or stores the password.
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA, config } from './config.js';
import { saveCookies } from './canvas.js';

const PROFILE = path.join(DATA, 'canvas-profile');
const WAIT_MS = 10 * 60 * 1000;

async function launch() {
  const opts = { headless: process.env.VISION_LOGIN_HEADLESS === '1', viewport: null, args: ['--window-size=1100,820'] };
  if (config.browserPath) return chromium.launchPersistentContext(PROFILE, { ...opts, executablePath: config.browserPath });
  try {
    return await chromium.launchPersistentContext(PROFILE, { ...opts, channel: 'chrome' });
  } catch (e) {
    throw new Error('Could not open Google Chrome for the Canvas login. Install Chrome, or set VISION_BROWSER_PATH in .env. ('
      + String(e.message).split('\n')[0] + ')');
  }
}

/** Opens the window and resolves once the user is signed in. Rejects if they close it or take too long. */
export async function loginWindow() {
  const ctx = await launch();
  let closed = false;
  ctx.on('close', () => { closed = true; });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(config.canvasUrl + '/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      if (closed) throw new Error('The Canvas login window was closed before sign-in finished.');
      const res = await ctx.request.get(config.canvasUrl + '/api/v1/users/self', { maxRedirects: 0, failOnStatusCode: false }).catch(() => null);
      if (res && res.status() === 200) {
        saveCookies(await ctx.cookies(config.canvasUrl));
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error('Nobody signed in to Canvas within ten minutes.');
  } finally {
    if (!closed) await ctx.close().catch(() => {});
  }
}
