// The Ascend link as a service (deploy/vfd-ascend.service, user npreg on CT 115): one signed-in Ascend session and
// the tool server Vida's engine dials, checked by the link key.
import { readFileSync } from 'node:fs';
import { KEY_FILE, LISTEN_HOST, LISTEN_PORT, STAFF_CA_FILE, STAFF_KEY_FILE, STAFF_URL, STATE_DIR } from './config.ts';
import { SignInGuard } from './guard.ts';
import { readKey } from './key.ts';
import { poster } from './notes.ts';
import { startServer } from './server.ts';
import { AscendSession } from './session.ts';
import { useAscend, useStaff } from './tools.ts';

const key = readKey(KEY_FILE);
const session = new AscendSession(new SignInGuard(STATE_DIR));
useAscend(session);
if (STAFF_URL) {
  useStaff(poster({ url: STAFF_URL, key: readKey(STAFF_KEY_FILE), ca: readFileSync(STAFF_CA_FILE) }));
  console.log(`leave_note stores staff messages at ${STAFF_URL}`);
} else {
  console.log('leave_note is off: VFD_STAFF_URL is not set');
}
const http = await startServer({ host: LISTEN_HOST, port: LISTEN_PORT, key });
console.log(`vfd-ascend listening on ${LISTEN_HOST}:${LISTEN_PORT}`);

let closing = false;
async function stop(why: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`stopping: ${why}`);
  http.close();
  await session.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

// Sign in now so the first call does not wait. A refused or failed sign-in is the guard's to count and alert; the
// next call tries again within its limits.
session.ensureSignedIn().then(
  () => console.log('signed in to Ascend'),
  (e) => console.error('sign-in at start failed:', String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200)),
);
