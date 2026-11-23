import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { leaveNote, poster, type Post } from '../src/notes.ts';
import { callTool, useStaff } from '../src/tools.ts';

type Sent = { path: string; body: Record<string, unknown> };
function fake(answer: { status: number; body: unknown } | Error): { post: Post; sent: Sent[] } {
  const sent: Sent[] = [];
  const post: Post = async (path, body) => {
    sent.push({ path, body: body as Record<string, unknown> });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { post, sent };
}
const stored = { status: 200, body: { ok: true, id: 7, call_id: 'call-77' } };
const words = 'Please call me about my partial.';
const args = { category: 'front_desk_other', message: `  ${words} `, caller_name: 'Dana Reyes', phone: '7405550102', patient_id: 'P7' };

test('a message goes to the records service under its call, and is saved only when the service says so', async () => {
  const f = fake(stored);
  const out = await leaveNote(f.post, args, { caller_id: '7405550101', call_id: 'call-77', pain: true });
  assert.deepEqual(out, { ok: true, id: 7 });
  assert.deepEqual(f.sent, [{ path: '/api/messages', body: {
    call_id: 'call-77', caller_id: '7405550101', category: 'front_desk_other', message: words, caller_name: 'Dana Reyes',
    phone: '7405550102', patient_id: 'P7', pain: true } }]);
});

test('a message with no call id, name or number still goes, with no pain', async () => {
  const f = fake(stored);
  assert.equal((await leaveNote(f.post, { message: words }, {})).ok, true);
  assert.deepEqual(f.sent[0].body, { call_id: '', caller_id: '', category: '', message: words, caller_name: '', phone: '',
    patient_id: '', pain: false });
});

test('a category the engine adds later is sent; one that is not a category name is refused', async () => {
  const f = fake(stored);
  assert.equal((await leaveNote(f.post, { message: words, category: 'treatment_plan_off_list' }, {})).ok, true);
  assert.equal((await leaveNote(f.post, { message: words, category: 'a_new_category_2027' }, {})).ok, true);
  const bad = await leaveNote(f.post, { message: words, category: "x'; drop" }, {});
  assert.deepEqual(bad, { ok: false, error: 'the category is not a category name' });
  assert.equal(f.sent.length, 2);
});

test('a message with no words is refused and nothing is sent', async () => {
  const f = fake(stored);
  for (const message of ['', '   ', undefined, 7]) {
    assert.deepEqual(await leaveNote(f.post, { message }, {}), { ok: false, error: 'the message has no words' });
  }
  assert.equal(f.sent.length, 0);
});

test('anything but a stored message is not saved, and the error never carries the caller\'s words', async () => {
  for (const answer of [
    { status: 500, body: { ok: false, error: 'the message could not be stored' } },
    { status: 403, body: { ok: false, error: 'this key cannot do that' } },
    { status: 200, body: { ok: false } },
    { status: 200, body: { ok: true } },          // no id: nothing proves it was stored
    { status: 200, body: null },                  // not the service
    new Error('connect ECONNREFUSED 10.159.0.18:8444'),
  ]) {
    const out = await leaveNote(fake(answer).post, args, { call_id: 'call-77' });
    assert.equal(out.ok, false, JSON.stringify(answer));
    assert.match(String(out.error), /^the message could not be stored: /);
    assert.doesNotMatch(String(out.error), /partial|Dana|7405550102/);
  }
});

test('leave_note is off until the records service is given, then it stores', async () => {
  assert.deepEqual(await callTool('leave_note', args), { ok: false, error: 'leave_note is not built yet in the Ascend link' });
  const f = fake(stored);
  useStaff(f.post);
  assert.deepEqual(await callTool('leave_note', args, { call_id: 'call-77', caller_id: '7405550101' }), { ok: true, id: 7 });
  assert.equal(f.sent[0].body.call_id, 'call-77');
});

// The real way out: https with this link's key, trusting the service's own certificate and no other.
test('the poster sends the key over https and trusts only the certificate it was given', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vfd-notes-'));
  const make = (name: string): { key: Buffer; cert: Buffer } => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`), '-subj', '/CN=vida-staff',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.crt`)) };
  };
  let own: { key: Buffer; cert: Buffer }, other: { key: Buffer; cert: Buffer };
  try { own = make('own'); other = make('other'); } catch { t.skip('no openssl here to make a test certificate'); return; }
  const seen: { auth?: string; path?: string; body?: string }[] = [];
  const srv = createServer({ key: own.key, cert: own.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, path: `${req.method} ${req.url}`, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"id":3}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const key = 'K'.repeat(40);
    assert.deepEqual(await leaveNote(poster({ url, key, ca: own.cert }), args, { call_id: 'call-77' }), { ok: true, id: 3 });
    assert.equal(seen[0].auth, `Bearer ${key}`);
    assert.equal(seen[0].path, 'POST /api/messages');
    assert.equal(JSON.parse(seen[0].body ?? '{}').message, words);
    const refused = await leaveNote(poster({ url, key, ca: other.cert }), args, {});
    assert.equal(refused.ok, false);
    assert.equal(seen.length, 1, 'a server with another certificate was sent the message');
    assert.throws(() => poster({ url: url.replace('https:', 'http:'), key, ca: own.cert }), /must be https/);
  } finally {
    srv.close();
  }
});
