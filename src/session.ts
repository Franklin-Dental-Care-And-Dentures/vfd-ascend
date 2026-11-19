// The one signed-in Ascend browser (decision 1175): a headed Chromium on the virtual display, signed in as the
// link's own Ascend user, and every Ascend call sent through it with the session cookies and the csrf token from
// /pm (doc ascend-internal-calls-map 8.8.4 item 1, 8.9.2). Calls go one at a time. A call answered 302 or 401
// signs in again once and is sent again; every sign-in passes the guard first.
//
// Nothing here prints or keeps patient data: errors carry the method, the path without its query and the status.
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { alert } from './alert.ts';
import { ALLOWED_HOSTS, AUTH_HOST, BASE, LIVE_HOST, LOGIN_URL, ORGANIZATION, PASS_FILE, TZ, USER_FILE } from './config.ts';
import type { SignInGuard } from './guard.ts';

export class SignInRefused extends Error {}

export class AscendHttpError extends Error {
  status: number;
  constructor(method: string, path: string, status: number) {
    super(`${method} ${pathOnly(path)}: HTTP ${status}`);
    this.status = status;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type Reply = { status: number; json: unknown };
type Outcome = 'ok' | 'code' | 'rejected' | 'stuck';

const SIGNED_IN_PATH = /^\/(pm|landing)(\/|$)/;
const LOGIN_PATH = /^\/login(\/|$)/;

export const pathOnly = (p: string) => p.split('?')[0];

// Send the password page. Ascend's own /login form has a #send button. Henry Schein's sign-in page (Auth0 Universal
// Login, which Ascend handed the password step to by 15:28 ET 2026-11-19) has no #send and two submit buttons named
// "action": the first is a hidden default button with pointer-events none, so clicking the first visible submit hangs
// (TEST 51373). Enter in the password field submits either form once, through the form's own default button.
export async function submitPassword(page: Page): Promise<void> {
  const send = page.locator('#send:visible');
  if (await send.count()) {
    await send.first().click({ timeout: 10000 });
    return;
  }
  await page.locator('input[type="password"]:visible').first().press('Enter', { timeout: 10000 });
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200);

export class AscendSession {
  guard: SignInGuard;
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  csrf = '';
  signedInAt: Date | null = null;
  lastCallAt: Date | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(guard: SignInGuard) {
    this.guard = guard;
  }

  async open(): Promise<Page> {
    if (this.page && this.browser?.isConnected()) return this.page;
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      locale: 'en-US', timezoneId: TZ, viewport: { width: 1400, height: 900 },
    });
    await context.route('**/*', (route) => {
      let host = '';
      try { host = new URL(route.request().url()).host; } catch { /* not a URL: abort */ }
      return ALLOWED_HOSTS.has(host) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on('dialog', (d) => {
      console.error(`browser ${d.type()} dialog dismissed`);
      d.dismiss().catch(() => {});
    });
    browser.on('disconnected', () => this.#forget(true));
    this.browser = browser;
    this.context = context;
    this.page = page;
    return page;
  }

  #forget(browserGone: boolean): void {
    this.csrf = '';
    this.signedInAt = null;
    if (browserGone) {
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.#forget(true);
    await b?.close().catch(() => {});
  }

  #where(): URL {
    return new URL(this.page?.url() || 'about:blank');
  }

  // Signed in, by a person over VNC after a code prompt for example: take the session over.
  async #adopt(): Promise<boolean> {
    const u = this.#where();
    if (u.host !== LIVE_HOST || !SIGNED_IN_PATH.test(u.pathname)) return false;
    const csrf = await this.#readCsrf().catch(() => '');
    if (!csrf) return false;
    this.csrf = csrf;
    this.signedInAt = new Date();
    const s = this.guard.state();
    if (s.stopped?.code_prompt) this.guard.clear();
    this.guard.record(true, 'session taken over: signed in by a person');
    return true;
  }

  async ensureSignedIn(): Promise<void> {
    if (this.csrf && this.browser?.isConnected()) return;
    if (this.page && (await this.#adopt())) return;
    await this.signIn();
  }

  async signIn(): Promise<void> {
    const v = this.guard.check();
    if (!v.ok) throw new SignInRefused(v.why + (v.retry_at ? `; next try after ${v.retry_at}` : ''));
    this.#forget(false);
    await this.open();
    let outcome: Outcome;
    let detail: string;
    try {
      [outcome, detail] = await this.#steps();
    } catch (e) {
      [outcome, detail] = ['stuck', firstLine(e)];
    }
    if (outcome === 'ok') {
      this.csrf = await this.#readCsrf().catch(() => '');
      if (!this.csrf) [outcome, detail] = ['stuck', 'signed in, but /pm has no csrf token'];
    }
    if (outcome === 'ok') {
      this.signedInAt = new Date();
      this.guard.record(true, 'signed in');
      return;
    }
    if (outcome === 'code') {
      // The page is left as it is, so Dewayne can finish the sign-in over VNC; the next call takes it over.
      this.guard.stop('Ascend asked for a sign-in code', true);
      alert('signin-code', 'Ascend asked for a sign-in code. Sign-in is stopped; Dewayne finishes it over VNC.');
      throw new SignInRefused('Ascend asked for a sign-in code; sign-in stopped');
    }
    const s = this.guard.record(false, `${outcome}: ${detail}`);
    alert('signin-failed', `Ascend sign-in failed (${outcome}: ${detail}).` +
      (s.stopped ? ' Sign-in is stopped until a person clears it.' : ' One retry no sooner than 15 minutes.'));
    throw new SignInRefused(`sign-in failed (${outcome}: ${detail})`);
  }

  async #steps(): Promise<[Outcome, string]> {
    const page = this.page!;
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let u = this.#where();
    if (u.host === LIVE_HOST && SIGNED_IN_PATH.test(u.pathname)) return ['ok', 'already signed in'];
    if (!(u.host === LIVE_HOST && LOGIN_PATH.test(u.pathname))) return ['stuck', `sign-in page not found; at ${u.host}${u.pathname}`];
    await page.fill('#organization', ORGANIZATION);
    await page.fill('#username', readFileSync(USER_FILE, 'utf8').trim());
    await page.click('#continue');
    const password = page.locator('#password');
    await password.waitFor({ state: 'visible', timeout: 20000 });
    await password.fill(readFileSync(PASS_FILE, 'utf8').trim());
    const submittedOn = this.#where().host;
    await submitPassword(page);
    // Where the sign-in ends: the app, a code prompt, an error on a sign-in page, or nothing within a minute.
    // A password already sent on Henry Schein's page is never typed and sent there a second time.
    let authPasswordSent = submittedOn === AUTH_HOST;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      u = this.#where();
      if (u.host === LIVE_HOST && SIGNED_IN_PATH.test(u.pathname)) return ['ok', u.pathname];
      const onSignInPage = u.host === AUTH_HOST || (u.host === LIVE_HOST && LOGIN_PATH.test(u.pathname));
      if (!onSignInPage) continue;
      if (await this.#codePrompt()) return ['code', `${u.host}${u.pathname}`];
      const err = await this.#signInError();
      if (err) return ['rejected', err];
      if (u.host === AUTH_HOST && !authPasswordSent) {
        // Henry Schein's own sign-in page, if Ascend hands over to it: the same name and password, once.
        const pw = page.locator('input[type="password"]:visible').first();
        if (await pw.count()) {
          const name = page.locator('input[name="username"]:visible').first();
          if ((await name.count()) && !(await name.inputValue())) {
            await name.fill(readFileSync(USER_FILE, 'utf8').trim());
          }
          await pw.fill(readFileSync(PASS_FILE, 'utf8').trim());
          authPasswordSent = true;
          await submitPassword(page);
        }
      }
    }
    u = this.#where();
    return ['stuck', `no app page within 60 s; at ${u.host}${u.pathname}; fields ${await this.#fields()}`];
  }

  async #codePrompt(): Promise<boolean> {
    const u = this.#where();
    if (/mfa|otp|verify|challenge/i.test(u.pathname)) return true;
    const sel = 'input[name="code"]:visible, input[autocomplete="one-time-code"]:visible, input[name="otp"]:visible';
    return (await this.page!.locator(sel).count()) > 0;
  }

  // Error text shown on a sign-in page (never read on an app page, which can show patient names).
  async #signInError(): Promise<string> {
    const sel = '[role="alert"]:visible, .error:visible, .alert-danger:visible, [id*="error" i]:visible, ' +
      '.ulp-input-error-message:visible, .ulp-validator-error:visible';
    const loc = this.page!.locator(sel);
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const t = (await loc.nth(i).innerText().catch(() => '')).trim();
      if (t) return t.replace(/\s+/g, ' ').slice(0, 160);
    }
    return '';
  }

  // Field kinds and names on the page, never their values (to see where a sign-in got stuck).
  async #fields(): Promise<string> {
    return this.page!.evaluate(() => Array.from(document.querySelectorAll('input, button'))
      .filter((el) => (el as HTMLElement).getBoundingClientRect().width > 0)
      .map((el) => `${(el as HTMLInputElement).type}:${(el as HTMLInputElement).name || (el as HTMLElement).id}`)
      .join(' ')).catch(() => '?');
  }

  async #readCsrf(): Promise<string> {
    const page = this.page!;
    const u = this.#where();
    if (!(u.host === LIVE_HOST && /^\/pm(\/|$)/.test(u.pathname))) {
      await page.goto(BASE + '/pm', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const u2 = this.#where();
    if (u2.host !== LIVE_HOST || LOGIN_PATH.test(u2.pathname)) return '';
    return (await page.locator('meta[name="csrf-token"]').getAttribute('content', { timeout: 10000 })) ?? '';
  }

  // One Ascend call through the signed-in browser. JSON in, JSON out; one call at a time.
  call(method: Method, path: string, body?: unknown): Promise<Reply> {
    const run = this.#chain.then(() => this.#call(method, path, body, true));
    this.#chain = run.catch(() => {});
    return run;
  }

  async #call(method: Method, path: string, body: unknown, mayRetry: boolean): Promise<Reply> {
    await this.ensureSignedIn();
    const headers: Record<string, string> = {
      'x-csrf-token': this.csrf,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: BASE + '/pm',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.context!.request.fetch(BASE + path, {
      method, headers, data: body === undefined ? undefined : JSON.stringify(body),
      maxRedirects: 0, timeout: 20000, failOnStatusCode: false,
    });
    const status = res.status();
    if ((status === 302 || status === 401) && mayRetry) {
      this.#forget(false);
      await this.signIn();
      return this.#call(method, path, body, false);
    }
    if (status >= 300) throw new AscendHttpError(method, path, status);
    this.lastCallAt = new Date();
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); } catch { throw new AscendHttpError(method, path, status); }
    }
    return { status, json };
  }
}
