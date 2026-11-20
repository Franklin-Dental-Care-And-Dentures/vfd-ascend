// send_forms against a fake Ascend: only to the patient just registered; a text when the mobile takes texts, else
// an email, else nothing (decisions 1063, 1794, 1492); Ascend's current send: the forms link, then /v2/form/send.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelOf, sendForms } from '../src/forms.ts';

const rec = (phones: any[], email = '') => ({ id: 900, phones, primaryEmail: email ? { id: 77, address: email } : {} });
const mob = (id: number, number: string, sms: string, sequence = 1) => ({ id, type: 'MOBILE', number, smsAuthorizationStatus: sms, sequence });
const LINK = JSON.stringify({ status: 'enabled', url: 'u', smsUrl: 'su', emailUrl: 'eu', expirationDate: 1 });

test('the channel: a text to a mobile that said yes, else the email, else none', () => {
  assert.deepEqual(channelOf(rec([mob(5, '(513) 555-1111', 'OPT_IN')], 'a@b.c')), { channelType: 'SMS', phoneNumberId: 5 });
  assert.deepEqual(channelOf(rec([mob(5, '5135551111', 'OPT_OUT')], 'a@b.c')), { channelType: 'EMAIL', emailAddressId: 77 });
  assert.deepEqual(channelOf(rec([mob(5, '5135551111', 'INVALID')], 'a@b.c')), { channelType: 'EMAIL', emailAddressId: 77 });
  assert.deepEqual(channelOf(rec([{ id: 6, type: 'HOME', number: '5135551111', smsAuthorizationStatus: 'OPT_IN' }])), null);
  assert.deepEqual(channelOf(rec([mob(1, '5135552222', 'OPT_OUT', 1), mob(2, '5135553333', 'OPT_IN', 2)])), { channelType: 'SMS', phoneNumberId: 2 });
  assert.equal(channelOf(rec([])), null);
});

function fake(record: any, link: string | Error, sent: any = { success: true }) {
  const forms: { path: string; fields: Record<string, string> }[] = [];
  const posts: { path: string; body: any }[] = [];
  return {
    forms, posts,
    s: {
      async call(m: string, path: string, body?: unknown) {
        if (m === 'POST') { posts.push({ path, body }); return { status: 200, json: sent }; }
        return path === '/patient/900' ? { status: 200, json: record } : { status: 200, json: null };
      },
      async form(path: string, fields: Record<string, string>) {
        forms.push({ path, fields });
        if (link instanceof Error) throw link;
        return { status: 200, text: link };
      },
    },
  };
}

test("send_forms: refused for anyone the link did not just register; sent once by Ascend's own send", async () => {
  const f = fake(rec([mob(5, '5135551111', 'OPT_IN')]), LINK);
  assert.deepEqual(await sendForms(f.s as any, { patient_id: '900' }, new Set()),
    { ok: false, refused: true, reason: 'forms go only to the patient just registered (decisions 1063, 1794)' });
  assert.equal(f.forms.length + f.posts.length, 0);
  assert.deepEqual(await sendForms(f.s as any, { patient_id: '900' }, new Set(['900'])), { ok: true, channel: 'text' });
  assert.deepEqual(f.forms, [{ path: '/patientForm/fetchPatientChallengeUrl/900', fields: { origin: 'requestAllDue' } }]);
  assert.deepEqual(f.posts, [{ path: '/v2/form/send', body: { patientId: 900, url: 'su', channelType: 'SMS', phoneNumberId: 5 } }]);
  const e = fake(rec([], 'a@b.c'), LINK);
  assert.deepEqual(await sendForms(e.s as any, { patient_id: '900' }, new Set(['900'])), { ok: true, channel: 'email' });
  assert.deepEqual(e.posts[0].body, { patientId: 900, url: 'eu', channelType: 'EMAIL', emailAddressId: 77 });
});

test('send_forms: nothing due, no way to reach them, or a refused send are error results, never a throw', async () => {
  const none = fake(rec([mob(5, '5135551111', 'OPT_IN')]), new Error('POST /patientForm/fetchPatientChallengeUrl/900: HTTP 500'));
  assert.deepEqual(await sendForms(none.s as any, { patient_id: '900' }, new Set(['900'])),
    { ok: false, error: 'no forms are due for this patient, or Ascend refused the forms link (HTTP 500)' });
  assert.equal(none.posts.length, 0);
  const nowhere = fake(rec([mob(5, '5135551111', 'INVALID')]), LINK);
  assert.deepEqual(await sendForms(nowhere.s as any, { patient_id: '900' }, new Set(['900'])),
    { ok: false, error: 'no mobile phone that takes texts and no email on the record' });
  assert.equal(nowhere.forms.length, 0);
  const no = fake(rec([mob(5, '5135551111', 'OPT_IN')]), LINK, { success: false });
  assert.deepEqual(await sendForms(no.s as any, { patient_id: '900' }, new Set(['900'])), { ok: false, error: 'Ascend did not send the forms' });
});
