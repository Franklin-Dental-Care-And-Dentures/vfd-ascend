// Fixed settings of the Ascend link. Nothing secret lives here: the sign-in name and password are files on CT 115
// (README), read only at sign-in.

export const LIVE_HOST = 'live19.dentrixascend.com';
export const AUTH_HOST = 'auth.henryscheinone.com';
export const BASE = `https://${LIVE_HOST}`;
export const ORGANIZATION = 'FranklinDental';
export const TZ = 'America/New_York';

export const USER_FILE = process.env.VFD_ASCEND_USER_FILE ?? '/etc/npreg/ascend.user';
export const PASS_FILE = process.env.VFD_ASCEND_PASS_FILE ?? '/etc/npreg/ascend.pass';
// Sign-in guard and alerts; the browser session itself is kept in memory only (decision 784 point 4: never on
// disk where a backup could take it).
export const STATE_DIR = process.env.VFD_ASCEND_STATE ?? '/home/npreg/.vfd-ascend';

// The only hosts the browser may load from. Everything else is aborted in the browser before it leaves: Google
// Fonts hang the page (TEST 51122), and analytics and support widgets get no Ascend page data (8.8.3).
export const ALLOWED_HOSTS = new Set([LIVE_HOST, AUTH_HOST, 'cdn.auth0.com', 'apps.prod.dentrixascend.com']);

// Sign-in guard (decision 784 point 5): after a failed sign-in, one retry no sooner than 15 minutes later; a second
// failure in a row stops sign-in until a person clears it; never more than 3 failed sign-ins in a day (Eastern).
// A code prompt stops at once: Dewayne signs in over VNC.
export const RETRY_AFTER_MS = 15 * 60 * 1000;
export const FAILS_PER_DAY = 3;
export const FAILS_IN_A_ROW_TO_STOP = 2;
