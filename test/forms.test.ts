// send_forms against a fake Ascend: only to the patient just registered; a text when the mobile takes texts, else
// an email, else nothing (decisions 1063, 1794, 1492).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelOf, NO_FORMS_DUE, sendForms } from '../src/forms.ts';

const rec = (phones: any[], email = '') => ({ id: 900, phones, primaryEmail: email ? { address: email } : {} });
const mob = (number: string, sms: string, sequence = 1) => ({ type: 'MOBILE', number, smsAuthorizationStatus: sms, sequence });

test('the channel: a text to a mobile that said yes, else the email, else none', () => {
  assert.deepEqual(channelOf(rec([mob('(513) 555-1111', 'OPT_IN')], 'a@b.c')), { channelType: 'SMS', smsNumber: '5135551111' });
  assert.deepEqual(channelOf(rec([mob('5135551111', 'OPT_OUT')], 'a@b.c')), { channelType: 'EMAIL', emailAddress: 'a@b.c' });
  assert.deepEqual(channelOf(rec([mob('5135551111', 'INVALID')], ' a@b.c ')), { channelType: 'EMAIL', emailAddress: 'a@b.c' });
  assert.deepEqual(channelOf(rec([{ type: 'HOME', number: '5135551111', smsAuthorizationStatus: 'OPT_IN' }])), null);
  assert.deepEqual(channelOf(rec([mob('5135552222', 'OPT_OUT', 1), mob('5135553333', 'OPT_IN', 2)])), { channelType: 'SMS', smsNumber: '5135553333' });
  assert.equal(channelOf(rec([])), null);
});

function fake(record: any, reply: string) {
  const posts: { path: string; fields: Record<string, string> }[] = [];
  return {
    posts,
    s: {
      async call(_m: string, path: string) { return path === '/patient/900' ? { status: 200, json: record } : { status: 200, json: null }; },
      async form(path: string, fields: Record<string, string>) { posts.push({ path, fields }); return { status: 200, text: reply }; },
    },
  };
}

test('send_forms: refused for anyone the link did not just register; sent once by Ascend\'s own form', async () => {
  const f = fake(rec([mob('5135551111', 'OPT_IN')]), '"Forms sent"');
  assert.deepEqual(await sendForms(f.s as any, { patient_id: '900' }, new Set()),
    { ok: false, refused: true, reason: 'forms go only to the patient just registered (decisions 1063, 1794)' });
  assert.equal(f.posts.length, 0);
  assert.deepEqual(await sendForms(f.s as any, { patient_id: '900' }, new Set(['900'])), { ok: true, channel: 'text' });
  assert.deepEqual(f.posts, [{ path: '/patientForm/sendFormsNow/900', fields: { origin: 'requestAllDue', channelType: 'SMS', smsNumber: '5135551111' } }]);
});

test('send_forms: no forms due, and no way to reach the patient, are errors and nothing more', async () => {
  const none = fake(rec([], 'a@b.c'), JSON.stringify(NO_FORMS_DUE));
  assert.deepEqual(await sendForms(none.s as any, { patient_id: '900' }, new Set(['900'])), { ok: false, error: 'no forms are due for this patient' });
  assert.equal(none.posts[0].fields.channelType, 'EMAIL');
  const nowhere = fake(rec([mob('5135551111', 'INVALID')]), '');
  assert.deepEqual(await sendForms(nowhere.s as any, { patient_id: '900' }, new Set(['900'])),
    { ok: false, error: 'no mobile phone that takes texts and no email on the record' });
  assert.equal(nowhere.posts.length, 0);
});

test('send_forms: an Ascend refusal is an error result, never a throw', async () => {
  const f = { async call() { return { status: 200, json: rec([mob('5135551111', 'OPT_IN')]) }; },
    async form() { throw new Error('POST /patientForm/sendFormsNow/900: HTTP 422'); } };
  assert.deepEqual(await sendForms(f as any, { patient_id: '900' }, new Set(['900'])), { ok: false, error: 'Ascend did not send the forms (HTTP 422)' });
});
