// Fixed settings of the Ascend link. Nothing secret lives here: the sign-in name and password are files on CT 115
// (README), read only at sign-in.

export const LIVE_HOST = 'live19.dentrixascend.com';
export const AUTH_HOST = 'auth.henryscheinone.com';
export const BASE = `https://${LIVE_HOST}`;
// Where a sign-in starts: the address the office signs in from (Dewayne, 15:37 ET 2026-11-19). It lands on the
// dashboard; Continue then goes to Henry Schein's password page (auth.henryscheinone.com/u/login).
export const LOGIN_URL = `${BASE}/login#/dashboard`;
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

// The service (deploy/vfd-ascend.service): the link key's file - this server's copy of 1Password item "Vida Ascend
// link key", stored by pve /root/store-vfd-ascend-key.sh, never logged - and where the tool server listens.
export const KEY_FILE = process.env.VFD_ASCEND_KEY_FILE ?? '/etc/npreg/vfd-ascend.key';
// Vida's records service on VM 104 (vfd-agent vida-staff, decision 2259), where leave_note stores a staff message:
// https://10.159.0.18:8444 once it is set up. Empty: leave_note stays off. The key is this server's copy of
// 1Password item "Vida records key - link"; the certificate is the service's own, the only one trusted for it.
export const STAFF_URL = process.env.VFD_STAFF_URL ?? '';
export const STAFF_KEY_FILE = process.env.VFD_STAFF_KEY_FILE ?? '/etc/npreg/vida-staff.key';
export const STAFF_CA_FILE = process.env.VFD_STAFF_CA_FILE ?? '/etc/npreg/vida-staff.crt';
export const LISTEN_HOST = process.env.VFD_ASCEND_LISTEN ?? '127.0.0.1';
export const LISTEN_PORT = Number(process.env.VFD_ASCEND_PORT ?? 8795);
