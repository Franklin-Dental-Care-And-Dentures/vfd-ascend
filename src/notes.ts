// leave_note: a message for the office goes to Vida's records service on VM 104 (vida-staff; decisions 2223, 2259)
// the moment it is taken, never into Ascend. It is reported saved only when the service says it stored the message
// and read it back, so Vida says "I have your message" only when staff will see it. The engine sends the call's id
// and whether the caller is in pain beside the arguments (_meta); the staff page shows the message under that call.
//
// The category's shape is checked, not its membership: a category the engine adds later must never cost a caller
// their message (the practice sim refuses an unknown one on purpose, to catch the engine in tests). An error never
// carries the caller's words.
import { request } from 'node:https';
import type { Meta, Result } from './tools.ts';

export type Staff = { url: string; key: string; ca: string | Buffer; timeoutMs?: number };
export type Post = (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

// The one way to the records service: its address, this link's key, and the service's own certificate as the only
// one trusted.
export function poster(s: Staff): Post {
  const u = new URL(s.url);
  if (u.protocol !== 'https:') throw new Error('the records service address must be https');
  return (path, body) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({
      host: u.hostname, port: u.port || 443, path, method: 'POST', ca: s.ca, timeout: s.timeoutMs ?? 8000,
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let parsed: unknown = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: not the service */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('the records service did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

const CATEGORY = /^[a-z0-9_]{0,64}$/;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function leaveNote(post: Post, a: Record<string, unknown>, meta: Meta): Promise<Result> {
  const message = text(a.message);
  const category = typeof a.category === 'string' ? a.category : '';
  if (!message) return { ok: false, error: 'the message has no words' };
  if (!CATEGORY.test(category)) return { ok: false, error: 'the category is not a category name' };
  let res: { status: number; body: unknown };
  try {
    res = await post('/api/messages', {
      call_id: text(meta.call_id), caller_id: text(meta.caller_id), category, message,
      caller_name: text(a.caller_name), phone: text(a.phone), patient_id: text(a.patient_id), pain: meta.pain === true,
    });
  } catch (e) {
    const why = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 120);
    return { ok: false, error: `the message could not be stored: ${why}` };
  }
  const b = (res.body ?? {}) as { ok?: unknown; id?: unknown; error?: unknown };
  if (res.status !== 200 || b.ok !== true || typeof b.id !== 'number') {
    const said = typeof b.error === 'string' ? ` ${b.error.slice(0, 120)}` : '';
    return { ok: false, error: `the message could not be stored: the records service answered ${res.status}${said}` };
  }
  return { ok: true, id: b.id };
}
