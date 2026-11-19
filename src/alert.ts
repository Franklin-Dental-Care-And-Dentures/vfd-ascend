// Alerts for IT: a line in the state folder's alerts.jsonl and on stderr (the service journal). Getting them to
// IT through the watcher path (decision 784 point 6) is a later step; until then a person reads them here.
// An alert never carries patient data: only what happened to the link.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';

export function alert(kind: string, text: string): void {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, text });
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(join(STATE_DIR, 'alerts.jsonl'), line + '\n', { mode: 0o600 });
  } finally {
    console.error(`ALERT ${kind}: ${text}`);
  }
}
