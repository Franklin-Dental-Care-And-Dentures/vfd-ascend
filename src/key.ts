// The link key from its file: owner-only, 32-64 letters and numbers, as the store script writes it.
import { readFileSync, statSync } from 'node:fs';

export function readKey(file: string): string {
  if (statSync(file).mode & 0o077) throw new Error(`${file} is readable by others; it must be 0600`);
  const key = readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9]{32,64}$/.test(key)) throw new Error(`${file} does not hold a link key`);
  return key;
}
