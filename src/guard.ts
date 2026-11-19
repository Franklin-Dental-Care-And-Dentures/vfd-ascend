// The sign-in guard (decision 784 point 5), kept in a small file so it holds across restarts. The rules are pure
// functions over the file's state; the class only reads and writes the file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAILS_IN_A_ROW_TO_STOP, FAILS_PER_DAY, RETRY_AFTER_MS, TZ } from './config.ts';

export type Attempt = { at: string; ok: boolean; why: string };
export type Stop = { at: string; why: string; code_prompt: boolean };
export type GuardState = { attempts: Attempt[]; stopped: Stop | null; cleared_at: string | null };
export type Verdict = { ok: true } | { ok: false; why: string; retry_at?: string };

export const EMPTY: GuardState = { attempts: [], stopped: null, cleared_at: null };

export function etDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
}

// May the link try to sign in now?
export function verdict(s: GuardState, now: Date): Verdict {
  if (s.stopped) {
    return { ok: false, why: `sign-in stopped (${s.stopped.why}) since ${s.stopped.at}; a person clears it` };
  }
  const today = etDay(now);
  const fails = s.attempts.filter((a) => !a.ok && etDay(new Date(a.at)) === today).length;
  if (fails >= FAILS_PER_DAY) {
    return { ok: false, why: `${fails} failed sign-ins today; none more until tomorrow` };
  }
  const last = s.attempts.at(-1);
  if (last && !last.ok) {
    const next = new Date(new Date(last.at).getTime() + RETRY_AFTER_MS);
    if (now < next) {
      return { ok: false, why: 'the last sign-in failed; one retry 15 minutes after it', retry_at: next.toISOString() };
    }
  }
  return { ok: true };
}

// Failed sign-ins in a row at the end of the list, counting only those after the last time a person cleared a stop.
export function failsInARow(s: GuardState): number {
  let n = 0;
  for (let i = s.attempts.length - 1; i >= 0; i--) {
    const a = s.attempts[i];
    if (a.ok || (s.cleared_at && a.at <= s.cleared_at)) break;
    n++;
  }
  return n;
}

export function recorded(s: GuardState, ok: boolean, why: string, now: Date): GuardState {
  const next: GuardState = { ...s, attempts: [...s.attempts, { at: now.toISOString(), ok, why }].slice(-50) };
  if (!ok) {
    const n = failsInARow(next);
    if (n >= FAILS_IN_A_ROW_TO_STOP) {
      next.stopped = { at: now.toISOString(), why: `${n} failed sign-ins in a row; last: ${why}`, code_prompt: false };
    }
  }
  return next;
}

export function stopped(s: GuardState, why: string, codePrompt: boolean, now: Date): GuardState {
  return { ...s, stopped: { at: now.toISOString(), why, code_prompt: codePrompt } };
}

export function cleared(s: GuardState, now: Date): GuardState {
  return { ...s, stopped: null, cleared_at: now.toISOString() };
}

export class SignInGuard {
  file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'signin-guard.json');
  }

  state(): GuardState {
    try {
      return { ...EMPTY, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
      // An unreadable guard file must not open the door to unlimited tries: treat it as stopped.
      return { ...EMPTY, stopped: { at: new Date().toISOString(), why: 'guard file unreadable', code_prompt: false } };
    }
  }

  #save(s: GuardState): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  check(now = new Date()): Verdict {
    return verdict(this.state(), now);
  }

  record(ok: boolean, why: string, now = new Date()): GuardState {
    const s = recorded(this.state(), ok, why, now);
    this.#save(s);
    return s;
  }

  stop(why: string, codePrompt: boolean, now = new Date()): void {
    this.#save(stopped(this.state(), why, codePrompt, now));
  }

  clear(now = new Date()): void {
    this.#save(cleared(this.state(), now));
  }
}
