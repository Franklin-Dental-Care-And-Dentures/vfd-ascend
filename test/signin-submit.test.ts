// The password page is sent exactly once, on Ascend's own form and on Henry Schein's (Auth0) form, whose first
// submit button is hidden with pointer-events none (TEST 51373). Headless Chromium on local pages only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { submitPassword } from '../src/session.ts';

let browser: Browser;
let page: Page;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const sends = () => page.evaluate(() => (window as unknown as { sent?: number }).sent ?? 0);
// A fresh page per form, so no count is carried over from the test before.
const form = async (inner: string) => {
  await page?.close();
  page = await browser.newPage();
  await page.setContent(`<form onsubmit="window.sent=(window.sent||0)+1; return false">${inner}</form>`);
};

test("Ascend's own form: the #send button sends it once", async () => {
  await form('<input id="password" type="password" value="x"><button id="send" type="submit">Sign in</button>');
  await submitPassword(page);
  assert.equal(await sends(), 1);
});

test("Henry Schein's form: hidden first submit, no #send - Enter sends it once", async () => {
  await form('<input id="username" value="u"><input id="password" name="password" type="password" value="x">' +
    '<button type="submit" name="action" value="default" style="pointer-events:none;position:absolute;opacity:0;width:56px;height:14px">Continue</button>' +
    '<button type="submit" name="action" value="default">Continue</button>');
  await submitPassword(page);
  assert.equal(await sends(), 1);
});

test('a hidden #send is not clicked; Enter is used instead', async () => {
  await form('<input type="password" value="x"><button id="send" type="submit" style="display:none">Sign in</button>' +
    '<button type="submit">Continue</button>');
  await submitPassword(page);
  assert.equal(await sends(), 1);
});
