// One-off look at the Ascend sign-in pages, metadata only: it fills the organization and the username, presses
// Continue, and reports where the browser lands and which fields that page shows. It never types the password, so
// it uses no sign-in attempt. Run as npreg on DISPLAY :99.
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { ALLOWED_HOSTS, BASE, ORGANIZATION, USER_FILE } from '../src/config.ts';

async function fields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('input, button, select, textarea'))) {
      const h = el as HTMLElement;
      const r = h.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const i = el as HTMLInputElement;
      const label = el.tagName === 'BUTTON' ? ` "${(h.innerText || '').trim().slice(0, 30)}"` : '';
      out.push(`${el.tagName.toLowerCase()}:${i.type || ''}:${i.name || ''}#${h.id || ''}${label}`);
    }
    return out;
  });
}

const where = (page: Page) => { const u = new URL(page.url()); return `${u.host}${u.pathname}`; };

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York' });
const blocked = new Set<string>();
await context.route('**/*', (route) => {
  const host = new URL(route.request().url()).host;
  if (ALLOWED_HOSTS.has(host)) return route.continue();
  blocked.add(host);
  return route.abort();
});
const page = await context.newPage();
const path: string[] = [];
page.on('framenavigated', (f) => { if (f === page.mainFrame()) path.push(where(page)); });
try {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  console.log('1 at', where(page), '| title:', await page.title());
  console.log('1 fields', JSON.stringify(await fields(page)));
  await page.fill('input[name="organization"]', ORGANIZATION);
  await page.fill('input[name="username"]', readFileSync(USER_FILE, 'utf8').trim());
  const before = page.url();
  await page.click('input[name="continue"], button[name="continue"]', { timeout: 10000 });
  await Promise.race([
    page.waitForURL((u) => u.toString() !== before, { timeout: 20000 }),
    page.locator('input[type="password"]:visible').first().waitFor({ timeout: 20000 }),
  ]).catch((e) => console.log('2 wait:', String(e.message).split('\n')[0]));
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);
  console.log('2 at', where(page), '| title:', await page.title());
  console.log('2 fields', JSON.stringify(await fields(page)));
} catch (e) {
  console.log('error:', String((e as Error).message).split('\n')[0]);
} finally {
  console.log('pages:', path.join(' -> '));
  console.log('aborted hosts:', [...blocked].sort().join(' '));
  await browser.close();
}
