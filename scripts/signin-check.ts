// Sign in once through the guard, read the csrf token and make two harmless reads (Ascend's code lists and the
// link user's own rights). Prints only metadata: statuses, lengths and counts. Run as npreg on DISPLAY :99.
import { STATE_DIR } from '../src/config.ts';
import { SignInGuard } from '../src/guard.ts';
import { AscendSession } from '../src/session.ts';

const shape = (j: unknown) => Array.isArray(j) ? `array of ${j.length}`
  : j && typeof j === 'object' ? `object with ${Object.keys(j).length} keys` : typeof j;

const guard = new SignInGuard(STATE_DIR);
console.log('guard before:', JSON.stringify(guard.check()));
const s = new AscendSession(guard);
const t0 = Date.now();
try {
  await s.signIn();
  console.log(`signed in after ${((Date.now() - t0) / 1000).toFixed(1)} s; csrf length ${s.csrf.length}; at ${new URL(s.page!.url()).pathname}`);
  for (const path of ['/enum/index', '/userREST/userAccessRights']) {
    const t1 = Date.now();
    const r = await s.call('GET', path);
    console.log(`GET ${path}: ${r.status}, ${shape(r.json)}, ${Date.now() - t1} ms`);
  }
} catch (e) {
  console.log('failed:', (e as Error).message);
} finally {
  console.log('guard after:', JSON.stringify(guard.check()));
  await s.close();
}
