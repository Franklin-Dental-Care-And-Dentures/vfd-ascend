import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EMPTY, SignInGuard, cleared, etDay, recorded, stopped, verdict } from '../src/guard.ts';

const at = (s: string) => new Date(s);
const MIN = 60 * 1000;

test('a fresh guard lets a sign-in through', () => {
  assert.deepEqual(verdict(EMPTY, at('2026-11-19T19:00:00Z')), { ok: true });
});

test('after a failure, the one retry waits 15 minutes', () => {
  const t0 = at('2026-11-19T19:00:00Z');
  const s = recorded(EMPTY, false, 'rejected', t0);
  assert.equal(s.stopped, null);
  const early = verdict(s, new Date(t0.getTime() + 14 * MIN));
  assert.equal(early.ok, false);
  assert.deepEqual(verdict(s, new Date(t0.getTime() + 15 * MIN)), { ok: true });
});

test('a second failure in a row stops sign-in until a person clears it', () => {
  const t0 = at('2026-11-19T19:00:00Z');
  let s = recorded(EMPTY, false, 'rejected', t0);
  s = recorded(s, false, 'rejected', new Date(t0.getTime() + 16 * MIN));
  assert.ok(s.stopped);
  assert.equal(verdict(s, new Date(t0.getTime() + 600 * MIN)).ok, false);
  s = cleared(s, new Date(t0.getTime() + 601 * MIN));
  assert.deepEqual(verdict(s, new Date(t0.getTime() + 601 * MIN)), { ok: true });
  // after the clear, one new failure is not yet two in a row
  s = recorded(s, false, 'rejected', new Date(t0.getTime() + 602 * MIN));
  assert.equal(s.stopped, null);
});

test('a success between failures resets the count in a row', () => {
  const t0 = at('2026-11-19T14:00:00Z');
  let s = recorded(EMPTY, false, 'stuck', t0);
  s = recorded(s, true, 'signed in', new Date(t0.getTime() + 20 * MIN));
  s = recorded(s, false, 'stuck', new Date(t0.getTime() + 40 * MIN));
  assert.equal(s.stopped, null);
});

test('never more than three failed sign-ins in an Eastern day, even after clears', () => {
  const t0 = at('2026-11-19T14:00:00Z');       // 09:00 ET
  let s = EMPTY;
  for (let i = 0; i < 3; i++) {
    s = recorded(s, false, 'stuck', new Date(t0.getTime() + i * 60 * MIN));
    s = cleared(s, new Date(t0.getTime() + i * 60 * MIN + 1));
  }
  const v = verdict(s, new Date(t0.getTime() + 5 * 60 * MIN));
  assert.equal(v.ok, false);
  // the next Eastern day is open again
  assert.deepEqual(verdict(s, at('2026-11-20T06:00:00Z')), { ok: true });   // 01:00 ET on the 20th
});

test('the day is the Eastern day', () => {
  assert.equal(etDay(at('2026-11-20T03:30:00Z')), '2026-11-19');   // 22:30 ET on the 19th
  assert.equal(etDay(at('2026-11-20T05:30:00Z')), '2026-11-20');
});

test('a code prompt stops at once and is marked as one', () => {
  const s = stopped(EMPTY, 'Ascend asked for a sign-in code', true, at('2026-11-19T19:00:00Z'));
  assert.equal(s.stopped?.code_prompt, true);
  assert.equal(verdict(s, at('2026-11-20T19:00:00Z')).ok, false);
});

test('the file keeps the state across restarts, and a broken file counts as stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const g = new SignInGuard(dir);
  g.record(false, 'rejected', at('2026-11-19T19:00:00Z'));
  assert.equal(new SignInGuard(dir).state().attempts.length, 1);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'signin-guard.json'), '{not json');
  assert.equal(new SignInGuard(dir).check().ok, false);
});
