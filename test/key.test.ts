import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readKey } from '../src/key.ts';

const dir = mkdtempSync(join(tmpdir(), 'vfd-key-'));
function file(name: string, text: string, mode: number): string {
  const f = join(dir, name);
  writeFileSync(f, text);
  chmodSync(f, mode);
  return f;
}

test('a 40-character key in an owner-only file is read, a trailing newline dropped', () => {
  assert.equal(readKey(file('ok', 'A'.repeat(39) + '7\n', 0o600)), 'A'.repeat(39) + '7');
});
test('a key file others can read is refused', () => {
  assert.throws(() => readKey(file('open', 'B'.repeat(40), 0o644)), /must be 0600/);
});
test('a short, doubled-up or odd key is refused', () => {
  for (const k of ['short', 'C'.repeat(80), 'D'.repeat(39) + '!', '']) {
    assert.throws(() => readKey(file('bad', k, 0o600)), /does not hold a link key/);
  }
});
test('a missing key file is refused', () => {
  assert.throws(() => readKey(join(dir, 'none')));
});
